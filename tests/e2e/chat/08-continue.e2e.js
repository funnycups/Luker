// #8 — /continue should extend the existing last assistant message
// rather than spawn a new one. We measure chat.length before vs after.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina starts to answer.* "The path bends —"',
        ' — and then opens onto the headland."',
    ] });
    server = await startServer({ batchKey: 'chat', scenarioId: 'continue' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#8 — /continue extends last message', () => {
    test('/continue appends to last assistant message in place', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        const { replyId } = await sendMessageAndAwaitReply(page, 'Trace the path for me, slowly.');
        const beforeSnap = await getChatSnapshot(page);
        const beforeLen = beforeSnap.length;
        const beforeMesLen = (beforeSnap.messages[replyId]?.mes || '').length;
        expect(beforeMesLen).toBeGreaterThan(0);

        // Fire /continue and wait for MESSAGE_RECEIVED (the continuation
        // emits the same event for the same message id).
        await page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('continue timeout')), 30_000);
            const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
                resolve(true);
            });
            ctx.executeSlashCommandsWithOptions('/continue').catch(reject);
        }));
        // small settle for save
        await page.waitForTimeout(400);

        const afterSnap = await getChatSnapshot(page);
        expect(afterSnap.length, `chat length should NOT grow on /continue; before=${beforeLen}, after=${afterSnap.length}`).toBe(beforeLen);
        const afterMesLen = (afterSnap.messages[replyId]?.mes || '').length;
        expect(afterMesLen, `last assistant message should grow on /continue`).toBeGreaterThan(beforeMesLen);
        // Final message should now contain both fragments.
        expect(afterSnap.messages[replyId].mes).toContain('path bends');
        expect(afterSnap.messages[replyId].mes).toContain('headland');
    });
});
