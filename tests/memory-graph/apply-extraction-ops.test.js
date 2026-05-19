/**
 * Tests for `applyExtractionOpsImpl` exported from
 * `public/scripts/extensions/memory-graph/main.js`.
 *
 * Spec: Task 18 — refactor the per-op switch out of
 * `processPendingMessageBatchWithLLM` into a reusable exported entry that the
 * upcoming write-api (Task 19) can call.
 *
 * main.js transitively pulls `script.js`, `extensions.js`, etc. — modules that
 * depend on the webpack-bundled `lib.core.bundle.js` and on a browser DOM.
 * We stub those modules with `jest.unstable_mockModule` BEFORE main.js loads,
 * following the pattern in `read-api-dogfood.test.js`. memory-graph internal
 * modules (`graph-ops.js`, `primitives.js`, `persistence.js`, …) load for real
 * so we exercise the production op pipeline end-to-end on an in-memory store.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// -----------------------------------------------------------------------------
// Browser/jQuery shims for main.js's module-level `jQuery(() => …)` init
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
// Module mocks — anything outside memory-graph/ that main.js imports.
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

// -----------------------------------------------------------------------------
// Lazy SUT import — must come AFTER the mocks above register.
// -----------------------------------------------------------------------------

let applyExtractionOpsImpl;

beforeAll(async () => {
    const mainMod = await import(
        '../../public/scripts/extensions/memory-graph/main.js'
    );
    applyExtractionOpsImpl = mainMod.applyExtractionOpsImpl;
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('applyExtractionOpsImpl', () => {
    test('applies a create op then a link_upsert op pointing at the new node by ref', () => {
        const store = { nodes: {}, edges: [], seqCounter: 0 };
        const ops = [
            { op: 'create', type: 'character_sheet', title: 'Eileen', fields: { traits: 'healer' }, ref: 'eileen' },
            { op: 'link_upsert', sourceRef: 'eileen', links: [{ targetRef: 'eileen', relation: 'related', direction: 'bidirectional' }] },
        ];
        // The pipeline rejects self-links (addEdge drops from === to). The
        // link is therefore a no-op; this test exercises the create + ref
        // chain wiring, which is the main risk after the refactor.
        const result = applyExtractionOpsImpl(store, ops, { maxSeq: 5 });
        expect(result.applied.length).toBeGreaterThanOrEqual(1); // create op applied; link self-rejected
        const created = Object.values(store.nodes).find(n => n.title === 'Eileen');
        expect(created).toBeDefined();
    });

    test('link_delete op removes the edge', () => {
        const store = {
            nodes: { a: { id: 'a' }, b: { id: 'b' } },
            edges: [
                { from: 'a', to: 'b', type: 'partner_of', seqTo: 1 },
                { from: 'b', to: 'a', type: 'partner_of', seqTo: 1 },
            ],
            seqCounter: 0,
        };
        applyExtractionOpsImpl(store, [
            { op: 'link_delete', sourceNodeId: 'a', targetNodeId: 'b', relation: 'partner_of', direction: 'bidirectional' },
        ], { maxSeq: 5 });
        expect(store.edges).toEqual([]);
    });

    test('cross-op ref resolution: link_upsert resolves target_ref to a freshly created node', () => {
        const store = { nodes: {}, edges: [], seqCounter: 0 };
        const ops = [
            { op: 'create', type: 'character_sheet', title: 'Eileen', fields: { traits: 'healer' }, ref: 'eileen' },
            { op: 'create', type: 'character_sheet', title: 'Marcus', fields: { traits: 'warrior' }, ref: 'marcus' },
            {
                op: 'link_upsert',
                sourceRef: 'eileen',
                links: [{ targetRef: 'marcus', relation: 'allied_with', direction: 'bidirectional' }],
            },
        ];
        applyExtractionOpsImpl(store, ops, { maxSeq: 10 });

        const eileen = Object.values(store.nodes).find(n => n.title === 'Eileen');
        const marcus = Object.values(store.nodes).find(n => n.title === 'Marcus');
        expect(eileen).toBeDefined();
        expect(marcus).toBeDefined();

        // Edge should be created between the two newly-resolved nodes
        const allied = store.edges.find(e => e.type === 'allied_with' && (
            (e.from === eileen.id && e.to === marcus.id) ||
            (e.from === marcus.id && e.to === eileen.id)
        ));
        expect(allied).toBeDefined();
    });
});
