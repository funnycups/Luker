// #1 — Send first user turn → receive reply → restart server → both
// messages still present in chat history (in-memory + on-disk).
//
// Real-user flow: fill #send_textarea, click #send_but, assert against
// .mes_text DOM nodes. ctx.chat snapshot is the secondary cross-restart
// equality check; DOM is the primary assertion.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getChatSnapshot,
    getRenderedChatTexts,
} from '../_lib/page.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina lays her hand on the rail beside yours, eyes still on the dark water.* "The reef has been restless tonight, but the lantern still holds. We can keep moving."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'first-turn-persistence' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#1 — first-turn persistence', () => {
    test('chat survives server restart and reload', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for greeting to land so the message we care about isn't
        // mistaken for the first_mes echo. DOM-side: .mes count >= 1.
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const userText = 'I walked the cliff path. The wind is cold but the lantern holds and the path is clear.';
        const { replyId, text: replyText } = await sendMessageAndAwaitReply(page, userText);

        // DOM-side primary assertion: rendered .mes_text contains the
        // scripted reply (the actual bytes the user sees).
        expect(replyText).toMatch(/lantern|reef|moving/);
        const renderedBefore = await getRenderedChatTexts(page);
        expect(renderedBefore.some(t => t.includes('cliff path'))).toBe(true);
        expect(renderedBefore.some(t => /lantern|reef|moving/.test(t))).toBe(true);
        // Last rendered message must be the assistant reply at replyId.
        expect(renderedBefore[replyId]).toBe(replyText);

        // Secondary: ctx.chat snapshot for cross-restart structural equality.
        const before = await getChatSnapshot(page);
        expect(before.length).toBeGreaterThanOrEqual(2);
        const chatId = before.chatId;
        expect(chatId).toBeTruthy();

        // Avatar filename (minus .png) is the chat-folder name.
        const avatarFolder = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const c = ctx.characters[ctx.characterId];
            return (c?.avatar || '').replace(/\.png$/, '');
        });
        expect(avatarFolder).toBeTruthy();

        // The chat file should exist on disk under the avatar folder.
        const charChatsDir = resolve(server.dataRoot, 'default-user', 'chats', avatarFolder);
        const filesPreRestart = readdirSync(charChatsDir).filter(f => f.endsWith('.jsonl'));
        expect(filesPreRestart.length).toBeGreaterThanOrEqual(1);

        const jsonlPath = resolve(charChatsDir, `${chatId}.jsonl`);
        expect(existsSync(jsonlPath)).toBe(true);
        const preLines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
        // header + at least greeting + user + assistant => 4 lines
        expect(preLines.length).toBeGreaterThanOrEqual(4);
        const preLastUser = preLines.map(l => JSON.parse(l)).filter(o => o.is_user).pop();
        expect(preLastUser?.mes).toContain('cliff path');

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, { timeout: 15_000 });

        // After-restart DOM assertion.
        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter.some(t => /cliff path/.test(t))).toBe(true);
        expect(renderedAfter.some(t => /lantern|reef|moving/.test(t))).toBe(true);

        // Secondary ctx.chat check.
        const after = await getChatSnapshot(page);
        expect(after.chatId).toBe(chatId);
        expect(after.length).toBeGreaterThanOrEqual(before.length);
        const userMsg = after.messages.find(m => m.is_user && /cliff path/.test(m.mes || ''));
        const asstMsg = after.messages.find(m => !m.is_user && /lantern|reef|moving/.test(m.mes || ''));
        expect(userMsg, 'user message should be restored after restart').toBeTruthy();
        expect(asstMsg, 'assistant message should be restored after restart').toBeTruthy();
    });
});
