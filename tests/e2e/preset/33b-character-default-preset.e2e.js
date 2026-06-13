// #33b — Per-character default preset auto-activates on character switch.
//
// Two distinct mechanisms exist for "preset follows character" in Luker:
//
//   1. EXPLICIT BINDING — `extensions.luker.chat_completion_preset` on
//      the character card carries the preset NAME and a full preset
//      BODY snapshot. `maybeApplyCharacterBoundPreset` activates a
//      synthetic runtime option mirroring the bound body whenever the
//      character is selected. (Covered by #35.)
//
//   2. NAME-MATCH AUTO-SELECT — when a character has NO explicit binding,
//      `autoSelectPreset` (preset-manager.js) calls
//      `presetManager.findPreset(character.name)`. If a preset whose
//      name matches the character's name exists, it is selected
//      automatically.
//
// This case covers #2 — the "default preset" UX where the user names a
// preset to match a character so switching characters swaps presets.
// The lookup is case-insensitive and uses lookup-name normalization.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

// The preset is keyed by the character's exact display name. That's
// the name autoSelectPreset looks up via findPreset(character.name).
const ASH_NAME = 'Ash the Cartographer';
const IYANA_NAME = 'Iyana the Watchwoman';

// Distinct, non-default values so a sticky-from-Default fail is loud.
const VALUES_ASH = {
    temperature: 0.33,
    top_p: 0.66,
};
const VALUES_IYANA = {
    temperature: 0.81,
    top_p: 0.43,
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'preset', scenarioId: 'char-default-preset' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-the-cartographer.png',
        overrides: { name: ASH_NAME },
    });
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
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#33b — per-character default preset (name-match autoSelect)', () => {
    test('character switch picks the preset whose name matches; restart preserves the binding', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Reload character list so Ash + Iyana show up in window.characters.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(({ a, b }) => {
            const ctx = window.SillyTavern.getContext();
            return [a, b].every(name => ctx.characters.some(c => c?.name === name));
        }, { a: ASH_NAME, b: IYANA_NAME }, { timeout: 15_000 });

        // ── Step 1: Save two presets, naming each EXACTLY after a character.
        //   autoSelectPreset → findPreset(character.name) is the contract.
        await page.evaluate(async ({ ashName, iyanaName, valsA, valsB }) => {
            const ctx = window.SillyTavern.getContext();
            const mgr = ctx.getPresetManager('openai');
            const base = mgr.getCompletionPresetByName('Default') || {};
            const make = (vals) => {
                const clone = JSON.parse(JSON.stringify(base));
                clone.temperature = vals.temperature;
                clone.top_p = vals.top_p;
                return clone;
            };
            await mgr.savePreset(ashName, make(valsA));
            await mgr.savePreset(iyanaName, make(valsB));
        }, { ashName: ASH_NAME, iyanaName: IYANA_NAME, valsA: VALUES_ASH, valsB: VALUES_IYANA });

        // Wait for both preset option labels to register.
        await page.waitForFunction(({ a, b }) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'))
                .map(o => o.textContent);
            return opts.includes(a) && opts.includes(b);
        }, { a: ASH_NAME, b: IYANA_NAME }, { timeout: 5000 });

        // ── Step 2: Select Ash. autoSelectPreset must pick the
        //   preset named "Ash the Cartographer".
        //
        // Field-mapping note: preset BODY uses keys `temperature` and
        // `top_p`; at apply time those map onto `oai_settings.temp_openai`
        // and `oai_settings.top_p_openai` via the `settingsToUpdate` table
        // (public/scripts/openai.js). The wait-fors read the runtime keys.
        await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === name);
            await ctx.selectCharacterById(idx);
        }, ASH_NAME);
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_ASH, { timeout: 10_000 });

        const afterAsh = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai;
        });
        expect(afterAsh, 'active preset name after Ash select').toBe(ASH_NAME);

        // ── Step 3: Switch to a different character AND a different
        //   preset (so the next switch back to Ash is a real auto-pick,
        //   not the preset just "still being there"). Iyana is conveniently
        //   already wired with her own name-matched preset.
        await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === name);
            await ctx.selectCharacterById(idx);
        }, IYANA_NAME);
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9;
        }, VALUES_IYANA, { timeout: 10_000 });
        const afterIyana = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai;
        }, IYANA_NAME);
        expect(afterIyana).toBe(IYANA_NAME);

        // ── Step 4: Switch back to Ash → preset-A reactivates by name.
        await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === name);
            await ctx.selectCharacterById(idx);
        }, ASH_NAME);
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_ASH, { timeout: 10_000 });
        const reAsh = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai;
        });
        expect(reAsh).toBe(ASH_NAME);

        // ── Step 5: Restart + reload. The presets are on disk; selecting
        // each character after restart must still auto-activate the
        // name-matched preset.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(({ a, b }) => {
            const ctx = window.SillyTavern.getContext();
            return [a, b].every(name => ctx.characters.some(c => c?.name === name));
        }, { a: ASH_NAME, b: IYANA_NAME }, { timeout: 15_000 });

        await page.evaluate(async (name) => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === name);
            await ctx.selectCharacterById(idx);
        }, ASH_NAME);
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_ASH, { timeout: 10_000 });
        const finalAsh = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai;
        });
        expect(finalAsh, 'name-matched preset auto-activates after restart').toBe(ASH_NAME);
    });
});
