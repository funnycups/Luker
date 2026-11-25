// #94 — CPA iter-studio: the live preview marks a pending preset change
// before approval (B6).
//
// REAL USER-GESTURE flow:
//   1. Open the CPA studio through the extensions drawer.
//   2. The mock LLM answers the prompt with a preset_set_field tool call,
//      which the studio stages as a pending proposal.
//   3. The preview pane's Temperature row carries `pending-change` and
//      shows the pending value — no Approve click.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const TARGET_TEMPERATURE = 0.37;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({ scope,
        batchKey: 'iterstudio',
        scenarioId: '94-cpa-preview-pending',
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

test.describe('#94 — CPA iter-studio preview highlights the pending change (real UI)', () => {
    test('a pending preset_set_field marks the Temperature row before approval', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'cpa');

        mock.scriptToolCall({
            name: 'preset_set_field',
            arguments: {
                path: 'temperature',
                value_json: JSON.stringify(TARGET_TEMPERATURE),
                reason: 'Steadier narration for the night watch on the chart deck',
            },
        });
        await sendIterPrompt(page, 'cpa', 'Bring the temperature down to 0.37 so the night watch narration stays steady.');

        const popup = page.locator('.wbench .wb-win');
        const pendingRow = popup.locator('.wb-iter-preview .wb-preset-preview details.is-change');
        await expect(pendingRow).toContainText('Generation parameters', { timeout: 15_000 });
        await expect(pendingRow.locator('pre')).toContainText('"temperature"');
        expect(JSON.parse(await pendingRow.locator('pre').textContent()).temperature).toBe(TARGET_TEMPERATURE);

        await closeIterStudio(page);
    });
});
