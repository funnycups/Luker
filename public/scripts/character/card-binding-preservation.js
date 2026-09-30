// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Layer 1 — Card binding preservation on character card replacement.
 *
 * The "Replace Character" flow (More menu → file / URL) imports a new card
 * over the same avatar. `/api/characters/import` writes the new file
 * verbatim, so every local binding stored inside `data.extensions.*` is lost
 * with the old card. This module keeps them:
 *
 *   - Owners register a slot descriptor (`registerCardBindingSlot`)
 *     describing how to read / detect / summarize / write one binding.
 *   - The engine compares the previous and the incoming card. Bindings only
 *     the previous card had are silently written back; bindings both cards
 *     define differently raise a per-category popup.
 *
 * Registration is open: core registers its own slots at the bottom of this
 * module, plugins register theirs from their init. A disabled plugin never
 * registers, so its binding is not preserved — documented in the developer
 * reference at docs/development/extension-api/character-replace-flow.md.
 */

import { lodash } from '../../lib.js';
import { t } from '/scripts/i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, PopupUtils } from '/scripts/popup.js';
import { getContext } from '/scripts/st-context.js';
import {
    readCharacterBoundStateRaw,
    writeCharacterBoundStateById,
} from '/scripts/character/presets.js';
import {
    getDedicatedPersonaEntriesFromCharacter,
    setCharacterDedicatedPersonaEntries,
} from '/scripts/personas.js';
import { maybeApplyCharacterBoundPreset } from '/scripts/openai.js';

const MODULE_NAME = 'card-binding-preservation';

const SLOT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const CORE_SLOT_BOUND_PRESETS = 'bound-presets';
const CORE_SLOT_DEDICATED_PERSONAS = 'dedicated-personas';

/** @type {Map<string, object>} insertion-ordered slot registry */
const slots = new Map();

/**
 * Register a card-binding slot. Owners call this from their extension init;
 * core registers its own two slots at the bottom of this module.
 *
 * @param {object} descriptor
 * @param {string} descriptor.id Unique, stable slot id; letters, digits, `_` and `-` only, must start with a letter.
 * @param {() => string} descriptor.label User-visible category name (translated by the owner).
 * @param {(character: object) => any} descriptor.read Pure read of the binding from a card object; null when absent.
 * @param {(value: any) => boolean} descriptor.isPresent Whether the read value counts as configured.
 * @param {(value: any) => string} descriptor.summarize One-line summary for the conflict popup.
 * @param {(characterId: number, value: any) => Promise<void>} descriptor.write Write the binding back; must preserve sibling keys.
 */
export function registerCardBindingSlot(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError(`${MODULE_NAME}: slot descriptor must be an object`);
    }
    if (typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
        throw new TypeError(`${MODULE_NAME}: slot descriptor requires a non-empty string id`);
    }
    if (!SLOT_ID_PATTERN.test(descriptor.id)) {
        throw new TypeError(`${MODULE_NAME}: slot id '${descriptor.id}' must match ${SLOT_ID_PATTERN}`);
    }
    for (const field of ['label', 'read', 'isPresent', 'summarize', 'write']) {
        if (typeof descriptor[field] !== 'function') {
            throw new TypeError(`${MODULE_NAME}: slot '${descriptor.id}' requires a ${field}() function`);
        }
    }
    if (slots.has(descriptor.id)) {
        console.warn(`[${MODULE_NAME}] Overwriting existing slot '${descriptor.id}'`);
    }
    slots.set(descriptor.id, descriptor);
}

/** @returns {object[]} registered descriptors in registration order */
export function listCardBindingSlots() {
    return [...slots.values()];
}

/**
 * Pure comparison between the previous and the incoming card.
 * @returns {{silent: object[], conflicts: object[]}}
 */
export function computeCardBindingPreservation(previousCharacter, newCharacter) {
    const silent = [];
    const conflicts = [];
    for (const slot of listCardBindingSlots()) {
        try {
            const localValue = slot.read(previousCharacter);
            const cardValue = slot.read(newCharacter);
            if (!slot.isPresent(localValue)) {
                continue;
            }
            if (!slot.isPresent(cardValue)) {
                silent.push({ slotId: slot.id, slot, value: localValue });
                continue;
            }
            if (lodash.isEqual(localValue, cardValue)) {
                continue;
            }
            conflicts.push({
                slotId: slot.id,
                slot,
                label: String(slot.label()),
                localSummary: String(slot.summarize(localValue)),
                cardSummary: String(slot.summarize(cardValue)),
                localValue,
                cardValue,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] slot '${slot.id}' failed to evaluate`, error);
        }
    }
    return { silent, conflicts };
}

/**
 * Apply writes sequentially. One failing slot never blocks the rest.
 * @returns {Promise<{applied: string[], failed: object[]}>}
 */
export async function applyCardBindingPreservation(characterId, writes) {
    const applied = [];
    const failed = [];
    for (const write of writes) {
        try {
            await write.slot.write(characterId, write.value);
            applied.push(write.slotId);
        } catch (error) {
            failed.push({
                slotId: write.slotId,
                label: resolveSlotLabel(write),
                error,
            });
        }
    }
    return { applied, failed };
}

function resolveSlotLabel(write) {
    try {
        if (typeof write.slot?.label === 'function') {
            return String(write.slot.label());
        }
    } catch {
        return write.slotId;
    }
    return write.slotId;
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Show the per-category conflict dialog. Resolves with the conflict entries
 * the user chose to keep from the local card (empty on cancel/Esc).
 */
async function promptConflictChoices(conflicts) {
    const rowsHtml = conflicts.map(conflict => `
        <div style="margin-top: 8px;">
            <div><strong>${escapeHtmlText(conflict.label)}</strong></div>
            <div><span style="opacity: 0.85;">${escapeHtmlText(t`Local:`)}</span> ${escapeHtmlText(conflict.localSummary)}</div>
            <div><span style="opacity: 0.85;">${escapeHtmlText(t`New card:`)}</span> ${escapeHtmlText(conflict.cardSummary)}</div>
        </div>`).join('');
    const content = PopupUtils.BuildTextWithHeader(
        t`Local bindings found on both cards`,
        `<div class="card-binding-conflicts">${rowsHtml}</div>`,
    );
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        wide: true,
        okButton: t`Apply`,
        cancelButton: t`Cancel`,
        customInputs: conflicts.map(conflict => ({
            id: `card-binding-keep-${conflict.slotId}`,
            type: 'checkbox',
            label: `${conflict.label} — ${t`Keep local`}`,
            defaultState: true,
        })),
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return [];
    }
    return conflicts.filter(conflict => Boolean(popup.inputResults?.get(`card-binding-keep-${conflict.slotId}`)));
}

/**
 * Post-replace orchestration: silent inheritance, conflict popup, write-back.
 * Never throws — a binding failure must not break the replacement itself.
 * @param {{context?: object, characterId: number, previousCharacter: object|null, newCharacter?: object}} args
 * @returns {Promise<{wrotePresets: boolean}>}
 */
export async function handlePostReplaceBindings({ context, characterId, previousCharacter, newCharacter }) {
    try {
        if (!previousCharacter) {
            return { wrotePresets: false };
        }
        const ctx = context || getContext();
        const incoming = newCharacter || ctx.characters?.[characterId];
        if (!incoming) {
            return { wrotePresets: false };
        }

        const { silent, conflicts } = computeCardBindingPreservation(previousCharacter, incoming);
        const writes = [...silent];
        if (conflicts.length > 0) {
            const keptConflicts = await promptConflictChoices(conflicts);
            writes.push(...keptConflicts.map(conflict => ({
                slotId: conflict.slotId,
                slot: conflict.slot,
                value: conflict.localValue,
            })));
        }
        if (writes.length === 0) {
            return { wrotePresets: false };
        }

        const { applied, failed } = await applyCardBindingPreservation(characterId, writes);
        for (const failure of failed) {
            console.warn(`[${MODULE_NAME}] slot '${failure.slotId}' failed to write`, failure.error);
            toastr.error(
                t`The local binding for ${failure.label} could not be kept.`,
                t`Some local bindings were not kept`,
            );
        }

        const wrotePresets = applied.includes(CORE_SLOT_BOUND_PRESETS);
        if (wrotePresets) {
            try {
                await maybeApplyCharacterBoundPreset();
            } catch (error) {
                console.warn(`[${MODULE_NAME}] failed to refresh the bound preset after replace`, error);
            }
        }
        return { wrotePresets };
    } catch (error) {
        console.error(`[${MODULE_NAME}] post-replace handling failed`, error);
        return { wrotePresets: false };
    }
}

registerCardBindingSlot({
    id: CORE_SLOT_BOUND_PRESETS,
    label: () => t`Bound chat completion presets`,
    read: character => {
        // Pure normalized read: a detached previous-card clone must not
        // schedule the legacy-shape migration flush, and `_migrated` would
        // make an otherwise-identical legacy binding look like a conflict.
        const state = readCharacterBoundStateRaw(character);
        if (state && typeof state === 'object') {
            delete state._migrated;
        }
        return state;
    },
    isPresent: state => Array.isArray(state?.presets)
        ? state.presets.length > 0 || Boolean(state.defaultPresetName)
        : false,
    summarize: state => {
        const count = Array.isArray(state?.presets) ? state.presets.length : 0;
        const defaultName = state?.defaultPresetName ? String(state.defaultPresetName) : t`None`;
        return t`${count} preset(s) · default: ${defaultName}`;
    },
    write: (characterId, state) => writeCharacterBoundStateById(characterId, state),
});

registerCardBindingSlot({
    id: CORE_SLOT_DEDICATED_PERSONAS,
    label: () => t`Character-dedicated personas`,
    read: character => getDedicatedPersonaEntriesFromCharacter(character),
    isPresent: entries => Array.isArray(entries) && entries.length > 0,
    summarize: entries => t`${entries.length} dedicated persona(s)`,
    write: async (characterId, entries) => {
        const character = getContext().characters?.[characterId];
        if (!character?.avatar) {
            throw new Error(`${MODULE_NAME}: character not found at index ${characterId}`);
        }
        // restoreRemovedToGlobal must stay false: overlaying the preserved
        // list onto the new card must never leak the new card's personas
        // into the global persona library.
        await setCharacterDedicatedPersonaEntries(character.avatar, entries, { restoreRemovedToGlobal: false });
    },
});
