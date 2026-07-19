// Storage Inspector · mobile viewport CSS breakpoint.
//
// Pins the @media (max-width: 720px) rules in public/css/storage-inspector.css:
//   - .storageInspectorEntry gains flex-wrap:wrap
//   - .storageInspectorEntryDots is display:none
// Also verifies the same UI at 1280×800 restores the desktop layout (dots
// visible again).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedFixtureUser } from './_helpers.js';

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'storage-inspector',
        scenarioId: 'mobile-viewport',
    });
    await seedFixtureUser(server.dataRoot, 'default-user');
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openInspector(page) {
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }
    await page.locator('#account_button').click();
    const profilePopup = page.locator('dialog.popup[open]').last();
    await profilePopup.locator('.userStorageInspectorButton').click();
    const inspector = page.locator('dialog.popup[open]').last().locator('.storageInspectorContainer');
    await inspector.waitFor({ state: 'visible', timeout: 10_000 });
    await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
    return inspector;
}

test.describe('Storage Inspector · mobile viewport', () => {
    test('narrow viewport hides dots and lets entry rows wrap', async ({ page }) => {
        // Set the viewport BEFORE opening the app so the initial layout is
        // computed against the mobile size.
        await page.setViewportSize({ width: 400, height: 800 });
        await awaitMainUI(page, server.baseURL);
        const inspector = await openInspector(page);

        const firstRow = inspector.locator('.storageInspectorEntry').first();
        const flexWrap = await firstRow.evaluate(el => getComputedStyle(el).flexWrap);
        expect(flexWrap, 'entry rows should wrap under 720px').toBe('wrap');

        const dotsDisplay = await firstRow.locator('.storageInspectorEntryDots').evaluate(el => getComputedStyle(el).display);
        expect(dotsDisplay, 'dots should be hidden under 720px').toBe('none');
    });

    test('desktop viewport restores the full row layout', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await awaitMainUI(page, server.baseURL);
        const inspector = await openInspector(page);

        const firstRow = inspector.locator('.storageInspectorEntry').first();
        const flexWrap = await firstRow.evaluate(el => getComputedStyle(el).flexWrap);
        expect(flexWrap, 'entry rows should NOT wrap on desktop').not.toBe('wrap');

        const dotsDisplay = await firstRow.locator('.storageInspectorEntryDots').evaluate(el => getComputedStyle(el).display);
        expect(dotsDisplay, 'dots should be visible on desktop').not.toBe('none');
    });
});
