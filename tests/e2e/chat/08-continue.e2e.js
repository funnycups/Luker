// #8 — Continue should extend the existing last assistant message
// rather than spawn a new one. Real user clicks the Continue option in
// the options dropdown (#mes_continue / #option_continue → Generate
// ('continue', ...)). We assert chat.length is unchanged and the
// rendered .mes_text grew.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    continueViaUI,
    getChatSnapshot,
} from '../_lib/page.js';

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

test.describe('#8 — Continue extends last message', () => {
    test('Continue from options dropdown appends to last assistant message in place', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, { timeout: 10_000 }).catch(() => {});

        const { replyId } = await sendMessageAndAwaitReply(page, 'Trace the path for me, slowly.');
        const beforeCount = await page.locator('#chat .mes').count();
        const beforeRendered = await page.locator(`.mes[mesid="${replyId}"] .mes_text`).innerText();
        expect(beforeRendered.length).toBeGreaterThan(0);
        expect(beforeRendered).toContain('path bends');

        // Real user gesture: open #options dropdown, click #option_continue.
        await continueViaUI(page);
        await page.waitForTimeout(400);

        // DOM-side primary assertion: chat length unchanged, last message
        // body grew and contains both fragments.
        const afterCount = await page.locator('#chat .mes').count();
        expect(afterCount, `chat length should NOT grow on Continue; before=${beforeCount}, after=${afterCount}`).toBe(beforeCount);
        const afterRendered = await page.locator(`.mes[mesid="${replyId}"] .mes_text`).innerText();
        expect(afterRendered.length, 'last assistant message should grow on Continue').toBeGreaterThan(beforeRendered.length);
        expect(afterRendered).toContain('path bends');
        expect(afterRendered).toContain('headland');

        // Secondary ctx.chat check.
        const afterSnap = await getChatSnapshot(page);
        expect(afterSnap.messages[replyId].mes).toContain('path bends');
        expect(afterSnap.messages[replyId].mes).toContain('headland');
    });
});
