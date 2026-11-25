// Case #89 — a quiet generation that shares a director run's abort
// controller leaves the run's UI and send state to the run.
//
// The Backgrounds drawer's auto-select button runs a quiet generation.
// While the director's finalize call is held in the mock LLM:
//
//   - outlives the run: the quiet generation's server ping is held, the
//     director run is released and finishes, then the quiet generation
//     resumes and completes. Stop stays hidden and Send starts the next
//     turn. A second variant holds the quiet request at the mock instead
//     and releases it after the run finishes.
//   - Stop: with the quiet request held at the mock, clicking Stop closes
//     both upstream requests and the UI accepts the next turn.

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
    sendMessageAndAwaitReply,
    closeAnyOpenTopSettingsDrawer,
    getChatSnapshot,
} from '../_lib/page.js';
import { installMinimalDirectorProfile } from '../_lib/ui-orchestrator.js';

const HELD_REPLY =
    '*Ash rolls the map tight and binds it with a strip of sailcloth.*\n\n'
    + '"We leave the lantern here. Whoever watches the shore will think we never left."';
const NEXT_REPLY = '*Ash nods once and pulls the hood over her hair.* "Then we go now."';

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

/**
 * Script two director turns: the first writes HELD_REPLY and holds its
 * finalize until released, the second writes NEXT_REPLY and finalizes.
 */
function scriptHeldThenNextDirectorTurn() {
    let markFinalizeRequested;
    const finalizeRequested = new Promise((resolve) => { markFinalizeRequested = resolve; });
    let releaseFinalize;
    const finalizeReleased = new Promise((resolve) => { releaseFinalize = resolve; });
    let finalizeRecord = null;
    mock.scriptDirectorRun({
        route: ({ role, turn, record }) => {
            if (role !== 'director-main') return null;
            if (turn === 0) return { tool: 'write_message', arguments: { text: HELD_REPLY, mode: 'replace' } };
            if (turn === 1) {
                finalizeRecord = record;
                markFinalizeRequested();
                return finalizeReleased.then(() => ({ tool: 'finalize', arguments: {} }));
            }
            if (turn === 2) return { tool: 'write_message', arguments: { text: NEXT_REPLY, mode: 'replace' } };
            if (turn === 3) return { tool: 'finalize', arguments: {} };
            return null;
        },
    });
    return { finalizeRequested, releaseFinalize, getFinalizeRecord: () => finalizeRecord };
}

async function openBackgroundsDrawer(page) {
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#backgrounds-drawer-toggle').click();
    await expect(page.locator('#Backgrounds')).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
}

async function expectBackgroundSelected(page, background) {
    await expect(page.locator(`#bg_menu_content .bg_example[bgfile="${background}.jpg"]`))
        .toHaveClass(/\bselected-background\b/, { timeout: 30_000 });
}

/**
 * The UI is idle and Send starts the next director turn.
 */
async function expectSendStartsNextTurn(page) {
    await expect(page.locator('#mes_stop')).toBeHidden();
    await closeAnyOpenTopSettingsDrawer(page);
    const { replyId } = await sendMessageAndAwaitReply(page, '"Ready when you are."', { timeoutMs: 60_000 });
    const nextMes = await page.evaluate((id) => String(window.Luker.getContext().chat?.[id]?.mes ?? ''), replyId);
    expect(nextMes.trim()).toBe(NEXT_REPLY.trim());
}

async function startHeldDirectorTurn(page) {
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, 'Seraphina');
    await installMinimalDirectorProfile(page);
    const director = scriptHeldThenNextDirectorTurn();
    await sendMessageViaUI(page, '*I trace the coastline on the map with one finger.* "Which cove?"');
    await director.finalizeRequested;
    const chatId = (await getChatSnapshot(page)).chatId;
    return { director, chatId };
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope, batchKey: 'orchestrator', scenarioId: '89-quiet-outlives-run' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#89 — quiet generation sharing a director run', () => {
    test('a quiet generation resumed after the run finished leaves Send usable', async ({ page }) => {
        const { director, chatId } = await startHeldDirectorTurn(page);
        await openBackgroundsDrawer(page);

        // Hold the quiet generation's server ping, which it sends after
        // deciding to share the run's controller and before the request.
        let markPingHeld;
        const pingHeld = new Promise((resolve) => { markPingHeld = resolve; });
        await page.route('**/api/ping', (route) => { markPingHeld(route); });
        mock.scriptReply('bedroom red');
        await page.locator('#auto_background').click();
        const heldPing = await pingHeld;

        director.releaseFinalize();
        await expect.poll(() => lastPersistedAssistantText(chatId), { timeout: 30_000 }).toBe(HELD_REPLY.trim());
        await expect(page.locator('#mes_stop')).toBeHidden();

        await heldPing.continue();
        await page.unroute('**/api/ping');
        await expectBackgroundSelected(page, 'bedroom red');

        await expectSendStartsNextTurn(page);
    });

    test('a quiet request answered after the run finished leaves Send usable', async ({ page }) => {
        const { director, chatId } = await startHeldDirectorTurn(page);
        await openBackgroundsDrawer(page);

        const quietHold = mock.holdNextQueuedRequest();
        mock.scriptReply('bedroom clean');
        await page.locator('#auto_background').click();
        await quietHold.requested;

        director.releaseFinalize();
        await expect.poll(() => lastPersistedAssistantText(chatId), { timeout: 30_000 }).toBe(HELD_REPLY.trim());
        await expect(page.locator('#mes_stop')).toBeHidden();

        quietHold.release();
        await expectBackgroundSelected(page, 'bedroom clean');

        await expectSendStartsNextTurn(page);
    });

    test('Stop closes the run and the quiet request it shares a controller with', async ({ page }) => {
        const { director } = await startHeldDirectorTurn(page);
        await openBackgroundsDrawer(page);

        const quietHold = mock.holdNextQueuedRequest();
        await page.locator('#auto_background').click();
        const quietRecord = await quietHold.requested;
        const finalizeRecord = director.getFinalizeRecord();

        await closeAnyOpenTopSettingsDrawer(page);
        await page.locator('#mes_stop').click();

        await expect.poll(() => finalizeRecord.closedAt !== null && quietRecord.closedAt !== null, { timeout: 30_000 }).toBe(true);
        expect(finalizeRecord.responseCompleted).toBe(false);
        expect(quietRecord.responseCompleted).toBe(false);

        // Settle the held finalize so the next turn starts from a fresh
        // director turn counter.
        director.releaseFinalize();
        await expectSendStartsNextTurn(page);
    });
});
