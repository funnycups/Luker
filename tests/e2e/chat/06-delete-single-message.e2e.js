// #6 — Delete a single message via /cut <id>. After the cut, the chat
// should re-pack to the surrounding turns, and that delete persists.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';

const REPLIES = [
    '*Seraphina draws an X on the chart with a thumbnail.* "Reply 1: that line is gone since the spring tide."',
    '*Seraphina circles a small atoll.* "Reply 2: the rocks here are new, two days old at most."',
    '*Seraphina shrugs and smiles.* "Reply 3: the lantern will see us through the rest of the night."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'delete-single' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#6 — delete single message via /cut', () => {
    test('cutting a middle assistant message leaves the others intact across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn one: what is gone from the chart?');
        await sendMessageAndAwaitReply(page, 'Turn two: any new rocks?');
        await sendMessageAndAwaitReply(page, 'Turn three: how long will the lantern hold?');

        const before = await getChatSnapshot(page);
        // Find the 2nd assistant message (index of the second non-user item
        // after the greeting). The greeting is index 0 (assistant), so we
        // want the second user-reply assistant message.
        const asstIdsAll = before.messages.map((m, i) => ({ i, m })).filter(({ m }) => !m.is_user).map(({ i }) => i);
        // asstIdsAll[0] = greeting; [1] = reply to turn one; [2] = reply to two; [3] = reply to three
        const target = asstIdsAll[2];
        expect(typeof target === 'number').toBe(true);
        const targetText = before.messages[target].mes;
        expect(targetText).toContain('Reply 2');

        await page.evaluate(async (id) => {
            await window.Luker.getContext().executeSlashCommandsWithOptions(`/cut ${id}`);
        }, target);
        await page.waitForFunction(({ len }) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length === len;
        }, { len: before.length - 1 }, { timeout: 10_000 });
        await page.waitForTimeout(400);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 2;
        }, { timeout: 15_000 });

        const after = await getChatSnapshot(page);
        expect(after.length).toBe(before.length - 1);
        const stillThereCount = after.messages.filter(m => !m.is_user && /Reply 2/.test(m.mes || '')).length;
        expect(stillThereCount, 'cut message should be gone').toBe(0);
        // The other replies must still be present.
        expect(after.messages.some(m => !m.is_user && /Reply 1/.test(m.mes || ''))).toBe(true);
        expect(after.messages.some(m => !m.is_user && /Reply 3/.test(m.mes || ''))).toBe(true);
    });
});
