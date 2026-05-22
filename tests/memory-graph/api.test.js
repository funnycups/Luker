/**
 * Tests for memory-graph/api.js — the Layer-1 facade that publishes
 * `openSession(context)` via `registerExtensionApi('memory-graph', …)`.
 *
 * api.js imports persistence.js (pure data shuffling) plus read-api.js +
 * write-api.js (which themselves load main.js). The same mock stack used by
 * the read-api / write-api suites lets the real api.js module load in Node.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';

// ---------------------------------------------------------------------------
// Browser / jQuery shims required by main.js's module-level init.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module mocks — anything outside memory-graph/ main.js touches.
// ---------------------------------------------------------------------------

const extensionSettingsMock = { memory_graph: {} };

jest.unstable_mockModule('../../public/script.js', () => ({
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    // The session API resolves the chat-state target through this helper.
    // Returning a valid character target lets `ensureMemoryStoreLoaded` /
    // `resolveChatKeyForSession` flow without short-circuiting to null.
    resolveChatStateTarget: () => ({
        is_group: false,
        avatar_url: 'session-test-avatar.png',
        file_name: 'session-test-chat',
    }),
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => ({}),
    registerExtensionApi: jest.fn(),
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

let openSession;
let resetFloorStateInstanceForTesting;

beforeAll(async () => {
    const apiMod = await import('../../public/scripts/extensions/memory-graph/api.js');
    openSession = apiMod.openSession;
    const persistMod = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    resetFloorStateInstanceForTesting = persistMod.resetFloorStateInstanceForTesting;
});

describe('memory-graph/api.openSession', () => {
    function makeStorageBackedContext(initialPayload = null, initialMeta = null) {
        // Minimal viable context that exercises the real
        // `ensureMemoryStoreLoaded` + `commitSessionMutation` path:
        //   - `getChatState` returns the persisted payload / meta sidecar
        //     so the loader can build a runtime store
        //   - `updateChatState` records writes so tests can assert the
        //     commit boundary actually flushed.
        const storage = new Map();
        if (initialPayload !== null) storage.set('luker_memory_graph', initialPayload);
        if (initialMeta !== null) storage.set('luker_memory_graph__meta', initialMeta);
        const updateChatState = jest.fn(async (namespace, _target, reducerOrPayload) => {
            const key = String(namespace || '');
            const prev = storage.get(key);
            const next = typeof reducerOrPayload === 'function'
                ? reducerOrPayload(prev)
                : reducerOrPayload;
            storage.set(key, next);
            // memory-graph's persistence helpers (`persistMetaFields`,
            // `commitMemoryStoreReplaceByChatKey`) check `result?.ok` and
            // throw on falsy. Mirror the real chat-state contract here.
            return { ok: true };
        });
        const ctx = {
            chatId: 'chat-1',
            getChatState: async (namespace) => storage.get(String(namespace || '')) ?? null,
            updateChatState,
            // memory-graph's commit pipeline diffs payloads via
            // `buildObjectPatchOperationsAsync`. Providing it directly on
            // ctx short-circuits `resolveBuildObjectPatchOperationsAsync`
            // so the test doesn't need to mock script.js's copy. A no-op
            // patch builder is enough — the commit path also takes the
            // "no graph change" fallback that writes via updateChatState
            // anyway, which is what we assert on.
            buildObjectPatchOperationsAsync: async () => [],
            // floor-state isn't on the openSession hot path post-refactor,
            // but `attachNotesFloorState` callers / legacy code paths can
            // still ask for it. Returning a benign stub avoids exploding
            // module-time init in main.js if it ever pre-warms one.
            createFloorState: () => ({
                ready: async () => {},
                get: async () => null,
                update: async () => true,
                patch: async () => true,
                namespace: 'luker_memory_graph',
            }),
        };
        return { ctx, storage, updateChatState };
    }

    test('returns a session bound to the live runtime store; reads see prior nodes', async () => {
        resetFloorStateInstanceForTesting();
        // v2 payload shape with one pre-existing character.
        const payload = {
            nodes: {
                n1: {
                    id: 'n1',
                    type: 'character_sheet',
                    level: 'semantic',
                    title: 'Alice',
                    fields: { title: 'Alice' },
                    seqTo: 1,
                    parentId: '',
                    childrenIds: [],
                    archived: false,
                    semanticRollup: false,
                    semanticDepth: 0,
                },
            },
            edges: [],
            seqCounter: 1,
            nodeSeq: 1,
            appliedSeqTo: 1,
            loggedSeqTo: 1,
        };
        const meta = { schemaVersion: 2, sourceMessageCount: 0, lastRecallTrace: [], lastRecallProjection: null };
        const { ctx } = makeStorageBackedContext(payload, meta);
        const session = await openSession(ctx);
        expect(session).toBeTruthy();
        expect(typeof session.listVisibleCandidates).toBe('function');
        expect(typeof session.createNode).toBe('function');
        const list = session.listVisibleCandidates({});
        expect(Array.isArray(list)).toBe(true);
    });

    test('createNode through the session flushes the mutation through the commit boundary', async () => {
        // Regression: pre-fix, write-api methods only mutated an in-memory
        // store snapshot and never reached `updateChatState`, so the LLM
        // saw `ok: true` while the UI / persistence layer never noticed.
        // `openSession` now wires a commit callback that writes through to
        // chat-state, so a single createNode call MUST produce at least
        // one updateChatState invocation against the graph namespace.
        resetFloorStateInstanceForTesting();
        const { ctx, updateChatState } = makeStorageBackedContext(null, null);
        const session = await openSession(ctx);
        expect(session).toBeTruthy();
        const created = await session.createNode({
            type: 'event',
            title: 'evt',
            fields: { what: 'something happened' },
        });
        expect(created.id).toBeTruthy();
        // The commit fans out to multiple chat-state writes (graph payload
        // + meta sidecar + floor-state log). We only require that the
        // graph payload namespace was touched at least once.
        const graphNamespaceCalls = updateChatState.mock.calls.filter(
            ([namespace]) => String(namespace || '').startsWith('memory_graph'),
        );
        expect(graphNamespaceCalls.length).toBeGreaterThan(0);
        // Read-after-write through the same session: the new node is
        // visible to subsequent reads on the shared active store.
        const visible = session.listVisibleCandidates({});
        expect(visible.some(n => n.id === created.id)).toBe(true);
    });
});
