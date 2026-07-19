/**
 * Skill manager subpanel.
 *
 * A popup launched from the orchestrator config that lists installed skills
 * across all three scopes, with per-row actions (View, Edit, Move to,
 * Rename, Delete — collapsed behind a "⋮" disclosure on each card) plus a
 * top toolbar for import (bundled/file/URL, merged behind one "Import
 * skill ▾" button), export (pick any subset across scopes, packed into one
 * downloadable file), and create-new.
 *
 * The filter is a fixed 4-bucket select (All/Global/Preset/Character —
 * see `scopeBucketOf`). Global always renders as a flat card list (there's
 * only one). Preset/Character render as a collapsible section: a header
 * toggle reveals a name-picker row per instance that actually has ≥1 skill
 * (instances with none are omitted), including a leading "All" row that
 * merges every instance's cards into one list (each tagged with its
 * source). Picking a specific instance narrows to just its cards. See
 * `renderNamedSection` for the full mechanics, and `openSkillManagerPanel`'s
 * `initialScope` handling for how a deep link (e.g. CPA's "bundle skills
 * with this preset") auto-opens + auto-picks the right instance.
 *
 * All write paths flow through `context.skills.*` — the JS API. The panel
 * never touches `fetch` directly; this keeps the CSRF / auth concerns
 * centralized in the JS API and lets the skill-resolution cache invalidate
 * uniformly via the REST layer.
 *
 * Inline-tested helpers are exported for use by the test suite without
 * needing a DOM (Luker's Jest config runs in node, not jsdom). The
 * interactive `openSkillManagerPanel` entry point is exported for use by
 * orchestrator's main.js.
 *
 * Edit + Create-new wire through to `openSkillEditor` / `openCreateNewSkillFlow`
 * from skill-editor.js. Editor's `onChange` callback refreshes the manager
 * so updated descriptions / new skills show up without reload.
 */

import { openSkillEditor, openCreateNewSkillFlow } from './skill-editor.js';
import { renderBundledBrowser, describeBundledImportResult } from './bundled-browser.js';
import { ensureSkillI18n } from './i18n.js';
import { pickTargetScope as pickTargetScopeImpl } from './scope-picker.js';

export const SKILL_PANEL_STYLESHEET_ID = 'luker_skill_manager_stylesheet';
export const SKILL_PANEL_STYLESHEET_HREF = '/scripts/skills/skill-manager-panel.css';

/**
 * Lazily inject the panel's stylesheet into `<head>`. Idempotent; mirrors
 * the pattern in `iteration-library/text-diff.js`'s `ensureStylesheetInjected`.
 * No-ops in non-DOM environments (Jest runs in node, no document global).
 */
export function ensureSkillPanelStylesheetInjected() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(SKILL_PANEL_STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = SKILL_PANEL_STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = SKILL_PANEL_STYLESHEET_HREF;
    document.head.appendChild(link);
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Format a SkillScope object as a short user-facing label.
 * Mirrors `src/skills/scope.js` scopeLabel — duplicated here to avoid
 * pulling node-only modules into the browser bundle.
 *
 * @param {object} scope
 * @returns {string}
 */
export function formatScopeLabel(scope, t = (s) => s) {
    if (!scope || typeof scope !== 'object') return t('unknown');
    switch (scope.kind) {
        case 'global': return t('global');
        case 'preset': return `${t('preset')}: ${scope.name}`;
        case 'character': return `${t('character')}: ${scope.characterFile}`;
        case 'orch-preset': return `${t('Orchestrator preset')}: ${scope.mode}/${scope.name}`;
        default: return t('unknown');
    }
}

/**
 * Compare two scopes for equality. Used for collision detection and to
 * shortcut a no-op move-scope.
 *
 * @param {object} a
 * @param {object} b
 */
export function scopesEqual(a, b) {
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'global') return true;
    if (a.kind === 'preset') return a.name === b.name;
    if (a.kind === 'character') return a.characterFile === b.characterFile;
    if (a.kind === 'orch-preset') return a.mode === b.mode && a.name === b.name;
    return false;
}

/**
 * Stable JSON-string key for a scope. Lets us group skills via Map keys.
 *
 * @param {object} scope
 * @returns {string}
 */
export function scopeKey(scope) {
    if (!scope || typeof scope !== 'object') return '';
    switch (scope.kind) {
        case 'global': return 'global';
        case 'preset': return `preset/${scope.name}`;
        case 'character': return `character/${scope.characterFile}`;
        case 'orch-preset': return `orch-preset/${scope.mode}/${scope.name}`;
        default: return '';
    }
}

/**
 * Group a flat skill-index list into ordered groups keyed by scope, in the
 * order: global → preset → character. Within each kind, alphabetize the
 * sub-keys (preset name, character file). Within a group, skills are
 * sorted by name.
 *
 * @param {Array} skills - flat list as returned by `context.skills.list({scope:'all'})`
 * @returns {Array<{scope: object, label: string, skills: Array}>}
 */
export function groupSkillsByScope(skills) {
    const groups = new Map();
    for (const s of Array.isArray(skills) ? skills : []) {
        if (!s || !s.scope) continue;
        const key = scopeKey(s.scope);
        if (!key) continue;
        if (!groups.has(key)) {
            groups.set(key, { scope: s.scope, label: formatScopeLabel(s.scope), skills: [] });
        }
        groups.get(key).skills.push(s);
    }
    // Within each group, sort skills by name.
    for (const g of groups.values()) {
        g.skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    // Sort groups by kind priority then by key.
    const kindOrder = { global: 0, preset: 1, character: 2, 'orch-preset': 3 };
    return Array.from(groups.values()).sort((a, b) => {
        const ka = kindOrder[a.scope.kind] ?? 99;
        const kb = kindOrder[b.scope.kind] ?? 99;
        if (ka !== kb) return ka - kb;
        return scopeKey(a.scope).localeCompare(scopeKey(b.scope));
    });
}

/**
 * Filter a grouped list by an optional scope filter. The filter is either
 * the sentinel `'all'`, a stringified scope key, a bare scope KIND
 * ('preset' | 'character' — matches every instance of that kind; see
 * `scopeBucketOf`), or a SkillScope object.
 *
 * @param {Array} groups - output of groupSkillsByScope
 * @param {'all'|string|object} filter
 * @returns {Array}
 */
export function filterGroups(groups, filter) {
    if (!filter || filter === 'all') return groups;
    const key = typeof filter === 'string' ? filter : scopeKey(filter);
    if (!key) return groups;
    // Bare kind words match every instance of that kind — this is what
    // lets the toolbar's fixed "Preset skills" / "Character skills"
    // buckets show every preset/character's skills at once, while a
    // specific scope key (e.g. 'preset/rp') still narrows to just one.
    // 'global' is already both the bucket word and the sole exact key
    // for that kind, so this only adds real behavior for the two
    // multi-instance kinds.
    if (key === 'preset' || key === 'character' || key === 'orch-preset') {
        return groups.filter(g => g.scope.kind === key);
    }
    return groups.filter(g => scopeKey(g.scope) === key);
}

/**
 * Derive which of the 4 fixed toolbar buckets a filter key belongs to.
 * `'all'` and `'global'` are buckets in their own right; any exact
 * `preset/<name>` or `character/<file>` key belongs to the `'preset'` /
 * `'character'` bucket respectively.
 *
 * @param {string} filterKey
 * @returns {'all'|'global'|'preset'|'character'}
 */
export function scopeBucketOf(filterKey) {
    if (filterKey === 'global' || filterKey === 'preset' || filterKey === 'character' || filterKey === 'orch-preset') return filterKey;
    if (typeof filterKey === 'string' && filterKey.startsWith('orch-preset/')) return 'orch-preset';
    if (typeof filterKey === 'string' && filterKey.startsWith('preset/')) return 'preset';
    if (typeof filterKey === 'string' && filterKey.startsWith('character/')) return 'character';
    return 'all';
}

/**
 * The instance name/file a filter key narrows to within its bucket, or
 * null when the key is a bare bucket / 'all' (no specific instance picked).
 *
 * @param {string} filterKey
 * @returns {string|null}
 */
export function scopeInstanceOf(filterKey) {
    if (typeof filterKey === 'string' && filterKey.startsWith('orch-preset/')) return filterKey.slice('orch-preset/'.length);
    if (typeof filterKey === 'string' && filterKey.startsWith('preset/')) return filterKey.slice('preset/'.length);
    if (typeof filterKey === 'string' && filterKey.startsWith('character/')) return filterKey.slice('character/'.length);
    return null;
}

/**
 * Detect the import payload shape from a filename + raw bytes (string or
 * Uint8Array). Used by "Import from file..." to decide whether to wrap the
 * bytes as an archive-base64-v1 item or parse as a full embed payload JSON.
 *
 * Returns one of:
 *   - `{ kind: 'embed-json', payload }` — the file is a parsed embed payload
 *     already (e.g. a `.json` file with `{ version: 1, items: [...] }`).
 *   - `{ kind: 'archive', defaultName, contentBase64 }` — the file is a zip
 *     bundle; caller must wrap into a single-item embed payload.
 *   - `{ kind: 'unknown', reason }` — could not classify.
 *
 * Caller is responsible for sha256 computation; the panel passes that on to
 * the server which verifies during materialize.
 *
 * @param {string} filename
 * @param {Uint8Array|ArrayBuffer|string} bytes
 * @returns {{kind:'embed-json',payload:object}|{kind:'archive',defaultName:string,contentBase64:string}|{kind:'unknown',reason:string}}
 */
export function inferImportFormat(filename, bytes) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    if (ext === 'json') {
        try {
            const text = typeof bytes === 'string'
                ? bytes
                : new TextDecoder('utf-8').decode(bytes);
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.items)) {
                return { kind: 'embed-json', payload: parsed };
            }
            return { kind: 'unknown', reason: 'JSON missing { version: 1, items: [...] }' };
        } catch (e) {
            return { kind: 'unknown', reason: `invalid JSON: ${e.message}` };
        }
    }
    if (ext === 'zip') {
        // Strip extension for the default skill name; server-side materialize
        // overrides this from the SKILL.md frontmatter anyway, so the value
        // here only shows up in conflict-preview UI.
        const base = String(filename || '').replace(/\.zip$/i, '') || 'imported';
        const defaultName = base.replace(/[^A-Za-z0-9._-]/g, '-');
        const contentBase64 = encodeBase64(bytes);
        return { kind: 'archive', defaultName, contentBase64 };
    }
    return { kind: 'unknown', reason: `unsupported file extension: ${ext}` };
}

/**
 * Build an embed payload wrapping a single archive item. Used after
 * `inferImportFormat` returns 'archive' so the panel can hand it to
 * `executeExtractEmbed` (which handles archive-base64-v1 + sha256).
 *
 * @param {string} name
 * @param {string} contentBase64
 * @param {string} [sha256]
 * @returns {{version:1, items:Array}}
 */
export function buildArchiveEmbedPayload(name, contentBase64, sha256) {
    const item = {
        bundleFormat: 'archive-base64-v1',
        name: String(name || 'imported'),
        contentBase64: String(contentBase64 || ''),
    };
    if (sha256) item.sha256 = String(sha256);
    return { version: 1, items: [item] };
}

/**
 * Base64-encode bytes from any reasonable input shape. Browsers don't have
 * a built-in Uint8Array → base64 path (`btoa` only takes strings); we walk
 * the bytes 32KB at a time to avoid blowing the stack on large archives.
 *
 * The Node fallback exists only to support unit tests; production code
 * runs under `public/` where `btoa` is always defined.
 *
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {string}
 */
export function encodeBase64(input) {
    const NodeBuffer = typeof globalThis !== 'undefined' ? globalThis.Buffer : undefined;
    if (typeof input === 'string') {
        if (typeof btoa === 'function') return btoa(input);
        return NodeBuffer.from(input, 'binary').toString('base64');
    }
    const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
    if (typeof btoa === 'function') {
        let out = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
            out += String.fromCharCode(...slice);
        }
        return btoa(out);
    }
    return NodeBuffer.from(bytes).toString('base64');
}

// Import: map each category folder back to a scope kind + how many instance
// segments follow (which preset / character card / orch mode+preset). Mirrors
// scopeToExportDir. English scope-kind folder names are also accepted so a
// hand-made bundle round-trips too.
const IMPORT_CATEGORY = Object.freeze({
    '全局技能': { kind: 'global', depth: 0 },
    '预设技能': { kind: 'preset', depth: 1 },
    '角色卡技能': { kind: 'character', depth: 1 },
    '编排器预设技能': { kind: 'orch-preset', depth: 2 },
    'global': { kind: 'global', depth: 0 },
    'preset': { kind: 'preset', depth: 1 },
    'character': { kind: 'character', depth: 1 },
    'orch-preset': { kind: 'orch-preset', depth: 2 },
});

function reconstructScope(kind, instance) {
    switch (kind) {
        case 'global': return { kind: 'global' };
        case 'preset': return { kind: 'preset', name: instance[0] };
        case 'character': return { kind: 'character', characterFile: instance[0] };
        case 'orch-preset': return { kind: 'orch-preset', mode: instance[0], name: instance[1] };
        default: return null;
    }
}

/**
 * Parse a flat list of zip entry paths from a scope-organized installation
 * package back into skills, each carrying the scope (binding) it was exported
 * from — the inverse of scopeToExportDir + exportEntryPath. Two shapes:
 *   - `SKILL.md` at the archive root → one bare skill (scope null → caller asks
 *     where to import it).
 *   - `<category>/[<instance…>/]<id>.md` (+ optional `<…>/<id>/<extra>` files)
 *     → one skill per id, restored to its original scope.
 * Unknown top-level folders and stray files are ignored.
 *
 * @param {string[]} paths
 * @returns {Array<{scope:object|null, name:string, files:Array<{full:string, rel:string}>}>}
 */
export function parseExportedSkills(paths) {
    const list = (Array.isArray(paths) ? paths : [])
        .map(p => String(p).replace(/^\/+/, ''))
        .filter(p => p && !p.endsWith('/'));
    // Bare single skill: SKILL.md at the archive root.
    if (list.includes('SKILL.md')) {
        return [{ scope: null, name: '', files: list.map(p => ({ full: p, rel: p })) }];
    }
    const byKey = new Map();
    for (const full of list) {
        const segs = full.split('/');
        const cat = IMPORT_CATEGORY[segs[0]];
        if (!cat) continue;                            // unknown category
        const rest = segs.slice(1);
        if (rest.length < cat.depth + 1) continue;     // not enough segments
        const instance = rest.slice(0, cat.depth);
        const scope = reconstructScope(cat.kind, instance);
        if (!scope) continue;
        const tail = rest.slice(cat.depth);
        let id, rel;
        if (tail.length === 1 && /\.md$/i.test(tail[0])) {
            id = tail[0].replace(/\.md$/i, '');        // <id>.md → the skill's SKILL.md
            rel = 'SKILL.md';
        } else if (tail.length >= 2) {
            id = tail[0];                              // <id>/<extra…> → an extra file
            rel = tail.slice(1).join('/');
        } else {
            continue;
        }
        const key = JSON.stringify([scopeKey(scope), id]);
        if (!byKey.has(key)) byKey.set(key, { scope, name: id, files: [] });
        byKey.get(key).files.push({ full, rel });
    }
    return Array.from(byKey.values());
}

/**
 * Detect a rename collision: would renaming a skill to `newName` in
 * `scope` overwrite an existing skill?
 *
 * @param {Array} skills - flat skill-index list
 * @param {object} scope
 * @param {string} oldName - the skill currently being renamed
 * @param {string} newName - the desired new name
 * @returns {boolean}
 */
export function hasRenameCollision(skills, scope, oldName, newName) {
    if (!newName || newName === oldName) return false;
    return Array.isArray(skills) && skills.some(s =>
        s && s.name === newName && scopesEqual(s.scope, scope),
    );
}

/**
 * Detect a move-scope collision: would moving a skill into `toScope`
 * overwrite an existing skill of the same name there?
 *
 * @param {Array} skills - flat skill-index list
 * @param {string} name
 * @param {object} fromScope
 * @param {object} toScope
 * @returns {boolean}
 */
export function hasMoveScopeCollision(skills, name, fromScope, toScope) {
    if (scopesEqual(fromScope, toScope)) return false;
    return Array.isArray(skills) && skills.some(s =>
        s && s.name === name && scopesEqual(s.scope, toScope),
    );
}

// ── Export picker (pure helpers) ───────────────────────────────────────────

/**
 * Group flat `{name, scope}` export picks by scope key into batches
 * suitable for one `context.skills.packForEmbed({scope, names})` call each
 * — that API only accepts a single scope + name list, but a user's export
 * selection can span global + several presets/characters at once.
 *
 * @param {Array<{name:string, scope:object}>} picks
 * @returns {Array<{scope:object, names:string[]}>}
 */
export function groupExportPicksByScope(picks) {
    const byKey = new Map();
    for (const p of Array.isArray(picks) ? picks : []) {
        if (!p || !p.scope || !p.name) continue;
        const key = scopeKey(p.scope);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, { scope: p.scope, names: [] });
        byKey.get(key).names.push(p.name);
    }
    return Array.from(byKey.values());
}

/**
 * Merge multiple `{version:1, items:[...]}` embed payloads (one per scope
 * batch from `packForEmbed`) into a single payload for a one-file export —
 * the same shape "Import from file..." already knows how to read back in.
 *
 * @param {Array<{version:1, items:Array}|null|undefined>} payloads
 * @returns {{version:1, items:Array}}
 */
export function mergeEmbedPayloads(payloads) {
    const items = [];
    for (const p of Array.isArray(payloads) ? payloads : []) {
        if (p && Array.isArray(p.items)) items.push(...p.items);
    }
    return { version: 1, items };
}

/**
 * Map a skill's scope to its category folder path in the exported archive — a
 * directory tree mirroring the skill manager panel's grouping: category → the
 * specific container the skill is bound to. Fixed Chinese labels match the
 * panel's filter buckets; instance names (preset / character card / orch
 * mode+preset) form the deeper folders. Path-unsafe chars are sanitized.
 *
 *   global      → 全局技能
 *   preset      → 预设技能/<预设名>
 *   character   → 角色卡技能/<角色卡>
 *   orch-preset → 编排器预设技能/<模式>/<预设名>
 *
 * @param {object} scope
 * @returns {string}
 */
export function scopeToExportDir(scope) {
    const safe = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名';
    if (!scope || typeof scope !== 'object') return '未分类技能';
    switch (scope.kind) {
        case 'global': return '全局技能';
        case 'preset': return `预设技能/${safe(scope.name)}`;
        case 'character': return `角色卡技能/${safe(scope.characterFile)}`;
        case 'orch-preset': return `编排器预设技能/${safe(scope.mode)}/${safe(scope.name)}`;
        default: return '未分类技能';
    }
}

/**
 * The zip entry path for one of a skill's files. A skill's SKILL.md becomes
 * `<scopeDir>/<id>.md` (the skill IS a single file named by its id); any other
 * file travels with it inside a sibling `<scopeDir>/<id>/<relPath>` folder.
 *
 * @param {object} scope - the skill's scope (→ category folder)
 * @param {string} id - the skill name/id
 * @param {string} relPath - the file's path within the skill (e.g. 'SKILL.md')
 * @returns {string}
 */
export function exportEntryPath(scope, id, relPath) {
    const dir = scopeToExportDir(scope);
    const safeId = String(id ?? '').replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名';
    return relPath === 'SKILL.md' ? `${dir}/${safeId}.md` : `${dir}/${safeId}/${relPath}`;
}

/**
 * Build the export picker dialog body: every installed skill, grouped by
 * scope, each with a real checkbox (checked by default — the common case
 * is "export everything"; unchecking narrows the selection) plus one
 * master "Select all" checkbox that cascades via a change listener wired
 * by the caller (native checkboxes don't cascade on their own).
 *
 * @param {Array} groups - groupSkillsByScope(...) output, unfiltered
 * @param {(s: string) => string} t
 * @param {(s: string) => string} esc
 * @returns {string}
 */
export function buildExportDialogHtml(groups, t, esc) {
    const totalCount = groups.reduce((n, g) => n + g.skills.length, 0);
    if (totalCount === 0) {
        return `<div class="luker_skill_empty">${esc(t('No skills to export.'))}</div>`;
    }
    const groupsHtml = groups.map(g => `
        <div class="luker_skill_export_group" data-scope-key="${esc(scopeKey(g.scope))}">
            <label class="luker_skill_export_group_head" title="${esc(t('Select all in this category'))}">
                <input type="checkbox" checked data-skill-export-group-all />
                ${renderScopeBadge(g.scope, t, esc)}
                <span class="luker_skill_group_count">${esc(t('${0} skills').replace('${0}', String(g.skills.length)))}</span>
            </label>
            ${g.skills.map(s => `
                <label class="luker_skill_export_row">
                    <input type="checkbox" checked data-skill-export-name="${esc(s.name)}" data-skill-export-scope="${esc(JSON.stringify(s.scope))}" />
                    <div class="luker_skill_export_row_main">
                        <div class="luker_skill_export_row_name">${esc(s.name)}</div>
                        <div class="luker_skill_export_row_desc">${esc(s.description || t('(no description)'))}</div>
                    </div>
                </label>
            `).join('')}
        </div>
    `).join('');
    const countText = t('Selected ${0} / ${1}').replace('${0}', String(totalCount)).replace('${1}', String(totalCount));
    return `
        <div class="luker_skill_export_dialog">
            <div class="luker_skill_export_toolbar">
                <label class="luker_skill_export_select_all">
                    <input type="checkbox" checked data-skill-export-select-all />
                    ${esc(t('Select all'))}
                </label>
                <span data-skill-export-count>${esc(countText)}</span>
            </div>
            <div class="luker_skill_export_scroll">${groupsHtml}</div>
        </div>
    `;
}

/**
 * Scrape the export dialog's checked boxes back into `{name, scope}` picks.
 * Called from the popup's `onClosing` hook (AFFIRMATIVE path only), same
 * idiom as `embed-import-dialog.js`'s `collectConflictStrategies`.
 *
 * @param {Element} dlg - popup.dlg
 * @returns {Array<{name:string, scope:object}>}
 */
export function collectExportPicks(dlg) {
    const picks = [];
    const boxes = dlg.querySelectorAll('input[data-skill-export-name]:checked');
    for (const box of boxes) {
        const name = box.getAttribute('data-skill-export-name');
        let scope = null;
        try { scope = JSON.parse(box.getAttribute('data-skill-export-scope')); } catch { /* ignore malformed */ }
        if (name && scope) picks.push({ name, scope });
    }
    return picks;
}

/**
 * Scope badge chip — shared by the global section header and the
 * preset/character section headers.
 *
 * @param {object} scope
 * @param {(s: string) => string} t
 * @param {(s: string) => string} esc
 * @returns {string}
 */
export function renderScopeBadge(scope, t, esc) {
    const kind = scope?.kind || 'unknown';
    const kindClass = `luker_skill_scope_badge_${esc(kind)}`;
    const kindName = esc(t(kind === 'global' ? 'Global' : kind === 'preset' ? 'Preset' : 'Character'));
    return `<span class="luker_skill_scope_badge ${kindClass}">
        <span class="luker_skill_scope_badge_kind">${kindName}</span>
    </span>`;
}

/**
 * Render one skill as a card (view/edit/move/rename/delete collapse behind
 * a native `<details>` "⋮" disclosure — same `data-skill-action` buttons as
 * before, just hidden until opened, so existing click-delegation and tests
 * keep working unchanged).
 *
 * @param {object} skill
 * @param {(s: string) => string} t
 * @param {(s: string) => string} esc
 * @param {string} [sourceLabel] - when this card is shown as part of a
 *   merged "All" view spanning multiple preset/character instances, the
 *   instance name/file it actually belongs to (shown as a small tag).
 * @returns {string}
 */
export function renderSkillCard(skill, t, esc, sourceLabel) {
    const scopeStr = JSON.stringify(skill.scope);
    const fileLabel = t('${0} files').replace('${0}', String(skill.fileCount ?? 0));
    return `
        <div class="luker_skill_row luker_skill_row_card" data-skill-name="${esc(skill.name)}" data-skill-scope="${esc(scopeStr)}">
            <div class="luker_skill_row_main">
                <div class="luker_skill_row_head">
                    <div class="luker_skill_row_name" title="${esc(skill.name)}">${esc(skill.name)}</div>
                    <div class="luker_skill_row_meta">
                        <span class="luker_skill_meta_chip">${esc(fileLabel)}</span>
                        ${skill.hasScripts ? `<span class="luker_skill_meta_chip luker_skill_meta_chip_warn" title="${esc(t('has scripts'))}">${esc(t('has scripts'))}</span>` : ''}
                        ${skill.hasBinary ? `<span class="luker_skill_meta_chip" title="${esc(t('binary'))}">${esc(t('binary'))}</span>` : ''}
                    </div>
                </div>
                <div class="luker_skill_row_desc">${esc(skill.description || t('(no description)'))}</div>
                ${sourceLabel ? `<div class="luker_skill_row_card_source">${esc(t('From: ${0}').replace('${0}', sourceLabel))}</div>` : ''}
            </div>
            <details class="luker_skill_row_actions_disclosure">
                <summary class="luker_skill_row_kebab" title="${esc(t('Actions'))}">⋮</summary>
                <div class="luker_skill_row_actions">
                    <div class="luker_skill_row_actions_group">
                        <div class="menu_button menu_button_small luker_skill_row_btn" data-skill-action="view" title="${esc(t('View'))}">${esc(t('View'))}</div>
                        <div class="menu_button menu_button_small luker_skill_row_btn luker_skill_row_btn_primary" data-skill-action="edit" title="${esc(t('Edit'))}">${esc(t('Edit'))}</div>
                    </div>
                    <div class="luker_skill_row_actions_group">
                        <div class="menu_button menu_button_small luker_skill_row_btn" data-skill-action="move" title="${esc(t('Move to...'))}">${esc(t('Move to...'))}</div>
                        <div class="menu_button menu_button_small luker_skill_row_btn" data-skill-action="rename" title="${esc(t('Rename'))}">${esc(t('Rename'))}</div>
                    </div>
                    <div class="luker_skill_row_actions_group">
                        <div class="menu_button menu_button_small luker_skill_row_btn luker_skill_row_btn_danger luker_skill_row_delete" data-skill-action="delete" title="${esc(t('Delete'))}">${esc(t('Delete'))}</div>
                    </div>
                </div>
            </details>
        </div>
    `;
}

/**
 * The Global section — always a flat card list, no name-picker (there's
 * only one global bucket, nothing to pick between).
 *
 * @param {{scope: object, skills: Array}|undefined} globalGroup
 * @param {(s: string) => string} t
 * @param {(s: string) => string} esc
 * @returns {string}
 */
export function renderGlobalSection(globalGroup, t, esc) {
    const skills = globalGroup ? globalGroup.skills : [];
    return `
        <section class="luker_skill_group" data-scope-key="global">
            <header class="luker_skill_group_header">
                ${renderScopeBadge({ kind: 'global' }, t, esc)}
                <span class="luker_skill_group_count">${esc(t('${0} skills').replace('${0}', String(skills.length)))}</span>
            </header>
            <div class="luker_skill_group_rows_cards">
                ${skills.length === 0
        ? `<div class="luker_skill_empty">${esc(t('(no skills in this scope)'))}</div>`
        : skills.map(s => renderSkillCard(s, t, esc)).join('')}
            </div>
        </section>
    `;
}

/**
 * The Preset / Character section — a collapsible header (click to toggle
 * `namesOpen`) revealing a picker row per instance that actually has ≥1
 * skill (instances with none are omitted entirely), plus a leading "All"
 * picker row that merges every instance's skills into one card list
 * (each card tagged with which instance it came from). Picking a specific
 * instance narrows to just its cards.
 *
 * @param {'preset'|'character'|'orch-preset'} kind
 * @param {Array<{scope:object, skills:Array}>} groupsOfKind
 * @param {boolean} namesOpen
 * @param {string|null} activeName - '__all__', an instance name/file, or null.
 *   For orch-preset the instance is the compound `mode/name` string.
 * @param {(s: string) => string} t
 * @param {(s: string) => string} esc
 * @returns {string}
 */
export function renderNamedSection(kind, groupsOfKind, namesOpen, activeName, t, esc) {
    const kindLabel = kind === 'preset' ? t('Preset') : kind === 'character' ? t('Character') : t('Orchestrator preset');
    const instanceLabel = (scope) => (kind === 'preset' ? scope.name : kind === 'character' ? scope.characterFile : `${scope.mode}/${scope.name}`) || '?';

    if (groupsOfKind.length === 0) {
        return `
        <section class="luker_skill_group" data-scope-key="${kind}">
            <header class="luker_skill_group_header">
                <span class="luker_skill_scope_badge">${esc(kindLabel)}</span>
            </header>
            <div class="luker_skill_empty">${esc(t('(no skills in this scope)'))}</div>
        </section>`;
    }

    const totalCount = groupsOfKind.reduce((n, g) => n + g.skills.length, 0);
    const allActive = activeName === '__all__';
    const pickerRows = [
        `<div class="luker_skill_row luker_skill_picker_row luker_skill_picker_row_all${allActive ? ' luker_skill_picker_row_active' : ''}" data-skill-toggle-kind="${kind}" data-skill-toggle-name="__all__">
            <div class="luker_skill_row_main"><div class="luker_skill_row_name">${esc(t('All'))}</div></div>
            <span class="luker_skill_picker_row_count">${totalCount}</span>
        </div>`,
        ...groupsOfKind.map((g) => {
            const name = instanceLabel(g.scope);
            const active = name === activeName;
            return `<div class="luker_skill_row luker_skill_picker_row${active ? ' luker_skill_picker_row_active' : ''}" data-skill-toggle-kind="${kind}" data-skill-toggle-name="${esc(name)}">
                <div class="luker_skill_row_main"><div class="luker_skill_row_name">${esc(name)}</div></div>
                <span class="luker_skill_picker_row_count">${g.skills.length}</span>
            </div>`;
        }),
    ].join('');

    let cardsHtml = '';
    if (allActive) {
        cardsHtml = groupsOfKind.flatMap(g => g.skills.map(s => renderSkillCard(s, t, esc, instanceLabel(g.scope)))).join('');
    } else if (activeName) {
        const g = groupsOfKind.find(g => instanceLabel(g.scope) === activeName);
        if (g) cardsHtml = g.skills.map(s => renderSkillCard(s, t, esc)).join('');
    }

    return `
        <section class="luker_skill_group" data-scope-key="${kind}">
            <header class="luker_skill_group_header luker_skill_group_header_toggle" data-skill-toggle-names="${kind}">
                <span class="luker_skill_scope_badge">${esc(kindLabel)}</span>
                <span class="luker_skill_group_count">${esc(t('${0} skills').replace('${0}', String(totalCount)))}</span>
                <span class="luker_skill_group_header_chevron">${namesOpen ? '▲' : '▾'}</span>
            </header>
            ${namesOpen ? `
                <div class="luker_skill_group_rows">${pickerRows}</div>
                ${cardsHtml
        ? `<div class="luker_skill_group_rows_cards">${cardsHtml}</div>`
        : `<div class="luker_skill_picker_hint">${esc(t('Pick a name above to see its skills'))}</div>`}
            ` : ''}
        </section>
    `;
}

/**
 * Build the panel's main HTML body from a grouped + filtered list. The
 * caller wires events via delegation on the root container.
 *
 * The tab strip (Installed / Browse bundled) is always rendered so users can
 * see what's available even when the chosen tab body is empty. The bundled
 * tab is rendered by `bundled-browser.js` into the same body container.
 *
 * @param {Array} groups - filterGroups(groupSkillsByScope(...), filter)
 * @param {Array} allScopes - list of scopes that appear anywhere in the
 *   inventory (currently unused by the fixed 4-bucket filter UI, kept as a
 *   param for backward-compat with existing callers)
 * @param {string} selectedFilterKey - currently-selected filter ('all', a
 *   bare bucket, or a scope key — see `scopeBucketOf`/`scopeInstanceOf`)
 * @param {'installed'|'bundled'} activeTab
 * @param {(s: string) => string} t - i18n helper
 * @param {(s: string) => string} esc - html-escape helper
 * @param {object} [uiState] - `{presetNamesOpen, characterNamesOpen,
 *   activePresetName, activeCharacterName}`. The `*NamesOpen` flags default
 *   to false (auto-forced true when that bucket is the exclusive filter,
 *   see below); `active*Name` is `'__all__'`, an instance name/file, or
 *   null/omitted for "nothing picked yet".
 * @returns {string}
 */
export function buildPanelHtml(groups, allScopes, selectedFilterKey, activeTab, t, esc, uiState = {}) {
    const bucket = scopeBucketOf(selectedFilterKey);

    const globalGroup = groups.find(g => g.scope.kind === 'global');
    const presetGroups = groups.filter(g => g.scope.kind === 'preset');
    const characterGroups = groups.filter(g => g.scope.kind === 'character');
    const orchPresetGroups = groups.filter(g => g.scope.kind === 'orch-preset');

    const sections = [];
    if (bucket === 'all' || bucket === 'global') sections.push(renderGlobalSection(globalGroup, t, esc));
    if (bucket === 'all' || bucket === 'preset') {
        // Filtering exclusively to this bucket implies the name-picker is
        // already the whole point of the screen, so open it automatically
        // even if the user never clicked the section header.
        sections.push(renderNamedSection('preset', presetGroups, Boolean(uiState.presetNamesOpen) || bucket === 'preset', uiState.activePresetName || null, t, esc));
    }
    if (bucket === 'all' || bucket === 'character') {
        sections.push(renderNamedSection('character', characterGroups, Boolean(uiState.characterNamesOpen) || bucket === 'character', uiState.activeCharacterName || null, t, esc));
    }
    if (bucket === 'all' || bucket === 'orch-preset') {
        sections.push(renderNamedSection('orch-preset', orchPresetGroups, Boolean(uiState.orchPresetNamesOpen) || bucket === 'orch-preset', uiState.activeOrchPresetName || null, t, esc));
    }

    const installedBody = groups.length === 0
        ? `<div class="luker_skill_empty luker_skill_empty_root">
              <div class="luker_skill_empty_title">${esc(t('No skills installed yet.'))}</div>
              <div class="luker_skill_empty_hint">${esc(t('Use Import or Create to add some.'))}</div>
           </div>`
        : sections.join('');

    const installedActive = activeTab !== 'bundled';
    const tabStrip = `
        <div class="luker_skill_manager_tabs" role="tablist">
            <div class="luker_skill_tab${installedActive ? ' luker_skill_tab_active' : ''}" data-skill-tab="installed" role="tab">${esc(t('Installed'))}</div>
            <div class="luker_skill_tab${installedActive ? '' : ' luker_skill_tab_active'}" data-skill-tab="bundled" role="tab">${esc(t('Browse bundled'))}</div>
        </div>
    `;

    // For the bundled tab, leave an empty mount that renderBundledBrowser
    // paints into asynchronously — keeps buildPanelHtml synchronous and
    // unit-testable while still supporting the live tab.
    const bundledMount = '<div class="luker_skill_manager_bundled_mount"></div>';

    // Fixed 4-bucket filter — replaces the old "one <option> per scope
    // instance" dropdown. Specific instances are picked via the name-picker
    // rows inside the preset/character sections instead (see
    // renderNamedSection); the select's value is always one of these 4.
    const filterOptions = [
        ['all', 'All skills'],
        ['global', 'Global skills'],
        ['preset', 'Preset skills'],
        ['character', 'Character skills'],
        ['orch-preset', 'Orchestrator preset skills'],
    ].map(([value, label]) => `<option value="${value}"${bucket === value ? ' selected' : ''}>${esc(t(label))}</option>`).join('');

    const tabBody = installedActive
        ? `
    <div class="luker_skill_manager_toolbar">
        <label class="luker_skill_filter_label">
            <span class="luker_skill_filter_label_text">${esc(t('Filter by scope:'))}</span>
            <select class="text_pole luker_skill_filter_select" data-skill-filter>${filterOptions}</select>
        </label>
        <div class="luker_skill_manager_toolbar_actions">
            <div class="luker_skill_toolbar_group">
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="import-menu-toggle" title="${esc(t('Import skill'))}">${esc(t('Import skill'))} ▾</div>
                <div class="luker_skill_import_menu" data-skill-import-menu>
                    <div class="menu_button menu_button_small luker_skill_toolbar_btn luker_skill_import_menu_item" data-skill-toolbar="import-file" title="${esc(t('Import from file...'))}">${esc(t('Import from file...'))}</div>
                    <div class="menu_button menu_button_small luker_skill_toolbar_btn luker_skill_import_menu_item" data-skill-toolbar="import-bundled" title="${esc(t('Import bundled'))}">${esc(t('Import bundled'))}</div>
                    <div class="menu_button menu_button_small luker_skill_toolbar_btn luker_skill_import_menu_item" data-skill-toolbar="import-url" title="${esc(t('Import from URL...'))}">${esc(t('Import from URL...'))}</div>
                </div>
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="export" title="${esc(t('Export skill'))}">${esc(t('Export skill'))}</div>
            </div>
            <div class="luker_skill_toolbar_group">
                <div class="menu_button menu_button_small luker_skill_toolbar_btn luker_skill_toolbar_btn_primary" data-skill-toolbar="create" title="${esc(t('Create new'))}">${esc(t('Create new'))}</div>
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="refresh" title="${esc(t('Refresh'))}">${esc(t('Refresh'))}</div>
            </div>
        </div>
    </div>
    <div class="luker_skill_manager_body">${installedBody}</div>
        `
        : bundledMount;

    return `
<div class="luker_skill_manager luker-studio">
    ${tabStrip}
    ${tabBody}
</div>
    `;
}

// ── Interactive popup entry point ─────────────────────────────────────────

/**
 * Open the Skill Manager popup. Resolves once the user closes the popup.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (must expose
 *   `context.skills`, `context.callGenericPopup`, `context.POPUP_TYPE`,
 *   `context.POPUP_RESULT`).
 * @param {object|null} [opts.initialScope] - if provided, seed the scope
 *   filter to this scope (e.g. when launching from the Preset Assistant
 *   "Bundle skills with this preset" link the panel opens already filtered
 *   to the current preset). Pass null or omit for default 'all'.
 * @param {'installed'|'bundled'} [opts.initialTab='installed'] - which tab to
 *   show first. Pass 'bundled' to land directly on the bundled browser.
 * @param {(s: string) => string} [opts.t] - i18n helper; defaults to identity.
 * @returns {Promise<void>}
 */
export async function openSkillManagerPanel({ context, initialScope = null, initialTab = 'installed', t = (s) => s } = {}) {
    if (!context || !context.skills) {
        throw new Error('openSkillManagerPanel: context.skills missing');
    }
    // Self-register Skills UI translations so any caller (orchestrator,
    // completion-preset-assistant, future extensions) gets zh-CN / zh-TW
    // strings without having to copy our locale table into their own setup.
    ensureSkillI18n();
    ensureSkillPanelStylesheetInjected();
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    })[c]);

    // filterKey is always a bare bucket now ('all'|'global'|'preset'|'character')
    // — the fixed 4-option toolbar select never carries a specific instance.
    // A deep-linked initialScope for a preset/character seeds that bucket AND
    // pre-picks + auto-opens the specific instance via the uiState fields
    // below, so CPA's "bundle skills with this preset" link still lands
    // directly on the right preset's cards.
    const state = {
        skills: [],
        filterKey: initialScope ? scopeBucketOf(scopeKey(initialScope)) : 'all',
        presetNamesOpen: Boolean(initialScope && initialScope.kind === 'preset'),
        characterNamesOpen: Boolean(initialScope && initialScope.kind === 'character'),
        orchPresetNamesOpen: Boolean(initialScope && initialScope.kind === 'orch-preset'),
        activePresetName: initialScope && initialScope.kind === 'preset' ? initialScope.name : null,
        activeCharacterName: initialScope && initialScope.kind === 'character' ? initialScope.characterFile : null,
        activeOrchPresetName: initialScope && initialScope.kind === 'orch-preset' ? `${initialScope.mode}/${initialScope.name}` : null,
        tab: initialTab === 'bundled' ? 'bundled' : 'installed',
        mountId: `luker_skill_manager_${Date.now()}`,
    };

    // Defer DOM ops until after the popup mounts. The popup body uses a
    // unique id we paint into the initial HTML; we re-render into that
    // element on every refresh().
    const initialHtml = `<div id="${state.mountId}"></div>`;
    const popupPromise = context.callGenericPopup(initialHtml, context.POPUP_TYPE.TEXT, t('Skill Manager'), {
        okButton: t('Close'),
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    /**
     * Re-fetch the inventory and re-render the panel body. Errors surface as
     * a toast — the panel stays open so the user can retry.
     *
     * When `state.tab === 'bundled'`, the body is handed off to
     * `renderBundledBrowser` which manages its own data fetches; we still
     * render the tab strip first so the user can switch back. We always fetch
     * the installed list anyway because the filter dropdown needs the live
     * scope set even on the bundled tab.
     */
    async function refresh() {
        const mount = document.getElementById(state.mountId);
        if (!mount) return;
        try {
            const skills = await context.skills.list({ scope: 'all' });
            state.skills = Array.isArray(skills) ? skills : [];
        } catch (e) {
            state.skills = [];
            toast(t('Failed to load skills: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
        const grouped = groupSkillsByScope(state.skills);
        const allScopes = dedupeScopes(state.skills.map(s => s.scope));
        // filterKey is always a bare bucket ('all'/'global'/'preset'/'character')
        // so it's never itself invalid. What CAN go stale is a picked preset/
        // character instance (deep-linked or clicked) that got renamed or
        // deleted since the last refresh — drop it so the section falls back
        // to its own "pick a name" hint instead of silently showing nothing.
        if (state.activePresetName && !allScopes.some(s => s.kind === 'preset' && s.name === state.activePresetName)) {
            state.activePresetName = null;
        }
        if (state.activeCharacterName && !allScopes.some(s => s.kind === 'character' && s.characterFile === state.activeCharacterName)) {
            state.activeCharacterName = null;
        }
        if (state.activeOrchPresetName && !allScopes.some(s => s.kind === 'orch-preset' && `${s.mode}/${s.name}` === state.activeOrchPresetName)) {
            state.activeOrchPresetName = null;
        }
        const filtered = filterGroups(grouped, state.filterKey);
        mount.innerHTML = buildPanelHtml(filtered, allScopes, state.filterKey, state.tab, t, esc, {
            presetNamesOpen: state.presetNamesOpen,
            characterNamesOpen: state.characterNamesOpen,
            orchPresetNamesOpen: state.orchPresetNamesOpen,
            activePresetName: state.activePresetName,
            activeCharacterName: state.activeCharacterName,
            activeOrchPresetName: state.activeOrchPresetName,
        });
        bindEvents(mount);
        if (state.tab === 'bundled') {
            const bundledMount = mount.querySelector('.luker_skill_manager_bundled_mount');
            if (bundledMount) {
                try {
                    await renderBundledBrowser({ context, mount: bundledMount, t });
                } catch (e) {
                    toast(t('Failed to render bundled browser: ${0}').replace('${0}', e?.message || String(e)), 'error');
                }
            }
        }
    }

    function bindEvents(root) {
        // Tab switching always available; the per-tab toolbar bindings below
        // are no-ops when their elements aren't in the current DOM.
        root.querySelectorAll('[data-skill-tab]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.preventDefault();
                const next = el.getAttribute('data-skill-tab');
                if (next !== 'installed' && next !== 'bundled') return;
                if (state.tab === next) return;
                state.tab = next;
                void refresh();
            });
        });

        const filterSelect = root.querySelector('[data-skill-filter]');
        if (filterSelect) {
            filterSelect.addEventListener('change', () => {
                // The select only ever offers the 4 bare buckets now, so this
                // always discards whatever specific preset/character instance
                // was previously picked — a manual bucket switch is a fresh
                // start, same as picking "All scopes" used to be.
                state.filterKey = String(filterSelect.value || 'all');
                void refresh();
            });
        }

        // The merged "Import skill ▾" button just toggles visibility of the
        // menu holding the three original import-bundled/file/url buttons —
        // their own click handlers (below, same `data-skill-toolbar` loop)
        // are untouched, so nothing about how imports actually run changed.
        const importMenu = root.querySelector('[data-skill-import-menu]');
        const importToggle = root.querySelector('[data-skill-toolbar="import-menu-toggle"]');
        if (importToggle && importMenu) {
            importToggle.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                importMenu.classList.toggle('luker_skill_import_menu_open');
            });
        }

        root.querySelectorAll('[data-skill-toolbar]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const action = el.getAttribute('data-skill-toolbar');
                if (action === 'import-bundled') {
                    if (importMenu) importMenu.classList.remove('luker_skill_import_menu_open');
                    await handleImportBundled();
                } else if (action === 'import-file') {
                    if (importMenu) importMenu.classList.remove('luker_skill_import_menu_open');
                    await handleImportFile();
                } else if (action === 'import-url') {
                    if (importMenu) importMenu.classList.remove('luker_skill_import_menu_open');
                    await handleImportUrl();
                } else if (action === 'export') {
                    await handleExportPicker();
                } else if (action === 'create') {
                    // openCreateNewSkillFlow walks the user through name +
                    // description + scope, installs the template skill, and
                    // fires onChange so this panel refreshes when the new
                    // skill lands.
                    await openCreateNewSkillFlow({
                        context,
                        t,
                        onChange: () => { void refresh(); },
                    });
                } else if (action === 'refresh') {
                    await refresh();
                }
            });
        });

        // Preset/character section headers double as a collapse toggle for
        // their name-picker row list.
        root.querySelectorAll('[data-skill-toggle-names]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.preventDefault();
                const kind = el.getAttribute('data-skill-toggle-names');
                if (kind === 'preset') state.presetNamesOpen = !state.presetNamesOpen;
                else if (kind === 'character') state.characterNamesOpen = !state.characterNamesOpen;
                else if (kind === 'orch-preset') state.orchPresetNamesOpen = !state.orchPresetNamesOpen;
                void refresh();
            });
        });

        // Name-picker rows: '__all__' merges every instance's skills into one
        // card list (each tagged with its source); a specific name narrows to
        // just that instance. Clicking the already-active row collapses back
        // to the "pick a name" hint.
        root.querySelectorAll('[data-skill-toggle-kind]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.preventDefault();
                const kind = el.getAttribute('data-skill-toggle-kind');
                const name = el.getAttribute('data-skill-toggle-name');
                if (kind === 'preset') {
                    state.activePresetName = (state.activePresetName === name) ? null : name;
                } else if (kind === 'character') {
                    state.activeCharacterName = (state.activeCharacterName === name) ? null : name;
                } else if (kind === 'orch-preset') {
                    state.activeOrchPresetName = (state.activeOrchPresetName === name) ? null : name;
                }
                void refresh();
            });
        });

        root.querySelectorAll('[data-skill-action]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const row = el.closest('[data-skill-name]');
                if (!row) return;
                const name = row.getAttribute('data-skill-name');
                const scope = parseScope(row.getAttribute('data-skill-scope'));
                const action = el.getAttribute('data-skill-action');
                if (action === 'view') {
                    await handleView(scope, name);
                } else if (action === 'edit') {
                    // openSkillEditor uses context.skills.listFiles for the
                    // file tree and writeFile/expectedSha256 for save. We
                    // pass an onChange so descriptions / new files surface
                    // in the manager immediately on save.
                    await openSkillEditor({
                        context,
                        scope,
                        name,
                        t,
                        onChange: () => { void refresh(); },
                    });
                } else if (action === 'move') {
                    await handleMove(scope, name);
                } else if (action === 'rename') {
                    await handleRename(scope, name);
                } else if (action === 'delete') {
                    await handleDelete(scope, name);
                }
            });
        });
    }

    // ── Handlers ─────────────────────────────────────────────────────────

    async function handleImportBundled() {
        try {
            const result = await context.skills.importBundled();
            // The server returns `{installed:number, replaced:number,
            // alreadyInstalled:number}` — the legacy code here treated them as
            // arrays via `.length`, which always coerced to 0 and produced the
            // useless "Bundled import: 0 installed, 0 skipped" toast even on
            // successful imports. Use the shared formatter so this toolbar and
            // the Browse bundled tab stay in lock-step.
            const summary = describeBundledImportResult(result, t);
            toast(summary.text, summary.level);
            await refresh();
        } catch (e) {
            toast(t('Bundled import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    // JSZip is bundled at public/lib/jszip.min.js; load it as a side-effect
    // import that assigns window.JSZip (same idiom as utils.js's epub export).
    // Skips the import when JSZip is already present — lets a test inject a
    // stub and avoids re-loading on repeat export/import.
    async function ensureJSZip() {
        let JSZip = (typeof window !== 'undefined' && window.JSZip) || globalThis.JSZip;
        if (typeof JSZip !== 'function') {
            await import('../../lib/jszip.min.js');
            JSZip = (typeof window !== 'undefined' && window.JSZip) || globalThis.JSZip;
        }
        if (typeof JSZip !== 'function') throw new Error('JSZip unavailable');
        return JSZip;
    }

    /**
     * Turn a `.zip` file's bytes into one embed payload per scope, so each
     * skill can be restored to the binding it was exported from. Handles a
     * bare single-skill zip (SKILL.md at root → one group with scope null, the
     * caller asks where to put it) and a scope-organized installation package
     * (`<category>/[<instance>/]<id>.md` → grouped by scope). Each skill is
     * re-zipped (SKILL.md + its extras) into its own archive item.
     *
     * @returns {Promise<Array<{scope: object|null, payload: {version:1, items:Array}}>>}
     */
    async function zipToScopedPayloads(bytes, filename) {
        const JSZip = await ensureJSZip();
        const zip = await JSZip.loadAsync(bytes);
        const paths = Object.keys(zip.files).filter(p => !zip.files[p].dir);
        const skills = parseExportedSkills(paths);
        if (skills.length === 0) throw new Error(t('No SKILL.md found in the archive'));
        // Bare single skill at the archive root: pass the original bytes
        // straight through; the caller picks a target scope.
        if (skills.length === 1 && skills[0].scope === null) {
            const base = String(filename || '').replace(/\.zip$/i, '') || 'imported';
            return [{ scope: null, payload: buildArchiveEmbedPayload(base.replace(/[^A-Za-z0-9._-]/g, '-'), encodeBase64(bytes)) }];
        }
        // Scope-organized package: re-zip each skill (SKILL.md + extras) into
        // its own archive item, grouped by the scope it belongs to.
        const byScope = new Map();
        for (const skill of skills) {
            const inner = new JSZip();
            for (const f of skill.files) {
                inner.file(f.rel, await zip.file(f.full).async('uint8array'));
            }
            const contentBase64 = await inner.generateAsync({ type: 'base64' });
            const item = { bundleFormat: 'archive-base64-v1', name: skill.name || 'imported', contentBase64 };
            const key = scopeKey(skill.scope);
            if (!byScope.has(key)) byScope.set(key, { scope: skill.scope, items: [] });
            byScope.get(key).items.push(item);
        }
        return Array.from(byScope.values()).map(g => ({ scope: g.scope, payload: { version: 1, items: g.items } }));
    }

    async function handleImportFile() {
        const file = await pickFile('.zip,.json');
        if (!file) return;
        let bytes;
        try {
            bytes = new Uint8Array(await file.arrayBuffer());
        } catch (e) {
            toast(t('Failed to read file: ${0}').replace('${0}', e?.message || String(e)), 'error');
            return;
        }
        const ext = String(file.name || '').toLowerCase().split('.').pop();

        // Non-zip: a JSON embed payload goes into one user-picked scope.
        if (ext !== 'zip') {
            const fmt = inferImportFormat(file.name, bytes);
            if (fmt.kind !== 'embed-json') {
                toast(t('Unsupported file: ${0}').replace('${0}', fmt.reason || fmt.kind), 'error');
                return;
            }
            const targetScope = await pickTargetScope(t('Import into scope'));
            if (!targetScope) return;
            await runExtractWithConflictResolution(fmt.payload, targetScope);
            return;
        }

        let groups;
        try {
            groups = await zipToScopedPayloads(bytes, file.name);
        } catch (e) {
            toast(t('Unsupported file: ${0}').replace('${0}', e?.message || String(e)), 'error');
            return;
        }

        // A bare single-skill zip carries no scope — ask where to put it.
        if (groups.length === 1 && groups[0].scope === null) {
            const targetScope = await pickTargetScope(t('Import into scope'));
            if (!targetScope) return;
            await runExtractWithConflictResolution(groups[0].payload, targetScope);
            return;
        }

        // Scope-organized package: restore each skill to its original binding,
        // then report a per-scope summary — character/preset skills stay hidden
        // in the panel until their container is opened, so the summary is how
        // the user sees what landed where.
        let totalInstalled = 0, failed = 0;
        const parts = [];
        for (const g of groups) {
            try {
                const { installed } = await extractScopeGroup(g.payload, g.scope);
                totalInstalled += installed;
                if (installed) parts.push(`${formatScopeLabel(g.scope, t)}: ${installed}`);
            } catch (e) {
                failed++;
            }
        }
        await refresh();
        const detail = parts.length ? parts.join('、') : '—';
        toast(t('Imported ${0} skill(s): ${1}')
            .replace('${0}', String(totalInstalled))
            .replace('${1}', detail), (failed && totalInstalled === 0) ? 'error' : (failed ? 'info' : 'success'));
    }

    async function handleImportUrl() {
        const url = await context.callGenericPopup(
            t('Enter the URL of a skill zip bundle'),
            context.POPUP_TYPE.INPUT,
            '',
            { okButton: t('Import'), cancelButton: t('Cancel') },
        );
        if (!url || typeof url !== 'string') return;
        const targetScope = await pickTargetScope(t('Import into scope'));
        if (!targetScope) return;
        try {
            const result = await context.skills.importFromUrl({ url: String(url).trim(), targetScope });
            const installed = Array.isArray(result?.installed) ? result.installed.length : 0;
            const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
            toast(t('URL import: ${0} installed, ${1} skipped.')
                .replace('${0}', String(installed))
                .replace('${1}', String(skipped)), 'success');
            await refresh();
        } catch (e) {
            toast(t('URL import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    /**
     * Export picker: lists every installed skill (regardless of the current
     * scope filter) with checkboxes, defaulting to all-checked. Confirms →
     * packs each scope's selected names via `context.skills.packForEmbed`,
     * then assembles a folder-structured `.zip` installation package — one
     * folder per skill (`<name>/SKILL.md`, `<name>/references/…`) — and
     * downloads it. Text skills come back inline; binary/large skills come
     * back as a per-skill archive whose entries are re-nested under the
     * skill's folder.
     */
    async function handleExportPicker() {
        const Popup = context.Popup;
        const POPUP_TYPE = context.POPUP_TYPE;
        const POPUP_RESULT = context.POPUP_RESULT;
        if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
            toast(t('Popup API missing — cannot show export dialog.'), 'error');
            return;
        }
        const groups = groupSkillsByScope(state.skills);
        if (groups.reduce((n, g) => n + g.skills.length, 0) === 0) {
            toast(t('No skills to export.'), 'info');
            return;
        }

        const html = buildExportDialogHtml(groups, t, esc);
        let picks = null;
        const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: t('Export skill'),
            cancelButton: t('Cancel'),
            wider: true,
            allowVerticalScrolling: true,
            onClosing: (p) => {
                // Only scrape on the AFFIRMATIVE path; cancel needs nothing.
                if (p.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                picks = collectExportPicks(p.dlg);
                return true;
            },
        });

        // Native checkboxes don't cascade on their own — wire "select all"
        // + a live count, same pattern as other Skills dialogs that need
        // in-popup interactivity (see embed-import-dialog's radio handling,
        // via `popup.dlg` available synchronously before `.show()`).
        const dlg = popup.dlg;
        const selectAll = dlg.querySelector('[data-skill-export-select-all]');
        const countLabel = dlg.querySelector('[data-skill-export-count]');
        const allBoxes = () => Array.from(dlg.querySelectorAll('input[data-skill-export-name]'));
        const groupAllBoxes = () => Array.from(dlg.querySelectorAll('input[data-skill-export-group-all]'));
        const boxesIn = (groupEl) => Array.from(groupEl.querySelectorAll('input[data-skill-export-name]'));
        const updateCount = () => {
            if (!countLabel) return;
            const boxes = allBoxes();
            const n = boxes.filter(b => b.checked).length;
            countLabel.textContent = t('Selected ${0} / ${1}')
                .replace('${0}', String(n))
                .replace('${1}', String(boxes.length));
        };
        // Reflect current row state up into each category checkbox + the master.
        const syncHeaders = () => {
            for (const gbox of groupAllBoxes()) {
                const groupEl = gbox.closest('.luker_skill_export_group');
                const rows = groupEl ? boxesIn(groupEl) : [];
                gbox.checked = rows.length > 0 && rows.every(b => b.checked);
            }
            if (selectAll) selectAll.checked = allBoxes().every(b => b.checked);
        };
        // Master "select all": cascades to every row + every category checkbox.
        if (selectAll) {
            selectAll.addEventListener('change', () => {
                for (const box of allBoxes()) box.checked = selectAll.checked;
                for (const gbox of groupAllBoxes()) gbox.checked = selectAll.checked;
                updateCount();
            });
        }
        // Per-category "select all": cascades only to that category's rows,
        // so the user can e.g. select every preset skill without touching global.
        for (const gbox of groupAllBoxes()) {
            gbox.addEventListener('change', () => {
                const groupEl = gbox.closest('.luker_skill_export_group');
                if (groupEl) for (const b of boxesIn(groupEl)) b.checked = gbox.checked;
                updateCount();
                if (selectAll) selectAll.checked = allBoxes().every(b => b.checked);
            });
        }
        for (const box of allBoxes()) {
            box.addEventListener('change', () => {
                updateCount();
                syncHeaders();
            });
        }

        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        if (!picks || picks.length === 0) {
            toast(t('No skills selected.'), 'info');
            return;
        }

        try {
            const batches = groupExportPicksByScope(picks);
            const payloads = await Promise.all(
                batches.map(b => context.skills.packForEmbed({ scope: b.scope, names: b.names, mode: 'auto' })),
            );
            // Flatten to per-skill items, each tagged with its source scope
            // (batches[] is index-aligned with payloads[]).
            const taggedItems = [];
            payloads.forEach((p, i) => {
                const scope = batches[i]?.scope;
                for (const item of (p && Array.isArray(p.items) ? p.items : [])) {
                    taggedItems.push({ ...item, scope });
                }
            });
            const JSZip = await ensureJSZip();
            const zip = new JSZip();
            for (const item of taggedItems) {
                // Each skill's SKILL.md → <category>/…/<id>.md; its other files
                // (references/…) travel alongside in <category>/…/<id>/… — the
                // scope decides the category folder (see exportEntryPath).
                const id = item.name;
                if (item.bundleFormat === 'archive-base64-v1' && item.contentBase64) {
                    const inner = await JSZip.loadAsync(item.contentBase64, { base64: true });
                    for (const entry of Object.values(inner.files)) {
                        if (entry.dir) continue;
                        zip.file(exportEntryPath(item.scope, id, entry.name), await entry.async('uint8array'));
                    }
                } else {
                    const files = Array.isArray(item.files) ? item.files : [];
                    for (const f of files) {
                        zip.file(exportEntryPath(item.scope, id, f.path), typeof f.content === 'string' ? f.content : '');
                    }
                }
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const filename = `luker-skills-export-${Date.now()}.zip`;
            downloadBlob(blob, filename);
            toast(t('Exported ${0} skill(s) to ${1}')
                .replace('${0}', String(picks.length))
                .replace('${1}', filename), 'success');
        } catch (e) {
            toast(t('Export failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleView(scope, name) {
        try {
            const result = await context.skills.readFile({ scope, name, path: 'SKILL.md' });
            const body = `<h3>${esc(name)}</h3><pre class="luker_skill_view_pre">${esc(result?.content || '')}</pre>`;
            await context.callGenericPopup(body, context.POPUP_TYPE.TEXT, formatScopeLabel(scope, t), {
                okButton: t('Close'),
                wide: true,
                large: true,
                allowVerticalScrolling: true,
            });
        } catch (e) {
            toast(t('Failed to read skill: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleDelete(scope, name) {
        const ok = await context.callGenericPopup(
            t('Delete skill "${0}" from ${1}? This cannot be undone.')
                .replace('${0}', name)
                .replace('${1}', formatScopeLabel(scope, t)),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: t('Delete'), cancelButton: t('Cancel') },
        );
        if (!isAffirmative(ok)) return;
        try {
            await context.skills.delete(scope, name);
            toast(t('Deleted skill: ${0}').replace('${0}', name), 'success');
            await refresh();
        } catch (e) {
            toast(t('Delete failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleRename(scope, oldName) {
        const newName = await context.callGenericPopup(
            t('Rename skill "${0}" to:').replace('${0}', oldName),
            context.POPUP_TYPE.INPUT,
            oldName,
            { okButton: t('Rename'), cancelButton: t('Cancel') },
        );
        if (!newName || typeof newName !== 'string') return;
        const trimmed = String(newName).trim();
        if (!trimmed || trimmed === oldName) return;
        if (hasRenameCollision(state.skills, scope, oldName, trimmed)) {
            const confirm = await context.callGenericPopup(
                t('A skill named "${0}" already exists in ${1}. Server will refuse the rename. Try a different name?')
                    .replace('${0}', trimmed)
                    .replace('${1}', formatScopeLabel(scope, t)),
                context.POPUP_TYPE.CONFIRM,
                '',
                { okButton: t('Retry'), cancelButton: t('Cancel') },
            );
            if (isAffirmative(confirm)) {
                await handleRename(scope, oldName);
            }
            return;
        }
        try {
            await context.skills.rename(scope, oldName, trimmed);
            toast(t('Renamed: ${0} -> ${1}')
                .replace('${0}', oldName)
                .replace('${1}', trimmed), 'success');
            await refresh();
        } catch (e) {
            toast(t('Rename failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleMove(fromScope, name) {
        const toScope = await pickTargetScope(t('Move "${0}" to scope').replace('${0}', name), fromScope);
        if (!toScope) return;
        if (scopesEqual(fromScope, toScope)) {
            toast(t('Skill already in that scope.'), 'info');
            return;
        }
        if (hasMoveScopeCollision(state.skills, name, fromScope, toScope)) {
            const ok = await context.callGenericPopup(
                t('A skill named "${0}" already exists in ${1}. Move will fail unless you delete the existing one first. Proceed anyway?')
                    .replace('${0}', name)
                    .replace('${1}', formatScopeLabel(toScope, t)),
                context.POPUP_TYPE.CONFIRM,
                '',
                { okButton: t('Proceed'), cancelButton: t('Cancel') },
            );
            if (!isAffirmative(ok)) return;
        }
        try {
            await context.skills.moveScope(name, fromScope, toScope);
            toast(t('Moved ${0}: ${1} -> ${2}')
                .replace('${0}', name)
                .replace('${1}', formatScopeLabel(fromScope, t))
                .replace('${2}', formatScopeLabel(toScope, t)), 'success');
            await refresh();
        } catch (e) {
            toast(t('Move failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    /**
     * Run the preview+execute flow with per-skill conflict resolution. For
     * any 'different' rows we prompt the user with Skip/Replace. 'new' and
     * 'same' rows go through unchanged.
     */
    // Preview one payload against a target scope, prompt for each real content
    // conflict, then execute. Returns {installed, skipped}; throws on failure so
    // the caller decides how to report (one scope vs a multi-scope summary).
    async function extractScopeGroup(payload, targetScope) {
        const preview = await context.skills.previewExtractEmbed({ payload, targetScope });
        const items = Array.isArray(preview?.items) ? preview.items : [];
        const conflictStrategies = {};
        for (const it of items) {
            if (it.conflict === 'different') {
                const ok = await context.callGenericPopup(
                    t('Skill "${0}" already exists in ${1} with different content. Replace it?')
                        .replace('${0}', it.name)
                        .replace('${1}', formatScopeLabel(targetScope, t)),
                    context.POPUP_TYPE.CONFIRM,
                    '',
                    { okButton: t('Replace'), cancelButton: t('Skip') },
                );
                conflictStrategies[it.name] = isAffirmative(ok) ? 'replace' : 'skip';
            }
        }
        const result = await context.skills.executeExtractEmbed({ payload, targetScope, conflictStrategies });
        return {
            installed: Array.isArray(result?.installed) ? result.installed.length : 0,
            skipped: Array.isArray(result?.skipped) ? result.skipped.length : 0,
        };
    }

    async function runExtractWithConflictResolution(payload, targetScope) {
        try {
            const { installed, skipped } = await extractScopeGroup(payload, targetScope);
            toast(t('Imported: ${0} installed, ${1} skipped.')
                .replace('${0}', String(installed))
                .replace('${1}', String(skipped)), 'success');
            await refresh();
        } catch (e) {
            toast(t('Import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    // ── DOM helpers (interactive only) ───────────────────────────────────

    function pickTargetScope(title, suggestScope) {
        return pickTargetScopeImpl(context, t, title, suggestScope);
    }

    async function pickFile(accept) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = accept || '';
            input.style.display = 'none';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                document.body.removeChild(input);
                resolve(file || null);
            });
            // Wire a fallback for cancel: most browsers fire 'cancel' on the
            // input when the user closes the chooser without selecting; we
            // also clean up on next-tick if no change fired and the input
            // is still present (defensive).
            input.addEventListener('cancel', () => {
                if (input.parentNode === document.body) {
                    document.body.removeChild(input);
                }
                resolve(null);
            });
            document.body.appendChild(input);
            input.click();
        });
    }

    /**
     * Trigger a browser download of a Blob. No-ops outside a real DOM —
     * checked via `document.head` (same discriminator
     * `ensureSkillPanelStylesheetInjected` uses) rather than Blob/URL,
     * since Node's Jest environment has real Blob/URL globals but no real
     * `document`; the export flow's own tests cover the pure folder/entry
     * helpers instead of this DOM side effect.
     */
    function downloadBlob(blob, filename) {
        if (typeof document === 'undefined' || !document.head) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function toast(message, level) {
        // The popup is inside a dialog; toastr's container needs to be
        // inside the dialog to be visible. Luker's popup.js already wires
        // this via `fixToastrForDialogs` on popup open, so we just call
        // toastr directly.
        if (typeof toastr === 'undefined') {
            console.warn('[skill-manager-panel]', message);
            return;
        }
        if (level === 'error') toastr.error(String(message));
        else if (level === 'success') toastr.success(String(message));
        else toastr.info(String(message));
    }

    function isAffirmative(result) {
        // POPUP_RESULT.AFFIRMATIVE === 1
        return result === 1 || result === true;
    }

    function parseScope(json) {
        try {
            return JSON.parse(json);
        } catch {
            return null;
        }
    }

    function dedupeScopes(scopes) {
        const seen = new Set();
        const out = [];
        for (const s of scopes) {
            if (!s) continue;
            const k = scopeKey(s);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
        return out;
    }

    // Kick off initial render. The mount node is painted into the popup
    // body synchronously after callGenericPopup returns the promise; we
    // refresh on the next microtask so the DOM is ready.
    Promise.resolve().then(() => { void refresh(); });

    await popupPromise;
}
