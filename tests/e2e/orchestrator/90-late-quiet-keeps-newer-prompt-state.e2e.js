// Case #90 — a quiet generation that shares a director run and settles
// after the run leaves a newer generation's prompt state alone.
//
// The director run's finalize call is held in the mock LLM while a
// background Auto-select quiet generation shares the run; its request
// is held too. The run is released and finishes. `/gen` with a stop
// string is then sent from the chat input box, and that generation's server
// ping is held, so the generation is mid-way between setting its stop
// string and sending its request. The shared quiet generation is
// released and settles in that window. The `/gen` request must still
// carry the stop string.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageViaUI,
    closeAnyOpenTopSettingsDrawer,
    getChatSnapshot,
} from '../_lib/page.js';
import { installMinimalDirectorProfile } from '../_lib/ui-orchestrator.js';

const HELD_REPLY =
    '*Ash marks the last channel on the chart with a thumbnail crease.*\n\n'
    + '"That one floods first. We wait for the second bell before we cross."';
const GEN_PROMPT = 'Name the next tide in one word.';
const GEN_STOP = 'ZQX';

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

function lastPersistedAssistantText(chatId) {
    const last = readChatFileMessages(chatId).at(-1);
    return last && !last.is_user ? String(last.mes || '').trim() : '';
}

function findGenRequest() {
    return mock.requests.find(r => r.url.includes('/chat/completions')
        && JSON.stringify(r.body?.messages || []).includes(GEN_PROMPT));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '90-quiet-late-settle' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#90 — late-settling shared quiet generation', () => {
    test('a /gen started after the run keeps its stop string', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await installMinimalDirectorProfile(page);

        let markFinalizeRequested;
        const finalizeRequested = new Promise((resolve) => { markFinalizeRequested = resolve; });
        let releaseFinalize;
        const finalizeReleased = new Promise((resolve) => { releaseFinalize = resolve; });
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role !== 'director-main') return null;
                if (turn === 0) return { tool: 'write_message', arguments: { text: HELD_REPLY, mode: 'replace' } };
                if (turn === 1) {
                    markFinalizeRequested();
                    return finalizeReleased.then(() => ({ tool: 'finalize', arguments: {} }));
                }
                return null;
            },
        });

        await sendMessageViaUI(page, '*I lean over the chart.* "Which channel floods first?"');
        await finalizeRequested;
        const chatId = (await getChatSnapshot(page)).chatId;

        // The shared quiet generation: Auto-select, request held.
        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#backgrounds-drawer-toggle').click();
        await expect(page.locator('#Backgrounds')).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
        const quietHold = mock.holdNextQueuedRequest();
        mock.scriptReply('bedroom red');
        mock.scriptReply('Spring');
        await page.locator('#auto_background').click();
        await quietHold.requested;

        releaseFinalize();
        await expect.poll(() => lastPersistedAssistantText(chatId), { timeout: 30_000 }).toBe(HELD_REPLY.trim());
        await expect(page.locator('#mes_stop')).toBeHidden();

        // /gen sent from the chat input box, held at its server ping. The
        // slash command runs before the send turn reaches its own ping.
        let markPingHeld;
        const pingHeld = new Promise((resolve) => { markPingHeld = resolve; });
        await page.route('**/api/ping', (route) => { markPingHeld(route); });
        await sendMessageViaUI(page, `/gen stop=${JSON.stringify([GEN_STOP])} ${GEN_PROMPT}`);
        const heldPing = await pingHeld;

        quietHold.release();
        await expect(page.locator('#bg_menu_content .bg_example[bgfile="bedroom red.jpg"]'))
            .toHaveClass(/\bselected-background\b/, { timeout: 30_000 });

        await heldPing.continue();
        await page.unroute('**/api/ping');
        await expect.poll(() => Boolean(findGenRequest()), { timeout: 30_000 }).toBe(true);
        expect(findGenRequest().body.stop).toContain(GEN_STOP);
    });
});
