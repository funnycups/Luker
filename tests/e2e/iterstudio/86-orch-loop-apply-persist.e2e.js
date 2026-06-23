// #86 — Orchestrator iter-studio (LOOP mode): Apply loop profile → persists across restart.
//
// REAL USER-GESTURE flow:
//   1. Pin executionMode='loop' so the orchestrator panel shows the loop board.
//   2. Open the orchestrator iter-studio popup (extensions drawer → orch panel
//      → "Open AI Iteration Studio" — the visible trigger under the loop panel).
//   3. Script `luker_orch_set_loop_profile` on the mock with a new system_prompt.
//   4. Click Send via sendIterPrompt; wait for an Approve affordance.
//   5. Click Apply via applyIterBatch (real click).
//   6. Close popup. Verify both:
//      - In-memory active loop preset slot has the new system_prompt.
//      - settings.json on disk reflects the new system_prompt.
//   7. Restart server, reload page, re-assert.
//
// Production bug this guards: prior to the patch-storage refactor users
// reported "loop 模式第一次编辑就报冲突" — the first proposal arrived from
// the LLM, the user clicked Apply, but the proposal-bus computed a stale
// fingerprint over the entire live profile (sha256OfJson) and decided it
// had drifted, dropping the write. This e2e runs the FULL real path
// (mock LLM → studio → bus → target handler → writeActivePreset → disk),
// so if any layer regresses to whole-snapshot drift detection, Apply will
// silently no-op and the disk assertion fails.

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

const NEW_LOOP_SYSTEM_PROMPT = '*You are Ash narrating the Bryn headland reef survey.* '
    + 'Keep the in-scene voice; thread each tool plan through the next tide window. '
    + 'When you finish a round, close on a tactile beat: brine on the rail, '
    + 'verdigris on the brass spyglass, the cold of the lantern bezel.';

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
    s.extension_settings.orchestrator.executionMode = 'loop';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveLoopPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    if (!ext) return null;
    const activeId = ext.activePresetIds?.loop || '';
    const lib = ext.presetLibraries?.loop || {};
    return activeId ? (lib[activeId] || null) : null;
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '86-orch-loop-apply',
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

test.describe('#86 — Orchestrator iter-studio LOOP mode Apply persists across restart (real UI)', () => {
    test('Apply writes loop.system_prompt to active preset via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Open the loop-mode iter-studio popup. The orchestrator extensions
        // drawer auto-shows the panel matching executionMode (loop here), so
        // the visible "Open AI Iteration Studio" trigger lives under it.
        await openIterStudio(page, 'orch');

        // Script the first-round tool_call exactly as the LLM would emit it.
        // Only system_prompt is changed; every other loop-profile field is
        // omitted so the patch helper preserves them.
        mock.scriptToolCall({
            name: 'luker_orch_set_loop_profile',
            arguments: { system_prompt: NEW_LOOP_SYSTEM_PROMPT },
        });

        await sendIterPrompt(page, 'orch', 'Rewrite the loop system prompt to the Bryn headland reef-survey narration.');

        await applyIterBatch(page, 'orch');

        await closeIterStudio(page);

        // In-memory: active loop preset slot has the new system_prompt.
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const s = ctx.extensionSettings.orchestrator;
                const activeId = s?.activePresetIds?.loop || '';
                return s?.presetLibraries?.loop?.[activeId]?.system_prompt || '';
            });
        }, { timeout: 10_000 }).toBe(NEW_LOOP_SYSTEM_PROMPT);

        // Disk-side: settings.json mirrors the in-memory state.
        await expect.poll(() => readActiveLoopPreset(server.dataRoot)?.system_prompt || '', { timeout: 10_000 }).toBe(NEW_LOOP_SYSTEM_PROMPT);

        // Restart + reload + re-assert against both sources of truth.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = readActiveLoopPreset(server.dataRoot);
        expect(afterRestart).toBeTruthy();
        expect(afterRestart.system_prompt).toBe(NEW_LOOP_SYSTEM_PROMPT);

        const inMem = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.loop || '';
            return s?.presetLibraries?.loop?.[activeId]?.system_prompt || '';
        });
        expect(inMem).toBe(NEW_LOOP_SYSTEM_PROMPT);
    });
});
