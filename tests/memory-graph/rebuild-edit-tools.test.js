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
        file_name: 'chat',
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
    ensureMemoryStoreLoaded = main.ensureMemoryStoreLoaded;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
    defaultSettings = main.defaultSettings;
    normalizeNodeTypeSchema = main.normalizeNodeTypeSchema;
});

beforeEach(() => {
    resetFloorStateInstance();
    toastrErrors.length = 0;
    extensionSettingsMock.memory_graph = {
        ...structuredClone(defaultSettings),
        nodeTypeSchema: getDefaultNodeTypeSchema(),
        extractBatchTurns: 1,
        extractContextTurns: 1,
        autoCompressionEnabled: false,
        toolCallRetryMax: 0,
    };
    configureOverrides({
        MODULE_NAME: 'memory_graph',
        defaultSettings,
        normalizeNodeTypeSchema,
        normalizeAdvancedSettings,
        getSettings: () => extensionSettingsMock.memory_graph,
    });
});

function parseGraphDataFromMessages(taskMessages) {
    const tail = taskMessages[taskMessages.length - 1]?.content || '';
    const match = tail.match(/<graph_data>\s*([\s\S]*?)\s*<\/graph_data>/);
    return match ? JSON.parse(match[1]) : null;
}

describe('full rebuild exposes edit tools for editable node types', () => {
    test('batch 2 of runRebuildGraph provides thread_edit, keeps event create-only, and persists thread status update', async () => {
        const committedPayloads = [];
        const seenToolsByBatch = [];
        let batchIndex = 0;

        const context = {
            chat: [
                { is_user: true, name: 'User', mes: 'Let us search for the missing cellar key.' },
                { is_user: false, name: 'Guide', mes: 'I promise to help find the cellar key before nightfall.' },
                { is_user: true, name: 'User', mes: 'Look under the loose stone.' },
                { is_user: false, name: 'Guide', mes: 'We found the cellar key and unlocked the door.' },
            ],
            characters: [],
            characterId: null,
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
            worldNames: [],
            updateWorldInfoList: async () => {},
            generateTask: jest.fn(async (opts) => {
                batchIndex += 1;
                const toolNames = (opts.tools || []).map(t => t.function.name);
                seenToolsByBatch.push(toolNames);

                if (batchIndex === 1) {
                    return {
                        toolCalls: [
                            {
                                name: 'luker_rpg_extract_thread_create',
                                args: {
                                    ref: 't1',
                                    title: 'Find cellar key',
                                    status: 'active',
                                    note: 'Need to find the cellar key before nightfall.',
                                },
                            },
                            {
                                name: 'luker_rpg_extract_event_create',
                                args: {
                                    summary: '时间: Day 1 10:00\n地点: Courtyard\n\nAgreed to search for the cellar key.',
                                    links: [{ target_ref: 't1', relation: 'advances', direction: 'outgoing' }],
                                },
                            },
                            { name: 'luker_rpg_extract_done', args: {} },
                        ],
                    };
                }

                const graphData = parseGraphDataFromMessages(opts.taskMessages);
                const threadNode = graphData?.nodes?.find(n => n.type === 'thread');
                expect(threadNode).toBeTruthy();

                return {
                    toolCalls: [
                        {
                            name: 'luker_rpg_extract_thread_edit',
                            args: {
                                node_id: threadNode.id,
                                set_fields: {
                                    status: 'resolved',
                                    note: 'Cellar key found under the loose stone.',
                                },
                            },
                        },
                        {
                            name: 'luker_rpg_extract_event_create',
                            args: {
                                summary: '时间: Day 1 11:00\n地点: Courtyard\n\nFound the cellar key and unlocked the door.',
                                links: [{ target_node_id: threadNode.id, relation: 'advances', direction: 'outgoing' }],
                            },
                        },
                        { name: 'luker_rpg_extract_done', args: {} },
                    ],
                };
            }),
        };

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);

        expect(toastrErrors).toEqual([]);
        expect(seenToolsByBatch).toHaveLength(2);
        for (const toolNames of seenToolsByBatch) {
            expect(toolNames).toContain('luker_rpg_extract_thread_edit');
            expect(toolNames).toContain('luker_rpg_extract_thread_delete');
            expect(toolNames).toContain('luker_rpg_extract_character_sheet_edit');
            expect(toolNames).toContain('luker_rpg_extract_location_state_edit');
            expect(toolNames).not.toContain('luker_rpg_extract_event_edit');
            expect(toolNames).not.toContain('luker_rpg_extract_event_delete');
        }

        const finalPayload = committedPayloads.at(-1);
        const threads = Object.values(finalPayload.nodes || {}).filter(n => n.type === 'thread');
        expect(threads).toHaveLength(1);
        expect(threads[0].fields.status).toBe('resolved');
        expect(threads[0].fields.note).toBe('Cellar key found under the loose stone.');
    });
});
