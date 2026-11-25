// #102 — CEA editor iter-studio: `simulate_prompt` runs a real non-persisted
// generation, opens the simulation review, and returns the review envelope as
// the tool result. A cancelled review is still a successful tool call.
//
// Per call the mock LLM serves three requests: the editor round that emits the
// tool call, the quiet generation the simulator runs, and the follow-up editor
// round that receives the tool result (plain-text echo ends the loop).

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

const SIM_TURN = 'I ask Seraphina whether the Shadowfangs will follow us past the river stones.';
const SIM_REPLY = '*Seraphina lifts her lantern toward the glade path, her voice low.* "They never cross the river stones. Stay close, and keep your blade sheathed until I say otherwise."';

let server, mock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '102-cea-simulate-prompt',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {

    await mock?.stop();
});

/** Read the complete result through the actual expanded Workbench trace. */
async function readLastResult(page) {
    const trace = page.locator('.wbench .wb-tool-trace').last();
    await trace.locator('> summary').click();
    const call = trace.locator('.wb-tool-entry', { has: page.locator('.wb-tool-name', { hasText: 'simulate_prompt' }) });
    await expect(call.locator('.is-error')).toHaveCount(0);
    const result = call.locator('pre:last-child');
    await expect(result).toBeVisible();
    return result.textContent();
}

function ceaEditorRequests() {
    return mock.requests.filter((r) => String(r.url || '').includes('chat/completions')
        && (Array.isArray(r.body?.tools) ? r.body.tools : [])
            .some((t) => String(t?.function?.name || '') === 'simulate_prompt'));
}

function lastToolMessage(request) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    return messages.filter((m) => m?.role === 'tool').pop() || null;
}

/** Send one editor turn whose model reply calls simulate_prompt, then act on the review popup. */
async function simulateAndDecide(page, decision) {
    mock.scriptToolCall({ name: 'simulate_prompt', arguments: { text: SIM_TURN } });
    mock.scriptReply(SIM_REPLY);

    const editor = page.locator('.wbench .wb-win');
    await sendIterPrompt(page, 'cea', 'Simulate how Seraphina answers a question about the Shadowfangs.', { waitForSettle: false });

    const review = page.locator('dialog.popup[open]', { has: page.locator('.luker-sim-review-wrapper') }).last();
    await review.waitFor({ state: 'visible', timeout: 60_000 });
    await expect(review).toContainText(SIM_REPLY);
    await review.locator(decision === 'submit' ? '.popup-button-ok' : '.popup-button-cancel').first().click();
    await review.waitFor({ state: 'detached', timeout: 10_000 });

    await expect(editor.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 60_000 });
    await expect(editor.locator('.wb-msg-ai')).toHaveCount(1);
}

test.describe.configure({ mode: 'serial' });

test.describe('#102 — CEA editor simulate_prompt result', () => {
    test('failed real simulation returns a failed tool result', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');
        mock.scriptToolCall({ name: 'simulate_prompt', arguments: { text: SIM_TURN } });
        mock.scriptReply('The simulation could not be completed.');
        const editor = page.locator('.wbench .wb-win');
        await editor.locator('.wb-chat .wb-input').fill('Show how the forest guardian answers at the river.');
        const hold = mock.holdNextQueuedRequest();
        await editor.locator('.wb-chat .wb-send').click();
        await hold.requested;
        const simulationHold = mock.holdNextQueuedRequest();
        hold.release();
        await simulationHold.requested;
        simulationHold.release({ status: 500, message: 'simulation upstream failure' });
        await expect.poll(() => {
            const result = lastToolMessage(ceaEditorRequests().at(-1));
            if (!result) return null;
            return typeof JSON.parse(result.content).error;
        }, { timeout: 60_000 }).toBe('string');
        await closeIterStudio(page);
    });
    test('submitted review: the trace displays the complete result the model receives', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');

        const requestsBefore = mock.requests.length;
        await simulateAndDecide(page, 'submit');

        // The simulator ran a real generation: a chat request outside the
        // editor's tool catalog was served between the two editor rounds.
        const served = mock.requests.slice(requestsBefore)
            .filter((r) => String(r.url || '').includes('chat/completions'));
        expect(served.some((r) => !(Array.isArray(r.body?.tools) ? r.body.tools : [])
            .some((t) => String(t?.function?.name || '') === 'simulate_prompt'))).toBe(true);

        const result = await readLastResult(page);
        expect(result).toContain('<simulation_result kind="cea" ok="true">');
        expect(result).toContain('<status submitted="true" annotations_count="0"/>');
        expect(result).toContain(SIM_REPLY);
        expect(result.length).toBeGreaterThan(0);

        const requests = ceaEditorRequests();
        expect(lastToolMessage(requests[requests.length - 1])?.content).toBe(result);

        await closeIterStudio(page);
    });

    test('cancelled review: still a successful tool call that tells the model it was cancelled', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await openIterStudio(page, 'cea');

        await simulateAndDecide(page, 'cancel');

        const result = await readLastResult(page);
        expect(result).toContain('<simulation_result kind="cea" ok="false" cancelled="true">');
        expect(result).toContain('<status submitted="false"/>');
        expect(result).toContain(SIM_REPLY);
        const requests = ceaEditorRequests();
        expect(lastToolMessage(requests[requests.length - 1])?.content).toBe(result);

        await closeIterStudio(page);
    });
});
