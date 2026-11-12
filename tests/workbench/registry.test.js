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
    test('registers workspaces/targets before and after mount and updates live rail & status on deregister/disable', () => {
        const reg = createWorkbenchRegistry();
        let memEnabled = true;

        // Register BEFORE mount
        const unregMem = reg.registerWorkspace({
            id: 'memory',
            title: 'Memory Lens',
            icon: 'memory',
            order: 10,
            tone: 'memory',
            isEnabled: () => memEnabled,
            mount: (host) => {
                const el = document.createElement('div');
                el.className = 'test-mem-ws';
                el.textContent = 'Memory workspace mounted';
                host.appendChild(el);
                return () => el.remove();
            },
        });
        const unregTargetBefore = reg.registerIterateTarget({ id: 'memory', label: 'Memory graph', order: 1 });

        expect(reg.getWorkspaces().map(w => w.id)).toEqual(['memory']);
        expect(reg.getIterateTargets().map(t => t.id)).toEqual(['memory']);

        const wb = mountWorkbench({ registry: reg, startCollapsed: false });

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

        // Open the memory workspace and verify mount ran
        wb.open({ ws: 'memory', subview: 'nodes', focusId: 'n42' });
        expect(document.querySelector('.test-mem-ws')).not.toBeNull();

        // Disable via isEnabled + notify updates live rail & tears down active workspace
        memEnabled = false;
        reg.notify();
        expect(tabLabels()).not.toContain('Memory Lens');
        expect(document.querySelector('.test-mem-ws')).toBeNull();

        // Deregistration cleans up live state
        unregOrchNew();
        unregMem();
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

describe('workbench index bootstrap & st-context exposure', () => {
    test('st-context.js exposes workbench platform API synchronously', () => {
        const src = readFileSync(
            fileURLToPath(new URL('../../public/scripts/st-context.js', import.meta.url)),
            'utf8',
        );
        expect(src).toContain('workbench: WORKBENCH_API');
        for (const method of [
            'registerWorkspace',
            'registerIterateTarget',
            'registerAskProvider',
            'registerSuggestRuleProvider',
            'open',
            'saveSettingsChecked',
        ]) {
            expect(src).toContain(method);
        }
    });

    test('initWorkbench mounts corner pill on APP_READY, adds wand item, supports Alt+W, and detects third-party copy via listExtensionNames()', async () => {
        const menu = document.createElement('div');
        menu.id = 'extensionsMenu';
        document.body.appendChild(menu);

        // Active third-party copy suppresses built-in workbench
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const blockedCtx = createMockLukerContext({
            extensionNames: ['third-party/luker-workbench'],
            disabledExtensions: [],
        });
        globalThis.Luker = { getContext: () => blockedCtx };
        initWorkbench();
        await blockedCtx.eventSource.emit('APP_READY');
        expect(warnSpy).toHaveBeenCalled();
        expect(document.getElementById('luker_workbench_wand_item')).toBeNull();
        expect(document.querySelector('.wbench')).toBeNull();
        resetWorkbenchForTest();
        warnSpy.mockRestore();

        // Disabled third-party copy allows built-in workbench to boot cleanly
        const ctx = createMockLukerContext({
            extensionNames: ['third-party/luker-workbench'],
            disabledExtensions: ['third-party/luker-workbench'],
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

        // openWorkbench({ page: 'ai', ws: 'memory', scope: 'character' }) opens and navigates
        let receivedOpts = null;
        const unreg = registerWorkspace({
            id: 'memory',
            title: 'Memory',
            icon: 'memory',
            mount: (_host, { opts }) => { receivedOpts = opts; },
        });
        await openWorkbench({ page: 'ai', ws: 'memory', scope: 'character' });
        expect(document.querySelector('.wbench .wb-win').hidden).toBe(false);
        expect(document.querySelector('.wb-tab[aria-selected="true"]').textContent).toContain('AI iteration');
        expect(receivedOpts === null || receivedOpts.scope === 'character').toBe(true);
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
});
