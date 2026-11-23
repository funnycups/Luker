/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { fitToViewport } from '../../public/scripts/workbench/viewport.js';
import { createWindow } from '../../public/scripts/workbench/ui/window.js';
import { createAskPage } from '../../public/scripts/workbench/pages/ask.js';
import { createHomePage } from '../../public/scripts/workbench/pages/home.js';
import { createIteratePage } from '../../public/scripts/workbench/pages/iterate.js';
import { confirmDialog } from '../../public/scripts/lens-shared/ui.js';
import { createDock } from '../../public/scripts/run-panel/dock.js';
import { createRecorder, createMemoryStorage } from '../../public/scripts/run-panel/recorder.js';

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
});

describe('workbench mobile viewport & preventScroll focus', () => {
    test('fitToViewport zeroes root width and height before measuring getBoundingClientRect origin', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);
        root.style.width = '400px';
        root.style.height = '900px';

        const observedDuringMeasure = [];
        const origGetBCR = root.getBoundingClientRect.bind(root);
        root.getBoundingClientRect = () => {
            observedDuringMeasure.push({
                width: root.style.width,
                height: root.style.height,
            });
            // Simulate a root document that stays scrolled by -30px only when root itself still overflows.
            const stillTall = parseInt(root.style.height || '0', 10) > 800;
            return {
                ...origGetBCR(),
                left: 0,
                top: stillTall ? -30 : 0,
                width: 0,
                height: 0,
            };
        };

        Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });

        const handle = fitToViewport(root);
        expect(observedDuringMeasure.length).toBeGreaterThanOrEqual(1);
        expect(observedDuringMeasure[0]).toEqual({ width: '0px', height: '0px' });
        expect(root.style.top).toBe('0px');
        expect(root.style.width).toBe('400px');
        expect(root.style.height).toBe('800px');
        handle.destroy();
    });

    test('createWindow.expand and focus pass preventScroll: true so sheet animation does not scroll documentElement', () => {
        Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });

        const win = createWindow({
            title: 'Workbench',
            theme: () => 'light',
            onThemeToggle: () => {},
            startCollapsed: true,
        });
        document.body.appendChild(win.layer);

        const focusSpy = jest.spyOn(win.win, 'focus');
        win.expand();
        expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

        focusSpy.mockClear();
        win.focus();
        expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

        // Verify mobile bottom-edge height resize (.wb-resize-y) and touch double-tap on .wb-titlebar
        const bar = win.win.querySelector('.wb-titlebar');
        const bottomGrip = win.win.querySelector('.wb-resize-y');
        expect(bottomGrip).not.toBeNull();
        const startHeight = parseInt(win.win.style.height, 10);

        const firePtr = (el, type, props = {}) => {
            const ev = new Event(type, { bubbles: true, cancelable: true });
            Object.assign(ev, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 180, clientY: 400, ...props });
            el.dispatchEvent(ev);
        };

        firePtr(bottomGrip, 'pointerdown', { clientY: 500 });
        firePtr(bottomGrip, 'pointermove', { clientY: 560 });
        firePtr(bottomGrip, 'pointerup', { clientY: 560 });
        expect(parseInt(win.win.style.height, 10)).toBe(startHeight + 60);

        // Touch double-tap on titlebar toggles maximised on mobile
        expect(win.win.classList.contains('is-max')).toBe(false);
        firePtr(bar, 'pointerdown', { clientX: 150, clientY: 160 });
        firePtr(bar, 'pointerup', { clientX: 151, clientY: 160 });
        firePtr(bar, 'pointerdown', { clientX: 151, clientY: 160 });
        firePtr(bar, 'pointerup', { clientX: 151, clientY: 160 });
        expect(win.win.classList.contains('is-max')).toBe(true);

        // Regression 1: pointerdown on maximised titlebar followed by pointerup outside titlebar
        // cleans up global drag listeners (even if a later move has buttons=1).
        firePtr(bar, 'pointerdown', { pointerType: 'mouse', pointerId: 1, buttons: 1, clientX: 150, clientY: 20 });
        firePtr(document.body, 'pointerup', { pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 150, clientY: 200 });
        win.setMaximised(false);
        const leftBeforeHover = win.win.style.left;
        const topBeforeHover = win.win.style.top;
        firePtr(bar, 'pointermove', { pointerType: 'mouse', pointerId: 1, buttons: 1, clientX: 210, clientY: 240 });
        expect(win.win.style.left).toBe(leftBeforeHover);
        expect(win.win.style.top).toBe(topBeforeHover);

        // Regression 2: if pointerup was missed completely (e.g. released outside browser), a mouse
        // pointermove with buttons=0 aborts the stale gesture without dragging.
        firePtr(bar, 'pointerdown', { pointerType: 'mouse', pointerId: 1, buttons: 1, clientX: 150, clientY: 160 });
        firePtr(bar, 'pointermove', { pointerType: 'mouse', pointerId: 1, buttons: 0, clientX: 210, clientY: 240 });
        expect(win.win.style.left).toBe(leftBeforeHover);
        expect(win.win.style.top).toBe(topBeforeHover);

        win.destroy();
    });

    test('createWindow honors persisted prefs.maximised over defaultSize and preserves manual maximise across collapse/expand', () => {
        Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });

        // 1) No saved prefs.maximised -> falls back to defaultSize ('large')
        let configured = 'large';
        const winDefaultLarge = createWindow({
            title: 'Workbench',
            theme: () => 'dark',
            defaultSize: () => configured,
            onThemeToggle: () => {},
        });
        document.body.appendChild(winDefaultLarge.layer);
        expect(winDefaultLarge.win.classList.contains('is-max')).toBe(true);
        winDefaultLarge.destroy();

        // 2) Saved prefs.maximised: true MUST NOT be discarded when defaultSize returns 'small'
        localStorage.setItem('workbench.prefs.v1', JSON.stringify({ maximised: true }));
        configured = 'small';
        const winSavedMax = createWindow({
            title: 'Workbench',
            theme: () => 'dark',
            defaultSize: () => configured,
            onThemeToggle: () => {},
        });
        document.body.appendChild(winSavedMax.layer);
        expect(winSavedMax.win.classList.contains('is-max')).toBe(true);

        // 3) Folding (collapse) and reopening (expand) preserves manual maximised state
        winSavedMax.collapse();
        expect(winSavedMax.isCollapsed()).toBe(true);
        winSavedMax.expand();
        expect(winSavedMax.win.classList.contains('is-max')).toBe(true);

        // 4) Manual restore persists maximised: false; manual maximise then collapse -> expand keeps true
        winSavedMax.win.querySelector('.wb-ctl-max').click();
        expect(winSavedMax.win.classList.contains('is-max')).toBe(false);
        expect(JSON.parse(localStorage.getItem('workbench.prefs.v1')).maximised).toBe(false);

        winSavedMax.win.querySelector('.wb-ctl-max').click();
        expect(winSavedMax.win.classList.contains('is-max')).toBe(true);
        winSavedMax.collapse();
        winSavedMax.expand();
        expect(winSavedMax.win.classList.contains('is-max')).toBe(true);

        // 5) resetPosition clears persisted maximised and returns to configuredDefault ('small')
        winSavedMax.resetPosition();
        expect(winSavedMax.win.classList.contains('is-max')).toBe(false);
        expect(JSON.parse(localStorage.getItem('workbench.prefs.v1')).maximised).toBeUndefined();

        winSavedMax.destroy();
    });

    test('createWindow preserves preferred mobileBox height across transient IME shrinks and updates responsive layout classes', async () => {
        Object.defineProperty(window, 'innerWidth', { value: 412, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 915, configurable: true });
        const layoutEvents = [];
        const flushViewport = () => new Promise(resolve => requestAnimationFrame(() => queueMicrotask(resolve)));

        const win = createWindow({
            title: 'Workbench',
            theme: () => 'dark',
            onThemeToggle: () => {},
            onLayout: (info) => layoutEvents.push(info),
        });
        document.body.appendChild(win.layer);
        try {
            const normalHeight = parseInt(win.win.style.height, 10);
            expect(normalHeight).toBe(520);
            expect(win.layer.classList.contains('is-compact')).toBe(true);
            expect(win.layer.classList.contains('is-short')).toBe(false);

            // Simulate mobile IME opening: viewport shrinks to 360px tall
            Object.defineProperty(window, 'innerHeight', { value: 360, configurable: true });
            win.refresh();
            await flushViewport();
            expect(parseInt(win.win.style.height, 10)).toBe(360);
            expect(win.layer.classList.contains('is-short')).toBe(true);

            // Simulate mobile IME closing: preferred height restores to 520px instead of staying stuck at 360px
            Object.defineProperty(window, 'innerHeight', { value: 915, configurable: true });
            win.refresh();
            await flushViewport();
            expect(parseInt(win.win.style.height, 10)).toBe(normalHeight);
            expect(win.layer.classList.contains('is-short')).toBe(false);

            // Explicit user-resized mobileBox (e.g. 580px) also survives a transient IME shrink cleanly
            const bottomGrip = win.win.querySelector('.wb-resize-y');
            const firePtr = (type, clientY) => {
                const ev = new Event(type, { bubbles: true, cancelable: true });
                Object.assign(ev, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 180, clientY });
                bottomGrip.dispatchEvent(ev);
            };
            firePtr('pointerdown', 500);
            firePtr('pointermove', 560);
            firePtr('pointerup', 560);
            expect(parseInt(win.win.style.height, 10)).toBe(normalHeight + 60);

            Object.defineProperty(window, 'innerHeight', { value: 360, configurable: true });
            win.refresh();
            await flushViewport();
            expect(parseInt(win.win.style.height, 10)).toBe(360);

            Object.defineProperty(window, 'innerHeight', { value: 915, configurable: true });
            win.refresh();
            await flushViewport();
            expect(parseInt(win.win.style.height, 10)).toBe(normalHeight + 60);

            // Mid-width non-compact window (680x380) sets narrow-main, drawer-side, and is-short
            Object.defineProperty(window, 'innerWidth', { value: 680, configurable: true });
            Object.defineProperty(window, 'innerHeight', { value: 380, configurable: true });
            win.refresh();
            await flushViewport();
            expect(win.layer.classList.contains('is-compact')).toBe(false);
            expect(win.layer.classList.contains('is-narrow-main')).toBe(true);
            expect(win.layer.classList.contains('is-drawer-side')).toBe(true);
            expect(win.layer.classList.contains('is-short')).toBe(true);

            // Wide desktop window (1280x800) clears narrow-main, drawer-side, and is-short
            Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
            Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
            win.refresh();
            await flushViewport();
            expect(win.layer.classList.contains('is-narrow-main')).toBe(false);
            expect(win.layer.classList.contains('is-drawer-side')).toBe(false);
            expect(win.layer.classList.contains('is-short')).toBe(false);
            expect(layoutEvents.length).toBeGreaterThanOrEqual(1);
        } finally {
            win.destroy();
        }
    });

    test('Iterate page hides previewPane in compact mode and restores it on layout switch to desktop', async () => {
        let compact = true;
        const target = {
            id: 'memory',
            label: () => 'Memory graph',
            scopes: async () => ({ global: true }),
            load: async () => ({ live: { schema: [{ id: 'event', label: 'Event' }] }, target: { scope: 'global' }, title: 'Global' }),
            renderPreview: () => {
                const div = document.createElement('div');
                div.textContent = 'Schema Preview';
                return div;
            },
            units: () => new Map(),
            rebuild: (_b, a) => a,
        };
        const app = {
            sessions: { list: async () => [], get: async () => null },
            settings: () => ({}),
            saveSettings: jest.fn(),
            snapshot: () => ({}),
            isCompact: () => compact,
            iterateTargets: () => [target],
            toast: jest.fn(),
            reload: jest.fn(),
            refreshBadges: jest.fn(),
            source: {},
        };

        const page = createIteratePage(app);
        document.body.appendChild(page.el);
        await page.show({ ws: 'memory', scope: 'global' });
        await new Promise(r => setTimeout(r, 0));

        const previewPane = page.el.querySelector('.wb-iter-preview');
        expect(previewPane.hidden).toBe(true);

        compact = false;
        page.onLayout?.();
        expect(previewPane.hidden).toBe(false);
        expect(previewPane.textContent).toContain('Schema Preview');

        compact = true;
        page.onLayout?.();
        expect(previewPane.hidden).toBe(true);
    });

    test('Ask page show() focuses composer input with preventScroll: true', async () => {
        const app = {
            settings: () => ({ ask: { sources: {} } }),
            saveSettings: jest.fn(),
            snapshot: () => null,
            suggestions: () => [],
            askProviders: () => [],
            toast: jest.fn(),
            go: jest.fn(),
            source: {},
        };
        const askPage = createAskPage(app);
        document.body.appendChild(askPage.el);
        const input = askPage.el.querySelector('textarea.wb-input');
        const focusSpy = jest.spyOn(input, 'focus');

        await askPage.show();
        await new Promise((r) => requestAnimationFrame(r));

        expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('Home page onSnapshot skips redundant DOM teardown when snapshot and suggestions are unchanged', () => {
        let currentSnap = {
            chat: { chatId: 'c1', label: 'Ash', floors: 4 },
            providers: {},
            budget: { total: 1200, max: 8000, parts: [{ key: 'preset', label: 'Preset', tokens: 1200 }] },
            preset: { name: 'p1', prompts: [{ enabled: true }] },
            card: { name: 'Ash', books: [] },
            world: { character: [], global: [] },
            at: 1000,
        };
        let currentSuggestions = [];
        const app = {
            snapshot: () => currentSnap,
            suggestions: () => currentSuggestions,
            loadError: () => '',
            workspaces: () => [],
            askProviders: () => [],
            settings: () => ({ dismissed: {} }),
            saveSettings: jest.fn(),
            reload: jest.fn(),
            go: jest.fn(),
            open: jest.fn(),
            toast: jest.fn(),
        };

        const home = createHomePage(app);
        document.body.appendChild(home.el);
        home.show();
        const firstCard = home.el.querySelector('.wb-card');
        expect(firstCard).toBeTruthy();

        // Identical snapshot + suggestions (even with a newer `at` timestamp when load() finishes after expand()) keeps live DOM intact.
        currentSnap = { ...currentSnap, at: 1500 };
        home.onSnapshot();
        expect(home.el.querySelector('.wb-card')).toBe(firstCard);

        // Changed snapshot triggers a fresh paint.
        currentSnap = { ...currentSnap, preset: { name: 'p2', prompts: [{ enabled: true }, { enabled: true }] }, at: 2000 };
        home.onSnapshot();
        expect(home.el.querySelector('.wb-card')).not.toBe(firstCard);
        expect(home.el.textContent).toContain('p2');
    });

    test('confirmDialog focuses confirm button and restores prior focus with preventScroll: true', async () => {
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        trigger.focus();
        const returnFocusSpy = jest.spyOn(trigger, 'focus');

        const promise = confirmDialog({
            host: document.body,
            title: 'Delete',
            message: 'Confirm removal?',
        });
        const confirmBtn = document.body.querySelector('.lw-dialog-foot .lw-btn.is-primary');
        const confirmFocusSpy = jest.spyOn(confirmBtn, 'focus');
        await new Promise((r) => requestAnimationFrame(r));
        expect(confirmFocusSpy).toHaveBeenCalledWith({ preventScroll: true });

        returnFocusSpy.mockClear();
        document.body.querySelector('.lw-dialog-foot .lw-btn.is-ghost').click();
        await expect(promise).resolves.toBe(false);
        expect(returnFocusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });

    test('Run Dock .rp-dock and .rp-dock-scrim are tested distinctly on narrow mobile viewports (<= 640px) with visualViewport offsets', async () => {
        const origMatchMedia = globalThis.matchMedia;
        const origVV = globalThis.visualViewport;
        globalThis.matchMedia = (q) => ({
            matches: q === '(max-width: 640px)',
            addEventListener: () => {},
            removeEventListener: () => {},
        });
        Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true });

        const vvListeners = new Map();
        const mockVV = {
            width: 375,
            height: 812,
            offsetLeft: 0,
            offsetTop: 0,
            addEventListener: (ev, fn) => {
                if (!vvListeners.has(ev)) vvListeners.set(ev, new Set());
                vvListeners.get(ev).add(fn);
            },
            removeEventListener: (ev, fn) => vvListeners.get(ev)?.delete(fn),
        };
        Object.defineProperty(globalThis, 'visualViewport', { value: mockVV, configurable: true });

        const recorder = createRecorder({ storage: createMemoryStorage(), owner: () => 'u1' });
        const dock = createDock({ recorder, container: document.body });
        try {
            const dockEl = document.body.querySelector('.rp-dock');
            const scrimEl = document.body.querySelector('.rp-dock-scrim');
            expect(dockEl).not.toBeNull();
            expect(scrimEl).not.toBeNull();
            expect(dockEl).not.toBe(scrimEl);
            expect(dockEl.querySelector('.rp-dock-foot')).toBeNull();
            expect(dockEl.querySelector('.rp-dock-grip')).toBeNull();

            // 1) Test .rp-dock itself on compact mobile small mode + keyboard visualViewport shrink
            // Default mobile bottom (150px) sits cleanly above Workbench's default mobile pill (bottom: 96px, height: 42px => 138px).
            dock.open();
            expect(dockEl.classList.contains('is-compact')).toBe(true);
            expect(dockEl.dataset.size).toBe('small');
            expect(dockEl.style.bottom).toBe('150px');

            mockVV.height = 512; // 300px mobile keyboard opens
            for (const fn of vvListeners.get('resize') || []) fn();
            expect(dockEl.style.bottom).toBe('450px');
            expect(parseInt(dockEl.style.bottom, 10) - 300 + parseInt(dockEl.style.maxHeight, 10)).toBeLessThanOrEqual(512);

            // Dragging upward to the extreme top edge must stay within the 12px top margin (no negative top overflow)
            mockVV.height = 420;
            for (const fn of vvListeners.get('resize') || []) fn();
            const headEl = dockEl.querySelector('.rp-dock-head');
            const fireHead = (type, clientY) => {
                const ev = new Event(type, { bubbles: true, cancelable: true });
                Object.assign(ev, { pointerId: 2, pointerType: 'touch', button: 0, clientX: 180, clientY });
                headEl.dispatchEvent(ev);
            };
            fireHead('pointerdown', 350);
            fireHead('pointermove', -350); // +700px upward drag hits clampMobilePos ceiling
            fireHead('pointerup', -350);
            const vvBottomAfter = 812 - 420;
            const visibleBottom = parseInt(dockEl.style.bottom, 10) - vvBottomAfter;
            const maxH = parseInt(dockEl.style.maxHeight, 10);
            expect(visibleBottom).toBe(420 - 152);
            expect(visibleBottom + maxH).toBeLessThanOrEqual(420 - 12);

            // 2) Test .rp-dock-scrim fitToViewport origin measurement in large mode
            mockVV.height = 812;
            scrimEl.style.width = '375px';
            scrimEl.style.height = '900px';
            const observedScrim = [];
            const origGetBCR = scrimEl.getBoundingClientRect.bind(scrimEl);
            scrimEl.getBoundingClientRect = () => {
                observedScrim.push({ width: scrimEl.style.width, height: scrimEl.style.height });
                return { ...origGetBCR(), left: 0, top: 0, width: 0, height: 0 };
            };
            dock.setSize('large');
            await new Promise(resolve => requestAnimationFrame(resolve));
            expect(scrimEl.hidden).toBe(false);
            expect(observedScrim.length).toBeGreaterThanOrEqual(1);
            expect(observedScrim[0]).toEqual({ width: '0px', height: '0px' });
            expect(dockEl.style.left).toBe('12px');
        } finally {
            dock.destroy();
            recorder.detach();
            globalThis.matchMedia = origMatchMedia;
            Object.defineProperty(globalThis, 'visualViewport', { value: origVV, configurable: true });
        }
    });
});
