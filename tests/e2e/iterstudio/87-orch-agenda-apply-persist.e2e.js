// #87 — Orchestrator iter-studio (AGENDA mode): Apply agenda planner → persists across restart.
//
// REAL USER-GESTURE flow:
//   1. Pin executionMode='agenda' so the orchestrator panel shows the agenda board.
//   2. Open the orch iter-studio popup via real clicks.
//   3. Script `luker_orch_set_agenda_planner` with a new systemPrompt.
//   4. Click Send → wait Approve → click Apply → close popup.
//   5. Verify both in-memory and on-disk active agenda preset reflect the new systemPrompt.
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

const NEW_PLANNER_PROMPT = '*You direct the agenda-planning council inside Bryn\'s harbour office.* '
    + 'Lay out every sub-agent\'s task in plain operational language. Anchor each step to the chart '
    + 'pinned over the desk — landmarks, tide windows, the names of the crews each agent will hail.';

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
    s.extension_settings.orchestrator.executionMode = 'agenda';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

function readActiveAgendaPreset(dataRoot) {
    const s = JSON.parse(readFileSync(settingsJsonPath(dataRoot), 'utf8'));
    const ext = s?.extension_settings?.orchestrator;
    if (!ext) return null;
    const activeId = ext.activePresetIds?.agenda || '';
    const lib = ext.presetLibraries?.agenda || {};
    return activeId ? (lib[activeId] || null) : null;
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'iterstudio',
        scenarioId: '87-orch-agenda-apply',
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

test.describe('#87 — Orchestrator iter-studio AGENDA mode Apply persists across restart (real UI)', () => {
    test('Apply writes agenda.planner.systemPrompt to active preset via real Apply button click', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await openIterStudio(page, 'orch');

        mock.scriptToolCall({
            name: 'luker_orch_set_agenda_planner',
            arguments: { systemPrompt: NEW_PLANNER_PROMPT },
        });

        await sendIterPrompt(page, 'orch', 'Rewrite the agenda planner system prompt to the harbour-office tasking voice.');
        await applyIterBatch(page, 'orch');
        await closeIterStudio(page);

        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.Luker.getContext();
                const s = ctx.extensionSettings.orchestrator;
                const activeId = s?.activePresetIds?.agenda || '';
                return s?.presetLibraries?.agenda?.[activeId]?.planner?.systemPrompt || '';
            });
        }, { timeout: 10_000 }).toBe(NEW_PLANNER_PROMPT);

        await expect.poll(() => readActiveAgendaPreset(server.dataRoot)?.planner?.systemPrompt || '', { timeout: 10_000 }).toBe(NEW_PLANNER_PROMPT);

        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = readActiveAgendaPreset(server.dataRoot);
        expect(afterRestart).toBeTruthy();
        expect(afterRestart.planner?.systemPrompt).toBe(NEW_PLANNER_PROMPT);

        const inMem = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.agenda || '';
            return s?.presetLibraries?.agenda?.[activeId]?.planner?.systemPrompt || '';
        });
        expect(inMem).toBe(NEW_PLANNER_PROMPT);
    });
});
