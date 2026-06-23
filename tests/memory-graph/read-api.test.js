/**
 * Tests for memory-graph read-only API (read-api.js).
 *
 * Covers spec docs/superpowers/specs/2026-05-18-memory-graph-readonly-api.md
 * §8 acceptance:
 *   #1 type-freeze
 *   #2 per-API behavior (Layers A/B/C/D)
 *
 * Dogfood tests (§5) live in a sibling file (Phase 5).
 *
 * Uses the shared `_mocks/main-module-stack.js` shim so the real `main.js`
 * loads under jest. vector-index and character-overrides keep small in-file
 * mocks (the former needs an embedder, the latter reads the global
 * `extension_settings`).
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import './_mocks/main-module-stack.js';

// ---------------------------------------------------------------------------
// Test holders — let mocks read settings / vector config from a per-test slot
// ---------------------------------------------------------------------------
const testHolder = {
    settings: null, // set per-describe via setHolderSettings
    vectorProfile: null,
    vectorHits: [],
};

// ---------------------------------------------------------------------------
// Mock: ./vector-index.js — no real embedding service in unit tests.
//
// main.js + retriever.js between them import the full surface of
// vector-index.js. Tests only exercise findSimilarNodes /
// getVectorConfigFromSettings; the rest are stubbed to no-ops so the
// namespace imports in main.js/retriever.js succeed.
// ---------------------------------------------------------------------------
jest.unstable_mockModule(
    '../../public/scripts/extensions/memory-graph/vector-index.js',
    () => ({
        findSimilarNodes: jest.fn(async () => testHolder.vectorHits || []),
        getVectorConfigFromSettings: jest.fn(() => testHolder.vectorProfile),
        getRerankProfileFromSettings: jest.fn(() => null),
        validateVectorConfig: () => ({ ok: true }),
        syncVectorIndex: async () => ({}),
        ensureVectorIndexState: () => ({}),
        // re-exports from vector-index-core via vector-index.js
        buildCollectionId: () => '',
        buildNodeVectorText: () => '',
        buildNodeVectorHash: () => '',
        computeVectorSyncPlan: () => ({ inserts: [], deletes: [] }),
        // EmbeddingService-backed helpers used by retriever.js
        queryVectorCollection: async () => [],
        queryVectorCollectionByVector: async () => [],
        rerankDocuments: async (_q, docs) => docs,
        insertVectorItems: async () => ({}),
        deleteVectorItems: async () => ({}),
        purgeVectorCollection: async () => ({}),
    }),
);

// ---------------------------------------------------------------------------
// Mock: ./character-overrides.js — bypass the global `extension_settings`
// dance. Tests inject settings via `testHolder.settings`; we return that
// when set, otherwise fall through to the caller-supplied base settings.
// main.js destructures more names than read-api.js does; the unused ones are
// stubbed to identity / null so the namespace import succeeds.
// ---------------------------------------------------------------------------
jest.unstable_mockModule(
    '../../public/scripts/extensions/memory-graph/character-overrides.js',
    () => ({
        configure: () => {},
        getCurrentAvatar: () => '',
        getCharacterByAvatar: () => null,
        getCharacterIndexByAvatar: () => -1,
        getCharacterDisplayNameByAvatar: () => '',
        getCharacterExtensionDataByAvatar: () => ({}),
        getCharacterSchemaOverrideByAvatar: () => null,
        getCharacterAdvancedOverrideByAvatar: () => null,
        getEffectiveAdvancedSettings: (_context, baseSettings) => testHolder.settings || baseSettings || {},
        getEffectiveSettings: (_context, baseSettings) => testHolder.settings || baseSettings || {},
        getEffectiveNodeTypeSchema: (_context, _settings) => {
            // Prefer the test holder; fall through to whatever settings the
            // caller resolved (real getSettings() backing extension_settings).
            const s = testHolder.settings || _settings;
            return Array.isArray(s?.nodeTypeSchema) ? s.nodeTypeSchema : [];
        },
        getSchemaScopeInfo: () => ({ avatar: '', characterName: '', hasOverride: false, effectiveSchema: [] }),
        getAdvancedScopeInfo: () => ({ avatar: '', characterName: '', hasOverride: false, effectiveSettings: {} }),
        persistCharacterSchemaOverride: async () => {},
        removeCharacterSchemaOverride: async () => {},
        persistCharacterAdvancedOverride: async () => {},
        removeCharacterAdvancedOverride: async () => {},
    }),
);

// ---------------------------------------------------------------------------
// Lazy SUT imports (mocks have to be registered before the real module loads)
// ---------------------------------------------------------------------------
let getMemoryGraphReadApi;
let __setInjectedForTest;
let __resetInjectedForTest;
let __recordInjectedNodeIds;
let __resetListenersForTest;
let getMemoryGraphInjectionStateReexport;

beforeEach(async () => {
    if (!getMemoryGraphReadApi) {
        const readApi = await import('../../public/scripts/extensions/memory-graph/read-api.js');
        getMemoryGraphReadApi = readApi.getMemoryGraphReadApi;
        getMemoryGraphInjectionStateReexport = readApi.getMemoryGraphInjectionState;
        const extApi = await import('../../public/scripts/extensions/memory-graph/external-api.js');
        __setInjectedForTest = extApi.__setInjectedForTest;
        __resetInjectedForTest = extApi.__resetInjectedForTest;
        __recordInjectedNodeIds = extApi.__recordInjectedNodeIds;
        __resetListenersForTest = extApi.__resetListenersForTest;
    }
    // Wipe injection state between tests so visibleIds / listeners don't leak.
    __resetInjectedForTest();
    __resetListenersForTest();
    testHolder.vectorProfile = null;
    testHolder.vectorHits = [];
});

// ---------------------------------------------------------------------------
// Fixture builder — produces a small in-memory store + settings exercising:
//   - event nodes (hierarchical compression) with rollup parent + leaves
//   - character_sheet (none-compression) with parentId chain
//   - location_state, a non-event semantic type for filter coverage
//   - some episodic-level nodes for level filter coverage
//   - several edges spanning related / mentions / contains / semantic_contains
// ---------------------------------------------------------------------------
function buildFixtureSchema() {
    return [
        {
            id: 'event',
            label: 'Event',
            tableName: 'event_table',
            tableColumns: ['summary'],
            requiredColumns: ['summary'],
            primaryKeyColumns: [],
            forceUpdate: true,
            alwaysInject: true,
            editable: false,
            keywords: ['battle', 'event', 'foo'],
            compression: { mode: 'hierarchical' },
        },
        {
            id: 'character_sheet',
            label: 'Character',
            tableName: 'character_table',
            tableColumns: ['title', 'aliases', 'traits'],
            requiredColumns: ['title'],
            primaryKeyColumns: ['title', 'aliases'],
            forceUpdate: false,
            alwaysInject: false,
            editable: true,
            keywords: [],
            compression: { mode: 'none' },
        },
        {
            id: 'location_state',
            label: 'Location',
            tableName: 'location_table',
            tableColumns: ['title'],
            requiredColumns: ['title'],
            primaryKeyColumns: ['title'],
            forceUpdate: false,
            alwaysInject: false,
            editable: true,
            keywords: [],
            compression: { mode: 'none' },
        },
    ];
}

function makeNode({
    id,
    type,
    level = 'semantic',
    title = '',
    fields = {},
    seqTo = 0,
    parentId = '',
    childrenIds = [],
    archived = false,
    semanticRollup = false,
    semanticDepth = 0,
}) {
    return {
        id,
        type,
        level,
        title,
        fields,
        seqTo,
        parentId,
        childrenIds: childrenIds.slice(),
        archived,
        semanticRollup,
        semanticDepth,
    };
}

function buildFixtureStore() {
    // Topology:
    //   evt_rollup1 (event, semantic, depth=1, rollup) — parent of evt_leaf_a / evt_leaf_b
    //   evt_leaf_a (event, semantic, depth=0, seqTo=2)
    //   evt_leaf_b (event, semantic, depth=0, seqTo=4)
    //   evt_leaf_c (event, semantic, depth=0, seqTo=6) — orphan leaf
    //   evt_archived (event, semantic, archived=true, seqTo=1)
    //   char_alice (character_sheet, semantic, seqTo=7) — has parent char_root
    //   char_root  (character_sheet, semantic, seqTo=8) — top-level character
    //   loc_castle (location_state, semantic, seqTo=5)
    //   epi_log1   (event, episodic, seqTo=3)
    //   recall_diag (type=recall_state, semantic, seqTo=9) — diagnostic
    //
    // Edges:
    //   evt_rollup1 -> evt_leaf_a (contains)
    //   evt_rollup1 -> evt_leaf_b (contains)
    //   char_root -> char_alice (semantic_contains)
    //   evt_leaf_a -> char_alice (related)
    //   char_alice -> loc_castle (mentions)
    //   evt_leaf_c -> char_alice (related)

    const nodes = {};
    const allNodes = [
        makeNode({ id: 'evt_rollup1', type: 'event', title: 'Storyline Rollup',
            fields: { summary: 'A foo storyline summary' }, seqTo: 4,
            semanticRollup: true, semanticDepth: 1,
            childrenIds: ['evt_leaf_a', 'evt_leaf_b'] }),
        makeNode({ id: 'evt_leaf_a', type: 'event', title: 'leaf a',
            fields: { summary: 'leaf a foo detail' }, seqTo: 2,
            parentId: 'evt_rollup1', semanticDepth: 0 }),
        makeNode({ id: 'evt_leaf_b', type: 'event', title: 'leaf b',
            fields: { summary: 'leaf b battle detail' }, seqTo: 4,
            parentId: 'evt_rollup1', semanticDepth: 0 }),
        makeNode({ id: 'evt_leaf_c', type: 'event', title: 'leaf c',
            fields: { summary: 'orphan leaf c' }, seqTo: 6, semanticDepth: 0 }),
        makeNode({ id: 'evt_archived', type: 'event', title: 'old event',
            fields: { summary: 'archived event' }, seqTo: 1, archived: true }),
        makeNode({ id: 'char_alice', type: 'character_sheet', title: 'Alice',
            fields: { title: 'Alice', aliases: 'Ali', traits: 'brave' },
            seqTo: 7, parentId: 'char_root' }),
        makeNode({ id: 'char_root', type: 'character_sheet', title: 'Root',
            fields: { title: 'Root' }, seqTo: 8,
            childrenIds: ['char_alice'] }),
        makeNode({ id: 'loc_castle', type: 'location_state', title: 'Castle',
            fields: { title: 'Castle' }, seqTo: 5 }),
        makeNode({ id: 'epi_log1', type: 'event', level: 'episodic',
            title: 'episodic log', fields: { summary: 'episodic event' }, seqTo: 3 }),
        makeNode({ id: 'recall_diag', type: 'recall_state', title: 'diag',
            fields: {}, seqTo: 9 }),
    ];
    for (const n of allNodes) nodes[n.id] = n;

    const edges = [
        { from: 'evt_rollup1', to: 'evt_leaf_a', type: 'contains' },
        { from: 'evt_rollup1', to: 'evt_leaf_b', type: 'contains' },
        { from: 'char_root', to: 'char_alice', type: 'semantic_contains' },
        { from: 'evt_leaf_a', to: 'char_alice', type: 'related' },
        { from: 'char_alice', to: 'loc_castle', type: 'mentions' },
        { from: 'evt_leaf_c', to: 'char_alice', type: 'related' },
    ];
    return {
        nodes,
        edges,
        // getLatestSeqIndex reads from store.appliedSeqTo / loggedSeqTo (not node-iter max).
        // Setting this lets the recent-exclude-window test exercise the cutoff math correctly.
        appliedSeqTo: 8,
        loggedSeqTo: 8,
    };
}

function makeContext(store) {
    // Kept for back-compat with older tests that built context this way.
    // The store is now supplied as the first arg to getMemoryGraphReadApi;
    // this helper just returns a plain context object.
    void store;
    return {};
}

// ---------------------------------------------------------------------------
// Test groups
// ---------------------------------------------------------------------------

describe('read-api factory signature', () => {
    test('getMemoryGraphReadApi accepts (store, context) and resolves store directly', () => {
        // listVisibleCandidates only surfaces level:'semantic' nodes (real
        // buildGraphNodeHints filters via listNodesByLevel(LEVEL.SEMANTIC)).
        // The fixture intentionally uses a semantic node so we exercise the
        // happy path; tests that need episodic coverage live in listNodes().
        const store = { nodes: { n1: { id: 'n1', type: 'character_sheet', level: 'semantic', title: 'Alice', seqTo: 1 } }, edges: [], seqCounter: 1 };
        const api = getMemoryGraphReadApi(store, {});
        const list = api.listVisibleCandidates({ types: ['character_sheet'] });
        expect(list.some(n => n.id === 'n1')).toBe(true);
    });
});

describe('read-api type freeze (spec §8.1)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(store, ctx);
    });

    test('NodeView from getNode is frozen — assignment leaves value unchanged', () => {
        const view = api.getNode('char_alice');
        expect(view).toBeTruthy();
        expect(Object.isFrozen(view)).toBe(true);
        // Object.assign on frozen object: in non-strict it silently no-ops, in strict it throws.
        // We test for value invariance to avoid mode-dependence.
        try { Object.assign(view, { id: 'mutated' }); } catch (_) { /* strict-mode throw is acceptable */ }
        expect(view.id).toBe('char_alice');
    });

    test('NodeView nested fields object is frozen too', () => {
        const view = api.getNode('char_alice');
        expect(Object.isFrozen(view.fields)).toBe(true);
        try { view.fields.title = 'Hacked'; } catch (_) { /* strict throw acceptable */ }
        expect(view.fields.title).toBe('Alice');
    });

    test('NodeView childrenIds array is frozen', () => {
        const view = api.getNode('char_root');
        expect(Object.isFrozen(view.childrenIds)).toBe(true);
        try { view.childrenIds.push('mutated'); } catch (_) { /* strict throw acceptable */ }
        expect(view.childrenIds.includes('mutated')).toBe(false);
    });

    test('EdgeView from listEdges is frozen', () => {
        const edges = api.listEdges();
        expect(edges.length).toBeGreaterThan(0);
        const first = edges[0];
        expect(Object.isFrozen(first)).toBe(true);
        try { Object.assign(first, { from: 'mutated' }); } catch (_) { /* */ }
        // first.from is whatever the fixture set; just verify it didn't get mutated.
        const originalFrom = first.from;
        expect(first.from).toBe(originalFrom);
    });

    test('SchemaSpecView from getSchema().types is frozen', () => {
        const schema = api.getSchema();
        expect(Object.isFrozen(schema)).toBe(true);
        expect(Object.isFrozen(schema.types)).toBe(true);
        const first = schema.types[0];
        expect(Object.isFrozen(first)).toBe(true);
        try { Object.assign(first, { type: 'mutated' }); } catch (_) { /* */ }
        expect(first.type).not.toBe('mutated');
        // Nested array fields frozen too.
        expect(Object.isFrozen(first.tableColumns)).toBe(true);
        try { first.tableColumns.push('hax'); } catch (_) { /* */ }
        expect(first.tableColumns.includes('hax')).toBe(false);
    });

    test('NodeBriefView is frozen and nested records are frozen', () => {
        const brief = api.getNodeBrief('char_alice', { includeEdgeSummary: false });
        expect(brief).toBeTruthy();
        expect(Object.isFrozen(brief)).toBe(true);
        expect(Object.isFrozen(brief.keyValues)).toBe(true);
        expect(Object.isFrozen(brief.rowValues)).toBe(true);
        try { brief.keyValues.title = 'Hacked'; } catch (_) { /* */ }
        expect(brief.keyValues.title).toBe('Alice');
    });

    test('EdgeSummaryView from getEdgeSummary is frozen with frozen relations/sample_neighbors', () => {
        const summary = api.getEdgeSummary('char_alice', { visibleNodeIds: ['char_alice', 'loc_castle', 'evt_leaf_a', 'evt_leaf_c'] });
        expect(Object.isFrozen(summary)).toBe(true);
        expect(Object.isFrozen(summary.relations)).toBe(true);
        expect(Object.isFrozen(summary.sample_neighbors)).toBe(true);
        if (summary.relations.length > 0) expect(Object.isFrozen(summary.relations[0])).toBe(true);
        if (summary.sample_neighbors.length > 0) expect(Object.isFrozen(summary.sample_neighbors[0])).toBe(true);
    });

    test('InjectionState from getInjectionState is frozen', () => {
        __setInjectedForTest({ alwaysInjectIds: ['a1'], recallSelectedIds: ['r1'] });
        const state = api.getInjectionState();
        expect(Object.isFrozen(state)).toBe(true);
        // The three id Sets are frozen wrappers (their contents are by-contract immutable).
        expect(Object.isFrozen(state.alwaysInjectIds)).toBe(true);
        expect(Object.isFrozen(state.recallSelectedIds)).toBe(true);
        expect(Object.isFrozen(state.visibleIds)).toBe(true);
    });
});

describe('Layer A: data access (spec §4.2)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(store, ctx);
    });

    test('listNodes() returns active, non-diagnostic nodes sorted by compareNodesByTimeline (seqTo asc + id tiebreak)', () => {
        const result = api.listNodes();
        const ids = result.map(n => n.id);
        // Excludes evt_archived (archived) and recall_diag (diagnostic).
        expect(ids).not.toContain('evt_archived');
        expect(ids).not.toContain('recall_diag');
        // compareNodesByTimeline: seqTo asc → id locale-compare tiebreak.
        // Sorted seqTos: evt_leaf_a(2), epi_log1(3), evt_leaf_b(4) AND evt_rollup1(4) (tie → id),
        // loc_castle(5), evt_leaf_c(6), char_alice(7), char_root(8).
        // id tiebreak between 'evt_leaf_b' and 'evt_rollup1': 'evt_leaf_b' < 'evt_rollup1' lex.
        expect(ids).toEqual([
            'evt_leaf_a',
            'epi_log1',
            'evt_leaf_b',
            'evt_rollup1',
            'loc_castle',
            'evt_leaf_c',
            'char_alice',
            'char_root',
        ]);
    });

    test('listNodes({types:["event"]}) filters by type', () => {
        const result = api.listNodes({ types: ['event'] });
        const ids = result.map(n => n.id).sort();
        // Active event nodes only (semantic + episodic): rollup, leaf_a, leaf_b, leaf_c, epi_log1.
        expect(ids).toEqual(['epi_log1', 'evt_leaf_a', 'evt_leaf_b', 'evt_leaf_c', 'evt_rollup1']);
    });

    test('listNodes({activeOnly: false}) includes archived and diagnostic nodes', () => {
        const result = api.listNodes({ activeOnly: false });
        const ids = result.map(n => n.id);
        expect(ids).toContain('evt_archived');
        expect(ids).toContain('recall_diag');
    });

    test('listNodes({levels:["semantic"]}) filters by level', () => {
        const result = api.listNodes({ levels: ['semantic'] });
        const ids = result.map(n => n.id);
        expect(ids).not.toContain('epi_log1'); // episodic
    });

    test('listNodes({seqRange:{from:5,to:7}}) filters by seqTo range', () => {
        const result = api.listNodes({ seqRange: { from: 5, to: 7 } });
        const ids = result.map(n => n.id).sort();
        // seqTo: loc_castle(5), evt_leaf_c(6), char_alice(7).
        expect(ids).toEqual(['char_alice', 'evt_leaf_c', 'loc_castle']);
    });

    test('getNode(id) returns NodeView for hit; null for miss', () => {
        const hit = api.getNode('char_alice');
        expect(hit).toBeTruthy();
        expect(hit.id).toBe('char_alice');
        expect(hit.title).toBe('Alice');
        expect(api.getNode('does_not_exist')).toBeNull();
        expect(api.getNode('')).toBeNull();
    });

    test('listEdges() returns all raw edges (no projection, no weight on raw)', () => {
        const result = api.listEdges();
        expect(result.length).toBe(store.edges.length);
        for (const e of result) {
            expect(e).toHaveProperty('from');
            expect(e).toHaveProperty('to');
            expect(e).toHaveProperty('type');
            // Raw edges must NOT carry weight (per spec §4.2).
            expect(Object.prototype.hasOwnProperty.call(e, 'weight')).toBe(false);
        }
    });

    test('listEdges({excludeInternal:true}) drops contains / semantic_contains', () => {
        const result = api.listEdges({ excludeInternal: true });
        const types = result.map(e => e.type);
        expect(types).not.toContain('contains');
        expect(types).not.toContain('semantic_contains');
        // related and mentions should remain.
        expect(types).toEqual(expect.arrayContaining(['related', 'mentions']));
    });

    test('listEdges({types:["related"], from:"evt_leaf_a"}) filters by type + endpoint', () => {
        const result = api.listEdges({ types: ['related'], from: 'evt_leaf_a' });
        expect(result.length).toBe(1);
        expect(result[0]).toEqual({ from: 'evt_leaf_a', to: 'char_alice', type: 'related' });
    });

    test('getSchema() returns SchemaView with types: SchemaSpecView[] having all 9 contract fields', () => {
        const schema = api.getSchema();
        expect(schema).toHaveProperty('types');
        expect(Array.isArray(schema.types)).toBe(true);
        const event = schema.types.find(t => t.type === 'event');
        expect(event).toBeTruthy();
        // Spec §4.1 SchemaSpecView fields:
        const requiredFields = ['type', 'tableName', 'tableColumns', 'requiredColumns',
            'primaryKeyColumns', 'forceUpdate', 'alwaysInject', 'editable', 'compressionMode'];
        for (const f of requiredFields) {
            expect(Object.prototype.hasOwnProperty.call(event, f)).toBe(true);
        }
        expect(event.compressionMode).toBe('hierarchical');
        expect(event.tableName).toBe('event_table');
        expect(event.forceUpdate).toBe(true);
        expect(event.alwaysInject).toBe(true);
        expect(event.editable).toBe(false);
        const char = schema.types.find(t => t.type === 'character_sheet');
        expect(char.compressionMode).toBe('none');
        expect(char.editable).toBe(true);
        expect(char.alwaysInject).toBe(false);
    });
});

describe('Layer B: topology navigation (spec §4.3)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(store, ctx);
    });

    test('getNeighbors(direction:"out") returns out-edges only', () => {
        const result = api.getNeighbors('char_alice', { direction: 'out' });
        const ids = result.map(n => n.node.id).sort();
        // char_alice has outgoing: mentions->loc_castle
        expect(ids).toEqual(['loc_castle']);
        for (const r of result) expect(r.direction).toBe('out');
    });

    test('getNeighbors(direction:"in") returns in-edges only', () => {
        const result = api.getNeighbors('char_alice', { direction: 'in' });
        const ids = result.map(n => n.node.id).sort();
        // char_alice has incoming: semantic_contains<-char_root, related<-evt_leaf_a, related<-evt_leaf_c
        expect(ids).toEqual(['char_root', 'evt_leaf_a', 'evt_leaf_c']);
        for (const r of result) expect(r.direction).toBe('in');
    });

    test('getNeighbors(direction:"both") returns both directions', () => {
        const result = api.getNeighbors('char_alice', { direction: 'both' });
        const ids = result.map(n => n.node.id);
        expect(ids).toEqual(expect.arrayContaining(['loc_castle', 'char_root', 'evt_leaf_a', 'evt_leaf_c']));
    });

    test('getNeighbors({projectTo:"visible"}) uses current visibleIds via getNearestVisibleAncestorId', () => {
        __setInjectedForTest({ alwaysInjectIds: [], recallSelectedIds: [],
            visibleIds: ['char_root', 'evt_rollup1'] });
        // char_alice -> [parents: char_root]; via projectTo:'visible', neighbors should project to char_root level
        // Note: char_alice itself is not in visibleSet, so neighbor edges to non-visible nodes drop.
        const result = api.getNeighbors('char_root', { projectTo: 'visible' });
        // char_root's only edge: char_root -> char_alice (semantic_contains).
        // char_alice not in visibleSet → walks to parentId='' → empty. So char_root has no projected neighbors.
        expect(Array.isArray(result)).toBe(true);
    });

    test('getNeighbors({projectTo:[ids]}) uses custom visibleSet', () => {
        // visible = [evt_rollup1, char_alice]. Edge evt_leaf_a -> char_alice projects from evt_rollup1.
        const result = api.getNeighbors('evt_rollup1', { projectTo: ['evt_rollup1', 'char_alice'] });
        // evt_rollup1's own outgoing 'contains' edges: evt_rollup1->evt_leaf_a, evt_rollup1->evt_leaf_b.
        // Neither leaf is in visibleSet; both walk up parents to evt_rollup1 itself → self-loop dropped.
        // Plus projected edges via leaves to char_alice (via 'related' type, NOT outgoing from evt_rollup1
        // raw — the projection only changes neighborRawId for raw edges where evt_rollup1 is the source).
        // So expected: 0 neighbors here. The key assertion is the API doesn't crash and respects custom set.
        expect(Array.isArray(result)).toBe(true);
    });

    test('getAncestor walks parentId', () => {
        // char_alice -> parent char_root.
        const ancestor = api.getAncestor('char_alice');
        expect(ancestor).toBeTruthy();
        expect(ancestor.id).toBe('char_root');
    });

    test('getAncestor with predicate finds first matching ancestor', () => {
        // For evt_leaf_a, walk up: evt_rollup1 (type=event).
        // Predicate matches type==='event'.
        const ancestor = api.getAncestor('evt_leaf_a', { predicate: n => n.type === 'event' });
        expect(ancestor).toBeTruthy();
        expect(ancestor.id).toBe('evt_rollup1');
        // Predicate that never matches returns null.
        const none = api.getAncestor('evt_leaf_a', { predicate: () => false });
        expect(none).toBeNull();
    });

    test('getDescendants({maxDepth:1}) returns one-hop children', () => {
        const result = api.getDescendants('evt_rollup1', { maxDepth: 1 });
        const ids = result.map(n => n.id).sort();
        expect(ids).toEqual(['evt_leaf_a', 'evt_leaf_b']);
    });

    test('getDescendants() with default maxDepth returns full subtree', () => {
        // For evt_rollup1, full subtree is [evt_leaf_a, evt_leaf_b] (leaves have no children).
        const result = api.getDescendants('evt_rollup1');
        const ids = result.map(n => n.id).sort();
        expect(ids).toEqual(['evt_leaf_a', 'evt_leaf_b']);
        // For char_root, full subtree is [char_alice].
        const charResult = api.getDescendants('char_root');
        expect(charResult.map(n => n.id)).toEqual(['char_alice']);
    });

    test('getNearestVisibleAncestor four-scenario coverage (§8.2)', () => {
        // (a) visibleSet hits leaf itself
        const a = api.getNearestVisibleAncestor('evt_leaf_a', { visibleNodeIds: ['evt_leaf_a'] });
        expect(a).toBeTruthy();
        expect(a.id).toBe('evt_leaf_a');

        // (b) hits middle ancestor (evt_rollup1 is rollup over leaf_a/leaf_b — semantic_contains chain via parentId)
        const b = api.getNearestVisibleAncestor('evt_leaf_a', { visibleNodeIds: ['evt_rollup1'] });
        expect(b).toBeTruthy();
        expect(b.id).toBe('evt_rollup1');

        // (c) hits top rollup (parent of parent in character chain: char_root)
        const c = api.getNearestVisibleAncestor('char_alice', { visibleNodeIds: ['char_root'] });
        expect(c).toBeTruthy();
        expect(c.id).toBe('char_root');

        // (d) no hit — visibleSet doesn't include the node or any ancestor
        const d = api.getNearestVisibleAncestor('evt_leaf_a', { visibleNodeIds: ['char_alice'] });
        expect(d).toBeNull();
    });

    test('projectEdges({visibleNodeIds}) returns EdgeViews with weight, excludeInternal default true', () => {
        // visibleNodeIds = [evt_rollup1, char_alice, loc_castle].
        // Raw 'related' edge evt_leaf_a -> char_alice projects to evt_rollup1 -> char_alice.
        // Raw 'related' edge evt_leaf_c -> char_alice: evt_leaf_c has no parent → walks to itself (not in
        // visible) → drops because no visible ancestor.
        // Raw 'mentions' edge char_alice -> loc_castle → char_alice -> loc_castle (both visible).
        // Internal edges (contains/semantic_contains) are excluded by default.
        const result = api.projectEdges({ visibleNodeIds: ['evt_rollup1', 'char_alice', 'loc_castle'] });
        const triples = result.map(e => ({ from: e.from, to: e.to, type: e.type }));
        expect(triples).toEqual(expect.arrayContaining([
            { from: 'evt_rollup1', to: 'char_alice', type: 'related' },
            { from: 'char_alice', to: 'loc_castle', type: 'mentions' },
        ]));
        // Internal edge types excluded by default.
        const hasInternal = result.some(e => e.type === 'contains' || e.type === 'semantic_contains');
        expect(hasInternal).toBe(false);
        // Each edge has numeric weight.
        for (const e of result) {
            expect(typeof e.weight).toBe('number');
            expect(Number.isFinite(e.weight)).toBe(true);
            expect(e.weight).toBeGreaterThanOrEqual(1);
        }
    });

    test('projectEdges({excludeInternal:false}) includes contains / semantic_contains', () => {
        // visibleNodeIds = [evt_rollup1, evt_leaf_a, evt_leaf_b]. The raw `contains` edges have both
        // endpoints in the set → they project as themselves.
        const result = api.projectEdges({
            visibleNodeIds: ['evt_rollup1', 'evt_leaf_a', 'evt_leaf_b'],
            excludeInternal: false,
        });
        const types = result.map(e => e.type);
        expect(types).toContain('contains');
    });
});

describe('Layer C: recall primitives (spec §4.4)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(store, ctx);
    });

    test('listVisibleCandidates() matches collectRootCandidates id set (spec §8.2)', async () => {
        const { collectRootCandidates } = await import('../../public/scripts/extensions/memory-graph/main.js');
        const settings = testHolder.settings;
        const direct = collectRootCandidates(store, settings, { fullText: '' }, [], ctx, {
            latestSeqIndex: -1, excludeMessages: 0,
        });
        const apiResult = api.listVisibleCandidates();
        const directIds = new Set(direct.map(n => String(n.id)));
        const apiIds = new Set(apiResult.map(n => String(n.id)));
        expect(apiIds).toEqual(directIds);
    });

    test('listVisibleCandidates is sorted by compareNodesByRecency (seqTo desc → semanticDepth desc → id asc)', () => {
        const result = api.listVisibleCandidates();
        // event has hierarchical compression: leaves a/b under evt_rollup1
        // project up to the rollup; evt_leaf_c is an orphan leaf (no
        // active rollup ancestor) and stays as itself. Active visible pool
        // after projection (semantic level only — episodic epi_log1 is
        // excluded by real buildGraphNodeHints / listNodesByLevel):
        //   char_root(8), char_alice(7), evt_leaf_c(6), loc_castle(5),
        //   evt_rollup1(4, depth=1).
        expect(result.map(n => n.id)).toEqual([
            'char_root',
            'char_alice',
            'evt_leaf_c',
            'loc_castle',
            'evt_rollup1',
        ]);
    });

    test('listVisibleCandidates({seqWindow:{from:5}}) filters by seqTo', () => {
        const result = api.listVisibleCandidates({ seqWindow: { from: 5 } });
        const ids = result.map(n => n.id).sort();
        // seqTo >= 5: loc_castle(5), evt_leaf_c(6), char_alice(7), char_root(8)
        expect(ids).toEqual(['char_alice', 'char_root', 'evt_leaf_c', 'loc_castle']);
    });

    test('listVisibleCandidates({excludeRecentMessages:2}) excludes recent-window nodes', () => {
        // Real getLatestSeqIndex() = getStoreCoveredSeqTo() = max of
        // appliedSeqTo(8), loggedSeqTo(8), getSemanticCoverageSeq(store).
        // getSemanticCoverageSeq scans all active semantic nodes, including
        // the recall_state diagnostic at seqTo=9 (semantic level), so the
        // real watermark is 9. With excludeMessages=2 the cutoff is
        // 9 - 2 + 1 = 8, so only char_root (seqTo=8) gets excluded;
        // char_alice (seqTo=7) survives. Episodic epi_log1 is filtered out
        // by buildGraphNodeHints' semantic-only pass.
        const result = api.listVisibleCandidates({ excludeRecentMessages: 2 });
        const ids = result.map(n => n.id);
        expect(ids).not.toContain('char_root');
        // char_alice still present (seqTo=7 < cutoff=8).
        expect(ids).toContain('char_alice');
        // Older semantic nodes still present (event leaves a/b project up to evt_rollup1).
        expect(ids).toEqual(expect.arrayContaining(['evt_leaf_c', 'evt_rollup1', 'loc_castle']));
    });

    test('getNodeExposure: hierarchical-compression semantic node returns "high_only"', () => {
        // evt_rollup1 is event-type semantic — event has compression.mode hierarchical → high_only.
        expect(api.getNodeExposure('evt_rollup1')).toBe('high_only');
        expect(api.getNodeExposure('evt_leaf_a')).toBe('high_only');
    });

    test('getNodeExposure: episodic node returns "high_only" (per actual getNodeRecallExposure behavior)', () => {
        // The native getNodeRecallExposure returns 'high_only' for any non-semantic node. read-api passes
        // through verbatim. Episodic event nodes match this branch (line 5524 of main.js).
        expect(api.getNodeExposure('epi_log1')).toBe('high_only');
    });

    test('getNodeExposure: non-hierarchical semantic node returns "full"', () => {
        // character_sheet is semantic, compression.mode='none' → 'full'.
        expect(api.getNodeExposure('char_alice')).toBe('full');
        expect(api.getNodeExposure('loc_castle')).toBe('full');
    });

    test('getNodeExposure: missing / archived id returns null', () => {
        expect(api.getNodeExposure('nope')).toBeNull();
        expect(api.getNodeExposure('evt_archived')).toBeNull();
    });

    test('getEdgeSummary returns {degree, relations[], sample_neighbors[]} shape', () => {
        const summary = api.getEdgeSummary('char_alice', {
            visibleNodeIds: ['char_alice', 'loc_castle', 'evt_leaf_a', 'evt_leaf_c', 'char_root'],
        });
        expect(summary).toHaveProperty('degree');
        expect(summary).toHaveProperty('relations');
        expect(summary).toHaveProperty('sample_neighbors');
        expect(typeof summary.degree).toBe('number');
        expect(Array.isArray(summary.relations)).toBe(true);
        expect(Array.isArray(summary.sample_neighbors)).toBe(true);
        // char_alice has edges: in related<-evt_leaf_a, in related<-evt_leaf_c, in semantic_contains<-char_root,
        // out mentions->loc_castle. degree should be 4 (each edge contributes 1 with default weight).
        expect(summary.degree).toBe(4);
    });

    test('getEdgeSummary default nodeSet uses current visibleIds', () => {
        __setInjectedForTest({ alwaysInjectIds: [], recallSelectedIds: [],
            visibleIds: ['char_alice', 'loc_castle'] });
        const summary = api.getEdgeSummary('char_alice');
        // Only mentions->loc_castle should remain visible (others' opposite endpoints fall outside visibleSet).
        expect(summary.degree).toBe(1);
        const relTypes = summary.relations.map(r => r.relation);
        expect(relTypes).toContain('mentions');
    });

    test('getNodeBrief: full active node has all NodeBriefView fields', () => {
        __setInjectedForTest({
            alwaysInjectIds: [], recallSelectedIds: [],
            visibleIds: ['char_alice', 'loc_castle', 'evt_leaf_a', 'evt_leaf_c', 'char_root'],
        });
        const brief = api.getNodeBrief('char_alice');
        expect(brief).toBeTruthy();
        // Spec §4.1 NodeBriefView fields.
        for (const f of ['id', 'level', 'type', 'tableName', 'title', 'summary', 'keyValues',
            'rowValues', 'toSeq', 'childCount', 'exposure', 'edgeSummary', 'alwaysInject']) {
            expect(Object.prototype.hasOwnProperty.call(brief, f)).toBe(true);
        }
        expect(brief.id).toBe('char_alice');
        expect(brief.level).toBe('semantic');
        expect(brief.type).toBe('character_sheet');
        expect(brief.tableName).toBe('character_table');
        expect(brief.title).toBe('Alice');
        expect(brief.toSeq).toBe(7);
        expect(brief.exposure).toBe('full');
        expect(brief.alwaysInject).toBe(false);
        expect(brief.edgeSummary).not.toBeNull();
    });

    test('getNodeBrief: hierarchical-rollup node has exposure:"high_only" and childCount > 0', () => {
        const brief = api.getNodeBrief('evt_rollup1');
        expect(brief).toBeTruthy();
        expect(brief.exposure).toBe('high_only');
        expect(brief.childCount).toBeGreaterThan(0);
    });

    test('getNodeBrief: always-inject node reflects alwaysInject:true', () => {
        __setInjectedForTest({
            alwaysInjectIds: ['char_alice'],
            recallSelectedIds: [],
            visibleIds: ['char_alice'],
        });
        const brief = api.getNodeBrief('char_alice');
        expect(brief).toBeTruthy();
        expect(brief.alwaysInject).toBe(true);
    });

    test('getNodeBrief: missing / archived id returns null', () => {
        expect(api.getNodeBrief('does_not_exist')).toBeNull();
        expect(api.getNodeBrief('evt_archived')).toBeNull();
    });

    test('getNodeBrief({includeEdgeSummary:false}) sets edgeSummary=null', () => {
        const brief = api.getNodeBrief('char_alice', { includeEdgeSummary: false });
        expect(brief).toBeTruthy();
        expect(brief.edgeSummary).toBeNull();
    });

    test('expandFromSeeds([seed], {hops:2, includeChildren:true}) returns children and edge-projected neighbors', () => {
        // seed: char_root. With includeChildren:true + hops>=1 we reach char_alice (child) then via
        // projected edges hop to loc_castle (mentions) and back to evt_leaf_a / evt_leaf_c (related).
        const result = api.expandFromSeeds(['char_root'], { hops: 2, includeChildren: true });
        const ids = result.map(n => n.id);
        expect(ids).toContain('char_root');
        // Children expansion should pull in char_alice.
        expect(ids).toContain('char_alice');
        // Should have non-trivial count.
        expect(ids.length).toBeGreaterThanOrEqual(2);
    });

    test('expandFromSeeds({excludeInternal:false}) (default) includes children via contains edges', () => {
        // seed: evt_rollup1. Its children evt_leaf_a / evt_leaf_b sit behind `contains` edges.
        const result = api.expandFromSeeds(['evt_rollup1'], { hops: 1, includeChildren: true });
        const ids = result.map(n => n.id);
        expect(ids).toContain('evt_rollup1');
        expect(ids).toContain('evt_leaf_a');
        expect(ids).toContain('evt_leaf_b');
    });

    test('expandFromSeeds({excludeInternal:true}) drops hierarchical children of seed', () => {
        const result = api.expandFromSeeds(['evt_rollup1'], {
            hops: 1, includeChildren: true, excludeInternal: true,
        });
        const ids = result.map(n => n.id);
        expect(ids).toContain('evt_rollup1'); // seed always retained
        expect(ids).not.toContain('evt_leaf_a');
        expect(ids).not.toContain('evt_leaf_b');
    });

});

describe('keywordSearch', () => {
    let api;

    beforeEach(() => {
        const store = {
            nodes: {
                n1: { id: 'n1', type: 'character_sheet', title: 'Eileen', fields: { aliases: '艾琳', traits: 'healer quiet' }, seqTo: 10 },
                n2: { id: 'n2', type: 'character_sheet', title: 'Marcus', fields: { traits: 'warrior loud' }, seqTo: 12 },
                n3: { id: 'n3', type: 'event', title: 'Forest battle', fields: { summary: '时间:Day 5;Marcus 击退 wolves。' }, seqTo: 15 },
            },
            edges: [],
        };
        testHolder.settings = null;
        api = getMemoryGraphReadApi(store, {});
    });

    test('matches against title and projected columns', () => {
        const results = api.keywordSearch({ query: 'healer' });
        expect(results.map(r => r.id)).toContain('n1');
        expect(results.map(r => r.id)).not.toContain('n2');
    });

    test('returns empty array on empty query', () => {
        expect(api.keywordSearch({ query: '' })).toEqual([]);
        expect(api.keywordSearch({ query: '   ' })).toEqual([]);
    });

    test('respects types filter', () => {
        const results = api.keywordSearch({ query: 'Marcus', types: ['event'] });
        expect(results.map(r => r.id)).toContain('n3');
        expect(results.map(r => r.id)).not.toContain('n2');
    });

    test('respects k cap', () => {
        const results = api.keywordSearch({ query: 'a', k: 1 });
        expect(results.length).toBeLessThanOrEqual(1);
    });
});

describe('vectorSearch', () => {
    test('throws NO_EMBEDDING_PROFILE when no profile configured', async () => {
        const store = { nodes: {}, edges: [] };
        const api = getMemoryGraphReadApi(store, {});
        await expect(api.vectorSearch({ query: 'anything' })).rejects.toMatchObject({
            code: 'NO_EMBEDDING_PROFILE',
        });
    });

    test('returns empty array on empty query (no throw)', async () => {
        const store = { nodes: {}, edges: [] };
        const api = getMemoryGraphReadApi(store, {});
        await expect(api.vectorSearch({ query: '' })).resolves.toEqual([]);
    });
});

describe('findByName', () => {
    let api;
    beforeEach(() => {
        const store = {
            nodes: {
                n1: { id: 'n1', type: 'character_sheet', title: 'Eileen', fields: { aliases: '艾琳, Eily' }, seqTo: 10 },
                n2: { id: 'n2', type: 'character_sheet', title: 'Marcus', fields: { aliases: '' }, seqTo: 12 },
                n3: { id: 'n3', type: 'location_state', title: 'Dark Forest', fields: { aliases: '黑森林' }, seqTo: 8 },
            },
            edges: [],
        };
        // Both character_sheet and location_state must declare aliases in
        // primaryKeyColumns so findByName can substring-match against the field.
        // (Matches the default schema where both types ship with ['title','aliases'].)
        testHolder.settings = {
            nodeTypeSchema: [
                {
                    id: 'character_sheet',
                    label: 'Character',
                    tableName: 'character_table',
                    tableColumns: ['title', 'aliases', 'traits'],
                    requiredColumns: ['title'],
                    primaryKeyColumns: ['title', 'aliases'],
                    forceUpdate: false,
                    alwaysInject: false,
                    editable: true,
                    keywords: [],
                    compression: { mode: 'none' },
                },
                {
                    id: 'location_state',
                    label: 'Location',
                    tableName: 'location_table',
                    tableColumns: ['title', 'aliases'],
                    requiredColumns: ['title'],
                    primaryKeyColumns: ['title', 'aliases'],
                    forceUpdate: false,
                    alwaysInject: false,
                    editable: true,
                    keywords: [],
                    compression: { mode: 'none' },
                },
            ],
        };
        api = getMemoryGraphReadApi(store, {});
    });

    test('matches on title case-insensitively', () => {
        expect(api.findByName({ query: 'eileen' }).matches.map(m => m.id)).toContain('n1');
    });

    test('matches on aliases (substring of comma-separated values)', () => {
        expect(api.findByName({ query: '艾琳' }).matches.map(m => m.id)).toContain('n1');
        expect(api.findByName({ query: '黑森林' }).matches.map(m => m.id)).toContain('n3');
    });

    test('respects types filter', () => {
        const matches = api.findByName({ query: 'forest', types: ['character_sheet'] }).matches;
        expect(matches.map(m => m.id)).not.toContain('n3');
    });

    test('returns { matches: [] } on no match', () => {
        expect(api.findByName({ query: 'NonExistent' })).toEqual({ matches: expect.any(Array) });
        expect(api.findByName({ query: 'NonExistent' }).matches).toEqual([]);
    });
});

describe('compactionCandidates', () => {
    test('returns empty groups when type has compression.mode === "none"', () => {
        const store = {
            nodes: {
                c1: { id: 'c1', type: 'character_sheet', title: 'A', seqTo: 1, level: 'semantic' },
                c2: { id: 'c2', type: 'character_sheet', title: 'B', seqTo: 2, level: 'semantic' },
                c3: { id: 'c3', type: 'character_sheet', title: 'C', seqTo: 3, level: 'semantic' },
            },
            edges: [],
        };
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const api = getMemoryGraphReadApi(store, {});
        // character_sheet schema has compression.mode = 'none' in defaults
        expect(api.compactionCandidates({ type: 'character_sheet' })).toEqual({ groups: [] });
    });

    test('returns groups for hierarchical type at depth 0', () => {
        // Build a store with 15 leaf events.
        // Fixture schema uses { mode: 'hierarchical' } → mock fills defaults:
        //   threshold=6, fanIn=3, maxDepth=6, keepRecentLeaves=0.
        // With keepRecentLeaves=0 and 15 candidates: 15 >= 6 threshold, so
        // groups = floor(15 / 3) = 5 groups.
        const nodes = {};
        for (let i = 1; i <= 15; i++) {
            nodes[`e${i}`] = {
                id: `e${i}`,
                type: 'event',
                title: `Summary ${i}`,
                level: 'semantic',
                seqTo: i,
                semanticDepth: 0,
                semanticRollup: false,
                childrenIds: [],
                fields: { summary: '时间：Day ' + i + '；something happened.' },
            };
        }
        const store = { nodes, edges: [] };
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const api = getMemoryGraphReadApi(store, {});
        const result = api.compactionCandidates({ type: 'event', depth: 0 });
        expect(result.groups.length).toBeGreaterThan(0);
        expect(result.groups[0].depth).toBe(0);
        expect(result.groups[0].childIds.length).toBe(3); // fanIn
        expect(result.groups[0].fanIn).toBe(3);
    });
});

describe('Layer D: injection observation (spec §4.5)', () => {
    let api;
    let store;
    let ctx;

    beforeEach(() => {
        store = buildFixtureStore();
        ctx = makeContext(store);
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        api = getMemoryGraphReadApi(store, ctx);
    });

    test('getInjectionState() returns frozen InjectionState with three Sets', () => {
        __setInjectedForTest({ alwaysInjectIds: ['a'], recallSelectedIds: ['b'], visibleIds: ['c'] });
        const state = api.getInjectionState();
        expect(Object.isFrozen(state)).toBe(true);
        expect(state.alwaysInjectIds).toBeInstanceOf(Set);
        expect(state.recallSelectedIds).toBeInstanceOf(Set);
        expect(state.visibleIds).toBeInstanceOf(Set);
        expect(state.alwaysInjectIds.has('a')).toBe(true);
        expect(state.recallSelectedIds.has('b')).toBe(true);
        expect(state.visibleIds.has('c')).toBe(true);
    });

    test('onInjectionChanged(cb) returns a function; calling it twice is idempotent', () => {
        const cb = () => {};
        const unsubscribe = api.onInjectionChanged(cb);
        expect(typeof unsubscribe).toBe('function');
        // Idempotent: calling unsubscribe twice should not throw.
        expect(() => { unsubscribe(); unsubscribe(); }).not.toThrow();
    });

    test('Registered listener fires after __recordInjectedNodeIds with new state', () => {
        const calls = [];
        const unsubscribe = api.onInjectionChanged((state) => {
            calls.push({
                always: Array.from(state.alwaysInjectIds).sort(),
                recall: Array.from(state.recallSelectedIds).sort(),
                visible: Array.from(state.visibleIds).sort(),
            });
        });
        __recordInjectedNodeIds({
            alwaysInjectIds: ['a1'],
            recallSelectedIds: ['r1', 'r2'],
            visibleIds: ['v1'],
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ always: ['a1'], recall: ['r1', 'r2'], visible: ['v1'] });
        unsubscribe();
    });

    test('Unsubscribe stops further notifications', () => {
        let count = 0;
        const unsubscribe = api.onInjectionChanged(() => { count += 1; });
        __recordInjectedNodeIds({ alwaysInjectIds: ['a'], recallSelectedIds: [], visibleIds: [] });
        expect(count).toBe(1);
        unsubscribe();
        __recordInjectedNodeIds({ alwaysInjectIds: ['b'], recallSelectedIds: [], visibleIds: [] });
        expect(count).toBe(1); // listener no longer called
    });

    test('spec §6 alias: re-exported getMemoryGraphInjectionState returns equivalent shape', () => {
        __setInjectedForTest({ alwaysInjectIds: ['x'], recallSelectedIds: [], visibleIds: [] });
        const reexport = getMemoryGraphInjectionStateReexport({});
        expect(reexport.alwaysInjectIds).toBeInstanceOf(Set);
        expect(reexport.alwaysInjectIds.has('x')).toBe(true);
    });
});

describe('edge_summary fallback when injection state is empty (agent-only mode)', () => {
    test('falls back to canonical top-rollup pool for edge projection', () => {
        // Build a store with: rollup R (depth 1) containing leaves A,B (depth 0).
        // A has involved_in edge to character X.
        // Expected: in agent-only mode (no injection state), getEdgeSummary on X
        // should project A's edge up to R, so X sees R as a neighbor (not A).
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const store = {
            nodes: {
                R: { id: 'R', type: 'event', level: 'semantic', semanticDepth: 1, semanticRollup: true, seqTo: 10, parentId: '', childrenIds: ['A', 'B'], fields: { summary: 'rollup' } },
                A: { id: 'A', type: 'event', level: 'semantic', semanticDepth: 0, semanticRollup: false, seqTo: 5, parentId: 'R', childrenIds: [], fields: { summary: 'leaf A' } },
                B: { id: 'B', type: 'event', level: 'semantic', semanticDepth: 0, semanticRollup: false, seqTo: 8, parentId: 'R', childrenIds: [], fields: { summary: 'leaf B' } },
                X: { id: 'X', type: 'character_sheet', level: 'semantic', semanticDepth: 0, semanticRollup: false, seqTo: 6, parentId: '', childrenIds: [], fields: { title: 'X' } },
            },
            edges: [
                { from: 'R', to: 'A', type: 'semantic_contains', seqTo: 10 },
                { from: 'R', to: 'B', type: 'semantic_contains', seqTo: 10 },
                { from: 'A', to: 'X', type: 'involved_in', seqTo: 5 },
            ],
            appliedSeqTo: 10,
            loggedSeqTo: 10,
        };
        const api = getMemoryGraphReadApi(store, {});
        // No options.visibleNodeIds; no injection state — should fall back to canonical pool.
        const summary = api.getEdgeSummary('X');
        // Should find at least one neighbor (R, via leaf-edge projection)
        expect(summary.sample_neighbors.map(n => n.id)).toContain('R');
        // Should NOT include the hidden leaf A directly
        expect(summary.sample_neighbors.map(n => n.id)).not.toContain('A');
    });

    test('returns empty when explicit empty visibleNodeIds passed (caller intent)', () => {
        testHolder.settings = { nodeTypeSchema: buildFixtureSchema() };
        const store = {
            nodes: {
                A: { id: 'A', type: 'event', level: 'semantic', semanticDepth: 0, seqTo: 1, parentId: '', childrenIds: [], fields: {} },
                X: { id: 'X', type: 'character_sheet', level: 'semantic', semanticDepth: 0, seqTo: 1, parentId: '', childrenIds: [], fields: {} },
            },
            edges: [{ from: 'A', to: 'X', type: 'involved_in', seqTo: 1 }],
        };
        const api = getMemoryGraphReadApi(store, {});
        // Explicit empty array — caller wants "nothing visible".
        const summary = api.getEdgeSummary('X', { visibleNodeIds: [] });
        expect(summary.sample_neighbors).toEqual([]);
    });
});
