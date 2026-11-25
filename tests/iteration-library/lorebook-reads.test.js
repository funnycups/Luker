// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Contract of the shared lorebook read executor consumed by the
// orchestrator iter-studio, the memory-graph schema studio, and the CEA
// editor: result shape per tool and the structured failure envelope.

import { afterEach, describe, expect, test } from '@jest/globals';
import {
    LOREBOOK_READ_TOOL_DEFS,
    LOREBOOK_READ_TOOL_NAMES,
    isLorebookReadTool,
    runLorebookReadTool,
} from '../../public/scripts/iteration-library/tools/lorebook-reads.js';
import { STATE_ERROR_REASONS } from '../../public/scripts/lib/state-errors.js';
import { createWorldInfoHarness, worldInfoContext } from './real-worldinfo-context.js';
let harness;
beforeEach(async () => { harness = await createWorldInfoHarness(); });

const BRYN_BOOK = {
    entries: {
        0: {
            uid: 0,
            comment: 'reef-conditions',
            key: ['reef', 'breakers'],
            keysecondary: [],
            content: 'The Bryn reef shifts on a 19-day cycle. Charts older than two weeks are unreliable.',
            order: 100,
            position: 0,
            depth: 4,
            disable: false,
            constant: false,
            selectiveLogic: 0,
        },
        1: {
            uid: 1,
            comment: 'drifters',
            key: ['salt-mark drifters'],
            keysecondary: ['skiff'],
            content: 'Salt-mark drifters travel by skiff and never light fires inland.',
            order: 200,
            position: 1,
            depth: 2,
            disable: true,
            constant: false,
            selectiveLogic: 3,
            excludeRecursion: true,
            delayUntilRecursion: true,
        },
        7: {
            uid: 7,
            comment: '',
            key: ['lantern'],
            keysecondary: [],
            content: 'The harbour lantern burns whale oil; the reef pilots read its colour as a tide warning.',
            order: 50,
            position: 0,
            depth: 4,
            disable: false,
            constant: true,
            selectiveLogic: 0,
        },
    },
};

function makeContext({ books = { 'bryn-headland': BRYN_BOOK }, loadWorldInfo } = {}) {
    const { context } = worldInfoContext(harness, books);
    return {
        characters: [{ avatar: 'ash.png', data: { extensions: { world: 'bryn-headland' } } }],
        characterId: 0,
        chatMetadata: {},
        getWorldInfoNames: () => Object.keys(books),
        loadWorldInfo: loadWorldInfo || context.loadWorldInfo,
    };
}

const savedLuker = globalThis.Luker;
afterEach(() => {
    globalThis.Luker = savedLuker;
});

describe('catalog', () => {
    test('exposes the four short names in catalog order', () => {
        expect(LOREBOOK_READ_TOOL_NAMES).toEqual(['world_book_list', 'lorebook_list', 'lorebook_query', 'lorebook_get']);
        expect(LOREBOOK_READ_TOOL_DEFS.map(d => d.function.name)).toEqual(LOREBOOK_READ_TOOL_NAMES);
        for (const name of LOREBOOK_READ_TOOL_NAMES) expect(isLorebookReadTool(name)).toBe(true);
        expect(isLorebookReadTool('lorebook_update_entry')).toBe(false);
    });
});

describe('world_book_list', () => {
    test('collects character, aux, chat, and global books once each from the passed context, ignoring global Luker', async () => {
        globalThis.Luker = {
            getContext: () => ({
                getCharaFilename: () => 'wrong',
                getCharaAuxWorlds: () => ['wrong-aux'],
                chatWorldInfo: {
                    getNames: () => ['wrong-chat'],
                    globalSelection: ['wrong-global'],
                },
            }),
        };
        const context = {
            ...makeContext(),
            getCharaFilename: (_chid, { manualAvatarKey }) => String(manualAvatarKey).replace(/\.png$/, ''),
            getCharaAuxWorlds: (fileName) => (fileName === 'ash' ? ['bryn-tides', 'bryn-headland'] : []),
            chatWorldInfo: {
                getNames: () => ['harbour-log'],
                globalSelection: ['atlas-of-the-coast', 'bryn-tides'],
            },
        };
        const out = await runLorebookReadTool({ name: 'world_book_list', args: {} }, { context, avatar: 'ash.png' });
        expect(out).toEqual({
            ok: true,
            result: {
                books: ['bryn-headland', 'bryn-tides', 'harbour-log', 'atlas-of-the-coast'],
                sources: {
                    'bryn-headland': 'character',
                    'bryn-tides': 'character_aux',
                    'harbour-log': 'chat',
                    'atlas-of-the-coast': 'global',
                },
            },
        });
    });
});

describe('lorebook_list', () => {
    test('returns compact index rows inside the inclusive uid range', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_list', args: { book_name: 'bryn-headland', range: '0~5' } }, { context: makeContext() });
        expect(out).toEqual({
            ok: true,
            result: {
                book_name: 'bryn-headland',
                total_entries: 3,
                returned_entries: 2,
                range: { start_uid: 0, end_uid: 5 },
                entries: [
                    { uid: 0, name: 'reef-conditions', enabled: true },
                    { uid: 1, name: 'drifters', enabled: false },
                ],
            },
        });
    });

    test('names an uncommented entry by its first key', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_list', args: { book_name: 'bryn-headland' } }, { context: makeContext() });
        expect(out.result.range).toBeNull();
        expect(out.result.entries.find(e => e.uid === 7)).toEqual({ uid: 7, name: 'lantern', enabled: true });
    });

    test('preserves long entry comments without clipping in lorebook_list', async () => {
        const longComment = 'A'.repeat(180);
        const books = {
            'long-book': {
                entries: {
                    0: { uid: 0, comment: longComment, key: ['k'], content: 'body', disable: false },
                },
            },
        };
        const out = await runLorebookReadTool({ name: 'lorebook_list', args: { book_name: 'long-book' } }, { context: makeContext({ books }) });
        expect(out.ok).toBe(true);
        expect(out.result.entries[0].name).toBe(longComment);
    });
});

describe('lorebook_query', () => {
    test('ranks comment + key + content hits above content-only hits', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_query', args: { book_name: 'bryn-headland', text: 'reef' } }, { context: makeContext() });
        expect(out).toEqual({
            ok: true,
            result: {
                book_name: 'bryn-headland',
                total_hits: 2,
                entries: [
                    {
                        uid: 0,
                        comment: 'reef-conditions',
                        key: ['reef', 'breakers'],
                        keysecondary: [],
                        selective_logic: 'AND_ANY',
                        constant: false,
                        enabled: true,
                        match_fields: ['comment', 'key', 'content'],
                        matched_excerpt: 'The Bryn reef shifts on a 19-day cycle. Charts older than two weeks are unreliable.',
                    },
                    {
                        uid: 7,
                        comment: '',
                        key: ['lantern'],
                        keysecondary: [],
                        selective_logic: 'AND_ANY',
                        constant: true,
                        enabled: true,
                        match_fields: ['content'],
                        matched_excerpt: 'The harbour lantern burns whale oil; the reef pilots read its colour as a tide warning.',
                    },
                ],
            },
        });
    });

    test('activation mode only matches keys', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_query', args: { book_name: 'bryn-headland', text: 'reef', search_mode: 'activation' } }, { context: makeContext() });
        expect(out.result.total_hits).toBe(1);
        expect(out.result.entries[0]).toMatchObject({ uid: 0, match_fields: ['key'], matched_excerpt: null });
    });

    test('limit truncates entries but not total_hits', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_query', args: { book_name: 'bryn-headland', text: 'reef', limit: 1 } }, { context: makeContext() });
        expect(out.result.total_hits).toBe(2);
        expect(out.result.entries.map(e => e.uid)).toEqual([0]);
    });

    test('filter-only query returns matching entries without excerpts', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_query', args: { book_name: 'bryn-headland', constant: true } }, { context: makeContext() });
        expect(out.result.entries).toEqual([
            expect.objectContaining({ uid: 7, match_fields: [], matched_excerpt: null }),
        ]);
    });

    test('returns all matches when limit is omitted and honors limits above 20 without an artificial cap', async () => {
        const entries = {};
        for (let i = 0; i < 30; i++) {
            entries[i] = { uid: i, comment: `beacon-${i}`, key: ['beacon'], content: `Signal #${i}`, disable: false };
        }
        const context = makeContext({ books: { 'signal-book': { entries } } });

        const unbounded = await runLorebookReadTool({ name: 'lorebook_query', args: { book_name: 'signal-book', text: 'beacon' } }, { context });
        expect(unbounded.ok).toBe(true);
        expect(unbounded.result.total_hits).toBe(30);
        expect(unbounded.result.entries).toHaveLength(30);

        const explicit25 = await runLorebookReadTool({ name: 'lorebook_query', args: { book_name: 'signal-book', text: 'beacon', limit: 25 } }, { context });
        expect(explicit25.ok).toBe(true);
        expect(explicit25.result.total_hits).toBe(30);
        expect(explicit25.result.entries).toHaveLength(25);
    });
});

describe('lorebook_get', () => {
    test('returns full entries with layout fields and reports missing uids', async () => {
        const out = await runLorebookReadTool({ name: 'lorebook_get', args: { book_name: 'bryn-headland', uids: [1, 9, 1] } }, { context: makeContext() });
        expect(out).toEqual({
            ok: true,
            result: {
                book_name: 'bryn-headland',
                entries: [{
                    uid: 1,
                    comment: 'drifters',
                    key: ['salt-mark drifters'],
                    keysecondary: ['skiff'],
                    selective_logic: 'AND_ALL',
                    constant: false,
                    enabled: false,
                    order: 200,
                    position: 1,
                    depth: 2,
                    exclude_recursion: true,
                    prevent_recursion: false,
                    delay_until_recursion: 1,
                    content: 'Salt-mark drifters travel by skiff and never light fires inland.',
                }],
                missing_uids: [9],
            },
        });
    });

    test('returns more than 10 requested uids without silently capping', async () => {
        const entries = {};
        const uids = [];
        for (let i = 0; i < 15; i++) {
            entries[i] = { uid: i, comment: `entry-${i}`, key: [`k${i}`], content: `body-${i}`, disable: false };
            uids.push(i);
        }
        const out = await runLorebookReadTool(
            { name: 'lorebook_get', args: { book_name: 'big-book', uids } },
            { context: makeContext({ books: { 'big-book': { entries } } }) },
        );
        expect(out.ok).toBe(true);
        expect(out.result.entries).toHaveLength(15);
    });
});

describe('failure envelope', () => {
    const cases = [
        ['query without text or filter', { name: 'lorebook_query', args: { book_name: 'bryn-headland' } }, STATE_ERROR_REASONS.VALIDATION_ARGS],
        ['list without book_name', { name: 'lorebook_list', args: {} }, STATE_ERROR_REASONS.VALIDATION_ARGS],
        ['list of an unknown book', { name: 'lorebook_list', args: { book_name: 'no-such-book' } }, STATE_ERROR_REASONS.VALIDATION_TARGET],
        ['list with a malformed range', { name: 'lorebook_list', args: { book_name: 'bryn-headland', range: 'north' } }, STATE_ERROR_REASONS.VALIDATION_ARGS],
        ['get without uids', { name: 'lorebook_get', args: { book_name: 'bryn-headland', uids: [] } }, STATE_ERROR_REASONS.VALIDATION_ARGS],
    ];
    test.each(cases)('%s → structured reason', async (_label, call, reason) => {
        const out = await runLorebookReadTool(call, { context: makeContext() });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe(reason);
        expect(typeof out.error).toBe('string');
        expect(out.error.length).toBeGreaterThan(0);
    });

    test('a throwing loadWorldInfo becomes TRANSPORT_ERROR', async () => {
        const context = makeContext({ loadWorldInfo: async () => { throw new Error('disk unavailable'); } });
        const out = await runLorebookReadTool({ name: 'lorebook_list', args: { book_name: 'bryn-headland' } }, { context });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe(STATE_ERROR_REASONS.TRANSPORT_ERROR);
    });

    test('loadWorldInfo returning null fails with VALIDATION_TARGET instead of returning an empty book', async () => {
        const context = makeContext({ loadWorldInfo: async () => null });
        const out = await runLorebookReadTool({ name: 'lorebook_list', args: { book_name: 'bryn-headland' } }, { context });
        expect(out.ok).toBe(false);
        expect(out.reason).toBe(STATE_ERROR_REASONS.VALIDATION_TARGET);
        expect(out.error).toContain('bryn-headland');
    });

    test('non-read names and a missing context are rejected', async () => {
        expect((await runLorebookReadTool({ name: 'cea_set_card_field', args: {} }, { context: makeContext() })).ok).toBe(false);
        expect((await runLorebookReadTool({ name: 'lorebook_list', args: { book_name: 'bryn-headland' } }, {})).ok).toBe(false);
    });
});
