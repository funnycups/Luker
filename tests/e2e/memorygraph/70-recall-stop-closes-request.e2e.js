// tests/e2e/memorygraph/70-recall-stop-closes-request.e2e.js
//
// #70 — the recall toast's Stop button cancels an in-flight recall request.
//
// Real-user flow:
//   1. Same setup as #69 (MG on, auto extraction off, LLM recall, recent
//      exclusion 0, two turns, seeded nodes).
//   2. The mock holds every route request open for two minutes.
//   3. Send a third turn; once the route request is in flight, click the
//      toast's Stop button.
//
// Pins:
//   - the route request is closed by the client before any response byte;
//   - no retry and no finalize request follow;
//   - the panel status reads "Memory recall cancelled by user.";
//   - the main reply still generates.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { closeWorkbench } from '../_lib/ui-workbench.js';
import { importMgGraph, openMemoryWorkspace, setMgSettings } from '../_lib/ui-mg-varops.js';
import {
    ROUTE_TOOL,
    FINALIZE_TOOL,
    RECALL_SEED_RECORDS,
    RECALL_CANCELLED_STATUS,
    toolNamesOf,
    recordsWithTool,
    writeSeedGraphFile,
    readMemoryGraphState,
    memoryGraphStatus,
} from './_runner-helpers.js';

const TURNS = [
    'I bring the spare wick box up the ladder and set it beside the lantern.',
    'The fog bank has swallowed the third buoy entirely.',
    'Who was it that knew this channel blind?',
];

const REPLIES = [
    '*Ash lifts the lid and sniffs the coils.* "Dry. Good. The salt has not reached them yet."',
    '*Ash lowers her spyglass slowly.* "Then we read the water by sound tonight."',
    '*Ash taps the chart where the shelf drops away.* "We will chart it ourselves at first light, then."',
];

// Held long enough that only a client abort can end the request.
const ROUTE_HOLD_MS = 120_000;

let server, mock, seedPath;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [...REPLIES] });
    mock.setLatencyMs((_req, parsed) => (toolNamesOf(parsed).includes(ROUTE_TOOL) ? ROUTE_HOLD_MS : 0));
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'recall-stop-closes-request' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    seedPath = await writeSeedGraphFile(scope, RECALL_SEED_RECORDS, 'mg-recall-stop-');

    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes(ROUTE_TOOL)) {
            return { tool: ROUTE_TOOL, arguments: { action: 'finalize', selected_node_ids: ['n_1'], expand_plan: [], reason: 'Held route.' } };
        }
        if (names.includes(FINALIZE_TOOL)) {
            return { tool: FINALIZE_TOOL, arguments: { selected_node_ids: ['n_1'], reason: 'Unreachable after Stop.' } };
        }
        return null;
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#70 — Stop during recall closes the upstream request', () => {
    test.setTimeout(240_000);

    test('clicking Stop on the recall toast aborts the route request without retry', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        await setMgSettings(page, {
            enabled: true,
            autoExtractionEnabled: false,
            recallEnabled: true,
            recallMethod: 'llm',
        }, { closeAfter: true });

        await sendMessageAndAwaitReply(page, TURNS[0]);
        await sendMessageAndAwaitReply(page, TURNS[1]);

        await importMgGraph(page, seedPath, { mode: 'bind-latest', closeAfter: true });
        await expect.poll(async () => {
            const state = await readMemoryGraphState(page);
            return state.nodes.length;
        }, { timeout: 15_000 }).toBe(4);

        const before = mock.requests.length;
        const replyDone = sendMessageAndAwaitReply(page, TURNS[2], { timeoutMs: 180_000 });

        await expect.poll(() => recordsWithTool(mock, ROUTE_TOOL, before).length, { timeout: 60_000 }).toBe(1);
        const stopButton = page.locator('.toast .luker-toast-stop-button').first();
        await expect(stopButton).toBeVisible({ timeout: 10_000 });
        const stoppedAt = Date.now();
        await stopButton.click();

        await openMemoryWorkspace(page, { subview: 'settings' });
        await expect(memoryGraphStatus(page)).toHaveText(RECALL_CANCELLED_STATUS, { timeout: 10_000 });
        await closeWorkbench(page);
        await replyDone;

        const routeRecord = recordsWithTool(mock, ROUTE_TOOL, before)[0];
        await expect.poll(() => routeRecord.closedAt, { timeout: 10_000 }).not.toBeNull();
        expect(routeRecord.responseCompleted, 'closed by the client, not answered').toBe(false);
        expect(routeRecord.firstByteAt).toBeNull();
        expect(routeRecord.closedAt - stoppedAt).toBeGreaterThanOrEqual(0);
        expect(routeRecord.closedAt - stoppedAt).toBeLessThan(10_000);

        // The main reply completing establishes that the recall operation
        // settled and generation continued, rather than waiting a fixed delay.
        expect(recordsWithTool(mock, ROUTE_TOOL, before), 'no route retry after Stop').toHaveLength(1);
        expect(recordsWithTool(mock, FINALIZE_TOOL, before), 'no finalize after Stop').toHaveLength(0);
    });
});
