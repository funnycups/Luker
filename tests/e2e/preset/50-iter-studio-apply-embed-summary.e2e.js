// #50 — Orchestrator iter-studio "Apply to Character" triggers the same
//        unembedded-preset detect + summary popup that #44 covers for the
//        Save To Character Override editor-panel action.
//
// Feature contract — when the iter-studio commits a profile write to
// character scope (auto-routed via getIterationDefaultScope: a character
// is selected → scope = 'character'), the orchestrator inspects the live
// working profile for preset names that resolve only to the local
// global set and pops the same 3-button dialog:
//
//   [Embed all]           → ctx.character.presets.add(...) for each
//   [Save names only]     → persist profile as-is, no embed
//   [Cancel]              → bail; no orchestrator write, no preset write
//
// The four apply branches (loop / agenda / director / spec) all share
// the helper `promptEmbedUnembeddedPresetsForCharacterApply`.  This test
// drives loop mode — the most common apply path — for all three popup
// outcomes.  Test 4 covers the "all referenced presets already embedded"
// straight-through case (no popup).
//
// REAL USER-GESTURE flow (mirrors #37 + #44):
//   1. Seed a local global preset (SlotA) with a distinct temperature so
//      the on-disk card body assertion has something observable.
//   2. Select the fresh character card.
//   3. Open the orchestrator iter-studio in loop mode.
//   4. Script a `luker_orch_set_loop_profile` tool_call setting
//      promptPresetName to SlotA.
//   5. Send iter prompt → studio renders the pending proposal card.
//   6. Approve — proposal-bus commits `profile` target → studio calls
//      `commitLiveToCharacter` → `applyAiIterationSessionToCharacter` →
//      the preflight popup surfaces SlotA.
//   7. Click Embed all / Save names only / Cancel and assert.
//
// The four apply branches (loop / agenda / director / spec) all share
// the helper.  Loop mode gives loop-, agenda-, and director-shape
// coverage of the helper's popup wiring (the profile fingerprint the
// helper reads varies per mode but the popup path is identical).

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, applyIterBatch, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { normalizeIterStudioSettings, selectPresetByName, savePresetAsViaButton, setCounterInput } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Iris the Iterator';
const CHAR_AVATAR = 'iris-the-iterator.png';
const SLOT_A = 'SlotA';
const SLOT_A_TEMP = 0.29;

/** Force loop mode + orchestrator enabled + iter-studio boot config. */
function normalizeSettings(dataRoot) {
    normalizeIterStudioSettings(dataRoot);
    const sp = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = s.extension_settings.orchestrator || {};
    s.extension_settings.orchestrator.enabled = true;
    s.extension_settings.orchestrator.executionMode = 'loop';
    writeFileSync(sp, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'iter-studio-apply-embed-summary',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CHAR_AVATAR,
        overrides: { name: CHAR_NAME },
    });
    normalizeSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function readCardBoundState(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const chid = ctx?.characterId ?? window.this_chid;
        const c = ctx?.characters?.[chid];
        const raw = c?.data?.extensions?.luker?.chat_completion_preset ?? null;
        if (!raw) return { presets: [], defaultPresetName: null, isNull: true };
        if (Array.isArray(raw?.presets)) {
            return {
                presets: raw.presets.map(p => ({ name: p.name, temperature: p?.preset?.temperature ?? null })),
                defaultPresetName: raw.defaultPresetName ?? null,
                isNull: false,
            };
        }
        return { raw, isNull: false };
    });
}

async function readCharacterOrchestratorOverride(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const chid = ctx?.characterId ?? window.this_chid;
        const c = ctx?.characters?.[chid];
        return c?.data?.extensions?.orchestrator ?? null;
    });
}

/** Reset card on-disk so each test starts clean (no embedded presets,
 *  no orchestrator override, no character override storage). */
async function resetCharacterOnDisk({ dataRoot, avatarFile }) {
    const { read: readPngCard, write: writePngCard } = await import('../../../src/character-card-parser.js');
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    if (card.data) {
        if (card.data.extensions?.luker) delete card.data.extensions.luker.chat_completion_preset;
        if (card.data.extensions) delete card.data.extensions.orchestrator;
    }
    if (card.extensions) {
        if (card.extensions.luker) delete card.extensions.luker.chat_completion_preset;
        delete card.extensions.orchestrator;
    }
    writeFileSync(path, writePngCard(png, JSON.stringify(card)));
}

/** Seed the SlotA global preset if it doesn't exist yet. Distinct
 *  temperature makes the embed detection observable on the card body. */
async function seedGlobalPresetOnce(page, { name, temperature }) {
    const already = await page.evaluate((n) => {
        const opts = Array.from(document.querySelectorAll('#settings_preset_openai option'));
        return opts.some(o => o.textContent.trim() === n);
    }, name);
    if (already) return;
    await selectPresetByName(page, 'Default');
    await setCounterInput(page, '#temp_counter_openai', temperature);
    await savePresetAsViaButton(page, name);
}

/** Await the unembedded-preset summary popup, then return its dialog
 *  locator (topmost dialog, matches the summary that opens on top of
 *  the iter-studio popup).
 *
 *  Default profiles ship a customTools[] fixture (see
 *  `default-custom-tools.js` — the "Layer-3 customTools shipped with
 *  new orchestrator profiles" ledger), so the character-apply pipeline
 *  first opens the `reviewIncomingCustomTools` popup ("Apply with tools
 *  / Cancel / Apply without tools").  We approve with tools intact so
 *  the preflight popup (the one #50 is actually testing) surfaces next.
 */
async function awaitSummaryPopup(page, presetName) {
    // First: dismiss the customTools review popup that fires when the
    // incoming session carries any custom tools.  Present iff the
    // profile fixture ships defaults; safe to skip if absent.
    const reviewDialog = page.locator('dialog.popup[open]:has-text("Apply with tools")');
    if (await reviewDialog.count() > 0) {
        await reviewDialog.first().locator('.popup-button-ok').first().click();
        await reviewDialog.first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    }
    // Then: the preflight summary popup listing the unembedded preset.
    const dialog = page.locator('dialog.popup[open]').last();
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(dialog).toContainText(presetName, { timeout: 10_000 });
    return dialog;
}

test.describe.configure({ mode: 'serial' });

test.describe('#50 — iter-studio Apply to Character embed-summary popup', () => {
    test('Embed all: unembedded preset is added to card and loop override is written', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        await seedGlobalPresetOnce(page, { name: SLOT_A, temperature: SLOT_A_TEMP });
        await selectCharacterByName(page, CHAR_NAME);

        // Open iter-studio in loop mode.  With a character selected,
        // getIterationDefaultScope resolves to 'character', so approve
        // commits into commitLiveToCharacter → the preflight fires.
        await openIterStudio(page, 'orch');

        // Script the loop-profile patch that references SlotA.
        mock.scriptToolCall({
            name: 'luker_orch_set_loop_profile',
            arguments: { promptPresetName: SLOT_A },
        });

        await sendIterPrompt(page, 'orch', `Bind the loop prompt preset to ${SLOT_A}.`);
        await applyIterBatch(page, 'orch');

        const dialog = await awaitSummaryPopup(page, SLOT_A);
        // Embed all lives on the OK button (see promptEmbedUnembedded
        // helper — okButton is labeled "Embed all").
        await dialog.locator('.popup-button-ok').first().click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

        // The embed roundtrip lands via ctx.character.presets.add — poll
        // for the card slot to reflect the SlotA entry.
        await expect.poll(async () => {
            const state = await readCardBoundState(page);
            return state.presets.map(p => p.name);
        }, { timeout: 20_000 }).toEqual([SLOT_A]);

        const state = await readCardBoundState(page);
        expect(state.presets[0].temperature).toBeCloseTo(SLOT_A_TEMP, 5);
        // First-add bootstraps the default (Layer 1 contract).
        expect(state.defaultPresetName).toBe(SLOT_A);
        // Loop override persisted with the AI's promptPresetName patch.
        const override = await readCharacterOrchestratorOverride(page);
        expect(override).not.toBeNull();

        await closeIterStudio(page).catch(() => {});
    });

    test('Save names only: loop override written without embedding preset body', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        await seedGlobalPresetOnce(page, { name: SLOT_A, temperature: SLOT_A_TEMP });
        await selectCharacterByName(page, CHAR_NAME);
        await openIterStudio(page, 'orch');

        mock.scriptToolCall({
            name: 'luker_orch_set_loop_profile',
            arguments: { promptPresetName: SLOT_A },
        });
        await sendIterPrompt(page, 'orch', `Bind the loop prompt preset to ${SLOT_A}.`);
        await applyIterBatch(page, 'orch');

        const dialog = await awaitSummaryPopup(page, SLOT_A);
        // "Save names only" is the customButton — ST tags it with the
        // .popup-button-custom class in addition to .menu_button (see
        // the #44 helper comment).
        const namesOnlyBtn = dialog.locator('.popup-button-custom', { hasText: /Save names only/i }).first();
        await namesOnlyBtn.waitFor({ state: 'visible', timeout: 5000 });
        await namesOnlyBtn.click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

        // Card should NOT have the preset embedded.
        const state = await readCardBoundState(page);
        expect(state.presets).toEqual([]);
        // Loop override should still be persisted.
        await expect.poll(async () => {
            const override = await readCharacterOrchestratorOverride(page);
            return override !== null;
        }, { timeout: 20_000 }).toBe(true);

        await closeIterStudio(page).catch(() => {});
    });

    test('Cancel: nothing persisted (no card presets, no orchestrator override)', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        await seedGlobalPresetOnce(page, { name: SLOT_A, temperature: SLOT_A_TEMP });
        await selectCharacterByName(page, CHAR_NAME);
        await openIterStudio(page, 'orch');

        mock.scriptToolCall({
            name: 'luker_orch_set_loop_profile',
            arguments: { promptPresetName: SLOT_A },
        });
        await sendIterPrompt(page, 'orch', `Bind the loop prompt preset to ${SLOT_A}.`);
        await applyIterBatch(page, 'orch');

        const dialog = await awaitSummaryPopup(page, SLOT_A);
        // Cancel is the trailing custom button so the order reads
        // [Embed all] [Save names only] [Cancel] left-to-right; the
        // built-in `.popup-button-cancel` is hidden on this popup.
        await dialog.locator('.popup-button-custom', { hasText: /^Cancel$/ }).first().click();
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

        // Give any pending persist queues a chance to drain if they were
        // going to fire (they should not — Cancel aborts the apply).
        await page.waitForTimeout(500);
        const cardState = await readCardBoundState(page);
        expect(cardState.presets).toEqual([]);
        const override = await readCharacterOrchestratorOverride(page);
        expect(override).toBeNull();

        await closeIterStudio(page).catch(() => {});
    });

    test('Already-embedded preset skips the popup: apply goes straight through to persist', async ({ page }) => {
        await resetCharacterOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        await seedGlobalPresetOnce(page, { name: SLOT_A, temperature: SLOT_A_TEMP });
        await selectCharacterByName(page, CHAR_NAME);

        // Pre-embed SlotA on the card via the real ctx.character.presets.add
        // API (three-layer contract).  This is a REAL API call, not a
        // DOM-state shim: presets.add is the exact same code path the
        // Embed-all button in the popup would drive, so this seeds the
        // card exactly as production would.
        await page.evaluate(async ({ name, temperature }) => {
            const ctx = window.Luker?.getContext?.();
            const chid = ctx?.characterId ?? window.this_chid;
            const character = ctx?.characters?.[chid];
            const body = ctx.getPresetManager('openai').getStoredPreset(name)
                     || { temperature };
            await ctx.character.presets.add(character, name, body);
        }, { name: SLOT_A, temperature: SLOT_A_TEMP });

        // Confirm the seed landed before we drive iter-studio.
        await expect.poll(async () => {
            const state = await readCardBoundState(page);
            return state.presets.map(p => p.name);
        }, { timeout: 15_000 }).toEqual([SLOT_A]);

        await openIterStudio(page, 'orch');
        mock.scriptToolCall({
            name: 'luker_orch_set_loop_profile',
            arguments: { promptPresetName: SLOT_A },
        });
        await sendIterPrompt(page, 'orch', `Bind the loop prompt preset to ${SLOT_A}.`);
        await applyIterBatch(page, 'orch');

        // Dismiss the customTools review popup (default profile ships
        // baked-in tools; the character-apply pipeline surfaces the
        // "Apply with tools / Cancel / Apply without tools" prompt
        // before reaching the preflight).
        const reviewDialog = page.locator('dialog.popup[open]:has-text("Apply with tools")');
        if (await reviewDialog.count() > 0) {
            await reviewDialog.first().locator('.popup-button-ok').first().click();
            await reviewDialog.first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
        }

        // No summary popup should appear — SlotA is already embedded on
        // the card so `collectUnembeddedPresets` returns [].  Wait a
        // beat so any popup that WAS going to render has time to.  The
        // iter-studio popup itself remains open and may mention SlotA
        // in its diff card, so match on the preflight-popup title
        // phrase instead (unique to the unembedded-preset summary).
        await page.waitForTimeout(750);
        const stalePreflight = page.locator('dialog.popup[open]', {
            hasText: 'not yet embedded',
        });
        await expect(stalePreflight).toHaveCount(0);

        // Loop override should be persisted straight through.
        await expect.poll(async () => {
            const override = await readCharacterOrchestratorOverride(page);
            return override !== null;
        }, { timeout: 20_000 }).toBe(true);

        await closeIterStudio(page).catch(() => {});
    });
});
