// Storage Inspector · admin per-user view.
//
// Multi-user scenario: default-user (auto-admin) creates alice + bob via
// the real Admin Panel New User form. Both get fixture data seeded on
// disk. The admin then opens Storage Management tab, sees the user
// picker (aggregate row + alice + bob), clicks bob, and drills into
// bob's Chats.
//
// Also captures screenshot 04-admin-picker.png of the picker + inspector,
// gated behind LUKER_UPDATE_DOC_SCREENSHOTS (see _lib/doc-screenshots.js).

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI, createUserViaAdminUI } from '../_lib/page.js';
import { accountWindow, closeAccountWindow, openAdminPage } from '../_lib/account-window.js';
import { loginAs } from '../_lib/sync.js';
import { takeDocScreenshot } from '../_lib/doc-screenshots.js';
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
    // The Account window drops back to the user list after create; close
    // it before starting the second create, like an admin would.
    await closeAccountWindow(bootPage);
    await createUserViaAdminUI(bootPage, { handle: 'bob', name: 'Bob Casca', password: 'pw-bob' });
    await closeAccountWindow(bootPage);
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
        // Open user management → Server → Storage Management.
        await openAdminPage(page, 'adminStorage');
        const win = accountWindow(page);

        // The /api/users/overview fetch populates the picker. Wait for real
        // user rows to appear.
        const picker = win.locator('[data-region="adm-storage"]');
        await picker.locator('[data-act="adm-storage-open"][data-target="alice"]').waitFor({ state: 'visible', timeout: 10_000 });

        // 3 rows: aggregate + alice + bob (default-user has no seeded
        // storage but still appears as a row, so total is 4 — assert
        // "at least 3 non-aggregate real users appear"; the picker only
        // hides the aggregate on filter).
        const rows = picker.locator('[data-act="adm-storage-open"]');
        expect(await rows.count()).toBeGreaterThanOrEqual(3);
        await expect(picker.locator('[data-act="adm-storage-open"][data-target="__all__"]')).toBeVisible();
        await expect(picker.locator('[data-act="adm-storage-open"][data-target="alice"]')).toBeVisible();
        await expect(picker.locator('[data-act="adm-storage-open"][data-target="bob"]')).toBeVisible();

        // Screenshot 04 — picker with aggregate + real users visible.
        await takeDocScreenshot(page, resolve(SCREENSHOT_DIR, '04-admin-picker.png'), {
            fullPage: false,
        });

        // Click bob's row; the Inspector opens on its own page.
        await picker.locator('[data-act="adm-storage-open"][data-target="bob"]').click();
        const inspector = win.locator('[data-region="adm-inspector"] .storageInspectorContainer');
        await inspector.waitFor({ state: 'visible', timeout: 10_000 });
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        // Bob's fixture includes chats — Chats category row must show.
        await expect(inspector.locator('.storageInspectorEntry[data-key="chats"]')).toBeVisible();
    });
});
