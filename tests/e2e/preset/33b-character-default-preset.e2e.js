// #33b — Per-character default preset auto-activates on character switch.
//
// REAL USER-GESTURE flow:
//   1. Seed two characters (Ash + Iyana).
//   2. Create two presets named exactly after each character via the visible
//      save-as button (#new_oai_preset).
//   3. Click each character's card; autoSelectPreset picks the preset whose
//      name matches the character.name. Assert via DOM (#temp_counter_openai).
//   4. Server restart → re-click cards → re-assert via DOM.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, selectPresetByName, savePresetAsViaButton, setCounterInput } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const ASH_NAME = 'Ash the Cartographer';
const IYANA_NAME = 'Iyana the Watchwoman';

const VALUES_ASH = { temperature: 0.33, top_p: 0.66 };
const VALUES_IYANA = { temperature: 0.81, top_p: 0.43 };

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'char-default-preset',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'ash-the-cartographer.png', overrides: { name: ASH_NAME } });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'iyana-the-watchwoman.png',
        overrides: {
            name: IYANA_NAME,
            description: 'A reserved watchwoman who walks the eastern stretch of the Bryn headland.',
            personality: 'Reserved and steady; keeps her hands in her sleeves.',
            scenario: 'You and Iyana share the eastern watch.',
            first_mes: '*Iyana lifts a hand in greeting and does not speak first.*',
        },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#33b — per-character default preset (name-match autoSelect) (real UI)', () => {
    test('character switch picks the preset whose name matches; restart preserves the binding', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Ensure the character list is populated. The bootstrap fetches it
        // from disk but a fresh data dir may need an explicit re-load.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(({ a, b }) => {
            const ctx = window.Luker?.getContext?.();
            return ctx && [a, b].every(n => ctx.characters?.some(c => c?.name === n));
        }, { a: ASH_NAME, b: IYANA_NAME }, { timeout: 15_000 });

        // Step 1: Save Ash's preset (name === ASH_NAME).
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', VALUES_ASH.temperature);
        await setCounterInput(page, '#top_p_counter_openai', VALUES_ASH.top_p);
        await savePresetAsViaButton(page, ASH_NAME);

        // Save Iyana's preset (name === IYANA_NAME).
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', VALUES_IYANA.temperature);
        await setCounterInput(page, '#top_p_counter_openai', VALUES_IYANA.top_p);
        await savePresetAsViaButton(page, IYANA_NAME);

        // Step 2: Click Ash's card.
        await selectCharacterByName(page, ASH_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_ASH.temperature, 5);
        await expect.poll(async () => Number(await page.locator('#top_p_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_ASH.top_p, 5);

        // Step 3: Iyana's card.
        await selectCharacterByName(page, IYANA_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_IYANA.temperature, 5);

        // Step 4: Back to Ash.
        await selectCharacterByName(page, ASH_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_ASH.temperature, 5);

        // Step 5: Restart + reload, re-click Ash, re-assert.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, ASH_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 15_000 }).toBeCloseTo(VALUES_ASH.temperature, 5);
    });
});
