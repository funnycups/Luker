import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, openOptionsAndClick, acceptTopmostPopup } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const ASH_NAME = 'Ash the Cartographer';

function appendImageToLastMessage(chatPath, imageUrl) {
    const lines = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean);
    const lastIndex = lines.length - 1;
    const message = JSON.parse(lines[lastIndex]);
    message.mes = `${message.mes}\n<img src="${imageUrl}" alt="e2e">`;
    lines[lastIndex] = JSON.stringify(message);
    writeFileSync(chatPath, lines.join('\n') + '\n');
}

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Ash logs the reading without looking up.* "Noted. The reef is quiet enough tonight."'] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'media-gc-delete' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test('chat delete offers preview with cancel, skip, and confirmed deletion', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, ASH_NAME);
    await sendMessageAndAwaitReply(page, 'Log tonight\'s tide reading.');

    const { chatId, avatarDir } = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return {
            chatId: ctx.getCurrentChatId(),
            avatarDir: String(ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, ''),
        };
    });
    expect(chatId).toBeTruthy();

    const chatPath = resolve(server.dataRoot, 'default-user', 'chats', avatarDir, `${chatId}.jsonl`);
    const imageUrl = `/user/images/${ASH_NAME}/first.png`;
    const imagePath = resolve(server.dataRoot, 'default-user', 'user', 'images', ASH_NAME, 'first.png');
    await expect.poll(() => existsSync(chatPath), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => readFileSync(chatPath, 'utf8').includes('Log tonight'), { timeout: 15_000 }).toBe(true);
    mkdirSync(resolve(server.dataRoot, 'default-user', 'user', 'images', ASH_NAME), { recursive: true });
    writeFileSync(imagePath, Buffer.alloc(2_048));
    appendImageToLastMessage(chatPath, imageUrl);

    // Cancel: dialog opens, chat + image stay.
    await openOptionsAndClick(page, 'option_close_chat');
    let row = page.locator(`.recentChat[data-file="${chatId}"]`);
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.locator('.deleteChat').click();
    await acceptTopmostPopup(page);
    await expect(page.locator('.mediaDeletionDialog')).toBeVisible();
    await page.locator('.mediaDeletionCancel').click();
    await expect(page.locator('.mediaDeletionDialog')).toBeHidden();
    expect(existsSync(chatPath)).toBe(true);
    expect(existsSync(imagePath)).toBe(true);

    // Skip: chat goes, image stays.
    row = page.locator(`.recentChat[data-file="${chatId}"]`);
    await row.locator('.deleteChat').click();
    await acceptTopmostPopup(page);
    await expect(page.locator('.mediaDeletionDialog')).toBeVisible();
    await page.locator('.mediaDeletionSkip').click();
    await expect.poll(() => existsSync(chatPath), { timeout: 15_000 }).toBe(false);
    expect(existsSync(imagePath)).toBe(true);

    // Confirmed deletion: second chat + second image both go.
    await selectCharacterByName(page, ASH_NAME);
    await sendMessageAndAwaitReply(page, 'One more reading before the watch ends.');
    const second = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return {
            chatId: ctx.getCurrentChatId(),
            avatarDir: String(ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, ''),
        };
    });
    const secondChatPath = resolve(server.dataRoot, 'default-user', 'chats', second.avatarDir, `${second.chatId}.jsonl`);
    const secondImageUrl = `/user/images/${ASH_NAME}/second.png`;
    const secondImagePath = resolve(server.dataRoot, 'default-user', 'user', 'images', ASH_NAME, 'second.png');
    await expect.poll(() => existsSync(secondChatPath) && readFileSync(secondChatPath, 'utf8').includes('One more reading'), { timeout: 15_000 }).toBe(true);
    writeFileSync(secondImagePath, Buffer.alloc(4_096));
    appendImageToLastMessage(secondChatPath, secondImageUrl);

    await openOptionsAndClick(page, 'option_close_chat');
    row = page.locator(`.recentChat[data-file="${second.chatId}"]`);
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.locator('.deleteChat').click();
    await acceptTopmostPopup(page);
    await expect(page.locator('.mediaDeletionDialog .mediaDeletionItemCheckbox')).toHaveCount(1);
    await page.locator('.mediaDeletionConfirm').click();
    await expect.poll(() => existsSync(secondChatPath), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => existsSync(secondImagePath), { timeout: 15_000 }).toBe(false);
});
