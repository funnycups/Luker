// #7 — Delete-from-here (truncate). After 4 turns, delete the turn-2
// user message AND every assistant/user message after it via the .mes_edit
// pencil flow, leaving only turn-1.
//
// Real-user flow: iterate from the LAST message backwards down to the
// turn-2 user message, clicking the .mes_edit → .mes_edit_delete on each.
// Bottom-up order matters because deleting a middle message renumbers
// the mesids of everything below it; deleting from the top would land
// on the wrong message.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getChatSnapshot,
    getRenderedChatTexts,
    deleteMessageViaUI,
} from '../_lib/page.js';

const REPLIES = [
    '*Seraphina nods.* "Reply A — keep going."',
    '*Seraphina taps the chart.* "Reply B — and now the second line."',
    '*Seraphina exhales.* "Reply C — the third question is the right one."',
    '*Seraphina smiles wryly.* "Reply D — we have run out of charts."',
];

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ scope, batchKey: 'chat', scenarioId: 'truncate-from-here' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#7 — delete-from-here truncate', () => {
    test('deleting turn-2 onward via pencil leaves only turn-1 after restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        await sendMessageAndAwaitReply(page, 'Turn 1 user: walk me through the eastern stretch.');
        await sendMessageAndAwaitReply(page, 'Turn 2 user: now the western.');
        await sendMessageAndAwaitReply(page, 'Turn 3 user: and the deeps.');
        await sendMessageAndAwaitReply(page, 'Turn 4 user: anything else worth noting?');

        const renderedBefore = await getRenderedChatTexts(page);
        // First message with "Turn 2 user" is the truncation anchor.
        const truncateStart = renderedBefore.findIndex(t => /Turn 2 user/.test(t || ''));
        expect(truncateStart).toBeGreaterThanOrEqual(0);
        const lenBefore = renderedBefore.length;

        // Delete from the END down to truncateStart (inclusive) using the
        // pencil. After each delete the indices below shift, but indices
        // at or above the deleted id are unaffected when deleting the
        // last bubble — so deleting `lenBefore-1`, then `lenBefore-2`,
        // ..., down to `truncateStart` reaches every message.
        for (let id = lenBefore - 1; id >= truncateStart; id--) {
            await deleteMessageViaUI(page, id);
            await page.waitForFunction(({ wantLen }) => {
                return document.querySelectorAll('#chat .mes').length === wantLen;
            }, { wantLen: id }, { timeout: 10_000 });
        }

        await page.waitForTimeout(400);

        // DOM-side: only greeting + turn 1 remain.
        const renderedAfter = await getRenderedChatTexts(page);
        expect(renderedAfter).toHaveLength(truncateStart);
        expect(renderedAfter.some(t => /Turn 1 user/.test(t))).toBe(true);
        expect(renderedAfter.some(t => /Reply A/.test(t))).toBe(true);
        for (const tag of ['Turn 2 user', 'Turn 3 user', 'Turn 4 user', 'Reply B', 'Reply C', 'Reply D']) {
            expect(renderedAfter.some(t => t.includes(tag)), `${tag} should be gone`).toBe(false);
        }

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 15_000 });

        // Post-restart: same DOM state.
        const renderedRestored = await getRenderedChatTexts(page);
        expect(renderedRestored, `expected only greeting + turn 1 to remain; got ${JSON.stringify(renderedRestored.map(t => t?.slice(0, 40)))}`)
            .toHaveLength(truncateStart);
        expect(renderedRestored.some(t => /Turn 1 user/.test(t))).toBe(true);
        expect(renderedRestored.some(t => /Reply A/.test(t))).toBe(true);

        // Secondary ctx.chat structural check.
        const after = await getChatSnapshot(page);
        expect(after).toHaveLength(truncateStart);
        for (const tag of ['Turn 2 user', 'Turn 3 user', 'Turn 4 user', 'Reply B', 'Reply C', 'Reply D']) {
            expect(after.messages.some(m => (m.mes || '').includes(tag)), `${tag} should be gone from ctx.chat`).toBe(false);
        }
    });
});
