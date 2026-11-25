// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';
import {
    createExtensionRegistry,
    installBrowserModuleContext,
    installDomReadyJQuery,
    loadStateErrorsApi,
} from '../util/browser-module-context.js';

installDomReadyJQuery();
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

const extensionSettingsMock = { memory_graph: {} };
const toastrErrors = [];

globalThis.toastr = {
    info: () => null,
    success: () => null,
    warning: () => null,
    error: (msg) => { toastrErrors.push(String(msg || '')); return null; },
    clear: () => {},
};

const stateErrors = await loadStateErrorsApi();
const extensionRegistry = createExtensionRegistry();
const customLukerCtx = {
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: () => ({
        is_group: false,
        avatar_url: 'avatar.png',
        file_name: 'chat-wi',
    }),
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
    extensionSettings: extensionSettingsMock,
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    worldInfoEntry: {
        template: {},
        setGlobalSelection: () => {},
    },
    stateErrors,
    regex: { getScripts: () => [], saveScripts: () => {} },
    getExtensionApi: extensionRegistry.getExtensionApi,
    registerExtensionApi: extensionRegistry.registerExtensionApi,
    translate: (s) => String(s ?? ''),
    addLocaleData: () => {},
    getCurrentLocale: () => 'en-US',
};

installBrowserModuleContext(customLukerCtx);

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
    getContext: () => customLukerCtx,
}));
jest.unstable_mockModule('../../public/script.js', () => ({
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    resolveChatStateTarget: customLukerCtx.resolveChatStateTarget,
    saveSettings: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: extensionSettingsMock,
    getContext: () => customLukerCtx,
    registerExtensionApi: () => {},
    UNSET_VALUE: customLukerCtx.constants.unset,
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
    world_info_position: customLukerCtx.constants.wiPosition,
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
jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

let runRebuildGraph;
let runRecallDebug;
let ensureMemoryStoreLoaded;
let getDefaultNodeTypeSchema;
let defaultSettings;
let resetFloorStateInstance;
let configureOverrides;
let normalizeNodeTypeSchema;
let normalizeAdvancedSettings;

beforeAll(async () => {
    const persistence = await import('../../public/scripts/extensions/memory-graph/persistence.js');
    resetFloorStateInstance = persistence.resetFloorStateInstance;
    const overrides = await import('../../public/scripts/extensions/memory-graph/character-overrides.js');
    configureOverrides = overrides.configure;
    const adv = await import('../../public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js');
    normalizeAdvancedSettings = adv.normalizeAdvancedSettings;
    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    runRebuildGraph = main.runRebuildGraph;
    runRecallDebug = main.runRecallDebug;
    ensureMemoryStoreLoaded = main.ensureMemoryStoreLoaded;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
    defaultSettings = main.defaultSettings;
    normalizeNodeTypeSchema = main.normalizeNodeTypeSchema;
});

function buildHarness(overrides = {}) {
    resetFloorStateInstance();
    toastrErrors.length = 0;
    extensionSettingsMock.memory_graph = {
        ...structuredClone(defaultSettings),
        nodeTypeSchema: getDefaultNodeTypeSchema(),
        extractBatchTurns: 1,
        extractContextTurns: 1,
        autoCompressionEnabled: false,
        recallMethod: 'llm',
        toolCallRetryMax: 0,
        ...overrides,
    };
    configureOverrides({
        MODULE_NAME: 'memory_graph',
        defaultSettings,
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings,
        getSettings: () => extensionSettingsMock.memory_graph,
    });

    const committedPayloads = [];
    const observedWorldInfoByCall = [];
    const resolveWorldInfoForMessages = jest.fn(async () => ({
        worldInfoBeforeEntries: ['LORE_BEFORE_ENTRY'],
        worldInfoAfterEntries: [],
        worldInfoDepth: [],
        outletEntries: {},
        worldInfoExamples: [],
        anBefore: [],
        anAfter: [],
    }));

    const context = {
        chat: [
            { is_user: true, name: 'User', mes: 'Tell me about the northern lighthouse.' },
            { is_user: false, name: 'Guide', mes: 'Elena guards the northern lighthouse every winter.' },
        ],
        characters: [],
        characterId: null,
        worldNames: [],
        createFloorState: async () => ({
            ready: async () => {},
            reset: async () => ({ ok: true }),
            get: async () => ({ ok: true, state: committedPayloads.at(-1) || {} }),
        }),
        buildObjectPatchOperationsAsync: async (_before, after) => {
            committedPayloads.push(structuredClone(after));
            return [{ op: 'replace', path: '/', value: after }];
        },
        getChatState: async () => ({ ok: true, state: null }),
        updateChatState: async () => ({ ok: true }),
        loadWorldInfo: async () => ({ entries: {} }),
        saveWorldInfo: async () => {},
        updateWorldInfoList: async () => {},
        resolveWorldInfoForMessages,
        generateTask: jest.fn(async (opts) => {
            const toolNames = (opts.tools || []).map(t => t.function.name);
            const kind = toolNames.includes('luker_rpg_recall_plan') ? 'recall' : 'extract';
            observedWorldInfoByCall.push({ kind, runtimeWorldInfo: opts.runtimeWorldInfo });

            if (kind === 'extract') {
                return {
                    toolCalls: [
                        {
                            name: 'luker_rpg_extract_character_sheet_create',
                            args: { ref: 'c1', title: 'Elena', identity: 'Lighthouse keeper' },
                        },
                        {
                            name: 'luker_rpg_extract_event_create',
                            args: {
                                summary: '时间: Day 1 09:00\n地点: Harbor\n\nLearned Elena guards the lighthouse.',
                                links: [{ target_ref: 'c1', relation: 'mentions', direction: 'outgoing' }],
                            },
                        },
                        { name: 'luker_rpg_extract_done', args: {} },
                    ],
                };
            }
            return {
                toolCalls: [{
                    name: 'luker_rpg_recall_plan',
                    args: { action: 'finalize', selected_node_ids: [], reason: 'done' },
                }],
            };
        }),
    };

    return { context, observedWorldInfoByCall, resolveWorldInfoForMessages };
}

describe('independent extraction and recall world-info toggles', () => {
    beforeEach(() => {
        resetFloorStateInstance();
    });

    test('extractIncludeWorldInfo=false skips world info on extraction while recallIncludeWorldInfo=true attaches it on LLM recall', async () => {
        const { context, observedWorldInfoByCall, resolveWorldInfoForMessages } = buildHarness({
            extractIncludeWorldInfo: false,
            recallIncludeWorldInfo: true,
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);
        await runRecallDebug(context, 'Where is Elena?');

        expect(toastrErrors).toEqual([]);
        const extractCall = observedWorldInfoByCall.find(c => c.kind === 'extract');
        const recallCall = observedWorldInfoByCall.find(c => c.kind === 'recall');
        expect(extractCall).toBeTruthy();
        expect(recallCall).toBeTruthy();
        expect(extractCall.runtimeWorldInfo).toEqual({});
        expect(recallCall.runtimeWorldInfo.worldInfoBeforeEntries).toEqual(['LORE_BEFORE_ENTRY']);
        expect(resolveWorldInfoForMessages).toHaveBeenCalledTimes(1);
    });

    test('extractIncludeWorldInfo=true attaches world info on extraction while recallIncludeWorldInfo=false skips it on LLM recall', async () => {
        const { context, observedWorldInfoByCall, resolveWorldInfoForMessages } = buildHarness({
            extractIncludeWorldInfo: true,
            recallIncludeWorldInfo: false,
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);
        await runRecallDebug(context, 'Where is Elena?');

        expect(toastrErrors).toEqual([]);
        const extractCall = observedWorldInfoByCall.find(c => c.kind === 'extract');
        const recallCall = observedWorldInfoByCall.find(c => c.kind === 'recall');
        expect(extractCall).toBeTruthy();
        expect(recallCall).toBeTruthy();
        expect(extractCall.runtimeWorldInfo.worldInfoBeforeEntries).toEqual(['LORE_BEFORE_ENTRY']);
        expect(recallCall.runtimeWorldInfo).toEqual({});
        expect(resolveWorldInfoForMessages).toHaveBeenCalledTimes(1);
    });
});
