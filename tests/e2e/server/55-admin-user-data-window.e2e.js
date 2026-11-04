// e2e/server/55-admin-user-data-window.e2e.js
//
// Admin acts on another user's data. From user management → a user →
// "Backup, restore and migration", the Account window is scoped to that
// user: the title carries the handle, the page shows the "Acting on user"
// pill, and a restore that matched nothing stays on screen as a warning
// with a Done button that returns to user management instead of reloading
// the admin's own page.
//
// Also checks that a ZIP picked in one user's restore form does not leak
// into another user's window, while reopening the first user's window
// keeps its own form state.

import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, createUserViaAdminUI } from '../_lib/page.js';
import {
    accountWindow,
    answerWindowConfirm,
    openAccountTab,
    openAdminUser,
    pageHead,
    windowConfirm,
} from '../_lib/account-window.js';
import { loginAs } from '../_lib/sync.js';
import { seedFixtureUser } from '../storage-inspector/_helpers.js';

const HANDLES = ['alice', 'bob'];
let server;
let tempDir;
let backupZip;

test.beforeAll(async ({ browser }) => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'admin-user-data-'));
    backupZip = path.join(tempDir, 'alice-backup.zip');
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'admin-user-data',
        extraConfig: { enableUserAccounts: true },
    });

    const bootCtx = await browser.newContext();
    const bootPage = await bootCtx.newPage();
    await awaitMainUI(bootPage, server.baseURL);
    await createUserViaAdminUI(bootPage, { handle: 'alice', name: 'Alice Merren', password: 'pw-alice' });
    await bootPage.locator('dialog.dw-layer .dw-titlebar [data-act="close"]').click();
    await bootPage.locator('dialog.dw-layer').waitFor({ state: 'detached', timeout: 10_000 });
    await createUserViaAdminUI(bootPage, { handle: 'bob', name: 'Bob Casca', password: 'pw-bob' });
    await bootPage.locator('dialog.dw-layer .dw-titlebar [data-act="close"]').click();
    await bootPage.locator('dialog.dw-layer').waitFor({ state: 'detached', timeout: 10_000 });
    await bootCtx.close();

    for (const handle of HANDLES) await seedFixtureUser(server.dataRoot, handle);
});

test.afterAll(async () => {
    if (server) await tearDownServer(server);
    rmSync(tempDir, { recursive: true, force: true });
});

/** Open one user's data window from the user management list. */
async function openUserData(page, handle) {
    await openAdminUser(page, handle);
    await accountWindow(page).locator('[data-act="adm-data"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'backup', { timeout: 15_000 });
}

/**
 * Close a per-user data window. It reopens user management right away, so
 * wait for that window (title "Account", back on the user's detail page)
 * rather than for every dialog to disappear.
 */
async function closeUserData(page) {
    await accountWindow(page).locator('.dw-titlebar [data-act="close"]').click();
    const modal = windowConfirm(page);
    if (await modal.isVisible().catch(() => false)) await modal.locator('[data-r="1"]').click();
    await expect(accountWindow(page).locator('.dw-title')).toHaveText('Account', { timeout: 15_000 });
    await expect(pageHead(page)).toHaveAttribute('data-view', 'adminUser', { timeout: 15_000 });
}

test('admin acts on another user\'s data and comes back to user management', async ({ page }) => {
    test.setTimeout(180_000);
    await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });

    // The window is scoped to the target user.
    await openUserData(page, 'alice');
    await expect(accountWindow(page).locator('.dw-title')).toHaveText('Account · alice');
    await expect(accountWindow(page).locator('.dw-pilltag.is-warn')).toHaveText('Acting on user alice');

    // Download alice's backup through the real Backup page.
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90_000 }),
        accountWindow(page).locator('[data-act="backup-go"]').click(),
    ]);
    await download.saveAs(backupZip);

    // Pick the ZIP in alice's restore form, then leave the window.
    await openAccountTab(page, 'restore');
    await accountWindow(page).locator('input[data-role="file"]').setInputFiles(backupZip);
    await accountWindow(page).locator('.dw-file').waitFor({ state: 'visible', timeout: 15_000 });
    await closeUserData(page);

    // The picked file belongs to alice, not to bob.
    await openUserData(page, 'bob');
    await openAccountTab(page, 'restore');
    await expect(accountWindow(page).locator('.dw-file')).toHaveCount(0);
    await closeUserData(page);

    // Reopening alice keeps her own form state.
    await openUserData(page, 'alice');
    await openAccountTab(page, 'restore');
    await expect(accountWindow(page).locator('.dw-file')).toBeVisible();

    // Restore only a category alice has no files for: the window reports
    // that nothing was restored and waits for Done instead of reloading.
    // The backup is downloaded with the same category so the archive holds
    // no file entries at all, not even skipped ones.
    await openAccountTab(page, 'backup');
    await accountWindow(page).locator('[data-act="bsel"][data-mode="none"]').click();
    await accountWindow(page).locator('[data-act="bcat"][data-id="extensions"]').click();
    const [extensionsZip] = await Promise.all([
        page.waitForEvent('download', { timeout: 90_000 }),
        accountWindow(page).locator('[data-act="backup-go"]').click(),
    ]);
    const extensionsZipPath = path.join(tempDir, 'alice-extensions.zip');
    await extensionsZip.saveAs(extensionsZipPath);

    await openAccountTab(page, 'restore');
    await accountWindow(page).locator('input[data-role="file"]').setInputFiles(extensionsZipPath);
    await accountWindow(page).locator('.dw-file').waitFor({ state: 'visible', timeout: 15_000 });
    await accountWindow(page).locator('[data-act="restore-go"]').click();
    await answerWindowConfirm(page);

    const banner = accountWindow(page).locator('.dw-banner.warning');
    await banner.waitFor({ state: 'visible', timeout: 90_000 });
    await expect(banner).toContainText('No files were restored');

    // Nothing was restored, so the window must not auto-reload away.
    await page.waitForTimeout(4000);
    await expect(accountWindow(page).locator('.dw-title')).toHaveText('Account · alice');
    await expect(banner).toBeVisible();

    const done = banner.locator('[data-act="reload"]');
    await expect(done).toHaveText('Done');
    await done.click();

    // Done closes the per-user window and returns to user management,
    // where the admin was before opening it.
    await expect(accountWindow(page).locator('.dw-title')).toHaveText('Account', { timeout: 15_000 });
    await expect(pageHead(page)).toHaveAttribute('data-view', 'adminUser', { timeout: 15_000 });
    await accountWindow(page).locator('[data-act="back"]').first().click();
    await expect(accountWindow(page).locator('[data-act="adm-user"][data-handle="alice"]').first())
        .toBeVisible({ timeout: 15_000 });
});
