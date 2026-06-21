// #81 — Orchestrator iter-studio: Apply director profile → persists across restart.
//
// REAL USER-GESTURE flow:
//   1. Open the orchestrator iter-studio popup via real clicks
//      (extensions drawer → orchestrator panel → "Open AI Iteration Studio").
//   2. Script a `luker_orch_set_director_main_agent` tool_call on the mock.
//   3. Click Send via sendIterPrompt; wait for Apply button.
//   4. Click Apply via applyIterBatch.
//   5. Close popup. Verify:
//      - In-memory active director preset has the new systemPrompt
//      - settings.json reflects the new payload (on-disk read)
//   6. Restart, reload, re-assert via in-memory + disk reads.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings as baseNormalize } from '../preset/_helpers.js';

let server, mock;

const NEW_DIRECTOR_PROMPT = '*You are Ash, the cartographer-narrator of the Bryn headland.* '
    + 'Hold the in-scene voice. Frame each scene through the reef chart you carry — '
    + 'no third-wall asides, no meta. End every turn with a tactile beat: the brine on the rail, '
    + 'the verdigris of the spyglass, the cold of the lantern\'s bezel.';

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

function normalizeSettings(dataRoot) {
    baseNormalize(dataRoot);
    const sp = settingsJsonPath(dataRoot);
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    s.extension_settings.orchestrator.enabled = true;
    s.extension_settings.orchestrator.executionMode = 'director';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveDirectorPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    if (!ext) return null;
    const activeId = ext.activePresetIds?.director || '';
    const lib = ext.presetLibraries?.director || {};
    return activeId ? (lib[activeId] || null) : null;
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '81-orch-director-apply',
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

test.describe('#81 — Orchestrator iter-studio Apply → director profile persists across restart (real UI)', () => {
    test('Apply writes director.mainAgent.systemPrompt to active preset via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Open the orchestrator iter-studio popup.
        await openIterStudio(page, 'orch');

        // Script the tool_call.
        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: NEW_DIRECTOR_PROMPT },
        });

        // Send + wait for Apply to render.
        await sendIterPrompt(page, 'orch', 'Update the director main system prompt to the new immersive Bryn-headland framing.');

        // Click Apply via real button.
        await applyIterBatch(page, 'orch');

        // Close popup.
        await closeIterStudio(page);

        // In-memory: active director preset slot carries the new prompt.
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const s = ctx.extensionSettings.orchestrator;
                const activeId = s?.activePresetIds?.director || '';
                return s?.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '';
            });
        }, { timeout: 10_000 }).toBe(NEW_DIRECTOR_PROMPT);

        // Disk: settings.json carries the new payload.
        await expect.poll(() => readActiveDirectorPreset(server.dataRoot)?.mainAgent?.systemPrompt || '', { timeout: 10_000 }).toBe(NEW_DIRECTOR_PROMPT);

        // Restart + reload.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = readActiveDirectorPreset(server.dataRoot);
        expect(afterRestart).toBeTruthy();
        expect(afterRestart.mainAgent?.systemPrompt).toBe(NEW_DIRECTOR_PROMPT);

        const inMem = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.director || '';
            return s?.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '';
        });
        expect(inMem).toBe(NEW_DIRECTOR_PROMPT);
    });
});
