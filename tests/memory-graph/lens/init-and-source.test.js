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
let currentHasOverride = false;
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
    getRebuildableRange: () => ({ latestSeq: 0, minFloor: 0, maxFloor: -1, assistantFloors: [] }),
    getSettings: () => ({ nodeTypeSchema: [{ id: 'event', tableColumns: ['summary'] }] }),
    importMemoryGraphFile: async () => {},
    invalidateLatestRecallSnapshot: invalidateMock,
    normalizeNodeTypeSchema: (s) => Array.isArray(s) ? s : [{ id: 'event', tableColumns: ['summary'] }],
    openMemoryConfigStudio: async () => {},
    openMemoryGraphStudio: async () => {},
    resetMemoryGraphForChat: async () => {},
    runFillGraph: async () => {},
    runManualCompression: async () => {},
    runRebuildFromFloor: async () => {},
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
    summarize: () => ({ total: 0, count: 0, average: 0, max: 0, recent: [] }),
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
const { mountMemoryLens } = await import('../../../public/scripts/extensions/memory-graph/lens/app.js');

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
        currentHasOverride = false;
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
                        hasOverride: currentHasOverride,
                        scope: currentHasOverride ? 'character' : 'global',
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

    test('initMemoryLens registers workspace, AskProvider, SuggestRuleProvider, IterateTargets and starts background tasks', () => {
        initMemoryLens();
        expect(registeredWorkspaces.map(w => w.id)).toEqual(['memory']);
        expect(registeredAsk.map(a => a.id)).toEqual(['memory']);
        expect(registeredSuggest.map(s => s.id)).toEqual(['memory']);
        expect(registeredIterate.map(t => t.id)).toEqual(['memory', 'memory_graph']);
        expect(startTagFilterMock).toHaveBeenCalledTimes(1);
        expect(startRecorderMock).toHaveBeenCalledTimes(1);
        expect(toastrWarnSpy).not.toHaveBeenCalled();
    });

    test('schema.write checks expectedAvatar and calls invalidateLatestRecallSnapshot', async () => {
        const source = createLukerSource();
        const readInfo = await source.schema.read();
        expect(readInfo.avatar).toBe('alice.png');
        expect(readInfo.globalSettings).toEqual({
            autoCompressionEnabled: false,
            persistentInjectionMaxSeqDistance: 0,
            recallMethod: 'llm',
            ragDefaultPerTypeK: 0,
        });

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

    test('schema.write checks expectedAvatar when switching character override back to global, and schema.restore checks avatar when previous.scope is global', async () => {
        const source = createLukerSource();

        // 1) Switching Alice's character override back to global fails if active character switched to Bob
        currentAvatar = 'alice.png';
        currentHasOverride = true;
        currentAvatar = 'bob.png';
        await expect(source.schema.write([{ id: 'event', tableColumns: ['summary'] }], {
            scope: 'global',
            expectedAvatar: 'alice.png',
        })).rejects.toMatchObject({ code: 'character-changed' });
        expect(removeCharSchemaMock).not.toHaveBeenCalled();

        // 2) Write character override when Alice had no prior override -> previous.scope === 'global', previous.characterTypes === null
        currentAvatar = 'alice.png';
        currentHasOverride = false;
        const previous = await source.schema.write([{ id: 'event', tableColumns: ['summary'] }], {
            scope: 'character',
            expectedAvatar: 'alice.png',
        });
        expect(previous.scope).toBe('global');
        expect(previous.characterTypes).toBeNull();
        expect(previous.avatar).toBe('alice.png');

        // Switch to Bob (who has an override) and attempt restore -> must reject with character-changed and never delete Bob's override
        currentAvatar = 'bob.png';
        currentHasOverride = true;
        await expect(source.schema.restore(previous)).rejects.toMatchObject({ code: 'character-changed' });
        expect(removeCharSchemaMock).not.toHaveBeenCalled();
    });

    test('mountMemoryLens invalidates settings view when load() fails in catch branch', async () => {
        if (!globalThis.requestAnimationFrame) {
            globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
        }
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let shouldFailLoad = false;
            let updateEveryValue = 2;
            const readSettingsSpy = jest.fn(() => ({
                values: {
                    enabled: true,
                    autoExtractionEnabled: true,
                    autoCompressionEnabled: true,
                    recallEnabled: true,
                    recallMethod: 'llm',
                    recallInjectPosition: 1,
                    recallInjectDepth: 4,
                    recallInjectRole: 0,
                },
                options: {
                    connections: [],
                    presets: [],
                    embeddingProfiles: [],
                    rerankProfiles: [],
                    positions: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
                    roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
                    compressibleTypes: [],
                },
                advanced: {
                    values: { updateEvery: updateEveryValue, extractBatchTurns: 2, extractContextTurns: 2, extractExcludeRecentTurns: 0, extractMode: 'oneshot', llmVisibleRecentMessages: 5 },
                    defaults: {},
                    scope: 'global',
                    hasAvatar: false,
                    hasOverride: false,
                    avatar: '',
                    characterName: '',
                },
            }));

            const fakeSource = {
                load: jest.fn(async () => {
                    if (shouldFailLoad) {
                        const err = new Error('no chat');
                        err.code = 'no-chat';
                        throw err;
                    }
                    return {
                        chatKey: 'c1',
                        chatLabel: 'Chat 1',
                        loadedAt: Date.now(),
                        nodes: [],
                        edges: [],
                        schema: { types: [] },
                        columnLabels: {},
                        injection: null,
                        lastRecall: null,
                        tokens: { current: null, entries: [] },
                    };
                }),
                settings: {
                    read: readSettingsSpy,
                    set: (_k, v) => v,
                    subscribe: () => () => {},
                },
                ops: {
                    status: () => '',
                    onStatus: () => () => {},
                    stats: () => ({ nodeCount: 0, edgeCount: 0, messageCount: 0, sourceMessageCount: 0, levelCount: { semantic: 0 } }),
                },
            };

            const host = document.createElement('div');
            document.body.appendChild(host);
            const lens = mountMemoryLens({ source: fakeSource, container: host, opts: { subview: 'settings' } });
            await new Promise(r => setTimeout(r, 0));
            const callsBeforeFail = readSettingsSpy.mock.calls.length;
            expect(callsBeforeFail).toBeGreaterThanOrEqual(1);

            // Switch away from settings so settings.render() only reloads if invalidated
            lens.app.setState({ view: 'table' });
            shouldFailLoad = true;
            updateEveryValue = 7;
            await lens.reload();

            // Switching back to settings must re-read settings because load() catch invalidated views.settings
            lens.app.setState({ view: 'settings' });
            expect(readSettingsSpy).toHaveBeenCalledTimes(callsBeforeFail + 1);
            const summary = host.querySelector('[data-settings-section="extraction"] .luker-bsum');
            expect(summary.textContent).toContain('7');
            lens.destroy();
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('edit commit surfaces vector sync errors via onError / toast', async () => {
        const onError = jest.fn();
        const source = createLukerSource({ onError });
        const edit = source.edit.forChat('char:alice.png:chat1');
        await edit.createNode({ type: 'event', title: 'Test', fields: { summary: 'Hello' } });
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('vector down'));
    });

    test('mountMemoryLens preserves cached model and surfaces toast on transient reload error', async () => {
        if (!globalThis.requestAnimationFrame) {
            globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
        }
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const hostToast = jest.fn();
        try {
            let failTransient = false;
            const fakeSource = {
                load: jest.fn(async () => {
                    if (failTransient) {
                        const err = new Error('temporary IO error');
                        err.code = 'read-failed';
                        throw err;
                    }
                    return {
                        chatKey: 'c1',
                        chatLabel: 'Chat 1',
                        loadedAt: Date.now(),
                        nodes: [{ id: 'n1', type: 'event', level: 'semantic', title: 'Kept node', fields: { summary: 'Still here' }, seq_to: 1, semantic_depth: 0 }],
                        edges: [],
                        schema: { types: [{ id: 'event', tableColumns: ['summary'] }] },
                        columnLabels: {},
                        injection: null,
                        lastRecall: null,
                        tokens: { current: null, entries: [] },
                    };
                }),
                settings: { read: () => ({ values: {}, options: { connections: [], presets: [], positions: {}, roles: {}, compressibleTypes: [] }, advanced: { values: {}, defaults: {} } }), subscribe: () => () => {} },
                ops: { status: () => '', onStatus: () => () => {}, stats: () => ({ nodeCount: 1, edgeCount: 0 }) },
            };
            const host = document.createElement('div');
            document.body.appendChild(host);
            const lens = mountMemoryLens({ source: fakeSource, container: host, hostApp: { toast: hostToast } });
            await new Promise(r => setTimeout(r, 0));
            expect(lens.app.model()?.nodes.has('n1')).toBe(true);

            failTransient = true;
            await lens.reload();
            expect(lens.app.model()?.nodes.has('n1')).toBe(true);
            expect(hostToast).toHaveBeenCalledWith(expect.stringContaining('temporary IO error'), expect.objectContaining({ error: true }));
            lens.destroy();
        } finally {
            warnSpy.mockRestore();
        }
    });
});
