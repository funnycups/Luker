// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Save and undo rules for AI iteration that do not need Luker itself: what a
// partly saved batch reports, how world book entries are reverted, and which
// stored orchestration profile a change belongs to. Luker's functions are
// passed in.

import { i18n, i18nFormat } from '../i18n.js';
import { SourceError } from './errors.js';

const canon = (value) => JSON.stringify(value ?? null, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
const same = (a, b) => canon(a) === canon(b);
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** The entry a world book edit leaves behind; null when it removes the entry. */
export function entryAfterEdit(before, edit) {
    if (edit.op === 'lorebook_entry_add') return clone(edit.entry);
    if (edit.op === 'lorebook_entry_remove') return null;
    return clone({ ...(before || {}), ...edit.patch });
}

/**
 * Puts back only the entries in `records` ({ uid, before, after }). An entry
 * that no longer matches what the edit wrote was changed since, so it stays.
 * @returns {{ book: object, changed: number, conflicts: Array<string|number> }}
 */
export function revertBookEntries(current, records) {
    const book = clone(current) || { entries: {} };
    book.entries ||= {};
    let changed = 0;
    const conflicts = [];
    for (const { uid, before, after } of records) {
        const now = book.entries[uid] ?? null;
        if (same(now, before)) continue;
        if (!same(now, after)) { conflicts.push(uid); continue; }
        if (before === null) delete book.entries[uid];
        else book.entries[uid] = clone(before);
        changed++;
    }
    return { book, changed, conflicts };
}

/**
 * Saves card edits, then each book's edits. Luker saves the edits that do not
 * conflict and reports the rest, so the outcome is tracked per edit.
 * @param {{ cardEdits: object[], bookEdits: Record<string, object[]>, keyOf: Map<object, string> }} batch
 * @param {{ commitCard, readBook, commitBook, saveBook }} io
 * @returns {Promise<{ applied: string[], skipped: { key: string, reason: string }[], failure: string, undo: () => Promise<void> }>}
 */
export async function commitCardAndBooks({ cardEdits, bookEdits, keyOf }, io) {
    const applied = [];
    const skipped = [];
    const steps = [];
    let failure = null;
    const skip = (edits, reason) => { for (const e of edits) skipped.push({ key: keyOf.get(e), reason }); };
    /** Sorts a batch by outcome; returns the edits that really changed saved data. */
    const settle = (edits, res) => {
        const conflicts = new Map((res?.conflicts || []).map(c => [c.edit, c.reason]));
        const done = new Set(res?.alreadyDone || []);
        const written = [];
        for (const e of edits) {
            if (conflicts.has(e)) { skipped.push({ key: keyOf.get(e), reason: conflicts.get(e) }); continue; }
            applied.push(keyOf.get(e));
            if (res?.persisted && !done.has(e)) written.push(e);
        }
        return written;
    };

    if (cardEdits.length) {
        try {
            const written = settle(cardEdits, await io.commitCard(cardEdits));
            if (written.length) {
                const inverse = written.map(e => ({ op: 'set', path: e.path, oldValue: e.newValue, newValue: e.oldValue }));
                steps.push(async () => (await io.commitCard(inverse))?.conflicts?.length || 0);
            }
        } catch (err) {
            failure = err;
            skip(cardEdits, 'failed');
        }
    }
    for (const [book, edits] of Object.entries(bookEdits)) {
        if (!edits.length) continue;
        if (failure) { skip(edits, 'failed'); continue; }
        try {
            const before = await io.readBook(book);
            const written = settle(edits, await io.commitBook(book, before, edits));
            if (written.length) {
                const records = written.map((e) => {
                    const prior = before?.entries?.[e.uid] ?? null;
                    return { uid: e.uid, before: clone(prior), after: entryAfterEdit(prior, e) };
                });
                steps.push(async () => {
                    const result = revertBookEntries(await io.readBook(book), records);
                    if (result.changed) await io.saveBook(book, result.book);
                    return result.conflicts.length;
                });
            }
        } catch (err) {
            failure = err;
            skip(edits, 'failed');
        }
    }

    if (!applied.length) {
        if (failure) throw failure;
        if (skipped.length) throw new SourceError('conflict', i18nFormat('${0} changes conflict with edits made elsewhere, so nothing was saved. Reopen the chat.', skipped.length));
    }
    return {
        applied,
        skipped,
        failure: failure ? String(failure.message || failure) : '',
        async undo() {
            let conflicts = 0;
            let error = null;
            for (const step of [...steps].reverse()) {
                try { conflicts += await step(); } catch (err) { error ||= err; }
            }
            if (error) throw error;
            if (conflicts) throw new SourceError('conflict', i18nFormat('${0} places were changed after this edit and were left alone; everything else was undone.', conflicts));
        },
    };
}

/** The per-character orchestration profile a change was made to, or null if it is gone. */
export function orchCharacterRecord(characters, target) {
    if (!target?.avatar) return null;
    const index = (characters || []).findIndex(c => c?.avatar === target.avatar);
    if (index < 0) return null;
    const raw = characters[index].data?.extensions?.orchestrator?.presetLibraries?.[target.mode]?.[target.presetId];
    return raw ? { index, raw } : null;
}

/** Writes a profile back to the card at `index`; throws when Luker reports failure. */
export async function writeCharacterProfile(ctx, target, index, profile) {
    const ext = clone(ctx.characters[index]?.data?.extensions?.orchestrator);
    const lib = ext?.presetLibraries?.[target.mode];
    if (!lib?.[target.presetId]) throw new SourceError('target-gone', i18n('The orchestration profile this change was made to no longer exists'));
    lib[target.presetId] = { ...profile, name: lib[target.presetId].name };
    const ok = await ctx.getExtensionApi('orchestrator').persistOrchestratorCharacterExtension(ctx, index, ext);
    if (!ok) throw new SourceError('write-failed', i18n('Failed to write to the character card'));
}

/**
 * The character editor assistant's helper factory: the published API when it
 * is registered, otherwise its module. Its registration was removed from the
 * host in 50058129e, so the published API alone would break every read.
 */
export async function ceaHelperSource(ctx, loadMain) {
    const published = ctx.getExtensionApi?.('character-editor-assistant');
    if (typeof published?.buildCharacterEditorHelperApis === 'function') return published;
    let main = null;
    try { main = await loadMain(); } catch { /* reported below */ }
    if (typeof main?.buildCharacterEditorHelperApis !== 'function') throw new SourceError('no-extension', i18n('The character editor assistant is unavailable'));
    return main;
}
