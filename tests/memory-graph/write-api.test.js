/**
 * Tests for `getMemoryGraphWriteApi` exported from
 * `public/scripts/extensions/memory-graph/write-api.js`.
 *
 * Spec: Task 19 — Layer-1 write API factory. Mirrors the read-api factory
 * shape. The primitives are thin wrappers around `applyExtractionOpsImpl`,
 * so these tests verify the validation / id-resolution / store-missing
 * paths rather than re-testing the op pipeline (covered by
 * `apply-extraction-ops.test.js`).
 *
 * main.js transitively pulls `script.js`, `extensions.js`, etc. — modules that
 * depend on the webpack-bundled `lib.core.bundle.js` and on a browser DOM.
 * We stub those modules with `jest.unstable_mockModule` BEFORE write-api.js
 * loads, following the pattern in `apply-extraction-ops.test.js`.
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

// public/lib.js pulls in a webpack-bundled file that can't be resolved under
// jest. Stub to the bare set of exports memory-graph reaches for at import
// time (the same shim used by mg-schema-iteration tests).
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return {
        lodash,
        showdown: { Converter: class { makeHtml(text) { return String(text || ''); } } },
        DOMPurify: { sanitize: (html) => html },
    };
});

// request-compression.js does `import { gzip } from '/lib.js';` — the
// absolute-path import doesn't resolve under jest. Memory-graph doesn't
// directly use compression; stub the module to a harmless passthrough.
jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({
    compressRequest: async (req) => req,
}));

// preset-help.js → popup.js → RossAscends-mods.js → macros engine →
// /scripts/utils.js bare-spec failure. The UI helpers it exports are only
// reached by interactive code paths the write-api tests don't exercise.
jest.unstable_mockModule('../../public/scripts/extensions/preset-help.js', () => ({
    renderPresetHelpButton: () => '',
}));

// popup.js pulls the whole UI shell. Stub the parts memory-graph might
// reach for at import time.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0, INPUT: 1, CONFIRM: 2 },
    POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 },
}));

// st-context.js is the editor shim popup.js drags in; same import-time
// macros chain.
jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({
    getContext: () => ({}),
}));

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
// Lazy SUT import — must come AFTER the mocks above register.
// -----------------------------------------------------------------------------

let getMemoryGraphWriteApi;

beforeAll(async () => {
    const mod = await import(
        '../../public/scripts/extensions/memory-graph/write-api.js'
    );
    getMemoryGraphWriteApi = mod.getMemoryGraphWriteApi;
});

function makeContext(initialStore) {
    // Tests still inspect `ctx.__memoryStore` to assert post-mutation state,
    // so the helper keeps that field. The factory now takes the store as its
    // first arg; call sites pass `ctx.__memoryStore, ctx`.
    return { __memoryStore: initialStore || { nodes: {}, edges: [], seqCounter: 0 } };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('write-api factory shape', () => {
    test('returns a frozen object exposing all primitives', () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        expect(Object.isFrozen(api)).toBe(true);
        expect(typeof api.createNode).toBe('function');
        expect(typeof api.editNode).toBe('function');
        expect(typeof api.deleteNode).toBe('function');
        expect(typeof api.upsertLinks).toBe('function');
        expect(typeof api.deleteLinks).toBe('function');
        expect(typeof api.compactNodes).toBe('function');
        expect(typeof api.applyExtractionBatch).toBe('function');
    });

    test('getMemoryGraphWriteApi accepts (store, context) and resolves store directly', async () => {
        const store = { nodes: {}, edges: [], seqCounter: 0, appliedSeqTo: 0, loggedSeqTo: 0, nodeSeq: 0 };
        const api = getMemoryGraphWriteApi(store, {});
        const result = await api.createNode({ type: 'event', title: 'first event', fields: { what: 'thing happened' } });
        expect(result.id).toBeTruthy();
        expect(Object.keys(store.nodes)).toHaveLength(1);
    });

    test('onCommit fires after a successful mutation and receives the store', async () => {
        const store = { nodes: {}, edges: [], seqCounter: 0, appliedSeqTo: 0, loggedSeqTo: 0, nodeSeq: 0 };
        const seen = [];
        const api = getMemoryGraphWriteApi(store, {}, {
            onCommit: async (s) => { seen.push(s); },
        });
        await api.createNode({ type: 'event', title: 'flush', fields: { what: 'x' } });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(store);
    });

    test('onCommit does NOT fire when the mutation produced no applied op', async () => {
        const store = { nodes: {}, edges: [], seqCounter: 0, appliedSeqTo: 0, loggedSeqTo: 0, nodeSeq: 0 };
        const seen = [];
        const api = getMemoryGraphWriteApi(store, {}, {
            onCommit: async (s) => { seen.push(s); },
        });
        // editNode on a non-existent id returns ok:false; nothing to commit.
        const res = await api.editNode({ id: 'ghost', setFields: { traits: 'nope' } });
        expect(res.ok).toBe(false);
        expect(seen).toHaveLength(0);
    });
});

describe('write-api createNode', () => {
    test('creates a semantic node and returns its id', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const result = await api.createNode({
            type: 'character_sheet',
            title: 'Eileen',
            fields: { traits: 'healer' },
        });
        expect(result.id).toBeTruthy();
        const node = ctx.__memoryStore.nodes[result.id];
        expect(node).toBeDefined();
        expect(node.title).toBe('Eileen');
        expect(node.fields.traits).toBe('healer');
    });

    test('passes ref through in the return value', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const result = await api.createNode({
            type: 'character_sheet',
            title: 'Marcus',
            fields: {},
            ref: 'marcus',
        });
        expect(result.id).toBeTruthy();
        expect(result.ref).toBe('marcus');
    });

    test('throws on missing type', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.createNode({ title: 'X' })).rejects.toThrow();
    });

    test('MEMORY_STORE_MISSING when store is null', async () => {
        const api = getMemoryGraphWriteApi(null, {});
        await expect(api.createNode({ type: 'character_sheet', title: 'y' }))
            .rejects.toThrow(/MEMORY_STORE_MISSING|runtime store/);
    });
});

describe('write-api editNode / deleteNode', () => {
    test('editNode throws when id missing', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.editNode({ setFields: { x: 1 } })).rejects.toThrow();
    });

    test('deleteNode throws when id missing', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.deleteNode({})).rejects.toThrow();
    });

    test('deleteNode removes an existing node and returns ok', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const { id } = await api.createNode({ type: 'character_sheet', title: 'Zara' });
        expect(ctx.__memoryStore.nodes[id]).toBeDefined();
        const res = await api.deleteNode({ id });
        expect(res.ok).toBe(true);
    });

    // The LLM-facing memory_node_edit tool schema does NOT include a `type`
    // field — only node_id + set_fields/clear_fields/title. write-api's
    // editNode therefore does not synthesize one. applyExtractionOpsImpl had
    // a guard `targetNode.type === item.type` that silently skipped every
    // such call (item.type === undefined → '' !== 'character_sheet' →
    // continue → applied stays empty → ok:false with no diagnostic).
    // This test pins the contract that a real edit from the write-api path
    // succeeds and actually mutates the node.
    test('editNode without an explicit op.type still applies on the addressed node', async () => {
        const ctx = makeContext({
            nodes: {
                n1: {
                    id: 'n1',
                    type: 'character_sheet',
                    level: 'semantic',
                    title: 'Robin',
                    fields: { addressing_user: 'you' },
                    archived: false,
                },
            },
            edges: [],
            seqCounter: 0,
            appliedSeqTo: 0,
            loggedSeqTo: 0,
            nodeSeq: 1,
        });
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.editNode({
            id: 'n1',
            setFields: { addressing_user: 'sir' },
        });
        expect(res.ok).toBe(true);
        expect(ctx.__memoryStore.nodes.n1.fields.addressing_user).toBe('sir');
    });

    test('editNode on a missing id returns ok:false with a NODE_NOT_FOUND error', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.editNode({ id: 'ghost', setFields: { x: 1 } });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
        expect(String(res.error.code || '')).toBe('NODE_NOT_FOUND');
        expect(String(res.error.message || '')).toMatch(/ghost/);
    });

    test('editNode on an archived node returns ok:false with NODE_ARCHIVED', async () => {
        const ctx = makeContext({
            nodes: {
                n1: {
                    id: 'n1',
                    type: 'character_sheet',
                    level: 'semantic',
                    title: 'old',
                    fields: {},
                    archived: true,
                },
            },
            edges: [],
            seqCounter: 0,
        });
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.editNode({ id: 'n1', setFields: { x: 1 } });
        expect(res.ok).toBe(false);
        expect(String(res.error?.code || '')).toBe('NODE_ARCHIVED');
    });

    test('deleteNode on a missing id returns ok:false with a NODE_NOT_FOUND error', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.deleteNode({ id: 'ghost' });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
        expect(String(res.error.code || '')).toBe('NODE_NOT_FOUND');
    });
});

describe('write-api upsertLinks / deleteLinks', () => {
    test('upsertLinks throws without source or links', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.upsertLinks({})).rejects.toThrow();
        await expect(api.upsertLinks({ source: { id: 'a' } })).rejects.toThrow();
    });

    test('upsertLinks accepts target: { id } shape (docs-symmetric with deleteLinks)', async () => {
        const ctx = makeContext({
            nodes: {
                a: { id: 'a', type: 'character_sheet', level: 'semantic', title: 'A', fields: {} },
                b: { id: 'b', type: 'character_sheet', level: 'semantic', title: 'B', fields: {} },
            },
            edges: [],
            seqCounter: 0,
        });
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.upsertLinks({
            source: { id: 'a' },
            links: [{ target: { id: 'b' }, relation: 'mentions', direction: 'outgoing' }],
        });
        expect(res.applied).toBeGreaterThan(0);
        const edge = ctx.__memoryStore.edges.find(e => e.from === 'a' && e.to === 'b' && e.type === 'mentions');
        expect(edge).toBeDefined();
    });

    test('upsertLinks still accepts targetNodeId shape (orchestrator/LLM tool path)', async () => {
        const ctx = makeContext({
            nodes: {
                a: { id: 'a', type: 'character_sheet', level: 'semantic', title: 'A', fields: {} },
                b: { id: 'b', type: 'character_sheet', level: 'semantic', title: 'B', fields: {} },
            },
            edges: [],
            seqCounter: 0,
        });
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.upsertLinks({
            source: { id: 'a' },
            links: [{ targetNodeId: 'b', relation: 'mentions', direction: 'outgoing' }],
        });
        expect(res.applied).toBeGreaterThan(0);
        const edge = ctx.__memoryStore.edges.find(e => e.from === 'a' && e.to === 'b' && e.type === 'mentions');
        expect(edge).toBeDefined();
    });

    test('deleteLinks requires source/target/relation', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.deleteLinks({})).rejects.toThrow();
        await expect(api.deleteLinks({ source: { id: 'a' }, target: { id: 'b' } })).rejects.toThrow();
    });

    test('deleteLinks reports removed count based on edges before/after', async () => {
        const ctx = makeContext({
            nodes: { a: { id: 'a' }, b: { id: 'b' } },
            edges: [
                { from: 'a', to: 'b', type: 'partner_of', seqTo: 1 },
                { from: 'b', to: 'a', type: 'partner_of', seqTo: 1 },
            ],
            seqCounter: 0,
        });
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const res = await api.deleteLinks({
            source: { id: 'a' },
            target: { id: 'b' },
            relation: 'partner_of',
            direction: 'bidirectional',
        });
        expect(res.removed).toBe(2);
        expect(ctx.__memoryStore.edges).toEqual([]);
    });
});

describe('write-api applyExtractionBatch', () => {
    test('throws when ops is not an array', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.applyExtractionBatch({ ops: 'nope' })).rejects.toThrow();
    });

    test('forwards a batch directly to applyExtractionOpsImpl and returns its result', async () => {
        const ctx = makeContext();
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const ops = [
            { op: 'create', type: 'character_sheet', title: 'Eileen', fields: { traits: 'healer' }, ref: 'eileen' },
            { op: 'create', type: 'character_sheet', title: 'Marcus', fields: { traits: 'warrior' }, ref: 'marcus' },
            {
                op: 'link_upsert',
                sourceRef: 'eileen',
                links: [{ targetRef: 'marcus', relation: 'allied_with', direction: 'bidirectional' }],
            },
        ];
        const result = await api.applyExtractionBatch({ ops, maxSeq: 10 });
        expect(Array.isArray(result.applied)).toBe(true);
        expect(result.applied.length).toBeGreaterThanOrEqual(2);

        const eileen = Object.values(ctx.__memoryStore.nodes).find(n => n.title === 'Eileen');
        const marcus = Object.values(ctx.__memoryStore.nodes).find(n => n.title === 'Marcus');
        expect(eileen).toBeDefined();
        expect(marcus).toBeDefined();
        const allied = ctx.__memoryStore.edges.find(e => e.type === 'allied_with' && (
            (e.from === eileen.id && e.to === marcus.id) ||
            (e.from === marcus.id && e.to === eileen.id)
        ));
        expect(allied).toBeDefined();
    });

    test('MEMORY_STORE_MISSING when store is null', async () => {
        const api = getMemoryGraphWriteApi(null, {});
        await expect(api.applyExtractionBatch({ ops: [] }))
            .rejects.toThrow(/MEMORY_STORE_MISSING|runtime store/);
    });
});

describe('write-api compactNodes', () => {
    function makeStoreWithLeaves() {
        return {
            nodes: {
                e1: { id: 'e1', type: 'event', level: 'semantic', seqTo: 1, semanticDepth: 0, fields: { summary: 'time: D1; A.' }, childrenIds: [] },
                e2: { id: 'e2', type: 'event', level: 'semantic', seqTo: 2, semanticDepth: 0, fields: { summary: 'time: D2; B.' }, childrenIds: [] },
                e3: { id: 'e3', type: 'event', level: 'semantic', seqTo: 3, semanticDepth: 0, fields: { summary: 'time: D3; C.' }, childrenIds: [] },
            },
            edges: [],
            seqCounter: 3,
        };
    }

    test('compactNodes creates rollup, reparents children, adds semantic_contains edges', async () => {
        const ctx = makeContext(makeStoreWithLeaves());
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        const result = await api.compactNodes({
            type: 'event',
            childIds: ['e1', 'e2', 'e3'],
            summary: 'time: D1-D3; A and B and C.',
        });
        expect(result.rollupNodeId).toBeTruthy();
        const rollup = ctx.__memoryStore.nodes[result.rollupNodeId];
        expect(rollup.semanticRollup).toBe(true);
        expect(rollup.semanticDepth).toBe(1);
        expect(rollup.fields.summary).toContain('A and B and C');

        // Children reparented to the rollup
        expect(ctx.__memoryStore.nodes.e1.parentId).toBe(result.rollupNodeId);
        expect(ctx.__memoryStore.nodes.e2.parentId).toBe(result.rollupNodeId);
        expect(ctx.__memoryStore.nodes.e3.parentId).toBe(result.rollupNodeId);

        // semantic_contains edges added
        const containsEdges = ctx.__memoryStore.edges.filter(e => e.type === 'semantic_contains');
        expect(containsEdges.length).toBe(3);
    });

    test('compactNodes throws CHILD_HAS_PARENT when a child already has a rollup parent', async () => {
        const store = makeStoreWithLeaves();
        store.nodes.e1.parentId = 'some_other_rollup';
        const ctx = makeContext(store);
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.compactNodes({
            type: 'event',
            childIds: ['e1', 'e2', 'e3'],
            summary: 'x',
        })).rejects.toThrow();
    });

    test('compactNodes throws on missing summary', async () => {
        const ctx = makeContext(makeStoreWithLeaves());
        const api = getMemoryGraphWriteApi(ctx.__memoryStore, ctx);
        await expect(api.compactNodes({ type: 'event', childIds: ['e1', 'e2', 'e3'], summary: '' }))
            .rejects.toThrow(/summary/);
    });
});
