/**
 * loop-tools/memory tests — six read-api pipeline wrappers:
 *
 *   - memory_list_candidates → listVisibleCandidates(options)
 *   - memory_edge_summary    → getEdgeSummary(id, options)
 *   - memory_node_brief      → getNodeBrief(id, options)
 *   - memory_expand_seeds    → expandFromSeeds(ids, options)
 *   - memory_rank            → rankNodes(options)  [async]
 *   - memory_schema          → getSchema()
 *
 * Tests inject the read-api shim through `context.__memoryReadApi` so we
 * never load the real `memory-graph/read-api.js` (which would transitively
 * pull the build-only `lib.js` chain that Node can't import). The store is
 * delivered through `context.__memoryStore`; when null/undefined we expect
 * a structured `ToolError(MEMORY_DISABLED)` so the agent reads the failure
 * and pivots.
 */

import { describe, test, expect, jest } from '@jest/globals';

import {
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

/**
 * Build a stub read-api object that satisfies the 6 pipeline tools. Tests
 * inject this through `context.__memoryReadApi` (see memory.js
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

// ---------------------------------------------------------------------------
// Central dispatcher: dotted-name → underscore migration + runtime wiring
// ---------------------------------------------------------------------------

describe('central dispatcher routes pipeline tools', () => {
    test('executeLoopTool migrates dotted `memory.list_candidates` to underscore form', async () => {
        const ctx = {
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                listVisibleCandidates: () => [
                    { id: 'cand1', type: 'event', level: 'episodic', title: 'x', seqTo: 1, semanticDepth: 0 },
                ],
            }),
        };
        const result = await executeLoopTool('memory.list_candidates', {}, ctx);
        expect(result.candidates[0].id).toBe('cand1');
    });
});

describe('runtime propagates __memoryStore / __memoryReadApi into toolContext', () => {
    test('memory_list_candidates invoked through the runtime sees both fields from the upstream context', async () => {
        const { runLoopOrchestration } = await import(
            '../../public/scripts/extensions/orchestrator/loop-runtime.js'
        );

        let secondRoundMessages = null;
        const sendLlm = jest.fn()
            .mockImplementationOnce(async () => ({
                toolCalls: [
                    { id: 'tc1', name: 'memory_list_candidates', args: {} },
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
                memory: {
                    list_candidates: true,
                    edge_summary: false,
                    node_brief: false,
                    expand_seeds: false,
                    rank: false,
                    schema: false,
                },
                finalize: true,
            },
            max_rounds: 5,
            wall_clock_budget_ms: 60000,
            capsule_inject: { position: 'atDepth', depth: 0, role: 'system', customInstruction: '' },
        };

        const context = {
            chat: [],
            __memoryStore: { nodes: {} },
            __memoryReadApi: makeReadApi({
                listVisibleCandidates: () => [
                    { id: 'recalled', type: 'event', level: 'episodic', title: 'p', seqTo: 1, semanticDepth: 0 },
                ],
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
        expect(payloadShape.candidates[0].id).toBe('recalled');
    });
});

// ---------------------------------------------------------------------------
// Read-api pipeline wrappers (per-tool)
//
// Each wrapper is verified for:
//   - Dispatch: args are routed to the correct read-api method with the
//     correct option-name translation (snake_case args → camelCase options).
//   - MEMORY_DISABLED: missing store raises a structured ToolError with
//     code 'MEMORY_DISABLED'.
//   - Arg validation: required args (node_id / seed_ids / query) surface
//     the documented MEMORY_*_EMPTY codes.
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
        // NOT as a thrown error. The brief tool mirrors the read-api's null
        // return so the agent can decide whether to drop the id or retry.
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
    // Each tool's profile flag lives at `tools.memory.<verb>` where verb is
    // the schema name after the first underscore. The split logic in
    // `getEnabledToolSchemas` uses indexOf('_'), so
    // memory_list_candidates → memory.list_candidates,
    // memory_edge_summary    → memory.edge_summary, etc.
    const ALL_ON = {
        finalize: true,
        memory: {
            list_candidates: true, edge_summary: true, node_brief: true,
            expand_seeds: true, rank: true, schema: true,
        },
    };
    const ALL_OFF = {
        finalize: true,
        memory: {
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
