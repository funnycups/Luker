// Browser Storage Inspector · mobile viewport + confirm-cancel path.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedBrowserFixture, wipeBrowserFixture, openBrowserStorageInspector } from './_helpers.js';

const SCREENSHOT_DIR = resolve(import.meta.dirname, '../../../docs/public/images/browser-storage-inspector');

let server;
test.beforeAll(async () => {
    server = await startServer({ batchKey: 'browser-storage-inspector', scenarioId: 'mobile' });
});
test.afterAll(async () => { await tearDownServer(server); });

test.describe('Browser Storage Inspector · mobile + cancel', () => {
    test('mobile viewport: dots hidden, rows wrap', async ({ page }) => {
        await page.setViewportSize({ width: 400, height: 800 });
        await awaitMainUI(page, server.baseURL);
        await wipeBrowserFixture(page);
        await seedBrowserFixture(page, {
            localStorage: { 'luker-mobile-test': 'demo', 'luker-second': 'demo2' },
        });

        const inspector = await openBrowserStorageInspector(page);
        await expect(inspector.locator('.storageInspectorEntry')).toHaveCount(5);

        // Storage Inspector CSS collapses `.storageInspectorEntryDots` at
        // <=720px viewport — hidden dots per mobile CSS rule.
        const dotsVisible = await inspector.locator('.storageInspectorEntry .storageInspectorEntryDots').first().isVisible();
        expect(dotsVisible).toBe(false);

        await inspector.screenshot({ path: resolve(SCREENSHOT_DIR, '04-mobile.png') });

        await wipeBrowserFixture(page);
    });

    test('cancel path: click delete, cancel popup, item still there', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await wipeBrowserFixture(page);
        await seedBrowserFixture(page, {
            localStorage: { 'luker-cancel-test': 'still here' },
        });

        const inspector = await openBrowserStorageInspector(page);
        await inspector.locator('.storageInspectorEntry[data-key="localStorage"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });

        await inspector.locator('.storageInspectorEntry[data-key="luker-cancel-test"] .storageInspectorEntryDeleteButton').click();
        const confirmDialog = page.locator('dialog.popup[open]').last();
        await confirmDialog.locator('.popup-button-cancel').click();

        // Key still there in UI + in real storage
        await expect(inspector.locator('.storageInspectorEntry[data-key="luker-cancel-test"]')).toBeVisible();
        const val = await page.evaluate(() => localStorage.getItem('luker-cancel-test'));
        expect(val).toBe('still here');

        await wipeBrowserFixture(page);
    });
});
