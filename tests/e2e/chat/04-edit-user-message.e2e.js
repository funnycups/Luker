// #4 — Edit a user message → persist across restart.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, editMessageById, getChatSnapshot } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina sets the chart aside and looks at you.* "The wind has shifted. We will walk the outer line in an hour."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'edit-user' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#4 — edit user message', () => {
    test('edited user text persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'I will take the outer line at dawn.');

        const before = await getChatSnapshot(page);
        const userIdx = before.messages.findIndex(m => m.is_user && /outer line/.test(m.mes || ''));
        expect(userIdx).toBeGreaterThanOrEqual(0);
        const newText = 'I will take the inner line at dawn — the outer one is gutted by the slow swallow.';
        await editMessageById(page, userIdx, newText);

        // Wait for save round-trip (saveChat is debounced).
        await page.waitForFunction(({ idx, want }) => {
            const ctx = window.Luker.getContext();
            return ctx.chat[idx]?.mes === want;
        }, { idx: userIdx, want: newText }, { timeout: 10_000 });
        // Force a synchronous saveChat round-trip — editMessageById's
        // saveChat call is fire-and-forget. Then settle.
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
        const edited = after.messages.find(m => m.is_user && /inner line/.test(m.mes || ''));
        expect(edited, `edited text should be restored after restart; got ${JSON.stringify(after.messages)}`).toBeTruthy();
        expect(edited.mes).toBe(newText);
        // And the un-edited variant should be gone.
        const orig = after.messages.find(m => m.is_user && /outer line at dawn/.test(m.mes || '') && !/inner line/.test(m.mes || ''));
        expect(orig).toBeFalsy();
    });
});
