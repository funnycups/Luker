/**
 * Dogfood equivalence tests for memory-graph read-api.
 *
 * Spec: docs/superpowers/specs/2026-05-18-memory-graph-readonly-api.md §5
 *
 * The read-only API exposed in `read-api.js` claims to give external recall
 * agents the same inputs that native `chooseRecallRoute` feeds to the route
 * LLM. These tests assert that claim end-to-end against three equivalence
 * points:
 *
 *   1. candidateRows ≡ formatNodeBrief loop output that
 *      `chooseRecallRoute` (main.js:5736-5740) builds for the route LLM.
 *   2. schema_overview ≡ the row shape `chooseRecallRoute` derives from
 *      `getEffectiveNodeTypeSchema(...).map(...)` at main.js:5754.
 *   3. drill expansion ≡ `expandRouteCandidates(store, route, rootCandidates)`
 *      output node set for any `expand_plan` fixture.
 *
 * Native main.js + character-overrides drag in many frontend modules
 * (script.js, extensions.js, world-info.js, …) that need the runtime
 * `lib.core.bundle.js`, which only exists after webpack builds the
 * frontend. We side-step that by stubbing those modules via
 * `jest.unstable_mockModule` BEFORE main.js is loaded.
 */

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

// -----------------------------------------------------------------------------
// Global browser/jQuery shims for main.js's module-level `jQuery(() => …)` init
// -----------------------------------------------------------------------------

globalThis.jQuery = (cb) => {
    // Skip running init handlers — tests don't need DOM wiring.
    if (typeof cb === 'function') { /* swallow */ }
    return { ready: () => {}, on: () => {}, off: () => {} };
};
globalThis.$ = globalThis.jQuery;
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
};

// -----------------------------------------------------------------------------
// Module mocks — everything outside memory-graph/ that main.js imports.
// Paths resolve relative to this test file. They normalize to the same
// absolute paths main.js (and its transitive deps) use, so jest matches both.
// -----------------------------------------------------------------------------

// Shared mutable `extension_settings` reference both the test and the mocked
// `extensions.js` see. main.js's `ensureSettings()` will populate
// `extension_settings.memory_graph` with defaults the first time it runs.
const extensionSettingsMock = { memory_graph: {} };

jest.unstable_mockModule('../../public/script.js', () => ({
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    resolveChatStateTarget: () => null,
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => ({}),
    registerExtensionApi: () => {},
    UNSET_VALUE: Symbol('UNSET_VALUE'),
}));

jest.unstable_mockModule('../../public/scripts/extensions/memory-graph/schema-iteration/studio.js', () => ({
    openSchemaIterationStudio: () => Promise.resolve(),
}));

jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    performFuzzySearch: () => [],
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    escapeHtml: (s) => String(s || ''),
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: () => ({}),
    setGlobalWorldInfoSelection: () => {},
    world_info_position: {
        before: 0,
        after: 1,
        ANTop: 2,
        ANBottom: 3,
        EMTop: 4,
        EMBottom: 5,
        atDepth: 6,
    },
}));

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    translate: (k) => k,
    getCurrentLocale: () => 'en-US',
    t: (k) => k,
}));

jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    registerManagedRegexProvider: () => ({ dispose: () => {} }),
    regex_placement: {},
    substitute_find_regex: () => '',
}));

jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/profile-resolver.js',
    () => ({
        getChatCompletionConnectionProfiles: () => [],
    }),
);

jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/embed-rerank.js',
    () => ({
        renderProfileSelect: () => '',
        upsertEmbeddingProfile: () => {},
        upsertRerankProfile: () => {},
        getEmbeddingProfileById: () => null,
        getRerankProfileById: () => null,
    }),
);

jest.unstable_mockModule(
    '../../public/scripts/extensions/function-call-runtime.js',
    () => ({
        TOOL_PROTOCOL_STYLE: {},
        validateParsedToolCalls: () => true,
    }),
);

jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

// -----------------------------------------------------------------------------
// Lazy-imported modules — must wait for mocks to register.
// -----------------------------------------------------------------------------

let getMemoryGraphReadApi;
let collectRootCandidates;
let expandRouteCandidates;
let formatNodeBrief;
let getNodeRecallExposure;
let buildEdgeSummary;
let getLatestSeqIndex;
let getSettings;
let normalizeNodeTypeSchema;
let getEffectiveSettings;
let getEffectiveNodeTypeSchema;
let configureCharacterOverrides;
let __setInjectedForTest;
let __resetInjectedForTest;

beforeAll(async () => {
    const readApiMod = await import(
        '../../public/scripts/extensions/memory-graph/read-api.js'
    );
    getMemoryGraphReadApi = readApiMod.getMemoryGraphReadApi;

    const mainMod = await import(
        '../../public/scripts/extensions/memory-graph/main.js'
    );
    collectRootCandidates = mainMod.collectRootCandidates;
    expandRouteCandidates = mainMod.expandRouteCandidates;
    formatNodeBrief = mainMod.formatNodeBrief;
    getNodeRecallExposure = mainMod.getNodeRecallExposure;
    buildEdgeSummary = mainMod.buildEdgeSummary;
    getLatestSeqIndex = mainMod.getLatestSeqIndex;
    getSettings = mainMod.getSettings;
    normalizeNodeTypeSchema = mainMod.normalizeNodeTypeSchema;

    const overridesMod = await import(
        '../../public/scripts/extensions/memory-graph/character-overrides.js'
    );
    getEffectiveSettings = overridesMod.getEffectiveSettings;
    getEffectiveNodeTypeSchema = overridesMod.getEffectiveNodeTypeSchema;
    configureCharacterOverrides = overridesMod.configure;

    const externalApiMod = await import(
        '../../public/scripts/extensions/memory-graph/external-api.js'
    );
    __setInjectedForTest = externalApiMod.__setInjectedForTest;
    __resetInjectedForTest = externalApiMod.__resetInjectedForTest;

    // Wire character-overrides deps the same way main.js's init does, so
    // `getEffectiveNodeTypeSchema(...)` returns a normalized schema and
    // `getEffectiveSettings(...)` does not collapse to an empty object.
    configureCharacterOverrides({
        MODULE_NAME: 'memory_graph',
        defaultSettings: {},
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings: (s) => s || {},
        getSettings,
    });
});

// -----------------------------------------------------------------------------
// Fixture builder — one rich, deterministic store that exercises all three
// dogfood assertions.
//
// Contents:
//   - event_root: hierarchical-compression `event` rollup (parent) with two
//     leaf event children + one third leaf attached as `contains` edge.
//   - 4 standalone `event` leaves (not under the rollup).
//   - 2 `character_sheet` nodes (non-hierarchical, full exposure).
//   - 1 `location_state` node.
//   - 1 `rule_constraint` node.
//   - Edges of every required type: `related`, `mentions`, `contains`,
//     `semantic_contains`, `involved_in`, `occurred_at`.
//   - One always-inject node seeded via `__setInjectedForTest`.
// -----------------------------------------------------------------------------

function buildDogfoodFixture() {
    // Schema mirrors defaultNodeTypeSchema's shape but pins the specific
    // compression / always-inject behavior needed for the test.
    const nodeTypeSchema = [
        {
            id: 'event',
            label: 'Event',
            tableName: 'event_table',
            tableColumns: ['summary'],
            requiredColumns: ['summary'],
            forceUpdate: true,
            editable: false,
            alwaysInject: true,
            primaryKeyColumns: [],
            compression: { mode: 'hierarchical', threshold: 9, fanIn: 3, maxDepth: 10, keepRecentLeaves: 6 },
        },
        {
            id: 'character_sheet',
            label: 'Character Sheet',
            tableName: 'character_table',
            tableColumns: ['title', 'aliases', 'traits', 'state', 'goal'],
            requiredColumns: ['title'],
            forceUpdate: false,
            editable: true,
            alwaysInject: false,
            primaryKeyColumns: ['title', 'aliases'],
            compression: { mode: 'none' },
        },
        {
            id: 'location_state',
            label: 'Location State',
            tableName: 'location_table',
            tableColumns: ['title', 'controller', 'danger', 'state'],
            requiredColumns: ['title'],
            forceUpdate: false,
            editable: true,
            alwaysInject: false,
            primaryKeyColumns: ['title'],
            compression: { mode: 'none' },
        },
        {
            id: 'rule_constraint',
            label: 'Rule Constraint',
            tableName: 'rule_table',
            tableColumns: ['title', 'constraint', 'scope', 'status'],
            requiredColumns: ['title'],
            forceUpdate: false,
            editable: true,
            alwaysInject: false,
            primaryKeyColumns: ['title'],
            compression: { mode: 'none' },
        },
    ];

    // Seed extension_settings.memory_graph so getSettings() returns a usable
    // settings blob. The shared mock object is reused across `beforeEach`
    // calls; we replace its contents wholesale to avoid leaking state.
    extensionSettingsMock.memory_graph = {
        nodeTypeSchema: normalizeNodeTypeSchema(nodeTypeSchema),
        recentRawTurns: 2,
        recallQueryMessages: 2,
        recallMaxIterations: 3,
        extractBatchTurns: 1,
        extractContextTurns: 2,
        extractExcludeRecentTurns: 0,
        llmVisibleRecentMessages: 5,
        toolCallRetryMax: 2,
        rpmLimit: 0,
    };

    const node = (id, type, seqTo, fields, extra = {}) => ({
        id,
        type,
        level: 'semantic',
        title: String(fields?.title || fields?.summary || id),
        fields,
        seqTo,
        parentId: '',
        childrenIds: [],
        archived: false,
        semanticRollup: false,
        semanticDepth: 0,
        ...extra,
    });

    // -- Event rollup + leaves (hierarchical-compression exemplar) --
    const eventLeaf1 = node('evt_leaf_1', 'event', 10, {
        summary: 'Alice steps into the moonlit clearing and meets a stranger.',
    });
    const eventLeaf2 = node('evt_leaf_2', 'event', 11, {
        summary: 'The stranger reveals he was sent by the rival faction.',
    });
    const eventLeaf3 = node('evt_leaf_3', 'event', 12, {
        summary: 'Alice extracts a name and a meeting place from him.',
    });
    const eventRollup = node('evt_rollup_1', 'event', 12, {
        summary: 'Alice intercepts a rival-faction scout and learns the next move.',
    }, { semanticRollup: true, semanticDepth: 1, childrenIds: ['evt_leaf_1', 'evt_leaf_2'] });

    // Wire children's parentId back.
    eventLeaf1.parentId = 'evt_rollup_1';
    eventLeaf2.parentId = 'evt_rollup_1';

    // Standalone event leaves (no rollup parent — they should appear as their
    // own visible candidates).
    const eventStandalone1 = node('evt_standalone_1', 'event', 20, {
        summary: 'Alice and Bob argue over the next route.',
    });
    const eventStandalone2 = node('evt_standalone_2', 'event', 21, {
        summary: 'Bob storms off, leaving Alice to scout alone.',
    });

    // -- character_sheet nodes (non-hierarchical) --
    const charAlice = node('char_alice', 'character_sheet', 22, {
        title: 'Alice',
        aliases: 'Al, Ally',
        traits: 'curious, sharp-witted',
        state: 'on edge after the scout meeting',
        goal: 'find the rival faction stronghold',
    });
    const charBob = node('char_bob', 'character_sheet', 18, {
        title: 'Bob',
        aliases: 'Robert',
        traits: 'loyal, hot-tempered',
        state: 'angry, walking back to camp',
        goal: 'restock supplies',
    });

    // -- location_state --
    const locClearing = node('loc_clearing', 'location_state', 19, {
        title: 'Moonlit Clearing',
        controller: 'neutral',
        danger: 'low',
        state: 'eerie, well-lit by the full moon',
    });

    // -- rule_constraint --
    const ruleScout = node('rule_scout', 'rule_constraint', 5, {
        title: 'Scout interrogation rule',
        constraint: 'Scout captives never lie about their faction allegiance.',
        scope: 'meta',
        status: 'active',
    });

    const nodes = {
        evt_leaf_1: eventLeaf1,
        evt_leaf_2: eventLeaf2,
        evt_leaf_3: eventLeaf3,
        evt_rollup_1: eventRollup,
        evt_standalone_1: eventStandalone1,
        evt_standalone_2: eventStandalone2,
        char_alice: charAlice,
        char_bob: charBob,
        loc_clearing: locClearing,
        rule_scout: ruleScout,
    };

    // -- Edges: cover every relation type the dogfood drill cares about --
    const edges = [
        // related: alice↔bob (character-to-character)
        { from: 'char_alice', to: 'char_bob', type: 'related' },
        // mentions: rule mentions a character (so projection sees it)
        { from: 'rule_scout', to: 'char_alice', type: 'mentions' },
        // contains: parent->leaf hierarchical bookkeeping
        { from: 'evt_rollup_1', to: 'evt_leaf_1', type: 'contains' },
        { from: 'evt_rollup_1', to: 'evt_leaf_2', type: 'contains' },
        { from: 'evt_rollup_1', to: 'evt_leaf_3', type: 'contains' },
        // semantic_contains: another internal-edge variant
        { from: 'evt_rollup_1', to: 'evt_standalone_1', type: 'semantic_contains' },
        // involved_in: event -> character
        { from: 'evt_rollup_1', to: 'char_alice', type: 'involved_in' },
        { from: 'evt_standalone_1', to: 'char_alice', type: 'involved_in' },
        { from: 'evt_standalone_1', to: 'char_bob', type: 'involved_in' },
        { from: 'evt_standalone_2', to: 'char_bob', type: 'involved_in' },
        // occurred_at: event -> location
        { from: 'evt_rollup_1', to: 'loc_clearing', type: 'occurred_at' },
        { from: 'evt_standalone_1', to: 'loc_clearing', type: 'occurred_at' },
    ];

    const store = {
        nodes,
        edges,
        appliedSeqTo: 22,
        loggedSeqTo: 22,
    };

    // Layer-1 callers pass `store` explicitly to the read-api factory; the
    // context only carries the SillyTavern surface (chat, character info).
    const context = {
        characters: [],
        characterId: -1,
        chat: [],
        chatId: 'test-chat',
    };

    const settings = getEffectiveSettings(context, getSettings());

    return { store, context, settings, nodeTypeSchema };
}

// -----------------------------------------------------------------------------
// Helpers shared across tests
// -----------------------------------------------------------------------------

function normalizeKeyValues(kv) {
    if (!kv || typeof kv !== 'object') return {};
    // Strip frozen wrapper / undefined entries so deep-eq compares are stable.
    const out = {};
    for (const [k, v] of Object.entries(kv)) {
        if (v === undefined) continue;
        out[k] = v;
    }
    return out;
}

// -----------------------------------------------------------------------------
// Dogfood Test 1 — candidateRows equivalence
// -----------------------------------------------------------------------------

describe('dogfood: candidateRows equivalence', () => {
    beforeEach(() => {
        __resetInjectedForTest();
    });

    test('listVisibleCandidates + getNodeBrief is structurally equivalent to native formatNodeBrief loop', () => {
        const { store, context, settings } = buildDogfoodFixture();
        // Seed the always-inject set so both paths agree on `always_inject`.
        // The rollup is type=event which has alwaysInject:true on its spec;
        // collectAlwaysInjectNodes would gather it. We mirror by hand here
        // because the dogfood compares string-level row shape, not pipeline
        // wiring. (Spec §5: structural equivalence of the row, not equality
        // of the upstream injection list.)
        const alwaysInjectIds = new Set(['evt_rollup_1', 'evt_standalone_1', 'evt_standalone_2']);
        __setInjectedForTest({
            alwaysInjectIds,
            recallSelectedIds: new Set(),
        });

        const api = getMemoryGraphReadApi(store, context);

        // ---- Native path: replicate chooseRecallRoute's candidateRows build. ----
        const latestSeqIndex = getLatestSeqIndex(store);
        const nativeCandidates = collectRootCandidates(
            store,
            settings,
            { fullText: '' },
            [], // alwaysInjectNodes — passed in by main.js; pass [] here to
            //                          match the API's listVisibleCandidates flow
            //                          (which also does not inject extras).
            context,
            { latestSeqIndex, excludeMessages: 0 },
        );
        const nativeCandidateSet = new Set(nativeCandidates.map(n => String(n.id)));
        const nativeRows = nativeCandidates.map(node => formatNodeBrief(node, settings, context, {
            exposure: getNodeRecallExposure(settings, node, context),
            edge_summary: buildEdgeSummary(store, node.id, { nodeSet: nativeCandidateSet, limit: 8 }),
            always_inject: alwaysInjectIds.has(String(node.id)),
        }));

        // ---- API path ----
        const apiCandidates = api.listVisibleCandidates();
        const apiCandidateIds = apiCandidates.map(v => v.id);
        // The brief request needs the same nodeSet (visibleIds) the native
        // path used so edge_summary projection matches; the API resolves it
        // from `currentVisibleIdSet()` which itself comes from the injection
        // state. Pass it explicitly to side-step that wiring and keep the
        // comparison crisp.
        const apiVisibleIds = new Set(apiCandidateIds);
        const apiRows = apiCandidates.map(view => api.getNodeBrief(view.id, {
            includeEdgeSummary: true,
            edgeSummaryLimit: 8,
            visibleNodeIds: apiVisibleIds,
        }));

        // ---- Equivalence assertions ----

        // (a) id-order equality: API ≡ native (both sort by compareNodesByRecency).
        expect(apiCandidateIds).toEqual(nativeCandidates.map(n => String(n.id)));
        expect(apiRows.length).toBe(nativeRows.length);

        // (b) per-row structural equivalence (camelCase API ≡ snake_case native).
        for (let i = 0; i < nativeRows.length; i++) {
            const native = nativeRows[i];
            const apiR = apiRows[i];
            expect(apiR).not.toBeNull();
            expect(apiR.id).toBe(String(native.id));
            expect(apiR.type).toBe(String(native.type));
            expect(apiR.title).toBe(String(native.title));
            expect(apiR.toSeq).toBe(Number(native.to_seq ?? -1));
            expect(apiR.childCount).toBe(Number(native.child_count ?? 0));
            expect(apiR.exposure).toBe(native.exposure);
            expect(apiR.alwaysInject).toBe(Boolean(native.always_inject));

            // key_values / row_values: both are sparse string maps. Strip
            // undefineds and compare.
            expect(normalizeKeyValues(apiR.keyValues)).toEqual(normalizeKeyValues(native.key_values || {}));
            expect(normalizeKeyValues(apiR.rowValues)).toEqual(normalizeKeyValues(native.row_values || {}));

            // edge_summary: degree + relation tally must match. Sample
            // neighbor lists may differ in order of insertion; spec only
            // requires structural equivalence, so we compare summary degree
            // + relations-as-set.
            expect(apiR.edgeSummary).not.toBeNull();
            expect(apiR.edgeSummary.degree).toBe(Number(native.edge_summary?.degree || 0));

            const apiRelKeys = (apiR.edgeSummary.relations || [])
                .map(r => `${r.relation}:${r.direction}:${r.count}`).sort();
            const nativeRelKeys = (native.edge_summary?.relations || [])
                .map(r => `${r.relation}:${r.direction}:${r.count}`).sort();
            expect(apiRelKeys).toEqual(nativeRelKeys);

            const apiNbrIds = (apiR.edgeSummary.sample_neighbors || [])
                .map(n => n.id).sort();
            const nativeNbrIds = (native.edge_summary?.sample_neighbors || [])
                .map(n => n.id).sort();
            expect(apiNbrIds).toEqual(nativeNbrIds);
        }
    });
});

// -----------------------------------------------------------------------------
// Dogfood Test 2 — schema_overview equivalence
// -----------------------------------------------------------------------------

describe('dogfood: schema_overview equivalence', () => {
    test('getSchema() row shape ≡ chooseRecallRoute schema_overview projection', () => {
        const { store, context, settings } = buildDogfoodFixture();
        const api = getMemoryGraphReadApi(store, context);

        // ---- Native shape (chooseRecallRoute main.js:5754) ----
        const nativeSchema = getEffectiveNodeTypeSchema(context, settings);
        const nativeOverview = nativeSchema.map(item => ({
            id: String(item.id || ''),
            table_name: String(item.tableName || ''),
            table_columns: [...(Array.isArray(item.tableColumns) ? item.tableColumns : [])],
            required_columns: [...(Array.isArray(item.requiredColumns) ? item.requiredColumns : [])],
            force_update: Boolean(item.forceUpdate),
            always_inject: Boolean(item.alwaysInject),
            editable: Boolean(item.editable),
            compression_mode: String(item?.compression?.mode || 'none'),
        }));

        // ---- API shape ----
        const apiSchema = api.getSchema();
        const apiOverview = apiSchema.types.map(spec => ({
            // SchemaSpecView uses `type` (camelCase) as the id field.
            id: String(spec.type || ''),
            table_name: String(spec.tableName || ''),
            table_columns: [...(Array.isArray(spec.tableColumns) ? spec.tableColumns : [])],
            required_columns: [...(Array.isArray(spec.requiredColumns) ? spec.requiredColumns : [])],
            force_update: Boolean(spec.forceUpdate),
            always_inject: Boolean(spec.alwaysInject),
            editable: Boolean(spec.editable),
            compression_mode: String(spec.compressionMode || 'none'),
        }));

        expect(apiOverview.length).toBe(nativeOverview.length);
        for (let i = 0; i < nativeOverview.length; i++) {
            expect(apiOverview[i]).toEqual(nativeOverview[i]);
        }
    });
});

// -----------------------------------------------------------------------------
// Dogfood Test 3 — drill expansion equivalence
// -----------------------------------------------------------------------------

describe('dogfood: drill expansion equivalence', () => {
    beforeEach(() => {
        __resetInjectedForTest();
    });

    test('expandFromSeeds (default excludeInternal: false) ≡ expandRouteCandidates id set', () => {
        const { store, context, settings } = buildDogfoodFixture();

        // Seed visibleIds so the API's `projectTo: 'visible'` (default) flow
        // hands the native expandRouteCandidates the same rootCandidates
        // pool we build manually below.
        const latestSeqIndex = getLatestSeqIndex(store);
        const nativeRootCandidates = collectRootCandidates(
            store,
            settings,
            { fullText: '' },
            [],
            context,
            { latestSeqIndex, excludeMessages: 0 },
        );
        const visibleIds = new Set(nativeRootCandidates.map(n => String(n.id)));
        __setInjectedForTest({
            alwaysInjectIds: new Set(),
            recallSelectedIds: new Set(),
            visibleIds,
        });

        // Pick a seed that has children + projected-edge neighbors so the
        // expansion exercises both paths.
        const seedId = 'evt_rollup_1';
        // Sanity: seed must be in the visible candidate pool (otherwise
        // expandRouteCandidates would silently drop the seed's `expand_plan`
        // entry; main.js:5868).
        expect(visibleIds.has(seedId)).toBe(true);

        // ---- Native path ----
        const route = {
            expand_plan: [{
                seed_node_id: seedId,
                depth: 2,
                include_children: true,
            }],
        };
        const nativeExpanded = expandRouteCandidates(store, route, nativeRootCandidates);
        const nativeIds = new Set(nativeExpanded.map(n => String(n.id)));

        // ---- API path ----
        const api = getMemoryGraphReadApi(store, context);
        const apiExpanded = api.expandFromSeeds([seedId], {
            hops: 2,
            includeChildren: true,
            // Default `excludeInternal: false` matches spec; pass explicitly
            // to document intent.
            excludeInternal: false,
        });
        const apiIds = new Set(apiExpanded.map(v => v.id));

        // Spec §5: drill equivalence is set equality (id sets).
        expect(apiIds).toEqual(nativeIds);

        // And: the seed itself must be in both (drill always returns the
        // seed + frontier).
        expect(nativeIds.has(seedId)).toBe(true);
        expect(apiIds.has(seedId)).toBe(true);

        // Drill should reach at least one child + at least one projected-edge
        // neighbor (otherwise the fixture isn't exercising the path). The
        // rollup has children evt_leaf_1/2/3 and projected edges to
        // char_alice, loc_clearing, and (via internal) evt_standalone_1.
        expect(apiIds.size).toBeGreaterThan(1);
    });
});
