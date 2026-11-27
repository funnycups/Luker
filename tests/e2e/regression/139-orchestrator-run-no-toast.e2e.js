// #139 — Orchestrator spec / agenda / loop runs report progress through the
// run panel only without info toasts, and Stop in the panel aborts the run.
//
// REAL USER-GESTURE flow, per mode:
//   1. In the orchestrator drawer: enable and pick the mode (shipped default
//      preset).
//   2. Send a turn from the composer. The mock holds every LLM request while
//      the run is in flight.
//   3. The run panel opens with the run running; no running toast is shown.
//   4. Click Stop in the panel: the run ends as aborted and the main reply
//      still arrives.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageViaUI } from '../_lib/page.js';
import { enableOrchestratorMode } from '../_lib/ui-orchestrator.js';

const REPLY = '*Seraphina tucks the chart under her arm.* "Then we wait for the tide."';
// Long enough that the panel and toast checks plus the Stop click happen
// while the first orchestration request is still pending.
const HOLD_MS = 8000;

let server, mock;
let hold = false;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({ scriptedReplies: [REPLY, REPLY, REPLY] });
    mock.setLatencyMs(() => (hold ? HOLD_MS : 0));
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '139-orch-run-no-toast' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {

    await mock?.stop();
});

test.describe('#139 — orchestrator runs without the running toast', () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ viewport: { width: 1440, height: 900 } });
    test.setTimeout(180_000);

    for (const mode of ['spec', 'agenda', 'loop']) {
        test(`${mode} run: panel only, Stop in the panel aborts`, async ({ page }) => {
            await awaitMainUI(page, server.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await enableOrchestratorMode(page, mode);

            hold = true;
            try {
                await sendMessageViaUI(page, '*I lean on the rail.* "Do we sail tonight?"');
                const panel = page.locator('.rpdock.rp-dock');
                await expect(panel).toHaveAttribute('data-state', 'open', { timeout: 30_000 });
                await expect(panel.locator('.rp-status')).toHaveAttribute('data-status', 'running');
                await expect(page.locator('#toast-container .toast-info')).toHaveCount(0);

                const stop = panel.locator('button.rp-dock-stop');
                await stop.click();
                await expect(panel.locator('.rp-status')).toHaveAttribute('data-status', 'aborted', { timeout: 30_000 });
            } finally {
                hold = false;
            }
            await expect(page.locator('#chat .mes').last()).toContainText('wait for the tide', { timeout: 60_000 });
            await expect(page.locator('#toast-container .toast-info')).toHaveCount(0);
        });
    }
});
