/** 透镜配色持久化存储键 */
export const LENS_PALETTE_STORAGE_KEY = 'lt_palette_mode';

/** 挂载在左下角「•••」菜单 #options 顶部的配色条 DOM ID */
export const LENS_PALETTE_STRIP_ID = 'lt-palette-strip';

/** 透镜主题内置的 4 套配色元数据 */
export const LENS_PALETTES = Object.freeze([
    {
        id: '0',
        labelKey: 'Night',
        titleKey: 'Night Sky',
        themeColor: '#07090f',
        swatch: 'linear-gradient(135deg, #25488e 0%, #0b1020 58%, #86b2b1 100%)',
    },
    {
        id: '1',
        labelKey: 'Mist',
        titleKey: 'Morning Mist',
        themeColor: '#e8ecf3',
        swatch: 'linear-gradient(135deg, #b8d1f5 0%, #f6f8fc 58%, #2a7a7b 100%)',
    },
    {
        id: '2',
        labelKey: 'Ink',
        titleKey: 'Obsidian Ink',
        themeColor: '#0f1219',
        swatch: 'linear-gradient(135deg, #27354b 0%, #101319 60%, #68b8b0 100%)',
    },
    {
        id: '3',
        labelKey: 'Paper',
        titleKey: 'Warm Paper',
        themeColor: '#efece5',
        swatch: 'linear-gradient(135deg, #fbfaf7 0%, #e4eae7 58%, #38726a 100%)',
    },
]);

const AUTO_SWATCH = 'linear-gradient(90deg, #161d2e 50%, #eef2f7 50%)';
const VALID_MODES = new Set(['0', '1', '2', '3', 'auto']);

let isInitialized = false;
let isActive = false;
let origThemeColor = null;
let darkQuery = null;
let chatObserver = null;
let onPaletteChangeCallback = null;
let translateCallback = null;

/**
 * 解析配色模式为实际生效的配色编号（auto 模式按系统深浅色映射到 0 夜空 / 1 晨雾）。
 * @param {string|null|undefined} mode 用户选择的模式（'0'|'1'|'2'|'3'|'auto'）
 * @param {boolean} prefersDark 系统是否处于深色模式
 * @returns {'0'|'1'|'2'|'3'} 实际生效的配色编号
 */
export function resolveLensPaletteId(mode, prefersDark) {
    if (mode === 'auto') {
        return prefersDark ? '0' : '1';
    }
    return VALID_MODES.has(mode) ? /** @type {'0'|'1'|'2'|'3'} */ (mode) : '0';
}

/**
 * 读取已持久化的配色模式，非法值回退为默认 '0'（夜空）。
 * @param {Storage|null} [storage] 可选存储对象，默认使用 localStorage
 * @returns {string} 合法的模式值
 */
export function getSavedLensPaletteMode(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    try {
        const v = storage?.getItem(LENS_PALETTE_STORAGE_KEY);
        return VALID_MODES.has(v) ? v : '0';
    } catch {
        return '0';
    }
}

/**
 * 持久化用户选择的配色模式。
 * @param {string} mode 模式值
 * @param {Storage|null} [storage] 可选存储对象
 */
export function saveLensPaletteMode(mode, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    if (!VALID_MODES.has(mode)) return;
    try {
        storage?.setItem(LENS_PALETTE_STORAGE_KEY, mode);
    } catch {
        // 忽略隐私模式或配额限制导致的写入失败
    }
}

/**
 * 检测当前生效主题是否带有透镜标识变量 `--lt-theme: 1`。
 * @returns {boolean} 是否为透镜主题
 */
export function isLensThemeActive() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
        return false;
    }
    return getComputedStyle(document.documentElement).getPropertyValue('--lt-theme').trim() === '1';
}

function getSystemPrefersDark() {
    if (!darkQuery && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
    return Boolean(darkQuery?.matches);
}

function syncMetaThemeColor(color) {
    if (typeof document === 'undefined') return;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
    }
    if (origThemeColor === null) {
        origThemeColor = meta.getAttribute('content') || '#333';
    }
    meta.setAttribute('content', color);
}

function restoreMetaThemeColor() {
    if (typeof document === 'undefined' || origThemeColor === null) return;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute('content', origThemeColor);
    }
}

/**
 * 温和同步聊天区内显式声明了自适应变量的同源 iframe 卡片文字色。
 */
function notifyAdaptiveIframes() {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return;
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyColor = rootStyle.getPropertyValue('--SmartThemeBodyColor').trim();
    const quoteColor = rootStyle.getPropertyValue('--SmartThemeQuoteColor').trim();
    const isDark = (rootStyle.colorScheme || '').includes('dark');

    document.querySelectorAll('#chat iframe').forEach((frame) => {
        try {
            const win = frame.contentWindow;
            const doc = frame.contentDocument;
            if (!win || !doc || !doc.documentElement) return;
            const ir = doc.documentElement;
            const cs = win.getComputedStyle(ir);
            const usesStText = cs.getPropertyValue('--st-text').trim() !== '';
            const usesFg = cs.getPropertyValue('--fg').trim() !== '';
            if (usesStText && bodyColor) {
                ir.style.setProperty('--SmartThemeTextColor', bodyColor);
                ir.style.setProperty('--SmartThemeBodyColor', bodyColor);
            }
            if (usesFg && bodyColor) {
                ir.style.setProperty('--fg', bodyColor);
                if (quoteColor) ir.style.setProperty('--accent', quoteColor);
                ir.classList.toggle('dark', isDark);
            }
            if (usesStText || usesFg) {
                win.dispatchEvent(new Event('resize'));
            }
        } catch {
            // 忽略跨域或尚未加载完成的 iframe
        }
    });
}

function updateStripSelection(mode) {
    if (typeof document === 'undefined') return;
    const strip = document.getElementById(LENS_PALETTE_STRIP_ID);
    if (!strip) return;
    strip.querySelectorAll('.lt-pop-item').forEach((el) => {
        const active = el.dataset.mode === mode;
        el.classList.toggle('is-active', active);
        el.setAttribute('aria-checked', active ? 'true' : 'false');
    });
}

/**
 * 将指定配色模式应用到文档根节点，并联动系统栏与自适应卡片。
 * @param {string} mode 模式值（'0'|'1'|'2'|'3'|'auto'）
 * @param {object} [options] 附加选项
 * @param {boolean} [options.notify=false] 是否触发系统栏与自适应卡片同步回调
 */
export function applyLensPalette(mode, { notify = false } = {}) {
    if (typeof document === 'undefined') return;
    const resolved = resolveLensPaletteId(mode, getSystemPrefersDark());
    const root = document.documentElement;

    if (resolved === '0') {
        delete root.dataset.ltPalette;
    } else {
        root.dataset.ltPalette = resolved;
    }

    const chat = document.getElementById('chat');
    if (chat && chat.style.getPropertyValue('--lt-palette')) {
        chat.style.removeProperty('--lt-palette');
    }

    const item = LENS_PALETTES.find((p) => p.id === resolved) || LENS_PALETTES[0];
    syncMetaThemeColor(item.themeColor);
    updateStripSelection(mode);

    if (notify) {
        if (typeof onPaletteChangeCallback === 'function') {
            try {
                onPaletteChangeCallback(resolved, mode);
            } catch {
                // 不阻塞配色切换
            }
        }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => notifyAdaptiveIframes());
        }
    }
}

/**
 * 翻译工具：优先使用注入的官方 i18n translate，回退 globalThis.__i18n.translate 或英文原文。
 * @param {string} key 词条键
 * @returns {string} 翻译后的文案
 */
function translateLabel(key) {
    try {
        const fn = translateCallback || globalThis.__i18n?.translate;
        if (typeof fn === 'function') {
            return fn(key) || key;
        }
    } catch {
        // 回退英文原文
    }
    return key;
}

function ensureStrip() {
    if (typeof document === 'undefined') return null;
    let strip = document.getElementById(LENS_PALETTE_STRIP_ID);
    if (strip) return strip;

    const options = document.getElementById('options');
    if (!options) return null;

    strip = document.createElement('div');
    strip.id = LENS_PALETTE_STRIP_ID;
    strip.setAttribute('role', 'radiogroup');
    strip.setAttribute('aria-label', translateLabel('Lens palette'));
    strip.setAttribute('data-i18n', '[aria-label]Lens palette');
    strip.addEventListener('click', (e) => e.stopPropagation());

    const makeItem = (mode, labelKey, titleKey, swatch) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lt-pop-item';
        btn.dataset.mode = mode;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.setAttribute('title', translateLabel(titleKey));
        btn.setAttribute('data-i18n', `[title]${titleKey}`);

        const dot = document.createElement('span');
        dot.className = 'lt-pop-swatch';
        dot.style.background = swatch;

        const label = document.createElement('span');
        label.setAttribute('data-i18n', labelKey);
        label.textContent = translateLabel(labelKey);

        btn.append(dot, label);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            saveLensPaletteMode(mode);
            applyLensPalette(mode, { notify: true });
        });
        return btn;
    };

    LENS_PALETTES.forEach((p) => {
        strip.appendChild(makeItem(p.id, p.labelKey, p.titleKey, p.swatch));
    });
    strip.appendChild(makeItem('auto', 'Auto', 'Follow System', AUTO_SWATCH));

    options.prepend(strip);
    return strip;
}

function attachChatGuard() {
    if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    if (chatObserver) chatObserver.disconnect();
    chatObserver = new MutationObserver(() => {
        if (isActive && chat.style.getPropertyValue('--lt-palette')) {
            chat.style.removeProperty('--lt-palette');
        }
    });
    chatObserver.observe(chat, { attributes: true, attributeFilter: ['style'] });
}

/**
 * 根据当前主题的 `--lt-theme` 状态同步配色条显示、隐藏与状态清理。
 * 由 `applyCustomCSS()` 在每次加载或切换主题时调用。
 * @returns {boolean} 当前是否处于透镜主题激活态
 */
export function syncLensPaletteState() {
    if (typeof document === 'undefined') return false;
    const nowLens = isLensThemeActive();
    const root = document.documentElement;

    if (nowLens) {
        ensureStrip();
        attachChatGuard();
        root.classList.add('lt-theme-active');
        applyLensPalette(getSavedLensPaletteMode(), { notify: !isActive });
        isActive = true;
    } else if (isActive || root.classList.contains('lt-theme-active') || root.dataset.ltPalette !== undefined) {
        if (chatObserver) {
            chatObserver.disconnect();
            chatObserver = null;
        }
        root.classList.remove('lt-theme-active');
        delete root.dataset.ltPalette;
        restoreMetaThemeColor();
        isActive = false;
    }

    return isActive;
}

/**
 * 初始化透镜配色切换模块，注册系统深浅色变更监听与回调。
 * @param {object} [options] 初始化选项
 * @param {(resolvedId: string, mode: string) => void} [options.onPaletteChange] 配色变更后的回调（用于同步移动端系统栏）
 * @param {(text: string) => string} [options.translate] i18n 翻译函数
 */
export function initLensPalette({ onPaletteChange, translate } = {}) {
    if (typeof onPaletteChange === 'function') {
        onPaletteChangeCallback = onPaletteChange;
    }
    if (typeof translate === 'function') {
        translateCallback = translate;
    }
    if (!isInitialized && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const onSchemeChange = () => {
            if (isActive && getSavedLensPaletteMode() === 'auto') {
                applyLensPalette('auto', { notify: true });
            }
        };
        if (typeof darkQuery.addEventListener === 'function') {
            darkQuery.addEventListener('change', onSchemeChange);
        }
        isInitialized = true;
    }
    syncLensPaletteState();
}

/**
 * 重置内部状态（仅用于单元测试隔离）。
 */
export function __resetLensPaletteForTests() {
    if (chatObserver) {
        chatObserver.disconnect();
        chatObserver = null;
    }
    isInitialized = false;
    isActive = false;
    origThemeColor = null;
    darkQuery = null;
    onPaletteChangeCallback = null;
    translateCallback = null;
}
