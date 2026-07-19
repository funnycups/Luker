// Storage Inspector · self drill-down (single-user mode).
//
// Boots a Luker server in single-user mode (enableUserAccounts:false so
// the default admin logs in without a password), seeds a plausible corpus
// under default-user/, then drives the User Profile → Storage Inspector
// popup entirely through real DOM gestures:
//
//   1. Open Storage Inspector via #user-settings-button → #account_button
//      → .userStorageInspectorButton.
//   2. Verify L1 shows the stacked bar + at least the categories that our
//      fixture populates.
//   3. Drill Chats → default_Seraphina → first chat file.
//   4. Verify L4 shows metadata + messages + sidecars split rows.
//   5. Click a breadcrumb crumb to walk back up.
//
// Also captures three doc screenshots on the way — 01-self-l1.png,
// 02-self-chats-drilldown.png, 03-self-chat-file.png — that live under
// docs/public/images/storage-inspector/ so the user-facing docs can
// reference them without a separate capture pass.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedFixtureUser } from './_helpers.js';

const SCREENSHOT_DIR = resolve(import.meta.dirname, '../../../docs/public/images/storage-inspector');

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'storage-inspector',
        scenarioId: 'self-drilldown',
    });
    await seedFixtureUser(server.dataRoot, 'default-user');
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('Storage Inspector · self drill-down', () => {
    test('drills L1 → chats → character → chat → back via breadcrumb', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Open user-settings drawer, click Account (#account_button) to
        // launch the User Profile popup, then the Storage Inspector button
        // inside it.
        const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
        if (drawerClosed) {
            await page.locator('#user-settings-button .drawer-toggle').click();
            await page.waitForFunction(() => {
                const el = document.getElementById('user-settings-block');
                return el && !el.classList.contains('closedDrawer');
            }, { timeout: 5_000 });
        }
        await page.locator('#account_button').click();
        // User Profile popup is a callGenericPopup TEXT modal — wait for
        // its Storage Inspector button to be visible.
        const profilePopup = page.locator('dialog.popup[open]').last();
        await profilePopup.locator('.userStorageInspectorButton').click();

        // The Inspector popup is a NEW callGenericPopup mounted on top of
        // the profile popup. Grab the top-most open dialog and scope from
        // there for the rest of the drill.
        const inspector = page.locator('dialog.popup[open]').last().locator('.storageInspectorContainer');
        await inspector.waitFor({ state: 'visible', timeout: 10_000 });

        // Wait for the L1 fetch to settle — loading skeleton disappears.
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        // L1 · stacked bar has multiple segments; the entry list has all
        // the categories the fixture populated (chats + worlds + images +
        // backups + vectors + other → at least 5 visible rows).
        expect(await inspector.locator('.storageInspectorBarSegment').count()).toBeGreaterThanOrEqual(3);
        expect(await inspector.locator('.storageInspectorEntry').count()).toBeGreaterThanOrEqual(5);
        await expect(inspector.locator('.storageInspectorEntry[data-key="chats"]')).toBeVisible();

        // Screenshot 01 — L1 view (stacked bar + entry list visible).
        await page.screenshot({
            path: resolve(SCREENSHOT_DIR, '01-self-l1.png'),
            fullPage: false,
        });

        // Drill into Chats.
        await inspector.locator('.storageInspectorEntry[data-key="chats"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
        await expect(inspector.locator('.storageInspectorBreadcrumbCurrent')).toHaveText(/Chats|聊天/);
        // The seeded fixture guarantees default_Seraphina exists.
        await expect(inspector.locator('.storageInspectorEntry[data-key="default_Seraphina"]')).toBeVisible();

        // Screenshot 02 — L2 chats view showing per-character rows.
        await page.screenshot({
            path: resolve(SCREENSHOT_DIR, '02-self-chats-drilldown.png'),
            fullPage: false,
        });

        // Drill into the character.
        await inspector.locator('.storageInspectorEntry[data-key="default_Seraphina"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
        // Two chats seeded per character.
        expect(await inspector.locator('.storageInspectorEntry[data-kind="chat-file"]').count()).toBeGreaterThanOrEqual(2);

        // Drill into the first chat file.
        await inspector.locator('.storageInspectorEntry[data-kind="chat-file"]').first().click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });

        // L4 splits into chat metadata + messages + two sidecar rows.
        await expect(inspector.locator('.storageInspectorEntry[data-kind="chat-metadata"]')).toBeVisible();
        await expect(inspector.locator('.storageInspectorEntry[data-kind="chat-messages"]')).toBeVisible();
        expect(await inspector.locator('.storageInspectorEntry[data-kind="chat-sidecar"]').count()).toBeGreaterThanOrEqual(2);

        // Screenshot 03 — L4 chat file view (metadata + messages + sidecars).
        await page.screenshot({
            path: resolve(SCREENSHOT_DIR, '03-self-chat-file.png'),
            fullPage: false,
        });

        // Breadcrumb back to L1: click the first crumb (the "Storage" root).
        await inspector.locator('.storageInspectorBreadcrumbCrumb').first().click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached', timeout: 15_000 });
        await expect(inspector.locator('.storageInspectorEntry[data-key="chats"]')).toBeVisible();
    });
});
