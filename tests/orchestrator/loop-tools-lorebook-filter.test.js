/**
 * Filter-at-source tests for the 5 lorebook exec functions.
 *
 * A compiled lorebookFilter on `context.__lukerRun.lorebookFilter` drops
 * matching books/entries at the exec entry point BEFORE any output is
 * shaped. The observable behavior for a filtered book/entry must be
 * indistinguishable from a genuinely absent one — zero side channel —
 * so the agent cannot infer "this exists but is hidden":
 *
 *   - execWorldBookList: filtered books simply don't appear in output.
 *   - execLorebookSearch: filtered entries silently absent from grep hits.
 *   - execLorebookList (book-level match): returns {ok:true, output:''}
 *     — same shape as a book with zero enabled entries.
 *   - execLorebookList (entry-level match): filtered rows silently
 *     absent from the row list.
 *   - execLorebookGet (book- or entry-level match): throws
 *     ToolError(LOREBOOK_NOT_FOUND) — same code + wording pattern as a
 *     genuinely missing entry.
 *   - execLorebookForceActivate (book-level match): throws
 *     ToolError(LOREBOOK_FORCE_BOOK_NOT_FOUND) — same as a missing book.
 *     (entry-level match): the uid is reported skipped with
 *     `reason: 'uid_not_found'` — same reason a genuinely absent uid
 *     produces.
 */

import { describe, test, expect } from '@jest/globals';

import {
    execWorldBookList,
    execLorebookList,
    execLorebookSearch,
    execLorebookGet,
} from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js';
import { execLorebookForceActivate } from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook-force-activate.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

const ENTRIES = [
    { world: 'private_notes', uid: 1, key: ['k1'], comment: 'entry_a', content: 'PRIVATE1', position: 0 },
    { world: 'private_notes', uid: 2, key: ['k2'], comment: 'entry_b', content: 'PRIVATE2', position: 0 },
    { world: 'public',        uid: 3, key: ['k3'], comment: 'public_x', content: 'PUBLIC_X', position: 0 },
    { world: 'public',        uid: 4, key: ['k4'], comment: 'secret_x', content: 'SECRET_X', position: 0 },
];

const SCOPES = { private_notes: 'global', public: 'global' };

function makeBook(bookName) {
    const byUid = {};
    for (const e of ENTRIES) if (e.world === bookName) byUid[e.uid] = e;
    return { entries: byUid };
}

function makeContext(filter, opts = {}) {
    return {
        __getSortedEntriesFn: async () => ENTRIES,
        __getWorldScopesFn: async () => SCOPES,
        __loadWorldInfoFn: async (name) => makeBook(name),
        __lukerRun: {
            lorebookFilter: filter,
            activatedEntryKeys: new Set(),
            ...(opts.withPayload ? { wiFinalizedPayload: { worldInfoBeforeEntries: [], worldInfoAfterEntries: [], worldInfoDepth: [] } } : {}),
        },
    };
}

describe('execWorldBookList — filter at source', () => {
    test('book pattern excludes matching book from listing', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' });
        const result = await execWorldBookList({}, ctx);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('public');
        expect(result.output).not.toContain('private_notes');
    });

    test('entry pattern that eliminates every entry in a book drops the book from listing', async () => {
        // With entryPattern eliminating both entry_a and entry_b of private_notes,
        // that book falls to zero enabled entries and disappears from world_book_list.
        const ctx = makeContext({ bookPattern: '', entryPattern: '^entry_' });
        const result = await execWorldBookList({}, ctx);
        expect(result.output).toContain('public');
        expect(result.output).not.toContain('private_notes');
    });

    test('empty filter → identical output to no filter at all', async () => {
        const ctx = makeContext({ bookPattern: '', entryPattern: '' });
        const result = await execWorldBookList({}, ctx);
        expect(result.output).toContain('private_notes');
        expect(result.output).toContain('public');
    });
});

describe('execLorebookList — filter at source', () => {
    test('book match → empty output (indistinguishable from empty book)', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' });
        const result = await execLorebookList({ book_name: 'private_notes' }, ctx);
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('entry match narrows entries within a visible book', async () => {
        const ctx = makeContext({ bookPattern: '', entryPattern: '^secret_' });
        const result = await execLorebookList({ book_name: 'public' }, ctx);
        // secret_x (uid=4) filtered; public_x (uid=3) survives.
        expect(result.ok).toBe(true);
        expect(result.output).toContain('uid=3');
        expect(result.output).not.toContain('uid=4');
    });
});

describe('execLorebookSearch — filter at source', () => {
    test('book match drops all entries in that book from grep output', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' });
        const result = await execLorebookSearch({ pattern: '.' }, ctx);
        expect(result.output).not.toContain('PRIVATE1');
        expect(result.output).not.toContain('PRIVATE2');
        expect(result.output).toContain('PUBLIC_X');
    });

    test('entry match drops matching rows from grep output', async () => {
        const ctx = makeContext({ bookPattern: '', entryPattern: '^secret_' });
        const result = await execLorebookSearch({ pattern: '.' }, ctx);
        expect(result.output).not.toContain('SECRET_X');
        expect(result.output).toContain('PUBLIC_X');
    });
});

describe('execLorebookGet — filter at source (throws ToolError LOREBOOK_NOT_FOUND)', () => {
    test('book match on lookup → NOT_FOUND (same shape as genuine miss)', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' });
        await expect(execLorebookGet({ uid: 1, book: 'private_notes' }, ctx))
            .rejects.toMatchObject({ name: 'ToolError', code: 'LOREBOOK_NOT_FOUND' });
    });

    test('entry match on lookup → NOT_FOUND', async () => {
        const ctx = makeContext({ bookPattern: '', entryPattern: '^secret_' });
        await expect(execLorebookGet({ uid: 4 }, ctx))
            .rejects.toMatchObject({ name: 'ToolError', code: 'LOREBOOK_NOT_FOUND' });
    });

    test('entry_key lookup on filtered book → NOT_FOUND', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' });
        await expect(execLorebookGet({ entry_key: 'k1' }, ctx))
            .rejects.toMatchObject({ name: 'ToolError', code: 'LOREBOOK_NOT_FOUND' });
    });

    test('non-filtered entry still resolvable', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' });
        const result = await execLorebookGet({ uid: 3, book: 'public' }, ctx);
        expect(result.book).toBe('public');
        expect(result.content).toBe('PUBLIC_X');
    });
});

describe('execLorebookForceActivate — filter at source', () => {
    test('book match on force_activate → BOOK_NOT_FOUND (same as genuine miss)', async () => {
        const ctx = makeContext({ bookPattern: '^private_notes$', entryPattern: '' }, { withPayload: true });
        await expect(execLorebookForceActivate({ book_name: 'private_notes', uids: [1] }, ctx))
            .rejects.toMatchObject({ name: 'ToolError', code: 'LOREBOOK_FORCE_BOOK_NOT_FOUND' });
    });

    test('entry match on force_activate → skipped as uid_not_found (same reason as genuine miss)', async () => {
        const ctx = makeContext({ bookPattern: '', entryPattern: '^secret_' }, { withPayload: true });
        const result = await execLorebookForceActivate({ book_name: 'public', uids: [3, 4] }, ctx);
        expect(result.ok).toBe(true);
        expect(result.activated.map(a => a.uid)).toEqual([3]);
        expect(result.skipped).toContainEqual({ uid: 4, reason: 'uid_not_found' });
    });

    test('empty filter → no interference with normal activation', async () => {
        const ctx = makeContext({ bookPattern: '', entryPattern: '' }, { withPayload: true });
        const result = await execLorebookForceActivate({ book_name: 'private_notes', uids: [1] }, ctx);
        expect(result.ok).toBe(true);
        expect(result.activated.map(a => a.uid)).toEqual([1]);
    });
});

describe('filter absent from context → all exec functions behave as if unfiltered', () => {
    test('missing __lukerRun → world_book_list returns everything', async () => {
        const ctx = { __getSortedEntriesFn: async () => ENTRIES, __getWorldScopesFn: async () => SCOPES };
        const result = await execWorldBookList({}, ctx);
        expect(result.output).toContain('private_notes');
        expect(result.output).toContain('public');
    });

    test('missing lorebookFilter → lorebook_get resolves normally', async () => {
        const ctx = { __getSortedEntriesFn: async () => ENTRIES, __lukerRun: { activatedEntryKeys: new Set() } };
        const result = await execLorebookGet({ uid: 1 }, ctx);
        expect(result.book).toBe('private_notes');
    });
});
