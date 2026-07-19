// Browser Storage Inspector · delete a localStorage key.
//
// Seeds 3 keys, opens Inspector, drills localStorage, clicks the delete
// button on the 2nd key, confirms the popup, verifies:
//   - list refreshes to show only 2 rows
//   - page.evaluate(() => localStorage.getItem(deleted)) returns null
//   - remaining 2 keys still present.
// Captures 03-delete-confirm.png with confirm popup open.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedBrowserFixture, wipeBrowserFixture, openBrowserStorageInspector } from './_helpers.js';

const SCREENSHOT_DIR = resolve(import.meta.dirname, '../../../docs/public/images/browser-storage-inspector');

let server;
test.beforeAll(async () => {
    server = await startServer({ batchKey: 'browser-storage-inspector', scenarioId: 'delete-ls' });
});
test.afterAll(async () => { await tearDownServer(server); });

test.describe('Browser Storage Inspector · delete localStorage key', () => {
    test('confirms delete, removes key, refreshes list', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await wipeBrowserFixture(page);
        await seedBrowserFixture(page, {
            localStorage: {
                'luker-last-chat':   'Chat with Seraphina',
                'luker-draft-x729':  'x'.repeat(400),
                'luker-theme':       'dark',
            },
        });

        const inspector = await openBrowserStorageInspector(page);
        await inspector.locator('.storageInspectorEntry[data-key="localStorage"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });
        await expect(inspector.locator('.storageInspectorEntry')).toHaveCount(3);

        // Click delete on luker-draft-x729
        const targetRow = inspector.locator('.storageInspectorEntry[data-key="luker-draft-x729"]');
        await targetRow.locator('.storageInspectorEntryDeleteButton').click();

        // Confirm popup mounts as a NEW dialog on top of Inspector
        const confirmDialog = page.locator('dialog.popup[open]').last();
        await expect(confirmDialog).toContainText('luker-draft-x729');  // label interpolation

        await inspector.screenshot({ path: resolve(SCREENSHOT_DIR, '03-delete-confirm.png') });

        // Click the OK / Delete button
        await confirmDialog.locator('.popup-button-ok').click();

        // Inspector refreshes — count drops to 2 and target row disappears
        await expect(inspector.locator('.storageInspectorEntry')).toHaveCount(2);
        await expect(inspector.locator('.storageInspectorEntry[data-key="luker-draft-x729"]')).toHaveCount(0);

        // Verify actual localStorage: key gone, others still present
        const state = await page.evaluate(() => ({
            deleted: localStorage.getItem('luker-draft-x729'),
            keep1:   localStorage.getItem('luker-last-chat'),
            keep2:   localStorage.getItem('luker-theme'),
        }));
        expect(state.deleted).toBeNull();
        expect(state.keep1).toBe('Chat with Seraphina');
        expect(state.keep2).toBe('dark');

        await wipeBrowserFixture(page);
    });
});
