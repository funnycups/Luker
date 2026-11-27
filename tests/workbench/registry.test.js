/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';

import {
    createWorkbenchRegistry,
    registerWorkspace,
    registerIterateTarget,
    registerAskProvider,
    registerSuggestRuleProvider,
    open as openWorkbench,
    setOpenHandler,
    getWorkspaces,
    getIterateTargets,
    getAskProviders,
    getSuggestRuleProviders,
    subscribe as subscribeRegistry,
} from '../../public/scripts/workbench/registry.js';
import { mountWorkbench } from '../../public/scripts/workbench/app.js';
import { initWorkbench, resetWorkbenchForTest } from '../../public/scripts/workbench/index.js';
import { registerWorkbenchLocaleData } from '../../public/scripts/workbench/locale-data.js';
import { segmented } from '../../public/scripts/lens-shared/ui.js';

function createMockLukerContext({
    extensionNames = [],
    disabledExtensions = [],
    extensionSettings = {},
    locale = 'en',
} = {}) {
    const listeners = new Map();
    const localeTables = {};
    const eventSource = {
        on: (ev, fn) => {
            if (!listeners.has(ev)) listeners.set(ev, new Set());
            listeners.get(ev).add(fn);
        },
        off: (ev, fn) => listeners.get(ev)?.delete(fn),
        emit: async (ev, ...args) => {
            for (const fn of [...(listeners.get(ev) || [])]) {
                await fn(...args);
            }
        },
    };
    return {
        eventSource,
        eventTypes: { APP_READY: 'APP_READY', CHAT_CHANGED: 'CHAT_CHANGED' },
        extensionSettings: {
            disabledExtensions,
            ...extensionSettings,
        },
        listExtensionNames: () => [...extensionNames],
        addLocaleData: (loc, data) => {
            localeTables[loc] = { ...(localeTables[loc] || {}), ...data };
        },
        translate: (text) => localeTables[locale]?.[text] ?? text,
        getCurrentLocale: () => locale,
        accountStorage: null,
        saveSettings: async (_, opts) => opts?.onSaved?.(),
    };
}

beforeAll(() => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
        });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
    globalThis.toastr = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), success: jest.fn() };
});

beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    globalThis.localStorage.clear();
    jest.restoreAllMocks();
});

afterEach(() => {
    resetWorkbenchForTest();
});

describe('workbench registry (order-independent)', () => {
    test('registers workspaces/targets before and after mount and updates live rail & status on deregister/disable', async () => {
        const reg = createWorkbenchRegistry();
        let memEnabled = true;
        const mountedMemoryOpts = [];
        const shownMemoryOpts = [];
        const aiShowOpts = [];

        // Register BEFORE mount
        const unregMem = reg.registerWorkspace({
            id: 'memory',
            title: 'Memory Lens',
            icon: 'memory',
            order: 10,
            tone: 'memory',
            isEnabled: () => memEnabled,
            mount: (host, { opts }) => {
                mountedMemoryOpts.push(opts);
                const el = document.createElement('div');
                el.className = 'test-mem-ws';
                el.textContent = 'Memory workspace mounted';
                host.appendChild(el);
                return {
                    show: (showOpts) => shownMemoryOpts.push(showOpts),
                    destroy: () => el.remove(),
                };
            },
        });
        const unregTargetBefore = reg.registerIterateTarget({ id: 'memory', label: 'Memory graph', order: 1 });

        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['memory']);
        expect(reg.getIterateTargets().map(t => t.id)).toEqual(['memory']);

        const wb = mountWorkbench({
            registry: reg,
            startCollapsed: false,
            pages: {
                ai: () => {
                    const el = document.createElement('div');
                    el.className = 'test-ai-page';
                    return { el, show: (opts) => aiShowOpts.push(opts) };
                },
            },
        });

        // Initial connected fitToViewport measurement runs via win.refresh() right after mount
        await new Promise(r => globalThis.requestAnimationFrame(r));
        const layer = document.querySelector('.wbench');
        expect(layer.style.getPropertyValue('--wb-vh')).toBe(`${Math.round(window.innerHeight) / 100}px`);
        expect(layer.style.width).toBe(`${Math.round(window.innerWidth)}px`);

        // Rail renders built-in tabs + pre-mounted workspace
        const tabLabels = () => [...document.querySelectorAll('.wb-rail .wb-tab')].map(el => el.textContent);
        expect(tabLabels()).toContain('Memory Lens');

        // Register AFTER mount: rail and registry listeners update immediately
        let registryNotifications = 0;
        const unsub = reg.subscribe(() => { registryNotifications += 1; });
        const unregOrch = reg.registerWorkspace({
            id: 'orch',
            title: 'Orchestra Lens',
            icon: 'orch',
            order: 5,
            tone: 'orch',
            mount: () => {},
        });
        const unregAsk = reg.registerAskProvider({ id: 'chat-reader', label: 'Chat' });
        const unregSuggest = reg.registerSuggestRuleProvider({ id: 'mem-rules', rules: [] });

        expect(registryNotifications).toBeGreaterThanOrEqual(3);
        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['orch', 'memory']);
        expect(tabLabels()).toContain('Orchestra Lens');
        expect(reg.getAskProviders().map(p => p.id)).toEqual(['chat-reader']);
        expect(reg.getSuggestRuleProviders().map(p => p.id)).toEqual(['mem-rules']);

        // Idempotent replace by id does not duplicate and stale unregister is a no-op
        const unregOrchNew = reg.registerWorkspace({
            id: 'orch',
            title: 'Orchestra V2',
            icon: 'orch',
            order: 5,
            tone: 'orch',
            mount: () => {},
        });
        expect(reg.getWorkspaces().filter(w => w.id === 'orch')).toHaveLength(1);
        expect(tabLabels()).toContain('Orchestra V2');
        unregOrch(); // stale unregister must not remove the replacement
        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['orch', 'memory']);

        // Open the memory workspace and verify mount + show received navigation opts
        wb.open({ ws: 'memory', subview: 'nodes', focusId: 'n42' });
        expect(document.querySelector('.test-mem-ws')).not.toBeNull();
        expect(mountedMemoryOpts).toEqual([{ ws: 'memory', subview: 'nodes', focusId: 'n42' }]);
        expect(shownMemoryOpts).toEqual([{ ws: 'memory', subview: 'nodes', focusId: 'n42' }]);

        // Re-registering an already-mounted workspace unmounts stale view and remounts new mount()
        let v2Destroyed = false;
        const unregMemV2 = reg.registerWorkspace({
            id: 'memory',
            title: 'Memory V2',
            icon: 'memory',
            order: 10,
            tone: 'memory',
            isEnabled: () => memEnabled,
            mount: (host) => {
                const el = document.createElement('div');
                el.className = 'test-mem-ws-v2';
                host.appendChild(el);
                return () => { v2Destroyed = true; el.remove(); };
            },
        });
        expect(document.querySelector('.test-mem-ws')).toBeNull();
        expect(document.querySelector('.test-mem-ws-v2')).not.toBeNull();

        // Open core page with target options -> pageFactories.ai.show receives exact opts
        wb.open({ page: 'ai', ws: 'memory', scope: 'character' });
        expect(aiShowOpts).toEqual([{ page: 'ai', ws: 'memory', scope: 'character' }]);

        // Switch back to memory v2, then disable via isEnabled + notify -> tears down active workspace
        wb.open({ ws: 'memory' });
        memEnabled = false;
        reg.notify();
        expect(v2Destroyed).toBe(true);
        expect(tabLabels()).not.toContain('Memory V2');
        expect(document.querySelector('.test-mem-ws-v2')).toBeNull();

        // Deregistration cleans up live state
        unregOrchNew();
        unregMem();
        unregMemV2();
        unregTargetBefore();
        unregAsk();
        unregSuggest();
        unsub();

        expect(reg.getWorkspaces()).toEqual([]);
        expect(reg.getIterateTargets()).toEqual([]);
        expect(reg.getAskProviders()).toEqual([]);
        expect(reg.getSuggestRuleProviders()).toEqual([]);
        expect(tabLabels()).not.toContain('Orchestra V2');

        wb.close();
    });

    test('open({ page, ws, scope, subview, focusId }) queues before handler and forwards when wired', async () => {
        const reg = createWorkbenchRegistry();
        const received = [];

        // Called before handler exists -> queued
        const pendingPromise = reg.open({ page: 'ai', ws: 'memory', scope: 'character', subview: 'types', focusId: 'event' });
        expect(received).toEqual([]);

        reg.setOpenHandler(async (opts) => {
            received.push(opts);
            return opts;
        });

        await pendingPromise;
        expect(received).toEqual([
            { page: 'ai', ws: 'memory', scope: 'character', subview: 'types', focusId: 'event' },
        ]);

        // Subsequent call dispatches immediately
        await reg.open({ page: 'home', ws: 'preset' });
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual({ page: 'home', ws: 'preset' });
    });

    test('preserves property getters across register and get so dynamic labels stay live', () => {
        const reg = createWorkbenchRegistry();
        let lang = 'en';
        const dict = {
            en: { title: 'Memory graph', label: 'Memory graph', ask: 'Memory search' },
            zh: { title: '记忆图', label: '记忆图', ask: '记忆检索' },
        };

        const u1 = reg.registerWorkspace({
            id: 'memory',
            get title() { return dict[lang].title; },
            icon: 'memory',
            mount: () => {},
        });
        const u2 = reg.registerIterateTarget({
            id: 'memory',
            get label() { return dict[lang].label; },
        });
        const u3 = reg.registerAskProvider({
            id: 'memory-ask',
            get label() { return dict[lang].ask; },
        });

        const wsBefore = reg.getWorkspaces()[0];
        const targetBefore = reg.getIterateTargets()[0];
        const askBefore = reg.getAskProviders()[0];
        expect(wsBefore.title).toBe('Memory graph');
        expect(targetBefore.label).toBe('Memory graph');
        expect(askBefore.label).toBe('Memory search');

        lang = 'zh';
        expect(wsBefore.title).toBe('记忆图');
        expect(targetBefore.label).toBe('记忆图');
        expect(askBefore.label).toBe('记忆检索');
        expect(reg.getWorkspaces()[0].title).toBe('记忆图');
        expect(reg.getIterateTargets()[0].label).toBe('记忆图');
        expect(reg.getAskProviders()[0].label).toBe('记忆检索');

        u1(); u2(); u3();
    });

    test('singleton exports match registry contract', () => {
        const u1 = registerWorkspace({ id: 'singleton-test', title: 'S', icon: 'home', mount: () => {} });
        const u2 = registerIterateTarget({ id: 't1' });
        const u3 = registerAskProvider({ id: 'a1' });
        const u4 = registerSuggestRuleProvider({ id: 's1' });
        const u5 = subscribeRegistry(() => {});
        expect(getWorkspaces().some(w => w.id === 'singleton-test')).toBe(true);
        expect(getIterateTargets().some(t => t.id === 't1')).toBe(true);
        expect(getAskProviders().some(p => p.id === 'a1')).toBe(true);
        expect(getSuggestRuleProviders().some(r => r.id === 's1')).toBe(true);
        expect(typeof openWorkbench).toBe('function');
        expect(typeof setOpenHandler).toBe('function');
        u1(); u2(); u3(); u4(); u5();
    });
});

describe('workbench index bootstrap', () => {
    test('initWorkbench mounts corner pill on APP_READY, adds wand item, and supports Alt+W', async () => {
        const menu = document.createElement('div');
        menu.id = 'extensionsMenu';
        document.body.appendChild(menu);

        const ctx = createMockLukerContext({
            extensionSettings: { workbench: { pill: true, hotkey: 'alt+w' } },
        });
        globalThis.Luker = { getContext: () => ctx };
        initWorkbench();

        // Wand menu item added
        const wandItem = document.getElementById('luker_workbench_wand_item');
        expect(wandItem).not.toBeNull();
        expect(wandItem.textContent).toContain('Workbench');

        // APP_READY mounts collapsed pill and injects stylesheets idempotently
        await ctx.eventSource.emit('APP_READY');
        expect(document.querySelector('.wbench .wb-pill')).not.toBeNull();
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(true);
        expect(document.querySelectorAll('link[href*="lens-shared/tokens.css"]')).toHaveLength(1);
        expect(document.querySelectorAll('link[href*="workbench/style.css"]')).toHaveLength(1);

        // Alt+W opens and toggles
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 20));
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(false);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true }));
        await new Promise(r => setTimeout(r, 20));
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(true);

        // openWorkbench({ page: 'ai', ws: 'memory', scope: 'character' }) opens core AI page without mounting memory workspace
        let memoryMountedOpts = [];
        const unreg = registerWorkspace({
            id: 'memory',
            title: 'Memory',
            icon: 'memory',
            mount: (_host, { opts }) => { memoryMountedOpts.push(opts); },
        });
        await openWorkbench({ page: 'ai', ws: 'memory', scope: 'character' });
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(false);
        expect(document.querySelector('.wb-tab[aria-selected="true"]').textContent).toContain('AI iteration');
        expect(memoryMountedOpts).toEqual([]);

        // openWorkbench({ ws: 'memory', subview: 'nodes', focusId: 'n1' }) mounts the workspace directly with opts
        await openWorkbench({ ws: 'memory', subview: 'nodes', focusId: 'n1' });
        expect(document.querySelector('.wb-tab[aria-selected="true"]').textContent).toContain('Memory');
        expect(memoryMountedOpts).toEqual([{ ws: 'memory', subview: 'nodes', focusId: 'n1' }]);

        // openWorkbench() with no args when already expanded focuses the workbench window
        const outsideBtn = document.createElement('button');
        document.body.appendChild(outsideBtn);
        outsideBtn.focus();
        expect(document.activeElement).toBe(outsideBtn);
        await openWorkbench();
        expect(document.activeElement).toBe(document.querySelector('.wbench .wb-win'));
        outsideBtn.remove();
        unreg();
    });
});

describe('workbench boundary and locale-data contracts', () => {
    test('public/scripts/workbench/ has zero imports from extensions/, extensions.js, or script.js, and zero innerHTML', () => {
        const rootDir = fileURLToPath(new URL('../../public/scripts/workbench/', import.meta.url));
        const collectJs = (dir) => {
            const out = [];
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = `${dir}/${entry.name}`;
                if (entry.isDirectory()) out.push(...collectJs(full));
                else if (entry.name.endsWith('.js')) out.push(full);
            }
            return out;
        };
        const files = collectJs(rootDir);
        expect(files.length).toBeGreaterThan(5);
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
            expect(code).not.toMatch(/from\s+['"][^'"]*extensions(?:\/|\.js['"])/);
            expect(code).not.toMatch(/import\s*\(\s*['"][^'"]*extensions(?:\/|\.js['"])/);
            expect(code).not.toMatch(/from\s+['"][^'"]*script\.js['"]/);
            expect(code).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
        }
    });

    test('locale-data has matching ZH_CN/ZH_TW keys, no unescaped semicolons, full-width CJK punctuation, and zero overlap with core locale JSONs', () => {
        const captured = {};
        registerWorkbenchLocaleData((locale, data) => {
            captured[locale] = data;
        });

        expect(Object.keys(captured)).toEqual(['zh-cn', 'zh-tw']);
        const cnKeys = Object.keys(captured['zh-cn']).sort();
        const twKeys = Object.keys(captured['zh-tw']).sort();
        expect(cnKeys).toEqual(twKeys);

        for (const key of cnKeys) {
            expect(key.replace(/\\;/g, '')).not.toContain(';');
        }

        const zhCnCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-cn.json', import.meta.url)), 'utf8'));
        const zhTwCore = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/locales/zh-tw.json', import.meta.url)), 'utf8'));
        for (const key of cnKeys) {
            expect(Object.hasOwn(zhCnCore, key)).toBe(false);
            expect(Object.hasOwn(zhTwCore, key)).toBe(false);
        }

        for (const loc of ['zh-cn', 'zh-tw']) {
            for (const val of Object.values(captured[loc])) {
                expect(val).not.toMatch(/[\u4e00-\u9fff][,;:!?()]|[,;:!?()][\u4e00-\u9fff]/);
            }
        }
    });

    test('shell.css lifts host #toast-container above open Workbench windows across all pages, not only memory-graph settings', () => {
        const shellCss = readFileSync(fileURLToPath(new URL('../../public/scripts/workbench/css/shell.css', import.meta.url)), 'utf8');
        const mgSettingsCss = readFileSync(fileURLToPath(new URL('../../public/scripts/extensions/memory-graph/lens/css/settings.css', import.meta.url)), 'utf8');
        expect(shellCss).toMatch(/body:has\(\.wbench\s+\.wb-win:not\(\[hidden\]\)\)\s+#toast-container\s*\{\s*z-index:\s*2147483000\s*;/);
        expect(mgSettingsCss).not.toContain('#toast-container');
    });

    test('tokens.css cascades light-theme tokens from [data-theme="light"] host to embedded .mlens and .olens', () => {
        const tokensCss = readFileSync(fileURLToPath(new URL('../../public/scripts/lens-shared/tokens.css', import.meta.url)), 'utf8');
        expect(tokensCss).toContain('[data-theme="light"] :is(.lw-surface, .mlens, .olens, .rpdock):not([data-theme="dark"])');
    });

    test('segmented with iconOnlyMobile sets aria-label and title fallback on each button', () => {
        const seg = segmented([
            { value: 'studio', label: '图像工作台', iconName: 'image' },
            { value: 'run', label: '运行详情', iconName: 'play', title: '自定义标题' },
        ], 'studio', () => {}, { iconOnlyMobile: true });
        const buttons = [...seg.querySelectorAll('.lw-seg-btn')];
        expect(buttons[0].getAttribute('aria-label')).toBe('图像工作台');
        expect(buttons[0].getAttribute('title')).toBe('图像工作台');
        expect(buttons[1].getAttribute('aria-label')).toBe('运行详情');
        expect(buttons[1].getAttribute('title')).toBe('自定义标题');
    });
});
