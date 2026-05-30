// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Lorebook write tools shared by iter popups. Mirror of `lorebook-reads.js`:
 * short name → legacy `luker_card_*` wire name, dispatched through a
 * popup-injected runner. The plugin-side handlers (in
 * `character-editor-assistant/main.js`) ultimately reach
 * `CardApp.ctx.updateWorldBookEntry`.
 *
 * Why writes are character-scoped: the legacy helper-tool dispatcher binds
 * to one avatar, so a popup that wants the AI to edit a card's lorebook
 * must already know which character is being designed. Popups in global
 * scope SHOULD NOT splice these into their catalog.
 *
 * Tools:
 *   - `lorebook_update_entry(book_name, uid, patch)` — shallow merge.
 *     Use it to toggle `disable`, rewrite `content` wholesale, or adjust
 *     keys / activation flags.
 *   - `lorebook_str_replace_in_entry(book_name, uid, old_str, new_str)` —
 *     surgical text edit. Cheaper than re-sending the whole content. Fails
 *     if `old_str` appears zero times or more than once.
 */

export const LOREBOOK_WRITE_TOOL_LEGACY_NAMES = Object.freeze({
    lorebook_update_entry: 'luker_card_update_lorebook_entry',
    lorebook_str_replace_in_entry: 'luker_card_str_replace_in_lorebook_entry',
});

const LOREBOOK_WRITE_TOOL_NAME_SET = new Set(Object.keys(LOREBOOK_WRITE_TOOL_LEGACY_NAMES));

export function isLorebookWriteTool(name) {
    return LOREBOOK_WRITE_TOOL_NAME_SET.has(String(name || ''));
}

export const LOREBOOK_WRITE_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'lorebook_update_entry',
            description: 'Update fields of one world-book entry by uid (shallow merge). Common patch fields: `content` (string), `disable` (boolean — true hides the entry from activation), `comment` (string label shown in the UI), `key` / `keysecondary` (string arrays), `constant` (boolean — always-active), `order` (integer). The uid itself cannot be changed. Call lorebook_get first to read the current entry before patching unless you are toggling `disable`.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    uid: { type: 'integer', description: 'Required. UID of the entry to update.' },
                    patch: {
                        type: 'object',
                        description: 'Required. Fields to overwrite on the entry. Shallow merge — nested arrays are replaced wholesale, not appended to.',
                        additionalProperties: true,
                    },
                },
                required: ['book_name', 'uid', 'patch'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_str_replace_in_entry',
            description: 'Replace one substring inside an entry\'s `content` field. `old_str` must appear exactly once in the current content — fails otherwise so accidental multi-site edits are not possible. Prefer this over lorebook_update_entry when you only need to tweak a few sentences of a long entry.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    uid: { type: 'integer', description: 'Required. UID of the entry to edit.' },
                    old_str: { type: 'string', description: 'Required. Substring to find. Must occur exactly once in the entry\'s current content.' },
                    new_str: { type: 'string', description: 'Required. Replacement text. May be the empty string to delete `old_str`.' },
                },
                required: ['book_name', 'uid', 'old_str', 'new_str'],
                additionalProperties: false,
            },
        },
    },
];

/**
 * Execute one lorebook write tool. Translates the short canonical name to
 * the legacy `luker_card_*` wire name and dispatches through the supplied
 * helper-tool runner. The dispatcher itself is plugin-owned (lives in
 * `character-editor-assistant/main.js#runCharacterEditorHelperToolCall`)
 * and is injected via `dispatch` so this module stays plugin-agnostic.
 *
 * @param {object} call — `{ id, name, args }` from the runner
 * @param {object} ctx
 * @param {(legacyCall: object, helperApis: any) => Promise<any>} ctx.dispatch
 * @param {any[]} [ctx.helperApis] — per-character helper APIs (avatar-scoped)
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export async function runLorebookWriteTool(call, { dispatch, helperApis = [] } = {}) {
    const shortName = String(call?.name || '');
    if (!isLorebookWriteTool(shortName)) {
        return { ok: false, error: `Not a lorebook write tool: ${shortName || '(empty)'}` };
    }
    if (typeof dispatch !== 'function') {
        return { ok: false, error: 'runLorebookWriteTool: ctx.dispatch must be a function' };
    }
    const legacyName = LOREBOOK_WRITE_TOOL_LEGACY_NAMES[shortName];
    const legacyCall = {
        id: call?.id,
        name: legacyName,
        args: call?.args && typeof call.args === 'object' ? call.args : {},
    };
    try {
        const raw = await dispatch(legacyCall, helperApis);
        const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result')
            ? raw.result
            : raw;
        return { ok: true, result };
    } catch (err) {
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}
