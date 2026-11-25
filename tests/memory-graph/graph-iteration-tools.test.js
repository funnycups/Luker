/**
 * Unit tests for graph-iteration/tools.js — executors run against a real
 * sandbox store through the real write-api, so these pin the native
 * semantics (latestOnly merge/archive, event auto-titles, seqTo-preserving
 * edits, archive-on-merge) plus the shared error/noop contract.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

let tools;
let getMemoryGraphWriteApi;

beforeAll(async () => {
    tools = await import('../../public/scripts/extensions/memory-graph/graph-iteration/tools.js');
    const writeApiMod = await import('../../public/scripts/extensions/memory-graph/write-api.js');
    getMemoryGraphWriteApi = writeApiMod.getMemoryGraphWriteApi;
});

const SETTINGS = {
    nodeTypeSchema: [
        { id: 'character_sheet', tableColumns: ['title', 'aliases', 'identity'], primaryKeyColumns: ['title', 'aliases'], latestOnly: true },
        { id: 'location_state', tableColumns: ['title', 'state'], primaryKeyColumns: ['title'], latestOnly: true },
        {
            id: 'event',
            tableColumns: ['summary'],
            compression: { mode: 'hierarchical', summarizeInstruction: 'Keep enduring facts in one concise summary.' },
        },
    ],
};

function makeEnv() {
    const store = {
        nodes: {
            n_1: { id: 'n_1', type: 'character_sheet', level: 'semantic', title: 'Seraphina', fields: { title: 'Seraphina', aliases: 'Sera', identity: 'chart officer' }, childrenIds: [], parentId: '', archived: false, seqTo: 2 },
            n_2: { id: 'n_2', type: 'location_state', level: 'semantic', title: 'Bryn headland', fields: { title: 'Bryn headland', state: 'lit' }, childrenIds: [], parentId: '', archived: false, seqTo: 2 },
            n_3: { id: 'n_3', type: 'event', level: 'semantic', title: 'Summary 1', fields: { summary: 'signal lit' }, childrenIds: [], parentId: '', archived: false, seqTo: 1 },
            n_4: { id: 'n_4', type: 'event', level: 'semantic', title: 'archived note', fields: {}, childrenIds: [], parentId: '', archived: true, seqTo: 1 },
        },
        edges: [
            { from: 'n_1', to: 'n_2', type: 'guards' },
            { from: 'n_3', to: 'n_1', type: 'involves' },
        ],
        nodeSeq: 4,
        seqCounter: 2,
    };
    const writeApi = getMemoryGraphWriteApi(store, {}, { settings: SETTINGS });
    return {
        working: store,
        writeApi,
        settings: SETTINGS,
        context: {},
        deps: {
            getEffectiveNodeTypeSchema: () => SETTINGS.nodeTypeSchema,
            readChatRange: async (from, to) => [{ seq: from, role: 'assistant', content: `turn ${from}-${to}` }],
        },
    };
}

const env = () => makeEnv();

describe('reads', () => {
    test('read_fields resolves staged node/link paths and reports missing ones', async () => {
        const e = env();
        const res = await tools.executeGraphReadTool({ name: 'mg_graph_read_fields', args: { paths: ['nodes.n_1.fields.identity', 'nodes.n_1.fields.missing', 'links.n_1␟guards␟n_2.type'] } }, e);
        expect(res['nodes.n_1.fields.identity']).toBe('chart officer');
        expect(res['nodes.n_1.fields.missing']).toBeNull();
        expect(res.missing_paths).toContain('nodes.n_1.fields.missing');
        expect(res['links.n_1␟guards␟n_2.type']).toBe('guards');
    });

    test('list_nodes filters archived by default and supports type filters', async () => {
        const e = env();
        const all = await tools.executeGraphReadTool({ name: 'mg_graph_list_nodes', args: {} }, e);
        expect(all.nodes.map((n) => n.id)).toEqual(['n_3', 'n_1', 'n_2']);
        const events = await tools.executeGraphReadTool({ name: 'mg_graph_list_nodes', args: { types: ['event'], include_archived: true } }, e);
        expect(events.nodes.map((n) => n.id)).toEqual(['n_3', 'n_4']);
    });

    test('search_nodes keyword mode scores title over fields', async () => {
        const e = env();
        const res = await tools.executeGraphReadTool({ name: 'mg_graph_search_nodes', args: { query: 'bryn' } }, e);
        expect(res.matches[0].id).toBe('n_2');
    });

    test('node_detail returns edges with degree and relations', async () => {
        const e = env();
        const res = await tools.executeGraphReadTool({ name: 'mg_graph_node_detail', args: { node_id: 'n_1' } }, e);
        expect(res.node.id).toBe('n_1');
        expect(res.edges.degree).toBe(2);
        expect(res.edges.relations).toEqual(['guards', 'involves']);
    });

    test('neighbors walks edges across hops', async () => {
        const e = env();
        const res = await tools.executeGraphReadTool({ name: 'mg_graph_neighbors', args: { node_id: 'n_2', hops: 2 } }, e);
        const ids = res.neighbors.map((n) => n.id);
        expect(ids).toContain('n_1');
        expect(ids).toContain('n_3');
    });

    test('schema returns the effective type specs including compression metadata', async () => {
        const e = env();
        const res = await tools.executeGraphReadTool({ name: 'mg_graph_schema', args: {} }, e);
        expect(res.types.map((t) => t.id)).toEqual(['character_sheet', 'location_state', 'event']);
        expect(res.types[0].primaryKeyColumns).toEqual(['title', 'aliases']);
        expect(res.types[2].compression).toEqual({
            mode: 'hierarchical',
            summarizeInstruction: 'Keep enduring facts in one concise summary.',
        });
    });

    test('read_chat delegates to the injected range reader', async () => {
        const e = env();
        const res = await tools.executeGraphReadTool({ name: 'mg_graph_read_chat', args: { from_assistant_seq: 2, to_assistant_seq: 3 } }, e);
        expect(res.messages[0].content).toBe('turn 2-3');
    });

    test('unknown read tool throws unknown_tool', async () => {
        await expect(tools.executeGraphReadTool({ name: 'nope', args: {} }, env()))
            .rejects.toThrow(/nope: unknown_tool/);
    });
});

describe('create_node', () => {
    test('latestOnly create merges into the matched node and reports archived losers', async () => {
        const e = env();
        e.working.nodes.n_5 = { id: 'n_5', type: 'character_sheet', level: 'semantic', title: 'Sera', fields: { title: 'Sera', aliases: 'Sera', identity: 'dup' }, childrenIds: [], parentId: '', archived: false, seqTo: 2 };
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_create_node', args: { type: 'character_sheet', title: 'Seraphina', fields: { aliases: 'Sera', identity: 'updated' } } }, e);
        expect(res).toMatchObject({ ok: true, id: 'n_1', action: 'updated' });
        expect(res.archived_losers).toContain('n_5');
        expect(e.working.nodes.n_1.fields.identity).toBe('updated');
        expect(e.working.nodes.n_5.archived).toBe(true);
    });

    test('event create surfaces the auto-generated summary title', async () => {
        const e = env();
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_create_node', args: { type: 'event', title: 'Festival night', fields: { summary: 'lanterns' } } }, e);
        expect(res.action).toBe('created');
        expect(res.title).toMatch(/^Summary \d+$/);
        expect(res.note).toContain('automatic summary title');
    });

    test('create with an off-schema type throws invalid_args', async () => {
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_create_node', args: { type: 'ghost_type', title: 'x' } }, env()))
            .rejects.toThrow(/^mg_graph_create_node: invalid_args — .*ghost_type/);
    });

    test('create with a missing link target throws not_found', async () => {
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_create_node', args: { type: 'event', title: 'x', links: [{ target_node_id: 'ghost', relation: 'involves' }] } }, env()))
            .rejects.toThrow(/^mg_graph_create_node: not_found — .*ghost/);
    });
});

describe('edit_node', () => {
    test('noop edit reports changed:false and preserves seqTo', async () => {
        const e = env();
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_edit_node', args: { node_id: 'n_1', set_fields: { identity: 'chart officer' } } }, e);
        expect(res).toMatchObject({ ok: true, changed: false });
        expect(e.working.nodes.n_1.seqTo).toBe(2);
    });

    test('editing an archived node is refused unless archived:false unlocks it', async () => {
        const e = env();
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_edit_node', args: { node_id: 'n_4', set_fields: { x: 1 } } }, e))
            .rejects.toThrow(/^mg_graph_edit_node: not_allowed — .*n_4/);
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_edit_node', args: { node_id: 'n_4', archived: false, set_fields: { x: 1 } } }, e);
        expect(res.changed).toBe(true);
        expect(e.working.nodes.n_4.archived).toBe(false);
        expect(e.working.nodes.n_4.fields.x).toBe(1);
    });

    test('off-schema type change throws invalid_args', async () => {
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_edit_node', args: { node_id: 'n_1', type: 'ghost' } }, env()))
            .rejects.toThrow(/^mg_graph_edit_node: invalid_args — .*ghost/);
    });

    test('a failed type validation leaves the archived node untouched', async () => {
        const e = env();
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_edit_node', args: { node_id: 'n_4', archived: false, type: 'ghost' } }, e))
            .rejects.toThrow(/^mg_graph_edit_node: invalid_args — .*ghost/);
        expect(e.working.nodes.n_4.archived).toBe(true);
    });
});

describe('delete_node', () => {
    test('refuses to delete a node with children unless recursive', async () => {
        const e = env();
        e.working.nodes.n_2.parentId = 'n_1';
        e.working.nodes.n_1.childrenIds = ['n_2'];
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_delete_node', args: { node_id: 'n_1' } }, e))
            .rejects.toThrow(/^mg_graph_delete_node: not_allowed — .*n_1/);
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_delete_node', args: { node_id: 'n_1', recursive: true } }, e);
        expect(res.removed_nodes).toBe(2);
        expect(e.working.nodes.n_1).toBeUndefined();
        expect(e.working.nodes.n_2).toBeUndefined();
    });
});

describe('merge_nodes', () => {
    test('writes survivor fields and archives losers with edge rewiring', async () => {
        const e = env();
        e.working.edges = [{ from: 'n_2', to: 'n_3', type: 'related' }];
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_merge_nodes', args: { survivor_id: 'n_2', loser_ids: ['n_1'], fields: { state: 'dark' } } }, e);
        expect(res).toMatchObject({ ok: true, changed: true, survivor_id: 'n_2', archived_losers: ['n_1'] });
        expect(e.working.nodes.n_2.fields.state).toBe('dark');
        expect(e.working.nodes.n_1.archived).toBe(true);
        expect(e.working.edges).toEqual([{ from: 'n_2', to: 'n_3', type: 'related' }]);
    });

    test('merging an already-archived loser is an explicit noop', async () => {
        const e = env();
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_merge_nodes', args: { survivor_id: 'n_2', loser_ids: ['n_4'] } }, e);
        expect(res).toMatchObject({ ok: true, changed: false });
        expect(res.note).toContain('already archived');
    });

    test('merge whose supplied fields already match the survivor is an explicit noop', async () => {
        const e = env();
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_merge_nodes', args: { survivor_id: 'n_2', loser_ids: ['n_4'], fields: { state: 'lit' } } }, e);
        expect(res).toMatchObject({ ok: true, changed: false });
        expect(res.note).toContain('already archived');
    });

    test('merge reports changed when a live loser is newly archived even if fields match', async () => {
        const e = env();
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_merge_nodes', args: { survivor_id: 'n_2', loser_ids: ['n_1'], fields: { state: 'lit' } } }, e);
        expect(res).toMatchObject({ ok: true, changed: true, survivor_id: 'n_2', archived_losers: ['n_1'] });
    });

    test('a rejected survivor edit surfaces as a tool error without archiving losers', async () => {
        const e = env();
        e.working.nodes.n_2.level = 'episodic';
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_merge_nodes', args: { survivor_id: 'n_2', loser_ids: ['n_1'], fields: { state: 'dark' } } }, e))
            .rejects.toThrow(/^mg_graph_merge_nodes: not_allowed — .*not a semantic node/);
        expect(e.working.nodes.n_2.fields.state).toBe('lit');
        expect(e.working.nodes.n_1.archived).toBe(false);
    });
});

describe('compact_nodes and rollup guards', () => {
    test('compacts un-parented leaves into a single-summary rollup and surfaces rollup metadata on reads', async () => {
        const e = env();
        e.working.nodes.n_5 = { id: 'n_5', type: 'event', level: 'semantic', title: 'Summary 2', fields: { summary: 'drifters passed north' }, childrenIds: [], parentId: '', archived: false, seqTo: 2 };
        e.working.nodeSeq = 5;

        const res = await tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: {
                type: 'event',
                child_ids: ['n_3', 'n_5', 'n_3'],
                summary: 'Headland signal lit; drifters passed north.',
            },
        }, e);

        expect(res).toMatchObject({
            ok: true,
            changed: true,
            type: 'event',
            semantic_depth: 1,
            child_ids: ['n_3', 'n_5'],
        });
        const rollup = e.working.nodes[res.id];
        expect(rollup.semanticRollup).toBe(true);
        expect(rollup.semanticDepth).toBe(1);
        expect(rollup.fields).toEqual({ summary: 'Headland signal lit; drifters passed north.' });
        expect(rollup.childrenIds).toEqual(['n_3', 'n_5']);
        expect(rollup.seqTo).toBe(2);
        expect(e.working.nodes.n_3.parentId).toBe(res.id);
        expect(e.working.nodes.n_5.parentId).toBe(res.id);
        expect(e.working.edges.filter(edge => edge.from === res.id && edge.type === 'contains')).toHaveLength(2);
        expect(e.working.edges.filter(edge => edge.from === res.id && edge.type === 'semantic_contains')).toHaveLength(2);

        const listed = await tools.executeGraphReadTool({ name: 'mg_graph_list_nodes', args: { types: ['event'] } }, e);
        const listedRollup = listed.nodes.find(n => n.id === res.id);
        const listedChild = listed.nodes.find(n => n.id === 'n_3');
        expect(listedRollup).toMatchObject({ semanticRollup: true, semanticDepth: 1 });
        expect(listedChild.parentId).toBe(res.id);

        const detail = await tools.executeGraphReadTool({ name: 'mg_graph_node_detail', args: { node_id: res.id } }, e);
        expect(detail.node).toMatchObject({ semanticRollup: true, semanticDepth: 1, childrenIds: ['n_3', 'n_5'] });
    });

    test('supports custom title without bumping seqTo and supports non-event types and L2 rollups', async () => {
        const e = env();
        e.working.seqCounter = 9;
        e.working.nodes.n_5 = { id: 'n_5', type: 'location_state', level: 'semantic', title: 'Salt reef', fields: { title: 'Salt reef', state: 'foggy' }, childrenIds: [], parentId: '', archived: false, seqTo: 3 };
        e.working.nodes.n_6 = { id: 'n_6', type: 'location_state', level: 'semantic', title: 'North pier', fields: { title: 'North pier', state: 'quiet' }, childrenIds: [], parentId: '', archived: false, seqTo: 4 };
        e.working.nodeSeq = 6;

        const r1 = await tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: {
                type: 'location_state',
                child_ids: ['n_2', 'n_5'],
                title: 'Coastline Watch',
                summary: 'Headland lit; reef foggy.',
            },
        }, e);
        expect(r1).toMatchObject({ ok: true, title: 'Coastline Watch', semantic_depth: 1 });
        expect(e.working.nodes[r1.id].seqTo).toBe(3);
        expect(e.working.nodes[r1.id].fields).toEqual({ summary: 'Headland lit; reef foggy.' });

        const r2 = await tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: {
                type: 'location_state',
                child_ids: [r1.id, 'n_6'],
                summary: 'Entire northern coast quiet under fog.',
            },
        }, e);
        expect(r2).toMatchObject({ ok: true, semantic_depth: 2 });
        expect(e.working.nodes[r2.id].semanticDepth).toBe(2);
        expect(e.working.nodes[r1.id].parentId).toBe(r2.id);
    });

    test('validates schema type, child existence, archival, type match, and existing parent', async () => {
        const e = env();
        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'ghost_type', child_ids: ['n_3'], summary: 'x' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: invalid_args — .*ghost_type/);

        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'event', child_ids: [], summary: 'x' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: invalid_args/);

        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'event', child_ids: ['n_3'], summary: '   ' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: invalid_args/);

        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'event', child_ids: ['ghost'], summary: 'x' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: not_found — .*ghost/);

        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'event', child_ids: ['n_4'], summary: 'x' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: not_allowed — .*archived/);

        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'event', child_ids: ['n_3', 'n_1'], summary: 'x' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: invalid_args — .*character_sheet/);

        e.working.nodes.n_3.parentId = 'existing_rollup';
        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'event', child_ids: ['n_3'], summary: 'x' },
        }, e)).rejects.toThrow(/^mg_graph_compact_nodes: not_allowed — .*existing_rollup/);
    });

    test('edit_node permits title/summary on rollups and atomically rejects leaf fields or type changes', async () => {
        const e = env();
        const compacted = await tools.executeGraphWriteTool({
            name: 'mg_graph_compact_nodes',
            args: { type: 'location_state', child_ids: ['n_2'], summary: 'Initial rollup summary.' },
        }, e);
        const rollupId = compacted.id;

        const edited = await tools.executeGraphWriteTool({
            name: 'mg_graph_edit_node',
            args: { node_id: rollupId, title: 'Harbor Arc', set_fields: { summary: 'Updated rollup summary.' } },
        }, e);
        expect(edited).toMatchObject({ ok: true, changed: true });
        expect(e.working.nodes[rollupId].title).toBe('Harbor Arc');
        expect(e.working.nodes[rollupId].fields).toEqual({ summary: 'Updated rollup summary.' });

        e.working.nodes[rollupId].archived = true;
        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_edit_node',
            args: { node_id: rollupId, archived: false, set_fields: { state: 'disallowed' } },
        }, e)).rejects.toThrow(/^mg_graph_edit_node: not_allowed — .*only permits editing title or summary/);
        expect(e.working.nodes[rollupId].archived).toBe(true);

        e.working.nodes[rollupId].archived = false;
        await expect(tools.executeGraphWriteTool({
            name: 'mg_graph_edit_node',
            args: { node_id: rollupId, type: 'event' },
        }, e)).rejects.toThrow(/^mg_graph_edit_node: not_allowed — .*cannot change type of rollup/);
        expect(e.working.nodes[rollupId].type).toBe('location_state');
    });
});

describe('links', () => {
    test('upsert_links duplicate → changed:false; new relation → added_edges', async () => {
        const e = env();
        const dup = await tools.executeGraphWriteTool({ name: 'mg_graph_upsert_links', args: { source_node_id: 'n_1', links: [{ target_node_id: 'n_2', relation: 'guards' }] } }, e);
        expect(dup).toMatchObject({ ok: true, changed: false });
        const fresh = await tools.executeGraphWriteTool({ name: 'mg_graph_upsert_links', args: { source_node_id: 'n_1', links: [{ target_node_id: 'n_2', relation: 'watches' }] } }, e);
        expect(fresh).toMatchObject({ ok: true, changed: true, added_edges: 1 });
    });

    test('edit_link rewrites the relation in place', async () => {
        const e = env();
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_edit_link', args: { source_node_id: 'n_1', target_node_id: 'n_2', relation: 'guards', new_relation: 'watches' } }, e);
        expect(res).toMatchObject({ ok: true, changed: true, relation: 'watches' });
        expect(e.working.edges.some((x) => x.type === 'guards')).toBe(false);
        expect(e.working.edges.some((x) => x.type === 'watches' && x.from === 'n_1')).toBe(true);
    });

    test('edit_link on a missing relation throws not_found', async () => {
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_edit_link', args: { source_node_id: 'n_1', target_node_id: 'n_2', relation: 'ghost', new_relation: 'x' } }, env()))
            .rejects.toThrow(/not_found/);
    });

    test('edit_link refuses an archived target without dropping the old edge', async () => {
        const e = env();
        e.working.nodes.n_2.archived = true;
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_edit_link', args: { source_node_id: 'n_1', target_node_id: 'n_2', relation: 'guards', new_relation: 'watches' } }, e))
            .rejects.toThrow(/^mg_graph_edit_link: not_allowed — .*n_2/);
        expect(e.working.edges).toEqual([
            { from: 'n_1', to: 'n_2', type: 'guards' },
            { from: 'n_3', to: 'n_1', type: 'involves' },
        ]);
    });

    test('delete_link outgoing-miss with a reverse edge hints at bidirectional', async () => {
        const e = env();
        e.working.edges = [{ from: 'n_2', to: 'n_1', type: 'guards' }];
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_delete_link', args: { source_node_id: 'n_1', target_node_id: 'n_2', relation: 'guards' } }, e))
            .rejects.toThrow(/direction:"bidirectional"/);
        const res = await tools.executeGraphWriteTool({ name: 'mg_graph_delete_link', args: { source_node_id: 'n_1', target_node_id: 'n_2', relation: 'guards', direction: 'bidirectional' } }, e);
        expect(res.removed).toBe(1);
        expect(e.working.edges).toEqual([]);
    });
});

describe('error contract', () => {
    test('GraphToolError message follows "<tool>: <code> — <detail>" and carries an envelope', () => {
        const err = new tools.GraphToolError('mg_graph_edit_node', 'not_found', 'node x does not exist', 'search first');
        expect(err.message).toBe('mg_graph_edit_node: not_found — node x does not exist');
        expect(err.envelope).toMatchObject({ ok: false, error: 'not_found', detail: 'node x does not exist', hint: 'search first' });
    });

    test('write tools without a loaded graph are refused', async () => {
        await expect(tools.executeGraphWriteTool({ name: 'mg_graph_create_node', args: { type: 'event' } }, { working: null }))
            .rejects.toThrow(/not_allowed/);
    });
});
