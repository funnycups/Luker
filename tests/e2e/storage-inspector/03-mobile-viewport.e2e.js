// Storage Inspector · mobile viewport CSS breakpoint.
//
// Pins the @media (max-width: 720px) rules in public/css/storage-inspector.css:
//   - .storageInspectorEntry gains flex-wrap:wrap
//   - .storageInspectorEntryDots is display:none
// Also verifies the same UI at 1280×800 restores the desktop layout (dots
// visible again).

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openStorageInspectorPage } from '../_lib/account-window.js';
import { seedFixtureUser } from './_helpers.js';

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope,
        batchKey: 'storage-inspector',
        scenarioId: 'mobile-viewport',
    });
    markOnboarded({ dataRoot: server.dataRoot });
    await seedFixtureUser(server.dataRoot, 'default-user');
});



async function openInspector(page) {
    return openStorageInspectorPage(page, 'server');
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
