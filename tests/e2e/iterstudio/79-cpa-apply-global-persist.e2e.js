// #79 — CPA iter-studio: Apply to Global → preset file mutated → reload sees change.
//
// REAL USER-GESTURE flow:
//   1. Open the Extensions drawer, open the CPA inline drawer, click the
//      "Open Assistant" button — all by real DOM clicks (openIterStudio).
//   2. Script a `preset_set_field` tool_call on the mock LLM so the studio
//      receives a pending edit when we Send.
//   3. Fill the iter-studio composer textarea, click Send (sendIterPrompt).
//      sendIterPrompt waits for the Apply button to render after the LLM
//      tool_call is consumed.
//   4. Click the Apply button (applyIterBatch).
//   5. Close the popup, restart server, reload page.
//   6. After re-selecting the Default preset via the visible
//      #settings_preset_openai select, read the rendered #temp_counter_openai
//      input value — it must reflect the value we applied through Apply.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { selectPresetByName, normalizeIterStudioSettings } from '../preset/_helpers.js';

let server, mock;

const TARGET_TEMPERATURE = 0.42;

// The seed dataRoot's settings.json carries the developer's working CPA /
// orchestrator preset names which override our mock-bound oai_settings on
// every iter-studio LLM request. Use the shared normalizeIterStudioSettings.

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Ash glances at the chart and nods.* "We can hold for one more turn."',
    ] });
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '79-cpa-apply-global',
        // Tests need fs storage so the bootstrap fixtures' settings.json edits
        // land where the server reads from (the seed config.yaml may be sqlite
        // in dev checkouts).
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#79 — CPA iter-studio Apply → preset persists across restart (real UI)', () => {
    test('Apply persists temperature change to Default.json via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Baseline: read the rendered #temp_counter_openai input value before
        // the Apply runs so we can prove the change actually took effect.
        const baselineDisplayed = await page.locator('#temp_counter_openai').inputValue();
        expect(Number(baselineDisplayed)).not.toBe(TARGET_TEMPERATURE);

        // Open the CPA iter-studio popup via real clicks (extensions drawer
        // → CPA inline drawer → "Open Assistant" button).
        await openIterStudio(page, 'cpa');

        // Script the LLM's tool_call BEFORE clicking Send so the studio
        // receives a pending edit after the LLM round closes.
        mock.scriptToolCall({
            name: 'preset_set_field',
            arguments: {
                path: 'temperature',
                value_json: JSON.stringify(TARGET_TEMPERATURE),
                reason: 'e2e-real: lower temperature to 0.42 for a steadier scene',
            },
        });

        // Fill the iter-studio composer and click Send — sendIterPrompt waits
        // for the Apply button to render before returning.
        await sendIterPrompt(page, 'cpa', 'Lower the temperature to 0.42 for a steadier voice.');

        // Click the real Apply button — applyIterBatch waits for the
        // rollback button (apply-success signal) to appear in place.
        await applyIterBatch(page, 'cpa');

        // Close the popup so reload doesn't try to rehydrate a stale session.
        await closeIterStudio(page);

        // Restart server + reload page. The on-disk preset must carry the
        // new temperature, and after re-selecting Default the rendered
        // editor input must reflect it.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // Re-select Default via the visible preset select. The change
        // handler runs on selectOption, which writes the preset body's
        // temperature into oai_settings.temp_openai and refreshes the
        // visible input.
        await selectPresetByName(page, 'Default');

        // Read the rendered editor input — the DOM-side ground truth that
        // matters for the user-facing contract. Poll because the change
        // handler is async (OAI_PRESET_CHANGED_BEFORE listeners).
        await expect.poll(async () => {
            return Number(await page.locator('#temp_counter_openai').inputValue());
        }, { timeout: 15_000 }).toBe(TARGET_TEMPERATURE);
    });
});
