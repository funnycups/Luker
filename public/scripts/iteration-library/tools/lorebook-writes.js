// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Lorebook write tools shared by iter popups. Mirror of `lorebook-reads.js`.
 *
 * Architecture: plugin-agnostic. Two-phase contract:
 *
 *   1. `runLorebookWriteTool(call, { context })` — proposal phase. Returns
 *      `{ before, after, kind, ... }` WITHOUT touching disk. Popups capture
 *      the result as a pending diff card the user reviews.
 *
 *   2. `applyLorebookProposal(context, { kind, args })` — apply phase.
 *      Re-derives `after` from `args` against the entry's CURRENT on-disk
 *      state and writes once. Re-derivation lets multiple approved
 *      proposals chain correctly and surfaces concurrent drift as a fresh
 *      validation error rather than clobbering.
 *
 * Why writes are character-scoped: the popups that invoke writes (e.g.
 * orchestrator iter-studio) shape the iteration around one card. Global
 * popups SHOULD NOT splice these into their catalog. Nothing in this
 * module enforces avatar scope — that's the popup's call.
 *
 * Tools:
 *   - `lorebook_update_entry(book_name, uid, patch)` — shallow merge.
 *   - `lorebook_str_replace_in_entry(book_name, uid, oldString, newString, replaceAll?)`
 */

import { lorebookHelpers as H, LorebookError } from './_lorebook-helpers.js';
import { STATE_ERROR_REASONS } from '../../state-errors.js';

const TOOL_NAMES = Object.freeze({
    LOREBOOK_UPDATE_ENTRY: 'lorebook_update_entry',
    LOREBOOK_STR_REPLACE_IN_ENTRY: 'lorebook_str_replace_in_entry',
});

export const LOREBOOK_WRITE_TOOL_NAMES = Object.freeze(Object.values(TOOL_NAMES));

const NAME_SET = new Set(LOREBOOK_WRITE_TOOL_NAMES);

export function isLorebookWriteTool(name) {
    return NAME_SET.has(String(name || ''));
}

export const LOREBOOK_WRITE_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: TOOL_NAMES.LOREBOOK_UPDATE_ENTRY,
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
            name: TOOL_NAMES.LOREBOOK_STR_REPLACE_IN_ENTRY,
            description: 'Replace a substring inside an entry\'s `content` field. By default `oldString` must appear exactly once — fails otherwise so accidental multi-site edits are not possible; widen the substring with surrounding context until it is unique. Pass `replaceAll: true` to replace every occurrence. Prefer this over lorebook_update_entry when you only need to tweak a few sentences of a long entry.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    uid: { type: 'integer', description: 'Required. UID of the entry to edit.' },
                    oldString: { type: 'string', description: 'Required. Substring to find. Must occur exactly once in the entry\'s current content unless `replaceAll` is true.' },
                    newString: { type: 'string', description: 'Required. Replacement text. May be the empty string to delete `oldString`.' },
                    replaceAll: { type: 'boolean', description: 'Optional. When true, replace every occurrence of `oldString`. Default false (unique-or-fail).' },
                },
                required: ['book_name', 'uid', 'oldString', 'newString'],
                additionalProperties: false,
            },
        },
    },
];

async function computeUpdate(context, args, { missingReason = STATE_ERROR_REASONS.VALIDATION_TARGET } = {}) {
    const bookName = String(args?.book_name || '').trim();
    if (!bookName) throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_update_entry requires book_name' });
    const uid = H.asFiniteInteger(args?.uid, null);
    if (!Number.isInteger(uid) || uid < 0) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_update_entry requires a non-negative integer uid' });
    }
    const patch = args?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_update_entry requires a patch object' });
    }
    const patchKeys = Object.keys(patch);
    if (patchKeys.length === 0) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_update_entry patch must contain at least one field' });
    }
    const data = await context.loadWorldInfo(bookName);
    if (!data) {
        throw new LorebookError({ reason: missingReason, hint: `World book "${bookName}" not found` });
    }
    const entry = data.entries?.[uid];
    if (!entry) {
        throw new LorebookError({ reason: missingReason, hint: `Entry uid ${uid} not found in "${bookName}"` });
    }
    const before = structuredClone(entry);
    const after = structuredClone(entry);
    Object.assign(after, patch);
    after.uid = uid;
    return {
        ok: true,
        book_name: bookName,
        uid,
        kind: 'update',
        before,
        after,
        updated_fields: patchKeys.filter(k => k !== 'uid'),
    };
}

async function computeStrReplace(context, args, { missingReason = STATE_ERROR_REASONS.VALIDATION_TARGET } = {}) {
    const bookName = String(args?.book_name || '').trim();
    if (!bookName) throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_str_replace_in_entry requires book_name' });
    const uid = H.asFiniteInteger(args?.uid, null);
    if (!Number.isInteger(uid) || uid < 0) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_str_replace_in_entry requires a non-negative integer uid' });
    }
    if (typeof args?.oldString !== 'string' || args.oldString.length === 0) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_str_replace_in_entry requires a non-empty oldString' });
    }
    if (typeof args?.newString !== 'string') {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'lorebook_str_replace_in_entry requires newString (use an empty string to delete)' });
    }
    const replaceAll = Boolean(args?.replaceAll);
    const data = await context.loadWorldInfo(bookName);
    if (!data) {
        throw new LorebookError({ reason: missingReason, hint: `World book "${bookName}" not found` });
    }
    const entry = data.entries?.[uid];
    if (!entry) {
        throw new LorebookError({ reason: missingReason, hint: `Entry uid ${uid} not found in "${bookName}"` });
    }
    const content = String(entry.content ?? '');
    const firstIdx = content.indexOf(args.oldString);
    if (firstIdx === -1) {
        throw new LorebookError({ reason: missingReason, hint: `oldString not found in entry ${uid} of "${bookName}"` });
    }
    if (!replaceAll && content.indexOf(args.oldString, firstIdx + args.oldString.length) !== -1) {
        throw new LorebookError({
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: `oldString occurs more than once in entry ${uid} of "${bookName}"; narrow it or pass replaceAll: true`,
        });
    }
    const before = structuredClone(entry);
    const after = structuredClone(entry);
    const nextContent = replaceAll
        ? content.split(args.oldString).join(args.newString)
        : content.slice(0, firstIdx) + args.newString + content.slice(firstIdx + args.oldString.length);
    after.content = nextContent;
    after.uid = uid;
    return {
        ok: true,
        book_name: bookName,
        uid,
        kind: 'str_replace',
        before,
        after,
        replaced_chars: args.oldString.length,
        new_chars: args.newString.length,
    };
}

/**
 * Commit an approved lorebook-edit proposal to disk. Loads the book, copies
 * the supplied `after` entry into `data.entries[uid]` (preserving uid as the
 * address), and saves. Iter-studio's Apply path calls this once per approved
 * pending edit, sequentially.
 */
export async function applyLorebookCommit(context, { book_name, uid, after } = {}) {
    const bookName = String(book_name || '').trim();
    if (!bookName) throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'applyLorebookCommit: book_name is required' });
    if (!Number.isInteger(uid) || uid < 0) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'applyLorebookCommit: uid must be a non-negative integer' });
    }
    if (!after || typeof after !== 'object' || Array.isArray(after)) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'applyLorebookCommit: after must be an object' });
    }
    const data = await context.loadWorldInfo(bookName);
    if (!data) throw new LorebookError({ reason: STATE_ERROR_REASONS.CONFLICT, hint: `World book "${bookName}" not found` });
    const entry = data.entries?.[uid];
    if (!entry) throw new LorebookError({ reason: STATE_ERROR_REASONS.CONFLICT, hint: `Entry uid ${uid} not found in "${bookName}"` });
    Object.assign(entry, after);
    entry.uid = uid;
    await context.saveWorldInfo(bookName, data, true, { refreshEditor: true });
    return { ok: true, book_name: bookName, uid };
}

/**
 * Apply-time commit that re-derives the after-image from the proposal's
 * original tool args against the entry's CURRENT on-disk state, then
 * writes once. The popup approval flow calls this so:
 *
 *   1. Multiple approved proposals on the same book#uid chain correctly
 *      (B lands on top of A's already-committed mutation rather than B's
 *      stale `after` snapshot clobbering A's change).
 *   2. Concurrent drift (a parallel session edited the book between
 *      proposal time and Apply time) surfaces as a fresh validation
 *      error — for `str_replace`, the unique-match guard fires; for
 *      `update`, the shallow merge lands on the current content rather
 *      than the proposal author's expectation.
 */
export async function applyLorebookProposal(context, { kind, args } = {}) {
    const safeArgs = (args && typeof args === 'object') ? args : {};
    let computed;
    if (kind === 'update') {
        computed = await computeUpdate(context, safeArgs, { missingReason: STATE_ERROR_REASONS.CONFLICT });
    } else if (kind === 'str_replace') {
        computed = await computeStrReplace(context, safeArgs, { missingReason: STATE_ERROR_REASONS.CONFLICT });
    } else {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: `applyLorebookProposal: unknown kind "${kind}"` });
    }
    return applyLorebookCommit(context, {
        book_name: computed.book_name,
        uid: computed.uid,
        after: computed.after,
    });
}

/**
 * Execute one lorebook write tool. Plugin-agnostic — proposal mode only;
 * returns the {before, after, ...} envelope without touching disk. Commit
 * via `applyLorebookProposal` after user approval.
 *
 * @param {object} call — `{ id, name, args }` from the runner
 * @param {object} ctx
 * @param {object} ctx.context — SillyTavern context (provides loadWorldInfo)
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export async function runLorebookWriteTool(call, { context } = {}) {
    const name = String(call?.name || '');
    if (!isLorebookWriteTool(name)) {
        return { ok: false, error: `Not a lorebook write tool: ${name || '(empty)'}` };
    }
    if (!context || typeof context !== 'object') {
        return { ok: false, error: 'runLorebookWriteTool: ctx.context is required' };
    }
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    try {
        let result;
        if (name === TOOL_NAMES.LOREBOOK_UPDATE_ENTRY) {
            result = await computeUpdate(context, args);
        } else if (name === TOOL_NAMES.LOREBOOK_STR_REPLACE_IN_ENTRY) {
            result = await computeStrReplace(context, args);
        } else {
            return { ok: false, error: `Unhandled lorebook write tool: ${name}` };
        }
        return { ok: true, result };
    } catch (err) {
        if (err instanceof LorebookError) {
            return { ok: false, reason: err.reason, hint: err.hint, error: err.message };
        }
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}
