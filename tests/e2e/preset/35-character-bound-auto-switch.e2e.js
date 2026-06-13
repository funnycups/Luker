// #35 — Preset bound to character → switch character auto-switches preset.
//
// Sequence:
//   1. Seed two characters (Ash + Iyana) via the embedded-PNG helper.
//   2. Create preset-A and preset-B. Bind A→Ash, B→Iyana via
//      `setCharacterBoundPresetValue` (the same code path the
//      "Bind Current Chat Completion Preset" button drives).
//   3. Select Ash → active preset must read as preset-A's body
//      (delivered via the character-bound runtime option).
//   4. Select Iyana → active preset auto-switches to preset-B's body.
//   5. Switch back to Ash → auto-switches back to preset-A.
//   6. Restart → bindings persist on each character card; selecting
//      Ash/Iyana after restart still auto-applies the bound preset.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const PRESET_A = 'pa-ash-bound';
const PRESET_B = 'pa-iyana-bound';

const VALUES_A = {
    temperature: 0.39,
    top_p: 0.71,
    presence_penalty: 0.12,
};
const VALUES_B = {
    temperature: 0.83,
    top_p: 0.56,
    presence_penalty: 0.29,
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'preset', scenarioId: 'char-bound' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Two characters with proper PNG-embedded card data so /api/characters/all
    // returns them under their actual names (not "Seraphina").
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-the-cartographer.png',
        overrides: { name: 'Ash the Cartographer' },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: 'iyana-the-watchwoman.png',
        overrides: {
            name: 'Iyana the Watchwoman',
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

test.describe('#35 — preset bound to character auto-switches with character', () => {
    test('per-character bound presets activate on character switch and survive restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Reload character list so Ash + Iyana show up in window.characters.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return ['Ash the Cartographer', 'Iyana the Watchwoman']
                .every(name => ctx.characters.some(c => c?.name === name));
        }, { timeout: 15_000 });

        // ── Step 1: Create preset-A and preset-B as distinct snapshots. ──
        const presetsCreated = await page.evaluate(async ({ presetA, presetB, valsA, valsB }) => {
            const ctx = window.SillyTavern.getContext();
            const mgr = ctx.getPresetManager('openai');
            const oai = ctx.chatCompletionSettings;
            const snapshot = (vals) => {
                // Build a body via getCompletionPresetByName('Default') and
                // overlay the test vals so we capture a real, savable shape.
                const base = mgr.getCompletionPresetByName('Default') || {};
                const clone = JSON.parse(JSON.stringify(base));
                clone.temperature = vals.temperature;
                clone.top_p = vals.top_p;
                clone.presence_penalty = vals.presence_penalty;
                return clone;
            };
            await mgr.savePreset(presetA, snapshot(valsA));
            await mgr.savePreset(presetB, snapshot(valsB));
            return true;
        }, { presetA: PRESET_A, presetB: PRESET_B, valsA: VALUES_A, valsB: VALUES_B });
        expect(presetsCreated).toBe(true);

        // Wait for both option labels to register.
        await page.waitForFunction(({ a, b }) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'))
                .map(o => o.textContent);
            return opts.includes(a) && opts.includes(b);
        }, { a: PRESET_A, b: PRESET_B }, { timeout: 5000 });

        // ── Step 2: Bind preset-A → Ash, preset-B → Iyana. We drive the
        // backing helper directly because the UI path opens a Popup.confirm
        // dialog. Effect is identical: writes
        // `character.data.extensions.luker.chat_completion_preset = { name, preset }`.
        const bindResult = await page.evaluate(async ({ presetA, presetB }) => {
            const ctx = window.SillyTavern.getContext();
            const mgr = ctx.getPresetManager('openai');
            const ashIdx = ctx.characters.findIndex(c => c?.name === 'Ash the Cartographer');
            const iyanaIdx = ctx.characters.findIndex(c => c?.name === 'Iyana the Watchwoman');
            // Use the live /api/characters/merge-attributes endpoint
            // directly, exactly mirroring what `setCharacterBoundPresetValue`
            // does (the function is module-private to openai.js).
            const bind = async (chid, presetName) => {
                const character = ctx.characters[chid];
                const body = mgr.getCompletionPresetByName(presetName);
                const luker = (character.data?.extensions?.luker) || {};
                const next = {
                    name: presetName,
                    preset: body,
                };
                character.data = character.data || {};
                character.data.extensions = character.data.extensions || {};
                character.data.extensions.luker = { ...luker, chat_completion_preset: next };
                const res = await fetch('/api/characters/merge-attributes', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({
                        avatar: character.avatar,
                        data: {
                            extensions: {
                                luker: { chat_completion_preset: next },
                            },
                        },
                    }),
                });
                return res.ok;
            };
            const okA = await bind(ashIdx, presetA);
            const okB = await bind(iyanaIdx, presetB);
            return { okA, okB, ashIdx, iyanaIdx };
        }, { presetA: PRESET_A, presetB: PRESET_B });
        expect(bindResult.okA, 'bind preset-A to Ash').toBe(true);
        expect(bindResult.okB, 'bind preset-B to Iyana').toBe(true);

        // Re-fetch /api/characters/all so character.data.extensions.luker
        // reflects the merge-attributes write on the in-memory copy.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });

        // ── Step 3: Select Ash via ctx.selectCharacterById (drawer-free
        // path; see fork-feedback iter_shell_gotchas + per-batch note that
        // the DOM drawer state desyncs for multi-character flows).
        //
        // Field-mapping note: the preset BODY uses keys `temperature` and
        // `top_p`, but at apply time those map onto `oai_settings.temp_openai`
        // and `oai_settings.top_p_openai` via the `settingsToUpdate` table
        // (public/scripts/openai.js). The wait-fors below read the
        // runtime-side keys.
        const selectAsh = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Ash the Cartographer');
            await ctx.selectCharacterById(idx);
            return idx;
        });
        expect(selectAsh).toBeGreaterThanOrEqual(0);
        // Allow autoSelectPreset / maybeApplyCharacterBoundPreset to settle.
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_A, { timeout: 10_000 });

        // ── Step 4: Switch to Iyana → preset-B's values must apply.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Iyana the Watchwoman');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_B, { timeout: 10_000 });

        // ── Step 5: Back to Ash → preset-A re-applies.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Ash the Cartographer');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_A, { timeout: 10_000 });

        // ── Step 6: Restart and reload. Bindings live in the PNG-embedded
        // character data, so they must survive without code changes.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // Re-fetch characters and confirm the binding extension keys
        // survived on each card.
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            await mod.getCharacters();
        });
        await page.waitForFunction(() => {
            const ctx = window.SillyTavern.getContext();
            return ['Ash the Cartographer', 'Iyana the Watchwoman']
                .every(name => ctx.characters.some(c => c?.name === name));
        }, { timeout: 15_000 });

        const persistedBindings = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            // Force a fresh server-side read via /api/characters/get
            // (the cached in-memory list may not reflect deep merges
            // before reloadAndAwait re-bootstraps everything).
            const fetchBind = async (avatar) => {
                const res = await fetch('/api/characters/get', {
                    method: 'POST',
                    headers: ctx.getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar }),
                });
                if (!res.ok) return { error: res.status };
                const body = await res.json();
                const raw = body?.data?.extensions?.luker?.chat_completion_preset;
                return typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? raw.name : '');
            };
            return {
                ash: await fetchBind('ash-the-cartographer.png'),
                iyana: await fetchBind('iyana-the-watchwoman.png'),
            };
        });
        expect(persistedBindings.ash).toBe(PRESET_A);
        expect(persistedBindings.iyana).toBe(PRESET_B);

        // After restart: selecting Ash must still auto-apply preset-A.
        await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === 'Ash the Cartographer');
            await ctx.selectCharacterById(idx);
        });
        await page.waitForFunction((vals) => {
            const ctx = window.SillyTavern.getContext();
            const oai = ctx.chatCompletionSettings;
            return Math.abs((oai.temp_openai ?? -1) - vals.temperature) < 1e-9
                && Math.abs((oai.top_p_openai ?? -1) - vals.top_p) < 1e-9;
        }, VALUES_A, { timeout: 10_000 });
    });
});
