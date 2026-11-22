/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createWorkbenchRegistry } from '../../public/scripts/workbench/registry.js';
import { mountWorkbench } from '../../public/scripts/workbench/app.js';
import { segmented } from '../../public/scripts/lens-shared/ui.js';

function makeStubSource() {
    return {
        readSettings: () => ({ pill: true }),
        writeSettings: () => {},
        loadSnapshot: async () => ({ budget: { total: 1200 }, chat: { label: 'Demo Chat' } }),
        subscribe: () => () => {},
        runRules: () => [],
    };
}

function makeStubPages() {
    const page = (id) => () => {
        const el = document.createElement('div');
        el.dataset.page = id;
        return { el };
    };
    return {
        home: page('home'),
        ask: page('ask'),
        ai: page('ai'),
        hist: page('hist'),
        settings: page('settings'),
    };
}

describe('shared segmented() dirty dot', () => {
    test('renders .lw-dirty-dot and data-dirty="true" only for dirty options', () => {
        const seg = segmented([
            { value: 'a', label: 'A', dirty: false },
            { value: 'b', label: 'B', dirty: true },
        ], 'a', () => {});
        const btns = seg.querySelectorAll('.lw-seg-btn');
        expect(btns[0].dataset.dirty).toBeUndefined();
        expect(btns[0].querySelector('.lw-dirty-dot')).toBeNull();
        expect(btns[1].dataset.dirty).toBe('true');
        expect(btns[1].querySelector('.lw-dirty-dot')).not.toBeNull();
    });
});

describe('Workbench shell unsaved-changes visibility', () => {
    let wb = null;

    beforeEach(() => {
        document.body.innerHTML = '';
        globalThis.Luker = {
            getContext: () => ({
                translate: (s) => s,
                getCurrentLocale: () => 'en',
                accountStorage: null,
            }),
        };
    });

    afterEach(() => {
        wb?.close?.();
        wb = null;
    });

    test('highlights rail tab, corner pill, and shows warn toast on leave/collapse until cleared', async () => {
        const registry = createWorkbenchRegistry();
        let dirty = 0;
        let wsHostApp = null;
        registry.registerWorkspace({
            id: 'memory',
            title: 'Memory graph',
            icon: 'memory',
            order: 10,
            mount(container, { app }) {
                wsHostApp = app;
                const el = document.createElement('div');
                el.textContent = 'memory-body';
                container.appendChild(el);
                return {
                    unsavedCount: () => dirty,
                    destroy() { el.remove(); },
                };
            },
        });

        const host = document.createElement('div');
        document.body.appendChild(host);
        wb = mountWorkbench({
            source: makeStubSource(),
            registry,
            pages: makeStubPages(),
            container: host,
        });

        wb.open({ ws: 'memory' });
        await new Promise(r => setTimeout(r, 0));

        const tabOf = (label) => [...host.querySelectorAll('.wb-tab')].find(t => t.textContent.includes(label));
        expect(tabOf('Memory graph').classList.contains('is-dirty')).toBe(false);
        expect(host.querySelector('.wb-pill').classList.contains('has-unsaved')).toBe(false);

        // Become dirty with 2 unsaved edits
        dirty = 2;
        wsHostApp.refreshBadges();

        const memTab = tabOf('Memory graph');
        expect(memTab.classList.contains('is-dirty')).toBe(true);
        const dirtyBadge = memTab.querySelector('.wb-tab-dirty');
        expect(dirtyBadge).not.toBeNull();
        expect(dirtyBadge.textContent).toBe('2');

        const pill = host.querySelector('.wb-pill');
        expect(pill.classList.contains('has-unsaved')).toBe(true);
        expect(pill.querySelector('.wb-pill-unsaved')).not.toBeNull();

        // Switching away from dirty workspace shows amber warn toast with action to jump back
        tabOf('Overview').click();
        const toast = host.querySelector('.wb-toast');
        expect(toast.hidden).toBe(false);
        expect(toast.classList.contains('is-warn')).toBe(true);
        const backBtn = toast.querySelector('.wb-toast-btn');
        expect(backBtn).not.toBeNull();
        backBtn.click();
        expect(tabOf('Memory graph').getAttribute('aria-selected')).toBe('true');

        // Collapsing while dirty shows amber warn toast with reopen action
        wb.collapse();
        expect(wb.isCollapsed()).toBe(true);
        expect(toast.hidden).toBe(false);
        expect(toast.classList.contains('is-warn')).toBe(true);
        toast.querySelector('.wb-toast-btn').click();
        expect(wb.isCollapsed()).toBe(false);
        expect(tabOf('Memory graph').getAttribute('aria-selected')).toBe('true');

        // Clearing dirty state clears tab, pill, and suppresses warn toast on switch
        dirty = 0;
        wsHostApp.refreshBadges();
        expect(tabOf('Memory graph').classList.contains('is-dirty')).toBe(false);
        expect(tabOf('Memory graph').querySelector('.wb-tab-dirty')).toBeNull();
        expect(pill.classList.contains('has-unsaved')).toBe(false);
        toast.hidden = true;
        tabOf('Overview').click();
        expect(toast.hidden).toBe(true);
    });
});
