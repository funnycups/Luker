/** LocalStorage key storing per-theme palette mode preferences as a JSON object. */
export const THEME_PALETTES_STORAGE_KEY = 'luker_theme_palettes';

/** DOM ID of the palette switcher strip mounted at the top of the #options menu. */
export const THEME_PALETTE_STRIP_ID = 'theme-palette-strip';

/** Class applied to documentElement while a theme with declarative palettes is active. */
export const THEME_PALETTES_ACTIVE_CLASS = 'theme-palettes-active';

const DEFAULT_AUTO_SWATCH = 'linear-gradient(90deg, #161d2e 50%, #eef2f7 50%)';
const PALETTE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNSAFE_CSS_VALUE_PATTERN = /[;{}@\\]|url\s*\(|expression\s*\(|javascript:/i;

/**
 * @typedef {object} ThemePaletteItem
 * @property {string} id Unique identifier written to `html[data-theme-palette]`.
 * @property {string} label Short display label (passed through i18n if translated).
 * @property {string} title Descriptive tooltip text (passed through i18n if translated).
 * @property {string} [theme_color] Optional CSS color used for browser chrome and native system bars.
 * @property {string} [swatch] Optional CSS color or gradient rendered in the circular swatch preview.
 */

/**
 * @typedef {object} ThemePaletteAutoConfig
 * @property {string} dark Palette ID selected when prefers-color-scheme is dark.
 * @property {string} light Palette ID selected when prefers-color-scheme is light.
 * @property {string} swatch CSS color or gradient rendered for the Auto swatch button.
 */

/**
 * @typedef {object} ThemePalettesConfig
 * @property {string} default Default palette ID.
 * @property {ThemePaletteItem[]} items Declared palette entries (at least 2).
 * @property {ThemePaletteAutoConfig} [auto] Optional system color-scheme mapping.
 */

let isInitialized = false;
let activeThemeName = '';
/** @type {ThemePalettesConfig|null} */
let activeConfig = null;
/** @type {ThemePaletteItem|null} */
let activePalette = null;
/** @type {string|null} */
let activeMode = null;
let darkQuery = null;
let schemeChangeListener = null;
let onPaletteChangeCallback = null;
let translateCallback = null;

function isSafeCssValue(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || UNSAFE_CSS_VALUE_PATTERN.test(trimmed)) {
        return false;
    }
    let depth = 0;
    for (const ch of trimmed) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

function escapeI18nKey(key) {
    return String(key).replace(/;/g, '\\;');
}

/**
 * Validates and normalizes a declarative theme `palettes` definition.
 * Returns null if the input does not define at least 2 valid palettes.
 * @param {unknown} raw Raw `palettes` field from a theme JSON object.
 * @returns {ThemePalettesConfig|null} Normalized config or null.
 */
export function normalizeThemePalettes(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const rawObj = /** @type {Record<string, unknown>} */ (raw);
    if (!Array.isArray(rawObj.items)) {
        return null;
    }

    /** @type {ThemePaletteItem[]} */
    const items = [];
    const seenIds = new Set();

    for (const entry of rawObj.items) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const item = /** @type {Record<string, unknown>} */ (entry);
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const label = typeof item.label === 'string' ? item.label.trim() : '';
        if (!id || !PALETTE_ID_PATTERN.test(id) || seenIds.has(id) || !label) {
            continue;
        }
        seenIds.add(id);

        const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : label;
        /** @type {ThemePaletteItem} */
        const normalized = { id, label, title };

        if (isSafeCssValue(item.theme_color)) {
            normalized.theme_color = /** @type {string} */ (item.theme_color).trim();
        }
        if (isSafeCssValue(item.swatch)) {
            normalized.swatch = /** @type {string} */ (item.swatch).trim();
        }
        items.push(normalized);
    }

    if (items.length < 2) {
        return null;
    }

    const requestedDefault = typeof rawObj.default === 'string' ? rawObj.default.trim() : '';
    const defaultId = seenIds.has(requestedDefault) ? requestedDefault : items[0].id;

    /** @type {ThemePalettesConfig} */
    const config = {
        default: defaultId,
        items,
    };

    if (rawObj.auto && typeof rawObj.auto === 'object' && !Array.isArray(rawObj.auto)) {
        const autoObj = /** @type {Record<string, unknown>} */ (rawObj.auto);
        const dark = typeof autoObj.dark === 'string' ? autoObj.dark.trim() : '';
        const light = typeof autoObj.light === 'string' ? autoObj.light.trim() : '';
        if (seenIds.has(dark) && seenIds.has(light)) {
            config.auto = {
                dark,
                light,
                swatch: isSafeCssValue(autoObj.swatch)
                    ? /** @type {string} */ (autoObj.swatch).trim()
                    : DEFAULT_AUTO_SWATCH,
            };
        }
    }

    return config;
}

function isValidModeForConfig(config, mode) {
    if (!config || typeof mode !== 'string') return false;
    if (mode === 'auto') return Boolean(config.auto);
    return config.items.some((item) => item.id === mode);
}

/**
 * Resolves a palette mode into a concrete palette ID for the given config.
 * @param {ThemePalettesConfig|null} config Normalized palette config.
 * @param {string|null|undefined} mode Selected mode (palette ID or 'auto').
 * @param {boolean} prefersDark Whether system color-scheme is dark.
 * @returns {string|null} Resolved palette ID, or null if config is absent.
 */
export function resolveThemePaletteId(config, mode, prefersDark) {
    if (!config) return null;
    if (mode === 'auto' && config.auto) {
        return prefersDark ? config.auto.dark : config.auto.light;
    }
    if (typeof mode === 'string' && config.items.some((item) => item.id === mode)) {
        return mode;
    }
    return config.default;
}

function getDefaultStorage() {
    return typeof localStorage !== 'undefined' ? localStorage : null;
}

function readPreferenceMap(storage) {
    if (!storage) return {};
    try {
        const raw = storage.getItem(THEME_PALETTES_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        console.warn('Failed to read saved theme palette preferences', error);
        return {};
    }
}

/**
 * Reads the persisted palette mode for a theme, falling back to `config.default`.
 * @param {string} themeName Theme name used as the per-theme preference key.
 * @param {ThemePalettesConfig|null} config Normalized palette config.
 * @param {Storage|null} [storage] Optional Storage instance.
 * @returns {string|null} Valid mode for `config`, or null if `config` is absent.
 */
export function getSavedThemePaletteMode(themeName, config, storage = getDefaultStorage()) {
    if (!config) return null;
    if (!themeName) return config.default;
    const map = readPreferenceMap(storage);
    const saved = map[themeName];
    return isValidModeForConfig(config, saved) ? saved : config.default;
}

/**
 * Persists a valid palette mode for the given theme.
 * @param {string} themeName Theme name.
 * @param {string} mode Palette ID or 'auto'.
 * @param {ThemePalettesConfig|null} config Normalized palette config.
 * @param {Storage|null} [storage] Optional Storage instance.
 */
export function saveThemePaletteMode(themeName, mode, config, storage = getDefaultStorage()) {
    if (!themeName || !isValidModeForConfig(config, mode) || !storage) return;
    const map = readPreferenceMap(storage);
    map[themeName] = mode;
    try {
        storage.setItem(THEME_PALETTES_STORAGE_KEY, JSON.stringify(map));
    } catch (error) {
        console.warn('Failed to save theme palette preference', error);
    }
}

/**
 * Returns the currently active palette item, or null when no palette theme is active.
 * @returns {ThemePaletteItem|null}
 */
export function getActiveThemePalette() {
    return activePalette;
}

/**
 * Returns the active palette's declared `theme_color`, or null if unavailable.
 * @returns {string|null}
 */
export function getActiveThemePaletteColor() {
    return activePalette?.theme_color || null;
}

/**
 * Returns whether a theme with declarative palettes is currently active.
 * @returns {boolean}
 */
export function isThemePalettesActive() {
    return Boolean(activeConfig);
}

function getSystemPrefersDark() {
    if (!darkQuery && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    }
    return Boolean(darkQuery?.matches);
}

function translateLabel(key) {
    const fn = translateCallback || globalThis.__i18n?.translate;
    if (typeof fn === 'function') {
        return fn(key) || key;
    }
    return key;
}

/**
 * Syncs same-origin adaptive card iframes that opt in via `--st-text` or `--fg`.
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
        } catch (error) {
            // Cross-origin or sandboxed iframes reject DOM access with SecurityError.
            if (error?.name === 'SecurityError') return;
            throw error;
        }
    });
}

function updateStripSelection(mode) {
    if (typeof document === 'undefined') return;
    const strip = document.getElementById(THEME_PALETTE_STRIP_ID);
    if (!strip) return;
    const items = Array.from(strip.querySelectorAll('.theme-palette-item'));
    let matched = false;
    for (const el of items) {
        const isSelected = el.dataset.mode === mode;
        if (isSelected) matched = true;
        el.classList.toggle('is-active', isSelected);
        el.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        el.setAttribute('tabindex', isSelected ? '0' : '-1');
    }
    if (!matched && items.length > 0) {
        items[0].setAttribute('tabindex', '0');
    }
}

function selectModeFromUser(mode) {
    if (!activeConfig) return;
    saveThemePaletteMode(activeThemeName, mode, activeConfig);
    applyThemePalette(mode, { notify: true });
}

function handleStripKeyDown(event) {
    const strip = event.currentTarget;
    const items = Array.from(strip.querySelectorAll('.theme-palette-item'));
    if (items.length === 0) return;

    const currentIndex = items.indexOf(event.target.closest?.('.theme-palette-item'));
    if (currentIndex === -1) return;

    let nextIndex = -1;
    switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
            nextIndex = (currentIndex + 1) % items.length;
            break;
        case 'ArrowLeft':
        case 'ArrowUp':
            nextIndex = (currentIndex - 1 + items.length) % items.length;
            break;
        case 'Home':
            nextIndex = 0;
            break;
        case 'End':
            nextIndex = items.length - 1;
            break;
        default:
            return;
    }

    event.preventDefault();
    const target = items[nextIndex];
    const mode = target.dataset.mode;
    if (mode) {
        selectModeFromUser(mode);
        target.focus();
    }
}

function ensureStripContainer() {
    if (typeof document === 'undefined') return null;
    let strip = document.getElementById(THEME_PALETTE_STRIP_ID);
    if (strip) return strip;

    const options = document.getElementById('options');
    if (!options) return null;

    strip = document.createElement('div');
    strip.id = THEME_PALETTE_STRIP_ID;
    strip.setAttribute('role', 'radiogroup');
    strip.setAttribute('aria-label', translateLabel('Theme palette'));
    strip.setAttribute('data-i18n', '[aria-label]Theme palette');
    strip.addEventListener('click', (e) => e.stopPropagation());
    strip.addEventListener('keydown', handleStripKeyDown);

    options.prepend(strip);
    return strip;
}

function renderStrip(config) {
    const strip = ensureStripContainer();
    if (!strip) return null;

    strip.replaceChildren();

    const makeItem = (mode, labelKey, titleKey, swatch) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-palette-item';
        btn.dataset.mode = mode;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.setAttribute('tabindex', '-1');
        btn.setAttribute('title', translateLabel(titleKey));
        btn.setAttribute('data-i18n', `[title]${escapeI18nKey(titleKey)}`);

        const dot = document.createElement('span');
        dot.className = 'theme-palette-swatch';
        dot.setAttribute('aria-hidden', 'true');
        if (swatch) {
            dot.style.background = swatch;
        }

        const label = document.createElement('span');
        label.setAttribute('data-i18n', escapeI18nKey(labelKey));
        label.textContent = translateLabel(labelKey);

        btn.append(dot, label);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectModeFromUser(mode);
        });
        return btn;
    };

    const totalCount = config.items.length + (config.auto ? 1 : 0);
    strip.style.setProperty('--theme-palette-columns', String(totalCount));

    for (const item of config.items) {
        strip.appendChild(makeItem(item.id, item.label, item.title, item.swatch || item.theme_color || ''));
    }
    if (config.auto) {
        strip.appendChild(makeItem('auto', 'Auto', 'Follow System', config.auto.swatch));
    }

    return strip;
}

/**
 * Applies a palette mode for the currently active palette-enabled theme.
 * @param {string} mode Palette ID or 'auto'.
 * @param {object} [options]
 * @param {boolean} [options.notify=false] Whether to invoke onPaletteChange and sync adaptive iframes.
 * @returns {ThemePaletteItem|null} The resolved active palette item, or null if inactive.
 */
export function applyThemePalette(mode, { notify = false } = {}) {
    if (typeof document === 'undefined' || !activeConfig) return null;

    const effectiveMode = isValidModeForConfig(activeConfig, mode) ? mode : activeConfig.default;
    const resolvedId = resolveThemePaletteId(activeConfig, effectiveMode, getSystemPrefersDark());
    const item = activeConfig.items.find((p) => p.id === resolvedId) || activeConfig.items[0];

    activeMode = effectiveMode;
    activePalette = item;
    document.documentElement.dataset.themePalette = item.id;
    updateStripSelection(effectiveMode);

    if (notify) {
        if (typeof onPaletteChangeCallback === 'function') {
            onPaletteChangeCallback(item, effectiveMode);
        }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => notifyAdaptiveIframes());
        }
    }

    return item;
}

/**
 * Synchronizes the palette switcher UI and document attributes with the active theme's
 * declarative `palettes` definition. Deactivates and cleans up when the theme declares none.
 * @param {string} themeName Name of the active theme.
 * @param {unknown} rawPalettes Optional `palettes` field from the active theme.
 * @returns {boolean} True if declarative palettes are active for this theme.
 */
export function syncThemePalettes(themeName, rawPalettes) {
    if (typeof document === 'undefined') return false;

    const nextConfig = normalizeThemePalettes(rawPalettes);
    const wasActive = Boolean(activeConfig);
    const root = document.documentElement;

    if (nextConfig) {
        activeThemeName = String(themeName || '');
        activeConfig = nextConfig;
        renderStrip(nextConfig);
        root.classList.add(THEME_PALETTES_ACTIVE_CLASS);
        const savedMode = getSavedThemePaletteMode(activeThemeName, nextConfig);
        applyThemePalette(savedMode, { notify: true });
        return true;
    }

    activeThemeName = '';
    activeConfig = null;
    activePalette = null;
    activeMode = null;
    root.classList.remove(THEME_PALETTES_ACTIVE_CLASS);
    delete root.dataset.themePalette;

    const strip = document.getElementById(THEME_PALETTE_STRIP_ID);
    if (strip) {
        strip.replaceChildren();
    }

    if (wasActive && typeof onPaletteChangeCallback === 'function') {
        onPaletteChangeCallback(null, null);
    }

    return false;
}

/**
 * Initializes the theme palette controller and listens for system color-scheme changes.
 * @param {object} [options]
 * @param {(palette: ThemePaletteItem|null, mode: string|null) => void} [options.onPaletteChange]
 * @param {(text: string) => string} [options.translate]
 */
export function initThemePalettes({ onPaletteChange, translate } = {}) {
    if (typeof onPaletteChange === 'function') {
        onPaletteChangeCallback = onPaletteChange;
    }
    if (typeof translate === 'function') {
        translateCallback = translate;
    }
    if (!isInitialized && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
        schemeChangeListener = () => {
            if (activeConfig?.auto && activeMode === 'auto') {
                applyThemePalette('auto', { notify: true });
            }
        };
        if (typeof darkQuery.addEventListener === 'function') {
            darkQuery.addEventListener('change', schemeChangeListener);
        }
        isInitialized = true;
    }
}

/**
 * Resets internal module state for unit test isolation.
 */
export function __resetThemePalettesForTests() {
    if (darkQuery && schemeChangeListener && typeof darkQuery.removeEventListener === 'function') {
        darkQuery.removeEventListener('change', schemeChangeListener);
    }
    isInitialized = false;
    activeThemeName = '';
    activeConfig = null;
    activePalette = null;
    activeMode = null;
    darkQuery = null;
    schemeChangeListener = null;
    onPaletteChangeCallback = null;
    translateCallback = null;
}
