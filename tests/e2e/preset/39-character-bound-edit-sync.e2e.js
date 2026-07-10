// #39 — Edits made while a character-bound preset is active sync back
// to the character card snapshot.
//
// Without auto-sync, the bind flow froze the preset body onto the card
// at bind time; later sampler / prompt-group edits lived only in
// settings.json, and the next reload's maybeApplyCharacterBoundPreset
// would load the stale snapshot back into oai_settings.extensions —
// silently dropping the user's work.
//
// REAL USER-GESTURE flow:
//   1. Seed a character + a baseline preset via the visible UI.
//   2. Bind the preset to the character.
//   3. Edit the temperature slider via the counter (real input event).
//   4. Mutate oai_settings.extensions.luker.prompt_groups via the same
//      saveSettingsDebounced path the PromptManager uses (the real
//      drag-into-group UI requires multi-step Sortable gestures that
//      are out of scope here; the storage path is identical).
//   5. Wait for the debounced settings save + the SETTINGS_UPDATED
//      listener to flush the new snapshot back to the card.
//   6. Restart the server + reload the page + re-select the character.
//      Assert the temperature DOM value AND the persisted preset
//      snapshot on the card both reflect the post-bind edits.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';
import {
    normalizeIterStudioSettings,
    selectPresetByName,
    savePresetAsViaButton,
    setCounterInput,
    bindCurrentPresetToCharacter,
} from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CHAR_NAME = 'Ash the Cartographer';
const PRESET_NAME = 'pa-ash-edit-sync';
const BIND_TEMP = 0.42;
const POST_BIND_TEMP = 0.81;
const GROUP_NAME = 'Inspector Group';

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'char-bound-edit-sync',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-the-cartographer.png',
        overrides: { name: CHAR_NAME },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

function readCharacterBoundSnapshot(dataRoot, avatarFile) {
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const cardJson = readPngCard(png);
    const card = JSON.parse(cardJson);
    // sync-back writes the multi-slot shape
    // `{presets: [{name, preset}], defaultPresetName}`. Prior shape was
    // single `{name, preset}` — Layer 1 migrates old-shape reads into the
    // new shape and the sync-back path persists it, so pick the slot
    // matching the currently-bound name and return the same
    // `{name, preset}` view the old assertions expect.
    const raw = card?.data?.extensions?.luker?.chat_completion_preset;
    if (raw && typeof raw === 'object' && Array.isArray(raw.presets)) {
        const defaultName = String(raw.defaultPresetName || '').trim();
        const hit = defaultName
            ? raw.presets.find(p => p?.name === defaultName)
            : raw.presets[0];
        return hit || null;
    }
    return raw;
}

test.describe('#39 — character-bound preset edits sync back to the card', () => {
    test('temperature edit + prompt-group mutation both land on the card snapshot after restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Step 1: Create a baseline preset, then bind it.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', BIND_TEMP);
        await savePresetAsViaButton(page, PRESET_NAME);

        await selectCharacterByName(page, CHAR_NAME);
        await selectPresetByName(page, PRESET_NAME);
        await bindCurrentPresetToCharacter(page);

        // Confirm the runtime select sees the synthetic char-bound option.
        await page.waitForFunction(() => {
            const sel = document.querySelector('#settings_preset_openai');
            const opt = sel?.querySelector('option[data-luker-char-bound="1"]');
            return Boolean(opt) && String(sel.value) === String(opt.value);
        }, { timeout: 10_000 });

        // Step 2: Drive a sampler edit through the visible slider counter.
        await setCounterInput(page, '#temp_counter_openai', POST_BIND_TEMP);

        // Step 3: Mutate prompt_groups via the same path the PromptManager
        // uses — push directly onto oai_settings.extensions.luker.prompt_groups
        // then call saveSettingsDebounced. The SETTINGS_UPDATED listener
        // installed by the openai module re-snapshots oai_settings back into
        // the character card.
        const groupId = await page.evaluate(async (groupName) => {
            const ctx = window.Luker?.getContext?.();
            const oai = ctx?.chatCompletionSettings;
            if (!oai) throw new Error('chatCompletionSettings unavailable');
            oai.extensions = oai.extensions || {};
            oai.extensions.luker = oai.extensions.luker || {};
            const groups = Array.isArray(oai.extensions.luker.prompt_groups)
                ? oai.extensions.luker.prompt_groups
                : [];
            const id = `grp-${Date.now()}`;
            groups.push({ id, name: groupName, collapsed: false, identifiers: [], parentId: null });
            oai.extensions.luker.prompt_groups = groups;
            // Force a synchronous save so the SETTINGS_UPDATED listener
            // fires inside the test window without waiting on the 1s
            // debounce that saveSettingsDebounced uses by default.
            if (typeof ctx.saveSettings === 'function') {
                await ctx.saveSettings();
            } else {
                throw new Error('Luker.getContext().saveSettings unavailable');
            }
            return id;
        }, GROUP_NAME);

        // Give the SETTINGS_UPDATED listener time to fan out the merge POST.
        await page.waitForTimeout(500);

        // Step 4: Sanity-check the on-disk card snapshot now reflects both edits.
        await expect.poll(() => {
            const snap = readCharacterBoundSnapshot(server.dataRoot, 'ash-the-cartographer.png');
            return snap?.preset?.temperature;
        }, { timeout: 10_000 }).toBeCloseTo(POST_BIND_TEMP, 5);

        await expect.poll(() => {
            const snap = readCharacterBoundSnapshot(server.dataRoot, 'ash-the-cartographer.png');
            const groups = snap?.preset?.extensions?.luker?.prompt_groups;
            return Array.isArray(groups) ? groups.find(g => g?.id === groupId)?.name : null;
        }, { timeout: 10_000 }).toBe(GROUP_NAME);

        // Step 5: Restart, reload, re-select character. Both edits must survive.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        await expect.poll(
            async () => Number(await page.locator('#temp_counter_openai').inputValue()),
            { timeout: 15_000 },
        ).toBeCloseTo(POST_BIND_TEMP, 5);

        await expect.poll(
            async () => page.evaluate((id) => {
                const ctx = window.Luker?.getContext?.();
                const groups = ctx?.chatCompletionSettings?.extensions?.luker?.prompt_groups;
                if (!Array.isArray(groups)) return null;
                return groups.find(g => g?.id === id)?.name ?? null;
            }, groupId),
            { timeout: 15_000 },
        ).toBe(GROUP_NAME);
    });
});
