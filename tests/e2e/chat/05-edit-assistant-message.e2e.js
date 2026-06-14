// #5 — Edit an assistant message → persist across restart.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, editMessageById, getChatSnapshot } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina speaks before you have finished the question.* "The reef has moved since last night — I do not trust the old chart any more."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'edit-asst' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#5 — edit assistant message', () => {
    test('edited assistant text persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const { replyId } = await sendMessageAndAwaitReply(page, 'How fresh is the chart you are working from?');
        expect(typeof replyId === 'number').toBe(true);

        const newText = '*Seraphina sets the brass spyglass down quietly.* "Edited reply: I no longer trust any chart older than four days on this stretch of coast."';
        await editMessageById(page, replyId, newText);
        await page.waitForFunction(({ id, want }) => {
            const ctx = window.Luker.getContext();
            return ctx.chat[id]?.mes === want;
        }, { id: replyId, want: newText }, { timeout: 10_000 });
        // editMessageById fires saveChat without awaiting — flush.
        await page.evaluate(async () => {
            await window.Luker.getContext().saveChat();
        });
        await page.waitForTimeout(800);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 2;
        }, { timeout: 15_000 });

        const after = await getChatSnapshot(page);
        const edited = after.messages.find(m => !m.is_user && /Edited reply/.test(m.mes || ''));
        expect(edited, `edited assistant text should survive restart; got ${JSON.stringify(after.messages.map(m => m.mes?.slice(0, 60)))}`).toBeTruthy();
        expect(edited.mes).toBe(newText);
        // Original wording should be gone (no untouched copy).
        const stale = after.messages.find(m => !m.is_user && /reef has moved/.test(m.mes || '') && !/Edited reply/.test(m.mes || ''));
        expect(stale).toBeFalsy();
    });
});
