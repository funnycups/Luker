// #13 — Rename chat via the Manage Chat Files UI flow.
//
// Real-user gesture:
//   1. Open the options dropdown, click "Manage chat files"
//      (option_select_chat). This shows the past-chats popup, which
//      renders one .select_chat_block_wrapper per chat file with a
//      .renameChatButton pencil.
//   2. Click the .renameChatButton for the current chat. ST opens a
//      generic INPUT popup pre-filled with the old name.
//   3. Type the new name in the popup input and click OK.
//   4. ST renames the file on disk and refreshes the recent-chats index.
//
// File on disk should be renamed; recent-chats index should reflect the
// new file_name.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openOptionsAndClick,
} from '../_lib/page.js';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina cleans the spyglass with the heel of her palm.* "Reply 1: I will be ready when the wind drops."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'rename' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#13 — rename chat via Manage Chat Files UI', () => {
    test('clicking the pencil + entering a new name updates the file on disk and recent index', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Tell me when you will be ready.');

        const originalChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        expect(originalChatId).toBeTruthy();

        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const filesBefore = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesBefore).toContain(`${originalChatId}.jsonl`);

        const newName = 'bryn-headland-night-watch';

        // Real user gesture #1: open options → Manage Chat Files.
        await openOptionsAndClick(page, 'option_select_chat');
        // The past-chats popup renders the chat list. Wait for the row
        // wrapper that contains the current chat's filename.
        const row = page.locator('.select_chat_block_wrapper', { has: page.locator('.select_chat_block_filename', { hasText: originalChatId }) }).first();
        await row.waitFor({ state: 'visible', timeout: 10_000 });

        // Real user gesture #2: click the rename pencil. ST opens an
        // INPUT popup pre-filled with the old name.
        await row.locator('.renameChatButton').click();

        // Real user gesture #3: clear the pre-filled input, type new
        // name, click OK on the topmost popup.
        const popup = page.locator('dialog.popup[open]').last();
        const popupInput = popup.locator('.popup-input').last();
        await popupInput.waitFor({ state: 'visible', timeout: 5000 });
        await popupInput.fill(newName);
        await popup.locator('.popup-button-ok').click();

        // Wait for the chat to flip to the new name.
        await page.waitForFunction((expected) => {
            return window.Luker.getContext().getCurrentChatId() === expected;
        }, newName, { timeout: 15_000 });
        await page.waitForTimeout(800);

        // Disk-side check.
        const filesAfter = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesAfter, `disk rename should produce new filename; got ${JSON.stringify(filesAfter)}`)
            .toContain(`${newName}.jsonl`);
        expect(filesAfter, `original filename should be gone after rename`)
            .not.toContain(`${originalChatId}.jsonl`);

        // Recent-chats index should reflect the new name. This is a
        // server-side index assertion; we still fire it via a real fetch
        // from the page rather than reading the disk index directly so
        // we exercise the same endpoint the UI uses.
        const recent = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const res = await fetch('/api/chats/recent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ctx.getRequestHeaders?.()?.['X-CSRF-Token'] || '' },
                body: JSON.stringify({ pinned: [], max: 100 }),
            });
            if (!res.ok) return [];
            return res.json();
        });
        const renamedRecent = recent.find(r => r.file_name === `${newName}.jsonl` || r.file_name === newName);
        expect(renamedRecent, `recent-chats index should list renamed chat; got ${JSON.stringify(recent.map(r => r.file_name))}`).toBeTruthy();
    });
});
