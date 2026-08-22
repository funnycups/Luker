// #43b — Clear Bound Chat Completion Preset now opens a salvage dialog
//        instead of silently wiping every card snapshot. The dialog lets
//        the user promote each slot to a global preset (with per-slot
//        rename) or discard it. Collisions with existing globals are
//        surfaced via a single Overwrite-all / Back / Cancel confirm.
//
// User-visible scenarios:
//   (1) Discard all → all slots wiped, no global preset written.
//   (2) Save all (no collision) → each slot promoted to a fresh global,
//       then all slots wiped.
//   (3) Mixed (some Save, some Discard) → only the Save slots become
//       global; all slots wiped.
//   (4) Save with collision → confirm popup → Overwrite → global gets
//       overwritten with card body; all slots wiped.
//   (5) Save with collision → Back → dialog reopens with picks preserved
//       so user can rename inline; second attempt with fresh name
//       succeeds without touching the collider.
//   (6) Cancel (from either the salvage dialog or the collision confirm)
//       → no writes anywhere; card snapshots intact.
//
// The Bug this test protects: previously "Clear Bound Chat Completion
// Preset" issued a single confirm and then wiped every card snapshot.
// Any Prompt-Manager edit made while the preset was card-bound only
// ever lived in the card snapshot — the global preset kept the pre-bind
// body — so Clear silently threw those edits away.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, savePresetAsViaButton, selectPresetByName, setCounterInput } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Salvage the Salvager';
const CHAR_AVATAR = 'salvage-the-salvager.png';

// Card slots. Values are distinctive so we can verify which body landed
// in which global preset after promote.
const SLOT_A = 'CardSlotA';
const SLOT_A_TEMP = 0.13;
const SLOT_B = 'CardSlotB';
const SLOT_B_TEMP = 0.31;
const SLOT_C = 'CardSlotC';
const SLOT_C_TEMP = 0.47;

// Global preset created before Clear to trigger the collision branch.
// Uses the SAME name as SLOT_A on the card. Different temp so a
// successful Overwrite is observable.
const GLOBAL_COLLIDER_TEMP = 0.99;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'clear-with-salvage',
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
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/** Read the card-bound state directly from the character in the browser's runtime. */
async function readCardState(page) {
    return page.evaluate(() => {
        const ctx = window.Luker?.getContext?.();
        const chid = ctx?.characterId ?? window.this_chid;
        const c = ctx?.characters?.[chid];
        const raw = c?.data?.extensions?.luker?.chat_completion_preset ?? null;
        if (!raw) return { presets: [], defaultPresetName: null, isNull: true };
        if (Array.isArray(raw?.presets)) return {
            presets: raw.presets.map(p => ({ name: p.name, temperature: p?.preset?.temperature ?? null })),
            defaultPresetName: raw.defaultPresetName ?? null,
            isNull: false,
        };
        return { raw, isNull: false };
    });
}

/** Read the stored body of a global (openai) preset by name, or null if missing. */
async function readGlobalPreset(page, name) {
    return page.evaluate((presetName) => {
        const mgr = window.Luker?.getContext?.()?.getPresetManager?.('openai');
        const body = mgr?.getStoredPreset?.(presetName) ?? null;
        if (!body) return null;
        // Return just the temperature — the rest of the body is a
        // full oai_settings snapshot which is huge and not needed for
        // the assertions.
        return { temperature: body.temperature ?? null };
    }, name);
}

async function readAllGlobalPresetNames(page) {
    return page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('#settings_preset_openai option'));
        return options
            .filter(o => !String(o.value ?? '').startsWith('__luker_card__::'))
            .map(o => String(o.textContent ?? '').trim())
            .filter(Boolean);
    });
}

async function fireDropdownAction(page, optionId) {
    const drawer = page.locator('#rightNavDrawerIcon');
    const closed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (closed) await drawer.click();
    await page.waitForSelector('#char-management-dropdown', { state: 'attached', timeout: 5000 });
    await page.evaluate((id) => {
        const sel = document.querySelector('#char-management-dropdown');
        if (!sel) throw new Error('#char-management-dropdown not found');
        const opt = sel.querySelector('#' + id);
        if (!opt) throw new Error(`option not present: #${id}`);
        opt.selected = true;
        if (window.jQuery) window.jQuery(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, optionId);
}

/** Wait for the salvage dialog to be visible + return its <dialog> locator. */
async function waitForSalvageDialog(page) {
    const dialog = page.locator('dialog.popup[open]:has(#luker_clear_bound_presets_dialog)').last();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    return dialog;
}

/** Wait for the collision confirm popup + return its <dialog> locator. */
async function waitForCollisionConfirm(page) {
    // Text content includes the phrase 'The following global presets already exist'.
    const dialog = page.locator('dialog.popup[open]').filter({
        hasText: /already exist and will be overwritten/i,
    }).last();
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    return dialog;
}

/** Set a single row in the salvage dialog to 'save' or 'discard'. */
async function setSalvageRowAction(dialog, slotName, action) {
    const row = dialog.locator(`.luker-cbp-row[data-slot-name="${slotName}"]`);
    await row.locator(`.luker-cbp-action[value="${action}"]`).check();
}

/** Set the inline global-preset target name for a specific row. */
async function setSalvageRowGlobalName(dialog, slotName, name) {
    const row = dialog.locator(`.luker-cbp-row[data-slot-name="${slotName}"]`);
    const input = row.locator('.luker-cbp-global-name');
    await input.fill(name);
    // Trigger 'input' so the dialog's picks map updates before OK.
    await input.dispatchEvent('input');
}

async function clickSalvageOk(dialog) {
    await dialog.locator('.popup-button-ok').first().click();
}

async function clickSalvageCancel(dialog) {
    await dialog.locator('.popup-button-cancel').first().click();
}

async function clickBulkDiscard(dialog) {
    await dialog.locator('.luker-cbp-bulk-discard').click();
}

async function clickBulkSaveAll(dialog) {
    await dialog.locator('.luker-cbp-bulk-save').click();
}

/** Seed the card with three slots with given names, default = second slot. */
async function seedThreeSlots(dataRoot, avatarFile, nameA = SLOT_A, nameB = SLOT_B, nameC = SLOT_C) {
    const { resolve } = await import('node:path');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { read: readPngCard, write: writePngCard } = await import('../../../src/character-card-parser.js');
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    if (!card.data) card.data = {};
    if (!card.data.extensions) card.data.extensions = {};
    if (!card.data.extensions.luker) card.data.extensions.luker = {};
    card.data.extensions.luker.chat_completion_preset = {
        presets: [
            { name: nameA, preset: { temperature: SLOT_A_TEMP, chat_completion_source: 'openai' } },
            { name: nameB, preset: { temperature: SLOT_B_TEMP, chat_completion_source: 'openai' } },
            { name: nameC, preset: { temperature: SLOT_C_TEMP, chat_completion_source: 'openai' } },
        ],
        defaultPresetName: nameB,
    };
    writeFileSync(path, writePngCard(png, JSON.stringify(card)));
}

async function resetCardBindings(dataRoot, avatarFile) {
    const { resolve } = await import('node:path');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { read: readPngCard, write: writePngCard } = await import('../../../src/character-card-parser.js');
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    if (card?.data?.extensions?.luker) delete card.data.extensions.luker.chat_completion_preset;
    if (card?.extensions?.luker) delete card.extensions.luker.chat_completion_preset;
    writeFileSync(path, writePngCard(png, JSON.stringify(card)));
}

test.describe.configure({ mode: 'serial' });

test.describe('#43b — Clear Bound Chat Completion Preset salvage dialog', () => {
    /**
     * Per-test unique suffix. The server is beforeAll-scoped, so any global
     * preset created in a prior test survives into later tests. Using a
     * unique suffix per test guarantees no accidental collision between
     * one test's promoted-slot names and another test's card slot names.
     */
    let testId = 0;
    const uniq = (base) => `${base}_t${testId}`;

    test.beforeEach(async () => {
        testId += 1;
        // Start each test from a clean 3-slot card, with NO collider
        // in the global preset library.
        await resetCardBindings(server.dataRoot, CHAR_AVATAR);
        await seedThreeSlots(server.dataRoot, CHAR_AVATAR, uniq(SLOT_A), uniq(SLOT_B), uniq(SLOT_C));
    });

    test('(1) Discard all: wipes all card slots, does NOT touch the global preset library', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        const globalsBefore = await readAllGlobalPresetNames(page);

        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        const dialog = await waitForSalvageDialog(page);

        await clickBulkDiscard(dialog);
        await clickSalvageOk(dialog);

        // Card fully wiped.
        await expect.poll(async () => (await readCardState(page)).isNull, { timeout: 10_000 }).toBe(true);

        // Global preset library untouched.
        const globalsAfter = await readAllGlobalPresetNames(page);
        expect(globalsAfter.sort()).toEqual(globalsBefore.sort());
    });

    test('(2) Save all (no collision): each slot becomes a fresh global; card wiped', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        const a = uniq(SLOT_A), b = uniq(SLOT_B), c = uniq(SLOT_C);
        // Confirm none of the slot names collide with existing globals.
        const globalsBefore = new Set(await readAllGlobalPresetNames(page));
        for (const name of [a, b, c]) {
            expect(globalsBefore.has(name)).toBe(false);
        }

        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        const dialog = await waitForSalvageDialog(page);
        // Default is Save for every row — just click OK.
        await clickSalvageOk(dialog);

        // Card fully wiped.
        await expect.poll(async () => (await readCardState(page)).isNull, { timeout: 10_000 }).toBe(true);

        // Each slot now exists as a global with the seed body.
        expect((await readGlobalPreset(page, a))?.temperature).toBeCloseTo(SLOT_A_TEMP, 5);
        expect((await readGlobalPreset(page, b))?.temperature).toBeCloseTo(SLOT_B_TEMP, 5);
        expect((await readGlobalPreset(page, c))?.temperature).toBeCloseTo(SLOT_C_TEMP, 5);
    });

    test('(3) Mixed Save/Discard: only Save slots become globals; card wiped', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        const a = uniq(SLOT_A), b = uniq(SLOT_B), c = uniq(SLOT_C);

        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        const dialog = await waitForSalvageDialog(page);

        await setSalvageRowAction(dialog, a, 'save');
        await setSalvageRowAction(dialog, b, 'discard');
        await setSalvageRowAction(dialog, c, 'save');
        await clickSalvageOk(dialog);

        await expect.poll(async () => (await readCardState(page)).isNull, { timeout: 10_000 }).toBe(true);

        expect((await readGlobalPreset(page, a))?.temperature).toBeCloseTo(SLOT_A_TEMP, 5);
        expect(await readGlobalPreset(page, b)).toBeNull();
        expect((await readGlobalPreset(page, c))?.temperature).toBeCloseTo(SLOT_C_TEMP, 5);
    });

    test('(4) Save with collision → Overwrite all: existing global gets card body; card wiped', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const a = uniq(SLOT_A);
        // Create a global preset with the SAME name as the SLOT_A slot
        // so the salvage dialog surfaces a collision confirm on OK.
        // Save-as via the real "New preset" button so the state matches
        // what a user would produce interactively.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', GLOBAL_COLLIDER_TEMP);
        await savePresetAsViaButton(page, a);

        // Sanity: the collider now exists at GLOBAL_COLLIDER_TEMP, not SLOT_A_TEMP.
        expect((await readGlobalPreset(page, a))?.temperature).toBeCloseTo(GLOBAL_COLLIDER_TEMP, 5);

        await selectCharacterByName(page, CHAR_NAME);
        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        const dialog = await waitForSalvageDialog(page);
        // Save every row — slot A will collide with the global we just
        // saved. The dialog defaults to save for all rows.
        await clickSalvageOk(dialog);

        // Collision popup appears; accept "Overwrite all".
        const confirm = await waitForCollisionConfirm(page);
        await confirm.locator('.popup-button-ok').first().click();

        // Card fully wiped.
        await expect.poll(async () => (await readCardState(page)).isNull, { timeout: 10_000 }).toBe(true);

        // Slot A's global body was OVERWRITTEN with the card snapshot.
        expect((await readGlobalPreset(page, a))?.temperature).toBeCloseTo(SLOT_A_TEMP, 5);
        expect((await readGlobalPreset(page, uniq(SLOT_B)))?.temperature).toBeCloseTo(SLOT_B_TEMP, 5);
        expect((await readGlobalPreset(page, uniq(SLOT_C)))?.temperature).toBeCloseTo(SLOT_C_TEMP, 5);
    });

    test('(5) Save with collision → Back → rename inline → succeeds without touching collider', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const a = uniq(SLOT_A);
        // Create a global preset colliding with slot A.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', GLOBAL_COLLIDER_TEMP);
        await savePresetAsViaButton(page, a);
        const originalColliderTemp = (await readGlobalPreset(page, a)).temperature;

        await selectCharacterByName(page, CHAR_NAME);
        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        let dialog = await waitForSalvageDialog(page);
        // Discard B and C so this test only wrestles with slot A's
        // collision, not compound collisions with B and C too.
        await setSalvageRowAction(dialog, uniq(SLOT_B), 'discard');
        await setSalvageRowAction(dialog, uniq(SLOT_C), 'discard');
        await clickSalvageOk(dialog);

        // Collision popup → click Back (customButtons[0], mapped to
        // POPUP_RESULT.CUSTOM1).
        const confirm = await waitForCollisionConfirm(page);
        await confirm.getByRole('button', { name: /^Back$/ }).click();

        // Salvage dialog re-opens.
        dialog = await waitForSalvageDialog(page);

        // Inline rename slot A → a fresh name to dodge the collider.
        const salvagedName = a + '_renamed';
        await setSalvageRowGlobalName(dialog, a, salvagedName);
        // Re-apply discards on B and C — the re-open preserved picks,
        // but paranoia is cheap.
        await setSalvageRowAction(dialog, uniq(SLOT_B), 'discard');
        await setSalvageRowAction(dialog, uniq(SLOT_C), 'discard');

        await clickSalvageOk(dialog);

        // No second collision confirm this time — accept quickly.
        // Card wiped.
        await expect.poll(async () => (await readCardState(page)).isNull, { timeout: 10_000 }).toBe(true);

        // The renamed target got the card's slot A body.
        expect((await readGlobalPreset(page, salvagedName))?.temperature).toBeCloseTo(SLOT_A_TEMP, 5);
        // The original collider is UNCHANGED.
        expect((await readGlobalPreset(page, a))?.temperature).toBeCloseTo(originalColliderTemp, 5);
    });

    test('(6) Cancel from salvage dialog: no writes; card intact', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        const beforeCard = await readCardState(page);
        expect(beforeCard.presets?.length).toBe(3);

        const globalsBefore = await readAllGlobalPresetNames(page);

        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        const dialog = await waitForSalvageDialog(page);
        await clickSalvageCancel(dialog);

        // Card unchanged.
        await expect.poll(async () => (await readCardState(page)).presets?.length ?? -1, { timeout: 5000 }).toBe(3);

        // Global preset library unchanged.
        const globalsAfter = await readAllGlobalPresetNames(page);
        expect(globalsAfter.sort()).toEqual(globalsBefore.sort());
    });
});
