// #53 — data-maid lazy category rendering.
//
// A scan report can contain thousands of loose items. The dialog must show
// every category header immediately and defer item DOM until the user
// expands a category, so opening a large report does not freeze the page.

import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

const ORPHAN_COUNT = 40;

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'server', scenarioId: 'data-maid-lazy' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function openUserSettingsDrawer(page) {
    const settingsDrawer = page.locator('#user-settings-button');
    await settingsDrawer.waitFor({ state: 'visible', timeout: 10_000 });
    const drawerClosed = await page.locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
    }
}

test('#53 — data-maid renders category items lazily', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);

    const userRoot = resolve(server.dataRoot, 'default-user');
    const charactersDir = resolve(userRoot, 'characters');
    const thumbsDir = resolve(userRoot, 'thumbnails', 'avatar');
    mkdirSync(thumbsDir, { recursive: true });

    // Orphan thumbnails: a thumbnail whose source character is gone.
    const realCharPng = readdirSync(charactersDir).find(f => f.endsWith('.png'));
    expect(realCharPng, 'no seed character PNG found').toBeTruthy();
    const realCharBytes = readFileSync(resolve(charactersDir, realCharPng));
    for (let i = 0; i < ORPHAN_COUNT; i++) {
        writeFileSync(resolve(thumbsDir, `orphan-lazy-${i}.png`), realCharBytes);
    }

    // Open User Settings → Miscellaneous → Clean-Up through the real UI.
    await openUserSettingsDrawer(page);
    const cleanUp = page.locator('#data_maid_button');
    await cleanUp.waitFor({ state: 'visible', timeout: 10_000 });
    await cleanUp.click();

    const dialog = page.locator('.dataMaidDialogContainer');
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.locator('.dataMaidStartButton').click();

    const category = page.locator('.dataMaidCategory', { hasText: 'Avatar Thumbnails' }).first();
    await category.waitFor({ state: 'visible', timeout: 60_000 });

    // The header reports the full count immediately, but item DOM is deferred.
    const headerCount = Number(await category.locator('.dataMaidCategoryInfo small').first().innerText());
    expect(headerCount).toBeGreaterThanOrEqual(ORPHAN_COUNT);
    await expect(category.locator('.dataMaidItem')).toHaveCount(0);

    // Expanding the category builds the item list.
    await category.locator('.inline-drawer-toggle').click();
    await expect(category.locator('.dataMaidItem')).toHaveCount(headerCount);

    // Delegated actions still work on lazily rendered items.
    await category.locator('.dataMaidItemView').first().click();
    const preview = page.locator('.popup:visible .popup-content > img.dataMaidImageView');
    await preview.waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
});
