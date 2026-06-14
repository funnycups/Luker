// #7 — Delete-from-here (truncate). After 4 turns, /cut a range from
// turn 2 onward — only first turn remains.
//
// /cut accepts a range like "3-12" (inclusive). We compute the indices
// of the second user turn through the end of chat and cut that range.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName, sendMessageAndAwaitReply, getChatSnapshot } from '../_lib/page.js';

const REPLIES = [
    '*Seraphina nods.* "Reply A — keep going."',
    '*Seraphina taps the chart.* "Reply B — and now the second line."',
    '*Seraphina exhales.* "Reply C — the third question is the right one."',
    '*Seraphina smiles wryly.* "Reply D — we have run out of charts."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'truncate-from-here' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#7 — delete-from-here truncate', () => {
    test('truncating from turn 2 leaves only first turn after restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn 1 user: walk me through the eastern stretch.');
        await sendMessageAndAwaitReply(page, 'Turn 2 user: now the western.');
        await sendMessageAndAwaitReply(page, 'Turn 3 user: and the deeps.');
        await sendMessageAndAwaitReply(page, 'Turn 4 user: anything else worth noting?');

        const before = await getChatSnapshot(page);
        // Find the index of the second user message (turn 2).
        const userIdxs = before.messages.map((m, i) => ({ i, m })).filter(({ m }) => m.is_user).map(({ i }) => i);
        expect(userIdxs.length).toBe(4);
        const truncateStart = userIdxs[1];
        const truncateEnd = before.length - 1;

        await page.evaluate(async ({ from, to }) => {
            await window.Luker.getContext().executeSlashCommandsWithOptions(`/cut ${from}-${to}`);
        }, { from: truncateStart, to: truncateEnd });

        await page.waitForFunction(({ wantLen }) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.length === wantLen;
        }, { wantLen: truncateStart }, { timeout: 10_000 });
        await page.waitForTimeout(400);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 15_000 });

        const after = await getChatSnapshot(page);
        expect(after.length, `expected only greeting + turn 1 to remain; got ${JSON.stringify(after.messages.map(m => m.mes?.slice(0, 40)))}`)
            .toBe(truncateStart);
        // Turn 1 user/assistant present, turn 2/3/4 gone.
        expect(after.messages.some(m => m.is_user && /Turn 1 user/.test(m.mes || ''))).toBe(true);
        expect(after.messages.some(m => !m.is_user && /Reply A/.test(m.mes || ''))).toBe(true);
        for (const tag of ['Turn 2 user', 'Turn 3 user', 'Turn 4 user', 'Reply B', 'Reply C', 'Reply D']) {
            expect(after.messages.some(m => (m.mes || '').includes(tag)), `${tag} should be gone`).toBe(false);
        }
    });
});
