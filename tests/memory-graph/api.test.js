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
    resolveChatStateTarget: () => null,
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => ({}),
    registerExtensionApi: jest.fn(),
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

let openSession;
let resetFloorStateInstanceForTesting;

beforeAll(async () => {
    const apiMod = await import('../../public/scripts/extensions/memory-graph/api.js');
    openSession = apiMod.openSession;
    const persistMod = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    resetFloorStateInstanceForTesting = persistMod.resetFloorStateInstanceForTesting;
});

describe('memory-graph/api.openSession', () => {
    test('returns a session with read+write methods bound to the current store', async () => {
        resetFloorStateInstanceForTesting();
        const fakePayload = {
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
        const ctx = {
            chatId: 'chat-1',
            createFloorState: () => ({
                ready: async () => {},
                get: async () => fakePayload,
                update: async () => true,
                patch: async () => true,
                namespace: 'luker_memory_graph',
            }),
            getChatState: async () => null,
        };
        const session = await openSession(ctx);
        expect(session).toBeTruthy();
        expect(typeof session.listVisibleCandidates).toBe('function');
        expect(typeof session.createNode).toBe('function');
        // listVisibleCandidates without extra options must return an array
        // (its actual contents depend on the recall pipeline applied to the
        // store + schema; that's covered exhaustively in read-api.test.js).
        const list = session.listVisibleCandidates({});
        expect(Array.isArray(list)).toBe(true);
        // createNode round-trip: write through the session and observe the
        // store grow. This is the core proof the read+write factories were
        // bound to the same store snapshot the facade loaded.
        const before = Object.keys(fakePayload.nodes).length;
        const created = session.createNode({
            type: 'event',
            title: 'evt',
            fields: { what: 'something happened' },
        });
        expect(created.id).toBeTruthy();
        // Round-trip: the read+write factories must share the same store
        // snapshot. If openSession ever rewires them to different stores
        // (e.g. accidental re-clone inside the factory), the new node would
        // be invisible to reads — this assertion locks the invariant.
        const visible = session.listVisibleCandidates({});
        expect(visible.some(n => n.id === created.id)).toBe(true);
        expect(before).toBe(1);
    });

    test('returns a writable empty-store session when fs.get() returns null (fresh chat)', async () => {
        resetFloorStateInstanceForTesting();
        const ctx = {
            chatId: 'fresh-chat',
            createFloorState: () => ({
                ready: async () => {},
                get: async () => null,
                update: async () => true,
                patch: async () => true,
                namespace: 'luker_memory_graph',
            }),
            getChatState: async () => null,
        };
        const session = await openSession(ctx);
        expect(session).toBeTruthy();
        const list = session.listVisibleCandidates({});
        expect(Array.isArray(list)).toBe(true);
        expect(list).toHaveLength(0);
        const created = session.createNode({ type: 'event', title: 'first', fields: { what: 'thing happened' } });
        expect(created.id).toBeTruthy();
        const visible = session.listVisibleCandidates({});
        expect(visible.some(n => n.id === created.id)).toBe(true);
    });

    test('returns null when context lacks createFloorState', async () => {
        resetFloorStateInstanceForTesting();
        const session = await openSession({});
        expect(session).toBeNull();
    });
});
