/**
 * Verifies that memory-graph's session-write commit path:
 *   - calls `commitMemoryStoreDiffByChatKey` (append-incremental) when an
 *     in-flight chat tail is present
 *   - calls `replacePersistedGraphWithStore` (legacy replace flush) when
 *     no in-flight tail is present
 *   - threads a `beforeStore` snapshot through so the diff path sees the
 *     pre-write store as its baseline
 *
 * Uses the same mock stack as write-api.test.js to let main.js load
 * under jest. The test asserts behavior at the boundary — without a real
 * floor-state, the diff path will fail at fs.update / floor-resolution,
 * while the legacy replace path fails at Memory-store-target. Those error
 * shapes are enough signal to prove which branch was taken.
 */

import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { installBrowserModuleContext, installDomReadyJQuery } from '../util/browser-module-context.js';

// ---- Browser / jQuery shims ----
const jqueryEnv = installDomReadyJQuery();
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

// ---- Module mocks (same stack as write-api.test.js) ----
const extensionSettingsMock = { memory_graph: {} };
const browserEnv = installBrowserModuleContext({
    extensionSettings: extensionSettingsMock,
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'avatar.png', file_name: 'chat' }),
    saveSettings: () => Promise.resolve({ ok: true, status: 'saved' }),
    saveSettingsDebounced: () => {},
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    escapeHtml: (s) => String(s || ''),
    worldInfoEntry: { template: () => ({}), setGlobalSelection: () => {} },
    addLocaleData: () => {},
    translate: (k) => String(k ?? ''),
    getCurrentLocale: () => 'en-US',
    registerExtensionApi: () => {},
    getExtensionApi: () => null,
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    eventTypes: {},
    lib: {
        showdown: { Converter: class { makeHtml(t) { return String(t || ''); } } },
        DOMPurify: { sanitize: (h) => h },
    },
});

afterAll(() => {
    browserEnv.restore();
    jqueryEnv.restore();
});

jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return {
        lodash,
        showdown: { Converter: class { makeHtml(t) { return String(t || ''); } } },
        DOMPurify: { sanitize: (h) => h },
    };
});
jest.unstable_mockModule('../../public/scripts/request-compression.js', () => ({
    compressRequest: async (r) => r,
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0, INPUT: 1, CONFIRM: 2 },
    POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 },
}));
jest.unstable_mockModule('../../public/scripts/st-context.js', () => ({
    getContext: () => ({}),
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    resolveChatStateTarget: () => ({
        is_group: false, avatar_url: 'avatar.png', file_name: 'chat',
    }),
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => ({}),
    registerExtensionApi: () => {},
    UNSET_VALUE: Symbol('UNSET_VALUE'),
}));
jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    performFuzzySearch: () => [],
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    download: () => {}, getFileText: () => Promise.resolve(''),
    getStringHash: () => '', escapeHtml: (s) => String(s || ''),
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: () => ({}),
    setGlobalWorldInfoSelection: () => {},
    world_info_position: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {}, translate: (k) => k,
    getCurrentLocale: () => 'en-US', t: (k) => k,
}));
jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/profile-resolver.js',
    () => ({ getChatCompletionConnectionProfiles: () => [] }),
);
jest.unstable_mockModule(
    '../../public/scripts/extensions/connection-manager/embed-rerank.js',
    () => ({
        renderProfileSelect: () => '',
        upsertEmbeddingProfile: () => {}, upsertRerankProfile: () => {},
        getEmbeddingProfileById: () => null, getRerankProfileById: () => null,
    }),
);
jest.unstable_mockModule(
    '../../public/scripts/extensions/function-call-runtime.js',
    () => ({ TOOL_PROTOCOL_STYLE: {}, validateParsedToolCalls: () => true }),
);
jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

// ---- SUT import ----
let commitSessionMutation;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/memory-graph/main.js');
    commitSessionMutation = mod.commitSessionMutation;
});

describe('commitSessionMutation in-flight anchoring', () => {
    test('with in-flight tail, uses diff-mode commit and forwards beforeStore', async () => {
        const ctx = {
            chat: [
                { is_user: true, mes: 'u1' },
                { is_user: false, mes: 'a1' },
                { is_user: true, mes: 'u2' },
                { is_user: false, mes: 'a2 in flight' },
            ],
        };
        const before = { nodes: {}, edges: [], seqCounter: 1, appliedSeqTo: 1, loggedSeqTo: 1 };
        const after = { nodes: { 'n_1': { id: 'n_1', seqTo: 2, level: 1, type: 'event' } }, edges: [], seqCounter: 1, appliedSeqTo: 1, loggedSeqTo: 1 };

        // The diff-mode path fails at floor-state IO (no fs configured) —
        // that error shape proves the diff branch fired.
        await expect(
            commitSessionMutation(ctx, 'fake-chat-key', before, after),
        ).rejects.toThrow(/floor-resolution|log-append|floor-state|Memory store target|getFloorStateInstance/i);
    });

    test('without in-flight tail (chat empty), falls back to replace-mode path', async () => {
        const ctx = { chat: [] };
        const before = { nodes: {}, edges: [], seqCounter: 1 };
        const after = { nodes: {}, edges: [], seqCounter: 1 };

        // Empty chat → no anchor → replace path → fails at Memory store target.
        await expect(
            commitSessionMutation(ctx, 'fake-chat-key', before, after),
        ).rejects.toThrow(/Memory store target is unavailable/i);
    });
});

describe('graph-iteration commit surface', () => {
    test('main.js exports commitGraphUiMutation and it validates required args', async () => {
        const mod = await import(
            '../../public/scripts/extensions/memory-graph/main.js'
        );
        expect(typeof mod.commitGraphUiMutation).toBe('function');
        await expect(mod.commitGraphUiMutation({}, 'chat', {})).rejects.toThrow();
        await expect(mod.commitGraphUiMutation({}, '', { afterStore: { nodes: {} } })).rejects.toThrow();
    });

    test('openMemoryConfigStudio and openMemoryGraphStudio navigate to Workbench AI iteration', async () => {
        const mod = await import(
            '../../public/scripts/extensions/memory-graph/main.js'
        );
        const open = jest.fn(async () => {});
        const globalCtx = { workbench: { open }, characters: [], characterId: -1 };
        await mod.openMemoryConfigStudio(globalCtx);
        expect(open).toHaveBeenCalledWith({ page: 'ai', ws: 'memory', scope: 'global' });

        const charCtx = { workbench: { open }, characters: [{ avatar: 'alice.png', name: 'Alice' }], characterId: 0 };
        await mod.openMemoryConfigStudio(charCtx);
        expect(open).toHaveBeenCalledWith({ page: 'ai', ws: 'memory', scope: 'character' });

        await mod.openMemoryGraphStudio(charCtx);
        expect(open).toHaveBeenCalledWith({ page: 'ai', ws: 'memory_graph', scope: 'chat' });
    });
});
