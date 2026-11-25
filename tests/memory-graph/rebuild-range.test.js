// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeAll, beforeEach } from '@jest/globals';

globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || {
    addEventListener: () => {}, removeEventListener: () => {},
    querySelector: () => null, querySelectorAll: () => [],
};

const extensionSettingsMock = { memory_graph: {} };
const toastrErrors = [];
const toastrSuccesses = [];

globalThis.toastr = {
    info: () => null,
    success: (msg) => { toastrSuccesses.push(String(msg || '')); return null; },
    warning: () => null,
    error: (msg) => { toastrErrors.push(String(msg || '')); return null; },
    clear: () => {},
};

const baseLukerCtx = globalThis.Luker.getContext();
const customLukerCtx = new Proxy({
    constants: {
        promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
        promptTypes: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
        wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        unset: Symbol('UNSET_VALUE'),
    },
    resolveChatStateTarget: () => ({
        is_group: false,
        avatar_url: 'avatar.png',
        file_name: 'chat-rebuild-range',
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
    stateErrors: baseLukerCtx.stateErrors,
    regex: baseLukerCtx.regex,
    getExtensionApi: baseLukerCtx.getExtensionApi,
    registerExtensionApi: () => {},
    translate: (s) => String(s ?? ''),
    addLocaleData: () => {},
    getCurrentLocale: () => 'en-US',
}, {
    get(target, prop) {
        if (prop in target) return target[prop];
        return baseLukerCtx[prop];
    },
});

globalThis.Luker = { getContext: () => customLukerCtx };
globalThis.st = globalThis.Luker;
globalThis.SillyTavern = globalThis.Luker;

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

let getRebuildableRange;
let resolveStartSeqFromFloor;
let runRebuildFromFloor;
let runRebuildRecent;
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
    getRebuildableRange = main.getRebuildableRange;
    resolveStartSeqFromFloor = main.resolveStartSeqFromFloor;
    runRebuildFromFloor = main.runRebuildFromFloor;
    runRebuildRecent = main.runRebuildRecent;
    runRebuildGraph = main.runRebuildGraph;
    ensureMemoryStoreLoaded = main.ensureMemoryStoreLoaded;
    getDefaultNodeTypeSchema = main.getDefaultNodeTypeSchema;
    defaultSettings = main.defaultSettings;
    normalizeNodeTypeSchema = main.normalizeNodeTypeSchema;
});

beforeEach(() => {
    resetFloorStateInstance();
    toastrErrors.length = 0;
    toastrSuccesses.length = 0;
    extensionSettingsMock.memory_graph = {
        ...structuredClone(defaultSettings),
        nodeTypeSchema: getDefaultNodeTypeSchema(),
        extractBatchTurns: 1,
        extractContextTurns: 1,
        extractExcludeRecentTurns: 0,
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

function makeGreetingFirstChat() {
    return [
        { is_user: false, name: 'Guide', mes: 'Floor 0 opening greeting at the gate.' },
        { is_user: true, name: 'User', mes: 'Floor 1 user asks about the lantern.' },
        { is_user: false, name: 'Guide', mes: 'Floor 2 reply hands over the lantern.' },
        { is_user: true, name: 'User', mes: 'Floor 3 user opens the brass door.' },
        { is_user: false, name: 'Guide', mes: 'Floor 4 reply describes the archive room.' },
    ];
}

function createHarness(chat, onGenerate) {
    const committedPayloads = [];
    const seenPrompts = [];
    const generateTask = jest.fn(async (opts) => {
        const promptText = (opts.taskMessages || []).map(m => String(m?.content || '')).join('\n');
        seenPrompts.push(promptText);
        return onGenerate(opts, seenPrompts.length);
    });

    const context = {
        chat,
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
        generateTask,
    };

    return { context, committedPayloads, seenPrompts, generateTask };
}

function eventToolResponse(summary) {
    return {
        toolCalls: [
            { name: 'luker_rpg_extract_event_create', args: { summary, links: [], no_link_reason: 'standalone event' } },
            { name: 'luker_rpg_extract_done', args: {} },
        ],
    };
}

describe('getRebuildableRange and resolveStartSeqFromFloor', () => {
    test('computes 0-based floor bounds for greeting-first and user-first chats', () => {
        const greetingRange = getRebuildableRange({ chat: makeGreetingFirstChat() }, extensionSettingsMock.memory_graph);
        expect(greetingRange).toEqual({
            latestSeq: 3,
            minFloor: 0,
            maxFloor: 4,
            assistantFloors: [0, 2, 4],
        });

        const userFirstChat = [
            { is_user: true, name: 'User', mes: 'Hello' },
            { is_user: false, name: 'Guide', mes: 'Reply 1' },
            { is_user: true, name: 'User', mes: 'Next' },
            { is_user: false, name: 'Guide', mes: 'Reply 2' },
        ];
        expect(getRebuildableRange({ chat: userFirstChat }, extensionSettingsMock.memory_graph)).toEqual({
            latestSeq: 2,
            minFloor: 0,
            maxFloor: 3,
            assistantFloors: [1, 3],
        });
    });

    test('respects extractExcludeRecentTurns, empty assistant messages, and trailing user turns', () => {
        const chat = [
            { is_user: false, name: 'Guide', mes: 'Opening' },
            { is_user: true, name: 'User', mes: 'Ask 1' },
            { is_user: false, name: 'Guide', mes: '   ' },
            { is_user: false, name: 'Guide', mes: 'Reply 2' },
            { is_user: true, name: 'User', mes: 'Ask 2' },
            { is_user: false, name: 'Guide', mes: 'Reply 3' },
            { is_user: true, name: 'User', mes: 'Trailing user message' },
        ];
        expect(getRebuildableRange({ chat }, {
            ...extensionSettingsMock.memory_graph,
            extractExcludeRecentTurns: 1,
        })).toEqual({
            latestSeq: 2,
            minFloor: 0,
            maxFloor: 3,
            assistantFloors: [0, 3],
        });

        expect(getRebuildableRange({ chat: [{ is_user: true, name: 'User', mes: 'Only user' }] }, extensionSettingsMock.memory_graph)).toEqual({
            latestSeq: 0,
            minFloor: 0,
            maxFloor: -1,
            assistantFloors: [],
        });
    });

    test('maps assistant and user floors to 1-based assistant seq and rejects out-of-range values', () => {
        expect(resolveStartSeqFromFloor([0, 2, 4], 0)).toBe(1);
        expect(resolveStartSeqFromFloor([0, 2, 4], 1)).toBe(2);
        expect(resolveStartSeqFromFloor([0, 2, 4], 2)).toBe(2);
        expect(resolveStartSeqFromFloor([0, 2, 4], 3)).toBe(3);
        expect(resolveStartSeqFromFloor([0, 2, 4], 4)).toBe(3);
        expect(resolveStartSeqFromFloor([1, 3], 0)).toBe(1);

        expect(resolveStartSeqFromFloor([0, 2, 4], -1)).toBeNull();
        expect(resolveStartSeqFromFloor([0, 2, 4], 5)).toBeNull();
        expect(resolveStartSeqFromFloor([0, 2, 4], 1.5)).toBeNull();
        expect(resolveStartSeqFromFloor([0, 2, 4], NaN)).toBeNull();
        expect(resolveStartSeqFromFloor([], 0)).toBeNull();
    });
});

describe('runRebuildFromFloor and runRebuildRecent', () => {
    test('rebuilding from an assistant floor keeps earlier nodes and re-extracts from that floor onwards', async () => {
        let prefix = 'Initial';
        let call = 0;
        const { context, committedPayloads, generateTask } = createHarness(makeGreetingFirstChat(), () => {
            call += 1;
            return eventToolResponse(`${prefix} batch ${call}`);
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);
        expect(generateTask).toHaveBeenCalledTimes(3);

        prefix = 'Rebuilt-from-2';
        call = 0;
        generateTask.mockClear();
        await runRebuildFromFloor(context, 2, extensionSettingsMock.memory_graph);

        expect(toastrErrors).toEqual([]);
        expect(generateTask).toHaveBeenCalledTimes(2);
        const events = Object.values(committedPayloads.at(-1).nodes || {}).filter(n => n.type === 'event');
        const summaries = events.map(n => n.fields?.summary);
        expect(summaries).toContain('Initial batch 1');
        expect(summaries).not.toContain('Initial batch 2');
        expect(summaries).not.toContain('Initial batch 3');
        expect(summaries).toContain('Rebuilt-from-2 batch 1');
        expect(summaries).toContain('Rebuilt-from-2 batch 2');
    });

    test('rebuilding from a user floor starts at the following assistant turn and keeps prior floors intact', async () => {
        let prefix = 'Initial';
        let call = 0;
        const { context, committedPayloads, seenPrompts, generateTask } = createHarness(makeGreetingFirstChat(), () => {
            call += 1;
            return eventToolResponse(`${prefix} batch ${call}`);
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);

        prefix = 'Rebuilt-from-3';
        call = 0;
        seenPrompts.length = 0;
        generateTask.mockClear();
        await runRebuildFromFloor(context, 3, extensionSettingsMock.memory_graph);

        expect(toastrErrors).toEqual([]);
        expect(generateTask).toHaveBeenCalledTimes(1);
        expect(seenPrompts[0]).toContain('Floor 3 user opens the brass door.');
        expect(seenPrompts[0]).toContain('Floor 4 reply describes the archive room.');

        const summaries = Object.values(committedPayloads.at(-1).nodes || {})
            .filter(n => n.type === 'event')
            .map(n => n.fields?.summary);
        expect(summaries).toContain('Initial batch 1');
        expect(summaries).toContain('Initial batch 2');
        expect(summaries).not.toContain('Initial batch 3');
        expect(summaries).toContain('Rebuilt-from-3 batch 1');
    });

    test('rebuilding from floor 0 re-extracts every extractable assistant turn', async () => {
        let prefix = 'Initial';
        let call = 0;
        const { context, committedPayloads, generateTask } = createHarness(makeGreetingFirstChat(), () => {
            call += 1;
            return eventToolResponse(`${prefix} batch ${call}`);
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);

        prefix = 'Rebuilt-from-0';
        call = 0;
        generateTask.mockClear();
        await runRebuildFromFloor(context, 0, extensionSettingsMock.memory_graph);

        expect(toastrErrors).toEqual([]);
        expect(generateTask).toHaveBeenCalledTimes(3);
        const summaries = Object.values(committedPayloads.at(-1).nodes || {})
            .filter(n => n.type === 'event')
            .map(n => n.fields?.summary);
        expect(summaries).toEqual(['Rebuilt-from-0 batch 1', 'Rebuilt-from-0 batch 2', 'Rebuilt-from-0 batch 3']);
    });

    test('rejects invalid or excluded floor without running extraction or mutating graph', async () => {
        let call = 0;
        const { context, committedPayloads, generateTask } = createHarness(makeGreetingFirstChat(), () => {
            call += 1;
            return eventToolResponse(`Initial batch ${call}`);
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);
        const beforeCount = committedPayloads.length;
        generateTask.mockClear();

        await runRebuildFromFloor(context, 5, extensionSettingsMock.memory_graph);
        expect(toastrErrors).toHaveLength(1);
        expect(generateTask).not.toHaveBeenCalled();
        expect(committedPayloads).toHaveLength(beforeCount);

        toastrErrors.length = 0;
        await runRebuildFromFloor(context, 4, {
            ...extensionSettingsMock.memory_graph,
            extractExcludeRecentTurns: 1,
        });
        expect(toastrErrors).toHaveLength(1);
        expect(generateTask).not.toHaveBeenCalled();
        expect(committedPayloads).toHaveLength(beforeCount);
    });

    test('runRebuildRecent keeps older turns and re-extracts only the latest N assistant turns', async () => {
        let prefix = 'Initial';
        let call = 0;
        const { context, committedPayloads, generateTask } = createHarness(makeGreetingFirstChat(), () => {
            call += 1;
            return eventToolResponse(`${prefix} batch ${call}`);
        });

        await ensureMemoryStoreLoaded(context, { force: true });
        await runRebuildGraph(context, extensionSettingsMock.memory_graph);

        prefix = 'Recent';
        call = 0;
        generateTask.mockClear();
        await runRebuildRecent(context, 1, extensionSettingsMock.memory_graph);

        expect(toastrErrors).toEqual([]);
        expect(generateTask).toHaveBeenCalledTimes(1);
        const summaries = Object.values(committedPayloads.at(-1).nodes || {})
            .filter(n => n.type === 'event')
            .map(n => n.fields?.summary);
        expect(summaries).toContain('Initial batch 1');
        expect(summaries).toContain('Initial batch 2');
        expect(summaries).not.toContain('Initial batch 3');
        expect(summaries).toContain('Recent batch 1');
    });
});
