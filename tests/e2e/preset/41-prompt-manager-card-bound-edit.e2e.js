// #41 — saveOpenAIPreset routes to card-bound update when a card-bound
//        preset is currently selected and the requested name matches.
//
// This exercises the dispatch added to public/scripts/openai.js
// saveOpenAIPreset via public/scripts/character/save-dispatch.js. The
// #new_oai_preset ("Save preset as") button pre-fills the name dialog
// with the current card-bound preset's name (see
// public/scripts/openai.js:onNewPresetClick); accepting that name calls
// saveOpenAIPreset(<cardBoundName>, oai_settings), which — with the
// dispatch — must write the LIVE oai_settings body onto the card slot
// rather than creating a new global preset.
//
// REAL USER-GESTURE flow:
//   1. Seed a card with a bound preset {SFW Story: {temperature:0.27}}
//      and a global preset of the SAME name but different temperature
//      (0.55). Same-name distinction is what proves the dispatch is
//      origin-aware, not just name-aware.
//   2. Select the character; wait for the card-bound preset to auto-apply
//      (temp_counter reflects 0.27).
//   3. Edit the temperature via the visible counter to a distinctive value
//      (0.71) so oai_settings.temp_openai diverges from both stored bodies.
//   4. Click "Save preset as" (#new_oai_preset) → dialog opens with the
//      card-bound name pre-filled → accept.
//   5. Assert:
//      (a) The card slot's stored body now has temperature 0.71 (dispatch
//          fired → updateCharacterBoundPreset ran).
//      (b) The global preset with the same name still has 0.55 (dispatch
//          skipped the global path).
//      (c) The DOM selector still points at the card-bound ghost option,
//          NOT at the global option — i.e. no re-selection loop.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, setCounterInput, selectPresetByName, savePresetAsViaButton, ensureOaiDrawerOpen } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CHAR_NAME = 'Marla the Chartmaker';
const CHAR_AVATAR = 'marla-the-chartmaker.png';
const SHARED_NAME = 'SFW Story';
const CARD_TEMPERATURE_SEED = 0.27;
const GLOBAL_TEMPERATURE = 0.55;
const EDITED_TEMPERATURE = 0.71;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'card-bound-save-dispatch',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: {
            name: CHAR_NAME,
            extensions: {
                luker: {
                    chat_completion_preset: {
                        presets: [
                            { name: SHARED_NAME, preset: { temperature: CARD_TEMPERATURE_SEED, chat_completion_source: 'openai' } },
                        ],
                        defaultPresetName: SHARED_NAME,
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

/** Read the card-bound preset body for a given slot name from the on-disk PNG. */
function readCardBoundPresetBody(dataRoot, avatarFile, name) {
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    const state = card?.data?.extensions?.luker?.chat_completion_preset;
    if (!state || !Array.isArray(state.presets)) return null;
    return state.presets.find(p => p?.name === name)?.preset ?? null;
}

test.describe('#41 — saveOpenAIPreset dispatch: card-bound selected + matching name → update card, leave global alone', () => {
    test('save-as with pre-filled card-bound name writes to card slot, not to same-named global', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // -------- Create the same-named global preset (0.55) first --------
        // Start from Default, set the distinctive global temperature, then
        // save-as under SHARED_NAME. This creates a global preset that
        // collides in name with the card slot.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', GLOBAL_TEMPERATURE);
        await savePresetAsViaButton(page, SHARED_NAME);

        // -------- Select the character; card-bound preset auto-applies --------
        await selectCharacterByName(page, CHAR_NAME);
        // Wait for the ghost optgroup to be populated and the default to apply.
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 15_000 });
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_TEMPERATURE_SEED, 5);

        // -------- Edit temperature to a distinctive new value --------
        await setCounterInput(page, '#temp_counter_openai', EDITED_TEMPERATURE);

        // -------- Click "Save preset as" and accept the pre-filled card-bound name --------
        // onNewPresetClick pre-fills the dialog with getSelectedCardBoundName()
        // (i.e. SHARED_NAME) when a card-bound option is selected. Accepting
        // that value with saveOpenAIPreset(SHARED_NAME, ...) must dispatch
        // to the card branch — NOT create/overwrite the global.
        await ensureOaiDrawerOpen(page);
        await page.locator('#new_oai_preset').click();
        const popup = page.locator('.popup:visible').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        const input = popup.locator('input[type="text"], textarea').first();
        await input.waitFor({ state: 'visible', timeout: 5000 });
        // Confirm the dialog pre-fill is the card-bound name (regression
        // guard: if this ever changes we want to know).
        await expect(input).toHaveValue(SHARED_NAME);
        await popup.locator('.popup-button-ok').first().click();
        await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

        // -------- Assertion (a): card slot body has the edited temperature --------
        await expect
            .poll(() => readCardBoundPresetBody(server.dataRoot, CHAR_AVATAR, SHARED_NAME)?.temperature, { timeout: 10_000 })
            .toBeCloseTo(EDITED_TEMPERATURE, 5);

        // -------- Assertion (b): same-named global preset is UNCHANGED --------
        // Read the runtime openai_settings state: the global with SHARED_NAME
        // should still hold GLOBAL_TEMPERATURE (0.55), NOT the edited value.
        const globalBodyTemperature = await page.evaluate((n) => {
            const openai = window.Luker?.getContext?.()?.openai;
            const settings = openai?.settings;
            const names = openai?.settingNames;
            if (!Array.isArray(settings) || !names) return null;
            const idx = names[n];
            if (!Number.isInteger(idx)) return null;
            return settings[idx]?.temperature ?? null;
        }, SHARED_NAME);
        expect(globalBodyTemperature).toBeCloseTo(GLOBAL_TEMPERATURE, 5);

        // -------- Assertion (c): selector still points at the card-bound ghost option --------
        // If dispatch mis-fired to global, onNewPresetClick's downstream
        // trigger('change') would flip the selector to the global option.
        // The card branch skips that trigger by design.
        const selectedValueStartsWithSentinel = await page.evaluate(() => {
            const v = document.querySelector('#settings_preset_openai')?.value ?? '';
            return String(v).startsWith('__luker_card__::');
        });
        expect(selectedValueStartsWithSentinel).toBe(true);
    });
});
