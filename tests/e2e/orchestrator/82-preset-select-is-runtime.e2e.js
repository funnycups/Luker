// #82 — Orchestrator preset dropdown selection IS the runtime selection
//       (single-scope model: card active slot empty → global runs).
//
// Bug shape this locks in: under the old override-toggle model, picking a
// preset in the dropdown only changed which library the EDITOR displayed;
// what actually ran was still decided by the per-card `overrideEnabled`
// flag. After the single-scope rework, the dropdown's selected option must
// be the whole truth: select a GLOBAL preset → the global library's active
// preset drives the loop agent's system prompt; select a CARD preset → the
// card library's preset drives it.
//
// REAL USER-GESTURE flow:
//   1. Seed settings.json with two global loop presets (GA / GB) with
//      distinct marker system prompts, GA active.
//   2. Seed a card with a card-scope loop library (CA, distinct marker),
//      card active slot = CA (card runs first).
//   3. Load app, select the character, open the orchestrator drawer in
//      loop mode (General tab → preset selector bar).
//   4. Send a message → mock LLM captures the loop-agent request; its
//      system prompt must carry CARD_A_MARKER (card slot non-empty).
//   5. Pick GLOBAL preset A via the visible <select> (real change event).
//      Send again → system prompt carries GLOBAL_A_MARKER, and the card's
//      in-memory activePresetIds.loop is now '' (slot cleared).
//   6. Pick the CARD preset CA again. Send again → CARD_A_MARKER.
//   7. Pick GLOBAL preset B. Send again → GLOBAL_B_MARKER (switching
//      between two global presets works with an empty card slot).
//
// Assertion strategy: runtime evidence only — the system prompt inside
// the captured /chat/completions request body. No DOM marker assertions.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, openExtensionsDrawer, openInlineDrawer } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHARACTER_NAME = 'Pina the Preset Swapper';
const CHARACTER_AVATAR = 'pina-the-preset-swapper.png';

const GLOBAL_A_ID = 'global-a';
const GLOBAL_A_MARKER = '__E2E_GLOBAL_A_LOOP_PROMPT__reef-census-guidance__';
const GLOBAL_B_ID = 'global-b';
const GLOBAL_B_MARKER = '__E2E_GLOBAL_B_LOOP_PROMPT__drift-table-guidance__';
const CARD_A_ID = 'card-a';
const CARD_A_MARKER = '__E2E_CARD_A_LOOP_PROMPT__private-ledger-guidance__';

const LOOP_PROFILE_SHAPE = (name, systemPrompt) => ({
    name,
    mode: 'loop',
    apiPresetName: '',
    promptPresetName: '',
    system_prompt: systemPrompt,
    tools: {},
    max_rounds: 3,
    wall_clock_budget_ms: 0,
    capsule_inject: true,
    customTools: [],
    skills: { visible: [], deny: [] },
});

function settingsJsonPath(dataRoot) {
    return resolve(dataRoot, 'default-user', 'settings.json');
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'orchestrator',
        scenarioId: '82-preset-select-is-runtime',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Two global loop presets with marker system prompts; GA active.
    const sp = settingsJsonPath(server.dataRoot);
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    const ext = s.extension_settings.orchestrator;
    ext.enabled = true;
    ext.executionMode = 'loop';
    ext.presetLibrariesMigrationDone = 1;
    ext.presetLibraries = ext.presetLibraries || { spec: {}, agenda: {}, loop: {}, director: {} };
    ext.presetLibraries.loop = ext.presetLibraries.loop || {};
    ext.presetLibraries.loop[GLOBAL_A_ID] = LOOP_PROFILE_SHAPE('Global A', GLOBAL_A_MARKER);
    ext.presetLibraries.loop[GLOBAL_B_ID] = LOOP_PROFILE_SHAPE('Global B', GLOBAL_B_MARKER);
    ext.activePresetIds = ext.activePresetIds || { spec: '', agenda: '', loop: '', director: '' };
    ext.activePresetIds.loop = GLOBAL_A_ID;
    writeFileSync(sp, JSON.stringify(s, null, 4));

    // Card carries its own loop library with CA active — the card runs
    // its preset until the user picks a global option in the dropdown.
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHARACTER_AVATAR,
        overrides: {
            name: CHARACTER_NAME,
            extensions: {
                orchestrator: {
                    override: { mode: 'loop' },
                    presetLibraries: {
                        loop: { [CARD_A_ID]: LOOP_PROFILE_SHAPE('Card A', CARD_A_MARKER) },
                    },
                    activePresetIds: { loop: CARD_A_ID },
                },
            },
        },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function openOrchDrawerInLoopMode(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'orchestrator_settings').catch(() => {});
    const modeSelect = page.locator('#luker_orch_execution_mode');
    await modeSelect.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await modeSelect.inputValue()) !== 'loop') {
        await modeSelect.selectOption('loop');
        await modeSelect.evaluate(el => {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) window.jQuery(el).trigger('change');
        });
    }
    const generalTabButton = page.locator('button[data-luker-tabs-target="luker_orch_tabs"][data-luker-tab-key="general"]');
    if (await generalTabButton.count()) await generalTabButton.first().click();
}

function loopSelector(page) {
    return page.locator('[data-luker-preset-bar-host="loop"] [data-luker-preset-select][data-mode="loop"]');
}

async function pickPreset(page, scope, id) {
    // After every send the top drawer gets closed, so re-open the
    // orchestrator drawer before each pick — the preset select lives
    // inside it and is invisible (display:none subtree) otherwise.
    await openOrchDrawerInLoopMode(page);
    const select = loopSelector(page);
    await select.waitFor({ state: 'attached', timeout: 10_000 });
    // Option values are raw preset ids; scope rides on data-preset-scope.
    const option = select.locator(`option[data-preset-scope="${scope}"][value="${id}"]`);
    await option.waitFor({ state: 'attached', timeout: 10_000 });
    await select.selectOption(id);
    await select.evaluate(el => {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(el).trigger('change');
    });
}

function requestSystemPrompts(record) {
    const messages = Array.isArray(record?.body?.messages) ? record.body.messages : [];
    return messages.filter(m => m && m.role === 'system').map(m => String(m.content || ''));
}

function lastMarkerSystemPrompt() {
    // The loop agent's request is the one whose system prompt carries one
    // of our markers. Main-model requests never do.
    const markerHits = mock.requests.filter(r =>
        requestSystemPrompts(r).some(p =>
            p.includes(GLOBAL_A_MARKER) || p.includes(GLOBAL_B_MARKER) || p.includes(CARD_A_MARKER)));
    if (markerHits.length === 0) return '';
    const prompts = requestSystemPrompts(markerHits[markerHits.length - 1]);
    return prompts.find(p =>
        p.includes(GLOBAL_A_MARKER) || p.includes(GLOBAL_B_MARKER) || p.includes(CARD_A_MARKER)) || '';
}

async function waitForMarker(marker, timeoutMs = 60_000) {
    await expect.poll(async () => lastMarkerSystemPrompt().includes(marker), { timeout: timeoutMs }).toBe(true);
}

async function readCardLoopSlot(page) {
    return await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const card = ctx.characters?.[ctx.characterId];
        return card?.data?.extensions?.orchestrator?.activePresetIds?.loop ?? null;
    });
}

test.describe('#82 — orchestrator preset dropdown selection drives the runtime', () => {
    test.setTimeout(240_000);

    test('card slot → global → card → second global, runtime follows every pick', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);
        await openOrchDrawerInLoopMode(page);

        // The dropdown's initial selection must be the card preset (card
        // slot non-empty = card runs).
        const select = loopSelector(page);
        await select.waitFor({ state: 'attached', timeout: 10_000 });
        const initialSelected = await select.evaluate(el => el.value);
        expect(initialSelected).toBe(CARD_A_ID);
        const initialScope = await select.evaluate(el => {
            const opt = el.selectedOptions[0];
            return opt ? opt.getAttribute('data-preset-scope') : null;
        });
        expect(initialScope).toBe('character');

        // ── Leg 1: card slot active → loop agent prompt = CARD marker.
        await sendMessageAndAwaitReply(page, 'Start the first sweep.');
        await waitForMarker(CARD_A_MARKER);

        // ── Leg 2: pick global A via the visible dropdown.
        await pickPreset(page, 'global', GLOBAL_A_ID);
        // The card's slot must now be empty — the card library is
        // preserved but no longer drives this card.
        await expect.poll(async () => readCardLoopSlot(page), { timeout: 10_000 }).toBe('');
        await sendMessageAndAwaitReply(page, 'Second sweep, global A.');
        await waitForMarker(GLOBAL_A_MARKER);

        // ── Leg 3: pick the card preset again.
        await pickPreset(page, 'character', CARD_A_ID);
        await expect.poll(async () => readCardLoopSlot(page), { timeout: 10_000 }).toBe(CARD_A_ID);
        await sendMessageAndAwaitReply(page, 'Third sweep, back to card.');
        await waitForMarker(CARD_A_MARKER);

        // ── Leg 4: pick global B (global → global switch with the card
        // slot empty) — proves the global library's own active id moves.
        await pickPreset(page, 'global', GLOBAL_B_ID);
        await sendMessageAndAwaitReply(page, 'Fourth sweep, global B.');
        await waitForMarker(GLOBAL_B_MARKER);
    });
});
