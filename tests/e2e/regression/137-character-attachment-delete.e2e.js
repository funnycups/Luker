// Deleting a character Data Bank attachment must persist its removal from
// settings, not just delete the file and hide its row until the next reload.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { openTopDrawer, closeTopDrawer } from '../_lib/page.js';
import { recordDirtyWrites, readUserFile, userRootOf } from '../_lib/sync.js';
import { writeCharacterPng } from '../groups/_helpers.js';

const ATTACHMENT = { url: '/user/files/glade-ledger.txt', name: 'Glade ledger.txt', size: 41, created: Date.parse('2026-10-01T10:00:00Z') };
let server;

test.use({ actionTimeout: 15_000 });

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'character-attachment-delete' });
    markOnboarded({ dataRoot: server.dataRoot });
    writeCharacterPng({ dataRoot: server.dataRoot, avatarFile: 'Seraphina.png', card: { name: 'Seraphina', first_mes: 'Welcome back to the glade.' } });
    const root = userRootOf(server);
    fs.mkdirSync(path.join(root, 'user', 'files'), { recursive: true });
    fs.writeFileSync(path.join(root, 'user', 'files', 'glade-ledger.txt'), 'The spring rises beneath the white stones.');
    const settings = JSON.parse(readUserFile(server, 'settings.json'));
    settings.extension_settings.character_attachments = { 'Seraphina.png': [ATTACHMENT] };
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function loadUI(page) {
    await page.goto(server.baseURL);
    await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext, null, { timeout: 60_000 });
}

async function openCharacterDataBank(page) {
    await openTopDrawer(page, 'rightNavHolder');
    await page.locator('#rm_button_characters').click();
    await page.locator('#rm_print_characters_block .character_select', { has: page.locator('.avatar[title$="File: Seraphina.png"]') }).click();
    await closeTopDrawer(page, 'rightNavHolder');
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#manageAttachments').click();
}

test('deleting a character attachment persists after reloading', async ({ page }) => {
    const writes = recordDirtyWrites(page);
    await loadUI(page);
    await openCharacterDataBank(page);
    const row = page.locator('.characterAttachmentsList .attachmentListItem', { hasText: ATTACHMENT.name });
    await row.waitFor({ state: 'visible' });
    const readyAt = Date.now();
    await expect.poll(() => writes.inFlight.size === 0 && Date.now() - Math.max(writes.at(-1)?.at ?? 0, writes.lastSentAt, readyAt) >= 2000,
        { timeout: 30_000, message: 'startup and character selection writes finish before deletion' }).toBe(true);

    await row.locator('.deleteAttachmentButton').click();
    await page.locator('dialog.popup[open]').last().locator('.popup-button-ok').click();
    await expect(row).toHaveCount(0);
    expect(fs.existsSync(path.join(userRootOf(server), 'user', 'files', 'glade-ledger.txt'))).toBe(false);
    await expect.poll(() => JSON.parse(readUserFile(server, 'settings.json')).extension_settings.character_attachments['Seraphina.png'],
        { timeout: 10_000, message: 'the deleted character attachment is removed from saved settings' }).toEqual([]);

    await loadUI(page);
    await openCharacterDataBank(page);
    await expect(page.locator('.characterAttachmentsList .attachmentListItem', { hasText: ATTACHMENT.name })).toHaveCount(0);
});
