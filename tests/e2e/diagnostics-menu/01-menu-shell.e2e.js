// tests/e2e/diagnostics-menu/01-menu-shell.e2e.js
//
// The User Settings debug export button is a dropdown menu rather than a
// single action: opening it reveals the diagnostics entries, clicking
// outside or on the trigger again closes it, and the list renders fully
// inside the viewport rather than being clipped by the settings scroll
// container.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'diagnostics', scenarioId: 'menu-shell' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/** Load the UI and open the User Settings drawer, where the trigger lives. */
async function openSettings(page) {
    await awaitMainUI(page, server.baseURL);
    const drawerToggle = page.locator('#user-settings-button .drawer-toggle');
    if (await page.locator('#user-settings-button .drawer-icon.closedIcon').count()) {
        await drawerToggle.click();
    }
    await expect(page.locator('#debug-export-btn')).toBeVisible();
}

test('the control is live before first-load init finishes', async ({ page }) => {
    // The preloader disappears while first-load init is still running, so a
    // user can reach the button while it is unbound. Read the binding once,
    // right after parsing, rather than polling for it.
    await page.goto(server.baseURL, { waitUntil: 'domcontentloaded' });
    const bound = await page.evaluate(() => document.getElementById('debug-export-btn')?.dataset.debugExportBound === 'true');
    expect(bound).toBe(true);
});

test('the export button opens a diagnostics menu and closes again', async ({ page }) => {
    await openSettings(page);

    await expect(page.locator('#debug-menu-list')).toBeHidden();

    await page.locator('#debug-export-btn').click();
    await expect(page.locator('#debug-menu-list')).toBeVisible();
    await expect(page.locator('[data-debug-action="export-bundle"]')).toBeVisible();

    await page.locator('#debug-export-btn').click();
    await expect(page.locator('#debug-menu-list')).toBeHidden();
});

test('the menu closes when clicking outside', async ({ page }) => {
    await openSettings(page);

    await page.locator('#debug-export-btn').click();
    await expect(page.locator('#debug-menu-list')).toBeVisible();

    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await page.mouse.click(size.width / 2, size.height / 2);

    await expect(page.locator('#debug-menu-list')).toBeHidden();
});

test('every visible menu entry is hit-testable, not clipped by the scroll container', async ({ page }) => {
    await openSettings(page);

    await page.locator('#debug-export-btn').click();
    await expect(page.locator('#debug-menu-list')).toBeVisible();

    // boundingBox() ignores ancestor overflow clipping, so probe the real hit
    // target at each entry's centre instead. The settings drawer opens with an
    // animation, so its scroll container is still short for a frame or two and
    // every probe below the fold fails; poll until the layout settles instead
    // of measuring mid-transition. A menu that stays clipped never settles into
    // an empty list, so the assertion keeps its teeth.
    const unreachable = () => page.evaluate(() => {
        const items = [...document.querySelectorAll('#debug-menu-list .debug-menu-item')]
            .filter(item => !item.hidden && item.offsetParent !== null);

        return items
            .filter(item => {
                const rect = item.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return !hit || !item.contains(hit);
            })
            .map(item => item.dataset.debugAction);
    });

    await expect.poll(unreachable).toEqual([]);
});

test('the menu stays within viewport bounds on a narrow mobile screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page);

    await page.locator('#debug-export-btn').click();
    await expect(page.locator('#debug-menu-list')).toBeVisible();

    const bounds = await page.evaluate(() => {
        const list = document.getElementById('debug-menu-list');
        const rect = list.getBoundingClientRect();
        return {
            left: rect.left,
            right: rect.right,
            viewportWidth: window.innerWidth,
        };
    });

    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
});
