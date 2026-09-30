import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, sendMessageAndAwaitReply, openOptionsAndClick, closeRightNavDrawer } from '../_lib/page.js';
import { clickCharacterCard, dismissAnyPopup, openCharacterEditPanel, writeEmbeddedCharacter } from '../character/_helpers.js';
import { deleteSelectedCharacter } from '../_lib/ui-character.js';

let server, mock;

const ASH_NAME = 'Ash the Cartographer';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash sets the logbook down.* "The page is turned. Speak plainly."'] });
    server = await startServer({ batchKey: 'character', scenarioId: 'media-gc-delete' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    // A second card with the same display name → shared folder guard.
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'ash-copy.png' });

    const userRoot = resolve(server.dataRoot, 'default-user');
    mkdirSync(resolve(userRoot, 'user', 'images', ASH_NAME), { recursive: true });
    mkdirSync(resolve(userRoot, 'characters', ASH_NAME), { recursive: true });
    writeFileSync(resolve(userRoot, 'user', 'images', ASH_NAME, 'referenced.png'), Buffer.alloc(2_048));
    writeFileSync(resolve(userRoot, 'user', 'images', ASH_NAME, 'unreferenced.png'), Buffer.alloc(3_072));
    writeFileSync(resolve(userRoot, 'characters', ASH_NAME, 'happy.png'), Buffer.alloc(1_024));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('character delete with a same-name card keeps shared folders and lists chat references', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    // Two cards share the display name; target the original by its avatar.
    await clickCharacterCard(page, { avatar: 'ash-the-cartographer.png' });
    await closeRightNavDrawer(page);
    await sendMessageAndAwaitReply(page, 'Log the reef before the lantern dies.');

    const { chatId, avatarDir } = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return {
            chatId: ctx.getCurrentChatId(),
            avatarDir: String(ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, ''),
        };
    });
    const chatPath = resolve(server.dataRoot, 'default-user', 'chats', avatarDir, `${chatId}.jsonl`);
    await expect.poll(() => existsSync(chatPath) && readFileSync(chatPath, 'utf8').includes('Log the reef'), { timeout: 15_000 }).toBe(true);

    // Embed a reference to one gallery file in the saved message.
    const lines = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    last.mes = `${last.mes}\n<img src="/user/images/${ASH_NAME}/referenced.png" alt="e2e">`;
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(chatPath, lines.join('\n') + '\n');

    // Close the chat, then delete the card through the real panel.
    await openOptionsAndClick(page, 'option_close_chat');
    await clickCharacterCard(page, { avatar: 'ash-the-cartographer.png' });
    await dismissAnyPopup(page);
    await openCharacterEditPanel(page);
    await deleteSelectedCharacter(page);

    const dialog = page.locator('.mediaDeletionDialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.mediaDeletionNotes')).toContainText('shared');
    await expect(dialog.locator('.mediaDeletionItemCheckbox')).toHaveCount(1);
    await expect(dialog.locator('.mediaDeletionItemCheckbox[data-path$="referenced.png"]')).toBeVisible();
    await page.locator('.mediaDeletionConfirm').click();

    const userRoot = resolve(server.dataRoot, 'default-user');
    await expect.poll(() => existsSync(resolve(userRoot, 'user', 'images', ASH_NAME, 'referenced.png')), { timeout: 15_000 }).toBe(false);
    expect(existsSync(resolve(userRoot, 'user', 'images', ASH_NAME, 'unreferenced.png'))).toBe(true);
    expect(existsSync(resolve(userRoot, 'characters', ASH_NAME, 'happy.png'))).toBe(true);
    expect(existsSync(resolve(userRoot, 'characters', 'ash-copy.png'))).toBe(true);
});

test('character delete without associated media keeps the plain confirm flow', async ({ page }) => {
    const userRoot = resolve(server.dataRoot, 'default-user');
    const cardPath = resolve(userRoot, 'characters', 'bryn.png');
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'bryn.png', overrides: { name: 'Bryn the Watcher' } });

    await awaitMainUI(page, server.baseURL);
    await clickCharacterCard(page, 'Bryn the Watcher');
    await dismissAnyPopup(page);
    await openCharacterEditPanel(page);
    await deleteSelectedCharacter(page);

    await expect.poll(() => existsSync(cardPath), { timeout: 15_000 }).toBe(false);
    await expect(page.locator('.mediaDeletionDialog')).toHaveCount(0);
});
