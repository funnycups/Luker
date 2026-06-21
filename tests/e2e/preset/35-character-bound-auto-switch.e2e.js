// #35 — Preset bound to character → switch character auto-switches preset.
//
// REAL USER-GESTURE flow:
//   1. Seed two characters via fixtures.
//   2. Create two presets via visible save UI.
//   3. Select Ash, set PRESET_A active, then bind via #char-management-dropdown
//      → "Bind Current Chat Completion Preset" option (accept popup confirm).
//   4. Repeat for Iyana with PRESET_B.
//   5. Click between cards; the bound preset auto-activates. Assert via DOM.
//   6. Restart, re-click, re-assert via DOM.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, selectPresetByName, savePresetAsViaButton, setCounterInput, bindCurrentPresetToCharacter } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const ASH_NAME = 'Ash the Cartographer';
const IYANA_NAME = 'Iyana the Watchwoman';
const PRESET_A = 'pa-ash-bound';
const PRESET_B = 'pa-iyana-bound';
const VALUES_A = { temperature: 0.39, top_p: 0.71 };
const VALUES_B = { temperature: 0.83, top_p: 0.56 };

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'char-bound',
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

test.describe('#35 — preset bound to character auto-switches with character (real UI)', () => {
    test('per-character bound presets activate on character switch and survive restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Step 1: Save two presets via real UI.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', VALUES_A.temperature);
        await setCounterInput(page, '#top_p_counter_openai', VALUES_A.top_p);
        await savePresetAsViaButton(page, PRESET_A);

        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', VALUES_B.temperature);
        await setCounterInput(page, '#top_p_counter_openai', VALUES_B.top_p);
        await savePresetAsViaButton(page, PRESET_B);

        // Step 2: Ash → PRESET_A → bind.
        await selectCharacterByName(page, ASH_NAME);
        await selectPresetByName(page, PRESET_A);
        await bindCurrentPresetToCharacter(page);

        // Step 3: Iyana → PRESET_B → bind.
        await selectCharacterByName(page, IYANA_NAME);
        await selectPresetByName(page, PRESET_B);
        await bindCurrentPresetToCharacter(page);

        // Step 4: Back to Ash → bound PRESET_A auto-activates.
        await selectCharacterByName(page, ASH_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_A.temperature, 5);

        // Iyana → bound PRESET_B.
        await selectCharacterByName(page, IYANA_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_B.temperature, 5);

        // Back to Ash.
        await selectCharacterByName(page, ASH_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 }).toBeCloseTo(VALUES_A.temperature, 5);

        // Step 5: Restart + reload, re-click Ash, re-assert via DOM.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, ASH_NAME);
        await expect.poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 15_000 }).toBeCloseTo(VALUES_A.temperature, 5);
    });
});
