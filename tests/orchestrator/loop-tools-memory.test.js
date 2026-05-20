/**
 * loop-tools/memory tests — five read-api pipeline wrappers:
 *
 *   - memory_list_candidates → listVisibleCandidates(options)
 *   - memory_edge_summary    → getEdgeSummary(id, options)
 *   - memory_node_brief      → getNodeBrief(id, options)
 *   - memory_expand_seeds    → expandFromSeeds(ids, options)
 *   - memory_schema          → getSchema()
 *
 * Tests inject a session stub through `context.__memoryGraphSession` so we
 * never load the real `memory-graph/api.js` (which would transitively
 * pull the build-only `lib.js` chain that Node can't import). When the
 * field is null/undefined we expect a structured `ToolError(MEMORY_DISABLED)`
 * so the agent reads the failure and pivots.
 */

import { describe, test, expect, jest } from '@jest/globals';

import {
    execMemoryListCandidates,
    execMemoryEdgeSummary,
    execMemoryNodeBrief,
    execMemoryExpandSeeds,
    execMemorySchema,
} from '../../public/scripts/extensions/orchestrator/loop-tools/memory.js';
import {
    executeLoopTool,
    getEnabledToolSchemas,
} from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { ToolError } from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

/**
 * Build a stub session object that satisfies the 5 pipeline tools. Tests
 * inject this through `context.__memoryGraphSession` so we never load
 * `memory-graph/api.js` (which would pull the build-only `lib.js` chain
 * into the Node test runtime).
 *
 * Override individual methods per test by spreading: `makeSession({ getSchema: jest.fn() })`.
 */
function makeSession(overrides = {}) {
    return {
        listVisibleCandidates: () => [],
        getEdgeSummary: () => ({ degree: 0, relations: [], sample_neighbors: [] }),
        getNodeBrief: () => null,
        expandFromSeeds: () => [],
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
            __memoryGraphSession: makeSession({
                listVisibleCandidates: () => [
                    { id: 'cand1', type: 'event', level: 'episodic', title: 'x', seqTo: 1, semanticDepth: 0 },
                ],
            }),
        };
        const result = await executeLoopTool('memory.list_candidates', {}, ctx);
        expect(result.candidates[0].id).toBe('cand1');
    });
});

describe('runtime propagates __memoryGraphSession into toolContext', () => {
    test('memory_list_candidates invoked through the runtime sees the session from the upstream context', async () => {
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
            __memoryGraphSession: makeSession({
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
//   - Dispatch: args are routed to the correct session method with the
//     correct option-name translation (snake_case args → camelCase options).
//   - MEMORY_DISABLED: missing session raises a structured ToolError with
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
            __memoryGraphSession: makeSession({ listVisibleCandidates: listFn }),
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

    test('returns { candidates: [] } when session returns nothing', async () => {
        const ctx = {
            __memoryGraphSession: makeSession({ listVisibleCandidates: () => null }),
        };
        const result = await execMemoryListCandidates({}, ctx);
        expect(result).toEqual({ candidates: [] });
    });

    test('throws MEMORY_DISABLED when session missing', async () => {
        const ctx = { __memoryGraphSession: null };
        await expect(execMemoryListCandidates({}, ctx)).rejects.toBeInstanceOf(ToolError);
        await expect(execMemoryListCandidates({}, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryGraphSession: makeSession({
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
            __memoryGraphSession: makeSession({ getEdgeSummary: summaryFn }),
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
        const ctx = { __memoryGraphSession: makeSession() };
        await expect(execMemoryEdgeSummary({ node_id: '' }, ctx)).rejects.toBeInstanceOf(ToolError);
        await expect(execMemoryEdgeSummary({ node_id: '   ' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_ID_EMPTY' });
    });

    test('throws MEMORY_DISABLED when session missing', async () => {
        const ctx = { __memoryGraphSession: null };
        await expect(execMemoryEdgeSummary({ node_id: 'n1' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryGraphSession: makeSession({
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
            __memoryGraphSession: makeSession({ getNodeBrief: briefFn }),
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

    test('returns { brief: null } when session returns null (node missing or archived)', async () => {
        // Production contract: missing/archived nodes surface as `{ brief: null }`,
        // NOT as a thrown error. The brief tool mirrors the read-api's null
        // return so the agent can decide whether to drop the id or retry.
        const ctx = {
            __memoryGraphSession: makeSession({ getNodeBrief: () => null }),
        };
        const result = await execMemoryNodeBrief({ node_id: 'missing' }, ctx);
        expect(result).toEqual({ brief: null });
    });

    test('throws MEMORY_ID_EMPTY on empty node_id', async () => {
        const ctx = { __memoryGraphSession: makeSession() };
        await expect(execMemoryNodeBrief({ node_id: '' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_ID_EMPTY' });
    });

    test('throws MEMORY_DISABLED when session missing', async () => {
        const ctx = { __memoryGraphSession: null };
        await expect(execMemoryNodeBrief({ node_id: 'n1' }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryGraphSession: makeSession({
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
            __memoryGraphSession: makeSession({ expandFromSeeds: expandFn }),
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
        const ctx = { __memoryGraphSession: makeSession() };
        await expect(execMemoryExpandSeeds({}, ctx)).rejects.toMatchObject({ code: 'MEMORY_SEEDS_EMPTY' });
        await expect(execMemoryExpandSeeds({ seed_ids: [] }, ctx)).rejects.toMatchObject({ code: 'MEMORY_SEEDS_EMPTY' });
        await expect(execMemoryExpandSeeds({ seed_ids: ['', '  '] }, ctx)).rejects.toMatchObject({ code: 'MEMORY_SEEDS_EMPTY' });
    });

    test('throws MEMORY_DISABLED when session missing', async () => {
        const ctx = { __memoryGraphSession: null };
        await expect(execMemoryExpandSeeds({ seed_ids: ['x'] }, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryGraphSession: makeSession({
                expandFromSeeds: () => [{ id: 'x', type: 'event', level: 'episodic', title: 'X', seqTo: 1 }],
            }),
        };
        const result = await executeLoopTool('memory_expand_seeds', { seed_ids: ['s'] }, ctx);
        expect(result.nodes[0].id).toBe('x');
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
            __memoryGraphSession: makeSession({ getSchema: schemaFn }),
        };
        const result = await execMemorySchema({}, ctx);
        expect(schemaFn).toHaveBeenCalledTimes(1);
        expect(schemaFn.mock.calls[0]).toHaveLength(0);
        expect(result.schema.types[0].type).toBe('event');
    });

    test('throws MEMORY_DISABLED when session missing', async () => {
        const ctx = { __memoryGraphSession: null };
        await expect(execMemorySchema({}, ctx)).rejects.toMatchObject({ code: 'MEMORY_DISABLED' });
    });

    test('dispatches through executeLoopTool', async () => {
        const ctx = {
            __memoryGraphSession: makeSession({ getSchema: () => ({ types: [{ type: 'character_sheet' }] }) }),
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
    const MEMORY_VERBS = [
        'list_candidates', 'edge_summary', 'node_brief', 'expand_seeds', 'schema',
        'keyword_search', 'vector_search', 'find_by_name', 'compaction_candidates',
        'node_create', 'node_edit', 'node_delete', 'link_upsert', 'link_delete', 'compact_nodes',
    ];
    const MEMORY_TOOL_NAMES = MEMORY_VERBS.map(v => `memory_${v}`);
    const allFlags = (value) => Object.fromEntries(MEMORY_VERBS.map(v => [v, value]));
    const ALL_ON = {
        finalize: true,
        memory: allFlags(true),
    };
    const ALL_OFF = {
        finalize: true,
        memory: allFlags(false),
    };

    test('includes all 15 memory tools when flagged on', () => {
        const schemas = getEnabledToolSchemas({ tools: ALL_ON });
        const names = schemas.map(s => s?.function?.name);
        expect(names).toEqual(expect.arrayContaining(MEMORY_TOOL_NAMES));
    });

    test('omits all 15 memory tools when flagged off', () => {
        const schemas = getEnabledToolSchemas({ tools: ALL_OFF });
        const names = schemas.map(s => s?.function?.name);
        for (const n of MEMORY_TOOL_NAMES) {
            expect(names).not.toContain(n);
        }
    });

    test('per-tool gating: each flag independently controls its tool', () => {
        // Flip exactly one flag on at a time and assert that exactly that
        // tool (plus the always-on finalize) is in the resulting schema set.
        for (const verb of MEMORY_VERBS) {
            const name = `memory_${verb}`;
            const flags = {
                finalize: true,
                memory: { ...allFlags(false), [verb]: true },
            };
            const names = getEnabledToolSchemas({ tools: flags }).map(s => s?.function?.name);
            expect(names).toContain(name);
            for (const otherName of MEMORY_TOOL_NAMES) {
                if (otherName !== name) expect(names).not.toContain(otherName);
            }
        }
    });
});
