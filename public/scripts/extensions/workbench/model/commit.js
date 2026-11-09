// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Save and undo rules for AI iteration that do not need Luker itself: what a
// partly saved batch reports, how world books are read for writing, and which
// stored orchestration profile a change belongs to. Luker's functions are
// passed in.

import { i18n, i18nFormat } from '../i18n.js';
import { BOOK_META, applyBookOps, bookUnits } from './adapters.js';
import { SourceError } from './errors.js';
import { clone, conflictsLeftAlone, requireApplied, same, writeFields } from './patch.js';

const parseBookKey = (key) => key.match(/^wi:(.*):([^:]+)$/)?.[2];

/** Throws unless a book read back as a real book with entries to work on. */
function requireBook(book, name, count) {
    if (!book || typeof book.entries !== 'object' || book.entries === null) throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', name));
    if (count > 0 && !Object.keys(book.entries).length) throw new SourceError('book-empty', i18nFormat('"${0}" reads as empty but had entries before, so nothing was written', name));
    return book;
}

/**
 * A book to write to. Luker's cache can hold unsaved or failed writes, so
 * every touched entry is compared with the copy on the server; untouched
 * entries keep the cached version, which a pending save would write anyway.
 */
export function bookForWrite(persisted, cached, uids, name) {
    if (!persisted) return persisted;
    if (!cached?.entries) return persisted;
    for (const uid of uids) {
        if (uid !== BOOK_META && !same(persisted.entries?.[uid], cached.entries?.[uid])) throw new SourceError('unsaved', i18nFormat('"${0}" has unsaved edits in the world info panel. Wait for them to save, then try again.', name));
    }
    return cached;
}

async function commitBook(name, ops, baseCount, io) {
    const uids = ops.map(op => parseBookKey(op.key));
    let lastCount = 0;
    let requiredCount = baseCount;
    const result = await writeFields({
        async read() {
            const book = requireBook(await io.readBook(name, uids), name, requiredCount);
            lastCount = Object.keys(book.entries).length;
            return book;
        },
        units: (book) => bookUnits(name, book),
        apply: applyBookOps,
        write: (next) => io.saveBook(name, next),
    }, ops);
    // What undo may expect to find: entries this record did not touch.
    const touched = result.written.filter(op => op.kind !== 'add' && parseBookKey(op.key) !== BOOK_META).length;
    requiredCount = Math.max(0, lastCount - touched) + result.written.filter(op => op.kind === 'change' && parseBookKey(op.key) !== BOOK_META).length;
    return result;
}

/**
 * Saves card edits, then each book's field changes. The outcome is tracked
 * per unit, and only writes that reached storage count as applied.
 * @param {{ cardEdits: object[], bookOps: Record<string, object[]>, baseCounts: Record<string, number>, keyOf: Map<object, string> }} batch
 * @param {{ commitCard, readBook, saveBook }} io
 * @returns {Promise<{ applied: string[], skipped: { key: string, reason: string }[], failure: string, undo: () => Promise<void> }>}
 */
export async function commitCardAndBooks({ cardEdits, bookOps, baseCounts = {}, keyOf }, io) {
    const applied = [];
    const skipped = [];
    const steps = [];
    let failure = null;

    if (cardEdits.length) {
        try {
            const res = await io.commitCard(cardEdits);
            const conflicts = new Map((res?.conflicts || []).map(c => [c.edit, c.reason]));
            const done = new Set(res?.alreadyDone || []);
            const written = [];
            for (const e of cardEdits) {
                if (conflicts.has(e)) skipped.push({ key: keyOf.get(e), reason: conflicts.get(e) });
                // Luker's character list can hold a failed write, so "already
                // there" does not prove the value was saved.
                else if (!res?.persisted || done.has(e)) skipped.push({ key: keyOf.get(e), reason: 'not-saved' });
                else { applied.push(keyOf.get(e)); written.push(e); }
            }
            if (written.length) {
                const inverse = written.map(e => ({ op: 'set', path: e.path, oldValue: e.newValue, newValue: e.oldValue }));
                steps.push(async () => (await io.commitCard(inverse))?.conflicts?.length || 0);
            }
        } catch (err) {
            failure = err;
            for (const e of cardEdits) skipped.push({ key: keyOf.get(e), reason: 'failed' });
        }
    }
    for (const [book, ops] of Object.entries(bookOps)) {
        if (!ops.length) continue;
        if (failure) { for (const op of ops) skipped.push({ key: op.key, reason: 'failed' }); continue; }
        try {
            const result = await commitBook(book, ops, baseCounts[book] || 0, io);
            applied.push(...result.applied);
            skipped.push(...result.skipped);
            if (result.written.length) steps.push(() => result.revert());
        } catch (err) {
            failure = err;
            for (const op of ops) skipped.push({ key: op.key, reason: 'failed' });
        }
    }

    if (!applied.length) {
        if (failure) throw failure;
        requireApplied({ applied, skipped });
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
            if (conflicts) throw conflictsLeftAlone(conflicts);
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
