// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Layer 1 — Post-replace world book decisions.
 *
 * Replacing a character card (More menu → file / URL) imports the new file
 * verbatim, which drops the old card's `data.extensions.world` binding and
 * leaves the new card's embedded `data.character_book` unimported. This
 * module owns the follow-up decision:
 *
 *   - Owners register an action descriptor (`registerPostReplaceAction`)
 *     describing one concrete next step for the replacement.
 *   - The engine builds a detail object from the replace event, filters the
 *     registry by `isAvailable`, and shows a popup with one button per
 *     available action (registration order, first available = default).
 *   - Core registers two actions: import the new card's embedded book, or
 *     re-bind the previously bound book. Plugins register their own from
 *     their init; a disabled plugin never registers.
 *
 * Runs from `emitCharacterReplacedEvent` before `CHARACTER_REPLACED` is
 * emitted, so a long-lived action (e.g. CEA's merge studio) delays the
 * event until it closes — same ordering the old CEA listener had.
 * Documented in docs/development/extension-api/character-replace-flow.md.
 */

import { t } from '/scripts/i18n.js';
import { POPUP_RESULT, Popup } from '/scripts/popup.js';
import { getContext } from '/scripts/st-context.js';

const MODULE_NAME = 'post-replace-actions';

const ACTION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

// The popup API maps custom buttons to POPUP_RESULT.CUSTOM1..CUSTOM9
// (1001..1009); more buttons have no result value to resolve against.
const MAX_CUSTOM_ACTIONS = 9; // cap-ok: the popup API maps custom buttons to POPUP_RESULT.CUSTOM1..CUSTOM9 only

const CORE_ACTION_WORLD_BOOK_IMPORT = 'world-book-import';
const CORE_ACTION_WORLD_BOOK_KEEP = 'world-book-keep';

/** @type {Map<string, object>} insertion-ordered action registry */
const actions = new Map();

/**
 * Register a post-replace action. Owners call this from their extension
 * init; core registers its own two actions at the bottom of this module.
 *
 * @param {object} descriptor
 * @param {string} descriptor.id Unique, stable action id; letters, digits, `_` and `-` only, must start with a letter.
 * @param {() => string} descriptor.label User-visible button text (translated by the owner).
 * @param {(detail: object) => string} descriptor.description One-line explanation for the popup body.
 * @param {(detail: object) => boolean} descriptor.isAvailable Whether to offer this action for this replacement.
 * @param {(detail: object) => Promise<void>} descriptor.run Execute the action.
 */
export function registerPostReplaceAction(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') {
        throw new TypeError(`${MODULE_NAME}: action descriptor must be an object`);
    }
    if (typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
        throw new TypeError(`${MODULE_NAME}: action descriptor requires a non-empty string id`);
    }
    if (!ACTION_ID_PATTERN.test(descriptor.id)) {
        throw new TypeError(`${MODULE_NAME}: action id '${descriptor.id}' must match ${ACTION_ID_PATTERN}`);
    }
    for (const field of ['label', 'description', 'isAvailable', 'run']) {
        if (typeof descriptor[field] !== 'function') {
            throw new TypeError(`${MODULE_NAME}: action '${descriptor.id}' requires a ${field}() function`);
        }
    }
    if (actions.has(descriptor.id)) {
        console.warn(`[${MODULE_NAME}] Overwriting existing action '${descriptor.id}'`);
    }
    actions.set(descriptor.id, descriptor);
}

/** @returns {object[]} registered descriptors in registration order */
export function listPostReplaceActions() {
    return [...actions.values()];
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function resolveActionLabel(action) {
    try {
        return String(action.label());
    } catch {
        return action.id;
    }
}

/**
 * Assemble the object handed to `isAvailable` / `description` / `run`.
 * @returns {object}
 */
export function computePostReplaceDetail(characterId, character, previousCharacter, previousLorebookSnapshot) {
    const ctx = getContext();
    const previousBookName = String(
        previousLorebookSnapshot?.bookName
        || previousCharacter?.data?.extensions?.world
        || '',
    ).trim();
    const previousBookExists = previousBookName ? worldBookExists(ctx, previousBookName) : false;
    const hasNewEmbeddedBook = Boolean(
        character?.data?.character_book
        && Array.isArray(character.data.character_book.entries)
        && character.data.character_book.entries.length > 0,
    );
    return {
        characterId,
        character,
        previousCharacter: previousCharacter || null,
        previousLorebookSnapshot: previousLorebookSnapshot || null,
        previousBookName,
        previousBookExists,
        hasNewEmbeddedBook,
        source: 'replace_update',
    };
}

/**
 * Post-replace orchestration: suppress the legacy popup, ask the user which
 * available action to run, execute it. Never throws — a failed action must
 * not break the replacement itself.
 * @param {{characterId: number, previousCharacter: object|null, newCharacter: object|null, previousLorebookSnapshot: object|null}} args
 * @returns {Promise<{actionId: string|null}>}
 */
export async function handlePostReplaceWorldBook({ characterId, previousCharacter, newCharacter, previousLorebookSnapshot }) {
    try {
        if (!newCharacter || typeof newCharacter !== 'object') {
            return { actionId: null };
        }
        const avatar = String(newCharacter.avatar || '').trim();
        if (!avatar) {
            return { actionId: null };
        }
        // The replace flow triggers `select_selected_character` ->
        // `checkEmbeddedWorld` which can open ST's legacy "import embedded
        // world book?" popup. Suppress it unconditionally: the core popup
        // below is strictly more capable, and with no action available
        // there is nothing to import through that legacy dialog either.
        suppressLegacyEmbeddedWorldPopup(avatar);

        const detail = computePostReplaceDetail(characterId, newCharacter, previousCharacter, previousLorebookSnapshot);

        const available = [];
        for (const action of listPostReplaceActions()) {
            try {
                if (action.isAvailable(detail)) {
                    available.push(action);
                }
            } catch (error) {
                console.warn(`[${MODULE_NAME}] action '${action.id}' failed the availability check`, error);
            }
        }
        if (available.length === 0) {
            return { actionId: null };
        }
        if (available.length > MAX_CUSTOM_ACTIONS) {
            console.warn(`[${MODULE_NAME}] ${available.length} actions are available but the popup supports ${MAX_CUSTOM_ACTIONS}; truncating`);
            available.length = MAX_CUSTOM_ACTIONS;
        }

        const rowsHtml = available.map(action => {
            let description = '';
            try {
                description = String(action.description(detail) || '');
            } catch (error) {
                console.warn(`[${MODULE_NAME}] action '${action.id}' failed to describe itself`, error);
            }
            return `<li style="line-height:1.45;"><strong>${escapeHtmlText(resolveActionLabel(action))}</strong> — ${escapeHtmlText(description)}</li>`;
        }).join('');
        const bodyHtml = [
            `<div style="margin-bottom:12px;">${escapeHtmlText(t`You just replaced or updated this character card. Choose what to do with its world book:`)}</div>`,
            `<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;">${rowsHtml}</ul>`,
        ].join('');

        const buttons = available.map((action, index) => ({
            text: resolveActionLabel(action),
            result: POPUP_RESULT.CUSTOM1 + index,
            // The first available action is the recommended default and
            // carries the only solid button; the rest stay neutral.
            classes: index === 0 ? ['popup-button-ok'] : [],
        }));
        const result = await Popup.show.confirm(
            t`Replace: what should happen to the world book?`,
            bodyHtml,
            {
                okButton: false,
                cancelButton: t`Cancel`,
                customButtons: buttons,
                defaultResult: buttons[0].result,
            },
        );

        const chosenIndex = buttons.findIndex(button => button.result === result);
        if (chosenIndex < 0) {
            return { actionId: null };
        }
        const chosen = available[chosenIndex];
        try {
            await chosen.run(detail);
        } catch (error) {
            console.warn(`[${MODULE_NAME}] action '${chosen.id}' failed`, error);
            if (typeof toastr !== 'undefined') {
                toastr.error(t`Failed to apply the world book choice: ${String(error?.message || error)}`);
            }
        }
        return { actionId: chosen.id };
    } catch (error) {
        console.error(`[${MODULE_NAME}] post-replace world book handling failed`, error);
        return { actionId: null };
    }
}

function worldBookExists(context, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
        return false;
    }
    try {
        const names = context?.getWorldInfoNames?.() || [];
        return Array.isArray(names) && names.some(entry => String(entry || '').trim() === trimmed);
    } catch {
        return false;
    }
}

function suppressLegacyEmbeddedWorldPopup(avatar) {
    const trimmed = String(avatar || '').trim();
    if (!trimmed) {
        return;
    }
    // ST's `checkEmbeddedWorld` gates its popup on
    // `accountStorage.getItem('AlertWI_' + avatar)`. Stamp the key so any
    // future call short-circuits before opening the legacy dialog.
    try {
        const storage = getContext()?.accountStorage;
        if (storage && typeof storage.setItem === 'function') {
            storage.setItem(`AlertWI_${trimmed}`, 'true');
        }
    } catch { /* best-effort */ }
    // The legacy popup may have already opened (`select_selected_character`
    // runs earlier than the post-replace handling). Walk the open popup
    // list and cancel any dialog whose body matches the legacy embedded-
    // world copy — English and the Chinese fallbacks ST ships with.
    try {
        const dialogs = document.querySelectorAll('dialog.popup[open]');
        dialogs.forEach(dlg => {
            const body = dlg.querySelector('.popup-body, .popup-content');
            const text = String(body?.textContent || '');
            if (!text) {
                return;
            }
            if (/embedded World\/Lorebook|内置的世界书\/Lorebook|內嵌的世界書\/Lorebook/i.test(text)) {
                const cancelBtn = dlg.querySelector('.popup-button-cancel');
                const closeBtn = dlg.querySelector('.popup-button-close');
                if (cancelBtn instanceof HTMLElement) {
                    cancelBtn.click();
                } else if (closeBtn instanceof HTMLElement) {
                    closeBtn.click();
                }
            }
        });
    } catch { /* best-effort */ }
}

/**
 * Materialize a character's embedded world book: save it as a standalone
 * file, bind it as the primary world book, and mirror the visible UI.
 * Throws when the character or the import entry point is unavailable.
 */
export async function importEmbeddedBookForCharacter(characterId) {
    const ctx = getContext();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const character = Number.isInteger(characterId) ? characters[characterId] : null;
    if (!character?.avatar) {
        throw new Error(`${MODULE_NAME}: character not found at index ${characterId}`);
    }
    // `importEmbeddedWorldInfo` reads the chid from the hidden import
    // marker; re-arm it in case the legacy-popup suppression left it
    // hidden.
    jQuery('#import_character_info').data('chid', characterId).show();
    if (typeof ctx.importEmbeddedWorldInfo !== 'function') {
        throw new Error(`${MODULE_NAME}: importEmbeddedWorldInfo is unavailable`);
    }
    await ctx.importEmbeddedWorldInfo(true);
    const bookName = String(character?.data?.character_book?.name || `${character?.name}'s Lorebook`).trim();
    if (bookName) {
        await bindPrimaryBook(ctx, characterId, bookName);
    }
}

/**
 * Re-bind a previously bound primary world book (used by the Keep action
 * and by CEA's merge rollback).
 */
export async function rebindPreviousPrimaryBook(characterId, bookName) {
    const ctx = getContext();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const character = Number.isInteger(characterId) ? characters[characterId] : null;
    if (!character?.avatar) {
        throw new Error(`${MODULE_NAME}: character not found at index ${characterId}`);
    }
    await bindPrimaryBook(ctx, characterId, bookName);
}

async function bindPrimaryBook(ctx, characterId, bookName) {
    if (typeof ctx.charUpdatePrimaryWorld !== 'function') {
        throw new Error(`${MODULE_NAME}: charUpdatePrimaryWorld is unavailable`);
    }
    // `charUpdatePrimaryWorld` reads `this_chid` from script.js's module
    // scope, so make sure the edit panel points at this character before
    // writing.
    const editPanelChid = jQuery('#set_character_world').data('chid');
    if (editPanelChid !== characterId && typeof ctx.selectCharacterById === 'function') {
        try { await ctx.selectCharacterById(characterId); } catch { /* best-effort */ }
    }
    await ctx.charUpdatePrimaryWorld(bookName);
    // Mirror the UI gesture so the visible select picks up the value.
    jQuery('#character_world').val(bookName).trigger('change');
    if (typeof ctx.worldInfoEntry?.setButtonClass === 'function') {
        ctx.worldInfoEntry.setButtonClass(characterId, true);
    }
}

registerPostReplaceAction({
    id: CORE_ACTION_WORLD_BOOK_IMPORT,
    label: () => t`Import new book`,
    description: () => t`Save the new card's embedded world book as a standalone file and bind it to this character. Use when you want the new card's shipped lore verbatim.`,
    isAvailable: detail => detail.hasNewEmbeddedBook,
    run: detail => importEmbeddedBookForCharacter(detail.characterId),
});

registerPostReplaceAction({
    id: CORE_ACTION_WORLD_BOOK_KEEP,
    label: () => t`Keep old book`,
    description: detail => t`Re-bind the previously bound book (${detail.previousBookName}) and ignore the new card's embedded book. Use when you only wanted to refresh the character fields.`,
    isAvailable: detail => Boolean(detail.previousBookName && detail.previousBookExists),
    run: async detail => {
        await rebindPreviousPrimaryBook(detail.characterId, detail.previousBookName);
        if (typeof toastr !== 'undefined') {
            toastr.success(t`Kept the previous primary world book bound: ${detail.previousBookName}`);
        }
    },
});
