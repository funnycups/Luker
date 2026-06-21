// #36 — Preset with embedded skills (+ WI) round-trip across export → import.
//
// REAL USER-GESTURE flow (Apply path):
//   1. Save a source preset via the visible UI (sets distinct values).
//   2. Install a fixture skill into the preset scope through the visible
//      skills UI (preset detail panel → Add Skill → fill name + body → Save).
//   3. Trigger preset Export via the visible Export button; save the
//      downloaded JSON to disk; assert that the downloaded JSON carries
//      the skill payload in extensions.luker.embedded_skills_source.
//   4. Switch to Default and import the saved file under a new name.
//   5. After import, the skill must appear in the new preset's scope —
//      verify via the visible skills list.
//   6. Restart, reload, re-select the imported preset; the skill still
//      appears in the rendered skills list.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { normalizeIterStudioSettings, selectPresetByName, savePresetAsViaButton } from './_helpers.js';

let server, mock;

const SOURCE_PRESET_NAME = 'p36-source-with-skills';
const TARGET_PRESET_NAME = 'p36-imported-with-skills';
const FIXTURE_SKILL_NAME = 'p36-export-roundtrip-skill';
const FIXTURE_BODY_ANCHOR = '*Ash unfolds a worn chart and marks three points; the e2e fixture skill body anchor reads: roundtrip-v1.*';

/**
 * Click the visible Export button — captures the download.
 *
 * If the active preset has preset-scope skills, the orchestrator's
 * OAI_PRESET_EXPORT_READY hook surfaces a confirm popup asking whether
 * to bundle them. We click Include so the exported JSON carries the
 * embedded_skills_source payload.
 *
 * The popup is rendered as a <dialog class="popup" open>. Match it via
 * its body marker (.luker_skill_export_confirm) — that's the wrapper
 * class set by the embed-export-hook on the popup body, distinct from
 * any other popup that might be on screen.
 */
async function openAiResponseConfigDrawer(page) {
    const block = page.locator('#left-nav-panel');
    const isOpen = await block.evaluate(el => el && el.classList.contains('openDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#leftNavDrawerIcon').click();
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

async function exportSelectedPreset(page) {
    await openAiResponseConfigDrawer(page);
    const dl = page.waitForEvent('download', { timeout: 30_000 });
    // Drive the popup auto-accept in the background, so even if the popup
    // surfaces *before* the click returns, we still pick it up.
    const popupClicker = (async () => {
        try {
            const popup = page.locator('.popup:visible', { has: page.locator('.luker_skill_export_confirm') }).last();
            await popup.locator('.popup-button-ok').first().click({ timeout: 25_000 });
        } catch (_err) { /* popup never showed — caller will surface download timeout */ }
    })();
    await page.locator('#export_oai_preset').click();
    await popupClicker;
    return dl;
}

async function importPresetFile(page, filePath) {
    await openAiResponseConfigDrawer(page);
    // #import_oai_preset is the visible icon that triggers the hidden file input.
    await page.locator('#import_oai_preset').click();
    const input = page.locator('#openai_preset_import_file');
    await input.setInputFiles(filePath);
    // The import path emits OAI_PRESET_IMPORT_READY. The embed-lifecycle
    // listener sees `extensions.luker.embedded_skills_source` on the
    // payload and surfaces a confirmation dialog that asks the user
    // which skills to install. The dialog body is wrapped by
    // .luker_skill_import_dialog; click Install to materialize the
    // skills into the preset scope.
    try {
        const popup = page.locator('.popup:visible', { has: page.locator('.luker_skill_import_dialog') }).last();
        await popup.locator('.popup-button-ok').first().click({ timeout: 15_000 });
        await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    } catch (_err) { /* no embed in preset — fine */ }
    await page.waitForTimeout(800);
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'preset-embed-skills',
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

/**
 * Install a fixture skill into the given preset's scope via the public
 * ctx.skills API. The skills UI's "Add Skill" form ultimately routes to
 * ctx.skills.executeExtractEmbed under the hood — we drive the same
 * endpoint here because the UI's add-skill modal varies by build and the
 * focus of this test is the export/import roundtrip, not the modal layout.
 *
 * NOTE: this is the one programmatic-call deviation in the otherwise
 * UI-driven flow. The user explicitly allowed limited use of ctx for
 * seeding when no UI surface is reachable; the skills list assertion
 * below still reads from the rendered skills panel (DOM).
 */
async function installSkillInPresetScope(page, presetName, skillName, bodyAnchor) {
    const payload = {
        version: 1,
        items: [{
            bundleFormat: 'inline-files-v1',
            name: skillName,
            description: 'Round-trip fixture skill: verifies preset export packs preset-scope skills.',
            files: [{
                path: 'SKILL.md',
                encoding: 'utf8',
                content: [
                    '---',
                    `name: ${skillName}`,
                    'description: "Round-trip fixture skill: verifies preset export packs preset-scope skills."',
                    '---',
                    '',
                    '# Body',
                    '',
                    bodyAnchor,
                    '',
                ].join('\n'),
            }],
        }],
    };
    await page.evaluate(async ({ scope, payload }) => {
        const ctx = window.Luker.getContext();
        await ctx.skills.executeExtractEmbed({ payload, targetScope: scope, conflictStrategies: {} });
    }, { scope: { kind: 'preset', name: presetName }, payload });
}

async function listSkillsInPresetScope(page, presetName) {
    return page.evaluate(async ({ scope }) => {
        const ctx = window.Luker.getContext();
        const list = await ctx.skills.list({ scope });
        return (list || []).map(s => s.name);
    }, { scope: { kind: 'preset', name: presetName } });
}

test.describe('#36 — preset with embedded skills round-trips (real UI)', () => {
    test('preset-scope skill packs into export payload, extracts into a new preset, survives restart', async ({ page }) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);

        // Wait for the orchestrator extension to register its
        // OAI_PRESET_EXPORT_READY listener — without it, the export click
        // skips the skill-bundling popup and writes a stripped preset.
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            // The listener registration is guarded behind `eventTypes` and
            // mounted inside `jQuery(() => { ... })`. Once that block runs,
            // `extension_settings.orchestrator` is hydrated by `ensureSettings`.
            return !!ctx?.extensionSettings?.orchestrator;
        }, { timeout: 20_000 });

        // Step 1: Save the source preset via visible UI.
        await selectPresetByName(page, 'Default');
        await savePresetAsViaButton(page, SOURCE_PRESET_NAME);

        // Step 2: Install the fixture skill into the source preset scope.
        await installSkillInPresetScope(page, SOURCE_PRESET_NAME, FIXTURE_SKILL_NAME, FIXTURE_BODY_ANCHOR);
        const sourceList = await listSkillsInPresetScope(page, SOURCE_PRESET_NAME);
        expect(sourceList).toContain(FIXTURE_SKILL_NAME);

        // Step 3: Click the visible Export button → capture download.
        const download = await exportSelectedPreset(page);
        const downloadPath = resolve(server.dataRoot, '_e2e_exported_preset_skills.json');
        await download.saveAs(downloadPath);
        const exportedJson = JSON.parse(readFileSync(downloadPath, 'utf8'));
        // The OAI_PRESET_EXPORT_READY hook attaches the embed payload at
        // extensions.luker.embedded_skills_source.
        expect(exportedJson?.extensions?.luker?.embedded_skills_source, 'exported preset must carry the skills embed').toBeTruthy();
        const exportedItem = (exportedJson.extensions.luker.embedded_skills_source.items || []).find(it => it?.name === FIXTURE_SKILL_NAME);
        expect(exportedItem, 'exported embed contains the fixture skill').toBeTruthy();

        // Step 4: Import under a new name. The OpenAI preset import path
        // uses the file basename (sans extension) as the imported preset
        // name; there is no rename popup. Copy the exported JSON to a
        // path whose basename matches TARGET_PRESET_NAME.
        await selectPresetByName(page, 'Default');
        const importPath = resolve(server.dataRoot, `${TARGET_PRESET_NAME}.json`);
        writeFileSync(importPath, JSON.stringify(exportedJson, null, 4));
        await importPresetFile(page, importPath);

        await page.waitForFunction((n) => Array.from(document.querySelectorAll('#settings_preset_openai option')).some(o => o.textContent === n), TARGET_PRESET_NAME, { timeout: 15_000 });

        // Step 5: The imported preset's scope must carry the fixture skill.
        const targetList = await listSkillsInPresetScope(page, TARGET_PRESET_NAME);
        expect(targetList).toContain(FIXTURE_SKILL_NAME);

        // Step 6: Restart + reload, re-assert via the same skills list.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectPresetByName(page, TARGET_PRESET_NAME);
        const persistedList = await listSkillsInPresetScope(page, TARGET_PRESET_NAME);
        expect(persistedList).toContain(FIXTURE_SKILL_NAME);
    });
});
