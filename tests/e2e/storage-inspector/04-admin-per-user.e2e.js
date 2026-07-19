// Storage Inspector · admin per-user view.
//
// Multi-user scenario: default-user (auto-admin) creates alice + bob via
// the real Admin Panel New User form. Both get fixture data seeded on
// disk. The admin then opens Storage Management tab, sees the user
// picker (aggregate row + alice + bob), clicks bob, and drills into
// bob's Chats.
//
// Also captures screenshot 04-admin-picker.png of the picker + inspector.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, openAdminPanel, createUserViaAdminUI } from '../_lib/page.js';
import { loginAs } from '../_lib/sync.js';
import { seedFixtureUser } from './_helpers.js';

const SCREENSHOT_DIR = resolve(import.meta.dirname, '../../../docs/public/images/storage-inspector');

let server;

test.beforeAll(async ({ browser }) => {
    server = await startServer({
        batchKey: 'storage-inspector',
        scenarioId: 'admin-per-user',
        extraConfig: { enableUserAccounts: true },
    });

    // Bootstrap: log in as the default admin and create alice + bob via
    // the real Admin Panel New User form.
    const bootCtx = await browser.newContext();
    const bootPage = await bootCtx.newPage();
    await awaitMainUI(bootPage, server.baseURL);
    await createUserViaAdminUI(bootPage, { handle: 'alice', name: 'Alice Merren', password: 'pw-alice' });
    // The Admin Panel popup drops back to Manage Users after create; we
    // need it fully closed before starting the second create, else the
    // openAdminPanel helper would click through a stale popup layer.
    await bootPage.locator('dialog.popup[open] .popup-button-ok').last().click();
    await bootPage.waitForFunction(() => !document.querySelector('dialog.popup[open]'), { timeout: 10_000 });
    await createUserViaAdminUI(bootPage, { handle: 'bob', name: 'Bob Casca', password: 'pw-bob' });
    await bootPage.locator('dialog.popup[open] .popup-button-ok').last().click();
    await bootCtx.close();

    // Seed fixture data on disk for alice + bob (data dirs already exist
    // — createUserViaAdminUI ran /api/users/create → ensurePublicDirectoriesExist).
    await seedFixtureUser(server.dataRoot, 'alice');
    await seedFixtureUser(server.dataRoot, 'bob');
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('Storage Inspector · admin per-user view', () => {
    test('admin sees picker, switches to bob, sees bob\'s Chats', async ({ page }) => {
        // Default-user is admin; log in as them to exercise the admin path.
        await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });
        await openAdminPanel(page);

        // Click the Storage Management nav tab.
        const popup = page.locator('dialog.popup[open]').last();
        await popup.locator('button[data-target-tab="storageManagementTab"]').click();
        const tab = popup.locator('.storageManagementTab');
        await tab.waitFor({ state: 'visible', timeout: 10_000 });

        // The renderStorageManagement fetch (/api/users/overview) populates
        // the picker. Wait for real user rows to appear.
        const picker = tab.locator('.storageInspectorAdminUserPicker');
        await picker.locator('.storageInspectorAdminUserRow[data-target="alice"]').waitFor({ state: 'visible', timeout: 10_000 });

        // 3 rows: aggregate + alice + bob (default-user has no seeded
        // storage but still appears as a row, so total is 4 — assert
        // "at least 3 non-aggregate real users appear"; the picker only
        // hides the aggregate on filter).
        const rows = picker.locator('.storageInspectorAdminUserRow');
        expect(await rows.count()).toBeGreaterThanOrEqual(3);
        await expect(picker.locator('.storageInspectorAdminUserRow[data-target="__all__"]')).toBeVisible();
        await expect(picker.locator('.storageInspectorAdminUserRow[data-target="alice"]')).toBeVisible();
        await expect(picker.locator('.storageInspectorAdminUserRow[data-target="bob"]')).toBeVisible();

        // Screenshot 04 — picker with aggregate + real users visible.
        await page.screenshot({
            path: resolve(SCREENSHOT_DIR, '04-admin-picker.png'),
            fullPage: false,
        });

        // Click bob's row; the Inspector mounts inside the tab.
        await picker.locator('.storageInspectorAdminUserRow[data-target="bob"]').click();
        const inspector = tab.locator('.storageInspectorAdminInspectorContainer .storageInspectorContainer');
        await inspector.waitFor({ state: 'visible', timeout: 10_000 });
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        // Bob's fixture includes chats — Chats category row must show.
        await expect(inspector.locator('.storageInspectorEntry[data-key="chats"]')).toBeVisible();
    });
});
