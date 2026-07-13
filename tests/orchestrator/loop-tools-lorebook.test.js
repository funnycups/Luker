/**
 * loop-tools/lorebook tests.
 *
 * Layered against Plan Task 9 (migrated to regex search in Task 4 of the
 * orchestrator search-tools regex plan):
 *
 *   - lorebook_search runs a regex scan over enabled lorebook entries
 *     (content only — grep-style line-oriented) and excludes entries
 *     already activated this turn so the agent does not waste rounds
 *     rediscovering what main-flow World Info already injected. The
 *     activated set lives at `context.__lukerRun.activatedEntryKeys`
 *     as a `Set<${world}.${uid}>` populated by the orchestrator's
 *     `onWorldInfoFinalized` hook. Output is grep -n style:
 *     `[{book}] {entry_name}:{lineno}: {line_content}`.
 *   - lorebook_get fetches a specific entry by key. It does NOT dedup
 *     against the activated set — the agent may legitimately want to
 *     quote an injected entry verbatim for terminology consistency.
 *   - Both tools surface structured `ToolError`s for empty inputs and
 *     missing entries so the agent reads the failure and self-corrects.
 *   - Production loads entries via `getSortedEntries` from the world-info
 *     bundle (which pulls a build-only `lib.js`); tests inject the
 *     fixture through `context.__getSortedEntriesFn`. The implementation
 *     prefers the injected hook over the dynamic import when available.
 */

import { describe, test, expect } from '@jest/globals';

import {
    execLorebookSearch,
    execLorebookGet,
    execWorldBookList,
    execLorebookList,
} from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeFixture(entries, opts = {}) {
    return {
        __getSortedEntriesFn: async () => entries,
        __lukerRun: opts.activated
            ? { activatedEntryKeys: new Set(opts.activated) }
            : undefined,
    };
}

const SAMPLE_ENTRIES = [
    { world: 'global',    uid: 1, key: ['autumn'],      content: 'Autumn is cold and crisp.' },
    { world: 'global',    uid: 2, key: ['winter'],      content: 'Winter is snowy.' },
    { world: 'global',    uid: 3, key: ['autumn-fest'], content: 'Autumn festival happens yearly.' },
    { world: 'character', uid: 4, key: ['scribe'],      content: 'The scribe records every season.' },
];

describe('execLorebookSearch (regex)', () => {
    test('regex emits grep -n shape with [book] entry-name prefix', async () => {
        const entries = [
            { world: 'main', uid: 1, key: ['张明远'], content: '张明远站在窗边\n手里端着茶杯' },
            { world: 'side', uid: 2, key: ['李府'], content: '李府的庭院冷清' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries, __lukerRun: { activatedEntryKeys: new Set() } };
        const result = await execLorebookSearch({ pattern: '茶杯|庭院' }, ctx);
        expect(result.output).toContain('[main] 张明远:2: 手里端着茶杯');
        expect(result.output).toContain('[side] 李府:1: 李府的庭院冷清');
    });

    test('book filter narrows scan to one book', async () => {
        const entries = [
            { world: 'main', uid: 1, key: ['张'], content: '张三' },
            { world: 'side', uid: 2, key: ['李'], content: '李四' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries, __lukerRun: { activatedEntryKeys: new Set() } };
        const result = await execLorebookSearch({ pattern: '.', book: 'side' }, ctx);
        expect(result.output).toContain('[side]');
        expect(result.output).not.toContain('[main]');
    });

    test('activated entries are excluded (silently dropped from output)', async () => {
        const entries = [
            { world: 'main', uid: 1, key: ['张'], content: '张三' },
            { world: 'main', uid: 2, key: ['李'], content: '李四' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries, __lukerRun: { activatedEntryKeys: new Set(['main.1']) } };
        const result = await execLorebookSearch({ pattern: '.' }, ctx);
        expect(result.output).not.toContain('张');
        expect(result.output).toContain('李');
    });

    test('invalid regex returns ok=false with escape hint', async () => {
        const ctx = { __getSortedEntriesFn: async () => [] };
        const result = await execLorebookSearch({ pattern: '[bad' }, ctx);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/escape regex metacharacters/);
    });

    test('missing pattern argument throws ToolError', async () => {
        const ctx = { __getSortedEntriesFn: async () => [] };
        await expect(execLorebookSearch({}, ctx)).rejects.toThrow(/pattern/i);
    });

    test('throws ToolError when pattern is empty string', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        await expect(execLorebookSearch({ pattern: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('returns ok=true with empty output when no matches', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await execLorebookSearch({ pattern: 'nothing-matches-this' }, ctx);
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('handles missing activatedEntryKeys gracefully', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES); // no activated set in __lukerRun
        const result = await execLorebookSearch({ pattern: 'autumn', flags: 'gmi' }, ctx);
        // Both 'Autumn is cold and crisp.' and 'Autumn festival happens yearly.' should match.
        expect(result.output).toContain('[global] autumn:1: Autumn is cold and crisp.');
        expect(result.output).toContain('[global] autumn-fest:1: Autumn festival happens yearly.');
    });

    test('entry with multiple keys is labelled with keys joined by |', async () => {
        const entries = [
            { world: 'main', uid: 1, key: ['张', '李'], content: 'twokeys' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries, __lukerRun: { activatedEntryKeys: new Set() } };
        const result = await execLorebookSearch({ pattern: 'twokeys' }, ctx);
        expect(result.output).toContain('[main] 张|李:1: twokeys');
    });

    test('entry with no keys falls back to uid:<n> label', async () => {
        const entries = [
            { world: 'main', uid: 7, key: [], content: 'no-keys-here' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries, __lukerRun: { activatedEntryKeys: new Set() } };
        const result = await execLorebookSearch({ pattern: 'no-keys-here' }, ctx);
        expect(result.output).toContain('[main] uid:7:1: no-keys-here');
    });
});

describe('execLorebookGet (Task 9)', () => {
    test('fetches by key without dedup', async () => {
        // Mark the entry as activated; lorebook_get must still return it.
        const ctx = makeFixture(SAMPLE_ENTRIES, { activated: ['global.1'] });
        const result = await execLorebookGet({ entry_key: 'autumn' }, ctx);
        expect(result.book).toBe('global');
        expect(result.content).toBe('Autumn is cold and crisp.');
        expect(result.key).toEqual(['autumn']);
    });

    test('honors optional book filter when more than one entry shares a key', async () => {
        const entries = [
            { world: 'global',    uid: 1, key: ['name'], content: 'global name' },
            { world: 'character', uid: 2, key: ['name'], content: 'character name' },
        ];
        const ctx = makeFixture(entries);
        const result = await execLorebookGet({ entry_key: 'name', book: 'character' }, ctx);
        expect(result.book).toBe('character');
        expect(result.content).toBe('character name');
    });

    test('falls through book filter to first match when omitted', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await execLorebookGet({ entry_key: 'autumn' }, ctx);
        expect(result.book).toBe('global');
    });

    test('throws ToolError when entry_key empty', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        await expect(execLorebookGet({ entry_key: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('throws ToolError when entry_key not found', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        await expect(execLorebookGet({ entry_key: 'nope' }, ctx)).rejects.toThrow(/not found/i);
    });

    test('throws ToolError when book filter excludes every entry', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        await expect(execLorebookGet({ entry_key: 'autumn', book: 'no-such-book' }, ctx))
            .rejects.toThrow(/not found/i);
    });
});

describe('execLorebookGet uid addressing + richer output', () => {
    const FIXTURE = [
        { world: 'global', uid: 1, comment: 'Autumn', key: ['autumn'], content: 'fall lore' },
        { world: 'side',   uid: 2, comment: 'Scribe', key: ['scribe'], content: 'scribe lore' },
    ];

    test('fetches by uid and returns {book, uid, name, key, content}', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const result = await execLorebookGet({ uid: 1 }, ctx);
        expect(result).toEqual({
            book: 'global', uid: 1, name: 'Autumn', key: ['autumn'], content: 'fall lore',
        });
    });

    test('fetches by entry_key and still returns uid + name', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const result = await execLorebookGet({ entry_key: 'scribe' }, ctx);
        expect(result.uid).toBe(2);
        expect(result.name).toBe('Scribe');
        expect(result.content).toBe('scribe lore');
    });

    test('throws ToolError when both uid and entry_key are provided', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        await expect(execLorebookGet({ uid: 1, entry_key: 'autumn' }, ctx))
            .rejects.toThrow(/exactly one of/i);
    });

    test('throws ToolError when neither uid nor entry_key is provided', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        await expect(execLorebookGet({}, ctx)).rejects.toThrow(/exactly one of/i);
    });

    test('uid addressing honors optional book filter', async () => {
        const entries = [
            { world: 'a', uid: 1, comment: 'A', key: ['x'], content: 'in-a' },
            { world: 'b', uid: 1, comment: 'B', key: ['x'], content: 'in-b' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries };
        const result = await execLorebookGet({ uid: 1, book: 'b' }, ctx);
        expect(result.book).toBe('b');
        expect(result.content).toBe('in-b');
    });

    test('throws ToolError when uid not found', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        await expect(execLorebookGet({ uid: 999 }, ctx)).rejects.toThrow(/not found/i);
    });
});

describe('central dispatcher includes lorebook tools (Task 9)', () => {
    test('executeLoopTool dispatches lorebook_search', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await executeLoopTool('lorebook_search', { pattern: 'autumn', flags: 'gmi' }, ctx);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('[global] autumn:1: Autumn is cold and crisp.');
    });

    test('executeLoopTool dispatches lorebook_get', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await executeLoopTool('lorebook_get', { entry_key: 'winter' }, ctx);
        expect(result.content).toBe('Winter is snowy.');
    });

    test('getEnabledToolSchemas includes lorebook tools when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
                lorebook: { search: true, get: true },
                memory: { search: false, list_recent: false, get: false },
                note: { add: false },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toEqual(expect.arrayContaining(['lorebook_search', 'lorebook_get']));
    });

    test('getEnabledToolSchemas omits lorebook tools when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: { finalize: true, lorebook: { search: false, get: false } },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('lorebook_search');
        expect(names).not.toContain('lorebook_get');
    });

    test('executeLoopTool dispatches world_book_list', async () => {
        const entries = [
            { world: 'global', uid: 1, key: ['a'], content: 'x' },
            { world: 'global', uid: 2, key: ['b'], content: 'y' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries };
        const result = await executeLoopTool('world_book_list', {}, ctx);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('[unknown] global (2 entries)');
    });

    test('executeLoopTool dispatches lorebook_list', async () => {
        const entries = [
            { world: 'global', uid: 1, comment: 'A', key: ['a'], content: 'x' },
        ];
        const ctx = { __getSortedEntriesFn: async () => entries };
        const result = await executeLoopTool('lorebook_list', { book_name: 'global' }, ctx);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('uid=1 name=A key=a');
    });

    test('getEnabledToolSchemas includes world_book_list and lorebook_list when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                lorebook: {
                    search: false, get: false,
                    list: true, world_book_list: true,
                },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toEqual(expect.arrayContaining(['world_book_list', 'lorebook_list']));
    });

    test('getEnabledToolSchemas omits world_book_list and lorebook_list when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                lorebook: {
                    search: false, get: false,
                    list: false, world_book_list: false,
                },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('world_book_list');
        expect(names).not.toContain('lorebook_list');
    });
});

describe('execWorldBookList', () => {
    test('emits grep-style line per book with scope tag and entry count', async () => {
        const entries = [
            { world: 'global', uid: 1, key: ['a'], content: 'x' },
            { world: 'global', uid: 2, key: ['b'], content: 'y' },
            { world: 'character', uid: 3, key: ['c'], content: 'z' },
        ];
        const ctx = {
            __getSortedEntriesFn: async () => entries,
            __getWorldScopesFn: async () => ({ global: 'global', character: 'character' }),
        };
        const { execWorldBookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execWorldBookList({}, ctx);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('[global] global (2 entries)');
        expect(result.output).toContain('[character] character (1 entry)');
    });

    test('returns ok=true with empty output when no books visible', async () => {
        const ctx = {
            __getSortedEntriesFn: async () => [],
            __getWorldScopesFn: async () => ({}),
        };
        const { execWorldBookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execWorldBookList({}, ctx);
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('skips entries whose world field is empty', async () => {
        const entries = [
            { world: '', uid: 1, key: ['a'], content: 'x' },
            { world: 'real', uid: 2, key: ['b'], content: 'y' },
        ];
        const ctx = {
            __getSortedEntriesFn: async () => entries,
            __getWorldScopesFn: async () => ({ real: 'chat' }),
        };
        const { execWorldBookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execWorldBookList({}, ctx);
        expect(result.output).toContain('[chat] real (1 entry)');
        expect(result.output).not.toMatch(/\(0 entries?\)|^\[[^\]]*\]\s+\(/m);
    });

    test('falls back to [unknown] per-book when scope map omits the book', async () => {
        const entries = [
            { world: 'orphan', uid: 1, key: ['a'], content: 'x' },
            { world: 'orphan', uid: 2, key: ['b'], content: 'y' },
            { world: 'global', uid: 3, key: ['c'], content: 'z' },
        ];
        const ctx = {
            __getSortedEntriesFn: async () => entries,
            // scope map only knows about 'global'; 'orphan' should fall back.
            __getWorldScopesFn: async () => ({ global: 'global' }),
        };
        const { execWorldBookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execWorldBookList({}, ctx);
        expect(result.output).toContain('[unknown] orphan (2 entries)');
        expect(result.output).toContain('[global] global (1 entry)');
    });
});

describe('execLorebookList', () => {
    const FIXTURE = [
        { world: 'global', uid: 1, comment: 'Autumn',   key: ['autumn'],      content: 'fall lore' },
        { world: 'global', uid: 2, comment: 'Winter',   key: ['winter'],      content: 'snow lore' },
        { world: 'global', uid: 7, comment: 'Festival', key: ['fest', 'jubilee'], content: 'fest lore' },
        { world: 'side',   uid: 3, comment: 'Scribe',   key: ['scribe'],      content: 'scribe lore' },
    ];

    test('emits grep-style index line per entry in the named book', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global' }, ctx);
        expect(result.ok).toBe(true);
        expect(result.output).toContain('[global] uid=1 name=Autumn key=autumn');
        expect(result.output).toContain('[global] uid=2 name=Winter key=winter');
        expect(result.output).toContain('[global] uid=7 name=Festival key=fest|jubilee');
        expect(result.output).not.toContain('[side]');
    });

    test('activated entries are excluded silently', async () => {
        const ctx = {
            __getSortedEntriesFn: async () => FIXTURE,
            __lukerRun: { activatedEntryKeys: new Set(['global.2']) },
        };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global' }, ctx);
        expect(result.output).toContain('uid=1');
        expect(result.output).not.toContain('uid=2');
        expect(result.output).toContain('uid=7');
    });

    test('range "0~5" narrows to inclusive uid window', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global', range: '0~5' }, ctx);
        expect(result.output).toContain('uid=1');
        expect(result.output).toContain('uid=2');
        expect(result.output).not.toContain('uid=7');
    });

    test('range "5~" includes entries with uid >= 5', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global', range: '5~' }, ctx);
        expect(result.output).not.toContain('uid=1');
        expect(result.output).toContain('uid=7');
    });

    test('range "~2" includes entries with uid <= 2', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global', range: '~2' }, ctx);
        expect(result.output).toContain('uid=1');
        expect(result.output).toContain('uid=2');
        expect(result.output).not.toContain('uid=7');
    });

    test('single-uid range "7" narrows to one entry', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global', range: '7' }, ctx);
        expect(result.output).toContain('uid=7');
        expect(result.output).not.toContain('uid=1');
        expect(result.output).not.toContain('uid=2');
    });

    test('throws ToolError when book_name missing', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const { ToolError } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        await expect(execLorebookList({}, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('returns ok=true with empty output when book has no entries', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'no-such-book' }, ctx);
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('entry with no comment falls back to empty name field', async () => {
        const entries = [{ world: 'global', uid: 1, comment: '', key: ['k'], content: 'c' }];
        const ctx = { __getSortedEntriesFn: async () => entries };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result = await execLorebookList({ book_name: 'global' }, ctx);
        expect(result.output).toContain('[global] uid=1 name= key=k');
    });

    test('throws ToolError on malformed range "abc~5"', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const { ToolError } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        await expect(execLorebookList({ book_name: 'global', range: 'abc~5' }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('throws ToolError on reversed range "5~3"', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const { ToolError } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        await expect(execLorebookList({ book_name: 'global', range: '5~3' }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('throws ToolError on fractional range "2.5~7"', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const { ToolError } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        await expect(execLorebookList({ book_name: 'global', range: '2.5~7' }, ctx))
            .rejects.toBeInstanceOf(ToolError);
    });

    test('accepts alternative separators "-" and ".."', async () => {
        const ctx = { __getSortedEntriesFn: async () => FIXTURE };
        const { execLorebookList } = await import(
            '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js'
        );
        const result1 = await execLorebookList({ book_name: 'global', range: '0-5' }, ctx);
        expect(result1.output).toContain('uid=1');
        expect(result1.output).not.toContain('uid=7');
        const result2 = await execLorebookList({ book_name: 'global', range: '0..5' }, ctx);
        expect(result2.output).toContain('uid=1');
        expect(result2.output).not.toContain('uid=7');
    });
});

describe('runLoopOrchestration propagates payload.__lukerRun into tool context (Task 9)', () => {
    test('lorebook_search invoked through the runtime sees activatedEntryKeys from payload', async () => {
        const { runLoopOrchestration } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        const { jest } = await import('@jest/globals');

        // Round 1: agent calls lorebook_search; tool result rides into round 2.
        // Round 2: agent calls finalize. Tool result content carries the
        // dedup-aware result from execLorebookSearch.
        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'lorebook_search', args: { pattern: 'autumn', flags: 'gmi' } },
                ],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                secondRoundMessages = messages;
                return {
                    toolCalls: [
                        { id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } },
                    ],
                    assistantText: '',
                };
            });

        const profile = {
            mode: 'loop',
            apiPresetName: '',
            promptPresetName: '',
            system_prompt: '',
            tools: {
                note: { add: false },
                chat: { read_range: false, search: false },
                lorebook: { search: true, get: true },
                memory: { search: false, list_recent: false, get: false },
                finalize: true,
            },
            max_rounds: 5,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };

        // Top-level context exposes the world-info loader fixture; payload
        // carries `__lukerRun.activatedEntryKeys` exactly as main.js sets it.
        const fakeEntries = SAMPLE_ENTRIES;
        const context = {
            chat: [],
            __getSortedEntriesFn: async () => fakeEntries,
        };
        const payload = {
            signal: new AbortController().signal,
            coreChat: [],
            __lukerRun: { activatedEntryKeys: new Set(['global.3']) },
        };

        const result = await runLoopOrchestration(context, payload, profile, { sendLlm });

        expect(result.status).toBe('completed');
        const toolMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(toolMsg).toBeTruthy();
        const parsed = typeof toolMsg.content === 'string' ? JSON.parse(toolMsg.content) : toolMsg.content;
        // grep-style result: { ok: true, output: '...' }. The 'autumn' entry
        // (uid 1) appears; the activated 'autumn-fest' (uid 3) is excluded.
        expect(parsed.ok).toBe(true);
        expect(parsed.output).toContain('[global] autumn:1: Autumn is cold and crisp.');
        expect(parsed.output).not.toContain('autumn-fest');
    });
});

describe('sanitizeAgentToolFlags lorebook shape', () => {
    test('defaultAllOn=true seeds all 5 lorebook flags on', async () => {
        const { sanitizeAgentToolFlags } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const result = sanitizeAgentToolFlags({}, { defaultAllOn: true });
        expect(result.lorebook).toEqual({
            world_book_list: true,
            list: true,
            search: true,
            get: true,
            force_activate: true,
        });
    });

    test('defaultAllOn=false seeds all 5 lorebook flags off', async () => {
        const { sanitizeAgentToolFlags } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const result = sanitizeAgentToolFlags({}, { defaultAllOn: false });
        expect(result.lorebook).toEqual({
            world_book_list: false,
            list: false,
            search: false,
            get: false,
            force_activate: false,
        });
    });

    test('explicit false on one flag overrides the default-on seed', async () => {
        const { sanitizeAgentToolFlags } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const result = sanitizeAgentToolFlags(
            { lorebook: { list: false } },
            { defaultAllOn: true },
        );
        expect(result.lorebook).toEqual({
            world_book_list: true,
            list: false,
            search: true,
            get: true,
            force_activate: true,
        });
    });

    test('explicit false on force_activate overrides the default-on seed', async () => {
        const { sanitizeAgentToolFlags } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const result = sanitizeAgentToolFlags(
            { lorebook: { force_activate: false } },
            { defaultAllOn: true },
        );
        expect(result.lorebook.force_activate).toBe(false);
    });

    test('sanitizeLoopProfile round-trips all 5 lorebook flags on', async () => {
        const { sanitizeLoopProfile } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const profile = sanitizeLoopProfile({});
        expect(profile.tools.lorebook).toEqual({
            world_book_list: true,
            list: true,
            search: true,
            get: true,
            force_activate: true,
        });
    });

    test('sanitizer accepts explicit toggles on all 5 lorebook flags (iter-studio AI patch path)', async () => {
        const { sanitizeAgentToolFlags } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const result = sanitizeAgentToolFlags(
            { lorebook: { world_book_list: false, list: false, search: false, get: false, force_activate: false } },
            { defaultAllOn: true },
        );
        expect(result.lorebook).toEqual({
            world_book_list: false,
            list: false,
            search: false,
            get: false,
            force_activate: false,
        });
    });
});

describe('applyLoopProfilePatchArgs lorebook merge', () => {
    test('merges world_book_list and list from partial patch', async () => {
        const { applyLoopProfilePatchArgs } = await import(
            '../../public/scripts/extensions/orchestrator/loop-iteration.js'
        );
        const { sanitizeLoopProfile } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const current = sanitizeLoopProfile({});
        const patched = applyLoopProfilePatchArgs(current, {
            tools: { lorebook: { world_book_list: false, list: false } },
        });
        expect(patched.tools.lorebook).toEqual({
            world_book_list: false,
            list: false,
            search: true,
            get: true,
            force_activate: true,
        });
    });

    test('omitted lorebook flags inherit from current profile', async () => {
        const { applyLoopProfilePatchArgs } = await import(
            '../../public/scripts/extensions/orchestrator/loop-iteration.js'
        );
        const { sanitizeLoopProfile } = await import(
            '../../public/scripts/extensions/orchestrator/persistence.js'
        );
        const current = sanitizeLoopProfile({
            tools: { lorebook: { list: false } },
        });
        const patched = applyLoopProfilePatchArgs(current, {
            tools: { lorebook: { get: false } },
        });
        expect(patched.tools.lorebook).toEqual({
            world_book_list: true,
            list: false,
            search: true,
            get: false,
            force_activate: true,
        });
    });
});

describe('disabled entries (entry.disable === true) are invisible to all four discovery tools', () => {
    // Main-flow WI skips entry.disable during activation (world-info.js:8971).
    // The orchestrator's discovery tools must match: user-disabled entries
    // should not surface via lorebook_list / lorebook_search / lorebook_get /
    // world_book_list either. Otherwise the "disable" toggle in the WI panel
    // is a lie for orchestrator agents.
    const ENTRIES = [
        { world: 'BookA', uid: 1, key: ['on1'],  content: 'ALPHA_CONTENT',   comment: 'enabled_entry_1', disable: false },
        { world: 'BookA', uid: 2, key: ['off2'], content: 'BRAVO_CONTENT',   comment: 'disabled_entry_2', disable: true },
        { world: 'BookB', uid: 3, key: ['off3'], content: 'CHARLIE_CONTENT', comment: 'disabled_entry_3', disable: true },
        { world: 'BookB', uid: 4, key: ['on4'],  content: 'DELTA_CONTENT',   comment: 'enabled_entry_4', disable: false },
    ];

    function ctx(extra = {}) {
        return {
            __getSortedEntriesFn: async () => ENTRIES,
            __lukerRun: { activatedEntryKeys: new Set() },
            ...extra,
        };
    }

    test('execLorebookSearch does not surface disabled entry content', async () => {
        const result = await execLorebookSearch({ pattern: '_CONTENT$' }, ctx());
        expect(result.output).toContain('ALPHA_CONTENT');
        expect(result.output).toContain('DELTA_CONTENT');
        expect(result.output).not.toContain('BRAVO_CONTENT');
        expect(result.output).not.toContain('CHARLIE_CONTENT');
    });

    test('execLorebookGet on a disabled entry throws not-found (byte-identical to genuine miss)', async () => {
        await expect(execLorebookGet({ book_name: 'BookA', uid: 2 }, ctx())).rejects.toThrow(ToolError);
        // Enabled sibling still resolvable — proves this isn't over-blocking.
        const ok = await execLorebookGet({ book_name: 'BookA', uid: 1 }, ctx());
        expect(ok.content).toContain('ALPHA_CONTENT');
    });

    test('execLorebookList excludes disabled entries from per-book listing', async () => {
        const result = await execLorebookList({ book_name: 'BookA' }, ctx());
        // Only the enabled entry shows up.
        expect(result.output).toContain('uid=1');
        expect(result.output).not.toContain('uid=2');
    });

    test('execWorldBookList counts only enabled entries per book', async () => {
        // A book whose entries are all disabled must vanish from the list entirely,
        // same shape as a book with zero entries — see design note at lorebook.js:266.
        const allDisabled = [
            { world: 'HiddenBook', uid: 10, key: ['x'], content: 'X', comment: 'x', disable: true },
            { world: 'HiddenBook', uid: 11, key: ['y'], content: 'Y', comment: 'y', disable: true },
        ];
        const result = await execWorldBookList({}, ctx({ __getSortedEntriesFn: async () => [...ENTRIES, ...allDisabled] }));
        // BookA and BookB have 1 enabled entry each; HiddenBook has 0 and must not appear.
        expect(result.output).toContain('BookA (1 ');
        expect(result.output).toContain('BookB (1 ');
        expect(result.output).not.toContain('HiddenBook');
    });
});
