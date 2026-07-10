// #43 — `#bind_character_chat_completion_preset` is multi-slot additive
//        with always-set-as-default semantics; `#manage_character_bound_presets`
//        opens the slot-manager dialog covering the full set-default /
//        overwrite-from-current / update-from-local / delete / add-from-local
//        matrix.
//
// REAL USER-GESTURE flow:
//   1. Seed a character (no existing card-bound slots).
//   2. Create two distinguishable global presets ("SlotA", "SlotB") with
//      different temperatures.
//   3. Select the character; select SlotA in the openai preset select;
//      click Bind → assert card now has [SlotA] and defaultPresetName=SlotA.
//   4. Select SlotB; Bind → card now has [SlotA, SlotB]; defaultPresetName
//      MUST be SlotB — Bind always sets-as-default (not just first-add
//      bootstrap).
//   5. Bind SlotB again → confirm popup text mentions "Overwrite"
//      (duplicate-detection prompt distinguishes overwrite from append).
//   6. Select the card-bound ghost option for SlotA → Bind → should be
//      blocked with info toast (already bound on this card).
//   7. Open the Manage dialog → assert two rows exist, SlotB marked default.
//      Click "Set as default" on SlotA → row default marker moves.
//   8. Overwrite from current: select a global preset with different temp,
//      click "Overwrite from current" on SlotA → slot's stored body
//      temperature matches the currently-selected preset's temp.
//   9. Update from local: mutate SlotB's global preset (change temp), open
//      Manage, click "Update from local" on SlotB → slot's stored body
//      picks up the new temp.
//  10. Delete SlotA → row disappears; card presets[] length becomes 1.
//  11. Add-from-local: open Manage; select SlotA from the "Add from local"
//      dropdown; click Add → card has [SlotB, SlotA] again.
//  12. Clear (whole nuke) via the "Clear Bound Chat Completion Preset"
//      dropdown entry → confirm → card has null chat_completion_preset.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import {
    normalizeIterStudioSettings,
    selectPresetByName,
    savePresetAsViaButton,
    setCounterInput,
} from './_helpers.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';

let server, mock;

const CHAR_NAME = 'Bindy the Binder';
const CHAR_AVATAR = 'bindy-the-binder.png';
const SLOT_A = 'SlotA';
const SLOT_B = 'SlotB';
const SLOT_A_TEMP = 0.11;
const SLOT_B_TEMP = 0.22;
const OVERWRITE_SEED_TEMP = 0.33;
const UPDATED_B_TEMP = 0.44;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({
        batchKey: 'preset',
        scenarioId: 'bind-and-manage-dialog',
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
        if (Array.isArray(raw?.presets)) return { presets: raw.presets.map(p => ({ name: p.name, temperature: p?.preset?.temperature ?? null })), defaultPresetName: raw.defaultPresetName ?? null, isNull: false };
        return { raw, isNull: false };
    });
}

/**
 * Trigger a `#char-management-dropdown` action by option-id. Mirrors the
 * gesture used by `bindCurrentPresetToCharacter` in `_helpers.js`.
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

/**
 * Select a preset in `#settings_preset_openai` restricted to a specific origin.
 * When both a card-bound ghost option and a same-named global option are
 * present, `selectPresetByName` picks the first-matching text (usually
 * the ghost). This helper filters by option value: card-bound options'
 * values start with `__luker_card__::`, globals do not.
 *
 * For origin='global' the selector's resolved value is the option's numeric
 * index (openai uses index-keyed presets — cf. preset-manager.js:1028). We
 * wait on `chatCompletionSettings.preset_settings_openai === target` instead
 * of comparing the raw value against the name.
 */
async function selectPresetByNameFromOrigin(page, name, origin) {
    await page.evaluate(async ({ target, wantOrigin }) => {
        const $sel = window.jQuery?.('#settings_preset_openai');
        if (!$sel?.length) throw new Error('settings_preset_openai not found');
        const opt = $sel.find('option').filter((_i, el) => {
            if (String(el.textContent).trim() !== target) return false;
            const isCardBound = String(el.value ?? '').startsWith('__luker_card__::');
            return wantOrigin === 'card' ? isCardBound : !isCardBound;
        }).first();
        if (!opt.length) throw new Error(`preset option not found: ${target} (origin=${wantOrigin})`);
        $sel.val(String(opt.val())).trigger('change');
        await new Promise(r => setTimeout(r, 50));
    }, { target: name, wantOrigin: origin });
    if (origin === 'card') {
        await page.waitForFunction((target) => {
            const v = String(document.querySelector('#settings_preset_openai')?.value ?? '');
            return v.startsWith('__luker_card__::') && v.includes(encodeURIComponent(target));
        }, name, { timeout: 10_000 });
    } else {
        // Global path — preset_settings_openai carries the name at runtime.
        await page.waitForFunction((target) => {
            const ctx = window.Luker?.getContext?.();
            return ctx?.chatCompletionSettings?.preset_settings_openai === target;
        }, name, { timeout: 10_000 });
    }
}

/** Accept the top-most ST popup that just opened (click OK) and wait for
 *  it to close. Uses the dialog's data-id so we only wait on the ACCEPTED
 *  popup, not any older dialog underneath (e.g. the Manage dialog when
 *  accepting a Remove confirmation dialog stacked on top). */
async function acceptPopup(page, { timeout = 5000 } = {}) {
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout });
    const dataId = await popup.getAttribute('data-id');
    await popup.locator('.popup-button-ok').first().click();
    if (dataId) {
        await page.locator(`dialog.popup[data-id="${dataId}"]`).waitFor({ state: 'hidden', timeout }).catch(() => {});
    }
}

/** Wait for the settings save that fires after Layer 1 writeExtensionField merges the update. */
async function waitForCardSlotCount(page, expected, { timeoutMs = 10_000 } = {}) {
    await expect.poll(async () => (await readCardState(page)).presets?.length ?? -1, { timeout: timeoutMs }).toBe(expected);
}

/** Wipe the target character card's chat_completion_preset field on disk so
 *  each test starts from a known baseline. Reads and rewrites the PNG through
 *  the character-card-parser used by writeEmbeddedCharacter. Runs while the
 *  server is up but before the page reloads its character list. */
async function resetCharacterCardBindingsOnDisk({ dataRoot, avatarFile }) {
    const { resolve } = await import('node:path');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { read: readPngCard, write: writePngCard } = await import('../../../src/character-card-parser.js');
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    if (!card.data) card.data = {};
    if (!card.data.extensions) card.data.extensions = {};
    if (!card.data.extensions.luker) card.data.extensions.luker = {};
    delete card.data.extensions.luker.chat_completion_preset;
    // Mirror the mutation on the top-level payload too (v2 dual-encoding).
    if (card.extensions && card.extensions.luker) {
        delete card.extensions.luker.chat_completion_preset;
    }
    writeFileSync(path, writePngCard(png, JSON.stringify(card)));
}

/** Seed the character's card-bound state directly on disk with the given
 *  {presets, defaultPresetName}. Bypasses the Bind UI for tests that focus
 *  on downstream behavior (Manage dialog, Clear). */
async function seedCharacterCardBindingsOnDisk({ dataRoot, avatarFile, state }) {
    const { resolve } = await import('node:path');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { read: readPngCard, write: writePngCard } = await import('../../../src/character-card-parser.js');
    const path = resolve(dataRoot, 'default-user', 'characters', avatarFile);
    const png = readFileSync(path);
    const card = JSON.parse(readPngCard(png));
    if (!card.data) card.data = {};
    if (!card.data.extensions) card.data.extensions = {};
    if (!card.data.extensions.luker) card.data.extensions.luker = {};
    card.data.extensions.luker.chat_completion_preset = state;
    writeFileSync(path, writePngCard(png, JSON.stringify(card)));
}

/** Close the currently-open ST popup (the outer <dialog>). */
async function closeCurrentPopup(page) {
    const dialog = page.locator('dialog.popup[open]').last();
    if (!(await dialog.isVisible().catch(() => false))) return;
    // popup-button-close is a top-level <div> inside <dialog>, sibling to popup-body.
    const closeBtn = dialog.locator('.popup-button-close').first();
    if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
    } else {
        await page.keyboard.press('Escape');
    }
    await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

test.describe('#43 — Bind (add + set-default) and Manage Bound Presets dialog', () => {
    test('Bind Current is additive and always sets-as-default; duplicate prompt confirms overwrite', async ({ page }) => {
        await resetCharacterCardBindingsOnDisk({ dataRoot: server.dataRoot, avatarFile: CHAR_AVATAR });
        await awaitMainUI(page, server.baseURL);

        // Create two distinguishable global presets.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', SLOT_A_TEMP);
        await savePresetAsViaButton(page, SLOT_A);
        await setCounterInput(page, '#temp_counter_openai', SLOT_B_TEMP);
        await savePresetAsViaButton(page, SLOT_B);

        await selectCharacterByName(page, CHAR_NAME);

        // ── Bind SlotA ────────────────────────────────────────────────
        await selectPresetByNameFromOrigin(page, SLOT_A, 'global');
        await fireDropdownAction(page, 'bind_character_chat_completion_preset');
        await acceptPopup(page);
        await waitForCardSlotCount(page, 1);
        {
            const state = await readCardState(page);
            expect(state.presets.map(p => p.name)).toEqual([SLOT_A]);
            expect(state.defaultPresetName).toBe(SLOT_A);
        }

        // ── Bind SlotB — must APPEND (not replace) AND set-as-default ─
        await selectPresetByNameFromOrigin(page, SLOT_B, 'global');
        await fireDropdownAction(page, 'bind_character_chat_completion_preset');
        await acceptPopup(page);
        await waitForCardSlotCount(page, 2);
        {
            const state = await readCardState(page);
            expect(state.presets.map(p => p.name).sort()).toEqual([SLOT_A, SLOT_B]);
            expect(state.defaultPresetName).toBe(SLOT_B);
        }

        // ── Bind SlotB again — duplicate should show a distinct "overwrite" confirm ─
        // Selector auto-swapped to the SlotB GHOST after set-as-default. Explicitly
        // pick the GLOBAL SlotB so origin.kind is 'global' — otherwise Bind blocks
        // with the "already bound" info toast (that path is asserted in the
        // "Bind Current is blocked …" test).
        await selectPresetByNameFromOrigin(page, SLOT_B, 'global');
        await fireDropdownAction(page, 'bind_character_chat_completion_preset');
        // Duplicate detection: confirm text differs (mentions "Overwrite" / "覆盖").
        const popup = page.locator('dialog.popup[open]').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        const bodyText = await popup.locator('.popup-body, .popup-content').first().textContent();
        expect(bodyText || '').toMatch(/[Oo]verwrite|覆盖|覆蓋/);
        // Cancel — no state change expected.
        await popup.locator('.popup-button-cancel').first().click();
        await popup.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        await waitForCardSlotCount(page, 2);
    });

    test('Bind Current is blocked when the currently-selected preset is already a card-bound ghost option', async ({ page }) => {
        // Fresh state: seed [SlotA, SlotB] default=SlotB.
        await seedCharacterCardBindingsOnDisk({
            dataRoot: server.dataRoot,
            avatarFile: CHAR_AVATAR,
            state: {
                presets: [
                    { name: SLOT_A, preset: { temperature: SLOT_A_TEMP, chat_completion_source: 'openai' } },
                    { name: SLOT_B, preset: { temperature: SLOT_B_TEMP, chat_completion_source: 'openai' } },
                ],
                defaultPresetName: SLOT_B,
            },
        });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        // The ghost auto-applies SlotB on character-select — the selector's
        // value is already the __luker_card__::... encoded option. Clicking
        // Bind now must NOT reopen the confirm; instead surface an info toast.
        await page.waitForFunction(() => {
            const v = String(document.querySelector('#settings_preset_openai')?.value ?? '');
            return v.startsWith('__luker_card__::');
        }, { timeout: 10_000 });

        await fireDropdownAction(page, 'bind_character_chat_completion_preset');
        // No confirm popup — the handler bails after an info toast.
        // Give the handler a moment to run.
        await page.waitForTimeout(500);
        const popupCount = await page.locator('dialog.popup[open]').count();
        expect(popupCount).toBe(0);
    });

    test('Manage dialog: lists slots, marks default, set-default, overwrite-from-current, update-from-local, delete, add-from-local', async ({ page }) => {
        // Fresh state: seed [SlotA, SlotB] default=SlotB on the card, and
        // create SlotA + SlotB in the global preset library so the dialog's
        // "Add from local" and "Update from local" paths have real targets.
        await seedCharacterCardBindingsOnDisk({
            dataRoot: server.dataRoot,
            avatarFile: CHAR_AVATAR,
            state: {
                presets: [
                    { name: SLOT_A, preset: { temperature: SLOT_A_TEMP, chat_completion_source: 'openai' } },
                    { name: SLOT_B, preset: { temperature: SLOT_B_TEMP, chat_completion_source: 'openai' } },
                ],
                defaultPresetName: SLOT_B,
            },
        });
        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', SLOT_A_TEMP);
        await savePresetAsViaButton(page, SLOT_A);
        await setCounterInput(page, '#temp_counter_openai', SLOT_B_TEMP);
        await savePresetAsViaButton(page, SLOT_B);

        await selectCharacterByName(page, CHAR_NAME);

        // Carried-over state: [SlotA, SlotB] default=SlotB.
        await fireDropdownAction(page, 'manage_character_bound_presets');
        const dialog = page.locator('#luker_manage_bound_presets_dialog');
        await dialog.waitFor({ state: 'visible', timeout: 5000 });

        // Two rows.
        await expect(dialog.locator('.luker-mbp-row')).toHaveCount(2);

        // SlotB row shows default badge; SlotA does not.
        const rowA = dialog.locator('.luker-mbp-row[data-preset-name="SlotA"]');
        const rowB = dialog.locator('.luker-mbp-row[data-preset-name="SlotB"]');
        await expect(rowB.locator('.luker-mbp-default-badge')).toBeVisible();
        await expect(rowA.locator('.luker-mbp-default-badge')).toHaveCount(0);

        // Set SlotA as default.
        await rowA.locator('.luker-mbp-set-default').click();
        await expect
            .poll(async () => (await readCardState(page)).defaultPresetName, { timeout: 5000 })
            .toBe(SLOT_A);
        // Re-render should have flipped the default badge to SlotA.
        await expect(dialog.locator('.luker-mbp-row[data-preset-name="SlotA"] .luker-mbp-default-badge')).toBeVisible();

        // ── Overwrite from current: select a global preset with a distinct temp,
        //    then click Overwrite on SlotA. Layer 1 stores the current live body.
        // Close the dialog first so we can drive the selector.
        await closeCurrentPopup(page);

        // Create a "seed" global preset to hold the OVERWRITE_SEED_TEMP body.
        await selectPresetByName(page, 'Default');
        await setCounterInput(page, '#temp_counter_openai', OVERWRITE_SEED_TEMP);
        await savePresetAsViaButton(page, 'OverwriteSeed');
        // Selector now sits on OverwriteSeed with temp = OVERWRITE_SEED_TEMP.

        await fireDropdownAction(page, 'manage_character_bound_presets');
        const dialog2 = page.locator('#luker_manage_bound_presets_dialog');
        await dialog2.waitFor({ state: 'visible', timeout: 5000 });
        await dialog2.locator('.luker-mbp-row[data-preset-name="SlotA"] .luker-mbp-overwrite-current').click();
        await acceptPopup(page);   // confirm-overwrite
        await expect
            .poll(async () => (await readCardState(page)).presets.find(p => p.name === SLOT_A)?.temperature, { timeout: 5000 })
            .toBeCloseTo(OVERWRITE_SEED_TEMP, 5);

        // ── Update from local: mutate the SlotB *global* preset to UPDATED_B_TEMP.
        //    We drive this through the PresetManager API directly rather than the
        //    #update_oai_preset button: while the card has any bound presets,
        //    `characterBoundPresetState.active` is true and the button's handler
        //    routes writes into the CARD slot (or early-returns if the selector
        //    is not a ghost option). Neither branch touches the global preset
        //    we need to update for this test.
        await closeCurrentPopup(page);
        await page.evaluate(async ({ n, expected }) => {
            const mgr = window.Luker?.getContext?.()?.getPresetManager?.('openai');
            const cur = mgr?.getStoredPreset?.(n);
            if (!cur) throw new Error(`no local preset '${n}'`);
            const next = { ...cur, temperature: expected };
            await mgr.savePreset(n, next);
        }, { n: SLOT_B, expected: UPDATED_B_TEMP });
        // Wait for the runtime settings array to reflect the new temperature.
        await page.waitForFunction(({ n, expected }) => {
            const openai = window.Luker?.getContext?.()?.openai;
            const settings = openai?.settings;
            const names = openai?.settingNames;
            if (!Array.isArray(settings) || !names) return false;
            const idx = names[n];
            return Number.isInteger(idx) && Math.abs((settings[idx]?.temperature ?? 0) - expected) < 1e-4;
        }, { n: SLOT_B, expected: UPDATED_B_TEMP }, { timeout: 10_000 });

        // Re-open manage dialog. Selector may currently sit on any option —
        // Overwrite-from-current would use whatever's live. We use
        // update-from-local for SlotB specifically (reads the *global* SlotB body).
        await fireDropdownAction(page, 'manage_character_bound_presets');
        const dialog3 = page.locator('#luker_manage_bound_presets_dialog');
        await dialog3.waitFor({ state: 'visible', timeout: 5000 });
        await dialog3.locator('.luker-mbp-row[data-preset-name="SlotB"] .luker-mbp-update-from-local').click();
        await expect
            .poll(async () => (await readCardState(page)).presets.find(p => p.name === SLOT_B)?.temperature, { timeout: 5000 })
            .toBeCloseTo(UPDATED_B_TEMP, 5);

        // ── Delete SlotA. ─────────────────────────────────────────────
        await dialog3.locator('.luker-mbp-row[data-preset-name="SlotA"] .luker-mbp-remove').click();
        await acceptPopup(page);   // confirm-remove
        await waitForCardSlotCount(page, 1);
        // Default was SlotA → now null after remove.
        {
            const state = await readCardState(page);
            expect(state.presets.map(p => p.name)).toEqual([SLOT_B]);
            expect(state.defaultPresetName).toBeNull();
        }

        // ── Add-from-local: dialog should re-render after delete; add SlotA back. ──
        // The dialog re-renders in place. We select SlotA in the add dropdown.
        const addSelect = page.locator('#luker_manage_bound_presets_dialog #luker-mbp-add-select');
        await addSelect.waitFor({ state: 'visible', timeout: 5000 });
        await addSelect.selectOption(SLOT_A);
        await page.locator('#luker_manage_bound_presets_dialog .luker-mbp-add-button').click();
        await waitForCardSlotCount(page, 2);
        {
            const state = await readCardState(page);
            expect(state.presets.map(p => p.name).sort()).toEqual([SLOT_A, SLOT_B]);
        }

        // Close manage dialog.
        await closeCurrentPopup(page);
    });

    test('Clear Bound Chat Completion Preset wipes the whole set', async ({ page }) => {
        // Fresh state: seed a couple of slots so we can prove the wipe.
        await seedCharacterCardBindingsOnDisk({
            dataRoot: server.dataRoot,
            avatarFile: CHAR_AVATAR,
            state: {
                presets: [
                    { name: SLOT_A, preset: { temperature: SLOT_A_TEMP, chat_completion_source: 'openai' } },
                    { name: SLOT_B, preset: { temperature: SLOT_B_TEMP, chat_completion_source: 'openai' } },
                ],
                defaultPresetName: SLOT_B,
            },
        });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHAR_NAME);

        // Preconditions: at least one slot present.
        await expect
            .poll(async () => (await readCardState(page)).presets?.length ?? -1, { timeout: 10_000 })
            .toBeGreaterThanOrEqual(1);

        await fireDropdownAction(page, 'clear_character_chat_completion_preset');
        await acceptPopup(page);

        await expect.poll(async () => {
            const state = await readCardState(page);
            // After a full clear, the field is null → readCardState returns {isNull:true}.
            return state.isNull === true;
        }, { timeout: 10_000 }).toBe(true);
    });
});
