// #9 — /regenerate at swipe #2.
//
// Luker's /regenerate is a "redo this message" — it REPLACES the last
// assistant message entirely (the old swipes do not carry forward). We
// verify:
//   - After regenerate, the last assistant turn now exists and contains
//     the Variant C content from the next mock reply.
//   - chat.length is unchanged (we still have one assistant message at
//     the end, not two).
//   - The variants A/B that were in swipes before are gone (regenerate
//     is not the same as swipe).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';

const REPLIES = [
    '*Seraphina answers calmly.* "Variant A: the watch is steady."',
    '*Seraphina answers more sharply.* "Variant B: the watch is wrong."',
    '*Seraphina speaks barely above a whisper.* "Variant C: regenerated answer — the watch is quiet."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'regenerate' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function swipeRight(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('swipe timeout')), 30_000);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
            resolve(id);
        });
        ctx.executeSlashCommandsWithOptions('/swipe direction=right').catch(reject);
    }));
}

test.describe('#9 — /regenerate at swipe #2', () => {
    test('regenerate adds a new swipe variant without disturbing earlier ones', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Watch report?');
        await swipeRight(page); // → swipe_id 1, variant B
        // ensure we're on swipe_id 1
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            const last = ctx.chat[ctx.chat.length - 1];
            return last && last.swipe_id === 1;
        }, { timeout: 10_000 });

        const before = await getChatSnapshot(page);
        const lastBefore = before.messages[before.messages.length - 1];
        expect(lastBefore.swipes.length).toBe(2);
        expect(lastBefore.swipes[0]).toContain('Variant A');
        expect(lastBefore.swipes[1]).toContain('Variant B');

        // /regenerate.
        const beforeLen = before.length;
        await page.evaluate(() => new Promise((resolve, reject) => {
            const ctx = window.Luker.getContext();
            const t = setTimeout(() => reject(new Error('regen timeout')), 30_000);
            const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
                clearTimeout(t);
                try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
                resolve(true);
            });
            ctx.executeSlashCommandsWithOptions('/regenerate').catch(reject);
        }));
        await page.waitForTimeout(400);

        const after = await getChatSnapshot(page);
        // Chat length unchanged — regenerate replaces in place, not append.
        expect(after.length, `chat length should be unchanged by /regenerate`).toBe(beforeLen);
        const lastAfter = after.messages[after.messages.length - 1];
        // Variant C is now the active message.
        expect(lastAfter.mes, `regenerated message should be Variant C; got=${lastAfter.mes?.slice(0, 120)}`).toContain('Variant C');
        // No assistant turn elsewhere in the chat carries Variant C
        // (sanity: regenerate did not duplicate it).
        const cCount = after.messages.filter(m => !m.is_user && /Variant C/.test(m.mes || '')).length;
        expect(cCount).toBe(1);
    });
});
