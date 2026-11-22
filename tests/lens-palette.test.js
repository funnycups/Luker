import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
    LENS_PALETTES,
    LENS_PALETTE_STORAGE_KEY,
    LENS_PALETTE_STRIP_ID,
    __resetLensPaletteForTests,
    applyLensPalette,
    getSavedLensPaletteMode,
    initLensPalette,
    resolveLensPaletteId,
    saveLensPaletteMode,
    syncLensPaletteState,
} from '../public/scripts/lens-palette.js';

/** 构造最小可用的浏览器 DOM 替身，覆盖 classList、dataset、style、querySelector 与事件机制 */
function createMockBrowserEnv({ lensActive = true, prefersDark = true } = {}) {
    const store = new Map();
    const attrs = new WeakMap();
    const listeners = new WeakMap();

    const makeEl = (tag, id = '') => {
        const classes = new Set();
        const styleMap = new Map();
        const el = {
            tagName: tag.toUpperCase(),
            id,
            textContent: '',
            children: [],
            dataset: {},
            className: '',
            classList: {
                add: (...ns) => ns.forEach((n) => classes.add(n)),
                remove: (...ns) => ns.forEach((n) => classes.delete(n)),
                contains: (n) => classes.has(n),
                toggle: (n, force) => {
                    const next = force === undefined ? !classes.has(n) : Boolean(force);
                    if (next) classes.add(n); else classes.delete(n);
                    return next;
                },
            },
            style: {
                background: '',
                setProperty: (k, v) => styleMap.set(k, String(v)),
                getPropertyValue: (k) => styleMap.get(k) || '',
                removeProperty: (k) => styleMap.delete(k),
            },
            setAttribute: (k, v) => {
                if (!attrs.has(el)) attrs.set(el, new Map());
                attrs.get(el).set(k, String(v));
                if (k === 'id') el.id = String(v);
            },
            getAttribute: (k) => attrs.get(el)?.get(k) ?? null,
            append: (...nodes) => el.children.push(...nodes),
            appendChild: (node) => { el.children.push(node); return node; },
            prepend: (node) => { el.children.unshift(node); },
            addEventListener: (type, fn) => {
                if (!listeners.has(el)) listeners.set(el, new Map());
                const map = listeners.get(el);
                if (!map.has(type)) map.set(type, []);
                map.get(type).push(fn);
            },
            click: () => {
                const fns = listeners.get(el)?.get('click') || [];
                fns.forEach((fn) => fn({ stopPropagation: () => {} }));
            },
            querySelectorAll: (sel) => {
                const out = [];
                const walk = (node) => {
                    for (const child of node.children) {
                        if (sel === '.lt-pop-item' && child.className === 'lt-pop-item') out.push(child);
                        walk(child);
                    }
                };
                walk(el);
                return out;
            },
        };
        return el;
    };

    const root = makeEl('html');
    const head = makeEl('head');
    const meta = makeEl('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#333');
    head.appendChild(meta);

    const options = makeEl('div', 'options');
    const chat = makeEl('div', 'chat');

    const state = { lensActive, prefersDark };
    const mqListeners = [];

    const doc = {
        documentElement: root,
        head,
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => {
            if (id === 'options') return options;
            if (id === 'chat') return chat;
            if (id === LENS_PALETTE_STRIP_ID) {
                return options.children.find((c) => c.id === LENS_PALETTE_STRIP_ID) || null;
            }
            return null;
        },
        querySelector: (sel) => {
            if (sel === 'meta[name="theme-color"]') {
                return head.children.find((c) => c.getAttribute('name') === 'theme-color') || null;
            }
            return null;
        },
        querySelectorAll: () => [],
    };

    const win = {
        matchMedia: () => ({
            get matches() { return state.prefersDark; },
            addEventListener: (_type, fn) => mqListeners.push(fn),
        }),
    };

    const storage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        clear: () => store.clear(),
    };

    const getComputedStyleStub = () => ({
        colorScheme: root.dataset.ltPalette === '1' || root.dataset.ltPalette === '3' ? 'light' : 'dark',
        getPropertyValue: (prop) => (prop === '--lt-theme' ? (state.lensActive ? '1' : '') : ''),
    });

    return {
        state,
        root,
        meta,
        options,
        chat,
        storage,
        triggerSystemSchemeChange: (dark) => {
            state.prefersDark = dark;
            mqListeners.forEach((fn) => fn());
        },
        install: () => {
            globalThis.document = doc;
            globalThis.window = win;
            globalThis.localStorage = storage;
            globalThis.getComputedStyle = getComputedStyleStub;
        },
        uninstall: () => {
            delete globalThis.document;
            delete globalThis.window;
            delete globalThis.localStorage;
            delete globalThis.getComputedStyle;
        },
    };
}

describe('Lens built-in theme & palette module', () => {
    let env;

    beforeEach(() => {
        __resetLensPaletteForTests();
        env = createMockBrowserEnv({ lensActive: true, prefersDark: true });
        env.install();
    });

    afterEach(() => {
        __resetLensPaletteForTests();
        env.uninstall();
    });

    test('default content registers Lens.json with 4 palettes and performance guards', () => {
        const indexPath = path.resolve(process.cwd(), 'default/content/index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        expect(index).toContainEqual({ filename: 'themes/Lens.json', type: 'theme' });

        const themePath = path.resolve(process.cwd(), 'default/content/themes/Lens.json');
        const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
        expect(theme.name).toBe('Lens');
        expect(theme.custom_css).toContain('--lt-theme: 1;');
        expect(theme.custom_css).toContain('-webkit-text-size-adjust: 100%;');
        expect(theme.custom_css).toContain('contain: layout style;');
        expect(theme.custom_css).toContain(':root[data-lt-palette="1"]');
        expect(theme.custom_css).toContain(':root[data-lt-palette="2"]');
        expect(theme.custom_css).toContain(':root[data-lt-palette="3"]');
        expect(theme.custom_css).not.toContain('saturate(170%)');
    });

    test('resolveLensPaletteId handles explicit modes, auto mode, and invalid fallback', () => {
        expect(resolveLensPaletteId('0', false)).toBe('0');
        expect(resolveLensPaletteId('1', true)).toBe('1');
        expect(resolveLensPaletteId('2', false)).toBe('2');
        expect(resolveLensPaletteId('3', true)).toBe('3');
        expect(resolveLensPaletteId('auto', true)).toBe('0');
        expect(resolveLensPaletteId('auto', false)).toBe('1');
        expect(resolveLensPaletteId('invalid', false)).toBe('0');
        expect(resolveLensPaletteId(null, true)).toBe('0');
    });

    test('storage helper persists valid modes and rejects invalid modes', () => {
        expect(getSavedLensPaletteMode(env.storage)).toBe('0');
        saveLensPaletteMode('2', env.storage);
        expect(getSavedLensPaletteMode(env.storage)).toBe('2');
        saveLensPaletteMode('bad', env.storage);
        expect(getSavedLensPaletteMode(env.storage)).toBe('2');
    });

    test('mounts 5-swatch strip at top of #options only when Lens theme is active and cleans up on switch away', () => {
        env.state.lensActive = false;
        expect(syncLensPaletteState()).toBe(false);
        expect(env.root.classList.contains('lt-theme-active')).toBe(false);
        expect(env.options.children).toHaveLength(0);

        // 切入透镜主题
        env.state.lensActive = true;
        expect(syncLensPaletteState()).toBe(true);
        expect(env.root.classList.contains('lt-theme-active')).toBe(true);
        const strip = env.options.children[0];
        expect(strip.id).toBe(LENS_PALETTE_STRIP_ID);
        const buttons = strip.querySelectorAll('.lt-pop-item');
        expect(buttons).toHaveLength(LENS_PALETTES.length + 1);

        // 点击「晨雾」切换浅色并触发回调
        const callbackCalls = [];
        initLensPalette({
            onPaletteChange: (resolved, mode) => callbackCalls.push([resolved, mode]),
        });
        buttons[1].click();
        expect(env.storage.getItem(LENS_PALETTE_STORAGE_KEY)).toBe('1');
        expect(env.root.dataset.ltPalette).toBe('1');
        expect(env.meta.getAttribute('content')).toBe('#e8ecf3');
        expect(callbackCalls).toEqual([['1', '1']]);

        // 切离透镜主题：自动移除标记与 data-lt-palette 并恢复原 theme-color
        env.state.lensActive = false;
        expect(syncLensPaletteState()).toBe(false);
        expect(env.root.classList.contains('lt-theme-active')).toBe(false);
        expect(env.root.dataset.ltPalette).toBeUndefined();
        expect(env.meta.getAttribute('content')).toBe('#333');
    });

    test('auto mode tracks prefers-color-scheme changes and clears legacy #chat inline var', () => {
        env.chat.style.setProperty('--lt-palette', '2');
        initLensPalette();
        saveLensPaletteMode('auto', env.storage);
        applyLensPalette('auto');
        expect(env.chat.style.getPropertyValue('--lt-palette')).toBe('');
        // 初始系统深色 -> 0 夜空
        expect(env.root.dataset.ltPalette).toBeUndefined();
        expect(env.meta.getAttribute('content')).toBe('#07090f');

        // 系统切浅色 -> 自动变 1 晨雾
        env.triggerSystemSchemeChange(false);
        expect(env.root.dataset.ltPalette).toBe('1');
        expect(env.meta.getAttribute('content')).toBe('#e8ecf3');
    });
});
