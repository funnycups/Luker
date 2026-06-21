// #37 — Orchestrator iter-studio Apply → Global routes through writeActivePreset.
//
// REGRESSION LOCK for commit 990c2d738.
//
// REAL USER-GESTURE flow:
//   1. Open the orchestrator iter-studio popup (extensions drawer →
//      orchestrator panel → "Open AI Iteration Studio") via real clicks.
//   2. Script a `luker_orch_set_director_main_agent` tool_call on the mock
//      so the studio receives a pending edit.
//   3. Click Send via sendIterPrompt; wait for the Apply button to render.
//   4. Click Apply via applyIterBatch.
//   5. Verify the active director preset slot in extension_settings.orchestrator.
//      presetLibraries.director.<activeId>.mainAgent.systemPrompt carries the
//      mutated value AND that legacy flat fields (settings.directorProfile,
//      etc.) remain untouched.
//   6. Restart, reload, re-assert.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings } from './_helpers.js';

let server, mock;

const MARKER_PROMPT = '*Ash leans against the rail of the watchpost, brass spyglass folded against her hip.* You are the director for an immersive vigil on the Bryn headland. Compose director plans that keep the watch in scene, mark threats sparingly, and never write user actions for {{user}}. — regression marker e2e #37.';

function normalizeSettings(dataRoot) {
    normalizeIterStudioSettings(dataRoot);
    const sp = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    s.extension_settings.orchestrator.enabled = true;
    s.extension_settings.orchestrator.executionMode = 'director';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'orch-apply-global',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    normalizeSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#37 — orchestrator iter-studio Apply → Global writes through writeActivePreset (real UI)', () => {
    test('director-mode Apply lands in presetLibraries.director.<activeId>', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Step 1: Open the orchestrator iter-studio popup.
        await openIterStudio(page, 'orch');

        // Step 2: Script a director main-agent set tool call on the mock.
        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: MARKER_PROMPT },
        });

        // Step 3: Send + wait for Apply to render.
        await sendIterPrompt(page, 'orch', 'Update the director main system prompt to the new immersive watchpost framing.');

        // Step 4: Click Apply via the real button.
        await applyIterBatch(page, 'orch');

        // Close popup so reload doesn't fight us.
        await closeIterStudio(page);

        // Step 5: Verify the active preset slot carries the mutation, and
        // legacy flat fields were NOT written by Apply.
        const after = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.director || '';
            return {
                activeId,
                activeSlotSystemPrompt: s?.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '',
                hasLegacyDirectorProfile: Object.prototype.hasOwnProperty.call(s || {}, 'directorProfile'),
                hasLegacyLoopProfile: Object.prototype.hasOwnProperty.call(s || {}, 'loopProfile'),
            };
        });
        expect(after.activeId).toBeTruthy();
        expect(after.activeSlotSystemPrompt).toBe(MARKER_PROMPT);
        expect(after.hasLegacyDirectorProfile, 'apply must not write settings.directorProfile').toBe(false);
        expect(after.hasLegacyLoopProfile, 'apply must not write settings.loopProfile').toBe(false);

        // Step 6: Restart and reload — slot still carries marker.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const afterRestart = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.director || '';
            return s?.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '';
        });
        expect(afterRestart).toBe(MARKER_PROMPT);
    });
});
