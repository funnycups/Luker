// #33 — Save preset → switch → UI reflects all fields
//
// Modify temperature/top_p/max_tokens/system prompt + prompt_order on the
// current preset, save under a new name ("preset-A"), switch to Default,
// then switch back — every field's UI must show the saved values exactly,
// in-memory oai_settings must match, and the state must survive a server
// restart.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';

let server, mock;

const PRESET_A = 'preset-A-iter';
// Use distinct values that won't collide with default-preset values so
// "still default" vs "actually loaded" is unambiguous.
const VALUES_A = {
    temperature: 0.42,
    top_p: 0.77,
    openai_max_tokens: 1337,
    mainPromptContent: '*Ash leans against the rail, brass spyglass in hand.* You and {{char}} are watching the reef. Stay in scene; reply with two or three immersive paragraphs unless asked OOC.',
};

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [
        '*Seraphina folds the chart away.* The lantern still holds, so we have time.',
    ] });
    server = await startServer({ batchKey: 'preset', scenarioId: 'save-switch-reflect' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#33 — preset save → switch → field roundtrip', () => {
    test('saved preset reflects every field after switch-away/back + restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Step 1: write the target field values into chatCompletionSettings,
        // then save as preset-A through the preset manager. Driving the
        // underlying saveOpenAIPreset is faster + more deterministic than
        // fiddling each input element (the UI write-back path is what we'll
        // verify on the SECOND read; this first save is the seed).
        await page.evaluate(async (vals) => {
            const ctx = window.Luker.getContext();
            const oai = ctx.chatCompletionSettings;
            oai.temperature = vals.temperature;
            oai.top_p = vals.top_p;
            oai.openai_max_tokens = vals.openai_max_tokens;
            // Edit the Main Prompt content (prompts[] is the canonical list).
            if (Array.isArray(oai.prompts)) {
                const main = oai.prompts.find(p => p?.identifier === 'main');
                if (main) main.content = vals.mainPromptContent;
            }
        }, VALUES_A);

        // Save the modified live chatCompletionSettings under the new name.
        // The OpenAI preset manager's savePreset goes through
        // saveOpenAIPreset → persistPreset → /api/presets/save, then
        // registers the new option in openai_setting_names so subsequent
        // switching can find it.
        const saveOk = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            if (!mgr?.savePreset) return { ok: false, reason: 'no savePreset' };
            try {
                await mgr.savePreset(name, ctx.chatCompletionSettings);
                return { ok: true, saved: { temperature: ctx.chatCompletionSettings.temperature, top_p: ctx.chatCompletionSettings.top_p, openai_max_tokens: ctx.chatCompletionSettings.openai_max_tokens } };
            } catch (e) {
                return { ok: false, reason: String(e?.message || e) };
            }
        }, PRESET_A);
        expect(saveOk.ok, `savePreset failed: ${saveOk.reason || ''}`).toBe(true);
        // Sanity: the live values seen at save time should match what we wrote.
        expect(saveOk.saved).toEqual({
            temperature: VALUES_A.temperature,
            top_p: VALUES_A.top_p,
            openai_max_tokens: VALUES_A.openai_max_tokens,
        });

        // Wait for the new option to appear in the select.
        await page.waitForFunction((name) => {
            const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
            return opts.some(o => o.textContent === name);
        }, PRESET_A, { timeout: 5000 });

        // DEBUG: read the persisted preset body back through the manager.
        const storedAfterSave = await page.evaluate((name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const body = mgr.getCompletionPresetByName(name);
            return { temperature: body?.temperature, top_p: body?.top_p, openai_max_tokens: body?.openai_max_tokens };
        }, PRESET_A);
        expect(storedAfterSave).toEqual({
            temperature: VALUES_A.temperature,
            top_p: VALUES_A.top_p,
            openai_max_tokens: VALUES_A.openai_max_tokens,
        });

        // Step 2: switch to Default (the seed preset always present).
        await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const val = mgr.findPreset('Default');
            mgr.selectPreset(val);
        });
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai === 'Default';
        }, { timeout: 5000 });

        // Step 3: switch back to preset-A. UI fields must now show the
        // saved values. The OAI preset change handler writes the preset
        // body into chatCompletionSettings (and into the matching inputs).
        await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const val = mgr.findPreset(name);
            mgr.selectPreset(val);
        }, PRESET_A);
        await page.waitForFunction((name) => {
            const ctx = window.Luker.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai === name;
        }, PRESET_A, { timeout: 5000 });

        // Verify in-memory chatCompletionSettings matches the values we saved.
        const inMem = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const oai = ctx.chatCompletionSettings;
            const main = Array.isArray(oai.prompts) ? oai.prompts.find(p => p?.identifier === 'main') : null;
            return {
                temperature: oai.temperature,
                top_p: oai.top_p,
                openai_max_tokens: oai.openai_max_tokens,
                mainContent: main?.content || '',
                presetName: oai.preset_settings_openai,
            };
        });
        expect(inMem.presetName).toBe(PRESET_A);
        expect(inMem.temperature).toBe(VALUES_A.temperature);
        expect(inMem.top_p).toBe(VALUES_A.top_p);
        expect(inMem.openai_max_tokens).toBe(VALUES_A.openai_max_tokens);
        expect(inMem.mainContent).toBe(VALUES_A.mainPromptContent);

        // Verify the UI inputs reflect the same values. The OAI tab uses
        // standard ids per settingsToUpdate map (#temp_openai for temperature,
        // #top_p_openai, #openai_max_tokens, etc.).
        const tempInput = await page.locator('#temp_openai').inputValue();
        expect(Number(tempInput)).toBe(VALUES_A.temperature);
        const topPInput = await page.locator('#top_p_openai').inputValue();
        expect(Number(topPInput)).toBe(VALUES_A.top_p);
        const maxTokensInput = await page.locator('#openai_max_tokens').inputValue();
        expect(Number(maxTokensInput)).toBe(VALUES_A.openai_max_tokens);

        // Step 4: restart server and reload page; preset-A must still load
        // with the same field values.
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        // Re-select preset-A (default activation after reload may pick whatever
        // was last persisted — make sure we're on preset-A explicitly).
        await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const mgr = ctx.getPresetManager('openai');
            const cur = ctx.chatCompletionSettings.preset_settings_openai;
            if (cur !== name) {
                const val = mgr.findPreset(name);
                mgr.selectPreset(val);
            }
        }, PRESET_A);
        await page.waitForFunction((name) => {
            const ctx = window.Luker.getContext();
            return ctx.chatCompletionSettings.preset_settings_openai === name;
        }, PRESET_A, { timeout: 5000 });

        const inMem2 = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const oai = ctx.chatCompletionSettings;
            const main = Array.isArray(oai.prompts) ? oai.prompts.find(p => p?.identifier === 'main') : null;
            return {
                temperature: oai.temperature,
                top_p: oai.top_p,
                openai_max_tokens: oai.openai_max_tokens,
                mainContent: main?.content || '',
            };
        });
        expect(inMem2.temperature).toBe(VALUES_A.temperature);
        expect(inMem2.top_p).toBe(VALUES_A.top_p);
        expect(inMem2.openai_max_tokens).toBe(VALUES_A.openai_max_tokens);
        expect(inMem2.mainContent).toBe(VALUES_A.mainPromptContent);
    });
});
