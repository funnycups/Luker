// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// #62 — Removing a card-bound preset slot offers to promote the current
//        card-snapshot body to a global preset (with name collision
//        handling), instead of silently discarding it.
//
// Regression driver:
//   The old flow (`Popup.show.confirm`) drops the slot on OK and returns
//   on Cancel — no third option. When a user added prompts / adjusted
//   samplers on a card-bound preset (edits persisted via the
//   SETTINGS_UPDATED → syncCharacterBoundPresetFromSettings sidecar to
//   the CARD snapshot only), then clicked Delete in the Manage dialog,
//   every edit made while the preset was bound was lost — the card slot
//   was the sole store for those edits.
//
// Real UI flow (validated by this file):
//   1. Seed a card with a bound slot whose body carries a distinctive
//      marker prompt entry + a distinctive temperature (proxy for
//      "Prompt Manager edits made while bound").
//   2. Open Manage dialog → click Delete on the slot's row.
//   3. Assert the confirm popup shows three buttons: Save to global
//      preset (OK) / Discard (CUSTOM1) / Cancel.
//   4. Branch A (promote to a NEW global name): click OK → input popup
//      pre-filled with slot name; enter a fresh unused name; assert
//      global preset created with the snapshot body verbatim; card slot
//      removed.
//   5. Branch B (promote → name COLLIDES → Overwrite): reseed; click OK;
//      keep default name (which is now taken); assert collision popup;
//      click Overwrite; assert existing global preset's body replaced
//      with snapshot; slot removed.
//   6. Branch C (promote → name COLLIDES → Rename): reseed; click OK;
//      keep default (taken); collision popup → click Rename → back to
//      input popup with same candidate → change to unused name → assert
//      new global created; original global untouched; slot removed.
//   7. Branch D (Discard — legacy behavior): reseed; click Delete → click
//      Discard; assert slot removed and NO new global preset touched.
//   8. Branch E (Cancel from initial popup): reseed; click Delete → click
//      Cancel; assert slot INTACT (name + body unchanged); no global
//      side effects.
//   9. Branch F (Cancel at input popup after choosing Save): reseed;
//      click Delete → click Save → Cancel the input; assert slot INTACT.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import { normalizeIterStudioSettings, savePresetAsViaButton, selectPresetByName, setCounterInput } from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard, write as writePngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CARD_NAME = 'Promoter Aria';
const CARD_AVATAR = 'promoter-aria.png';
const SLOT_NAME = 'BoundEditedSlot';
const MARKER_TEMP = 0.37;
const MARKER_IDENTIFIER = 'luker-e2e-62-marker-prompt';
const MARKER_CONTENT = 'This entry exists ONLY in the card snapshot.';

function makeSnapshotBody() {
    // Minimal but distinctive body — the collision-vs-fresh assertions
    // read `temperature` and the marker prompt from the persisted global
    // preset to confirm the card snapshot was actually written, not a
    // stale global overriding.
    return {
        chat_completion_source: 'openai',
        temperature: MARKER_TEMP,
        prompts: [{
            identifier: MARKER_IDENTIFIER,
            name: 'e2e marker',
            role: 'system',
            content: MARKER_CONTENT,
            enabled: true,
        }],
    };
}

/** Rewrite the character card's chat_completion_preset field on disk. */
function seedCardSlot(dataRoot, avatarFile, slotName, body) {
    const p = path.resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = fs.readFileSync(p);
    const card = JSON.parse(readPngCard(png));
    card.data = card.data || {};
    card.data.extensions = card.data.extensions || {};
    card.data.extensions.luker = card.data.extensions.luker || {};
    card.data.extensions.luker.chat_completion_preset = {
        presets: [{ name: slotName, preset: body }],
        defaultPresetName: slotName,
    };
    if (card.extensions?.luker) {
        card.extensions.luker.chat_completion_preset = card.data.extensions.luker.chat_completion_preset;
    }
    fs.writeFileSync(p, writePngCard(png, JSON.stringify(card)));
}

function readGlobalPresetFile(dataRoot, presetName) {
    // OpenAI presets live under `default-user/OpenAI Settings/<name>.json`.
    const p = path.resolve(dataRoot, 'default-user', 'OpenAI Settings', `${presetName}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listGlobalPresetFiles(dataRoot) {
    const dir = path.resolve(dataRoot, 'default-user', 'OpenAI Settings');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
}

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'cardbound-remove-promote-to-global',
        extraConfig: { 'storage.mode': 'fs' },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: CARD_AVATAR,
        overrides: { name: CARD_NAME },
    });
    normalizeIterStudioSettings(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Trigger a `#char-management-dropdown` option by id — same helper as #43/#61.
 */
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

/** Wait for a fresh popup on top and return its data-id. */
async function waitTopPopup(page, { timeout = 5000 } = {}) {
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout });
    return { popup, dataId: await popup.getAttribute('data-id') };
}

async function waitPopupClosed(page, dataId, { timeout = 5000 } = {}) {
    if (!dataId) return;
    await page.locator(`dialog.popup[data-id="${dataId}"]`).waitFor({ state: 'hidden', timeout }).catch(() => {});
}

/** Reload the page + re-select the character so the manage-dialog reads the
 *  freshly-seeded on-disk card. selectCharacterByName after seed also refreshes
 *  the runtime `characters[]` entry with the new extensions payload. */
async function reseed(page, body = makeSnapshotBody()) {
    seedCardSlot(server.dataRoot, CARD_AVATAR, SLOT_NAME, body);
    // Force character re-read: reload the page so the character list is
    // rebuilt from disk (an in-memory selectCharacterByName would use the
    // stale characters[] entry loaded at page open).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, CARD_NAME);
    // Wait for the card-bound state to activate (ghost optgroup wired).
    await page.waitForFunction(() => {
        const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
        return Boolean(opt);
    }, { timeout: 15_000 });
}

async function openManageAndClickRemove(page) {
    await fireDropdownAction(page, 'manage_character_bound_presets');
    const dialog = page.locator('#luker_manage_bound_presets_dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    const row = dialog.locator(`.luker-mbp-row[data-preset-name="${SLOT_NAME}"]`);
    await row.waitFor({ state: 'visible', timeout: 5000 });
    await row.locator('.luker-mbp-remove').click();
    return waitTopPopup(page);
}

test.describe.configure({ mode: 'serial' });

test.describe('#62 — remove card-bound preset offers promote to global with collision handling', () => {
    test('Branch A: promote to a fresh (uncollided) global preset name', async ({ page }) => {
        await reseed(page);
        const beforeGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));

        const { popup, dataId } = await openManageAndClickRemove(page);
        // The first popup should show three actionable buttons.
        const okBtn = popup.locator('.popup-button-ok').first();
        const custom1Btn = popup.locator('.popup-button-custom[data-result="1001"]').first();
        const cancelBtn = popup.locator('.popup-button-cancel').first();
        await expect(okBtn).toBeVisible();
        await expect(custom1Btn).toBeVisible();
        await expect(cancelBtn).toBeVisible();
        // Body text mentions the slot name.
        await expect(popup).toContainText(SLOT_NAME);

        // Click Save to global preset.
        await okBtn.click();
        await waitPopupClosed(page, dataId);

        // Input popup with default = slot name.
        const { popup: inputPopup, dataId: inputId } = await waitTopPopup(page);
        const input = inputPopup.locator('input[type="text"], textarea').first();
        await input.waitFor({ state: 'visible', timeout: 5000 });
        await expect(input).toHaveValue(SLOT_NAME);
        const freshName = 'PromotedFreshA';
        await input.fill(freshName);
        await inputPopup.locator('.popup-button-ok').first().click();
        await waitPopupClosed(page, inputId);

        // Global preset file now exists with the snapshot's marker temp + prompt.
        await expect.poll(
            () => readGlobalPresetFile(server.dataRoot, freshName)?.temperature ?? null,
            { timeout: 10_000 },
        ).toBeCloseTo(MARKER_TEMP, 5);
        const persisted = readGlobalPresetFile(server.dataRoot, freshName);
        expect(Array.isArray(persisted?.prompts)).toBe(true);
        expect(persisted.prompts.find(p => p?.identifier === MARKER_IDENTIFIER)?.content).toBe(MARKER_CONTENT);

        // Global list actually grew (nothing else touched).
        const afterGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));
        const added = [...afterGlobalPresets].filter(f => !beforeGlobalPresets.has(f));
        expect(added).toContain(`${freshName}.json`);

        // Card slot is gone.
        await expect.poll(async () => {
            const state = await page.evaluate((n) => {
                const ctx = window.SillyTavern?.getContext();
                const c = ctx?.characters?.find(ch => ch?.name === n);
                const raw = c?.data?.extensions?.luker?.chat_completion_preset;
                if (!raw) return { presets: [], isNull: true };
                if (Array.isArray(raw.presets)) return { presets: raw.presets.map(p => p.name), isNull: false };
                return { presets: [], isNull: false };
            }, CARD_NAME);
            return state.presets;
        }, { timeout: 5000 }).toEqual([]);
    });

    test('Branch B: promote collides with existing global preset → Overwrite', async ({ page }) => {
        await reseed(page);
        // Pre-seed a global preset that will collide with the SLOT_NAME
        // default candidate. Use the real Save-preset-as UI gesture so we
        // exercise the same preset-creation path a user would.
        //
        // In card-bound mode the currently-selected preset is the ghost
        // option (temperature = MARKER_TEMP from the snapshot). Switch to
        // Default first + set a distinct temp so the created global's body
        // is clearly distinguishable from the snapshot in later assertions.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', 0.99);
        await savePresetAsViaButton(page, SLOT_NAME);
        // Re-select the card-bound ghost so the manage dialog + remove
        // flow run under the same runtime state as a real user (card
        // active).
        await selectCharacterByName(page, CARD_NAME);
        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return Boolean(opt);
        }, { timeout: 10_000 });

        // Sanity-check the global preset exists with the pre-existing temp.
        await expect.poll(
            () => readGlobalPresetFile(server.dataRoot, SLOT_NAME)?.temperature ?? null,
            { timeout: 5000 },
        ).toBeCloseTo(0.99, 5);

        const { popup, dataId } = await openManageAndClickRemove(page);
        await popup.locator('.popup-button-ok').first().click();  // Save to global preset
        await waitPopupClosed(page, dataId);

        // Input popup — default candidate is the (colliding) slot name; accept as-is.
        const { popup: inputPopup, dataId: inputId } = await waitTopPopup(page);
        const input = inputPopup.locator('input[type="text"], textarea').first();
        await expect(input).toHaveValue(SLOT_NAME);
        await inputPopup.locator('.popup-button-ok').first().click();
        await waitPopupClosed(page, inputId);

        // Collision popup: Overwrite (OK) / Rename (CUSTOM1) / Cancel.
        const { popup: collisionPopup, dataId: collisionId } = await waitTopPopup(page);
        await expect(collisionPopup).toContainText(SLOT_NAME);
        const overwriteBtn = collisionPopup.locator('.popup-button-ok').first();
        const renameBtn = collisionPopup.locator('.popup-button-custom[data-result="1001"]').first();
        await expect(overwriteBtn).toBeVisible();
        await expect(renameBtn).toBeVisible();
        await overwriteBtn.click();
        await waitPopupClosed(page, collisionId);

        // Existing global preset body is now the snapshot body.
        await expect.poll(
            () => readGlobalPresetFile(server.dataRoot, SLOT_NAME)?.temperature ?? null,
            { timeout: 10_000 },
        ).toBeCloseTo(MARKER_TEMP, 5);
        const persisted = readGlobalPresetFile(server.dataRoot, SLOT_NAME);
        expect(persisted.prompts?.find(p => p?.identifier === MARKER_IDENTIFIER)?.content).toBe(MARKER_CONTENT);

        // Card slot removed.
        await expect.poll(async () => page.evaluate((n) => {
            const c = window.SillyTavern?.getContext()?.characters?.find(ch => ch?.name === n);
            const raw = c?.data?.extensions?.luker?.chat_completion_preset;
            return Array.isArray(raw?.presets) ? raw.presets.length : 0;
        }, CARD_NAME), { timeout: 5000 }).toBe(0);
    });

    test('Branch C: collision → Rename loops back to input, second name succeeds', async ({ page }) => {
        await reseed(page);
        // Pre-seed a colliding global preset via real UI gesture (see Branch B).
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', 0.11);
        await savePresetAsViaButton(page, SLOT_NAME);
        await selectCharacterByName(page, CARD_NAME);
        await page.waitForFunction(() => {
            const opt = document.querySelector('#settings_preset_openai option[data-luker-char-bound="1"]');
            return Boolean(opt);
        }, { timeout: 10_000 });

        const { popup, dataId } = await openManageAndClickRemove(page);
        await popup.locator('.popup-button-ok').first().click();
        await waitPopupClosed(page, dataId);

        const { popup: input1, dataId: input1Id } = await waitTopPopup(page);
        await input1.locator('.popup-button-ok').first().click();
        await waitPopupClosed(page, input1Id);

        const { popup: collision, dataId: collId } = await waitTopPopup(page);
        // Click Rename (CUSTOM1).
        await collision.locator('.popup-button-custom[data-result="1001"]').first().click();
        await waitPopupClosed(page, collId);

        // Input popup re-opens (same candidate). Change the name to something fresh.
        const { popup: input2, dataId: input2Id } = await waitTopPopup(page);
        const inp = input2.locator('input[type="text"], textarea').first();
        await expect(inp).toHaveValue(SLOT_NAME);
        const freshName = 'PromotedRenamedC';
        await inp.fill(freshName);
        await input2.locator('.popup-button-ok').first().click();
        await waitPopupClosed(page, input2Id);

        // New global preset created with snapshot body.
        await expect.poll(
            () => readGlobalPresetFile(server.dataRoot, freshName)?.temperature ?? null,
            { timeout: 10_000 },
        ).toBeCloseTo(MARKER_TEMP, 5);
        // Original colliding global preset UNTOUCHED.
        const original = readGlobalPresetFile(server.dataRoot, SLOT_NAME);
        expect(original?.temperature).toBeCloseTo(0.11, 5);
        expect((original?.prompts ?? []).find(p => p?.identifier === MARKER_IDENTIFIER)).toBeUndefined();

        // Slot removed.
        await expect.poll(async () => page.evaluate((n) => {
            const c = window.SillyTavern?.getContext()?.characters?.find(ch => ch?.name === n);
            return Array.isArray(c?.data?.extensions?.luker?.chat_completion_preset?.presets)
                ? c.data.extensions.luker.chat_completion_preset.presets.length
                : 0;
        }, CARD_NAME), { timeout: 5000 }).toBe(0);
    });

    test('Branch D: Discard drops the slot WITHOUT writing to global preset library', async ({ page }) => {
        await reseed(page);
        const beforeGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));

        const { popup, dataId } = await openManageAndClickRemove(page);
        // Discard (CUSTOM1).
        await popup.locator('.popup-button-custom[data-result="1001"]').first().click();
        await waitPopupClosed(page, dataId);

        // No follow-up popup — the discard branch just deletes.
        // Slot gone.
        await expect.poll(async () => page.evaluate((n) => {
            const c = window.SillyTavern?.getContext()?.characters?.find(ch => ch?.name === n);
            const raw = c?.data?.extensions?.luker?.chat_completion_preset;
            return Array.isArray(raw?.presets) ? raw.presets.length : (raw ? -1 : 0);
        }, CARD_NAME), { timeout: 5000 }).toBe(0);

        // Global preset library untouched.
        const afterGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));
        const added = [...afterGlobalPresets].filter(f => !beforeGlobalPresets.has(f));
        expect(added).toEqual([]);
    });

    test('Branch E: Cancel on initial popup preserves the slot as-is', async ({ page }) => {
        await reseed(page);
        const beforeGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));

        const { popup, dataId } = await openManageAndClickRemove(page);
        // Cancel — the popup-button-cancel closes with POPUP_RESULT.NEGATIVE / CANCELLED.
        await popup.locator('.popup-button-cancel').first().click();
        await waitPopupClosed(page, dataId);
        // Close the still-open manage dialog for a clean state.
        // (nothing to assert on the dialog itself besides slot intact)

        // Slot still intact with marker content.
        const slot = await page.evaluate((n) => {
            const c = window.SillyTavern?.getContext()?.characters?.find(ch => ch?.name === n);
            const raw = c?.data?.extensions?.luker?.chat_completion_preset;
            const hit = raw?.presets?.[0];
            return hit ? { name: hit.name, temperature: hit.preset?.temperature, markerContent: hit.preset?.prompts?.find(p => p?.identifier === 'luker-e2e-62-marker-prompt')?.content } : null;
        }, CARD_NAME);
        expect(slot?.name).toBe(SLOT_NAME);
        expect(slot?.temperature).toBeCloseTo(MARKER_TEMP, 5);
        expect(slot?.markerContent).toBe(MARKER_CONTENT);

        // Global library untouched.
        const afterGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));
        const added = [...afterGlobalPresets].filter(f => !beforeGlobalPresets.has(f));
        expect(added).toEqual([]);
    });

    test('Branch F: Save to global → Cancel on name input aborts and preserves the slot', async ({ page }) => {
        await reseed(page);
        const beforeGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));

        const { popup, dataId } = await openManageAndClickRemove(page);
        await popup.locator('.popup-button-ok').first().click(); // Save to global preset
        await waitPopupClosed(page, dataId);

        const { popup: inputPopup, dataId: inputId } = await waitTopPopup(page);
        await inputPopup.locator('.popup-button-cancel').first().click();
        await waitPopupClosed(page, inputId);

        // Slot still there.
        const state = await page.evaluate((n) => {
            const c = window.SillyTavern?.getContext()?.characters?.find(ch => ch?.name === n);
            const raw = c?.data?.extensions?.luker?.chat_completion_preset;
            return Array.isArray(raw?.presets) ? raw.presets.map(p => p.name) : [];
        }, CARD_NAME);
        expect(state).toEqual([SLOT_NAME]);

        // Global library untouched.
        const afterGlobalPresets = new Set(listGlobalPresetFiles(server.dataRoot));
        const added = [...afterGlobalPresets].filter(f => !beforeGlobalPresets.has(f));
        expect(added).toEqual([]);
    });
});
