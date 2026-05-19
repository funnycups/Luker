/**
 * Edge summary `to_seq` projection: explicit edge seqTo when present,
 * otherwise fall back to max(node[from].seqTo, node[to].seqTo).
 *
 * Spec: docs/superpowers/plans/2026-05-19-memory-graph-extraction-and-compaction-api.md
 *       Task 4 — read-time fallback, no migration.
 *
 * main.js transitively imports `../../../script.js` / `./lib.js` which touch
 * DOM at module-load (jQuery / Popper / webpack-bundled `lib.core.bundle.js`).
 * We re-use the dogfood-style mock stack so the real `read-api.js` and
 * `main.js` load in Node.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// -----------------------------------------------------------------------------
// Browser / jQuery shims required by main.js's module-level init.
// -----------------------------------------------------------------------------

globalThis.jQuery = (cb) => {
    if (typeof cb === 'function') { /* swallow init handlers */ }
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
// Module mocks — everything outside memory-graph/ main.js touches.
// -----------------------------------------------------------------------------

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
    UNSET_VALUE: Symbol('UNSET_VALUE'),
}));

jest.unstable_mockModule('../../public/scripts/iteration-studio/index.js', () => ({
    open: () => {},
    defineAdapter: () => {},
    createSettingsBackedHistoryStore: () => ({ push: () => {}, list: () => [] }),
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

let getMemoryGraphReadApi;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/read-api.js');
    getMemoryGraphReadApi = mod.getMemoryGraphReadApi;
});

// -----------------------------------------------------------------------------
// Fixture builder — minimal store with two character_sheet nodes and one edge
// between them. Tests toggle whether the edge carries an explicit seqTo.
//
// Both endpoints are passed via `visibleNodeIds` so the projection survives
// without needing an injection state.
// -----------------------------------------------------------------------------

function buildStore({ edgeSeqTo } = {}) {
    const edge = { from: 'a', to: 'b', type: 'partner_of' };
    if (Number.isFinite(edgeSeqTo)) edge.seqTo = edgeSeqTo;
    return {
        nodes: {
            a: { id: 'a', type: 'character_sheet', level: 'semantic', title: 'A', seqTo: 10, fields: {} },
            b: { id: 'b', type: 'character_sheet', level: 'semantic', title: 'B', seqTo: 20, fields: {} },
        },
        edges: [edge],
    };
}

describe('edge_summary seqTo fallback', () => {
    test('edge with explicit seqTo uses that value', () => {
        const api = getMemoryGraphReadApi({ __memoryStore: buildStore({ edgeSeqTo: 99 }) });
        const summary = api.getEdgeSummary('a', { visibleNodeIds: ['a', 'b'], limit: 5 });
        const neighbor = summary?.sample_neighbors?.[0];
        expect(neighbor).toBeDefined();
        expect(neighbor.id).toBe('b');
        expect(neighbor.to_seq).toBe(99);
    });

    test('edge without seqTo falls back to max(node.seqTo)', () => {
        const api = getMemoryGraphReadApi({ __memoryStore: buildStore() });
        const summary = api.getEdgeSummary('a', { visibleNodeIds: ['a', 'b'], limit: 5 });
        const neighbor = summary?.sample_neighbors?.[0];
        expect(neighbor).toBeDefined();
        expect(neighbor.id).toBe('b');
        // max(node.a.seqTo=10, node.b.seqTo=20) = 20.
        expect(neighbor.to_seq).toBe(20);
    });

    test('sample_neighbors are sorted by to_seq desc', () => {
        // Three neighbors of `a`, each with a distinct edge seqTo.
        const store = {
            nodes: {
                a: { id: 'a', type: 'character_sheet', level: 'semantic', title: 'A', seqTo: 5, fields: {} },
                b: { id: 'b', type: 'character_sheet', level: 'semantic', title: 'B', seqTo: 1, fields: {} },
                c: { id: 'c', type: 'character_sheet', level: 'semantic', title: 'C', seqTo: 2, fields: {} },
                d: { id: 'd', type: 'character_sheet', level: 'semantic', title: 'D', seqTo: 3, fields: {} },
            },
            edges: [
                { from: 'a', to: 'b', type: 'partner_of', seqTo: 11 },
                { from: 'a', to: 'c', type: 'partner_of', seqTo: 33 },
                { from: 'a', to: 'd', type: 'partner_of', seqTo: 22 },
            ],
        };
        const api = getMemoryGraphReadApi({ __memoryStore: store });
        const summary = api.getEdgeSummary('a', { visibleNodeIds: ['a', 'b', 'c', 'd'], limit: 5 });
        const ids = summary.sample_neighbors.map(n => n.id);
        const seqs = summary.sample_neighbors.map(n => n.to_seq);
        expect(ids).toEqual(['c', 'd', 'b']);
        expect(seqs).toEqual([33, 22, 11]);
    });

    test('Map accumulator tracks max seqTo across multiple edges to the same neighbor', () => {
        const ctx = {
            __memoryStore: {
                nodes: {
                    a: { id: 'a', type: 'character_sheet', seqTo: 1, fields: {} },
                    b: { id: 'b', type: 'character_sheet', seqTo: 2, fields: {} },
                },
                edges: [
                    { from: 'a', to: 'b', type: 'partner_of', seqTo: 5 },
                    { from: 'a', to: 'b', type: 'rival_of', seqTo: 12 },
                ],
            },
        };
        const api = getMemoryGraphReadApi(ctx);
        const summary = api.getEdgeSummary('a', { visibleNodeIds: ['a', 'b'], limit: 5 });
        const neighborB = summary?.sample_neighbors?.find(n => n.id === 'b');
        expect(neighborB).toBeDefined();
        expect(neighborB.to_seq).toBe(12); // max of [5, 12]
    });
});
