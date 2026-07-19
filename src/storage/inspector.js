import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { createReadStream } from 'node:fs';

import { getDirectorySizeBytes, getEffectiveUserQuotaBytes } from '../admin-settings.js';

/**
 * Storage Inspector — pure library.
 *
 * 提供 taxonomy 常量、敏感文件识别、path 段安全校验、专用 Error 类,
 * 以及 root/category/sub-dir 三层枚举器。后端 endpoint
 * (users-private.js / users-admin.js) 通过 import 消费。
 * 除 walker 部分外无 side effect · 可完整单元测试。
 */

/**
 * 敏感 top-level 文件名。walker 允许作为一个 leaf entry 出现（报 size），
 * 但拒绝任何深入请求。
 */
export const SENSITIVE_ROOT_FILES = new Set([
    'secrets.json',
]);

/**
 * 10 大类顶层 taxonomy · 按用户视角聚合 · 顺序稳定（前端 stacked bar / legend 依赖）。
 * 每个 include 描述该 category 覆盖的物理路径（相对 data/<handle>/）。
 */
export const CATEGORIES = Object.freeze([
    {
        key: 'chats',
        label: 'Chats',
        icon: 'comment',
        colorVar: '--storage-cat-chats',
        includes: [
            { kind: 'dir', rel: 'chats' },
            { kind: 'dir', rel: 'group chats' },
        ],
    },
    {
        key: 'characters',
        label: 'Characters',
        icon: 'user',
        colorVar: '--storage-cat-characters',
        includes: [
            { kind: 'dir', rel: 'characters' },
        ],
    },
    {
        key: 'worlds',
        label: 'Worldbooks',
        icon: 'book',
        colorVar: '--storage-cat-worlds',
        includes: [
            { kind: 'dir', rel: 'worlds' },
        ],
    },
    {
        key: 'images',
        label: 'Images',
        icon: 'image',
        colorVar: '--storage-cat-images',
        includes: [
            { kind: 'dir', rel: 'backgrounds' },
            { kind: 'dir', rel: 'user/images' },
            { kind: 'dir', rel: 'User Avatars' },
        ],
    },
    {
        key: 'attachments',
        label: 'Attachments',
        icon: 'paperclip',
        colorVar: '--storage-cat-attach',
        includes: [
            { kind: 'dir', rel: 'user/files' },
            { kind: 'dir', rel: 'user/workflows' },
        ],
    },
    {
        key: 'presets',
        label: 'Presets & Settings',
        icon: 'sliders',
        colorVar: '--storage-cat-presets',
        includes: [
            { kind: 'dir', rel: 'OpenAI Settings' },
            { kind: 'dir', rel: 'NovelAI Settings' },
            { kind: 'dir', rel: 'KoboldAI Settings' },
            { kind: 'dir', rel: 'TextGen Settings' },
            { kind: 'dir', rel: 'themes' },
            { kind: 'dir', rel: 'movingUI' },
            { kind: 'dir', rel: 'QuickReplies' },
            { kind: 'dir', rel: 'instruct' },
            { kind: 'dir', rel: 'context' },
            { kind: 'dir', rel: 'sysprompt' },
            { kind: 'dir', rel: 'reasoning' },
            { kind: 'file', rel: 'settings.json' },
            { kind: 'glob', rel: 'settings.json.backup-*' },
            { kind: 'glob', rel: 'settings.json.presel-backup-*' },
        ],
    },
    {
        key: 'extensions',
        label: 'Extensions',
        icon: 'puzzle-piece',
        colorVar: '--storage-cat-ext',
        includes: [
            { kind: 'dir', rel: 'extensions' },
        ],
    },
    {
        key: 'vectors',
        label: 'Vector Stores',
        icon: 'brain',
        colorVar: '--storage-cat-vectors',
        includes: [
            { kind: 'dir', rel: 'vectors' },
        ],
    },
    {
        key: 'backups',
        label: 'Backups',
        icon: 'clock-rotate-left',
        colorVar: '--storage-cat-backups',
        includes: [
            { kind: 'dir', rel: 'backups' },
        ],
    },
    {
        key: 'other',
        label: 'Other',
        icon: 'box',
        colorVar: '--storage-cat-other',
        includes: [
            { kind: 'dir', rel: 'groups' },
            { kind: 'dir', rel: 'card-apps' },
            { kind: 'dir', rel: 'assets' },
            { kind: 'dir', rel: 'thumbnails' },
            { kind: 'file', rel: 'image-metadata.json' },
            { kind: 'file', rel: 'stats.json' },
            { kind: 'file', rel: 'content.log' },
            { kind: 'glob', rel: 'luker-storage.sqlite*' },
            { kind: 'file', rel: 'secrets.json', sensitive: true },
        ],
    },
]);

export const CATEGORY_MAP = Object.freeze(
    Object.fromEntries(CATEGORIES.map(c => [c.key, c])),
);

/**
 * 判断相对 `data/<handle>/` 的路径是否命中敏感文件（secrets.json 家族）。
 * 深入敏感文件的子路径仍算敏感（用于拒绝 drill-down）。
 */
export function isSensitiveRelPath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) return false;
    const top = relPath.split(/[/\\]/)[0];
    return SENSITIVE_ROOT_FILES.has(top);
}

/**
 * 校验 path 段安全 · 拒绝 traversal / abs / 特殊字符。
 * 前端传来的 path 每一段都必须过这个校验。
 * @throws {StorageInspectorError} code=E_INVALID_PATH
 */
export function assertSafeSegment(seg) {
    if (typeof seg !== 'string' || seg.length === 0) {
        throw new StorageInspectorError('E_INVALID_PATH', 'segment must be a non-empty string');
    }
    if (seg.includes('..') || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
        throw new StorageInspectorError('E_INVALID_PATH', `unsafe segment: ${JSON.stringify(seg)}`);
    }
    if (path.isAbsolute(seg)) {
        throw new StorageInspectorError('E_INVALID_PATH', `segment must be relative: ${JSON.stringify(seg)}`);
    }
}

/**
 * Storage Inspector 专用 Error · 带机器可读 code。
 *
 * Codes:
 * - E_INVALID_PATH     — path 结构 / 段字符非法（400）
 * - E_NOT_INSPECTABLE  — 命中敏感文件的深入请求（400）
 * - E_TARGET_NOT_FOUND — target handle 不存在（404）
 * - E_TIMEOUT          — 单类别 walk 超时（warning · 前端行标）
 */
export class StorageInspectorError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'StorageInspectorError';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// L2 grouped sub-category definitions.
//
// L1 (顶层) → L2 (category) → L3 (sub 或 file) 的 grouped 分组规则。
// 键 = category key · 值 = 该 category 的 L2 sub-categories 定义。
// simple (worlds / extensions / vectors) 不出现在这里 —— 它们的 L2
// 直接展开单目录 readdir。
//
// Sub 形式:
//   { key, label, rel }                       — 单 dir 或 file
//   { key, label, rels: [...] }               — 多 dir sum
//   { key, label, rel, globs: [...] }         — 单 parent + glob 筛选
//   { key, label, files: [...], globs: [...] } — 顶层 file + glob (main-settings)
// ---------------------------------------------------------------------------
const GROUPED_L2 = Object.freeze({
    images: [
        { key: 'backgrounds',  label: 'Backgrounds',     rel: 'backgrounds' },
        { key: 'user-images',  label: 'Chat Images',     rel: 'user/images' },
        { key: 'user-avatars', label: 'Persona Avatars', rel: 'User Avatars' },
    ],
    attachments: [
        { key: 'files',      label: 'Files',             rel: 'user/files' },
        { key: 'workflows',  label: 'ComfyUI Workflows', rel: 'user/workflows' },
    ],
    presets: [
        { key: 'api-presets',        label: 'API Presets',        rels: ['OpenAI Settings', 'NovelAI Settings', 'KoboldAI Settings', 'TextGen Settings'] },
        { key: 'ui-elements',        label: 'UI Elements',        rels: ['themes', 'movingUI', 'QuickReplies'] },
        { key: 'instruct-templates', label: 'Instruct Templates', rels: ['instruct', 'context', 'sysprompt', 'reasoning'] },
        { key: 'main-settings',      label: 'Main Settings',      files: ['settings.json'], globs: ['settings.json.backup-*', 'settings.json.presel-backup-*'] },
    ],
    backups: [
        { key: 'chat-backups',     label: 'Chat Backups',     rel: 'backups', globs: ['chat_*.jsonl'] },
        { key: 'settings-backups', label: 'Settings Backups', rel: 'backups', globs: ['settings_*.json'] },
    ],
});

/**
 * 通用递归 walk · 返回累积 size + 顶层子项计数。
 * 复用 admin-settings 的 getDirectorySizeBytes 拿总量;childCount 单独
 * readdir 一次浅测。不存在 / 不可读的目录返回 {sizeBytes:0, childCount:0}
 * (与 getDirectorySizeBytes 同容错语义)。
 *
 * @param {string} absPath
 * @returns {Promise<{sizeBytes:number, childCount:number, error?:string}>}
 */
export async function walkDirSize(absPath) {
    try {
        const [sizeBytes, entries] = await Promise.all([
            getDirectorySizeBytes(absPath),
            fsPromises.readdir(absPath).catch(() => []),
        ]);
        return { sizeBytes, childCount: entries.length };
    } catch (err) {
        return { sizeBytes: 0, childCount: 0, error: err?.message };
    }
}

/**
 * 单文件 stat · 用于 file kind include (如 settings.json)。
 * 不存在返回 size=0 · mtimeMs=null (不抛)。
 */
async function statFileSize(absPath) {
    try {
        const st = await fsPromises.stat(absPath);
        return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
        return { sizeBytes: 0, mtimeMs: null };
    }
}

/**
 * 极简 glob 展开 — 只支持结尾 `*` (前缀匹配)。
 * taxonomy 里只用 `settings.json.backup-*` / `luker-storage.sqlite*` /
 * `chat_*.jsonl` 这类形态,不引入 minimatch。
 * 非结尾 `*` 的模式抛 E_INVALID_PATH。
 */
async function walkGlob(parentAbs, pattern) {
    if (!pattern.endsWith('*')) {
        throw new StorageInspectorError('E_INVALID_PATH', `unsupported glob: ${pattern}`);
    }
    const prefix = pattern.slice(0, -1);
    let entries = [];
    try {
        entries = await fsPromises.readdir(parentAbs, { withFileTypes: true });
    } catch {
        return { sizeBytes: 0, matched: [] };
    }
    const matched = entries.filter(e => e.name.startsWith(prefix));
    let sizeBytes = 0;
    const files = [];
    for (const e of matched) {
        const abs = path.join(parentAbs, e.name);
        if (e.isDirectory()) {
            sizeBytes += await getDirectorySizeBytes(abs);
        } else {
            const st = await fsPromises.stat(abs).catch(() => null);
            if (st) {
                sizeBytes += st.size;
                files.push({ name: e.name, absPath: abs, size: st.size, mtimeMs: st.mtimeMs });
            }
        }
    }
    return { sizeBytes, matched: files };
}

/**
 * 计算 category 顶层总量 (遍历所有 includes 求和)。
 */
async function computeCategorySize(userRoot, category) {
    let sizeBytes = 0;
    let childCount = 0;
    for (const inc of category.includes) {
        const abs = path.join(userRoot, inc.rel);
        if (inc.kind === 'dir') {
            const r = await walkDirSize(abs);
            sizeBytes += r.sizeBytes;
            childCount += r.childCount;
        } else if (inc.kind === 'file') {
            const r = await statFileSize(abs);
            sizeBytes += r.sizeBytes;
            if (r.sizeBytes > 0) childCount += 1;
        } else if (inc.kind === 'glob') {
            const parent = path.dirname(abs);
            const pat = path.basename(abs);
            const r = await walkGlob(parent, pat);
            sizeBytes += r.sizeBytes;
            childCount += r.matched.length;
        }
    }
    return { sizeBytes, childCount };
}

/**
 * 单类别 walk 的软超时上限 (毫秒)。
 *
 * 30 s = HTTP 客户端不合理等待阈值 · 触发时返回 null size 让前端标 ?
 *        并显示 tooltip · 不 abort walker (允许 background 完成 · 下次刷新
 *        可能因 fs cache 加热而不再超时)。
 *
 * 用 `let` 而非 `const` 以便测试专用 setter (__setCategoryWalkSoftTimeoutForTest)
 * 临时调低到 ms 级验证 wrapper 契约。生产代码不应改写此值。
 */
export let CATEGORY_WALK_SOFT_TIMEOUT_MS = 30_000;

/**
 * 测试专用 · 临时改写单类别 walk 软超时 · 用完必须还原为 30_000。
 * 命名带 `__` 与 `ForTest` 双重前缀 · 生产代码不允许调用。
 */
export function __setCategoryWalkSoftTimeoutForTest(ms) {
    CATEGORY_WALK_SOFT_TIMEOUT_MS = ms;
}

/**
 * computeCategorySize 的软超时包装。
 * 超时时返回 { sizeBytes: null, childCount: 0, error: 'timeout' } ·
 * walker 本身 (computeCategorySize) 继续在后台跑,不 hard-abort。
 */
export async function computeCategorySizeWithTimeout(userRoot, category) {
    const walkP = computeCategorySize(userRoot, category);
    let timer;
    const timerP = new Promise((resolve) => {
        timer = setTimeout(
            () => resolve({ __timeout: true }),
            CATEGORY_WALK_SOFT_TIMEOUT_MS,
        );
    });
    const winner = await Promise.race([walkP, timerP]);
    if (winner && winner.__timeout) {
        // walker 未完成 · 让它继续跑到底 (不 detach warning)
        walkP.catch(() => { /* swallow · walker 结果被丢弃 */ });
        console.warn(
            `storage-inspector: category ${category.key} walk exceeded ${CATEGORY_WALK_SOFT_TIMEOUT_MS}ms, returning null size`,
        );
        return { sizeBytes: null, childCount: 0, error: 'timeout' };
    }
    clearTimeout(timer);
    return winner;
}

/**
 * L0 (打开 Inspector 时的第一层) · 返回全 10 类 total + quota。
 * 并行 walk 每类 · 各类间独立超时不影响其它类。
 */
export async function enumerateRoot(userRoot, user, adminSettings) {
    const catResults = await Promise.all(CATEGORIES.map(async (cat) => {
        const { sizeBytes, childCount, error } = await computeCategorySizeWithTimeout(userRoot, cat);
        return {
            key: cat.key,
            label: cat.label,
            icon: cat.icon,
            kind: 'category',
            sizeBytes,
            mtimeMs: null,
            childCount,
            // timeout 时不让钻 (size 未知 · 也可能 sub walk 同样爆);正常情况允许
            canDrill: sizeBytes !== null,
            note: error === 'timeout' ? 'Walk exceeded time limit; refresh to retry.' : null,
        };
    }));

    // usedBytes 汇总:null size 视为 0 (否则汇总里含 null)
    const usedBytes = catResults.reduce((s, e) => s + (e.sizeBytes ?? 0), 0);
    const quotaRaw = getEffectiveUserQuotaBytes(user, adminSettings);
    const quotaBytes = quotaRaw >= 0 ? quotaRaw : null;
    const over = quotaBytes !== null && usedBytes > quotaBytes;

    return {
        target: { type: 'self', handle: user?.handle ?? null },
        quota: { usedBytes, quotaBytes, over },
        path: [],
        breadcrumbs: [{ label: 'Storage', path: [] }],
        isLeaf: false,
        entries: catResults,
    };
}

/**
 * L1 (点某 category 后) · 返回该 category 的 L2 entries。
 *
 * 分派:
 * - chats / characters / other → 后续 task 各自实现 (此 task 抛 E_NOT_IMPLEMENTED)
 * - worlds / extensions / vectors (simple) → 直接展开该 category 唯一目录
 * - images / attachments / presets / backups (grouped) → 预定义 sub-categories 列表
 */
export async function enumerateCategory(userRoot, categoryKey) {
    const cat = CATEGORY_MAP[categoryKey];
    if (!cat) {
        throw new StorageInspectorError('E_INVALID_PATH', `unknown category: ${categoryKey}`);
    }

    // chats 分派 · L2 = 每 character 一行 + 群组聊天虚拟条目
    if (categoryKey === 'chats') {
        return enumerateChatsCategory(userRoot);
    }

    // characters 分派 · L2 = 每 character 一行(卡 + sprites + sidecar 合计)
    if (categoryKey === 'characters') {
        return enumerateCharactersCategory(userRoot);
    }

    // other 分派 · L2 直接是叶子 · 显式条目 + secrets.json 标 sensitive
    if (categoryKey === 'other') {
        return enumerateOtherCategory(userRoot);
    }

    // grouped → sub-categories
    if (GROUPED_L2[categoryKey]) {
        const subs = GROUPED_L2[categoryKey];
        const entries = await Promise.all(subs.map(async (sub) => {
            const { sizeBytes, childCount } = await computeSubSize(userRoot, sub);
            return {
                key: sub.key,
                label: sub.label,
                icon: 'folder',
                kind: 'sub-dir',
                sizeBytes,
                mtimeMs: null,
                childCount,
                canDrill: childCount > 0,
                note: null,
            };
        }));
        return {
            target: { type: 'self', handle: null },
            quota: null,
            path: [categoryKey],
            breadcrumbs: [
                { label: 'Storage', path: [] },
                { label: cat.label, path: [categoryKey] },
            ],
            isLeaf: false,
            entries,
        };
    }

    // simple → readdir 该 category 唯一 dir include
    const dirInc = cat.includes.find(i => i.kind === 'dir');
    if (!dirInc) {
        throw new StorageInspectorError('E_INVALID_PATH', `category ${categoryKey} has no dir include`);
    }
    const dirAbs = path.join(userRoot, dirInc.rel);
    const entries = await enumerateDirEntries(dirAbs);
    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: [categoryKey],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: cat.label, path: [categoryKey] },
        ],
        isLeaf: true,
        entries,
    };
}

/**
 * Grouped sub 的 size + count 计算 · 支持四种形式:
 *   - {rel: 'x'}                              — 单 dir 或 file
 *   - {rels: ['a','b','c']}                   — 多 dir sum
 *   - {rel: 'backups', globs: ['chat_*']}     — 单 parent dir + glob 筛选
 *   - {files: [...], globs: [...]}            — 顶层 file + glob (main-settings)
 */
async function computeSubSize(userRoot, sub) {
    let sizeBytes = 0;
    let childCount = 0;

    if (sub.rels) {
        for (const rel of sub.rels) {
            const r = await walkDirSize(path.join(userRoot, rel));
            sizeBytes += r.sizeBytes;
            childCount += r.childCount;
        }
    } else if (sub.globs && sub.rel) {
        const parent = path.join(userRoot, sub.rel);
        for (const g of sub.globs) {
            const r = await walkGlob(parent, g);
            sizeBytes += r.sizeBytes;
            childCount += r.matched.length;
        }
    } else if (sub.files || sub.globs) {
        if (sub.files) {
            for (const f of sub.files) {
                const r = await statFileSize(path.join(userRoot, f));
                sizeBytes += r.sizeBytes;
                if (r.sizeBytes > 0) childCount += 1;
            }
        }
        if (sub.globs) {
            for (const g of sub.globs) {
                const r = await walkGlob(userRoot, g);
                sizeBytes += r.sizeBytes;
                childCount += r.matched.length;
            }
        }
    } else if (sub.rel) {
        const r = await walkDirSize(path.join(userRoot, sub.rel));
        sizeBytes += r.sizeBytes;
        childCount += r.childCount;
    }
    return { sizeBytes, childCount };
}

/**
 * 通用 readdir 一层 · 每 entry 一行 · dir 可 drill · file 不可。
 * 用于 simple category L2 (worlds / extensions / vectors) 和 grouped L3。
 * 按 sizeBytes 降序 · 大的在前。
 */
async function enumerateDirEntries(dirAbs) {
    let raw = [];
    try {
        raw = await fsPromises.readdir(dirAbs, { withFileTypes: true });
    } catch {
        return [];
    }
    const entries = await Promise.all(raw.map(async (e) => {
        const abs = path.join(dirAbs, e.name);
        if (e.isDirectory()) {
            const { sizeBytes, childCount } = await walkDirSize(abs);
            const st = await fsPromises.stat(abs).catch(() => null);
            return {
                key: e.name,
                label: e.name,
                icon: 'folder',
                kind: 'directory',
                sizeBytes,
                mtimeMs: st?.mtimeMs ?? null,
                childCount,
                canDrill: childCount > 0,
                note: null,
            };
        }
        const { sizeBytes, mtimeMs } = await statFileSize(abs);
        return {
            key: e.name,
            label: e.name,
            icon: 'file',
            kind: 'file',
            sizeBytes,
            mtimeMs,
            childCount: 0,
            canDrill: false,
            note: null,
        };
    }));
    entries.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    return entries;
}

/**
 * L2 → L3 · grouped category 里某 sub-category 下的叶子文件列表。
 * 例:enumerateSubDir(userRoot, 'images', 'backgrounds')
 *     → readdir 该 sub 的 rel 目录下每文件。
 *
 * multi-rel (如 UI Elements 覆盖 themes+movingUI+QuickReplies) 展平合并,
 * 每 entry 的 label 前缀带子目录名以消歧。
 * main-settings 的 files + globs 也在此处理。
 * backups 的 chat-backups / settings-backups 用 rel+globs 组合筛选。
 */
export async function enumerateSubDir(userRoot, categoryKey, subKey) {
    const groups = GROUPED_L2[categoryKey];
    if (!groups) {
        throw new StorageInspectorError('E_INVALID_PATH', `category ${categoryKey} has no sub-dirs`);
    }
    const sub = groups.find(s => s.key === subKey);
    if (!sub) {
        throw new StorageInspectorError('E_INVALID_PATH', `unknown sub-dir: ${subKey}`);
    }

    const collected = [];

    // 单 rel + globs 组合:只列 glob 匹配文件 (backups 场景)
    if (sub.rel && sub.globs) {
        const parent = path.join(userRoot, sub.rel);
        for (const g of sub.globs) {
            const r = await walkGlob(parent, g);
            for (const m of r.matched) {
                collected.push({
                    key: m.name, label: m.name, icon: 'file', kind: 'file',
                    sizeBytes: m.size, mtimeMs: m.mtimeMs, childCount: 0, canDrill: false, note: null,
                });
            }
        }
    } else {
        // 单 rel / 多 rels → 每 rel 一次浅 readdir
        const dirs = sub.rel ? [sub.rel] : (sub.rels || []);
        for (const rel of dirs) {
            const rows = await enumerateDirEntries(path.join(userRoot, rel));
            for (const r of rows) {
                collected.push({
                    ...r,
                    label: dirs.length > 1 ? `${rel}/${r.label}` : r.label,
                });
            }
        }
        // main-settings 的 files + 顶层 globs
        if (sub.files) {
            for (const f of sub.files) {
                const abs = path.join(userRoot, f);
                const { sizeBytes, mtimeMs } = await statFileSize(abs);
                if (sizeBytes > 0) {
                    collected.push({
                        key: f, label: f, icon: 'file', kind: 'file',
                        sizeBytes, mtimeMs, childCount: 0, canDrill: false, note: null,
                    });
                }
            }
        }
        if (sub.globs && !sub.rel) {
            for (const g of sub.globs) {
                const r = await walkGlob(userRoot, g);
                for (const m of r.matched) {
                    collected.push({
                        key: m.name, label: m.name, icon: 'file', kind: 'file',
                        sizeBytes: m.size, mtimeMs: m.mtimeMs, childCount: 0, canDrill: false, note: null,
                    });
                }
            }
        }
    }

    collected.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    const cat = CATEGORY_MAP[categoryKey];
    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: [categoryKey, subKey],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: cat.label, path: [categoryKey] },
            { label: sub.label, path: [categoryKey, subKey] },
        ],
        isLeaf: true,
        entries: collected,
    };
}

/**
 * chat sidecar 命名 infix(与 src/storage/engines/sidecar-naming.js:1 保持一致).
 */
const CHAT_SIDECAR_INFIX = '.luker-state.';

/**
 * 群组聊天虚拟条目的 key(在 chats category 下,表示 group chats/ 目录的聚合).
 * `__` 前后缀避免与真实 character dir 名撞车.
 */
const GROUP_CHATS_VIRTUAL_KEY = '__group_chats__';

/**
 * L2 · chats 类顶层:每 character 一行 + 群组聊天虚拟条目.
 * 按 sizeBytes 降序排.
 */
async function enumerateChatsCategory(userRoot) {
    const chatsDir = path.join(userRoot, 'chats');
    const groupChatsDir = path.join(userRoot, 'group chats');

    // 每 char = chats/<char>/ 子目录
    let charDirs = [];
    try {
        const raw = await fsPromises.readdir(chatsDir, { withFileTypes: true });
        charDirs = raw.filter(e => e.isDirectory()).map(e => e.name);
    } catch { /* 目录不存在 · charDirs 留空 */ }

    const charEntries = await Promise.all(charDirs.map(async (name) => {
        const abs = path.join(chatsDir, name);
        const { sizeBytes } = await walkDirSize(abs);
        // childCount = chat 主体数(排除 sidecar);chat 主体 = *.jsonl
        let raw = [];
        try { raw = await fsPromises.readdir(abs); } catch { /* empty */ }
        const chatCount = raw.filter(n => n.endsWith('.jsonl')).length;
        return {
            key: name,
            label: name,
            icon: 'user',
            kind: 'character-chat-group',
            sizeBytes,
            mtimeMs: null,
            childCount: chatCount,
            canDrill: chatCount > 0,
            note: null,
        };
    }));

    // 虚拟"群组聊天"条目
    const grpSize = await walkDirSize(groupChatsDir);
    let grpFiles = [];
    try {
        grpFiles = (await fsPromises.readdir(groupChatsDir)).filter(n => n.endsWith('.jsonl'));
    } catch { /* 目录不存在 · empty */ }
    const grpEntry = {
        key: GROUP_CHATS_VIRTUAL_KEY,
        label: 'Group Chats',
        icon: 'users',
        kind: 'group-chats-virtual',
        sizeBytes: grpSize.sizeBytes,
        mtimeMs: null,
        childCount: grpFiles.length,
        canDrill: grpFiles.length > 0,
        note: null,
    };

    const entries = [...charEntries, grpEntry].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: ['chats'],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: 'Chats', path: ['chats'] },
        ],
        isLeaf: false,
        entries,
    };
}

/**
 * L3 · 某 character 下 chat 文件列表(每 chat = chat 主体 + 该 chat 所有 sidecar 合计一行).
 */
export async function enumerateChatsCharacter(userRoot, charKey) {
    assertSafeSegment(charKey);
    const dirAbs = path.join(userRoot, 'chats', charKey);
    let raw;
    try {
        raw = await fsPromises.readdir(dirAbs, { withFileTypes: true });
    } catch {
        throw new StorageInspectorError('E_INVALID_PATH', `character not found: ${charKey}`);
    }

    // chat 主体 = *.jsonl(排除 sidecar;sidecar 是 *.luker-state.<ns>.json)
    const chatFiles = raw.filter(e => e.isFile() && e.name.endsWith('.jsonl'));
    const entries = await Promise.all(chatFiles.map(async (e) => {
        const abs = path.join(dirAbs, e.name);
        const baseName = e.name.slice(0, -'.jsonl'.length);
        const st = await fsPromises.stat(abs);
        // 找该 chat 的所有 sidecar
        const sidecarPrefix = `${baseName}${CHAT_SIDECAR_INFIX}`;
        const sidecars = raw.filter(x => x.isFile() && x.name.startsWith(sidecarPrefix) && x.name.endsWith('.json'));
        let sidecarTotal = 0;
        for (const s of sidecars) {
            const sst = await fsPromises.stat(path.join(dirAbs, s.name)).catch(() => null);
            if (sst) sidecarTotal += sst.size;
        }
        return {
            key: e.name,
            label: e.name,
            icon: 'comment',
            kind: 'chat-file',
            sizeBytes: st.size + sidecarTotal,
            mtimeMs: st.mtimeMs,
            childCount: 1 + sidecars.length,  // chat body(展开为 metadata+messages 计 1)+ N sidecar
            canDrill: true,
            note: null,
        };
    }));
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: ['chats', charKey],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: 'Chats', path: ['chats'] },
            { label: charKey, path: ['chats', charKey] },
        ],
        isLeaf: false,
        entries,
    };
}

/**
 * L3 · 群组聊天虚拟条目下的每个 group chat.
 */
export async function enumerateGroupChats(userRoot) {
    const dirAbs = path.join(userRoot, 'group chats');
    const rows = await enumerateDirEntries(dirAbs);
    // 只保留 .jsonl(group chats 无 sidecar,但可能有别的杂文件)
    const entries = rows.filter(r => r.label.endsWith('.jsonl'))
        .map(r => ({ ...r, icon: 'comments', kind: 'chat-file', canDrill: true, childCount: 1 }));

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: ['chats', GROUP_CHATS_VIRTUAL_KEY],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: 'Chats', path: ['chats'] },
            { label: 'Group Chats', path: ['chats', GROUP_CHATS_VIRTUAL_KEY] },
        ],
        isLeaf: false,
        entries,
    };
}

/**
 * 读 .jsonl 首行 byte 长度(不含 trailing \n)· 用于 chat metadata size 精确切分.
 * 用 stream 读一行即 break · 不整个文件读入.
 *
 * 保护:1 MB 上限 · chat_metadata 实际极少超过几 KB;1 MB 是 100 倍安全垫;
 * 触发上限意味着输入畸形 · 我们 log 并返回 -1 让 caller fallback 到
 * 整文件视为 metadata(避免单个畸形 chat 吃光内存).
 */
export async function readFirstLineByteLen(absPath) {
    const MAX_METADATA_LINE = 1024 * 1024;  // 1 MB · 保护单一畸形文件不吃光内存
    return new Promise((resolve, reject) => {
        // 用 Buffer chunk(不指定 encoding)确保 \n 检测按字节走,不被 utf-8 边界截断.
        const stream = createReadStream(absPath);
        const chunks = [];
        let totalLen = 0;
        stream.on('data', (chunk) => {
            const nl = chunk.indexOf(0x0a);  // '\n' byte
            if (nl >= 0) {
                chunks.push(chunk.slice(0, nl));
                totalLen += nl;
                stream.destroy();
                resolve(totalLen);
                return;
            }
            chunks.push(chunk);
            totalLen += chunk.length;
            if (totalLen > MAX_METADATA_LINE) {
                stream.destroy();
                console.warn(`storage-inspector: chat metadata line > ${MAX_METADATA_LINE} bytes at ${absPath}, truncating`);
                resolve(-1);
            }
        });
        stream.on('end', () => {
            // 文件无 \n · 视整个文件为 metadata
            resolve(totalLen);
        });
        stream.on('error', reject);
    });
}

/**
 * L4 · 单 chat 叶子:metadata(首行 JSON)+ messages(剩余行) + 每 sidecar 分列.
 * chatFileName 用于识别 basename 定位 sidecar;categoryPath 是完整钻取路径
 * (含 chatFileName 末段).
 */
export async function enumerateChatFile(chatAbsPath, chatFileName, categoryPath) {
    const st = await fsPromises.stat(chatAbsPath);
    const totalBytes = st.size;
    const firstLineLen = await readFirstLineByteLen(chatAbsPath);
    const metaSize = firstLineLen >= 0 ? firstLineLen : totalBytes;
    // messagesBytes = totalBytes - metaSize - 1(减去 metadata 行末尾那个 \n);
    // 首行读失败则 messages 视 0(整文件已进 metaSize).
    const messagesSize = firstLineLen >= 0 ? Math.max(0, totalBytes - firstLineLen - 1) : 0;

    const entries = [
        {
            key: '__metadata__',
            label: 'Chat Metadata',
            icon: 'gear',
            kind: 'chat-metadata',
            sizeBytes: metaSize,
            mtimeMs: st.mtimeMs,
            childCount: 0,
            canDrill: false,
            note: null,
        },
        {
            key: '__messages__',
            label: 'Messages',
            icon: 'comment-dots',
            kind: 'chat-messages',
            sizeBytes: messagesSize,
            mtimeMs: st.mtimeMs,
            childCount: 0,
            canDrill: false,
            note: null,
        },
    ];

    // sidecar 检测 · 只对 chats/<char>/*.jsonl 有效;group chats 无 sidecar
    const parentDir = path.dirname(chatAbsPath);
    const baseName = chatFileName.endsWith('.jsonl')
        ? chatFileName.slice(0, -'.jsonl'.length) : chatFileName;
    const sidecarPrefix = `${baseName}${CHAT_SIDECAR_INFIX}`;
    let siblings = [];
    try { siblings = await fsPromises.readdir(parentDir); } catch { /* group chats · empty */ }
    const sidecars = siblings.filter(n => n.startsWith(sidecarPrefix) && n.endsWith('.json'));
    for (const s of sidecars) {
        const sAbs = path.join(parentDir, s);
        const sSt = await fsPromises.stat(sAbs).catch(() => null);
        if (!sSt) continue;
        const ns = s.slice(sidecarPrefix.length, -'.json'.length);
        entries.push({
            key: s,
            label: ns,
            icon: 'database',
            kind: 'chat-sidecar',
            sizeBytes: sSt.size,
            mtimeMs: sSt.mtimeMs,
            childCount: 0,
            canDrill: false,
            note: null,
        });
    }
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);

    // breadcrumbs 由 categoryPath 反推
    const breadcrumbs = [
        { label: 'Storage', path: [] },
        { label: 'Chats', path: ['chats'] },
    ];
    if (categoryPath[1] === GROUP_CHATS_VIRTUAL_KEY) {
        breadcrumbs.push({ label: 'Group Chats', path: ['chats', GROUP_CHATS_VIRTUAL_KEY] });
    } else {
        breadcrumbs.push({ label: categoryPath[1], path: ['chats', categoryPath[1]] });
    }
    breadcrumbs.push({ label: chatFileName, path: categoryPath });

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: categoryPath,
        breadcrumbs,
        isLeaf: true,
        entries,
    };
}

/**
 * character sidecar 命名 infix(与 src/endpoints/characters.js:40 保持一致).
 * 注意与 chat sidecar `.luker-state.` 不同 · 别混.
 */
const CHARACTER_SIDECAR_INFIX = '.state.';

/**
 * L2 · characters 类顶层:每 character 一行(卡 + sprites + sidecar 合计).
 * 一个 character 定义 = characters/<name>.png 存在;其 sprites 在 characters/<name>/,
 * 其 sidecar 是 characters/<name>.state.<ns>.json.
 * 按 sizeBytes 降序排.
 */
async function enumerateCharactersCategory(userRoot) {
    const charsDir = path.join(userRoot, 'characters');
    let raw = [];
    try {
        raw = await fsPromises.readdir(charsDir, { withFileTypes: true });
    } catch { /* 目录不存在 · empty */ }

    // 卡 = *.png 文件;取 name(不含 .png)作为 char key
    const cardFiles = raw.filter(e => e.isFile() && e.name.endsWith('.png'));

    const entries = await Promise.all(cardFiles.map(async (cf) => {
        const charKey = cf.name.slice(0, -'.png'.length);
        const cardAbs = path.join(charsDir, cf.name);
        const cardSt = await fsPromises.stat(cardAbs);

        // sprites 目录:characters/<charKey>/
        const spritesAbs = path.join(charsDir, charKey);
        const { sizeBytes: spritesSize, childCount: spritesCount } = await walkDirSize(spritesAbs);

        // sidecar:characters/<charKey>.state.<ns>.json
        const sidecarPrefix = `${charKey}${CHARACTER_SIDECAR_INFIX}`;
        const sidecarFiles = raw.filter(e =>
            e.isFile() && e.name.startsWith(sidecarPrefix) && e.name.endsWith('.json'));
        let sidecarSize = 0;
        for (const s of sidecarFiles) {
            const sSt = await fsPromises.stat(path.join(charsDir, s.name)).catch(() => null);
            if (sSt) sidecarSize += sSt.size;
        }

        return {
            key: charKey,
            label: charKey,
            icon: 'user',
            kind: 'character-group',
            sizeBytes: cardSt.size + spritesSize + sidecarSize,
            mtimeMs: cardSt.mtimeMs,
            childCount: 1 + (spritesCount > 0 ? 1 : 0) + sidecarFiles.length,
            canDrill: true,
            note: null,
        };
    }));
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: ['characters'],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: 'Characters', path: ['characters'] },
        ],
        isLeaf: false,
        entries,
    };
}

/**
 * L3 叶子 · 单 character 详情:卡 + 表情图(合并一行)+ 每 sidecar ns 一行.
 * sprites 按 spec 合并为单行 · 不再钻(canDrill:false).
 */
export async function enumerateCharacterDetail(userRoot, charKey) {
    assertSafeSegment(charKey);
    const charsDir = path.join(userRoot, 'characters');
    const cardAbs = path.join(charsDir, `${charKey}.png`);
    const cardSt = await fsPromises.stat(cardAbs).catch(() => null);
    if (!cardSt) {
        throw new StorageInspectorError('E_INVALID_PATH', `character not found: ${charKey}`);
    }

    const entries = [{
        key: `${charKey}.png`,
        label: `${charKey}.png`,
        icon: 'image',
        kind: 'character-card',
        sizeBytes: cardSt.size,
        mtimeMs: cardSt.mtimeMs,
        childCount: 0,
        canDrill: false,
        note: null,
    }];

    // Sprites 聚合成一行
    const spritesAbs = path.join(charsDir, charKey);
    const { sizeBytes: spritesSize, childCount: spritesCount } = await walkDirSize(spritesAbs);
    if (spritesCount > 0) {
        entries.push({
            key: '__sprites__',
            label: 'Sprites',
            labelSuffix: ` (${spritesCount})`,
            icon: 'images',
            kind: 'character-sprites',
            sizeBytes: spritesSize,
            mtimeMs: null,
            childCount: spritesCount,
            canDrill: false,  // 按 spec: 合并一行不再钻
            note: null,
        });
    }

    // Sidecars · 每个 ns 一行
    let raw = [];
    try { raw = await fsPromises.readdir(charsDir); } catch { /* empty */ }
    const sidecarPrefix = `${charKey}${CHARACTER_SIDECAR_INFIX}`;
    const sidecarFiles = raw.filter(n => n.startsWith(sidecarPrefix) && n.endsWith('.json'));
    for (const s of sidecarFiles) {
        const sAbs = path.join(charsDir, s);
        const sSt = await fsPromises.stat(sAbs).catch(() => null);
        if (!sSt) continue;
        const ns = s.slice(sidecarPrefix.length, -'.json'.length);
        entries.push({
            key: s,
            label: ns,
            icon: 'database',
            kind: 'character-sidecar',
            sizeBytes: sSt.size,
            mtimeMs: sSt.mtimeMs,
            childCount: 0,
            canDrill: false,
            note: null,
        });
    }
    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: ['characters', charKey],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: 'Characters', path: ['characters'] },
            { label: charKey, path: ['characters', charKey] },
        ],
        isLeaf: true,
        entries,
    };
}

/**
 * L2 · other 类:显式条目 + secrets.json 标 sensitive.
 * 每一条来自 CATEGORY_MAP.other.includes;顺序按 taxonomy 定义(最终 sizeBytes desc 排序).
 * other 是叶子(isLeaf:true) · 不再钻.
 *
 * 分类语义:
 * - dir:  用 walkDirSize · 空目录跳过
 * - file(!sensitive): 用 statFileSize · 不存在跳过
 * - file(sensitive):  即使 size=0 也显示 · kind='sensitive-blob' + icon='lock' + canDrill:false
 * - glob: 用 walkGlob · 每个匹配一行
 */
async function enumerateOtherCategory(userRoot) {
    const cat = CATEGORY_MAP.other;
    const entries = [];
    for (const inc of cat.includes) {
        if (inc.kind === 'dir') {
            const abs = path.join(userRoot, inc.rel);
            const { sizeBytes, childCount } = await walkDirSize(abs);
            if (sizeBytes === 0 && childCount === 0) continue;  // 不存在或空 · 跳过
            const st = await fsPromises.stat(abs).catch(() => null);
            entries.push({
                key: inc.rel,
                label: inc.rel,
                icon: 'folder',
                kind: 'directory',
                sizeBytes,
                mtimeMs: st?.mtimeMs ?? null,
                childCount,
                canDrill: false,  // other 是叶子 · 目录也不再钻
                note: null,
            });
        } else if (inc.kind === 'file') {
            const abs = path.join(userRoot, inc.rel);
            const { sizeBytes, mtimeMs } = await statFileSize(abs);
            if (sizeBytes === 0 && !inc.sensitive) continue;  // 非敏感不存在跳过 · 敏感即使 0 也显示
            if (inc.sensitive) {
                entries.push({
                    key: inc.rel,
                    label: inc.rel,
                    icon: 'lock',
                    kind: 'sensitive-blob',
                    sizeBytes,
                    mtimeMs,
                    childCount: 0,
                    canDrill: false,
                    note: 'Contains API keys · not inspectable',
                });
            } else {
                entries.push({
                    key: inc.rel,
                    label: inc.rel,
                    icon: 'file',
                    kind: 'file',
                    sizeBytes,
                    mtimeMs,
                    childCount: 0,
                    canDrill: false,
                    note: null,
                });
            }
        } else if (inc.kind === 'glob') {
            const parent = path.dirname(path.join(userRoot, inc.rel));
            const pat = path.basename(inc.rel);
            const r = await walkGlob(parent, pat);
            for (const m of r.matched) {
                entries.push({
                    key: m.name,
                    label: m.name,
                    icon: 'file',
                    kind: 'file',
                    sizeBytes: m.size,
                    mtimeMs: m.mtimeMs,
                    childCount: 0,
                    canDrill: false,
                    note: null,
                });
            }
        }
    }
    entries.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

    return {
        target: { type: 'self', handle: null },
        quota: null,
        path: ['other'],
        breadcrumbs: [
            { label: 'Storage', path: [] },
            { label: 'Other', path: ['other'] },
        ],
        isLeaf: true,
        entries,
    };
}

/**
 * Top-level dispatcher · endpoint 唯一入口.
 * 校验 path · 拦截敏感文件深入 · 分派到具体 enumerator.
 *
 * @param {string} userRoot — data/<handle>/ 绝对路径
 * @param {string[]} pathArr — 前端传来的 opaque path 数组(每段字符串)
 * @param {{target, user, adminSettings}} opts — user + adminSettings 只在 L0(root)使用
 * @returns {Promise<object>} InspectorResponse
 * @throws {StorageInspectorError} E_INVALID_PATH · E_NOT_INSPECTABLE
 */
export async function resolvePath(userRoot, pathArr, opts) {
    if (!Array.isArray(pathArr)) {
        throw new StorageInspectorError('E_INVALID_PATH', 'path must be an array');
    }
    // 每段 sanitize · 但允许双下划线虚拟 key(__group_chats__ / __metadata__ / __messages__ / __sprites__)
    // 虚拟 key 由 enumerator 自造 · 用户点击相关行时前端回传 · 不映射到 fs 段
    for (const seg of pathArr) {
        if (typeof seg === 'string' && /^__[a-z_]+__$/.test(seg)) continue;
        assertSafeSegment(seg);
    }
    // 敏感文件深入拦截 · 若中间段命中 SENSITIVE_ROOT_FILES 且后续还有段 → 拒
    for (let i = 0; i < pathArr.length - 1; i++) {
        if (SENSITIVE_ROOT_FILES.has(pathArr[i])) {
            throw new StorageInspectorError('E_NOT_INSPECTABLE',
                `sensitive file ${pathArr[i]} cannot be drilled into`);
        }
    }

    // Dispatch
    if (pathArr.length === 0) {
        return enumerateRoot(userRoot, opts.user, opts.adminSettings);
    }
    const [categoryKey, ...deeper] = pathArr;

    if (deeper.length === 0) {
        return enumerateCategory(userRoot, categoryKey);
    }

    // chats:['chats', charKey, chatFileName?] 最大深度 3
    if (categoryKey === 'chats') {
        const [charKey, chatFileName, ...rest] = deeper;
        if (rest.length > 0) {
            throw new StorageInspectorError('E_INVALID_PATH', 'chats path max depth = 3');
        }
        if (charKey === GROUP_CHATS_VIRTUAL_KEY) {
            if (!chatFileName) return enumerateGroupChats(userRoot);
            const abs = path.join(userRoot, 'group chats', chatFileName);
            return enumerateChatFile(abs, chatFileName, ['chats', GROUP_CHATS_VIRTUAL_KEY, chatFileName]);
        }
        if (!chatFileName) return enumerateChatsCharacter(userRoot, charKey);
        const abs = path.join(userRoot, 'chats', charKey, chatFileName);
        return enumerateChatFile(abs, chatFileName, ['chats', charKey, chatFileName]);
    }

    // characters:['characters', charKey] 最大深度 2
    if (categoryKey === 'characters') {
        const [charKey, ...rest] = deeper;
        if (rest.length > 0) {
            throw new StorageInspectorError('E_INVALID_PATH', 'characters path max depth = 2');
        }
        return enumerateCharacterDetail(userRoot, charKey);
    }

    // other L2 已是叶子 · 不允许再钻
    if (categoryKey === 'other') {
        throw new StorageInspectorError('E_INVALID_PATH', 'other category is a leaf');
    }

    // grouped(images/attachments/presets/backups) · L3 = enumerateSubDir · 最大深度 2
    if (GROUPED_L2[categoryKey]) {
        const [subKey, ...rest] = deeper;
        if (rest.length > 0) {
            throw new StorageInspectorError('E_INVALID_PATH', `${categoryKey} path max depth = 2`);
        }
        return enumerateSubDir(userRoot, categoryKey, subKey);
    }

    // simple category(worlds/extensions/vectors) · L2 已是叶子 · deeper 未知
    if (CATEGORY_MAP[categoryKey]) {
        throw new StorageInspectorError('E_INVALID_PATH', `${categoryKey} category is a leaf`);
    }

    // 未知 category · assertSafeSegment 已过 · 但 taxonomy 不认
    throw new StorageInspectorError('E_INVALID_PATH', `unknown category: ${categoryKey}`);
}

/**
 * 聚合视图 L0 · 遍历所有 users × 10 类别求和。
 * 每 user × 每类通过 computeCategorySizeWithTimeout(见前文)包时限,
 * 单类超时返回 null · 汇总时视为 0 · 不影响其它类别。
 *
 * 返回的 InspectorResponse.target = { type:'aggregate', handle:null };
 * quota.usedBytes 是全 user 全类总和,quotaBytes 恒为 null(聚合无单一配额);
 * entries 恒 10 条(与 CATEGORIES 一一对应),canDrill 仅在 sizeBytes>0 时 true。
 *
 * @param {Array<{handle:string, root:string}>} users
 * @param {object} adminSettings — 保留形参供未来扩展(如按 admin 阈值过滤);当前实现不消费
 * @returns {Promise<object>} InspectorResponse
 */
export async function enumerateAggregateRoot(users, adminSettings) {
    // CONCURRENCY 上限 20 · 是 fd/内存开销与并行收益的折中;
    // 典型多用户 server(10-100 用户)满并行会撞 ENFILE(默认 fd 上限 1024),
    // 20 * 10 类 = 200 并发 walk 是安全的(留足给其它 fs / db 使用者)。
    const CONCURRENCY = 20;
    const tasks = [];
    for (const u of users) {
        for (const cat of CATEGORIES) {
            tasks.push(async () => {
                const { sizeBytes } = await computeCategorySizeWithTimeout(u.root, cat);
                return { handle: u.handle, catKey: cat.key, sizeBytes: sizeBytes ?? 0 };
            });
        }
    }
    const results = await runWithConcurrency(tasks, CONCURRENCY);

    const catTotals = Object.fromEntries(CATEGORIES.map(c => [c.key, 0]));
    for (const r of results) catTotals[r.catKey] += r.sizeBytes;
    const usedBytes = Object.values(catTotals).reduce((s, v) => s + v, 0);

    const entries = CATEGORIES.map(cat => ({
        key: cat.key,
        label: cat.label,
        icon: cat.icon,
        kind: 'category',
        sizeBytes: catTotals[cat.key],
        mtimeMs: null,
        childCount: users.length,
        canDrill: catTotals[cat.key] > 0,
        note: null,
    }));

    return {
        target: { type: 'aggregate', handle: null },
        quota: { usedBytes, quotaBytes: null, over: false },
        path: [],
        breadcrumbs: [{ label: 'Storage · All Users', path: [] }],
        isLeaf: false,
        entries,
    };
}

/**
 * 聚合视图 L1 · 某类别下按用户 top 排列(size desc · 零 size 过滤)。
 *
 * 返回的 entries[].kind = 'aggregate-user-row',key/label 是用户 handle;
 * canDrill 恒 true(前端点击会跳到该用户的 Inspector 定位到该类别)。
 * 未知 categoryKey 抛 StorageInspectorError(E_INVALID_PATH)。
 *
 * @param {Array<{handle:string, root:string}>} users
 * @param {string} categoryKey
 * @returns {Promise<object>} InspectorResponse
 */
export async function enumerateAggregateCategory(users, categoryKey) {
    const cat = CATEGORY_MAP[categoryKey];
    if (!cat) {
        throw new StorageInspectorError('E_INVALID_PATH', `unknown category: ${categoryKey}`);
    }
    const userSizes = await Promise.all(users.map(async (u) => {
        const { sizeBytes } = await computeCategorySizeWithTimeout(u.root, cat);
        return { handle: u.handle, sizeBytes: sizeBytes ?? 0 };
    }));
    const entries = userSizes
        .filter(x => x.sizeBytes > 0)
        .sort((a, b) => b.sizeBytes - a.sizeBytes)
        .map(x => ({
            key: x.handle,
            label: x.handle,
            icon: 'user',
            kind: 'aggregate-user-row',
            sizeBytes: x.sizeBytes,
            mtimeMs: null,
            childCount: 1,
            canDrill: true,   // 点击 = 跳转到该 user 的 Inspector 定位到该类别
            note: null,
        }));
    return {
        target: { type: 'aggregate', handle: null },
        quota: null,
        path: [categoryKey],
        breadcrumbs: [
            { label: 'Storage · All Users', path: [] },
            { label: cat.label, path: [categoryKey] },
        ],
        isLeaf: false,
        entries,
    };
}

/**
 * 简易并发 pool · 避免 p-limit 依赖。
 * task 抛异常 → Promise.all 拒 · 上层看到 · 不静默(遵项目规: 不写兜底)。
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
async function runWithConcurrency(tasks, limit) {
    const results = [];
    let idx = 0;
    async function worker() {
        while (idx < tasks.length) {
            const i = idx++;
            results[i] = await tasks[i]();
        }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
