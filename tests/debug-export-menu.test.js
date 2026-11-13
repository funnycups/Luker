/**
 * @jest-environment jsdom
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

describe('diagnostics menu viewport positioning', () => {
    beforeEach(() => {
        jest.resetModules();
        document.body.innerHTML = `
            <div id="debug-menu" class="debug-menu">
                <div id="debug-export-btn">Diagnostics</div>
                <div id="debug-menu-list" class="debug-menu-list" hidden>
                    <div class="debug-menu-item" data-debug-action="export-bundle">Export Debug Logs</div>
                </div>
            </div>`;
        jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: () => ({}),
        }));
        jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
            t: (strings) => strings[0],
        }));
        jest.unstable_mockModule('../public/scripts/frontend-log-manager.js', () => ({
            getFrontendLogsSnapshot: () => ({ entries: [], latestId: 0 }),
        }));
    });

    function mockRect(el, rect) {
        el.getBoundingClientRect = () => ({
            top: 0,
            bottom: 40,
            height: 40,
            ...rect,
            width: rect.width ?? (rect.right - rect.left),
        });
    }

    test('left-aligns when dropdown fits within right viewport margin', async () => {
        const { positionDebugMenu } = await import('../public/scripts/debug-export.js');
        const button = document.getElementById('debug-export-btn');
        const list = document.getElementById('debug-menu-list');
        list.hidden = false;
        list.classList.add('debug-menu-list--align-right');
        list.style.left = '-40px';
        mockRect(button, { left: 16, right: 96 });
        mockRect(list, { left: 16, right: 236, width: 220 });

        positionDebugMenu(button, list, 390);

        expect(list.classList.contains('debug-menu-list--align-right')).toBe(false);
        expect(list.style.left).toBe('');
    });

    test('switches to right-alignment when left-aligned dropdown overflows right edge', async () => {
        const { positionDebugMenu } = await import('../public/scripts/debug-export.js');
        const button = document.getElementById('debug-export-btn');
        const list = document.getElementById('debug-menu-list');
        list.hidden = false;
        mockRect(button, { left: 290, right: 374 });
        mockRect(list, { left: 290, right: 510, width: 220 });

        positionDebugMenu(button, list, 390);

        expect(list.classList.contains('debug-menu-list--align-right')).toBe(true);
        expect(list.style.left).toBe('');
    });

    test('clamps left offset when right-alignment would overflow left viewport margin', async () => {
        const { positionDebugMenu } = await import('../public/scripts/debug-export.js');
        const button = document.getElementById('debug-export-btn');
        const list = document.getElementById('debug-menu-list');
        list.hidden = false;
        mockRect(button, { left: 140, right: 200 });
        mockRect(list, { left: 140, right: 380, width: 240 });

        positionDebugMenu(button, list, 260);

        expect(list.classList.contains('debug-menu-list--align-right')).toBe(false);
        expect(list.style.left).toBe('-128px');

        mockRect(list, { left: 140, right: 388, width: 248 });
        positionDebugMenu(button, list, 260);

        expect(list.style.left).toBe('-132px');
    });

    test('repositions when opening the menu via click and on window resize', async () => {
        const { initDebugExportButton } = await import('../public/scripts/debug-export.js');
        const button = document.getElementById('debug-export-btn');
        const list = document.getElementById('debug-menu-list');
        Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
        mockRect(button, { left: 290, right: 374 });
        mockRect(list, { left: 290, right: 510, width: 220 });

        initDebugExportButton();
        button.click();

        expect(list.hidden).toBe(false);
        expect(list.classList.contains('debug-menu-list--align-right')).toBe(true);

        mockRect(button, { left: 16, right: 96 });
        mockRect(list, { left: 16, right: 236, width: 220 });
        window.dispatchEvent(new Event('resize'));

        expect(list.classList.contains('debug-menu-list--align-right')).toBe(false);
    });
});
