// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #45 — Card-bound and local same-name coexistence: a card ships an
//        embedded preset named "Foo" with a distinctive temperature, and
//        the user's local library has a separate preset also named "Foo"
//        with a different temperature. Both must appear in the selector
//        (grouped by origin), and manual switch must load the correct
//        body per origin — name shadowing across origins is forbidden.
//
// REAL USER-GESTURE flow:
//   1. Seed a card with `data.extensions.luker.chat_completion_preset =
//      { presets: [{name:'ConflictFoo', preset:{temperature:0.13}}],
//        defaultPresetName:'ConflictFoo' }` via writeEmbeddedCharacter.
//   2. Boot Luker, select the card via the visible list so onCharacterChange
//      renders the Card-bound optgroup.
//   3. Save a local global preset also named 'ConflictFoo' with a distinct
//      temperature via the visible Save-preset-as icon (real click gesture).
//   4. Verify #settings_preset_openai now contains BOTH a card-bound option
//      (data-luker-char-bound="1", inside optgroup[data-luker-card-bound="1"])
//      and a local option (no data-luker-char-bound, outside that optgroup)
//      with identical labels.
//   5. Verify the default card-bound entry auto-applied (temp counter = card
//      value). Then switch to the local same-name preset via selectPresetByName
//      and verify temp counter reflects the LOCAL value. Then switch back to
//      the card option via its ghost value and verify the CARD value is
//      restored. This proves origin-based body dispatch, not name-based
//      shadowing.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, selectPresetByName, savePresetAsViaButton, setCounterInput } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Riven the Locksmith';
const CHAR_AVATAR = 'riven-the-locksmith.png';

const CONFLICT_NAME = 'ConflictFoo';
const CARD_TEMPERATURE = 0.13;
const LOCAL_TEMPERATURE = 0.87;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'card-vs-local-same-name',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Card carries one embedded preset with a distinctive temperature so
    // downstream DOM assertions can prove which body was applied without
    // matching prompt content.
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: {
            name: CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: CONFLICT_NAME, preset: { temperature: CARD_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: CONFLICT_NAME,
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

test.describe('#45 — card-bound preset and same-named local global preset coexist without shadowing', () => {
    test('both options appear grouped by origin and manual switch loads the correct body per origin', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await selectCharacterByName(page, CHAR_NAME);

        // Wait for the card-bound optgroup to render with the conflict name.
        const optState = await page.waitForFunction((name) => {
            const optgroup = document.querySelector('#settings_preset_openai optgroup[data-luker-card-bound="1"]');
            if (!optgroup) return false;
            const opts = Array.from(optgroup.querySelectorAll('option[data-luker-char-bound="1"]'));
            return opts.some(o => o.textContent === name);
        }, CONFLICT_NAME, { timeout: 15_000 });
        expect(await optState.jsonValue()).toBeTruthy();

        // Card default should have auto-applied to temp counter.
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_TEMPERATURE, 5);

        // To create a local preset that name-collides with the card slot,
        // FIRST switch off the card-bound option — otherwise saveOpenAIPreset
        // detects the card-bound origin + matching name and routes the write
        // to updateCharacterBoundPreset (see openai.js:saveOpenAIPreset), so
        // no new local preset ever gets created.
        await selectPresetByName(page, 'Default');

        // Now change the temperature to the LOCAL value, then Save-As under
        // the conflict name. savePresetAsViaButton drives the visible
        // #new_oai_preset icon → name popup → OK, so this is a real gesture
        // path.
        //
        // setCounterInput fires a jQuery input/change event which mutates
        // oai_settings.temperature via ST's canonical slider handler.
        await setCounterInput(page, '#temp_counter_openai', LOCAL_TEMPERATURE);
        await savePresetAsViaButton(page, CONFLICT_NAME);

        // Both options should now exist in the selector — one card-bound
        // (inside the optgroup) and one local (outside), with identical
        // labels but distinct values.
        const bothPresent = await page.evaluate((name) => {
            const cardOpt = document.querySelector(
                `#settings_preset_openai optgroup[data-luker-card-bound="1"] option[data-luker-char-bound="1"]`,
            );
            const cardMatches = cardOpt && cardOpt.textContent === name;
            const localOpts = Array.from(document.querySelectorAll('#settings_preset_openai > option'))
                .filter(o => o.textContent === name && !o.hasAttribute('data-luker-char-bound'));
            return {
                card: cardMatches ? cardOpt.value : null,
                localCount: localOpts.length,
                localValue: localOpts[0]?.value ?? null,
            };
        }, CONFLICT_NAME);
        expect(bothPresent.card).toBeTruthy();
        expect(bothPresent.card.startsWith('__luker_card__::')).toBe(true);
        expect(bothPresent.localCount).toBe(1);
        expect(bothPresent.localValue).toBeTruthy();
        expect(bothPresent.localValue.startsWith('__luker_card__::')).toBe(false);

        // Save-as landed on the local preset, so temperature counter should
        // already reflect the local value. Assert to lock the state.
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(LOCAL_TEMPERATURE, 5);

        // Now switch back to the card-bound option via its ghost value.
        // Using jQuery selectOption bypasses the hidden select2 wrapper
        // (same pattern as selectPresetByName in _helpers.js).
        await page.evaluate(({ ghostValue }) => {
            const $sel = window.jQuery?.('#settings_preset_openai');
            if (!$sel?.length) throw new Error('settings_preset_openai not found');
            $sel.val(String(ghostValue)).trigger('change');
        }, { ghostValue: bothPresent.card });

        // Card body must be restored — this proves origin-scoped body
        // dispatch. If the runtime name-shadowed via local, the temperature
        // would stick on the local value.
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_TEMPERATURE, 5);

        // Switch back to the local option by label — selectPresetByName
        // uses jQuery to match on textContent, which for the local option
        // resolves to the same string as the card option's label. The
        // matcher takes the FIRST match; verify it lands on local (not card)
        // by asserting the temperature counter reflects the local body.
        //
        // But: because card option is prepended (first), selectPresetByName's
        // .first() may catch it. Use the specific local value instead.
        await page.evaluate(({ localValue }) => {
            const $sel = window.jQuery?.('#settings_preset_openai');
            $sel.val(String(localValue)).trigger('change');
        }, { localValue: bothPresent.localValue });

        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(LOCAL_TEMPERATURE, 5);
    });
});
