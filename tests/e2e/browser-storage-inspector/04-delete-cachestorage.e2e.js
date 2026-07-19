// Browser Storage Inspector · delete a single Cache Storage cache.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedBrowserFixture, wipeBrowserFixture, openBrowserStorageInspector } from './_helpers.js';

let server;
test.beforeAll(async () => {
    server = await startServer({ batchKey: 'browser-storage-inspector', scenarioId: 'delete-cache' });
});
test.afterAll(async () => { await tearDownServer(server); });

test.describe('Browser Storage Inspector · delete Cache Storage', () => {
    test('deletes a single cache; other caches remain', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await wipeBrowserFixture(page);
        await seedBrowserFixture(page, {
            caches: [
                { name: 'kokoro-voices', requests: ['/voices/af_heart.bin'] },
                { name: 'tts-cache',     requests: ['/tts/hello.wav', '/tts/world.wav'] },
                { name: 'model-index',   requests: ['/models/kokoro.json'] },
            ],
        });

        const inspector = await openBrowserStorageInspector(page);
        await inspector.locator('.storageInspectorEntry[data-key="cachestorage"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });
        await expect(inspector.locator('.storageInspectorEntry')).toHaveCount(3);

        // Delete tts-cache
        await inspector.locator('.storageInspectorEntry[data-key="tts-cache"] .storageInspectorEntryDeleteButton').click();
        await page.locator('dialog.popup[open]').last().locator('.popup-button-ok').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });

        // UI · tts-cache gone
        await expect(inspector.locator('.storageInspectorEntry')).toHaveCount(2);
        await expect(inspector.locator('.storageInspectorEntry[data-key="tts-cache"]')).toHaveCount(0);

        // Real state · other caches remain
        const names = await page.evaluate(() => caches.keys());
        expect(names).not.toContain('tts-cache');
        expect(names).toContain('kokoro-voices');
        expect(names).toContain('model-index');

        await wipeBrowserFixture(page);
    });
});
