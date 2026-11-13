/**
 * @jest-environment jsdom
 */
import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, jest } from '@jest/globals';

const invalidateMock = jest.fn();
const persistCharSchemaMock = jest.fn(async () => true);
const removeCharSchemaMock = jest.fn(async () => true);
const saveSettingsMock = jest.fn(async () => {});
const syncVectorsMock = jest.fn(async () => { throw new Error('vector down'); });
const commitGraphUiMock = jest.fn(async () => ({ skipped: false }));
const startTagFilterMock = jest.fn(() => () => {});
const startRecorderMock = jest.fn(() => () => {});

let currentAvatar = 'alice.png';
let currentListExtensions = ['memory-graph'];
let disabledExtensions = [];

jest.unstable_mockModule('../../../public/scripts/extensions/memory-graph/main.js', () => ({
    addMemoryStatusListener: () => () => {},
    applyRawGraphJson: async () => true,
    clearMemoryAdvancedOverride: async () => true,
    commitGraphUiMutation: commitGraphUiMock,
    createNode: () => ({ id: 'n_1' }),
    ensureMemoryStoreLoaded: async () => ({ nodes: {}, edges: [] }),
    ensureStoreSyncedWithChat: async () => ({ nodes: {}, edges: [] }),
    exportMemoryGraph: async () => {},
    getChatKey: () => 'char:alice.png:chat1',
    getDefaultNodeTypeSchema: () => [{ id: 'event', tableColumns: ['summary'], compression: { mode: 'hierarchical' } }],
    getMemoryGraphStats: () => ({ nodeCount: 0, edgeCount: 0, messageCount: 0, sourceMessageCount: 0, levelCount: { semantic: 0 } }),
    getMemorySettingsView: () => ({ values: {}, options: { connections: [], presets: [], positions: {}, roles: {}, compressibleTypes: [] }, advanced: { values: {}, defaults: {} } }),
    getMemoryStatus: () => '',
    getRawGraphJson: () => '{}',
    getRebuildableLatestSeq: () => 0,
    getSettings: () => ({ nodeTypeSchema: [{ id: 'event', tableColumns: ['summary'] }] }),
    importMemoryGraphFile: async () => {},
    invalidateLatestRecallSnapshot: invalidateMock,
    normalizeNodeTypeSchema: (s) => Array.isArray(s) ? s : [{ id: 'event', tableColumns: ['summary'] }],
    openMemoryConfigStudio: async () => {},
    openMemoryGraphStudio: async () => {},
    resetMemoryGraphForChat: async () => {},
    runFillGraph: async () => {},
    runManualCompression: async () => {},
    runRebuildGraph: async () => {},
    runRebuildRecent: async () => {},
    runRecallDebug: async () => null,
    runVectorRecomputeForChat: async () => {},
    saveMemoryAdvancedSettings: async () => {},
    setMemorySetting: (_k, v) => v,
    stopMemoryExtraction: () => {},
    syncGenerationVisibleHistoryRuntimeRegexScripts: () => {},
    syncGraphVectorsAfterMutation: syncVectorsMock,
    readChatRange: () => [],
    searchGraphSimilarNodes: async () => [],
}));

jest.unstable_mockModule('../../../public/scripts/extensions/memory-graph/character-overrides.js', () => ({
    getCharacterAdvancedOverrideByAvatar: () => null,
    getCharacterSchemaOverrideByAvatar: () => null,
    getEffectiveNodeTypeSchema: (_ctx, s) => s?.nodeTypeSchema || [],
    getSchemaScopeInfo: () => ({ avatar: 'alice.png', hasAvatar: true, characterName: 'Alice', hasOverride: false, scope: 'global', schema: [] }),
    persistCharacterAdvancedOverridePatch: async () => true,
    persistCharacterSchemaOverride: async () => true,
    removeCharacterSchemaOverride: async () => true,
    getEffectiveSettings: (_ctx, s) => s,
}));

jest.unstable_mockModule('../../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [],
}));

jest.unstable_mockModule('../../../public/scripts/extensions/connection-manager/embed-rerank.js', () => ({
    listEmbeddingProfiles: () => [],
    listRerankProfiles: () => [],
    getEmbeddingProfileById: () => null,
    getRerankProfileById: () => null,
}));

jest.unstable_mockModule('../../../public/scripts/extensions/memory-graph/lens/filter/filter-runtime.js', () => ({
    startTagFilter: startTagFilterMock,
    readFilterSettings: () => ({ enabled: false, active: 'default', presets: [{ id: 'default', name: 'Default', black: '', white: '' }] }),
    writeFilterSettings: () => {},
    previewFloor: () => ({ before: '', after: '', real: false }),
    filterStatus: () => ({ registered: true, active: 0, mirrored: [], userRules: [] }),
}));

jest.unstable_mockModule('../../../public/scripts/extensions/memory-graph/lens/token-stats.js', () => ({
    META_KEY: 'memory_lens_tokens',
    TOKENS_EVENT: 'memory-lens:tokens',
    countTokens: async () => 0,
    readEntries: () => [],
    clearEntries: () => {},
    startRecorder: startRecorderMock,
}));

jest.unstable_mockModule('../../../public/scripts/extensions/memory-graph/read-api.js', () => ({
    getMemoryGraphReadApi: () => ({
        listNodes: () => [],
        listEdges: () => [],
        getSchema: () => ({ types: [] }),
        getInjectionState: () => null,
    }),
}));

jest.unstable_mockModule('../../../public/scripts/extensions/memory-graph/write-api.js', () => ({
    getMemoryGraphWriteApi: () => ({
        deleteNode: async () => ({ ok: true }),
    }),
}));

const { createLukerSource } = await import('../../../public/scripts/extensions/memory-graph/lens/source-luker.js');
const { initMemoryLens } = await import('../../../public/scripts/extensions/memory-graph/lens/index.js');

describe('lens index registration & source-luker fixes', () => {
    let registeredWorkspaces;
    let registeredAsk;
    let registeredSuggest;
    let registeredIterate;
    let toastrWarnSpy;
    let toastrErrorSpy;

    beforeEach(() => {
        if (typeof globalThis.structuredClone !== 'function') {
            globalThis.structuredClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
        }
        invalidateMock.mockClear();
        persistCharSchemaMock.mockClear();
        removeCharSchemaMock.mockClear();
        saveSettingsMock.mockClear();
        syncVectorsMock.mockClear();
        commitGraphUiMock.mockClear();
        startTagFilterMock.mockClear();
        startRecorderMock.mockClear();
        currentAvatar = 'alice.png';
        currentListExtensions = ['memory-graph'];
        disabledExtensions = [];
        registeredWorkspaces = [];
        registeredAsk = [];
        registeredSuggest = [];
        registeredIterate = [];
        toastrWarnSpy = jest.fn();
        toastrErrorSpy = jest.fn();
        globalThis.toastr = { warning: toastrWarnSpy, error: toastrErrorSpy };

        const prevCtx = globalThis.Luker.getContext();
        globalThis.Luker = {
            getContext: () => ({
                ...prevCtx,
                extensionSettings: { disabledExtensions },
                saveSettings: saveSettingsMock,
                saveSettingsDebounced: () => {},
                listExtensionNames: () => currentListExtensions,
                getCurrentChatId: () => 'chat1',
                eventTypes: {},
                eventSource: { on: () => {}, removeListener: () => {} },
                getExtensionApi: (name) => name === 'memory-graph' ? {
                    getSchemaScopeInfo: () => ({
                        avatar: currentAvatar,
                        hasAvatar: Boolean(currentAvatar),
                        characterName: currentAvatar,
                        hasOverride: false,
                        scope: 'global',
                        schema: [{ id: 'event', tableColumns: ['summary'] }],
                    }),
                    persistCharacterSchemaOverride: persistCharSchemaMock,
                    removeCharacterSchemaOverride: removeCharSchemaMock,
                    getCurrentInjection: () => null,
                    getLastRecallProjection: async () => null,
                    onStoreCommit: () => () => {},
                    onInjectionChanged: () => () => {},
                } : null,
                workbench: {
                    registerWorkspace: (def) => { registeredWorkspaces.push(def); return () => {}; },
                    registerAskProvider: (def) => { registeredAsk.push(def); return () => {}; },
                    registerSuggestRuleProvider: (def) => { registeredSuggest.push(def); return () => {}; },
                    registerIterateTarget: (def) => { registeredIterate.push(def); return () => {}; },
                },
            }),
        };
    });

    test('initMemoryLens registers workspace, AskProvider, SuggestRuleProvider, IterateTargets and skips background tasks when third-party copy active', () => {
        initMemoryLens();
        expect(registeredWorkspaces.map(w => w.id)).toEqual(['memory']);
        expect(registeredAsk.map(a => a.id)).toEqual(['memory']);
        expect(registeredSuggest.map(s => s.id)).toEqual(['memory']);
        expect(registeredIterate.map(t => t.id)).toEqual(['memory', 'memory_graph']);
        expect(startTagFilterMock).toHaveBeenCalledTimes(1);
        expect(startRecorderMock).toHaveBeenCalledTimes(1);
        expect(toastrWarnSpy).not.toHaveBeenCalled();

        startTagFilterMock.mockClear();
        startRecorderMock.mockClear();
        registeredWorkspaces = [];
        registeredIterate = [];
        currentListExtensions = ['memory-graph', 'third-party/memory-lens'];

        initMemoryLens();
        expect(registeredWorkspaces.map(w => w.id)).toEqual(['memory']);
        expect(registeredIterate.map(t => t.id)).toEqual(['memory', 'memory_graph']);
        expect(toastrWarnSpy).toHaveBeenCalledTimes(1);
        expect(startTagFilterMock).not.toHaveBeenCalled();
        expect(startRecorderMock).not.toHaveBeenCalled();
    });

    test('schema.write checks expectedAvatar and calls invalidateLatestRecallSnapshot', async () => {
        const source = createLukerSource();
        const readInfo = await source.schema.read();
        expect(readInfo.avatar).toBe('alice.png');

        await source.schema.write([{ id: 'event', tableColumns: ['summary'] }], {
            scope: 'character',
            expectedAvatar: 'alice.png',
        });
        expect(persistCharSchemaMock).toHaveBeenCalledTimes(1);
        expect(invalidateMock).toHaveBeenCalledTimes(1);

        currentAvatar = 'bob.png';
        await expect(source.schema.write([{ id: 'event', tableColumns: ['summary'] }], {
            scope: 'character',
            expectedAvatar: 'alice.png',
        })).rejects.toMatchObject({ code: 'character-changed' });
    });

    test('edit commit surfaces vector sync errors via onError / toast', async () => {
        const onError = jest.fn();
        const source = createLukerSource({ onError });
        const edit = source.edit.forChat('char:alice.png:chat1');
        await edit.createNode({ type: 'event', title: 'Test', fields: { summary: 'Hello' } });
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('vector down'));
    });
});
