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

import { Popup, POPUP_TYPE } from '/scripts/popup.js';
import { t } from '/scripts/i18n.js';
import { getContext } from '/scripts/st-context.js';
import {
    listCharacterBoundPresets,
    addCharacterBoundPreset,
    updateCharacterBoundPreset,
    removeCharacterBoundPreset,
    setCharacterBoundDefault,
} from './presets.js';
import { getCurrentPresetBodyForBinding, maybeApplyCharacterBoundPreset } from '/scripts/openai.js';
import { decodeCardBoundOptionValue } from './preset-ref-codec.js';

const DIALOG_ID = 'luker_manage_bound_presets_dialog';

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

    $dlg.on('click', `#${DIALOG_ID} .luker-mbp-remove`, async (ev) => {
        await withRowName(ev, async (name) => {
            const ok = await Popup.show.confirm(
                t`Delete Bound Preset`,
                t`Delete card-bound preset '${name}'?`,
            );
            if (!ok) return;
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
