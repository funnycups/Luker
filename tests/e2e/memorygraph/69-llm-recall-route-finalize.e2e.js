// tests/e2e/memorygraph/69-llm-recall-route-finalize.e2e.js
//
// #69 — LLM recall forces its route and finalize functions.
//
// Real-user flow:
//   1. Enable MG, turn auto extraction off, pick LLM recall and set the
//      recent-turn exclusion window to 0 — all through the settings panel.
//   2. Send two RP turns, then import four seeded nodes (Bind Latest).
//   3. Send a third turn. The mock answers the route call with `drill`
//      (no expansion → stagnation) and the finalize call with n_1.
//
// Pins:
//   - exactly one route request and one finalize request, each exposing
//     only its own function and forcing it via tool_choice;
//   - lastRecallTrace records plan_pass_1 → drill_stagnated_1 →
//     finalize_pass with the finalize selection;
//   - the selected node reaches the main-generation prompt.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { importMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import {
    ROUTE_TOOL,
    FINALIZE_TOOL,
    RECALL_SEED_RECORDS,
    toolNamesOf,
    chatCompletionRecords,
    recordsWithTool,
    writeSeedGraphFile,
    readMemoryGraphState,
} from './_runner-helpers.js';

const TURNS = [
    'I climb to the watchpost with the new tide table tucked under my coat.',
    'The marker buoys look wrong from up here — further east than your chart says.',
    'Who could guide a skiff across that shelf in the dark?',
];

const REPLIES = [
    '*Ash sets the lantern on the sill and checks the tide table twice.* "Slack water within the hour. We wait."',
    '*Ash traces the kelp shelf on the chart with one ink-dark finger.* "Then someone has to re-sound the channel before dawn."',
    '*Ash nods toward the black water below the rail.* "Maelis took a skiff through there last spring without scraping the hull once."',
];

let server, mock, seedPath;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [...REPLIES] });
    server = await startServer({ scope, batchKey: 'memorygraph', scenarioId: 'llm-recall-route-finalize' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot });
    seedPath = await writeSeedGraphFile(scope, RECALL_SEED_RECORDS, 'mg-llm-recall-');

    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes(ROUTE_TOOL)) {
            return {
                tool: ROUTE_TOOL,
                arguments: {
                    action: 'drill',
                    selected_node_ids: [],
                    expand_plan: [],
                    reason: 'The pilot question needs the full candidate rows.',
                },
            };
        }
        if (names.includes(FINALIZE_TOOL)) {
            return {
                tool: FINALIZE_TOOL,
                arguments: {
                    selected_node_ids: ['n_1'],
                    reason: 'Maelis is the pilot who knows the shelf.',
                },
            };
        }
        return null;
    });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#69 — LLM recall route and finalize force their function', () => {
    test.setTimeout(240_000);

    test('route and finalize send a forced tool_choice and the trace records both passes', async ({ page }) => {
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
            return state.nodes.map(node => node.id).sort().join(',');
        }, { timeout: 15_000 }).toBe('n_1,n_2,n_3,n_4');

        const before = mock.requests.length;
        await sendMessageAndAwaitReply(page, TURNS[2]);

        const routeRequests = recordsWithTool(mock, ROUTE_TOOL, before);
        const finalizeRequests = recordsWithTool(mock, FINALIZE_TOOL, before);
        expect(routeRequests, 'one route request, no retry').toHaveLength(1);
        expect(finalizeRequests, 'one finalize request, no retry').toHaveLength(1);

        expect(toolNamesOf(routeRequests[0].body)).toEqual([ROUTE_TOOL]);
        expect(routeRequests[0].body.tool_choice).toEqual({ type: 'function', function: { name: ROUTE_TOOL } });
        expect(toolNamesOf(finalizeRequests[0].body)).toEqual([FINALIZE_TOOL]);
        expect(finalizeRequests[0].body.tool_choice).toEqual({ type: 'function', function: { name: FINALIZE_TOOL } });

        const { lastRecallTrace } = await readMemoryGraphState(page);
        const steps = lastRecallTrace.map(step => step.step);
        const expectedOrder = ['plan_pass_1', 'expand_from_plan_1', 'drill_stagnated_1', 'finalize_pass'];
        expect(steps).toEqual(expect.arrayContaining(expectedOrder));
        const positions = expectedOrder.map(step => steps.indexOf(step));
        for (let i = 1; i < positions.length; i += 1) {
            expect(positions[i], `${expectedOrder[i]} must follow ${expectedOrder[i - 1]}`).toBeGreaterThan(positions[i - 1]);
        }
        const plan = lastRecallTrace.find(step => step.step === 'plan_pass_1');
        expect(plan.route.action).toBe('drill');
        expect(plan.stage1_candidates).toContain('n_1');
        const finalize = lastRecallTrace.find(step => step.step === 'finalize_pass');
        expect(finalize.selected_ids).toEqual(['n_1']);

        const mainGeneration = chatCompletionRecords(mock, before)
            .filter(record => record.receivedAt >= finalizeRequests[0].receivedAt)
            .filter(record => !toolNamesOf(record.body).some(name => name.startsWith('luker_rpg_')));
        expect(mainGeneration.length, 'the reply request follows recall').toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(mainGeneration[mainGeneration.length - 1].body.messages)).toContain('Maelis Brine-Ward');
    });
});
