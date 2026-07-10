// #40 — Character card with multi-slot embedded chat completion presets:
//        ghost optgroup renders one option per preset, defaultPresetName
//        auto-applies, manual switch swaps body via runtime cache.
//
// REAL USER-GESTURE flow:
//   1. Seed a card with `data.extensions.luker.chat_completion_preset =
//      { presets: [{name, preset:{temperature,...}}], defaultPresetName }`
//      via writeEmbeddedCharacter (uses writePngCard directly — the same
//      writer real card exports use, so this is on-disk state Luker's
//      /api/characters loader parses natively).
//   2. Select the card via the visible list.
//   3. Assert ghost <optgroup data-luker-card-bound="1"> exists in
//      #settings_preset_openai with the expected two <option> labels.
//   4. Assert the defaultPresetName body was applied (poll temp counter).
//   5. selectOption('#settings_preset_openai', 'Combat') via jQuery
//      (Playwright's selectOption rejects hidden select2), assert temp
//      counter now reflects the Combat body.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const MULTI_NAME = 'Marla the Chartmaker';
const MULTI_AVATAR = 'marla-the-chartmaker.png';

const SFW_PRESET_NAME = 'SFW Story';
const COMBAT_PRESET_NAME = 'Combat';
const SFW_TEMPERATURE = 0.27;
const COMBAT_TEMPERATURE = 0.91;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'card-multi-slot',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Card carries pre-populated multi-slot bindings under
    // `data.extensions.luker.chat_completion_preset =
    // {presets: [...], defaultPresetName}`. The two presets have
    // distinguishable temperatures so DOM assertions can prove which body
    // was applied without matching prompt content.
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: MULTI_AVATAR,
        overrides: {
            name: MULTI_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SFW_PRESET_NAME, preset: { temperature: SFW_TEMPERATURE, chat_completion_source: 'openai' } },
                            { name: COMBAT_PRESET_NAME, preset: { temperature: COMBAT_TEMPERATURE, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SFW_PRESET_NAME,
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

test.describe('#40 — multi-slot card-bound presets: optgroup + default apply + manual swap', () => {
    test('card with two bound presets renders ghost optgroup and applies default, manual switch swaps body', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await selectCharacterByName(page, MULTI_NAME);

        // Ghost optgroup renders inside #settings_preset_openai.
        // Poll — the select2 wrapper obscures the native <select>, so we
        // interrogate the native node via evaluate, not locators.
        const optgroupState = await page.waitForFunction(() => {
            const optgroup = document.querySelector('#settings_preset_openai optgroup[data-luker-card-bound="1"]');
            if (!optgroup) return false;
            const options = Array.from(optgroup.querySelectorAll('option[data-luker-char-bound="1"]'));
            return { count: options.length, labels: options.map(o => o.textContent) };
        }, { timeout: 15_000 });
        const groupSnapshot = await optgroupState.jsonValue();
        expect(groupSnapshot.count).toBe(2);
        expect(groupSnapshot.labels).toEqual([SFW_PRESET_NAME, COMBAT_PRESET_NAME]);

        // defaultPresetName auto-applied via onSettingsPresetChange, which
        // reads the body from characterBoundPresetState.runtimeOptions.
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(SFW_TEMPERATURE, 5);

        // Manual switch → Combat. selectOption bypasses the hidden select2
        // via a direct jQuery change (same pattern as selectPresetByName
        // in tests/e2e/preset/_helpers.js).
        await page.evaluate(({ target }) => {
            const $sel = window.jQuery?.('#settings_preset_openai');
            if (!$sel?.length) throw new Error('settings_preset_openai not found');
            const opt = $sel.find('option[data-luker-char-bound="1"]').filter((_i, el) => el.textContent === target).first();
            if (!opt.length) throw new Error(`card-bound option not found: ${target}`);
            $sel.val(String(opt.val())).trigger('change');
        }, { target: COMBAT_PRESET_NAME });

        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(COMBAT_TEMPERATURE, 5);

        // Selected option's ghost-value must decode back to
        // {avatar: MULTI_AVATAR, name: COMBAT_PRESET_NAME}: the origin the
        // ctx layer will report to any preset-state consumer.
        const selectedValue = await page.evaluate(() => document.querySelector('#settings_preset_openai').value);
        expect(selectedValue.startsWith('__luker_card__::')).toBe(true);
        expect(selectedValue).toContain(encodeURIComponent(MULTI_AVATAR));
        expect(selectedValue).toContain(encodeURIComponent(COMBAT_PRESET_NAME));
    });
});
