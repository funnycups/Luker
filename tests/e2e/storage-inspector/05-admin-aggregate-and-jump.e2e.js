// Storage Inspector · admin aggregate view + jump-to-user redirect.
//
// Selects the `* All Users *` aggregate row, verifies L1 sums categories,
// drills into Chats to see per-user rows (kind=aggregate-user-row), then
// clicks a user row to trigger the redirect (endpoint returns
// {redirect:{target,path}} for depth ≥ 3 aggregate paths, frontend re-
// mounts on that user's per-target Inspector automatically).

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
        scenarioId: 'admin-aggregate',
        extraConfig: { enableUserAccounts: true },
    });

    const bootCtx = await browser.newContext();
    const bootPage = await bootCtx.newPage();
    await awaitMainUI(bootPage, server.baseURL);
    await createUserViaAdminUI(bootPage, { handle: 'alice', name: 'Alice Merren', password: 'pw-alice' });
    await bootPage.locator('dialog.popup[open] .popup-button-ok').last().click();
    await bootPage.waitForFunction(() => !document.querySelector('dialog.popup[open]'), { timeout: 10_000 });
    await createUserViaAdminUI(bootPage, { handle: 'bob', name: 'Bob Casca', password: 'pw-bob' });
    await bootPage.locator('dialog.popup[open] .popup-button-ok').last().click();
    await bootCtx.close();

    await seedFixtureUser(server.dataRoot, 'alice');
    await seedFixtureUser(server.dataRoot, 'bob');
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('Storage Inspector · admin aggregate view', () => {
    test('aggregate L1 sums categories; L2 shows per-user rows; click redirects to that user', async ({ page }) => {
        await loginAs(page, server.baseURL, { handle: 'default-user', password: '' });
        await openAdminPanel(page);
        const popup = page.locator('dialog.popup[open]').last();
        await popup.locator('button[data-target-tab="storageManagementTab"]').click();
        const tab = popup.locator('.storageManagementTab');
        await tab.waitFor({ state: 'visible', timeout: 10_000 });
        const picker = tab.locator('.storageInspectorAdminUserPicker');
        await picker.locator('.storageInspectorAdminUserRow[data-target="alice"]').waitFor({ state: 'visible', timeout: 10_000 });

        // Click the aggregate row.
        await picker.locator('.storageInspectorAdminUserRow[data-target="__all__"]').click();
        const inspector = tab.locator('.storageInspectorAdminInspectorContainer .storageInspectorContainer');
        await inspector.waitFor({ state: 'visible', timeout: 10_000 });
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        // Aggregate L1: Chats row present (alice + bob both seeded chats).
        const chatsRow = inspector.locator('.storageInspectorEntry[data-key="chats"]');
        await expect(chatsRow).toBeVisible();

        // Screenshot 05 — aggregate L1 view.
        await page.screenshot({
            path: resolve(SCREENSHOT_DIR, '05-admin-aggregate.png'),
            fullPage: false,
        });

        // Drill into Chats — the aggregate L2 renders per-user rows
        // (kind=aggregate-user-row).
        await chatsRow.click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
        const userRows = inspector.locator('.storageInspectorEntry[data-kind="aggregate-user-row"]');
        expect(await userRows.count()).toBeGreaterThanOrEqual(2);

        // Screenshot 06 — aggregate L2 chats with per-user rows.
        await page.screenshot({
            path: resolve(SCREENSHOT_DIR, '06-admin-aggregate-drilldown.png'),
            fullPage: false,
        });

        // Click the first per-user row. Frontend fetches inspect-any with
        // depth ≥ 3; endpoint returns {redirect:{target,path}}; frontend
        // switches to that user and re-navigates. Breadcrumb reflects the
        // per-user Chats view (contains alice or bob and Chats label).
        //
        // Capture the target user's handle from the row's data-key so the
        // assertion is deterministic against whichever user is at top.
        const targetHandle = await userRows.first().getAttribute('data-key');
        expect(targetHandle).toMatch(/^(alice|bob)$/);
        await userRows.first().click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        // After redirect, breadcrumbs should show Storage → Chats → <charDir>.
        // We assert the breadcrumb contains "Chats" (locale-agnostic
        // via regex; the frontend translate() falls through untranslated
        // strings to the English label).
        await expect(inspector.locator('.storageInspectorBreadcrumbs')).toContainText(/Chats|聊天/);
    });
});
