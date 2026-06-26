/**
 * lorebook_force_activate tests.
 *
 * The tool mutates the in-flight wiFinalizedPayload that
 * `script.js:7687`'s emit hands every listener. After emit returns,
 * `script.js:7729` calls `joinWorldInfoEntries` on the same array
 * references — so pushes made here land in the main model's
 * <world_info> channel verbatim for THIS turn.
 *
 * Covers:
 *   - before-char position → worldInfoBeforeEntries push
 *   - after-char position → worldInfoAfterEntries push
 *   - at-depth position → worldInfoDepth[matching bucket].entries push,
 *     bucket created if missing
 *   - existing depth bucket (matching depth + role) reused
 *   - disabled entry → skipped with reason
 *   - unknown uid → skipped with reason
 *   - empty content → skipped with reason
 *   - already-activated entry (per __lukerRun.activatedEntryKeys) → skipped
 *   - activatedEntryKeys is updated post-push so subsequent dedups work
 *   - unsupported position (AN-top / AN-bottom / EM-top / EM-bottom) →
 *     skipped with unsupported_position reason (not crash)
 *   - missing book → ToolError LOREBOOK_FORCE_BOOK_NOT_FOUND
 *   - missing book_name arg → ToolError LOREBOOK_FORCE_BOOK_MISSING
 *   - missing uids arg → ToolError LOREBOOK_FORCE_UIDS_MISSING
 *   - missing wiFinalizedPayload on __lukerRun → ToolError LOREBOOK_FORCE_NO_PAYLOAD
 *     (this is the loop-only guard: spec/agenda/director hit this)
 *   - registry: lorebook_force_activate is registered as a write tool and
 *     gated by tools.lorebook.force_activate (default off)
 */

import { describe, test, expect } from '@jest/globals';

import { execLorebookForceActivate } from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook-force-activate.js';
import { getEnabledToolSchemas, getBuiltinToolRegistry } from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

// World Info position enum values (mirror world_info_position from world-info.js).
const POS_BEFORE = 0;
const POS_AFTER = 1;
const POS_AT_DEPTH = 4;
const POS_AN_TOP = 2;

function makeBook(entries) {
    // The production loader returns { entries: { [uid]: entry } }.
    const byUid = {};
    for (const e of entries) byUid[e.uid] = e;
    return { entries: byUid };
}

function makePayload(overrides = {}) {
    return {
        worldInfoBeforeEntries: [],
        worldInfoAfterEntries: [],
        worldInfoDepth: [],
        ...overrides,
    };
}

function makeContext({ book = null, payload = makePayload(), activated = [] } = {}) {
    return {
        __loadWorldInfoFn: async (_name) => book,
        __lukerRun: {
            wiFinalizedPayload: payload,
            activatedEntryKeys: new Set(activated),
        },
    };
}

describe('lorebook_force_activate — position routing', () => {
    test('position=before → pushed to worldInfoBeforeEntries', async () => {
        const book = makeBook([
            { uid: 1, comment: 'Forest lore', content: 'The forest is dense.', position: POS_BEFORE },
        ]);
        const payload = makePayload();
        const ctx = makeContext({ book, payload });
        const result = await execLorebookForceActivate({ book_name: 'world', uids: [1] }, ctx);
        expect(result.ok).toBe(true);
        expect(result.activated).toEqual([
            expect.objectContaining({ uid: 1, comment: 'Forest lore', route: 'before-char' }),
        ]);
        expect(payload.worldInfoBeforeEntries).toEqual(['The forest is dense.']);
        expect(payload.worldInfoAfterEntries).toEqual([]);
    });

    test('position=after → pushed to worldInfoAfterEntries', async () => {
        const book = makeBook([
            { uid: 2, comment: 'Tavern lore', content: 'The tavern is loud.', position: POS_AFTER },
        ]);
        const payload = makePayload();
        const ctx = makeContext({ book, payload });
        await execLorebookForceActivate({ book_name: 'world', uids: [2] }, ctx);
        expect(payload.worldInfoAfterEntries).toEqual(['The tavern is loud.']);
        expect(payload.worldInfoBeforeEntries).toEqual([]);
    });

    test('position=at-depth → creates matching bucket and pushes', async () => {
        const book = makeBook([
            { uid: 3, comment: 'Depth lore', content: 'Whispered.', position: POS_AT_DEPTH, depth: 2, role: 0 },
        ]);
        const payload = makePayload();
        const ctx = makeContext({ book, payload });
        const result = await execLorebookForceActivate({ book_name: 'world', uids: [3] }, ctx);
        expect(result.activated[0].route).toBe('at-depth(d=2,r=0)');
        expect(payload.worldInfoDepth).toEqual([
            { depth: 2, role: 0, entries: ['Whispered.'] },
        ]);
    });

    test('position=at-depth → reuses existing bucket with same depth+role', async () => {
        const book = makeBook([
            { uid: 4, comment: 'A', content: 'A-body', position: POS_AT_DEPTH, depth: 3, role: 1 },
            { uid: 5, comment: 'B', content: 'B-body', position: POS_AT_DEPTH, depth: 3, role: 1 },
        ]);
        const payload = makePayload({
            worldInfoDepth: [{ depth: 3, role: 1, entries: ['existing'] }],
        });
        const ctx = makeContext({ book, payload });
        await execLorebookForceActivate({ book_name: 'world', uids: [4, 5] }, ctx);
        expect(payload.worldInfoDepth).toHaveLength(1);
        expect(payload.worldInfoDepth[0].entries).toEqual(['existing', 'A-body', 'B-body']);
    });

    test('position=at-depth with different role → creates new bucket', async () => {
        const book = makeBook([
            { uid: 6, comment: 'C', content: 'C-body', position: POS_AT_DEPTH, depth: 1, role: 1 },
        ]);
        const payload = makePayload({
            worldInfoDepth: [{ depth: 1, role: 0, entries: ['role0-existing'] }],
        });
        const ctx = makeContext({ book, payload });
        await execLorebookForceActivate({ book_name: 'world', uids: [6] }, ctx);
        expect(payload.worldInfoDepth).toHaveLength(2);
        const role1 = payload.worldInfoDepth.find(b => b.role === 1);
        expect(role1.entries).toEqual(['C-body']);
    });
});

describe('lorebook_force_activate — skip reasons', () => {
    test('unknown uid → skipped with reason', async () => {
        const book = makeBook([{ uid: 1, content: 'x', position: POS_BEFORE }]);
        const ctx = makeContext({ book });
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [99] }, ctx);
        expect(result.activated).toEqual([]);
        expect(result.skipped).toEqual([{ uid: 99, reason: 'uid_not_found' }]);
    });

    test('disabled entry → skipped', async () => {
        const book = makeBook([{ uid: 2, content: 'x', position: POS_BEFORE, disable: true }]);
        const ctx = makeContext({ book });
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [2] }, ctx);
        expect(result.skipped).toEqual([{ uid: 2, reason: 'entry_disabled' }]);
    });

    test('empty content → skipped', async () => {
        const book = makeBook([{ uid: 3, content: '   \n  ', position: POS_BEFORE }]);
        const ctx = makeContext({ book });
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [3] }, ctx);
        expect(result.skipped).toEqual([{ uid: 3, reason: 'empty_content' }]);
    });

    test('already-activated entry → skipped, no double-push', async () => {
        const book = makeBook([{ uid: 4, content: 'already there', position: POS_BEFORE }]);
        const payload = makePayload();
        const ctx = makeContext({ book, payload, activated: ['w.4'] });
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [4] }, ctx);
        expect(result.skipped).toEqual([{ uid: 4, reason: 'already_activated' }]);
        expect(payload.worldInfoBeforeEntries).toEqual([]);
    });

    test('unsupported AN-top position → skipped (does not crash)', async () => {
        const book = makeBook([{ uid: 5, content: 'top', position: POS_AN_TOP }]);
        const ctx = makeContext({ book });
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [5] }, ctx);
        expect(result.skipped[0]).toMatchObject({ uid: 5, reason: expect.stringMatching(/unsupported_position/) });
    });

    test('mixed batch: some activated, some skipped', async () => {
        const book = makeBook([
            { uid: 1, content: 'ok', position: POS_BEFORE },
            { uid: 2, content: 'x', position: POS_BEFORE, disable: true },
        ]);
        const payload = makePayload();
        const ctx = makeContext({ book, payload });
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [1, 2, 3] }, ctx);
        expect(result.activated.map(a => a.uid)).toEqual([1]);
        expect(result.skipped.map(s => s.uid).sort()).toEqual([2, 3]);
    });
});

describe('lorebook_force_activate — activatedEntryKeys tracking', () => {
    test('updates activatedEntryKeys so subsequent dedup sees pushed entry', async () => {
        const book = makeBook([{ uid: 1, content: 'body', position: POS_BEFORE }]);
        const payload = makePayload();
        const ctx = makeContext({ book, payload });
        await execLorebookForceActivate({ book_name: 'mybook', uids: [1] }, ctx);
        expect(ctx.__lukerRun.activatedEntryKeys.has('mybook.1')).toBe(true);
    });

    test('survives missing activatedEntryKeys set (still pushes)', async () => {
        const book = makeBook([{ uid: 1, content: 'body', position: POS_BEFORE }]);
        const payload = makePayload();
        const ctx = {
            __loadWorldInfoFn: async () => book,
            __lukerRun: { wiFinalizedPayload: payload },  // no activatedEntryKeys
        };
        const result = await execLorebookForceActivate({ book_name: 'w', uids: [1] }, ctx);
        expect(result.ok).toBe(true);
        expect(payload.worldInfoBeforeEntries).toEqual(['body']);
    });
});

describe('lorebook_force_activate — input errors', () => {
    test('missing book_name → ToolError BOOK_MISSING', async () => {
        const ctx = makeContext({ book: makeBook([]) });
        await expect(execLorebookForceActivate({ uids: [1] }, ctx)).rejects.toMatchObject({
            code: 'LOREBOOK_FORCE_BOOK_MISSING',
        });
    });

    test('empty uids → ToolError UIDS_MISSING', async () => {
        const ctx = makeContext({ book: makeBook([]) });
        await expect(execLorebookForceActivate({ book_name: 'w', uids: [] }, ctx)).rejects.toMatchObject({
            code: 'LOREBOOK_FORCE_UIDS_MISSING',
        });
    });

    test('non-array uids → ToolError UIDS_MISSING', async () => {
        const ctx = makeContext({ book: makeBook([]) });
        await expect(execLorebookForceActivate({ book_name: 'w', uids: 'oops' }, ctx)).rejects.toMatchObject({
            code: 'LOREBOOK_FORCE_UIDS_MISSING',
        });
    });

    test('book not found → ToolError BOOK_NOT_FOUND', async () => {
        const ctx = { __loadWorldInfoFn: async () => null, __lukerRun: { wiFinalizedPayload: makePayload() } };
        await expect(execLorebookForceActivate({ book_name: 'ghost', uids: [1] }, ctx)).rejects.toMatchObject({
            code: 'LOREBOOK_FORCE_BOOK_NOT_FOUND',
        });
    });

    test('missing wiFinalizedPayload → ToolError NO_PAYLOAD (loop-only guard)', async () => {
        const ctx = { __loadWorldInfoFn: async () => makeBook([{ uid: 1, content: 'x', position: POS_BEFORE }]) };
        await expect(execLorebookForceActivate({ book_name: 'w', uids: [1] }, ctx)).rejects.toMatchObject({
            code: 'LOREBOOK_FORCE_NO_PAYLOAD',
        });
    });

    test('__lukerRun present but no wiFinalizedPayload → ToolError NO_PAYLOAD', async () => {
        const ctx = {
            __loadWorldInfoFn: async () => makeBook([{ uid: 1, content: 'x', position: POS_BEFORE }]),
            __lukerRun: { activatedEntryKeys: new Set() },
        };
        await expect(execLorebookForceActivate({ book_name: 'w', uids: [1] }, ctx)).rejects.toMatchObject({
            code: 'LOREBOOK_FORCE_NO_PAYLOAD',
        });
    });
});

describe('lorebook_force_activate — registry + gating', () => {
    test('is registered as a Layer-1 write tool', () => {
        const reg = getBuiltinToolRegistry();
        const entry = reg.get('lorebook_force_activate');
        expect(entry).toBeTruthy();
        expect(entry.mode).toBe('write');
        expect(typeof entry.exec).toBe('function');
    });

    test('schema is gated by tools.lorebook.force_activate flag', () => {
        // Explicitly off → not emitted.
        const offSchemas = getEnabledToolSchemas({ tools: { lorebook: { force_activate: false } } });
        expect(offSchemas.find(s => s?.function?.name === 'lorebook_force_activate')).toBeUndefined();

        // Flag on → emitted.
        const onSchemas = getEnabledToolSchemas({ tools: { lorebook: { force_activate: true } } });
        expect(onSchemas.find(s => s?.function?.name === 'lorebook_force_activate')).toBeTruthy();
    });
});
