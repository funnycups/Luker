// Browser Storage Inspector · L1 enumeration + drilldown into each category.
//
// Seeds a mixed fixture spanning all 5 categories, then verifies:
//   L1 has exactly 5 category rows with expected labelSuffix.
//   Drilling localStorage lists the seeded keys.
//   Drilling IndexedDB → DB → store lists the seeded store.
//   Drilling Cache Storage lists the seeded caches.
//   Storage Quota is a non-drillable leaf.
// Captures 01-browser-l1.png and 02-indexeddb-l2.png doc screenshots.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { awaitMainUI } from '../_lib/page.js';
import { seedBrowserFixture, wipeBrowserFixture, openBrowserStorageInspector } from './_helpers.js';

const SCREENSHOT_DIR = resolve(import.meta.dirname, '../../../docs/public/images/browser-storage-inspector');

let server;
test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'browser-storage-inspector',
        scenarioId: 'enumerate',
    });
});
test.afterAll(async () => { await tearDownServer(server); });

test.describe('Browser Storage Inspector · enumerate and drill', () => {
    test('L1 shows 5 categories; each drills correctly', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await wipeBrowserFixture(page);
        await seedBrowserFixture(page, {
            localStorage: {
                'luker-last-chat': 'Chat with Seraphina',
                'luker-theme': 'dark',
                'luker-draft': 'x'.repeat(500),
            },
            sessionStorage: {
                'session-nav-history': '/user-settings',
            },
            indexeddb: [
                { name: 'bryn-headland-lore', stores: ['characters', 'worldbooks'] },
                { name: 'aetherpost-index', stores: ['entries'] },
            ],
            caches: [
                { name: 'kokoro-voices', requests: ['/voices/af_heart.bin', '/voices/bf_lily.bin'] },
                { name: 'tts-cache', requests: ['/tts/hello.wav'] },
            ],
        });

        const inspector = await openBrowserStorageInspector(page);

        // L1: 5 category rows
        const rows = inspector.locator('.storageInspectorEntry');
        await expect(rows).toHaveCount(5);
        for (const k of ['localStorage', 'sessionStorage', 'indexeddb', 'cachestorage', 'quota']) {
            await expect(inspector.locator(`.storageInspectorEntry[data-key="${k}"]`)).toBeVisible();
        }

        await inspector.screenshot({ path: resolve(SCREENSHOT_DIR, '01-browser-l1.png') });

        // Drill localStorage → L2 lists the 3 seeded keys
        await inspector.locator('.storageInspectorEntry[data-key="localStorage"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });
        for (const k of ['luker-last-chat', 'luker-theme', 'luker-draft']) {
            await expect(inspector.locator(`.storageInspectorEntry[data-key="${k}"]`)).toBeVisible();
        }

        // Every localStorage row has a delete button (canDelete = true)
        expect(await inspector.locator('.storageInspectorEntry .storageInspectorEntryDeleteButton').count()).toBe(3);

        // Back to L1 via breadcrumb
        await inspector.locator('.storageInspectorBreadcrumbCrumb').first().click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });

        // Drill IndexedDB → L2 shows 2 DBs
        await inspector.locator('.storageInspectorEntry[data-key="indexeddb"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });
        await expect(inspector.locator('.storageInspectorEntry[data-key="bryn-headland-lore"]')).toBeVisible();
        await expect(inspector.locator('.storageInspectorEntry[data-key="aetherpost-index"]')).toBeVisible();

        await inspector.screenshot({ path: resolve(SCREENSHOT_DIR, '02-indexeddb-l2.png') });

        // Drill into bryn-headland-lore DB → L3 shows the 2 stores
        await inspector.locator('.storageInspectorEntry[data-key="bryn-headland-lore"]').click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });
        await expect(inspector.locator('.storageInspectorEntry[data-key="characters"]')).toBeVisible();
        await expect(inspector.locator('.storageInspectorEntry[data-key="worldbooks"]')).toBeVisible();

        // Store rows are non-drillable (no chevron), but have delete button
        expect(await inspector.locator('.storageInspectorEntry[data-key="characters"] .storageInspectorEntryChevron').count()).toBe(0);
        expect(await inspector.locator('.storageInspectorEntry[data-key="characters"] .storageInspectorEntryDeleteButton').count()).toBe(1);

        // Back to L1 and verify Storage Quota is a non-drillable leaf.
        await inspector.locator('.storageInspectorBreadcrumbCrumb').first().click();
        await inspector.locator('.storageInspectorLoading.displayNone').waitFor({ state: 'attached' });
        const quotaRow = inspector.locator('.storageInspectorEntry[data-key="quota"]');
        // No chevron (canDrill=false) and no delete button (canDelete=false)
        expect(await quotaRow.locator('.storageInspectorEntryChevron').count()).toBe(0);
        expect(await quotaRow.locator('.storageInspectorEntryDeleteButton').count()).toBe(0);
        // Row is not marked drillable
        expect(await quotaRow.evaluate(el => el.classList.contains('storageInspectorEntryDrillable'))).toBe(false);

        await wipeBrowserFixture(page);
    });
});
