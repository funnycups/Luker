/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { fitToViewport } from '../../public/scripts/workbench/viewport.js';
import { createWindow } from '../../public/scripts/workbench/ui/window.js';
import { createAskPage } from '../../public/scripts/workbench/pages/ask.js';
import { createHomePage } from '../../public/scripts/workbench/pages/home.js';
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

        win.destroy();
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

    test('Run Dock compact fitToViewport zeroes width and height before measuring getBoundingClientRect origin', async () => {
        const origMatchMedia = globalThis.matchMedia;
        globalThis.matchMedia = (q) => ({
            matches: q === '(max-width: 860px)',
            addEventListener: () => {},
            removeEventListener: () => {},
        });
        Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
        Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true });

        const recorder = createRecorder({ storage: createMemoryStorage(), owner: () => 'u1' });
        const dock = createDock({ recorder, host: document.body });
        try {
            const root = document.body.querySelector('.rpdock');
            root.style.width = '375px';
            root.style.height = '900px';
            const observed = [];
            const origGetBCR = root.getBoundingClientRect.bind(root);
            root.getBoundingClientRect = () => {
                observed.push({ width: root.style.width, height: root.style.height });
                return { ...origGetBCR(), left: 0, top: 0, width: 0, height: 0 };
            };
            dock.open();
            await new Promise(resolve => requestAnimationFrame(resolve));
            expect(observed.length).toBeGreaterThanOrEqual(1);
            expect(observed[0]).toEqual({ width: '0px', height: '0px' });
        } finally {
            dock.destroy();
            recorder.detach();
            globalThis.matchMedia = origMatchMedia;
        }
    });
});
