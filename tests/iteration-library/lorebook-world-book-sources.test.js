// tests/iteration-library/lorebook-world-book-sources.test.js
import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { lorebookHelpers } from '../../public/scripts/iteration-library/tools/_lorebook-helpers.js';
import { runLorebookReadTool } from '../../public/scripts/iteration-library/tools/lorebook-reads.js';
import { execWorldBookList } from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js';

const CHARACTER = { avatar: 'ash.png', data: { extensions: { world: 'Primary' } } };
const CHAT_METADATA = { world_info: 'ChatBook' };

function makeCtxRoot(overrides = {}) {
    return {
        characters: [CHARACTER],
        characterId: 0,
        chatMetadata: CHAT_METADATA,
        getCharaFilename: (_chid, { manualAvatarKey }) => manualAvatarKey.replace(/\.png$/, ''),
        getCharaAuxWorlds: () => ['Aux', 'Primary'],
        chatWorldInfo: {
            getNames: (meta) => [meta?.world_info, 'Aux'].filter(Boolean),
            globalSelection: ['Global', 'ChatBook'],
        },
        ...overrides,
    };
}

// tests/jest.setup.js installs a global Luker stub; restore it after each
// test that swaps in a context root.
const ORIGINAL_LUKER = globalThis.Luker;

afterEach(() => {
    globalThis.Luker = ORIGINAL_LUKER;
});

describe('lorebookHelpers.collectWorldBookSources', () => {
    test('orders sources by binding strength and keeps the first writer', () => {
        expect(lorebookHelpers.collectWorldBookSources(makeCtxRoot(), CHARACTER, CHAT_METADATA)).toEqual([
            ['Primary', 'character'],
            ['Aux', 'character_aux'],
            ['ChatBook', 'chat'],
            ['Global', 'global'],
        ]);
    });

    test('propagates errors when the aux lookup throws instead of silently dropping books', () => {
        const ctxRoot = makeCtxRoot({ getCharaAuxWorlds: () => { throw new Error('no aux'); } });
        expect(() => lorebookHelpers.collectWorldBookSources(ctxRoot, CHARACTER, CHAT_METADATA)).toThrow('no aux');
    });

    test('passes chatMetadata to getNames and propagates errors when it throws', () => {
        const getNames = jest.fn(() => { throw new Error('metadata unavailable'); });
        const ctxRoot = makeCtxRoot({ chatWorldInfo: { getNames, globalSelection: ['Global'] } });
        expect(() => lorebookHelpers.collectWorldBookSources(ctxRoot, CHARACTER, CHAT_METADATA)).toThrow('metadata unavailable');
        expect(getNames).toHaveBeenCalledWith(CHAT_METADATA);
    });

    test('works without a context root, a character, or an avatar', () => {
        expect(lorebookHelpers.collectWorldBookSources(null, CHARACTER, CHAT_METADATA)).toEqual([['Primary', 'character']]);
        expect(lorebookHelpers.collectWorldBookSources(makeCtxRoot(), null, CHAT_METADATA)).toEqual([
            ['ChatBook', 'chat'],
            ['Aux', 'chat'],
            ['Global', 'global'],
        ]);
        const getCharaAuxWorlds = jest.fn(() => ['Aux']);
        lorebookHelpers.collectWorldBookSources(makeCtxRoot({ getCharaAuxWorlds }), { data: { extensions: { world: 'Primary' } } }, CHAT_METADATA);
        expect(getCharaAuxWorlds).not.toHaveBeenCalled();
    });

    test('normalizeQueryLimit is unbounded by default and preserves explicit positive limits', () => {
        expect(lorebookHelpers.normalizeQueryLimit(undefined)).toBeNull();
        expect(lorebookHelpers.normalizeQueryLimit(50)).toBe(50);
        expect(Number.isInteger(lorebookHelpers.MATCH_EXCERPT_RADIUS)).toBe(true);
    });
});

describe('world book listing consumers', () => {
    test('world_book_list returns books and sources from the passed context without consulting global Luker', async () => {
        delete globalThis.Luker;
        const context = makeCtxRoot();
        const result = await runLorebookReadTool({ name: 'world_book_list', args: {} }, { context });
        expect(result).toEqual({
            ok: true,
            result: {
                books: ['Primary', 'Aux', 'ChatBook', 'Global'],
                sources: { Primary: 'character', Aux: 'character_aux', ChatBook: 'chat', Global: 'global' },
            },
        });
    });

    test('runtime world_book_list tags scopes from the Luker context', async () => {
        globalThis.Luker = { getContext: () => makeCtxRoot() };
        const entries = [
            { world: 'Primary', uid: 1, key: ['reef'], content: 'The western reef.' },
            { world: 'Aux', uid: 2, key: ['buoy'], content: 'The broken buoy.' },
            { world: 'ChatBook', uid: 3, key: ['shoal'], content: 'The second shoal.' },
            { world: 'ChatBook', uid: 4, key: ['lantern'], content: 'The lantern post.' },
            { world: 'Global', uid: 5, key: ['tide'], content: 'Slack water rules.' },
        ];
        const result = await execWorldBookList({}, { __getSortedEntriesFn: async () => entries });
        expect(result.ok).toBe(true);
        expect(result.output.split('\n')).toEqual([
            '[character] Primary (1 entry)',
            '[character_aux] Aux (1 entry)',
            '[chat] ChatBook (2 entries)',
            '[global] Global (1 entry)',
        ]);
    });
});
