// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import {
    createExtensionRegistry,
    installBrowserModuleContext,
    loadStateErrorsApi,
} from '../util/browser-module-context.js';

globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const domReadyCallbacks = [];
const jqChain = { length: 0 };
for (const method of ['on', 'off', 'one', 'val', 'text', 'html', 'attr', 'prop', 'css', 'addClass', 'removeClass', 'toggleClass', 'show', 'hide', 'toggle', 'append', 'prepend', 'empty', 'remove', 'find', 'closest', 'children', 'parent', 'filter', 'first', 'last', 'eq', 'each', 'trigger', 'focus', 'blur', 'click', 'data']) {
    jqChain[method] = () => jqChain;
}
jqChain.is = () => false;
jqChain.hasClass = () => false;
globalThis.jQuery = Object.assign(
    function (selectorOrFn) {
        if (typeof selectorOrFn === 'function') {
            domReadyCallbacks.push(selectorOrFn);
            return;
        }
        return jqChain;
    },
    {
        __chain: jqChain,
        escapeSelector: (s) => String(s),
    },
);
globalThis.$ = globalThis.jQuery;

const extensionSettingsMock = { memory_graph: {} };
const toastrErrors = [];
const toastrSuccesses = [];
const toastrInfos = [];

globalThis.toastr = {
    info: (msg) => { toastrInfos.push(String(msg || '')); return null; },
    success: (msg) => { toastrSuccesses.push(String(msg || '')); return null; },
    warning: () => null,
    error: (msg) => { toastrErrors.push(String(msg || '')); return null; },
    clear: () => {},
};

let registry = createActivityGuardRegistry();
function makeActivityGuardApi(reg) {
    return Object.freeze({
        acquire: reg.acquireActivityLease,
        run: reg.withActivityLease,
        hasUnloadGuard: reg.hasUnloadGuard,
        hasChatSwitchGuard: reg.hasChatSwitchGuard,
        hasKeepAliveHold: reg.hasKeepAliveHold,
        list: reg.getActiveActivities,
        subscribe: reg.subscribeActivityGuard,
    });
}

let activeRuntimeContext = null;
const eventHandlers = new Map();
const fakeEventSource = {
    on(event, fn) {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event).push(fn);
    },
    off(event, fn) {
        const list = eventHandlers.get(event) || [];
        eventHandlers.set(event, list.filter(item => item !== fn));
    },
    async emit(event, ...args) {
        for (const fn of [...(eventHandlers.get(event) || [])]) {
            await fn(...args);
        }
    },
};

const fakeEmbeddingService = {
    purgeCollection: jest.fn(async () => {}),
    listHashes: jest.fn(async () => []),
    deleteByHashes: jest.fn(async () => {}),
    insert: jest.fn(async () => {}),
};

let currentChatFile = 'chat-activity-test-0';
let chatFileSeq = 0;
let embeddingProfileMock = null;
const stateErrors = await loadStateErrorsApi();
const extensionRegistry = createExtensionRegistry();
const customLukerCtx = {
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    eventTypes: {
        CHAT_CHANGED: 'chat_id_changed',
        GENERATION_ENDED: 'generation_ended',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_RECEIVED: 'message_received',
    },
    eventSource: fakeEventSource,
    resolveChatStateTarget: () => ({
        is_group: false,
        avatar_url: 'avatar.png',
        file_name: currentChatFile,
    }),
    saveSettings: async () => ({ ok: true, status: 'saved' }),
    saveSettingsDebounced: () => {},
    extensionSettings: extensionSettingsMock,
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    worldInfoEntry: {
        template: {},
        setGlobalSelection: async () => false,
    },
    stateErrors,
    regex: {
        getScripts: () => [],
        saveScripts: () => {},
        registerManagedRegexProvider: () => ({ setScripts: () => {}, clear: () => {}, dispose: () => {} }),
    },
    getExtensionApi: extensionRegistry.getExtensionApi,
    registerExtensionApi: extensionRegistry.registerExtensionApi,
    registerCardBindingSlot: () => {},
    connectionProfiles: {
        list: () => [],
        embedding: {
            list: () => (embeddingProfileMock ? [embeddingProfileMock] : []),
            getById: (id) => (embeddingProfileMock && embeddingProfileMock.id === id ? embeddingProfileMock : null),
            upsert: () => null,
        },
        rerank: {
            list: () => [],
            getById: () => null,
            upsert: () => null,
        },
    },
    embeddingService: fakeEmbeddingService,
    translate: (s) => String(s ?? ''),
    addLocaleData: () => {},
    getCurrentLocale: () => 'en-US',
    get activityGuard() {
        return makeActivityGuardApi(registry);
    },
    get chat() {
        return activeRuntimeContext?.chat || [];
    },
    get characters() {
        return activeRuntimeContext?.characters || [];
    },
    get characterId() {
        return activeRuntimeContext?.characterId ?? null;
    },
    createFloorState(...args) {
        return activeRuntimeContext?.createFloorState?.(...args);
    },
    buildObjectPatchOperationsAsync(...args) {
        return activeRuntimeContext?.buildObjectPatchOperationsAsync?.(...args);
    },
    getChatState(...args) {
        return activeRuntimeContext?.getChatState?.(...args);
    },
    updateChatState(...args) {
        return activeRuntimeContext?.updateChatState?.(...args);
    },
    loadWorldInfo(...args) {
        return activeRuntimeContext?.loadWorldInfo?.(...args);
    },
    saveWorldInfo(...args) {
        return activeRuntimeContext?.saveWorldInfo?.(...args);
    },
    get worldNames() {
        return activeRuntimeContext?.worldNames || [];
    },
    updateWorldInfoList(...args) {
        return activeRuntimeContext?.updateWorldInfoList?.(...args);
    },
    generateTask(...args) {
        return activeRuntimeContext?.generateTask?.(...args);
    },
};

installBrowserModuleContext(() => customLukerCtx);

let main;
let resetFloorStateInstance;
let configureOverrides;
let normalizeNodeTypeSchema;
let normalizeAdvancedSettings;
let persistenceMod;

beforeAll(async () => {
    persistenceMod = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    resetFloorStateInstance = persistenceMod.resetFloorStateInstance;
    const overrides = await import('../../public/scripts/extensions/memory-graph/character-overrides.js');
    configureOverrides = overrides.configure;
    const adv = await import('../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js');
    normalizeAdvancedSettings = adv.normalizeAdvancedSettings;
    main = await import('../../public/scripts/extensions/memory-graph/main.js');
    normalizeNodeTypeSchema = main.normalizeNodeTypeSchema;
    for (const cb of domReadyCallbacks) {
        await cb();
    }
});

beforeEach(() => {
    chatFileSeq += 1;
    currentChatFile = `chat-activity-test-${chatFileSeq}`;
    registry = createActivityGuardRegistry();
    resetFloorStateInstance();
    toastrErrors.length = 0;
    toastrSuccesses.length = 0;
    toastrInfos.length = 0;
    embeddingProfileMock = null;
    fakeEmbeddingService.purgeCollection.mockReset().mockResolvedValue(undefined);
    fakeEmbeddingService.listHashes.mockReset().mockResolvedValue([]);
    fakeEmbeddingService.deleteByHashes.mockReset().mockResolvedValue(undefined);
    fakeEmbeddingService.insert.mockReset().mockResolvedValue(undefined);
    extensionSettingsMock.memory_graph = {
        ...structuredClone(main.defaultSettings),
        enabled: true,
        nodeTypeSchema: main.getDefaultNodeTypeSchema(),
        extractBatchTurns: 1,
        extractContextTurns: 1,
        extractExcludeRecentTurns: 0,
        autoCompressionEnabled: false,
        toolCallRetryMax: 0,
    };
    configureOverrides({
        MODULE_NAME: 'memory_graph',
        defaultSettings: main.defaultSettings,
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings,
        getSettings: () => extensionSettingsMock.memory_graph,
    });
});

function makeSampleChat() {
    return [
        { is_user: false, name: 'Guide', mes: 'Opening at the lighthouse.' },
        { is_user: true, name: 'User', mes: 'Let us inspect the lantern.' },
        { is_user: false, name: 'Guide', mes: 'The brass lantern glows amber.' },
    ];
}

function makeAbortError(msg = 'Aborted') {
    const err = new Error(msg);
    err.name = 'AbortError';
    return err;
}

function makeHarness(chat, onGenerate, { initialStore = null } = {}) {
    const storedState = initialStore ? structuredClone(initialStore) : {};
    const chatStateUpdates = [];
    const generateTask = jest.fn(async (opts) => onGenerate(opts));
    const context = {
        chat,
        characters: [],
        characterId: null,
        activityGuard: makeActivityGuardApi(registry),
        createFloorState: async () => ({
            ready: async () => {},
            reset: async () => ({ ok: true }),
            get: async () => ({ ok: true, state: storedState }),
        }),
        buildObjectPatchOperationsAsync: async (_before, after) => {
            Object.assign(storedState, structuredClone(after));
            return [{ op: 'replace', path: '/', value: after }];
        },
        getChatState: async () => ({ ok: true, state: initialStore ? { schemaVersion: 2 } : null }),
        updateChatState: async (ns, fn) => {
            chatStateUpdates.push(ns);
            if (typeof fn === 'function') await fn(storedState);
            return { ok: true };
        },
        loadWorldInfo: async () => ({ entries: {} }),
        saveWorldInfo: async () => {},
        worldNames: [],
        updateWorldInfoList: async () => {},
        generateTask,
    };
    activeRuntimeContext = context;
    return { context, storedState, chatStateUpdates, generateTask };
}

function doneEventResponse(summary = 'Event recorded') {
    return {
        toolCalls: [
            { name: 'luker_rpg_extract_event_create', args: { summary, links: [], no_link_reason: 'root' } },
            { name: 'luker_rpg_extract_done', args: {} },
        ],
    };
}

describe('memory-graph activity guard leases', () => {
    test('runRebuildGraph acquires memory-graph:update chat lease and aborts cleanly on chat switch cancel', async () => {
        const gate = deferred();
        let capturedSignal = null;
        const { context } = makeHarness(makeSampleChat(), async (opts) => {
            capturedSignal = opts.abortSignal;
            opts.abortSignal?.addEventListener('abort', () => gate.reject(makeAbortError()), { once: true });
            return gate.promise;
        });

        const promise = main.runRebuildGraph(context, extensionSettingsMock.memory_graph);
        await new Promise(r => setTimeout(r, 20));

        expect(registry.hasChatSwitchGuard()).toBe(true);
        expect(registry.hasUnloadGuard()).toBe(true);
        expect(registry.hasKeepAliveHold()).toBe(true);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'memory-graph:update',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardChatSwitch: true,
                guardUnload: true,
                keepAlive: true,
            }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(capturedSignal?.aborted).toBe(true);

        await promise;
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('runRebuildRecent holds memory-graph:update chat lease until completion and releases', async () => {
        const gate = deferred();
        const { context } = makeHarness(makeSampleChat(), async () => gate.promise);
        await main.ensureMemoryStoreLoaded(context);

        const promise = main.runRebuildRecent(context, 1, extensionSettingsMock.memory_graph);
        await new Promise(r => setTimeout(r, 20));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'memory-graph:update', scope: 'chat' }),
        ]);

        gate.resolve(doneEventResponse());
        await promise;

        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('runFillGraph holds memory-graph:update chat lease and aborts on cancel', async () => {
        const gate = deferred();
        let capturedSignal = null;
        const { context } = makeHarness(makeSampleChat(), async (opts) => {
            capturedSignal = opts.abortSignal;
            opts.abortSignal?.addEventListener('abort', () => gate.reject(makeAbortError()), { once: true });
            return gate.promise;
        });

        const promise = main.runFillGraph(context, extensionSettingsMock.memory_graph);
        await new Promise(r => setTimeout(r, 20));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'memory-graph:update', scope: 'chat' }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(capturedSignal?.aborted).toBe(true);
        await promise;
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('runManualCompression holds memory-graph:update chat lease and aborts on cancel', async () => {
        extensionSettingsMock.memory_graph.autoCompressionEnabled = true;
        extensionSettingsMock.memory_graph.nodeTypeSchema = [
            {
                id: 'event',
                label: 'Event',
                tableColumns: ['summary'],
                compression: { mode: 'hierarchical', fanIn: 2, keepRecentLeaves: 0 },
            },
        ];
        const initialStore = {
            version: 2,
            coveredAssistantSeq: 2,
            nodes: {
                e1: { id: 'e1', type: 'event', level: 'semantic', semanticDepth: 0, seqFrom: 1, seqTo: 1, fields: { summary: 'First' }, archived: false },
                e2: { id: 'e2', type: 'event', level: 'semantic', semanticDepth: 0, seqFrom: 2, seqTo: 2, fields: { summary: 'Second' }, archived: false },
            },
            edges: [],
        };
        const gate = deferred();
        let capturedSignal = null;
        const { context } = makeHarness(makeSampleChat(), async (opts) => {
            capturedSignal = opts.abortSignal;
            opts.abortSignal?.addEventListener('abort', () => gate.reject(makeAbortError()), { once: true });
            return gate.promise;
        }, { initialStore });

        const promise = main.runManualCompression(context, extensionSettingsMock.memory_graph, {
            selectedTypeIds: ['event'],
            mode: 'force',
            scope: 'all',
            maxRoundsPerType: 1,
        });
        await new Promise(r => setTimeout(r, 20));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'memory-graph:update', scope: 'chat' }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(capturedSignal?.aborted).toBe(true);
        await promise;
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('runScheduledExtractionPass holds memory-graph:update chat lease and aborts on cancel', async () => {
        const gate = deferred();
        let capturedSignal = null;
        const { context } = makeHarness(makeSampleChat(), async (opts) => {
            capturedSignal = opts.abortSignal;
            opts.abortSignal?.addEventListener('abort', () => gate.reject(makeAbortError()), { once: true });
            return gate.promise;
        });
        const chatKey = main.getChatKey(context);

        const promise = main.runScheduledExtractionPass(chatKey);
        await new Promise(r => setTimeout(r, 20));

        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({ source: 'memory-graph:update', scope: 'chat' }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(capturedSignal?.aborted).toBe(true);
        await promise;
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });

    test('runVectorRecomputeForChat acquires memory-graph:vector-recompute chat lease, passes signal, and handles abort without error toast', async () => {
        embeddingProfileMock = { id: 'emb-1', source: 'openai', model: 'text-embedding-3-small' };
        extensionSettingsMock.memory_graph.embeddingProfileId = 'emb-1';

        const initialStore = {
            version: 2,
            coveredAssistantSeq: 1,
            nodes: {
                e1: { id: 'e1', type: 'event', level: 'semantic', semanticDepth: 0, seqFrom: 1, seqTo: 1, fields: { summary: 'Lantern discovered' }, archived: false },
            },
            edges: [],
        };
        const gate = deferred();
        let receivedSignal = null;
        fakeEmbeddingService.insert.mockImplementation(async ({ signal }) => {
            receivedSignal = signal;
            signal?.addEventListener('abort', () => gate.reject(makeAbortError()), { once: true });
            return gate.promise;
        });

        const { context, chatStateUpdates } = makeHarness(makeSampleChat(), async () => doneEventResponse(), { initialStore });

        const promise = main.runVectorRecomputeForChat(context, 'incremental', extensionSettingsMock.memory_graph);
        await new Promise(r => setTimeout(r, 20));

        expect(receivedSignal).toBeDefined();
        expect(receivedSignal.aborted).toBe(false);
        expect(registry.getActiveActivities()).toEqual([
            expect.objectContaining({
                source: 'memory-graph:vector-recompute',
                label: expect.stringMatching(/\S/),
                scope: 'chat',
                guardChatSwitch: true,
                guardUnload: true,
                keepAlive: true,
            }),
        ]);

        registry.cancelChatSwitchActivities();
        expect(receivedSignal.aborted).toBe(true);

        await promise;
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
        expect(chatStateUpdates).toEqual([]);
    });

    test('CHAT_CHANGED aborts active vector recompute signal symmetrically with extraction', async () => {
        embeddingProfileMock = { id: 'emb-1', source: 'openai', model: 'text-embedding-3-small' };
        extensionSettingsMock.memory_graph.embeddingProfileId = 'emb-1';

        const initialStore = {
            version: 2,
            coveredAssistantSeq: 1,
            nodes: {
                e1: { id: 'e1', type: 'event', level: 'semantic', semanticDepth: 0, seqFrom: 1, seqTo: 1, fields: { summary: 'Harbor bell' }, archived: false },
            },
            edges: [],
        };
        const gate = deferred();
        let receivedSignal = null;
        fakeEmbeddingService.insert.mockImplementation(async ({ signal }) => {
            receivedSignal = signal;
            signal?.addEventListener('abort', () => gate.reject(makeAbortError()), { once: true });
            return gate.promise;
        });

        const { context } = makeHarness(makeSampleChat(), async () => doneEventResponse(), { initialStore });
        const promise = main.runVectorRecomputeForChat(context, 'incremental', extensionSettingsMock.memory_graph);
        await new Promise(r => setTimeout(r, 20));

        expect(receivedSignal?.aborted).toBe(false);
        await fakeEventSource.emit(customLukerCtx.eventTypes.CHAT_CHANGED);
        expect(receivedSignal?.aborted).toBe(true);

        await promise;
        expect(registry.getActiveActivities()).toEqual([]);
        expect(toastrErrors).toEqual([]);
    });
});
