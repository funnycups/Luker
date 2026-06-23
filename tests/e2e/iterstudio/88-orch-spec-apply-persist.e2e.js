// #88 — Orchestrator iter-studio (SPEC mode): Apply spec preset → persists across restart.
//
// REAL USER-GESTURE flow:
//   1. Pin executionMode='spec' so the orchestrator panel shows the spec workflow board.
//   2. Open the orch iter-studio popup via real clicks.
//   3. Script `luker_orch_set_preset` with a new preset_id + systemPrompt.
//   4. Click Send → wait Approve → click Apply → close popup.
//   5. Verify both in-memory and on-disk active spec preset payload contains
//      the new preset under .presets[id].
//   6. Restart, reload, re-assert.

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

const PRESET_ID = 'ash_narrator';
const NEW_PRESET_SYSTEM_PROMPT = '*You are Ash the Bryn cartographer-narrator.* '
    + 'In every spec node you drive, stay in-scene; thread your reasoning through reef-survey beats — '
    + 'the spyglass, the tide line, the brine-rust at the lantern bezel.';

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
    s.extension_settings.orchestrator.executionMode = 'spec';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveSpecPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    if (!ext) return null;
    const activeId = ext.activePresetIds?.spec || '';
    const lib = ext.presetLibraries?.spec || {};
    return activeId ? (lib[activeId] || null) : null;
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '88-orch-spec-apply',
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

test.describe('#88 — Orchestrator iter-studio SPEC mode Apply persists across restart (real UI)', () => {
    test('Apply writes a new spec preset payload via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');

        mock.scriptToolCall({
            name: 'luker_orch_set_preset',
            arguments: {
                preset_id: PRESET_ID,
                systemPrompt: NEW_PRESET_SYSTEM_PROMPT,
                userPromptTemplate: 'Continue the reef-survey narration. Anchor every line to a chart landmark.',
            },
        });

        await sendIterPrompt(page, 'orch', `Define a spec preset "${PRESET_ID}" with the Bryn reef-survey narrator voice.`);
        await applyIterBatch(page, 'orch');
        await closeIterStudio(page);

        await expect.poll(async () => {
            return await page.evaluate((presetId) => {
                const ctx = window.Luker.getContext();
                const s = ctx.extensionSettings.orchestrator;
                const activeId = s?.activePresetIds?.spec || '';
                return s?.presetLibraries?.spec?.[activeId]?.presets?.[presetId]?.systemPrompt || '';
            }, PRESET_ID);
        }, { timeout: 10_000 }).toBe(NEW_PRESET_SYSTEM_PROMPT);

        await expect.poll(() => readActiveSpecPreset(server.dataRoot)?.presets?.[PRESET_ID]?.systemPrompt || '', { timeout: 10_000 }).toBe(NEW_PRESET_SYSTEM_PROMPT);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = readActiveSpecPreset(server.dataRoot);
        expect(afterRestart).toBeTruthy();
        expect(afterRestart.presets?.[PRESET_ID]?.systemPrompt).toBe(NEW_PRESET_SYSTEM_PROMPT);

        const inMem = await page.evaluate((presetId) => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.spec || '';
            return s?.presetLibraries?.spec?.[activeId]?.presets?.[presetId]?.systemPrompt || '';
        }, PRESET_ID);
        expect(inMem).toBe(NEW_PRESET_SYSTEM_PROMPT);
    });
});
