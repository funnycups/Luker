// #42 — CPA iter-studio is transparent to card-bound presets: opening the
//        assistant on a character-bound preset is not blocked, and Apply
//        writes back onto the card slot (via saveOpenAIPreset dispatch
//        added in the multi-preset card binding series).
//
// Guard the deletion in commit "let CPA iterate character-bound presets
// via ctx dispatch": prior to this change, openCpaIteration bailed with
// toast "Current preset is not a stored chat completion preset. Please
// select a saved preset first." whenever the current preset came from a
// character card. The transparent path now returns stored:true for
// card-bound refs; this test locks the end-to-end behavior:
//
//   1. Seed a character with a card-bound preset "CardEdit" (temp 0.27),
//      plus a same-named global preset (temp 0.55) to prove dispatch is
//      origin-aware — the Apply must not accidentally overwrite the
//      global.
//   2. Select the character; wait for the card-bound preset to auto-
//      apply (ghost option selected, #temp_counter_openai shows 0.27).
//   3. Open the CPA iter-studio via real drawer + open-assistant clicks
//      (openIterStudio helper). If the guard were still in place, this
//      would show a toast warning and the popup would never mount.
//   4. Script mock LLM to return `preset_set_field` for temperature=0.53.
//   5. Send + Apply via real buttons.
//   6. Assert:
//      (a) card slot's stored body now has temperature 0.53
//      (b) same-named global preset still has temperature 0.55
//      (c) selected option is still the card-bound ghost (no re-selection
//          to the global name).

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, setCounterInput, selectPresetByName, savePresetAsViaButton } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CHAR_NAME = 'Cora the Cartographer';
const CHAR_AVATAR = 'cora-the-cartographer.png';
const SHARED_NAME = 'CardEdit';
const CARD_TEMPERATURE_SEED = 0.27;
const GLOBAL_TEMPERATURE = 0.55;
const APPLIED_TEMPERATURE = 0.53;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cpa-card-bound-transparent',
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

test.describe('#42 — CPA iter-studio on card-bound preset: opens, iterates, Apply writes to card', () => {
    test('open + preset_set_field via mock → card slot body updated, same-named global untouched', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // -------- Create the same-named global preset (0.55) first --------
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', GLOBAL_TEMPERATURE);
        await savePresetAsViaButton(page, SHARED_NAME);

        // -------- Select the character; card-bound preset auto-applies --------
        await selectCharacterByName(page, CHAR_NAME);
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 15_000 });
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(CARD_TEMPERATURE_SEED, 5);

        // -------- Open CPA iter-studio — this is what the guard used to block --------
        // Prior to guard deletion: openCpaIteration would toast + return
        // because getLive on a character-origin ref returned stored:false.
        // getLive now returns stored:true for card-bound refs, no guard
        // blocks the popup.
        await openIterStudio(page, 'cpa');

        // -------- Script LLM to lower temperature and Send --------
        mock.scriptToolCall({
            name: 'preset_set_field',
            arguments: {
                path: 'temperature',
                value_json: JSON.stringify(APPLIED_TEMPERATURE),
                reason: 'e2e #42: transparent CPA on card-bound preset',
            },
        });

        await sendIterPrompt(page, 'cpa', 'Lower temperature for a steadier voice on this character.');

        // -------- Apply via real button --------
        await applyIterBatch(page, 'cpa');
        await closeIterStudio(page);

        // -------- Assertion (a): card slot body has the applied temperature --------
        await expect
            .poll(() => readCardBoundPresetBody(server.dataRoot, CHAR_AVATAR, SHARED_NAME)?.temperature, { timeout: 10_000 })
            .toBeCloseTo(APPLIED_TEMPERATURE, 5);

        // -------- Assertion (b): same-named global preset is UNCHANGED --------
        // If dispatch mis-fired, the global's temperature would have moved
        // to APPLIED_TEMPERATURE. Runtime state is the ground truth here
        // (CPA calls saveOpenAIPreset which writes both runtime + disk).
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
        const selectedValueStartsWithSentinel = await page.evaluate(() => {
            const v = document.querySelector('#settings_preset_openai')?.value ?? '';
            return String(v).startsWith('__luker_card__::');
        });
        expect(selectedValueStartsWithSentinel).toBe(true);
    });
});
