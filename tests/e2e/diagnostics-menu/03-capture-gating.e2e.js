// tests/e2e/diagnostics-menu/03-capture-gating.e2e.js
//
// The capture entries are client-only. A plain browser has no native bridge,
// so the entries must stay hidden rather than offering an action that cannot
// run.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'diagnostics', scenarioId: 'capture-gating' });
    markOnboarded({ dataRoot: server.dataRoot });
});



/** Load the UI and open the User Settings drawer, where the trigger lives. */
async function openSettings(page) {
    await awaitMainUI(page, server.baseURL);
    if (await page.locator('#user-settings-button .drawer-icon.closedIcon').count()) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
    await expect(page.locator('#debug-export-btn')).toBeVisible();
}

test('capture entries stay hidden in a browser without the native bridge', async ({ page }) => {
    await openSettings(page);
    await page.locator('#debug-export-btn').click();

    await expect(page.locator('[data-debug-action="export-bundle"]')).toBeVisible();
    await expect(page.locator('[data-debug-action="download-perf-report"]')).toBeVisible();
    await expect(page.locator('[data-debug-action="toggle-self-profiling"]')).toBeVisible();
    await expect(page.locator('[data-debug-action="capture-heap"]')).toBeHidden();
    await expect(page.locator('[data-debug-action="toggle-perf-recording"]')).toBeHidden();
    await expect(page.locator('[data-debug-action="toggle-android-debug-recording"]')).toBeHidden();
});
