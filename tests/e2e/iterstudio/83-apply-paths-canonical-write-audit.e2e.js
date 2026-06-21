// #83 — Cross-cutting audit: all 4 iter-studio Apply paths route through
//         canonical write APIs (not legacy bypass surfaces).
//
// REAL USER-GESTURE flow per adapter:
//   1. Open the adapter's iter-studio popup via real clicks.
//   2. Install a fetch recorder.
//   3. Script the adapter's apply-shaped tool_call on the mock.
//   4. Click Send → wait Apply → click Apply.
//   5. Assert the canonical endpoint was hit:
//      - CPA   → /api/presets/save
//      - MG    → /api/settings/save (or /api/settings/patch)
//      - Orch  → /api/settings/save (or /api/settings/patch); also assert
//        legacy flat fields stayed untouched (regression 990c2d738)
//      - CEA   → /api/characters/edit

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings as baseNormalize } from '../preset/_helpers.js';

let server, mock;

function normalizeSettings(dataRoot) {
    baseNormalize(dataRoot);
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
        batchKey: 'iterstudio',
        scenarioId: '83-apply-path-audit',
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

async function installFetchRecorder(page) {
    await page.evaluate(() => {
        if (window.__iterStudioFetchRecorderInstalled) {
            window.__iterStudioFetchLog = [];
            return;
        }
        window.__iterStudioFetchRecorderInstalled = true;
        window.__iterStudioFetchLog = [];
        const orig = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const url = typeof input === 'string'
                ? input
                : (input && typeof input.url === 'string' ? input.url : String(input));
            const method = (init && init.method) || (input && input.method) || 'GET';
            window.__iterStudioFetchLog.push({ url: String(url), method: String(method).toUpperCase() });
            return orig(input, init);
        };
    });
}

async function readFetchLogSince(page, sinceIdx) {
    return await page.evaluate((from) => {
        const log = window.__iterStudioFetchLog || [];
        return log.slice(from);
    }, sinceIdx);
}

async function fetchLogLength(page) {
    return await page.evaluate(() => (window.__iterStudioFetchLog || []).length);
}

test.describe('#83 — All 4 iter-studio Apply paths route through canonical write APIs (real UI)', () => {
    test('CPA Apply (real click) → /api/presets/save', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await installFetchRecorder(page);

        await openIterStudio(page, 'cpa');
        mock.scriptToolCall({
            name: 'preset_set_field',
            arguments: { path: 'temperature', value_json: '0.7' },
        });
        await sendIterPrompt(page, 'cpa', 'Set temperature to 0.7 for the next session.');

        const before = await fetchLogLength(page);
        await applyIterBatch(page, 'cpa');
        await closeIterStudio(page);

        const reqs = await readFetchLogSince(page, before);
        const savedPreset = reqs.find(r => /\/api\/presets\/save\b/.test(r.url));
        expect(savedPreset, `CPA Apply must hit /api/presets/save; saw ${JSON.stringify(reqs.map(r => r.url))}`).toBeTruthy();
        expect(savedPreset.method).toBe('POST');
    });

    test('MG Schema Apply (real click) → /api/settings/save or /api/settings/patch', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await installFetchRecorder(page);

        await openIterStudio(page, 'mg');
        mock.scriptToolCall({
            name: 'mg_schema_set_node_type',
            arguments: {
                node_type: {
                    id: 'audit_marker_83',
                    label: 'Audit Marker',
                    tableName: 'audit_marker_table',
                    tableColumns: ['note'],
                    embeddingColumns: ['note'],
                    requiredColumns: ['note'],
                    keywords: ['audit'],
                },
            },
        });
        await sendIterPrompt(page, 'mg', 'Add an audit_marker node type.');

        const before = await fetchLogLength(page);
        await applyIterBatch(page, 'mg');
        await closeIterStudio(page);

        await expect.poll(async () => {
            const reqs = await readFetchLogSince(page, before);
            return reqs.some(r => /\/api\/settings\/(save|patch)\b/.test(r.url));
        }, { timeout: 5000 }).toBe(true);
    });

    test('Orchestrator Apply (real click) → writeActivePreset; legacy flat fields untouched', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await installFetchRecorder(page);

        await openIterStudio(page, 'orch');
        const NEW_PROMPT = '*Ash narrates the night reef.* Stay in scene; one tactile beat per turn.';
        mock.scriptToolCall({
            name: 'luker_orch_set_director_main_agent',
            arguments: { systemPrompt: NEW_PROMPT },
        });
        await sendIterPrompt(page, 'orch', 'Set the director main system prompt to the new tactile-beat framing.');

        await applyIterBatch(page, 'orch');
        await closeIterStudio(page);

        // Assert: active director slot carries the new prompt; legacy
        // settings.directorProfile is NOT a mirror of the new value.
        const after = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const s = ctx.extensionSettings.orchestrator;
            const activeId = s?.activePresetIds?.director || '';
            return {
                directorActiveSlot: s?.presetLibraries?.director?.[activeId]?.mainAgent?.systemPrompt || '',
                hasDirectorProfile: Object.prototype.hasOwnProperty.call(s || {}, 'directorProfile'),
                directorProfileSystemPrompt: s?.directorProfile?.mainAgent?.systemPrompt || '',
            };
        });
        expect(after.directorActiveSlot).toBe(NEW_PROMPT);
        if (after.hasDirectorProfile) {
            expect(after.directorProfileSystemPrompt, 'legacy directorProfile.mainAgent.systemPrompt must not mirror Apply').not.toBe(NEW_PROMPT);
        }
    });

    test('CEA Character Apply (real click) → /api/characters/edit', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await installFetchRecorder(page);

        await openIterStudio(page, 'cea');
        const NEW_DESC = 'Seraphina keeps a tide-log on her belt — a half-inch leather notebook.';
        mock.scriptToolCall({
            name: 'cea_set_card_field',
            arguments: { field: 'description', value: NEW_DESC },
        });
        await sendIterPrompt(page, 'cea', 'Add a tide-log detail to Seraphina\'s description.');

        const before = await fetchLogLength(page);
        await applyIterBatch(page, 'cea');
        await closeIterStudio(page);

        const reqs = await readFetchLogSince(page, before);
        const editCall = reqs.find(r => /\/api\/characters\/edit\b/.test(r.url));
        expect(editCall, `CEA Apply must hit /api/characters/edit; saw ${JSON.stringify(reqs.map(r => r.url))}`).toBeTruthy();
        expect(editCall.method).toBe('POST');
    });
});
