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
// keeps its own form state: the file, the mode and the content selection
// together. A draft with no file starts over from the defaults (mode and
// selection both), and the reopened draft, restored without touching it,
// requests exactly the narrowed selection. A migration link regenerated
// after reopening keeps the content of the link it replaces. API keys are
// an ordinary, selectable category.

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

const chip = (page, id) => accountWindow(page).locator(`[data-act="bcat"][data-id="${id}"]`);
const modeButton = (page, mode) => accountWindow(page).locator(`[data-act="mode"][data-set="restore"][data-mode="${mode}"]`);

/** Narrow the restore draft to "Replace" with only extensions selected. */
async function narrowRestoreDraft(page) {
    await modeButton(page, 'replace').click();
    await accountWindow(page).locator('[data-act="bsel"][data-mode="none"]').click();
    await chip(page, 'extensions').click();
    await expect(chip(page, 'extensions')).toHaveClass(/\bon\b/);
    await expect(chip(page, 'chats')).not.toHaveClass(/\bon\b/);
}

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

    // Pick the ZIP in alice's restore form, narrow it to "Replace" with
    // only extensions, then leave the window.
    await openAccountTab(page, 'restore');
    await expect(chip(page, 'secrets')).toBeEnabled();
    await expect(chip(page, 'secrets')).toHaveClass(/\bon\b/);
    await accountWindow(page).locator('input[data-role="file"]').setInputFiles(backupZip);
    await accountWindow(page).locator('.dw-file').waitFor({ state: 'visible', timeout: 15_000 });
    await narrowRestoreDraft(page);
    await closeUserData(page);

    // The picked file and selection belong to alice, not to bob.
    await openUserData(page, 'bob');
    await openAccountTab(page, 'restore');
    await expect(accountWindow(page).locator('.dw-file')).toHaveCount(0);
    await expect(chip(page, 'chats')).toHaveClass(/\bon\b/);
    await expect(modeButton(page, 'merge')).toHaveClass(/\bon\b/);

    // A draft without a file does not survive closing: "Replace" and the
    // narrowed selection both go back to the defaults together.
    await narrowRestoreDraft(page);
    await closeUserData(page);
    await openUserData(page, 'bob');
    await openAccountTab(page, 'restore');
    await expect(modeButton(page, 'merge')).toHaveClass(/\bon\b/);
    await expect(chip(page, 'chats')).toHaveClass(/\bon\b/);
    await expect(chip(page, 'secrets')).toHaveClass(/\bon\b/);

    // A migration link made for extensions only, regenerated after reopening
    // (when the selection on screen is back to the defaults), still offers
    // extensions only.
    const offerSelections = [];
    await page.route('**/api/users/lan-migration/offer', route => {
        offerSelections.push(route.request().postDataJSON().selection);
        return route.continue();
    });
    const openMigrateOut = async () => {
        await openAccountTab(page, 'migrate');
        await accountWindow(page).locator('[data-act="push"][data-view="migrateOut"]').click();
        await expect(pageHead(page)).toHaveAttribute('data-view', 'migrateOut');
    };
    await openMigrateOut();
    await accountWindow(page).locator('[data-act="bsel"][data-mode="none"]').click();
    await chip(page, 'extensions').click();
    await accountWindow(page).locator('[data-act="migrate-link"]').click();
    await accountWindow(page).locator('.dw-linkbox').waitFor({ state: 'visible', timeout: 15_000 });
    await closeUserData(page);
    await openUserData(page, 'bob');
    await expect(chip(page, 'chats')).toHaveClass(/\bon\b/);
    await openMigrateOut();
    await accountWindow(page).locator('.dw-linkbox [data-act="migrate-link"]').click();
    await expect.poll(() => offerSelections.length, { timeout: 15_000 }).toBe(2);
    await page.unroute('**/api/users/lan-migration/offer');
    for (const selection of offerSelections) {
        expect(Object.keys(selection).filter(key => selection[key])).toEqual(['extensions']);
    }
    await accountWindow(page).locator('[data-act="migrate-done"]').click();
    await closeUserData(page);

    // Reopening alice keeps her own form state: file, mode and selection.
    await openUserData(page, 'alice');
    await openAccountTab(page, 'restore');
    await expect(accountWindow(page).locator('.dw-file')).toBeVisible();
    await expect(modeButton(page, 'replace')).toHaveClass(/\bon\b/);
    await expect(chip(page, 'extensions')).toHaveClass(/\bon\b/);
    await expect(chip(page, 'chats')).not.toHaveClass(/\bon\b/);
    await expect(chip(page, 'secrets')).not.toHaveClass(/\bon\b/);

    // Restoring the reopened draft as it is, without reselecting anything,
    // asks to replace extensions only. The request is stopped before the
    // server acts on it.
    let draftRequest;
    await page.route('**/api/users/restore-backup', route => {
        draftRequest = route.request().postDataJSON();
        return route.abort();
    });
    await accountWindow(page).locator('[data-act="restore-go"]').click();
    await answerWindowConfirm(page);
    await expect.poll(() => draftRequest, { timeout: 90_000 }).toBeTruthy();
    await page.unroute('**/api/users/restore-backup');
    expect(draftRequest.mode).toBe('overwrite');
    expect(Object.keys(draftRequest.selection).filter(key => draftRequest.selection[key])).toEqual(['extensions']);
    await expect(accountWindow(page).locator('[data-act="restore-go"]')).toBeEnabled({ timeout: 30_000 });
    await modeButton(page, 'merge').click();

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
    const restoreRequest = page.waitForRequest(req => req.url().endsWith('/api/users/restore-backup') && req.method() === 'POST', { timeout: 90_000 });
    await answerWindowConfirm(page);

    // The request restores exactly what the window shows as selected.
    const { selection } = (await restoreRequest).postDataJSON();
    expect(Object.keys(selection).filter(key => selection[key])).toEqual(['extensions']);

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
