// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #52 — Card-bound preset export → import roundtrip on the same Luker.
//
// Semantics: a card-bound preset exported to disk and re-imported lands
// as a plain global preset. The importer does NOT auto-rebind it to any
// card; the card's slot state is unchanged.
//
// REAL USER-GESTURE flow:
//   1-4. Same as #51 (seed card + colliding global preset + auto-apply
//        + preset-scope skill + real Export click → download captured).
//   5. Switch back to a real global preset (Default) so import isn't
//      confused by the still-selected ghost row.
//   6. Import the downloaded file via visible Import icon → hidden file
//      input; the import flow surfaces a name popup, we type
//      'ImportedFromCard'.
//   7. Assert:
//      (a) data/<user>/OpenAI Settings/ImportedFromCard.json exists
//          (server /api/presets/save wrote it).
//      (b) That file's body matches the exported JSON byte-for-byte
//          (including extensions.luker.embedded_skills_source).
//      (c) The card's PNG chat_completion_preset block is unchanged
//          (import did NOT touch the card).
//      (d) The colliding global CardBoundExportSlot.json is unchanged
//          (import uses the new name, does NOT overwrite the collider).

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter, disableTagImportPopup } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CARD_NAME = 'Roundtrip Test Card';
const CARD_AVATAR = 'roundtrip-test-card.png';
const SLOT_NAME = 'CardBoundExportSlot';
const IMPORTED_NAME = 'ImportedFromCard';
const SLOT_TEMPERATURE = 0.31;
const GLOBAL_COLLIDING_TEMPERATURE = 0.99;
const FIXTURE_SKILL_NAME = 'p52-roundtrip-skill';
const FIXTURE_BODY_ANCHOR = '# Body anchor: roundtrip v1';

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
    const popupClicker = (async () => {
        try {
            const popup = page
                .locator('.popup:visible', { has: page.locator('.luker_skill_export_confirm') })
                .last();
            await popup.locator('.popup-button-ok').first().click({ timeout: 25_000 });
        } catch (_) { /* no popup — ignore */ }
    })();
    await page.locator('#export_oai_preset').click();
    await popupClicker;
    return dl;
}

/**
 * Install a fixture skill into the given preset scope via the public
 * ctx.skills API. Uses the same inline-files-v1 payload shape as e2e #36.
 */
async function installFixtureSkillInPresetScope(page, presetName, skillName, bodyAnchor) {
    const payload = {
        version: 1,
        items: [{
            bundleFormat: 'inline-files-v1',
            name: skillName,
            description: 'e2e #52 fixture — preset-scope skill for roundtrip.',
            files: [{
                path: 'SKILL.md',
                encoding: 'utf8',
                content: [
                    '---',
                    `name: ${skillName}`,
                    'description: "e2e #52 fixture: preset-scope skill for roundtrip."',
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

/**
 * Import a preset file via the visible Import icon and hidden file input.
 * The importer uses the file's basename (minus extension) as the preset
 * name — there is no naming popup — so callers must rename the file on
 * disk before calling this. If a colliding name is already loaded an
 * overwrite confirm popup surfaces; we do NOT auto-confirm it because
 * this test's assertion (d) explicitly guards against overwrite.
 */
async function importPresetFile(page, filePath, { expectedName }) {
    await openAiResponseConfigDrawer(page);
    await page.locator('#import_oai_preset').click();
    const input = page.locator('#openai_preset_import_file');
    await input.setInputFiles(filePath);
    await page.waitForFunction((name) => {
        try {
            const ctx = window.SillyTavern?.getContext?.() || window.Luker?.getContext?.();
            return !!ctx?.openai?.settingNames && Number.isInteger(ctx.openai.settingNames[name]);
        } catch { return false; }
    }, expectedName, { timeout: 20_000 });
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-export-import-roundtrip',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });

    const globalPresetPath = path.join(
        server.dataRoot, 'default-user/OpenAI Settings', `${SLOT_NAME}.json`,
    );
    fs.mkdirSync(path.dirname(globalPresetPath), { recursive: true });
    fs.writeFileSync(globalPresetPath, JSON.stringify({
        temperature: GLOBAL_COLLIDING_TEMPERATURE,
        chat_completion_source: 'openai',
    }, null, 4));

    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SLOT_NAME, preset: { temperature: SLOT_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SLOT_NAME,
                    },
                },
            },
        },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#52 — card-bound export → import roundtrip lands as new global preset', () => {
    test('import creates new global; body matches; card slot unchanged; collider untouched', async ({ page }, testInfo) => {
        test.setTimeout(240_000);
        await awaitMainUI(page, server.baseURL);

        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.extensionSettings?.orchestrator;
        }, { timeout: 20_000 });

        await selectCharacterByName(page, CARD_NAME);
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 15_000 });

        await installFixtureSkillInPresetScope(page, SLOT_NAME, FIXTURE_SKILL_NAME, FIXTURE_BODY_ANCHOR);

        // Export.
        const dl = await exportSelectedPreset(page);
        const downloadPath = testInfo.outputPath('52-export.json');
        await dl.saveAs(downloadPath);
        const exportedBody = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));

        // Sanity: the exported body must be the card slot body (temp
        // 0.31), not the colliding global body (temp 0.99). Without this
        // guard, the roundtrip assertion (b) below is vacuously true even
        // when export dispatches to the wrong body — the imported file
        // would just match whatever body was exported, however wrong.
        expect(exportedBody.temperature).toBe(SLOT_TEMPERATURE);
        expect(exportedBody.temperature).not.toBe(GLOBAL_COLLIDING_TEMPERATURE);
        // Same guard for the skills bundle — proves the export hook
        // resolved the preset scope from the emitted name (slot name),
        // not from the stale `oai_settings.preset_settings_openai`.
        const embeddedItems = exportedBody?.extensions?.luker?.embedded_skills_source?.items;
        const bundledNames = Array.isArray(embeddedItems) ? embeddedItems.map(i => i?.name) : [];
        expect(bundledNames).toContain(FIXTURE_SKILL_NAME);

        // Record card slot state + colliding global mtime.
        const cardPath = path.join(server.dataRoot, 'default-user/characters', CARD_AVATAR);
        const cardBeforeJson = readPngCard(fs.readFileSync(cardPath));
        const cardBoundBefore = JSON.stringify(
            JSON.parse(cardBeforeJson).data.extensions.luker.chat_completion_preset,
        );
        const globalCollidingPath = path.join(
            server.dataRoot, 'default-user/OpenAI Settings', `${SLOT_NAME}.json`,
        );
        const globalCollidingMtimeBefore = fs.statSync(globalCollidingPath).mtimeMs;
        const globalCollidingBodyBefore = fs.readFileSync(globalCollidingPath, 'utf8');

        // Switch back to a plain global preset so import isn't confused
        // by the still-selected ghost row.
        await page.evaluate(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = Array.from(sel?.querySelectorAll('option') || [])
                .find(o => o.getAttribute('data-luker-char-bound') !== '1'
                    && o.textContent.trim() === 'Default');
            if (opt && window.jQuery) {
                window.jQuery(sel).val(opt.value).trigger('change');
            }
        });
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const selected = sel?.selectedOptions?.[0];
            return selected && selected.getAttribute('data-luker-char-bound') !== '1';
        }, { timeout: 10_000 });

        // Import. Rename the download on disk so the importer uses
        // IMPORTED_NAME (importer strips the extension and uses that as
        // the preset name — it does NOT prompt for a name).
        const renamedPath = testInfo.outputPath(`${IMPORTED_NAME}.json`);
        fs.copyFileSync(downloadPath, renamedPath);
        await importPresetFile(page, renamedPath, { expectedName: IMPORTED_NAME });

        // (a) new global preset file exists.
        const importedPath = path.join(
            server.dataRoot, 'default-user/OpenAI Settings', `${IMPORTED_NAME}.json`,
        );
        expect(fs.existsSync(importedPath)).toBe(true);

        // (b) body matches exported JSON byte-for-byte.
        const importedBody = JSON.parse(fs.readFileSync(importedPath, 'utf8'));
        expect(JSON.stringify(importedBody)).toBe(JSON.stringify(exportedBody));

        // (c) card slot state unchanged.
        const cardAfterJson = readPngCard(fs.readFileSync(cardPath));
        const cardBoundAfter = JSON.stringify(
            JSON.parse(cardAfterJson).data.extensions.luker.chat_completion_preset,
        );
        expect(cardBoundAfter).toBe(cardBoundBefore);

        // (d) colliding global preset file untouched.
        const globalCollidingMtimeAfter = fs.statSync(globalCollidingPath).mtimeMs;
        expect(globalCollidingMtimeAfter).toBe(globalCollidingMtimeBefore);
        expect(fs.readFileSync(globalCollidingPath, 'utf8')).toBe(globalCollidingBodyBefore);
    });
});
