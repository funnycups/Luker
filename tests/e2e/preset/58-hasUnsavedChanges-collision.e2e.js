// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #58 — hasUnsavedOpenAIPresetChanges dispatches through the card slot
//        when the ghost option is DOM-selected, even under a name collision
//        with a global preset. This is the wired-up counterpart to
//        tests/character-presets/openai-has-unsaved-changes.test.js case 1.
//
// This scenario is designed to CATCH the pre-refactor bug (the observed
// user-visible chain): the card slot body equals the live oai_settings
// body, but the same-named global preset body deliberately differs. Old
// code looked up `openai_settings[openai_setting_names['MyPreset']]` and
// reported spurious unsaved changes → user got the "You have unsaved
// changes" popup → clicking "Save and continue" wrote the card body over
// the global preset → user's actual card edits vanished on next restore.
//
// New (origin-aware) code MUST see:
//   • ghost option DOM-selected → readSelectedPresetRef ⇒ character origin
//   • ref.name === 'MyPreset' ⇒ compare live vs card slot body
//   • both equal ⇒ hasUnsavedChanges returns false
//   • global preset body is not consulted at all
//
// REAL USER-GESTURE flow:
//   1. Seed a card with a card-bound slot `MyPreset { temperature: 0.5 }`.
//   2. Seed a global preset with the SAME name and a DIFFERENT temperature
//      (`0.9`) by writing to `default-user/OpenAI Settings/MyPreset.json`
//      before server start.
//   3. Load Luker → the card auto-applies its default slot → live
//      oai_settings.temperature = 0.5 (matches card, not global).
//   4. Call `ctx.openai.hasUnsavedChanges('MyPreset')` through the real
//      wiring (st-context.js:2851). Origin-aware helper must return
//      `false`; pre-refactor helper would have returned `true`.
//   5. Sanity-check: switch to the same-named GLOBAL option (via jQuery
//      change so onSettingsPresetChange runs) and confirm the global body
//      applies → live temperature becomes 0.9. Then flip back to the ghost
//      option and re-check `hasUnsavedChanges('MyPreset')`; it must again
//      be false because the card auto-applies its body on ghost re-entry.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CARD_NAME = 'Collision Test Card';
const CARD_AVATAR = 'collision-test-card.png';
const COLLIDING_NAME = 'MyPreset';
const CARD_TEMPERATURE = 0.5;
const GLOBAL_TEMPERATURE = 0.9;   // deliberately ≠ CARD_TEMPERATURE

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'hasUnsaved-collision',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Global preset seeded on disk before server start so the settings
    // loader picks it up during boot (`src/constants.js:47` maps
    // `OpenAI Settings` → the openai_settings library slot).
    const globalPresetPath = path.join(
        server.dataRoot,
        'default-user',
        'OpenAI Settings',
        `${COLLIDING_NAME}.json`,
    );
    fs.mkdirSync(path.dirname(globalPresetPath), { recursive: true });
    fs.writeFileSync(globalPresetPath, JSON.stringify({
        temperature: GLOBAL_TEMPERATURE,
        chat_completion_source: 'openai',
    }, null, 4));

    // Card carries a same-named slot with a different body.
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: {
            name: CARD_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: COLLIDING_NAME, preset: { temperature: CARD_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: COLLIDING_NAME,
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

test.describe('#58 — hasUnsavedChanges under card / global name collision routes through card slot', () => {
    test('ghost-selected card slot with same name as a divergent global preset reports no unsaved changes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CARD_NAME);

        // Card default auto-applied → ghost is DOM-selected and live temp
        // matches the card slot body.
        await page.waitForFunction(
            () => typeof window.__characterBoundPresetState !== 'undefined'
                && window.__characterBoundPresetState.active === true,
            { timeout: 15_000 },
        );
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_TEMPERATURE, 5);

        // Verify the same-named global preset actually made it into the
        // in-memory library — this is the setup precondition for the
        // origin-awareness assertion below to be meaningful.
        const globalSideCheck = await page.evaluate((name) => {
            const ctx = window.Luker?.getContext?.();
            const settingNames = ctx?.openai?.settingNames;
            const settings = ctx?.openai?.settings;
            const idx = settingNames?.[name];
            return {
                hasIndex: Number.isInteger(idx),
                globalTemp: (Number.isInteger(idx) && settings?.[idx]) ? settings[idx].temperature : null,
            };
        }, COLLIDING_NAME);
        expect(globalSideCheck.hasIndex).toBe(true);
        expect(globalSideCheck.globalTemp).toBeCloseTo(GLOBAL_TEMPERATURE, 5);

        // The origin-awareness assertion. Old (pre-Task-2) code would
        // compare live (0.5) vs openai_settings[MyPreset] (0.9) → true.
        // Origin-aware code sees ghost origin → compares live vs card
        // slot body (0.5 vs 0.5) → false.
        const unsavedUnderGhost = await page.evaluate((name) => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.openai?.hasUnsavedChanges?.(name);
        }, COLLIDING_NAME);
        expect(unsavedUnderGhost).toBe(false);

        // Sanity round-trip: switch to the GLOBAL same-name option (i.e.
        // the option that lives OUTSIDE the card-bound optgroup). This
        // proves the two entries are distinct and that the global body
        // actually applies when we ask for it.
        await page.evaluate(({ name }) => {
            const $ = window.jQuery;
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            const globalOpt = opts.find(o =>
                o.textContent === name
                && o.getAttribute('data-luker-char-bound') !== '1',
            );
            if (!globalOpt) throw new Error(`global option not found for ${name}`);
            $('#settings_preset_openai').val(globalOpt.value).trigger('change');
        }, { name: COLLIDING_NAME });
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(GLOBAL_TEMPERATURE, 5);

        // Flip back to the ghost option → card body must re-apply → live
        // temperature returns to CARD_TEMPERATURE → hasUnsavedChanges must
        // again report false (character branch, live == card).
        await page.evaluate(() => {
            const $ = window.jQuery;
            const ghost = document.querySelector(
                '#settings_preset_openai option[data-luker-char-bound="1"]',
            );
            if (!ghost) throw new Error('ghost option not found after global switch');
            $('#settings_preset_openai').val(ghost.value).trigger('change');
        });
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_TEMPERATURE, 5);

        const unsavedAfterFlipBack = await page.evaluate((name) => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.openai?.hasUnsavedChanges?.(name);
        }, COLLIDING_NAME);
        expect(unsavedAfterFlipBack).toBe(false);
    });
});
