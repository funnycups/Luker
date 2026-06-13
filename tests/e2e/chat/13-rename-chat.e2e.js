// #13 — Rename chat via /renamechat.
// File on disk should be renamed; recent-chats index should reflect the
// new file_name.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
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

test.describe('#13 — rename chat', () => {
    test('/renamechat updates file on disk and recent-chat index', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Tell me when you will be ready.');

        const originalChatId = await page.evaluate(() => window.SillyTavern.getContext().getCurrentChatId());
        expect(originalChatId).toBeTruthy();

        const avatarFolder = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return (ctx.characters[ctx.characterId]?.avatar || '').replace(/\.png$/, '');
        });
        const chatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const filesBefore = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesBefore).toContain(`${originalChatId}.jsonl`);

        const newName = 'bryn-headland-night-watch';

        await page.evaluate(async (name) => {
            await window.SillyTavern.getContext().executeSlashCommandsWithOptions(`/renamechat ${name}`);
        }, newName);

        await page.waitForFunction((expected) => {
            return window.SillyTavern.getContext().getCurrentChatId() === expected;
        }, newName, { timeout: 15_000 });
        // small settle for the file rename + index refresh
        await page.waitForTimeout(800);

        const filesAfter = readdirSync(chatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesAfter, `disk rename should produce new filename; got ${JSON.stringify(filesAfter)}`)
            .toContain(`${newName}.jsonl`);
        expect(filesAfter, `original filename should be gone after rename`)
            .not.toContain(`${originalChatId}.jsonl`);

        // /api/chats/recent (recent-chats index) should reflect new name.
        const recent = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
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
