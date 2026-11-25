// #140 — a quiet generation that fails during a streaming reply leaves the
// reply stoppable.
//
// The reply streams and stalls mid-way in the mock LLM. The Backgrounds
// drawer's auto-select button then runs a quiet generation, and the mock
// answers its request with an error. Clicking Stop afterwards must still
// stop the stream: its upstream request closes, the partial reply is
// saved to the chat file and Send starts the next reply.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageViaUI,
    sendMessageAndAwaitReply,
    closeAnyOpenTopSettingsDrawer,
} from '../_lib/page.js';

const STREAMED_REPLY = '*Seraphina tilts the lantern toward the cliff path and squints into the dark* "Someone left the gate open again tonight."';
const NEXT_REPLY = '*Seraphina latches the gate behind you.* "There. Now nothing wanders in."';

let server, mock;

/**
 * Read the persisted messages of a chat file, without its header line.
 * @param {string} chatId
 * @returns {Array<{is_user?: boolean, mes?: string}>}
 */
function readChatFileMessages(chatId) {
    const file = resolve(server.dataRoot, 'default-user', 'chats', 'default_Seraphina', `${chatId}.jsonl`);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(1).map(line => JSON.parse(line));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '140-quiet-error-streaming' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: true });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#140 — failed quiet generation during a streaming reply', () => {
    test('Stop still stops the stream after the quiet generation failed', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Stream the first words of the reply, then stall.
        mock.scriptReply(STREAMED_REPLY);
        mock.setStreamStall({ afterChunks: 2, stallMs: 120_000 });
        const streamRequestIndex = mock.requests.length;
        await sendMessageViaUI(page, '*I hold the lantern higher.* "Do you see anything on the path?"');
        await expect(page.locator('#chat .last_mes .mes_text')).toContainText('Seraphina tilts', { timeout: 30_000 });
        const streamRecord = mock.requests.slice(streamRequestIndex).find(r => r.url.includes('/chat/completions'));
        expect(streamRecord).toBeTruthy();
        mock.setStreamStall({ afterChunks: -1, stallMs: 0 });

        // Auto-select a background; its quiet generation fails upstream.
        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#backgrounds-drawer-toggle').click();
        await expect(page.locator('#Backgrounds')).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
        const quietHold = mock.holdNextQueuedRequest();
        const quietErrors = [];
        const observeError = error => quietErrors.push(error.message);
        page.on('pageerror', observeError);
        await page.locator('#auto_background').click();
        const quietRecord = await quietHold.requested;
        quietHold.release({ status: 500, message: 'upstream overloaded' });
        await expect.poll(() => quietRecord.closedAt !== null && quietRecord.responseCompleted === true, { timeout: 30_000 }).toBe(true);
        // The async auto-select handler's rejection reaches the browser
        // only after its awaited quiet generation has unwound.
        try {
            await expect.poll(() => quietErrors.length, { timeout: 30_000 }).toBeGreaterThan(0);
        } finally {
            page.off('pageerror', observeError);
        }

        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#mes_stop').click();
        await expect.poll(() => streamRecord.closedAt !== null, { timeout: 30_000 }).toBe(true);
        expect(streamRecord.responseCompleted).toBe(false);
        await expect(page.locator('#mes_stop')).toBeHidden();
        const chatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
        await expect.poll(() => {
            const last = readChatFileMessages(chatId).at(-1);
            return last && !last.is_user ? String(last.mes || '') : '';
        }, { timeout: 30_000 }).toContain('Seraphina tilts');

        mock.scriptReply(NEXT_REPLY);
        const { text } = await sendMessageAndAwaitReply(page, '"Let us close it, then."', { timeoutMs: 60_000 });
        expect(text).toContain('latches the gate');
    });
});
