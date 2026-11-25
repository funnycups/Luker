// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Proposal target for one world-book entry, addressed by
 * `{ type: LOREBOOK_ENTRY_TARGET_TYPE, name, uid }`.
 *
 * `read` returns the entry itself, so the bus drift check and the stored
 * inverse operate on entry-level paths (`/content`, `/disable`, ...) — the
 * same shape the lorebook write tools put into a proposal's before/after.
 * `write` replaces the entry with the next state the bus computed, so a
 * rollback also removes keys the proposal added. It never replays tool
 * args (`target._op`): the bus has already applied the patch to the
 * current entry and checked every touched path for drift, and `write`
 * cannot tell an approve from a rollback.
 *
 * The type string is persisted in saved sessions and must not change.
 */

import { hasTarget, registerTarget } from '../../storage/target-registry.js';
import { LorebookError } from '../../tools/_lorebook-helpers.js';
import { STATE_ERROR_REASONS } from '../../../lib/state-errors.js';

export const LOREBOOK_ENTRY_TARGET_TYPE = 'orch-lorebook';

// The registry holds one handler per type for the whole page while each
// popup mount passes its own context; the latest ensure call wins. Every
// caller passes the same SillyTavern context surface.
let boundContext = null;

function requireContext() {
    if (!boundContext
        || typeof boundContext.loadWorldInfo !== 'function'
        || typeof boundContext.saveWorldInfo !== 'function') {
        throw new LorebookError({
            reason: STATE_ERROR_REASONS.VALIDATION_TARGET,
            hint: 'lorebook entry target has no context with loadWorldInfo/saveWorldInfo',
        });
    }
    return boundContext;
}

function entryAddress(target) {
    const name = String(target?.name || '').trim();
    const uid = Number(target?.uid);
    if (!name || !Number.isInteger(uid) || uid < 0) {
        throw new LorebookError({
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: 'lorebook entry target needs a book name and a non-negative integer uid',
        });
    }
    return { name, uid };
}

const lorebookEntryTarget = {
    async read(target) {
        const { name, uid } = entryAddress(target);
        const book = await requireContext().loadWorldInfo(name);
        if (!book || !book.entries || typeof book.entries !== 'object') {
            throw new LorebookError({ reason: STATE_ERROR_REASONS.CONFLICT, hint: `World book "${name}" not found` });
        }
        if (!book.entries[uid]) {
            throw new LorebookError({ reason: STATE_ERROR_REASONS.CONFLICT, hint: `Entry uid ${uid} not found in "${name}"` });
        }
        return structuredClone(book.entries[uid]);
    },
    async write(target, next) {
        const { name, uid } = entryAddress(target);
        const context = requireContext();
        const book = await context.loadWorldInfo(name);
        if (!book || !book.entries || typeof book.entries !== 'object') {
            throw new LorebookError({ reason: STATE_ERROR_REASONS.CONFLICT, hint: `World book "${name}" not found` });
        }
        if (!book.entries[uid]) {
            throw new LorebookError({ reason: STATE_ERROR_REASONS.CONFLICT, hint: `Entry uid ${uid} not found in "${name}"` });
        }
        const nextBook = structuredClone(book);
        nextBook.entries[uid] = { ...structuredClone(next ?? {}), uid };
        await context.saveWorldInfo(name, nextBook, true, { refreshEditor: true });
    },
    describe(target) {
        return `lorebook:${String(target?.name || '')}`;
    },
};

export function ensureLorebookEntryTarget(context) {
    boundContext = context;
    if (!hasTarget(LOREBOOK_ENTRY_TARGET_TYPE)) {
        registerTarget(LOREBOOK_ENTRY_TARGET_TYPE, lorebookEntryTarget);
    }
}
