// tests/e2e/diagnostics-menu/02-existing-entries.e2e.js
//
// The debug toggles that used to sit scattered in the long User Settings
// checkbox list now live in the diagnostics menu. Moving them must not
// change what they do, and the old controls must be gone.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'diagnostics', scenarioId: 'existing-entries' });
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

test('the moved entries live in the menu and still drive their settings', async ({ page }) => {
    await openSettings(page);
    await page.locator('#debug-export-btn').click();

    const frontendLog = page.locator('[data-debug-action="toggle-frontend-debug-log"]');
    const selfProfiling = page.locator('[data-debug-action="toggle-self-profiling"]');

    await expect(frontendLog).toBeVisible();
    await expect(frontendLog).toHaveAttribute('aria-checked', 'false');
    await expect(selfProfiling).toBeVisible();
    await expect(selfProfiling).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-debug-action="download-perf-report"]')).toBeVisible();

    await frontendLog.click();

    // The toggle must reach the real module, not just flip its own label.
    const enabled = await page.evaluate(async () => {
        const mod = await import('/scripts/frontend-log-manager.js');
        return mod.isFrontendConsoleDebugLoggingEnabled();
    });
    expect(enabled).toBe(true);

    await page.locator('#debug-export-btn').click();
    await expect(frontendLog).toHaveAttribute('aria-checked', 'true');
});

test('the old checkboxes are gone from the settings list', async ({ page }) => {
    await openSettings(page);

    await expect(page.locator('#frontend_debug_logging')).toHaveCount(0);
    await expect(page.locator('#self_profiling_enabled')).toHaveCount(0);
    await expect(page.locator('#download_self_profile_report')).toHaveCount(0);
    await expect(page.locator('#android_debug_recording')).toHaveCount(0);
});
