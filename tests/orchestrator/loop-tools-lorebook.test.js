/**
 * loop-tools/lorebook tests.
 *
 * Layered against Plan Task 9:
 *
 *   - lorebook.search runs a substring scan over enabled lorebook entries
 *     (content + key list both contribute to the haystack) and excludes
 *     entries already activated this turn so the agent does not waste
 *     rounds rediscovering what main-flow World Info already injected.
 *     The activated set lives at `context.__lukerLoop.activatedEntryKeys`
 *     as a `Set<${world}.${uid}>` populated by the orchestrator's
 *     `onWorldInfoFinalized` hook.
 *   - lorebook.get fetches a specific entry by key. It does NOT dedup
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
} from '../../public/scripts/extensions/orchestrator/loop-tools/lorebook.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeFixture(entries, opts = {}) {
    return {
        __getSortedEntriesFn: async () => entries,
        __lukerLoop: opts.activated
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

describe('execLorebookSearch (Task 9)', () => {
    test('returns matching entries with preview/world/key fields', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await execLorebookSearch({ query: 'autumn', limit: 5 }, ctx);
        expect(result).toHaveProperty('entries');
        expect(result).toHaveProperty('excluded_active_count');
        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toHaveProperty('book');
        expect(result.entries[0]).toHaveProperty('key');
        expect(result.entries[0]).toHaveProperty('preview');
        expect(result.excluded_active_count).toBe(0);
    });

    test('excludes entries already activated for this turn', async () => {
        // Mark the second autumn-related entry as activated; only the first
        // one should appear in results, and excluded_active_count records 1.
        const ctx = makeFixture(SAMPLE_ENTRIES, { activated: ['global.3'] });
        const result = await execLorebookSearch({ query: 'autumn', limit: 5 }, ctx);
        expect(result.excluded_active_count).toBe(1);
        const keys = result.entries.flatMap(e => e.key);
        expect(keys).toContain('autumn');
        expect(keys).not.toContain('autumn-fest');
    });

    test('case-insensitive substring match across content + keys', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await execLorebookSearch({ query: 'CRISP', limit: 5 }, ctx);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].key).toContain('autumn');
    });

    test('respects limit', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await execLorebookSearch({ query: 'autumn', limit: 1 }, ctx);
        expect(result.entries).toHaveLength(1);
    });

    test('throws ToolError when query is empty', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        await expect(execLorebookSearch({ query: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('throws ToolError when query is whitespace only', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        await expect(execLorebookSearch({ query: '   ' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('returns empty entries when nothing matches', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await execLorebookSearch({ query: 'nothing-matches-this' }, ctx);
        expect(result.entries).toEqual([]);
    });

    test('handles missing activatedEntryKeys gracefully', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES); // no activated set in __lukerLoop
        const result = await execLorebookSearch({ query: 'autumn', limit: 5 }, ctx);
        expect(result.entries.length).toBe(2);
        expect(result.excluded_active_count).toBe(0);
    });

    test('preview truncates long content', async () => {
        const longText = 'autumn '.repeat(200);
        const ctx = makeFixture([{ world: 'global', uid: 9, key: ['long'], content: longText }]);
        const result = await execLorebookSearch({ query: 'autumn' }, ctx);
        expect(result.entries[0].preview.length).toBeLessThanOrEqual(500);
    });
});

describe('execLorebookGet (Task 9)', () => {
    test('fetches by key without dedup', async () => {
        // Mark the entry as activated; lorebook.get must still return it.
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

describe('central dispatcher includes lorebook tools (Task 9)', () => {
    test('executeLoopTool dispatches lorebook.search', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await executeLoopTool('lorebook.search', { query: 'autumn' }, ctx);
        expect(result.entries.length).toBeGreaterThan(0);
    });

    test('executeLoopTool dispatches lorebook.get', async () => {
        const ctx = makeFixture(SAMPLE_ENTRIES);
        const result = await executeLoopTool('lorebook.get', { entry_key: 'winter' }, ctx);
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
        expect(names).toEqual(expect.arrayContaining(['lorebook.search', 'lorebook.get']));
    });

    test('getEnabledToolSchemas omits lorebook tools when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: { finalize: true, lorebook: { search: false, get: false } },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('lorebook.search');
        expect(names).not.toContain('lorebook.get');
    });
});

describe('runLoopOrchestration propagates payload.__lukerLoop into tool context (Task 9)', () => {
    test('lorebook.search invoked through the runtime sees activatedEntryKeys from payload', async () => {
        const { runLoopOrchestration } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        const { jest } = await import('@jest/globals');

        // Round 1: agent calls lorebook.search; tool result rides into round 2.
        // Round 2: agent calls finalize. Tool result content carries the
        // dedup-aware result from execLorebookSearch.
        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'lorebook.search', args: { query: 'autumn' } },
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
        // carries `__lukerLoop.activatedEntryKeys` exactly as main.js sets it.
        const fakeEntries = SAMPLE_ENTRIES;
        const context = {
            chat: [],
            __getSortedEntriesFn: async () => fakeEntries,
        };
        const payload = {
            signal: new AbortController().signal,
            coreChat: [],
            __lukerLoop: { activatedEntryKeys: new Set(['global.3']) },
        };

        const result = await runLoopOrchestration(context, payload, profile, { sendLlm });

        expect(result.status).toBe('completed');
        const toolMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(toolMsg).toBeTruthy();
        const parsed = typeof toolMsg.content === 'string' ? JSON.parse(toolMsg.content) : toolMsg.content;
        // Loop runtime wraps successful tool results under `data` when the
        // tool returned a plain object without an `ok` field.
        const payloadShape = Object.prototype.hasOwnProperty.call(parsed, 'ok')
            ? parsed.data || parsed
            : parsed;
        expect(payloadShape.excluded_active_count).toBe(1);
        const keys = (payloadShape.entries || []).flatMap(e => e.key);
        expect(keys).toContain('autumn');
        expect(keys).not.toContain('autumn-fest');
    });
});
