/**
 * loop-tools/memory tests.
 *
 * Legacy wrappers (Plan Task 10): thin wrappers over memory-graph's
 * external-api:
 *
 *   - memory_search → searchNodesLexical(store, q, { limit, excludeIds })
 *   - memory_list_recent → listRecentNodes(store, { limit, excludeIds })
 *   - memory_get → getNodeById(store, id, { includeNeighbors: true })
 *
 * Spec 2 (memory_scout uses read-only API): six new wrappers over
 * `memory-graph/read-api.js`:
 *
 *   - memory_list_candidates → listVisibleCandidates(options)
 *   - memory_edge_summary    → getEdgeSummary(id, options)
 *   - memory_node_brief      → getNodeBrief(id, options)
 *   - memory_expand_seeds    → expandFromSeeds(ids, options)
 *   - memory_rank            → rankNodes(options)  [async]
 *   - memory_schema          → getSchema()
 *
 * Dedup contract: legacy search / list calls pass `excludeIds = union(
 * alwaysInjectIds, recallSelectedIds)` so the agent never re-surfaces
 * already-injected nodes. The new pipeline wrappers do NOT apply dedup —
 * recall pipeline correctness depends on seeing the full visible pool,
 * which is exactly what the native route LLM sees.
 *
 * Tests inject the external-api shims through `context.__memoryDeps` and
 * the read-api shim through `context.__memoryReadApi` so we never load
 * the real memory-graph modules (which transitively pull the build-only
 * `lib.js` chain that Node can't import). The store is delivered through
 * `context.__memoryStore`; when null/undefined we expect a structured
 * `ToolError(MEMORY_DISABLED)` so the agent reads the failure and pivots.
 */

import { describe, test, expect, jest } from '@jest/globals';

import {
    execMemorySearch,
    execMemoryListRecent,
    execMemoryGet,
    execMemoryListCandidates,
    execMemoryEdgeSummary,
    execMemoryNodeBrief,
    execMemoryExpandSeeds,
    execMemoryRank,
    execMemorySchema,
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

/**
 * Build a stub read-api object that satisfies the 6 spec-2 pipeline tools.
 * Tests inject this through `context.__memoryReadApi` (see memory.js
 * `pickReadApi`) so we never load `memory-graph/read-api.js` (which would
 * pull the build-only `lib.js` chain into the Node test runtime).
 *
 * Override individual methods per test by spreading: `makeReadApi({ rankNodes: jest.fn() })`.
 */
function makeReadApi(overrides = {}) {
    return {
        listVisibleCandidates: () => [],
        getEdgeSummary: () => ({ degree: 0, relations: [], sample_neighbors: [] }),
        getNodeBrief: () => null,
        expandFromSeeds: () => [],
        rankNodes: async () => [],
        getSchema: () => ({ types: [] }),
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
            __lukerRun: { activatedEntryKeys: new Set() },
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

// ---------------------------------------------------------------------------
// Spec 2: read-api pipeline wrappers
//
// The 6 new wrappers are tested via `context.__memoryReadApi` (the parallel
// hook to `__memoryDeps`). Each wrapper is verified for:
//
//   - Dispatch: args are routed to the correct read-api method with the
//     correct option-name translation (snake_case args → camelCase options).
//   - MEMORY_DISABLED: missing store raises a structured ToolError with
//     code 'MEMORY_DISABLED'.
//   - Arg validation: required args (node_id / seed_ids / query) surface
//     the documented MEMORY_*_EMPTY codes.
//   - Profile flag gating (consolidated below): `getEnabledToolSchemas`
//     turns each tool on/off via `flags.memory.<verb>` where verb is the
//     name after the first underscore (e.g. `list_candidates`,
//     `edge_summary`, `node_brief`, `expand_seeds`, `rank`, `schema`).
// ---------------------------------------------------------------------------

describe('execMemoryListCandidates (spec 2)', () => {
    test('dispatches to listVisibleCandidates and trims candidate previews', async () => {
        const listFn = jest.fn(() => [
            { id: 'n1', type: 'event', level: 'episodic', title: 't1', seqTo: 5, semanticDepth: 0 },
            { id: 'n2', type: 'character_sheet', level: 'semantic', title: 't2', seqTo: 3, semanticDepth: 2 },
        ]);
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ listVisibleCandidates: listFn }),
        };
        const result = await execMemoryListCandidates({
            seq_window: { from: 1, to: 10 },
            types: ['event', 'character_sheet'],
            exclude_recent_messages: 4,
        }, ctx);
        expect(listFn).toHaveBeenCalledTimes(1);
        const opts = listFn.mock.calls[0][0];
        expect(opts.seqWindow).toEqual({ from: 1, to: 10 });
        expect(opts.types).toEqual(['event', 'character_sheet']);
        expect(opts.excludeRecentMessages).toBe(4);
        expect(result.candidates).toHaveLength(2);
        expect(result.candidates[0]).toEqual({
            id: 'n1', type: 'event', level: 'episodic', title: 't1', seqTo: 5, semanticDepth: 0,
        });
        expect(result.candidates[1].level).toBe('semantic');
    });

    test('returns { candidates: [] } when read-api returns nothing', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ listVisibleCandidates: () => null }),
        };
        const result = await execMemoryListCandidates({}, ctx);
        expect(result).toEqual({ candidates: [] });
    });

    test('throws MEMORY_DISABLED when store missing (no __memoryReadApi either)', async () => {
        const ctx = { __memoryStore: null };
        await expect(execMemoryListCandidates({}, ctx)).rejects.toBeInstanceOf(ToolError);
        await expect(execMemoryListCandidates({}, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                listVisibleCandidates: () => [{ id: 'cand1', type: 'event', level: 'episodic', title: 'x', seqTo: 1, semanticDepth: 0 }],
            }),
        };
        const result = await executeLoopTool('memory_list_candidates', {}, ctx);
        expect(result.candidates[0].id).toBe('cand1');
    });
});

describe('execMemoryEdgeSummary (spec 2)', () => {
    test('dispatches node_id + options into getEdgeSummary', async () => {
        const summaryFn = jest.fn(() => ({
            degree: 4,
            relations: [{ relation: 'mentions', direction: 'out', count: 3 }],
            sample_neighbors: [{ id: 'nb1', type: 'event', title: 't' }],
        }));
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ getEdgeSummary: summaryFn }),
        };
        const result = await execMemoryEdgeSummary({
            node_id: 'n42',
            edge_types: ['mentions', 'contains'],
            limit: 12,
        }, ctx);
        expect(summaryFn).toHaveBeenCalledTimes(1);
        expect(summaryFn.mock.calls[0][0]).toBe('n42');
        expect(summaryFn.mock.calls[0][1]).toEqual({ edgeTypes: ['mentions', 'contains'], limit: 12 });
        expect(result.summary.degree).toBe(4);
    });

    test('throws MEMORY_ID_EMPTY on empty node_id', async () => {
        const ctx = { __memoryStore: { nodes: {} }, __memoryReadApi: makeReadApi() };
        await expect(execMemoryEdgeSummary({ node_id: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
        await expect(execMemoryEdgeSummary({ node_id: '   ' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_ID_EMPTY' });
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null };
        await expect(execMemoryEdgeSummary({ node_id: 'n1' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                getEdgeSummary: (_id, _opts) => ({ degree: 1, relations: [], sample_neighbors: [] }),
            }),
        };
        const result = await executeLoopTool('memory_edge_summary', { node_id: 'n9' }, ctx);
        expect(result.summary.degree).toBe(1);
    });
});

describe('execMemoryNodeBrief (spec 2)', () => {
    test('dispatches node_id + options into getNodeBrief', async () => {
        const briefFn = jest.fn(() => ({
            id: 'n7', title: 'Title 7', summary: 'sum',
            keyValues: {}, rowValues: [], childCount: 0,
            exposure: 'full', edgeSummary: { degree: 0, relations: [], sample_neighbors: [] },
            alwaysInject: false,
        }));
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ getNodeBrief: briefFn }),
        };
        const result = await execMemoryNodeBrief({
            node_id: 'n7',
            include_edge_summary: false,
            edge_summary_limit: 16,
        }, ctx);
        expect(briefFn).toHaveBeenCalledTimes(1);
        expect(briefFn.mock.calls[0][0]).toBe('n7');
        expect(briefFn.mock.calls[0][1]).toEqual({ includeEdgeSummary: false, edgeSummaryLimit: 16 });
        expect(result.brief.id).toBe('n7');
    });

    test('returns { brief: null } when read-api returns null (node missing or archived)', async () => {
        // Production contract: missing/archived nodes surface as `{ brief: null }`,
        // NOT as a thrown error. The legacy `memory_get` tool throws MEMORY_NOT_FOUND
        // for missing ids; the spec-2 brief tool deliberately mirrors the read-api's
        // null return so the agent can decide whether to drop the id or retry.
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ getNodeBrief: () => null }),
        };
        const result = await execMemoryNodeBrief({ node_id: 'missing' }, ctx);
        expect(result).toEqual({ brief: null });
    });

    test('throws MEMORY_ID_EMPTY on empty node_id', async () => {
        const ctx = { __memoryStore: { nodes: {} }, __memoryReadApi: makeReadApi() };
        await expect(execMemoryNodeBrief({ node_id: '' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_ID_EMPTY' });
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null };
        await expect(execMemoryNodeBrief({ node_id: 'n1' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                getNodeBrief: id => ({ id, title: 'T', summary: 'S' }),
            }),
        };
        const result = await executeLoopTool('memory_node_brief', { node_id: 'n3' }, ctx);
        expect(result.brief.id).toBe('n3');
    });
});

describe('execMemoryExpandSeeds (spec 2)', () => {
    test('dispatches seed_ids + options into expandFromSeeds', async () => {
        const expandFn = jest.fn(() => [
            { id: 'a', type: 'event', level: 'episodic', title: 'A', seqTo: 7 },
            { id: 'b', type: 'event', level: 'semantic', title: 'B', seqTo: 9 },
        ]);
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ expandFromSeeds: expandFn }),
        };
        const result = await execMemoryExpandSeeds({
            seed_ids: ['s1', '  s2  ', ''],
            hops: 2,
            edge_types: ['mentions'],
            include_children: false,
            exclude_internal: true,
        }, ctx);
        expect(expandFn).toHaveBeenCalledTimes(1);
        // The wrapper trims/filters empty strings out of the seed list.
        expect(expandFn.mock.calls[0][0]).toEqual(['s1', 's2']);
        expect(expandFn.mock.calls[0][1]).toEqual({
            hops: 2,
            edgeTypes: ['mentions'],
            includeChildren: false,
            excludeInternal: true,
        });
        expect(result.nodes).toHaveLength(2);
        expect(result.nodes[0]).toEqual({ id: 'a', type: 'event', level: 'episodic', title: 'A', seqTo: 7 });
        expect(result.nodes[1].level).toBe('semantic');
    });

    test('throws MEMORY_SEEDS_EMPTY when seed_ids missing or all-whitespace', async () => {
        const ctx = { __memoryStore: { nodes: {} }, __memoryReadApi: makeReadApi() };
        await expect(execMemoryExpandSeeds({}, ctx)).rejects.toMatchObject({ code: 'MEMORY_SEEDS_EMPTY' });
        await expect(execMemoryExpandSeeds({ seed_ids: [] }, ctx)).rejects.toMatchObject({ code: 'MEMORY_SEEDS_EMPTY' });
        await expect(execMemoryExpandSeeds({ seed_ids: ['', '  '] }, ctx)).rejects.toMatchObject({ code: 'MEMORY_SEEDS_EMPTY' });
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null };
        await expect(execMemoryExpandSeeds({ seed_ids: ['x'] }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                expandFromSeeds: () => [{ id: 'x', type: 'event', level: 'episodic', title: 'X', seqTo: 1 }],
            }),
        };
        const result = await executeLoopTool('memory_expand_seeds', { seed_ids: ['s'] }, ctx);
        expect(result.nodes[0].id).toBe('x');
    });
});

describe('execMemoryRank (spec 2)', () => {
    test('dispatches query / mode / types / k into rankNodes (async)', async () => {
        const rankFn = jest.fn(async () => [
            { id: 'r1', type: 'event', title: 'T1', seqTo: 9, score: 0.91, scoreMode: 'hybrid' },
            { id: 'r2', type: 'event', title: 'T2', seqTo: 4, score: 0.42, scoreMode: 'hybrid' },
        ]);
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ rankNodes: rankFn }),
        };
        const result = await execMemoryRank({
            query: 'autumn',
            mode: 'hybrid',
            types: ['event'],
            k: 10,
        }, ctx);
        expect(rankFn).toHaveBeenCalledTimes(1);
        expect(rankFn.mock.calls[0][0]).toEqual({
            query: 'autumn', mode: 'hybrid', types: ['event'], k: 10,
        });
        expect(result.ranked).toHaveLength(2);
        expect(result.ranked[0]).toEqual({
            id: 'r1', type: 'event', title: 'T1', seqTo: 9, score: 0.91, scoreMode: 'hybrid',
        });
    });

    test('mode: "recency" is exempt from the empty-query check', async () => {
        // Production contract: vector/keyword/hybrid require a query; recency
        // does not (it ranks by recency alone). Empty query + mode='recency'
        // must NOT throw MEMORY_QUERY_EMPTY.
        const rankFn = jest.fn(async () => []);
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ rankNodes: rankFn }),
        };
        const result = await execMemoryRank({ query: '', mode: 'recency' }, ctx);
        expect(rankFn).toHaveBeenCalledTimes(1);
        expect(rankFn.mock.calls[0][0].mode).toBe('recency');
        expect(result).toEqual({ ranked: [] });
    });

    test('throws MEMORY_QUERY_EMPTY when query empty AND mode != recency', async () => {
        const ctx = { __memoryStore: { nodes: {} }, __memoryReadApi: makeReadApi() };
        await expect(execMemoryRank({ query: '' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_QUERY_EMPTY' });
        await expect(execMemoryRank({ query: '   ', mode: 'hybrid' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_QUERY_EMPTY' });
        await expect(execMemoryRank({ query: '', mode: 'vector' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_QUERY_EMPTY' });
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null };
        await expect(execMemoryRank({ query: 'x' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                rankNodes: async () => [{ id: 'ranked1', type: 'event', title: 'X', seqTo: 1, score: 0.5, scoreMode: 'hybrid' }],
            }),
        };
        const result = await executeLoopTool('memory_rank', { query: 'q' }, ctx);
        expect(result.ranked[0].id).toBe('ranked1');
    });
});

describe('execMemorySchema (spec 2)', () => {
    test('dispatches to getSchema with no args', async () => {
        const schemaFn = jest.fn(() => ({
            types: [
                { type: 'event', tableName: 'Events', tableColumns: ['summary'], requiredColumns: [], primaryKeyColumns: ['id'], forceUpdate: false, alwaysInject: false, editable: true, compressionMode: 'rollup' },
            ],
        }));
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ getSchema: schemaFn }),
        };
        const result = await execMemorySchema({}, ctx);
        expect(schemaFn).toHaveBeenCalledTimes(1);
        expect(schemaFn.mock.calls[0]).toHaveLength(0);
        expect(result.schema.types[0].type).toBe('event');
    });

    test('throws MEMORY_DISABLED when store missing', async () => {
        const ctx = { __memoryStore: null };
        await expect(execMemorySchema({}, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({ getSchema: () => ({ types: [{ type: 'character_sheet' }] }) }),
        };
        const result = await executeLoopTool('memory_schema', {}, ctx);
        expect(result.schema.types[0].type).toBe('character_sheet');
    });
});

describe('getEnabledToolSchemas — read-api pipeline flag gating (spec 2)', () => {
    // Each new tool's profile flag lives at `tools.memory.<verb>` where
    // verb is the schema name after the first underscore. The split logic
    // in `getEnabledToolSchemas` uses indexOf('_'), so
    // memory_list_candidates → memory.list_candidates,
    // memory_edge_summary    → memory.edge_summary, etc.
    const ALL_ON = {
        finalize: true,
        memory: {
            search: false, list_recent: false, get: false,
            list_candidates: true, edge_summary: true, node_brief: true,
            expand_seeds: true, rank: true, schema: true,
        },
    };
    const ALL_OFF = {
        finalize: true,
        memory: {
            search: false, list_recent: false, get: false,
            list_candidates: false, edge_summary: false, node_brief: false,
            expand_seeds: false, rank: false, schema: false,
        },
    };

    test('includes all 6 read-api pipeline tools when flagged on', () => {
        const schemas = getEnabledToolSchemas({ tools: ALL_ON });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toEqual(expect.arrayContaining([
            'memory_list_candidates',
            'memory_edge_summary',
            'memory_node_brief',
            'memory_expand_seeds',
            'memory_rank',
            'memory_schema',
        ]));
    });

    test('omits all 6 read-api pipeline tools when flagged off', () => {
        const schemas = getEnabledToolSchemas({ tools: ALL_OFF });
        const names = schemas.map(s => s?.function?.name);
        for (const n of [
            'memory_list_candidates',
            'memory_edge_summary',
            'memory_node_brief',
            'memory_expand_seeds',
            'memory_rank',
            'memory_schema',
        ]) {
            expect(names).not.toContain(n);
        }
    });

    test('per-tool gating: each flag independently controls its tool', () => {
        // Flip exactly one flag on at a time and assert that exactly that
        // tool (plus the always-on finalize) is in the resulting schema set.
        const verbToName = {
            list_candidates: 'memory_list_candidates',
            edge_summary: 'memory_edge_summary',
            node_brief: 'memory_node_brief',
            expand_seeds: 'memory_expand_seeds',
            rank: 'memory_rank',
            schema: 'memory_schema',
        };
        for (const [verb, name] of Object.entries(verbToName)) {
            const flags = {
                finalize: true,
                memory: {
                    search: false, list_recent: false, get: false,
                    list_candidates: false, edge_summary: false, node_brief: false,
                    expand_seeds: false, rank: false, schema: false,
                    [verb]: true,
                },
            };
            const names = getEnabledToolSchemas({ tools: flags }).map(s => s?.function?.name);
            expect(names).toContain(name);
            for (const otherName of Object.values(verbToName)) {
                if (otherName !== name) expect(names).not.toContain(otherName);
            }
        }
    });
});
