// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #51 — Card-bound preset export via visible Export button.
//
// REAL USER-GESTURE flow:
//   1. Seed a card with slot 'CardBoundExportSlot' (default, temperature=0.31)
//      plus a preset-scope skill so the export bundles skills too.
//   2. Preseed a colliding global preset with the same name but a distinct
//      body (temperature=0.99). Asserts export does not silently substitute
//      the global body for the card slot body.
//   3. Load Luker → select the card → ghost auto-apply.
//   4. Open AI Response Configuration drawer → click #export_button (real
//      visible gesture) → capture the Playwright download event.
//   5. Assert:
//      (a) download.suggestedFilename() === 'CardBoundExportSlot.json'
//          (slot name, not stale global name).
//      (b) exported.temperature === SLOT_TEMPERATURE (0.31, not the
//          global collision 0.99).
//      (c) exported.extensions.luker.embedded_skills_source lists the
//          preset-scope fixture skill (skills bundle attached).
//      (d) The global colliding preset file on disk was not touched
//          (mtime unchanged, body unchanged) — export must not write.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter, disableTagImportPopup } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Export Test Card';
const CARD_AVATAR = 'export-test-card.png';
const SLOT_NAME = 'CardBoundExportSlot';
const SLOT_TEMPERATURE = 0.31;
const GLOBAL_COLLIDING_TEMPERATURE = 0.99;
const FIXTURE_SKILL_NAME = 'p51-cardbound-export-skill';
const FIXTURE_BODY_ANCHOR = '# Body anchor: card-bound export v1\n\nRoundtrip fixture body.';

async function openAiResponseConfigDrawer(page) {
    const block = page.locator('#left-nav-panel');
    const isOpen = await block.evaluate(el => el && el.classList.contains('openDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#leftNavDrawerIcon').click();
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Click the visible Export button; auto-accept the skills-include popup so
 * the export bundles the preset-scope skill (assertion c). Returns the
 * captured Playwright download.
 */
async function exportSelectedPreset(page) {
    await openAiResponseConfigDrawer(page);
    const dl = page.waitForEvent('download', { timeout: 30_000 });
    const popupClicker = (async () => {
        try {
            const popup = page
                .locator('.popup:visible', { has: page.locator('.luker_skill_export_confirm') })
                .last();
            await popup.waitFor({ state: 'visible', timeout: 10_000 });
            await popup.locator('.popup-button-ok, [data-i18n="Include"]').first().click();
        } catch (_) { /* no skills / no popup — ignore */ }
    })();
    await page.locator('#export_oai_preset').click();
    await popupClicker;
    return dl;
}

/**
 * Install a fixture skill into the given preset scope via the public
 * ctx.skills API. Uses the same inline-files-v1 payload shape as e2e #36
 * (36-embedded-skills-roundtrip) — that shape is proven against
 * executeExtractEmbed while the simpler {name,description,body} shape
 * would need bundleFormat plumbing we don't need to introduce here.
 */
async function installFixtureSkillInPresetScope(page, presetName, skillName, bodyAnchor) {
    const payload = {
        version: 1,
        items: [{
            bundleFormat: 'inline-files-v1',
            name: skillName,
            description: 'e2e #51 fixture — preset-scope skill for card-bound export.',
            files: [{
                path: 'SKILL.md',
                encoding: 'utf8',
                content: [
                    '---',
                    `name: ${skillName}`,
                    'description: "e2e #51 fixture: preset-scope skill for card-bound export."',
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

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-export',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    disableTagImportPopup({ dataRoot: server.dataRoot });

    // Preseed the colliding global preset with a distinct body — asserts
    // assertion (b)/(d) that export doesn't pick up global body and doesn't
    // rewrite the global file.
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

test.describe('#51 — card-bound preset export uses slot body + slot name', () => {
    test('filename = slot name; body = slot body; skills bundled; global collider untouched', async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        await awaitMainUI(page, server.baseURL);

        // Wait for orchestrator to register its OAI_PRESET_EXPORT_READY
        // listener (mounted inside jQuery(() => { ... }) after settings
        // hydrate). Without it the popup never appears, assertion (c)
        // fails for the wrong reason.
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.extensionSettings?.orchestrator;
        }, { timeout: 20_000 });

        await selectCharacterByName(page, CARD_NAME);

        // Wait for ghost auto-apply — the card-bound slot must be the
        // selected option in #settings_preset_openai. Use DOM state (public
        // signal) rather than the __characterBoundPresetState test hook.
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 15_000 });

        // Install a preset-scope skill under the slot name — this is the
        // scope key the export hook will pass to skills.list once we fix
        // resolvePresetName to use the emitted presetName instead of the
        // stale oai_settings.preset_settings_openai.
        await installFixtureSkillInPresetScope(page, SLOT_NAME, FIXTURE_SKILL_NAME, FIXTURE_BODY_ANCHOR);

        const globalPresetPath = path.join(
            server.dataRoot, 'default-user/OpenAI Settings', `${SLOT_NAME}.json`,
        );
        const mtimeBefore = fs.statSync(globalPresetPath).mtimeMs;

        // Trigger export.
        const dl = await exportSelectedPreset(page);

        // (a) filename = slot name.
        expect(dl.suggestedFilename()).toBe(`${SLOT_NAME}.json`);

        const downloadPath = testInfo.outputPath('51-export.json');
        await dl.saveAs(downloadPath);
        const exported = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));

        // (b) body === card slot body. The card slot only carries
        // temperature + chat_completion_source; the export path may sync
        // additional fields back onto the slot before serialization, so we
        // pin the specific slot field rather than canonicalJson.
        expect(exported.temperature).toBe(SLOT_TEMPERATURE);
        expect(exported.temperature).not.toBe(GLOBAL_COLLIDING_TEMPERATURE);

        // (c) skills bundle attached under embedded_skills_source.
        const embedded = exported?.extensions?.luker?.embedded_skills_source;
        expect(embedded, 'exported body should carry embedded_skills_source').toBeTruthy();
        const items = Array.isArray(embedded?.items) ? embedded.items : [];
        const bundledNames = items.map(i => i?.name).filter(Boolean);
        expect(bundledNames).toContain(FIXTURE_SKILL_NAME);

        // (d) colliding global preset file untouched (no mtime change,
        // still has the global body).
        const mtimeAfter = fs.statSync(globalPresetPath).mtimeMs;
        expect(mtimeAfter).toBe(mtimeBefore);
        const globalBodyAfter = JSON.parse(fs.readFileSync(globalPresetPath, 'utf8'));
        expect(globalBodyAfter.temperature).toBe(GLOBAL_COLLIDING_TEMPERATURE);
    });
});
