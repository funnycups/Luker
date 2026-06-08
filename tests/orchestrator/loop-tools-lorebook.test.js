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
