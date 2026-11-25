// tests/e2e/storage/migrate-failure-recovery.e2e.js — a migration that
// fails on a database connection error must leave the admin UI in a state
// the operator can recover from without restarting the server.
//
// Shape:
//   1. Boot an fs-mode server and open Server → Storage Backend.
//   2. Start a migration to MySQL pointed at a closed port.
//   3. The server reports the failure; the page must not stay locked in
//      "migration in progress" (target radios and Migrate Now re-enabled).
//   4. Reset the retained resume state through the UI.
//   5. Migrate to sqlite to prove the same page still works after a failure.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { accountWindow, answerWindowConfirm, openAdminPage } from '../_lib/account-window.js';
import { fetchStorageStatus } from '../_lib/storage-ui.js';

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'storage', scenarioId: 'migrate-failure-recovery' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test('a failed migration can be retried from the admin UI', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await openAdminPage(page, 'adminBackend');
    const win = accountWindow(page);
    const currentModeEl = win.locator('[data-current-mode]');
    await currentModeEl.waitFor({ state: 'visible', timeout: 10_000 });

    // Target a closed port: mysql2 fails with ECONNREFUSED on the first write.
    await win.locator('[data-act="adm-backend-target"][data-mode="mysql"]').click();
    await win.locator('[data-model="top.db.mysqlUrl"]').fill('mysql://luker:luker@127.0.0.1:1/luker');

    const migrateResponse = page.waitForResponse(response =>
        response.url().includes('/api/users/storage/migrate')
        && response.request().method() === 'POST');
    await win.locator('[data-act="adm-migrate"]').click();
    await answerWindowConfirm(page);
    const response = await migrateResponse;
    expect(response.status()).toBe(500);

    // The failed run must not leave the page locked in "in progress".
    const migrateButton = win.locator('[data-act="adm-migrate"]');
    await expect(migrateButton).toBeEnabled({ timeout: 10_000 });
    await expect(win.locator('[data-act="adm-backend-target"][data-mode="sqlite"]')).toBeEnabled();

    // The resume state is retained for a retry, but no run is active.
    const status = await fetchStorageStatus(page);
    expect(status.migrationInProgress).toBe(false);
    expect(Object.values(status.state?.perUser || {}).some(entry => entry.status === 'failed')).toBe(true);

    // The failure is surfaced with an explicit recovery action.
    const resetButton = win.locator('[data-act="adm-migrate-reset"]');
    await expect(resetButton).toBeVisible();

    await resetButton.click();
    await answerWindowConfirm(page);
    await expect.poll(async () => (await fetchStorageStatus(page)).state).toBeNull();

    // The page is usable again: migrate to sqlite without restarting.
    await win.locator('[data-act="adm-backend-target"][data-mode="sqlite"]').click();
    await win.locator('[data-act="adm-migrate"]').click();
    await answerWindowConfirm(page);
    await expect(currentModeEl).toHaveAttribute('data-current-mode', 'sqlite', { timeout: 60_000 });
});
