/**
 * loop-tools/memory tests (Plan Task 10).
 *
 * The memory_* tools are thin wrappers over memory-graph's external-api:
 *
 *   - memory_search → searchNodesLexical(store, q, { limit, excludeIds })
 *   - memory_list_recent → listRecentNodes(store, { limit, excludeIds })
 *   - memory_get → getNodeById(store, id, { includeNeighbors: true })
 *
 * Dedup contract: excludeIds must be the union of `alwaysInjectIds` +
 * `recallSelectedIds` from `getCurrentlyInjectedNodeIds(context)` so the
 * agent never re-surfaces nodes already injected into the main model.
 *
 * Tests inject the external-api shims through `context.__memoryDeps` so we
 * don't have to load the real memory-graph module (and therefore avoid the
 * build-only `lib.js` chain). The store is delivered through
 * `context.__memoryStore`; when null/undefined we expect a structured
 * `ToolError(MEMORY_DISABLED)` so the agent reads the failure and pivots.
 */

import { describe, test, expect } from '@jest/globals';

import {
    execMemorySearch,
    execMemoryListRecent,
    execMemoryGet,
} from '../../public/scripts/extensions/orchestrator/loop-tools/memory.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

function makeDeps(overrides = {}) {
    return {
        searchNodesLexical: () => ({ nodes: [] }),
        listRecentNodes: () => ({ nodes: [] }),
        getNodeById: () => null,
        getCurrentlyInjectedNodeIds: () => ({
            alwaysInjectIds: new Set(),
            recallSelectedIds: new Set(),
        }),
        ...overrides,
    };
}

describe('execMemorySearch (Task 10)', () => {
    test('passes query + union(excludeIds) into searchNodesLexical', async () => {
        const calls = [];
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                searchNodesLexical: (store, q, opts) => {
                    calls.push({ store, q, opts });
                    return { nodes: [{ id: 'n1', preview: 'hit' }] };
                },
                getCurrentlyInjectedNodeIds: () => ({
                    alwaysInjectIds: new Set(['a1']),
                    recallSelectedIds: new Set(['r1', 'r2']),
                }),
            }),
        };
        const result = await execMemorySearch({ query: 'autumn', limit: 5 }, ctx);
        expect(result).toEqual({ nodes: [{ id: 'n1', preview: 'hit' }] });
        expect(calls).toHaveLength(1);
        expect(calls[0].q).toBe('autumn');
        expect(calls[0].opts.limit).toBe(5);
        expect(calls[0].opts.excludeIds).toBeInstanceOf(Set);
        expect(Array.from(calls[0].opts.excludeIds).sort()).toEqual(['a1', 'r1', 'r2']);
    });

    test('default limit (5) when omitted', async () => {
        let observedLimit = null;
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                searchNodesLexical: (_store, _q, opts) => {
                    observedLimit = opts.limit;
                    return { nodes: [] };
                },
            }),
        };
        await execMemorySearch({ query: 'x' }, ctx);
        expect(observedLimit).toBe(5);
    });

    test('throws ToolError on empty query', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps(),
        };
        await expect(execMemorySearch({ query: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('throws ToolError on whitespace-only query', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps(),
        };
        await expect(execMemorySearch({ query: '   ' }, ctx)).rejects.toThrow(/non-empty/i);
    });

    test('throws MEMORY_DISABLED when store is null', async () => {
        const ctx = {
            __memoryStore: null,
            __memoryDeps: makeDeps(),
        };
        await expect(execMemorySearch({ query: 'autumn' }, ctx)).rejects.toThrow(/memory-graph not enabled/i);
    });

    test('throws MEMORY_DISABLED when store is undefined (graceful degrade)', async () => {
        const ctx = {
            __memoryDeps: makeDeps(),
        };
        await expect(execMemorySearch({ query: 'autumn' }, ctx)).rejects.toThrow(/memory-graph not enabled/i);
    });
});

describe('execMemoryListRecent (Task 10)', () => {
    test('passes union(excludeIds) into listRecentNodes', async () => {
        let observed = null;
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                listRecentNodes: (_store, opts) => {
                    observed = opts;
                    return { nodes: [{ id: 'n2', preview: 'recent' }] };
                },
                getCurrentlyInjectedNodeIds: () => ({
                    alwaysInjectIds: new Set(['a1']),
                    recallSelectedIds: new Set(['r1']),
                }),
            }),
        };
        const result = await execMemoryListRecent({ limit: 7 }, ctx);
        expect(result.nodes[0].id).toBe('n2');
        expect(observed.limit).toBe(7);
        expect(Array.from(observed.excludeIds).sort()).toEqual(['a1', 'r1']);
    });

    test('default limit (10) when omitted', async () => {
        let observedLimit = null;
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                listRecentNodes: (_store, opts) => {
                    observedLimit = opts.limit;
                    return { nodes: [] };
                },
            }),
        };
        await execMemoryListRecent({}, ctx);
        expect(observedLimit).toBe(10);
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null, __memoryDeps: makeDeps() };
        await expect(execMemoryListRecent({}, ctx)).rejects.toThrow(/memory-graph not enabled/i);
    });
});

describe('execMemoryGet (Task 10)', () => {
    test('passes node_id + includeNeighbors:true into getNodeById', async () => {
        let observed = null;
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                getNodeById: (_store, id, opts) => {
                    observed = { id, opts };
                    return { node: { id }, neighbors: [{ id: 'nb1' }] };
                },
            }),
        };
        const result = await execMemoryGet({ node_id: 'n42' }, ctx);
        expect(result.node.id).toBe('n42');
        expect(result.neighbors).toEqual([{ id: 'nb1' }]);
        expect(observed.id).toBe('n42');
        expect(observed.opts).toEqual({ includeNeighbors: true });
    });

    test('throws ToolError on empty node_id', async () => {
        const ctx = { __memoryStore: { nodes: {} }, __memoryDeps: makeDeps() };
        await expect(execMemoryGet({ node_id: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
    });

    test('throws when node not found (returns null)', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({ getNodeById: () => null }),
        };
        await expect(execMemoryGet({ node_id: 'missing' }, ctx)).rejects.toThrow(/not found/i);
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null, __memoryDeps: makeDeps() };
        await expect(execMemoryGet({ node_id: 'n1' }, ctx)).rejects.toThrow(/memory-graph not enabled/i);
    });
});

describe('central dispatcher includes memory tools (Task 10)', () => {
    test('executeLoopTool dispatches memory_search', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                searchNodesLexical: () => ({ nodes: [{ id: 'n1' }] }),
            }),
        };
        const result = await executeLoopTool('memory_search', { query: 'autumn' }, ctx);
        expect(result.nodes[0].id).toBe('n1');
    });

    test('executeLoopTool dispatches memory_list_recent', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                listRecentNodes: () => ({ nodes: [{ id: 'n2' }] }),
            }),
        };
        const result = await executeLoopTool('memory_list_recent', {}, ctx);
        expect(result.nodes[0].id).toBe('n2');
    });

    test('executeLoopTool dispatches memory_get', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                getNodeById: (_s, id) => ({ node: { id }, neighbors: [] }),
            }),
        };
        const result = await executeLoopTool('memory_get', { node_id: 'n3' }, ctx);
        expect(result.node.id).toBe('n3');
    });

    test('executeLoopTool migrates legacy `memory.search` dotted name to underscore form', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                searchNodesLexical: () => ({ nodes: [{ id: 'legacy' }] }),
            }),
        };
        const result = await executeLoopTool('memory.search', { query: 'autumn' }, ctx);
        expect(result.nodes[0].id).toBe('legacy');
    });

    test('getEnabledToolSchemas includes memory tools when flagged on', () => {
        const schemas = getEnabledToolSchemas({
            tools: {
                finalize: true,
                chat: { read_range: false, search: false },
                lorebook: { search: false, get: false },
                memory: { search: true, list_recent: true, get: true },
                note: { add: false },
            },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toEqual(expect.arrayContaining(['memory_search', 'memory_list_recent', 'memory_get']));
    });

    test('getEnabledToolSchemas omits memory tools when flagged off', () => {
        const schemas = getEnabledToolSchemas({
            tools: { finalize: true, memory: { search: false, list_recent: false, get: false } },
        });
        const names = schemas.map(s => s?.function?.name);
        expect(names).not.toContain('memory_search');
        expect(names).not.toContain('memory_list_recent');
        expect(names).not.toContain('memory_get');
    });
});

describe('runtime propagates __memoryStore / __memoryDeps into toolContext (Task 10)', () => {
    test('memory_search invoked through the runtime sees both fields from the upstream context', async () => {
        const { runLoopOrchestration } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );
        const { jest } = await import('@jest/globals');

        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'memory_search', args: { query: 'recall me' } },
                ],
                assistantText: '',
            }))
            .mockImplementationOnce(async ({ messages }) => {
                secondRoundMessages = messages;
                return {
                    toolCalls: [{ id: 'tc2', name: 'finalize', args: { capsule_text: 'done' } }],
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
                lorebook: { search: false, get: false },
                memory: { search: true, list_recent: false, get: false },
                finalize: true,
            },
            max_rounds: 5,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };

        const context = {
            chat: [],
            __memoryStore: { nodes: {} },
            __memoryDeps: makeDeps({
                searchNodesLexical: () => ({ nodes: [{ id: 'recalled', preview: 'p' }] }),
            }),
        };
        const payload = {
            signal: new AbortController().signal,
            coreChat: [],
            __lukerLoop: { activatedEntryKeys: new Set() },
        };

        const result = await runLoopOrchestration(context, payload, profile, { sendLlm });
        expect(result.status).toBe('completed');

        const toolMsg = (secondRoundMessages || []).find(m => m?.role === 'tool' && m?.tool_call_id === 'tc1');
        expect(toolMsg).toBeTruthy();
        const parsed = typeof toolMsg.content === 'string' ? JSON.parse(toolMsg.content) : toolMsg.content;
        const payloadShape = Object.prototype.hasOwnProperty.call(parsed, 'ok')
            ? parsed.data || parsed
            : parsed;
        expect(payloadShape.nodes[0].id).toBe('recalled');
    });
});
