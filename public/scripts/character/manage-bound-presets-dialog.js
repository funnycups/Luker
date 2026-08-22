// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Manage character-bound chat completion presets — dialog UI.
 *
 * Single entry point (aside from Bind) for editing the multi-slot
 * `chat_completion_preset` field on a character card. Presents each slot
 * with per-row actions:
 *   - Set as default          → setCharacterBoundDefault
 *   - Overwrite from current  → updateCharacterBoundPreset with the body
 *                                of the currently-selected preset (any
 *                                origin — the "current live body" the
 *                                selector maps to via
 *                                getCurrentPresetBodyForBinding)
 *   - Update from local       → updateCharacterBoundPreset with the body
 *                                of the same-named LOCAL GLOBAL preset
 *                                (disabled + tooltip when no such global
 *                                exists)
 *   - Delete                  → removeCharacterBoundPreset (confirm)
 *
 * Plus one bottom control:
 *   - Add from local          → addCharacterBoundPreset with the selected
 *                                global preset's stored body
 *
 * All writes route through Layer 1 (`character/presets.js`) which handles
 * the four-strip contract, defaultPresetName upkeep, and the
 * read-spread-overlay dance in `writeExtensionField`.
 */

import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';
import { t } from '/scripts/i18n.js';
import { getContext } from '/scripts/st-context.js';
import {
    listCharacterBoundPresets,
    addCharacterBoundPreset,
    updateCharacterBoundPreset,
    removeCharacterBoundPreset,
    setCharacterBoundDefault,
    renameCharacterBoundPreset,
    getCharacterBoundPreset,
    clearAllCharacterBoundPresets,
} from './presets.js';
import { getCurrentPresetBodyForBinding, maybeApplyCharacterBoundPreset } from '/scripts/openai.js';
import { decodeCardBoundOptionValue } from './preset-ref-codec.js';

const DIALOG_ID = 'luker_manage_bound_presets_dialog';
const CLEAR_DIALOG_ID = 'luker_clear_bound_presets_dialog';

/**
 * Get all local (global) openai preset names. `getAllPresets()` reads
 * option.text off the `<select>` DOM which includes the ghost card-bound
 * optgroup — filter those out via the codec (option value starts with
 * the `__luker_card__::` sentinel).
 * @returns {string[]}
 */
function getLocalPresetNames() {
    const mgr = getContext().getPresetManager?.('openai');
    if (!mgr) return [];
    // Iterate the select's <option>s directly so we can filter by value.
    const options = window.jQuery
        ? window.jQuery(mgr.select).find('option').toArray()
        : Array.from(document.querySelectorAll('#settings_preset_openai option'));
    const names = [];
    for (const el of options) {
        const value = String(el.value ?? '');
        if (decodeCardBoundOptionValue(value)) continue;
        const text = String(el.textContent ?? '').trim();
        if (text) names.push(text);
    }
    return names;
}

/** Get local preset stored body by name. */
function getLocalPresetBody(name) {
    return getContext().getPresetManager?.('openai')?.getStoredPreset?.(name) || null;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function renderRow(item, localPresetNames) {
    const hasLocalSameName = localPresetNames.includes(item.name);
    const name = escapeHtml(item.name);
    // Default marker: a badge when this slot is the default; a button when it isn't.
    const defaultCell = item.isDefault
        ? `<span class="luker-mbp-default-badge">${escapeHtml(t`Default`)}</span>`
        : `<button type="button" class="menu_button luker-mbp-set-default">${escapeHtml(t`Set as default`)}</button>`;
    const updateFromLocalBtn = hasLocalSameName
        ? `<button type="button" class="menu_button luker-mbp-update-from-local">${escapeHtml(t`Update from local`)}</button>`
        : `<button type="button" class="menu_button luker-mbp-update-from-local" disabled title="${escapeHtml(t`No local preset with the same name.`)}">${escapeHtml(t`Update from local`)}</button>`;
    return `
<div class="luker-mbp-row" data-preset-name="${name}">
    <span class="luker-mbp-name" title="${name}">${name}</span>
    <div class="luker-mbp-actions">
        ${defaultCell}
        <button type="button" class="menu_button luker-mbp-overwrite-current" title="${escapeHtml(t`Overwrite this card slot with the currently-selected preset's body.`)}">${escapeHtml(t`Overwrite from current`)}</button>
        ${updateFromLocalBtn}
        <button type="button" class="menu_button luker-mbp-rename">${escapeHtml(t`Rename`)}</button>
        <button type="button" class="menu_button luker-mbp-remove">${escapeHtml(t`Delete`)}</button>
    </div>
</div>`;
}

function renderDialogHtml(character) {
    const items = listCharacterBoundPresets(character);
    const localNames = getLocalPresetNames();
    const rows = items.length
        ? items.map(item => renderRow(item, localNames)).join('')
        : `<div class="luker-mbp-empty">${escapeHtml(t`No card-bound presets yet.`)}</div>`;
    const addOptions = localNames
        .filter(n => !items.some(it => it.name === n))
        .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
        .join('');
    const characterName = escapeHtml(character?.name ?? '');
    return `
<div id="${DIALOG_ID}">
    <h3 class="luker-mbp-heading">${escapeHtml(t`Card-bound presets for '${character?.name ?? ''}'`)}</h3>
    <div class="luker-mbp-rows">${rows}</div>
    <div class="luker-mbp-add">
        <label for="luker-mbp-add-select" class="luker-mbp-add-label">${escapeHtml(t`Add from local preset:`)}</label>
        <select id="luker-mbp-add-select" class="luker-mbp-add-select">
            <option value="">${escapeHtml(t`— select —`)}</option>
            ${addOptions}
        </select>
        <button type="button" class="menu_button luker-mbp-add-button">${escapeHtml(t`Add`)}</button>
    </div>
    <!-- data-character-name kept purely for debugging / e2e sanity check -->
    <input type="hidden" data-character-name="${characterName}">
</div>`;
}

/**
 * Interactive: promote a card-snapshot preset body to the global preset
 * library. Prompts the user for a global preset name, defaulting to the
 * slot's own name, and handles name collisions with an Overwrite / Rename
 * / Cancel popup that loops until the user resolves it.
 *
 * @param {string} slotName default name suggested for the global preset
 * @param {object} presetBody snapshot body to save (already stripped of
 *   connection fields by Layer 1 read)
 * @returns {Promise<string|null>} the final name persisted to global, or
 *   null if the user cancelled at any step
 */
async function promoteCardSnapshotToGlobal(slotName, presetBody) {
    const mgr = getContext().getPresetManager?.('openai');
    if (!mgr) {
        toastr.error(t`Preset manager unavailable.`);
        return null;
    }

    let candidate = String(slotName || '').trim();
    // Loop to handle Rename-then-collide-again cycles.
    // Cap at a modest number — the user cancelling always exits, this cap
    // only guards against a UI bug that would otherwise spin the popup.
    for (let i = 0; i < 32; i++) {
        const raw = await Popup.show.input(
            t`Save to Global Preset`,
            t`Enter a name for the global preset. The card-bound slot will be removed after saving.`,
            candidate,
        );
        const proposed = String(raw ?? '').trim();
        if (!proposed) return null;

        const localNames = getLocalPresetNames();
        const collides = localNames.includes(proposed);
        if (!collides) {
            try {
                await mgr.savePreset(proposed, presetBody);
            } catch (err) {
                console.error('promoteCardSnapshotToGlobal: savePreset failed', err);
                toastr.error(String(err?.message || err));
                return null;
            }
            return proposed;
        }

        const action = await Popup.show.confirm(
            t`Preset name already exists`,
            t`A global preset named '${proposed}' already exists.`,
            {
                okButton: t`Overwrite`,
                cancelButton: t`Cancel`,
                customButtons: [{
                    text: t`Rename`,
                    result: POPUP_RESULT.CUSTOM1,
                }],
                defaultResult: POPUP_RESULT.CUSTOM1,
            },
        );

        if (action === POPUP_RESULT.AFFIRMATIVE) {
            try {
                await mgr.savePreset(proposed, presetBody);
            } catch (err) {
                console.error('promoteCardSnapshotToGlobal: overwrite savePreset failed', err);
                toastr.error(String(err?.message || err));
                return null;
            }
            return proposed;
        }
        if (action === POPUP_RESULT.CUSTOM1) {
            candidate = proposed;
            continue;
        }
        // CANCELLED / NEGATIVE — user backed out.
        return null;
    }
    toastr.warning(t`Save to global preset cancelled.`);
    return null;
}

/**
 * Save a preset body to the global preset library under a specific name,
 * with a boolean allow-overwrite gate. Thin wrapper over
 * `PresetManager.savePreset` — used by the batch salvage flow where name
 * choice + collision resolution have already happened in the outer
 * dialog, so we don't want the per-name input popup that
 * `promoteCardSnapshotToGlobal` runs.
 *
 * @param {string} name  target global preset name (already trimmed)
 * @param {object} body  preset body (already stripped of connection fields by Layer 1 read)
 * @param {{allowOverwrite: boolean}} options
 * @throws when `allowOverwrite=false` and the name already collides with
 *   an existing global preset (caller must have collision-scanned first),
 *   or when the underlying `savePreset` throws.
 * @returns {Promise<void>}
 */
async function saveBodyAsGlobalPreset(name, body, { allowOverwrite }) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('saveBodyAsGlobalPreset: name required');
    const mgr = getContext().getPresetManager?.('openai');
    if (!mgr) throw new Error('saveBodyAsGlobalPreset: preset manager unavailable');
    if (!allowOverwrite && getLocalPresetNames().includes(trimmed)) {
        throw new Error(`saveBodyAsGlobalPreset: refusing to overwrite existing global preset without allowOverwrite: ${trimmed}`);
    }
    await mgr.savePreset(trimmed, body);
}

/**
 * Open the "Clear + Salvage" dialog: lists every card-bound slot with a
 * per-row choice (Save to global preset / Discard) and an inline global
 * preset name input. OK resolves to a batch operation that:
 *
 *   1. Scans the collected Save rows against the global preset library
 *      for name collisions.
 *   2. If any collide → single confirm popup listing all colliders with
 *      Overwrite all / Back / Cancel. Back re-opens THIS dialog with the
 *      user's current picks preserved so they can rename any colliding
 *      target inline.
 *   3. Sequentially promotes each Save row to a global preset (fail-fast:
 *      the first savePreset throw aborts the batch WITHOUT calling
 *      clearAllCharacterBoundPresets — the card snapshots stay intact so
 *      the user can retry).
 *   4. After all promotes succeed, clears the entire
 *      chat_completion_preset field.
 *
 * Legacy / empty-snapshot state (bare-string binding with no
 * embedded body) is caller's responsibility to short-circuit before
 * entering this dialog — there is nothing to salvage in that case.
 *
 * @param {object} character
 * @returns {Promise<boolean>} true when the batch clear went through
 *   (all promotes + clear succeeded), false on cancel/back-that-ended-in-cancel
 *   or on the fail-fast abort path.
 */
export async function openClearWithSalvageDialog(character) {
    if (!character) return false;
    const slots = listCharacterBoundPresets(character);
    if (slots.length === 0) return false;

    // Per-row user picks — persisted across Back → re-open cycles.
    /** @type {Map<string, {action:'save'|'discard', globalName:string}>} */
    const picks = new Map();
    for (const s of slots) {
        picks.set(s.name, { action: 'save', globalName: s.name });
    }

    while (true) {
        const outcome = await runSalvageDialogOnce(character, slots, picks);
        if (outcome.kind === 'cancel') return false;
        // outcome.kind === 'ok' — outcome.picks reflects the user's final
        // per-row picks; picks has already been mutated in place inside the
        // dialog, so re-reading `picks` here would be equivalent.

        // Collision scan.
        const localNames = new Set(getLocalPresetNames());
        const collisions = [];
        const saveRows = [];
        for (const slot of slots) {
            const pick = picks.get(slot.name);
            if (pick.action !== 'save') continue;
            const target = String(pick.globalName || '').trim();
            if (!target) {
                toastr.error(t`Empty global preset name for slot '${slot.name}'.`);
                continue;
            }
            saveRows.push({ slotName: slot.name, targetName: target });
            if (localNames.has(target)) {
                collisions.push({ slotName: slot.name, targetName: target });
            }
        }

        if (collisions.length > 0) {
            const collisionList = collisions.map(c => `• ${c.targetName}`).join('\n');
            const action = await Popup.show.confirm(
                t`Overwrite existing global presets?`,
                t`The following global presets already exist and will be overwritten if you continue.\n\n${collisionList}`,
                {
                    okButton: t`Overwrite all`,
                    cancelButton: t`Cancel`,
                    customButtons: [{
                        text: t`Back`,
                        result: POPUP_RESULT.CUSTOM1,
                    }],
                    defaultResult: POPUP_RESULT.CUSTOM1,
                },
            );
            if (action === POPUP_RESULT.CUSTOM1) {
                // Back → re-open the salvage dialog with picks intact so
                // the user can rename any colliding target inline.
                continue;
            }
            if (action !== POPUP_RESULT.AFFIRMATIVE) {
                // Cancel / dismiss → abort the whole clear.
                return false;
            }
        }

        // Promote then clear. Fail-fast: any thrown savePreset aborts
        // the batch WITHOUT calling clearAllCharacterBoundPresets, so the
        // user can retry without losing snapshots. Already-written globals
        // are NOT rolled back (they were the user's declared intent).
        for (const row of saveRows) {
            const snapshot = getCharacterBoundPreset(character, row.slotName);
            if (!snapshot?.preset || typeof snapshot.preset !== 'object') {
                toastr.error(t`Cannot read snapshot for slot '${row.slotName}'.`);
                return false;
            }
            try {
                await saveBodyAsGlobalPreset(row.targetName, snapshot.preset, { allowOverwrite: true });
            } catch (err) {
                console.error('openClearWithSalvageDialog: promote failed', err);
                toastr.error(t`Failed to save slot '${row.slotName}' to global preset '${row.targetName}': ${String(err?.message || err)}`);
                return false;
            }
        }

        try {
            await clearAllCharacterBoundPresets(character);
            await maybeApplyCharacterBoundPreset();
        } catch (err) {
            console.error('openClearWithSalvageDialog: final clear failed', err);
            toastr.error(t`Failed to clear card-bound presets: ${String(err?.message || err)}`);
            return false;
        }

        const savedCount = saveRows.length;
        if (savedCount > 0) {
            toastr.success(t`Cleared ${slots.length} card-bound preset(s) from '${character.name}'. ${savedCount} saved to global preset library.`);
        } else {
            toastr.success(t`Cleared ${slots.length} card-bound preset(s) from '${character.name}'.`);
        }
        return true;
    }
}

/**
 * Render + drive one iteration of the salvage dialog. Mutates `picks` in
 * place as the user changes radios / edits names, so the surrounding loop
 * can re-open with the same picks after a Back from the collision confirm.
 *
 * Returns {kind:'ok'} when the user presses OK, {kind:'cancel'} otherwise.
 */
async function runSalvageDialogOnce(character, slots, picks) {
    const html = renderSalvageDialogHtml(character, slots, picks);
    const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: t`Clear`,
        cancelButton: t`Cancel`,
    });

    const $dlg = window.jQuery(popup.dlg);

    // Radio change → sync into picks + enable/disable the inline name input.
    $dlg.on('change', `#${CLEAR_DIALOG_ID} .luker-cbp-action`, (ev) => {
        const row = ev.currentTarget.closest('.luker-cbp-row');
        const slotName = row?.dataset?.slotName;
        if (!slotName) return;
        const action = ev.currentTarget.value === 'save' ? 'save' : 'discard';
        const current = picks.get(slotName) || { action: 'save', globalName: slotName };
        current.action = action;
        picks.set(slotName, current);
        const input = row.querySelector('.luker-cbp-global-name');
        if (input) {
            input.disabled = action !== 'save';
        }
    });

    // Inline name input → sync into picks on every keystroke so a Back
    // → re-open cycle preserves the edits.
    $dlg.on('input', `#${CLEAR_DIALOG_ID} .luker-cbp-global-name`, (ev) => {
        const row = ev.currentTarget.closest('.luker-cbp-row');
        const slotName = row?.dataset?.slotName;
        if (!slotName) return;
        const current = picks.get(slotName) || { action: 'save', globalName: slotName };
        current.globalName = String(ev.currentTarget.value ?? '');
        picks.set(slotName, current);
    });

    // Bulk buttons: set all rows to save/discard in one click.
    $dlg.on('click', `#${CLEAR_DIALOG_ID} .luker-cbp-bulk-save`, () => {
        for (const slot of slots) {
            const current = picks.get(slot.name) || { action: 'save', globalName: slot.name };
            current.action = 'save';
            picks.set(slot.name, current);
        }
        rerenderSalvageDialog(popup, character, slots, picks);
    });
    $dlg.on('click', `#${CLEAR_DIALOG_ID} .luker-cbp-bulk-discard`, () => {
        for (const slot of slots) {
            const current = picks.get(slot.name) || { action: 'save', globalName: slot.name };
            current.action = 'discard';
            picks.set(slot.name, current);
        }
        rerenderSalvageDialog(popup, character, slots, picks);
    });

    const result = await popup.show();
    return result === POPUP_RESULT.AFFIRMATIVE ? { kind: 'ok' } : { kind: 'cancel' };
}

function rerenderSalvageDialog(popup, character, slots, picks) {
    const outer = popup.dlg.querySelector('#' + CLEAR_DIALOG_ID);
    if (!outer) return;
    outer.outerHTML = renderSalvageDialogHtml(character, slots, picks);
}

function renderSalvageDialogHtml(character, slots, picks) {
    const rows = slots.map((slot, idx) => {
        const pick = picks.get(slot.name) || { action: 'save', globalName: slot.name };
        const escName = escapeHtml(slot.name);
        const escGlobal = escapeHtml(pick.globalName ?? slot.name);
        const isSave = pick.action === 'save';
        const disabledAttr = isSave ? '' : 'disabled';
        const saveChecked = isSave ? 'checked' : '';
        const discardChecked = isSave ? '' : 'checked';
        const defaultBadge = slot.isDefault
            ? `<span class="luker-cbp-default-badge" title="${escapeHtml(t`This slot is the auto-apply default on character load.`)}">${escapeHtml(t`Default`)}</span>`
            : '';
        // Radio group name uses row index rather than slot name so exotic
        // characters in the slot name (e.g. brackets, quotes) can't break
        // the HTML attribute grouping. Row-DOM has data-slot-name for
        // event handlers to look up the slot instead.
        const radioName = `luker-cbp-action-row-${idx}`;
        return `
<div class="luker-cbp-row" data-slot-name="${escName}">
    <div class="luker-cbp-slot">
        <span class="luker-cbp-slot-name" title="${escName}">${escName}</span>
        ${defaultBadge}
    </div>
    <div class="luker-cbp-choice">
        <label class="luker-cbp-choice-label">
            <input type="radio" class="luker-cbp-action" name="${radioName}" value="save" ${saveChecked}>
            ${escapeHtml(t`Save to global preset`)}
        </label>
        <input type="text" class="luker-cbp-global-name text_pole" value="${escGlobal}" ${disabledAttr} placeholder="${escapeHtml(t`Global preset name`)}">
        <label class="luker-cbp-choice-label">
            <input type="radio" class="luker-cbp-action" name="${radioName}" value="discard" ${discardChecked}>
            ${escapeHtml(t`Discard`)}
        </label>
    </div>
</div>`;
    }).join('');
    return `
<div id="${CLEAR_DIALOG_ID}">
    <h3 class="luker-cbp-heading">${escapeHtml(t`Clear card-bound presets for '${character?.name ?? ''}'`)}</h3>
    <p class="luker-cbp-intro">${escapeHtml(t`Choose what to do with each slot. Saved slots become global presets you can reuse on any character. Discarded slots are permanently deleted.`)}</p>
    <div class="luker-cbp-bulk">
        <button type="button" class="menu_button luker-cbp-bulk-save">${escapeHtml(t`Save all to global`)}</button>
        <button type="button" class="menu_button luker-cbp-bulk-discard">${escapeHtml(t`Discard all`)}</button>
    </div>
    <div class="luker-cbp-rows">${rows}</div>
</div>`;
}

/**
 * Open the manage-bound-presets dialog for the given character. Resolves
 * when the popup is closed. The popup is DISPLAY-type (no OK/Cancel
 * semantics for the outer flow — each row action is a self-contained
 * mutation with its own toast + optional confirm).
 * @param {object} character
 * @returns {Promise<void>}
 */
export async function openManageBoundPresetsDialog(character) {
    if (!character) {
        return;
    }
    const popup = new Popup(renderDialogHtml(character), POPUP_TYPE.DISPLAY, '', {
        wide: true,
        allowVerticalScrolling: true,
    });
    // popup.dlg is a raw HTMLDialogElement. We attach delegated jQuery
    // listeners so re-renders (innerHTML swap of the outer container)
    // don't need to rebind each event manually.
    const $dlg = window.jQuery(popup.dlg);

    const rerender = () => {
        const outer = popup.dlg.querySelector('#' + DIALOG_ID);
        if (!outer) return;
        outer.outerHTML = renderDialogHtml(character);
    };

    const withRowName = (ev, fn) => {
        const row = ev.currentTarget.closest('.luker-mbp-row');
        const name = row?.dataset?.presetName;
        if (!name) return;
        return fn(name);
    };

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-set-default`, async (ev) => {
        await withRowName(ev, async (name) => {
            try {
                await setCharacterBoundDefault(character, name);
                await maybeApplyCharacterBoundPreset();
                rerender();
            } catch (err) {
                console.error('manage-bound-presets: set-default failed', err);
                toastr.error(String(err?.message || err));
            }
        });
    });

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-overwrite-current`, async (ev) => {
        await withRowName(ev, async (name) => {
            const body = getCurrentPresetBodyForBinding();
            if (!body || typeof body !== 'object') {
                toastr.error(t`Failed to read current preset body.`);
                return;
            }
            const ok = await Popup.show.confirm(
                t`Overwrite Bound Preset`,
                t`Overwrite the card copy of '${name}' with current settings?`,
            );
            if (!ok) return;
            try {
                await updateCharacterBoundPreset(character, name, body);
                await maybeApplyCharacterBoundPreset();
                toastr.success(t`Card-bound preset '${name}' overwritten with current settings.`);
                rerender();
            } catch (err) {
                console.error('manage-bound-presets: overwrite-from-current failed', err);
                toastr.error(String(err?.message || err));
            }
        });
    });

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-update-from-local`, async (ev) => {
        await withRowName(ev, async (name) => {
            const body = getLocalPresetBody(name);
            if (!body || typeof body !== 'object') {
                toastr.error(t`Local preset '${name}' not found.`);
                return;
            }
            try {
                await updateCharacterBoundPreset(character, name, body);
                await maybeApplyCharacterBoundPreset();
                toastr.success(t`Card-bound preset '${name}' synced from local.`);
                rerender();
            } catch (err) {
                console.error('manage-bound-presets: update-from-local failed', err);
                toastr.error(String(err?.message || err));
            }
        });
    });

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-rename`, async (ev) => {
        await withRowName(ev, async (oldName) => {
            const newNameRaw = await Popup.show.input(
                t`Rename card-bound preset`,
                t`Enter a new name:`,
                oldName,
            );
            const newName = String(newNameRaw || '').trim();
            if (!newName || newName === oldName) return;
            try {
                await renameCharacterBoundPreset(character, oldName, newName);
                // Rebuild ghost optgroup + preserve selection. See the
                // twin comment in preset-manager.js's card-bound rename
                // dispatch: `maybeApplyCharacterBoundPreset` refreshes
                // both the DOM options (encoded via
                // encodeCardBoundOptionValue) and the runtimeOptions Map
                // in one pass — hand-patching the DOM would desync them.
                await maybeApplyCharacterBoundPreset();
                toastr.success(t`Card-bound preset renamed`);
                rerender();
            } catch (err) {
                console.error('manage-bound-presets: rename failed', err);
                toastr.error(String(err?.message || err));
            }
        });
    });

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-remove`, async (ev) => {
        await withRowName(ev, async (name) => {
            const snapshot = getCharacterBoundPreset(character, name);
            const snapshotBody = snapshot?.preset && typeof snapshot.preset === 'object' ? snapshot.preset : null;

            // First popup: three-way choice for what to do with the card snapshot.
            // The historical flow was a plain confirm → immediately discard the
            // slot, which silently threw away every Prompt-Manager edit made
            // while the preset was card-bound (they only lived in the card
            // snapshot, not the global preset library). Offer to promote the
            // snapshot to a global preset instead.
            const choice = await Popup.show.confirm(
                t`Delete Bound Preset`,
                t`Delete card-bound preset '${name}'. What should happen to its current contents?`,
                {
                    okButton: t`Save to global preset`,
                    cancelButton: t`Cancel`,
                    customButtons: [{
                        text: t`Discard`,
                        result: POPUP_RESULT.CUSTOM1,
                    }],
                    defaultResult: POPUP_RESULT.AFFIRMATIVE,
                },
            );

            if (choice !== POPUP_RESULT.AFFIRMATIVE && choice !== POPUP_RESULT.CUSTOM1) {
                // CANCELLED (null) or NEGATIVE — user backed out entirely.
                return;
            }

            if (choice === POPUP_RESULT.AFFIRMATIVE) {
                if (!snapshotBody) {
                    toastr.error(t`Cannot read snapshot for '${name}'.`);
                    return;
                }
                const savedName = await promoteCardSnapshotToGlobal(name, snapshotBody);
                if (!savedName) {
                    // User cancelled the name / conflict popup — abort the
                    // whole unbind so their edits stay intact on the card.
                    return;
                }
                try {
                    await removeCharacterBoundPreset(character, name);
                    await maybeApplyCharacterBoundPreset();
                    toastr.success(t`Saved '${name}' to global preset '${savedName}' and unbound from character.`);
                    rerender();
                } catch (err) {
                    console.error('manage-bound-presets: remove-after-promote failed', err);
                    toastr.error(String(err?.message || err));
                }
                return;
            }

            // choice === CUSTOM1 → Discard (legacy behavior).
            try {
                await removeCharacterBoundPreset(character, name);
                await maybeApplyCharacterBoundPreset();
                rerender();
            } catch (err) {
                console.error('manage-bound-presets: remove failed', err);
                toastr.error(String(err?.message || err));
            }
        });
    });

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-add-button`, async () => {
        const select = popup.dlg.querySelector('#' + DIALOG_ID + ' #luker-mbp-add-select');
        const name = String(select?.value ?? '').trim();
        if (!name) {
            toastr.info(t`Select a local preset to add.`);
            return;
        }
        const body = getLocalPresetBody(name);
        if (!body || typeof body !== 'object') {
            toastr.error(t`Local preset '${name}' not found.`);
            return;
        }
        try {
            // Layer 1 throws on duplicate name — the dialog's add dropdown
            // already filters out already-embedded names, but a concurrent
            // window could have added the same name between renders.
            // Surface the throw as a toast rather than crashing the popup.
            await addCharacterBoundPreset(character, name, body);
            await maybeApplyCharacterBoundPreset();
            toastr.success(t`Added '${name}' to card-bound presets.`);
            rerender();
        } catch (err) {
            console.error('manage-bound-presets: add-from-local failed', err);
            toastr.error(String(err?.message || err));
        }
    });

    await popup.show();
}
