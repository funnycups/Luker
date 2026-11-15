// #142 — A refused chat rename must tell the user why.
//
// Bug shape: POST /api/chats/rename answered every refusal with a bare
// status code, and renameGroupOrCharacterChat discarded it and showed the
// same sentence every time ("An error has occurred. Chat was not renamed.").
// The user could not tell a name collision from a stale chat list from a
// read-only storage back end.
//
// Real-user flow locked here: two chats on one character, the welcome
// screen's rename pencil aimed at an occupied name → the failure popup
// names the collision, the success toast stays silent, and both
// conversations keep their names.

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

const AVATAR = 'ash-the-cartographer.png';
const OCCUPIED = 'First Watch';
const EDITING = 'Second Watch';

let server;

/**
 * Write one chat as `[header, ...messages]` JSONL — the storage shape the
 * chat list and the rename route read.
 * @param {string} name Extensionless chat name
 * @param {string} greeting First assistant line
 */
function seedChat(name, greeting) {
    const directory = path.join(server.dataRoot, 'default-user', 'chats', AVATAR.replace(/\.png$/, ''));
    fs.mkdirSync(directory, { recursive: true });
    const lines = [
        { user_name: 'User', character_name: 'Ash the Cartographer', create_date: '2026-10-01@10h00m00s', chat_metadata: {} },
        { name: 'Ash the Cartographer', is_user: false, mes: greeting, send_date: '2026-10-01@10h00m01s' },
        { name: 'User', is_user: true, mes: 'The western marker holds.', send_date: '2026-10-01@10h00m02s' },
    ];
    fs.writeFileSync(path.join(directory, `${name}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'regression', scenarioId: 'chat-rename-failure-reason' });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR });
    seedChat(OCCUPIED, 'Ash taps the first marker on the inked coastline.');
    seedChat(EDITING, 'Ash unrolls the second chart beside the lantern.');
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#142 — refused chat rename names its reason', () => {
    test('renaming onto an occupied name explains the collision', async ({ page }) => {
        test.setTimeout(120_000);
        await awaitMainUI(page, server.baseURL);

        const welcome = page.locator('.welcomePanel');
        await welcome.waitFor({ state: 'visible', timeout: 20_000 });
        const editingRow = welcome.locator(`.recentChat[data-file=${JSON.stringify(EDITING)}]`);
        await expect(editingRow).toHaveCount(1, { timeout: 20_000 });

        await editingRow.locator('.renameChat').click();
        const dialog = page.locator('dialog.popup[open]').last();
        await dialog.locator('.popup-input').waitFor({ state: 'visible', timeout: 5_000 });
        await dialog.locator('.popup-input').fill(OCCUPIED);
        const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/rename');
        await dialog.locator('.popup-button-ok').click();

        const response = await answered;
        expect(response.status()).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'target_name_exists' });

        const failure = page.locator('dialog.popup[open]', { hasText: 'Chat was not renamed' });
        await expect(failure).toBeVisible({ timeout: 10_000 });
        await expect(failure).toContainText('already exists');
        await failure.locator('.popup-button-ok').click();

        // A refusal must not be dressed up as success.
        await expect(page.locator('.toast-success', { hasText: 'Chat renamed' })).toHaveCount(0);
        // Both conversations keep their names.
        await expect(welcome.locator(`.recentChat[data-file=${JSON.stringify(EDITING)}]`)).toHaveCount(1);
        await expect(welcome.locator(`.recentChat[data-file=${JSON.stringify(OCCUPIED)}]`)).toHaveCount(1);
    });
});
