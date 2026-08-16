/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// ctx-selected-live-state exercises st-context.js's origin-aware
// getSelected/getLive, plus client-only composite state.* key prefixing.
//
// Mock graph mirrors tests/character-presets/ctx-dispatch.test.js.
// DOM extras: #settings_preset_openai <select>, populated per-test.

import { jest } from '@jest/globals';

// jsdom (Node <17 semantics for this jest version) doesn't expose
// structuredClone on globalThis; st-context.js's safeClone falls back to
// its `{}` fallback and quietly drops the body. Polyfill via JSON clone
// which is sufficient for the preset-body shapes in these tests.
if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

const character = { avatar: 'Aqua.png', data: { extensions: {} } };
const charactersArray = [character];
let currentCharacterId = 0;

const mockPresetManager = {
    getPresetList: () => ({ preset_names: ['GlobalA', 'GlobalB'] }),
    getSelectedPresetName: () => 'GlobalA',
    getStoredPreset: (name) => ({ temperature: 0.5, __from: `global:${name}` }),
    getPresetSettings: (name) => ({ temperature: 0.5, __from: `live:${name}` }),
    getCompletionPresetByName: (name) => name === 'GlobalOnly' ? { temperature: 0.9 } : null,
    readPresetExtensionField: () => null,
    writePresetExtensionField: jest.fn(async () => {}),
    updateList: jest.fn(),
    resolvePresetName: (name) => name,
    getAllPresets: () => ['GlobalA', 'GlobalB'],
};
jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
    getPresetManager: (apiId) => (apiId === 'openai' || apiId === undefined || apiId === '' ? mockPresetManager : null),
    presetManagerRegistry: { openai: mockPresetManager },
}));

// Under `@jest-environment jsdom`, fflate (transitively pulled by
// tests/util/lib-stub.js → public/lib.js) resolves its `browser` ESM entry,
// which Jest can't parse without a transform. Force it back to the CJS
// entry via a direct mock — st-context.js does not exercise fflate in the
// paths under test.
jest.unstable_mockModule('fflate', () => ({
    gzipSync: () => new Uint8Array(),
    gzip: () => new Uint8Array(),
    unzlibSync: () => new Uint8Array(),
    strFromU8: () => '',
    strToU8: () => new Uint8Array(),
    default: {},
}));

// script.js — same enumeration as ctx-dispatch.test.js; state.* fns are
// jest.fn(async) so we can inspect the target payload the ctx layer passes.
const getPresetState = jest.fn(async () => null);
const getPresetStateBatch = jest.fn(async () => ({}));
const patchPresetState = jest.fn(async () => ({}));
const updatePresetState = jest.fn(async () => ({}));
const deletePresetState = jest.fn(async () => ({}));
const deleteAllPresetState = jest.fn(async () => ({}));

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: charactersArray,
    get this_chid() { return currentCharacterId; },
    activateSendButtons: () => {},
    addOneMessage: () => {},
    appendMediaToMessage: () => {},
    callPopup: () => Promise.resolve(''),
    chat: [],
    chat_metadata: {},
    CONNECT_API_MAP: {},
    create_save: {},
    deactivateSendButtons: () => {},
    event_types: {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {}, once: () => {}, emitAndWait: () => Promise.resolve() },
    extension_prompts: {},
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extractMessageFromData: () => '',
    Generate: () => Promise.resolve(),
    generateQuietPrompt: () => Promise.resolve(''),
    getCharacters: () => Promise.resolve(),
    getCurrentChatId: () => null,
    getRequestHeaders: () => ({}),
    getThumbnailUrl: () => '',
    main_api: 'openai',
    max_context: 4096,
    menu_type: '',
    messageFormatting: (s) => String(s ?? ''),
    name1: 'You',
    name2: 'Char',
    online_status: 'no_connection',
    openCharacterChat: () => Promise.resolve(),
    reloadCurrentChat: () => Promise.resolve(),
    renameChat: () => Promise.resolve(),
    saveChatConditional: () => Promise.resolve(),
    saveChatDebounced: () => {},
    saveMetadata: () => Promise.resolve(),
    saveReply: () => Promise.resolve(),
    saveSettingsDebounced: () => {},
    selectCharacterById: () => Promise.resolve(),
    sendGenerationRequest: () => Promise.resolve(),
    sendStreamingRequest: () => Promise.resolve(),
    sendSystemMessage: () => {},
    setExtensionPrompt: () => {},
    stopGeneration: () => {},
    streamingProcessor: null,
    substituteParams: (s) => String(s ?? ''),
    substituteParamsExtended: (s) => String(s ?? ''),
    updateChatMetadata: () => {},
    updateMessageBlock: () => {},
    printMessages: () => {},
    clearChat: () => {},
    unshallowCharacter: () => Promise.resolve(),
    deleteLastMessage: () => Promise.resolve(),
    getCharacterCardFields: () => ({}),
    buildWorldInfoChatInput: () => ({}),
    buildWorldInfoGlobalScanData: () => ({}),
    simulateWorldInfoActivation: () => Promise.resolve({}),
    getActiveWorldInfoPromptFields: () => ({}),
    appendChatMessages: () => {},
    patchChatMessages: () => {},
    saveChatMetadata: () => Promise.resolve(),
    getChatState: () => null,
    getChatStateBatch: () => ({}),
    patchChatState: () => Promise.resolve(),
    updateChatState: () => Promise.resolve(),
    setVariable: () => {},
    getPresetState,
    getPresetStateBatch,
    patchPresetState,
    updatePresetState,
    deleteChatState: () => Promise.resolve(),
    deletePresetState,
    deleteAllPresetState,
    swipe_right: () => {},
    swipe_left: () => {},
    generateRaw: () => Promise.resolve(''),
    generateRawData: () => Promise.resolve({}),
    showSwipeButtons: () => {},
    hideSwipeButtons: () => {},
    deleteMessage: () => Promise.resolve(),
    refreshSwipeButtons: () => {},
    swipe: () => {},
    isSwipingAllowed: () => false,
    swipeState: {},
    ensureMessageMediaIsArray: () => [],
    getMediaDisplay: () => '',
    getMediaIndex: () => -1,
    scrollChatToBottom: () => {},
    scrollOnMediaLoad: () => {},
    getOneCharacter: () => Promise.resolve(),
    getCharacterSource: () => '',
    createRawPrompt: () => '',
    getGenerateUrl: () => '',
    amount_gen: 100,
    closeCurrentChat: () => Promise.resolve(),
    doNewChat: () => Promise.resolve(),
    getPastCharacterChats: () => Promise.resolve([]),
    deleteCharacterChatByName: () => Promise.resolve(),
    updateCharacterData: () => {},
    persistCharacterData: () => Promise.resolve(),
    persistCharacterDataDebounced: () => {},
    saveSettings: () => Promise.resolve(),
    createModelIcon: () => '',
    resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'a.png', file_name: 'chat' }),
    converter: { makeHtml: (s) => String(s ?? '') },
    sendTextareaMessage: () => Promise.resolve(),
    buildObjectPatchOperationsAsync: () => Promise.resolve([]),
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    writeExtensionField: jest.fn(async (id, ns, value) => {
        const c = charactersArray[id];
        if (!c) throw new Error(`test-writeExtensionField: no character at id=${id}`);
        if (!c.data) c.data = {};
        if (!c.data.extensions) c.data.extensions = {};
        c.data.extensions[ns] = value;
    }),
    writeExtensionFieldBulk: async () => {},
    extension_settings: {},
    getExtensionManifest: () => null,
    ModuleWorkerWrapper: class {},
    openThirdPartyExtensionMenu: () => Promise.resolve(),
    registerExtensionApi: () => {},
    getExtensionApi: () => null,
    getCharacterState: () => null,
    setCharacterState: () => Promise.resolve(),
    patchCharacterState: () => Promise.resolve(),
    updateCharacterState: () => Promise.resolve(),
    getCharacterStateBatch: () => ({}),
    deleteCharacterState: () => Promise.resolve(),
    renderExtensionTemplate: () => '',
    renderExtensionTemplateAsync: () => Promise.resolve(''),
    saveMetadataDebounced: () => {},
    UNSET_VALUE: Symbol('UNSET_VALUE'),
}));

jest.unstable_mockModule('../../public/scripts/preset-persistence.js', () => ({
    persistPreset: jest.fn(async ({ name }) => ({ ok: true, mode: 'update', operations: [], response: null, data: { name } })),
}));

jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    getChatCompletionModel: () => 'test-model',
    oai_settings: {},
    openai_settings: [],
    openai_setting_names: {},
    sendOpenAIRequest: () => Promise.resolve(''),
    proxies: [],
    ZAI_ENDPOINT: '',
    stripOpenAIConnectionFieldsFromPreset: (p) => (p && typeof p === 'object') ? { ...p } : p,
    saveOpenAIPreset: () => Promise.resolve(),
    hasUnsavedOpenAIPresetChanges: () => false,
    promptManager: {},
    applyPresetByName: () => Promise.resolve(),
    parseExampleIntoIndividual: () => [],
    getChatCompletionPreset: () => null,
    chat_completion_sources: {},
    MINIMAX_ENDPOINT: '',
    SILICONFLOW_ENDPOINT: '',
    model_list: [],
    custom_prompt_post_processing_types: {},
    getStreamingReply: () => '',
    tryParseStreamingError: () => null,
    createGenerationParameters: () => ({}),
    isOpenAIConnectionPresetField: () => false,
    settingsToUpdate: {},
    Message: class {},
    MessageCollection: class {},
    TokenHandler: class {},
    OpenAITtsProvider: class {},
}));

const noop = () => undefined;
function nsStub(extra = {}) {
    return new Proxy({ ...extra }, {
        get(t, prop) {
            if (prop in t) return t[prop];
            if (prop === '__esModule') return true;
            if (prop === 'then') return undefined;
            if (prop === Symbol.toStringTag) return 'Module';
            if (typeof prop === 'symbol') return undefined;
            return noop;
        },
    });
}

jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/extensions/luker-tabs.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/extensions/field-help.js', () => nsStub());

jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    groups: [], openGroupChat: () => Promise.resolve(), selected_group: null, unshallowGroupMembers: () => Promise.resolve(),
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {}, getCurrentLocale: () => 'en-US', t: (k) => k, translate: (k) => k,
}));
jest.unstable_mockModule('../../public/scripts/loader.js', () => ({
    hideLoader: () => {}, showLoader: () => {},
}));
jest.unstable_mockModule('../../public/scripts/action-loader.js', () => ({
    loader: {},
}));
jest.unstable_mockModule('../../public/scripts/macros.js', () => ({
    MacrosParser: { registerMacro: () => {}, unregisterMacro: () => {} },
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: () => Promise.resolve(''), Popup: class {}, POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 }, POPUP_TYPE: { DISPLAY: 0 },
}));
jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: {}, registerDebugFunction: () => {}, performFuzzySearch: () => [],
}));
jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
    humanizedDateTime: () => '', isMobile: () => false, shouldSendOnEnter: () => true,
}));
jest.unstable_mockModule('../../public/scripts/scrapers.js', () => ({
    ScraperManager: { registerDataBankScraper: () => {} },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({
    executeSlashCommands: () => Promise.resolve({}), executeSlashCommandsWithOptions: () => Promise.resolve({}), registerSlashCommand: () => {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: {}, SlashCommandArgument: class {}, SlashCommandNamedArgument: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
    SlashCommandEnumValue: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: () => {} },
}));
jest.unstable_mockModule('../../public/scripts/tags.js', () => ({
    tag_map: {}, tags: [], importTags: () => {},
}));
jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
    getTextGenServer: () => '', getTextGenGenerationData: () => ({}), textgenerationwebui_settings: {}, textgen_types: {},
}));
jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({
    tokenizers: {}, tokenizer_settings: {}, getTextTokens: () => [], getTokenCount: () => 0, getTokenCountAsync: async () => 0, getTokenizerModel: () => '',
}));
jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({
    ToolManager: {
        registerFunctionTool: () => {}, unregisterFunctionTool: () => {},
        isToolCallingSupported: () => false, canPerformToolCalls: () => false,
    },
}));
jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: {},
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    areLookupNamesEqual: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
    findCanonicalNameInList: (list, name) => {
        const cleaned = String(name ?? '').trim().toLowerCase();
        if (!cleaned || !Array.isArray(list)) return '';
        return list.find(n => String(n ?? '').trim().toLowerCase() === cleaned) || '';
    },
    timestampToMoment: () => null,
    uuidv4: () => 'test-uuid',
    importFromExternalUrl: () => Promise.resolve(),
    getCharaFilename: () => '',
    escapeHtml: (s) => String(s ?? ''),
    download: () => {},
    getFileText: () => Promise.resolve(''),
    getStringHash: () => '',
    createThumbnail: () => Promise.resolve(''),
    isValidUrl: () => false,
}));
jest.unstable_mockModule('../../public/scripts/variables.js', () => ({
    addGlobalVariable: () => {}, addLocalVariable: () => {},
    decrementGlobalVariable: () => {}, decrementLocalVariable: () => {},
    deleteGlobalVariable: () => {}, deleteLocalVariable: () => {},
    existsGlobalVariable: () => false, existsLocalVariable: () => false,
    getGlobalVariable: () => null, getLocalVariable: () => null,
    incrementGlobalVariable: () => {}, incrementLocalVariable: () => {},
    popLocalVariable: () => null, pushLocalVariable: () => {},
    setGlobalVariable: () => {}, setLocalVariable: () => {},
}));
jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    convertCharacterBook: () => ({}), getWorldInfoPrompt: () => Promise.resolve(''),
    loadWorldInfo: () => Promise.resolve({}), loadWorldInfoBatch: () => Promise.resolve({}),
    reloadEditor: () => {}, saveWorldInfo: () => Promise.resolve(),
    updateWorldInfoList: () => Promise.resolve(),
    wi_anchor_position: {}, world_info_position: {}, world_names: [],
    getCharaAuxWorlds: () => [], createNewWorldInfo: () => Promise.resolve(),
    importEmbeddedWorldInfo: () => Promise.resolve(),
    charUpdatePrimaryWorld: () => Promise.resolve(),
    getCharacterEmbeddedWorld: () => null,
    newWorldInfoEntryTemplate: () => ({}), createWorldInfoEntry: () => Promise.resolve(),
    setWorldInfoButtonClass: () => {}, setGlobalWorldInfoSelection: () => {},
    deleteWorldInfoEntry: () => Promise.resolve(), selected_world_info: [],
    getChatWorldInfoNames: () => [], setChatWorldInfoSelection: () => {},
    getSortedEntries: () => Promise.resolve([]),
}));
jest.unstable_mockModule('../../public/scripts/custom-request.js', () => ({
    ChatCompletionService: {}, TextCompletionService: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
    ConnectionManagerRequestService: {},
}));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [], resolveChatCompletionRequestProfile: () => null,
}));
jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
    updateReasoningUI: () => {}, parseReasoningFromString: () => ({ reasoning: '', content: '' }),
    getReasoningTemplateByName: () => null, removeReasoningFromString: (s) => String(s ?? ''),
}));
jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
    IGNORE_SYMBOL: Symbol('IGNORE'), inject_ids: {},
}));
jest.unstable_mockModule('../../public/scripts/macros/macro-system.js', () => ({
    macros: { register: () => {}, registry: { unregisterMacro: () => {} } },
}));
jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (s) => String(s ?? ''), regex_placement: {},
}));
jest.unstable_mockModule('../../public/scripts/messages.js', () => ({
    addMessages: () => {}, updateMessages: () => {}, deleteMessages: () => {},
    getMessage: () => null, getMessageCount: () => 0,
}));
jest.unstable_mockModule('../../public/scripts/floor-state.js', () => ({
    createFloorState: () => ({}),
}));
jest.unstable_mockModule('../../public/scripts/generate-task.js', () => ({
    generateTask: () => Promise.resolve({}), generateTaskStream: () => Promise.resolve({}),
    GenerateTaskError: class extends Error {}, resolveOpenAiStreamFlag: () => false,
}));
jest.unstable_mockModule('../../public/scripts/message-takeover.js', () => ({
    createMessageEditorHandle: () => null, TakeoverError: class extends Error {},
}));
jest.unstable_mockModule('../../public/scripts/horde.js', () => ({
    generateHorde: () => Promise.resolve(''),
}));
jest.unstable_mockModule('../../public/scripts/kai-settings.js', () => ({
    getKoboldGenerationData: () => ({}), kai_settings: {}, koboldai_settings: {}, koboldai_setting_names: {},
}));
jest.unstable_mockModule('../../public/scripts/nai-settings.js', () => ({
    getNovelGenerationData: () => ({}), nai_settings: {}, novelai_settings: {}, novelai_setting_names: {},
}));
jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({
    skillsApi: {},
}));
jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {}, secret_state: {},
}));
jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

const { getContext } = await import('../../public/scripts/st-context.js');
const characterPresets = await import('../../public/scripts/character/presets.js');
const { encodeCardBoundOptionValue } = await import('../../public/scripts/character/preset-ref-codec.js');

beforeEach(() => {
    character.data.extensions = {};
    currentCharacterId = 0;
    document.body.innerHTML = '<select id="settings_preset_openai"><option value="GlobalA">GlobalA</option></select>';
    getPresetState.mockClear();
    getPresetStateBatch.mockClear();
    patchPresetState.mockClear();
    updatePresetState.mockClear();
    deletePresetState.mockClear();
    deleteAllPresetState.mockClear();
});

// -------------------- getSelected origin (openai only) --------------------

test('getSelected returns origin:global for normal option value', () => {
    document.querySelector('#settings_preset_openai').value = 'GlobalA';
    const ctx = getContext();
    const ref = ctx.presets.getSelected('openai');
    expect(ref.origin).toEqual({ kind: 'global' });
    expect(ref.name).toBe('GlobalA');
});

test('getSelected returns origin:character for __luker_card__ option value', async () => {
    const boundChar = getContext().characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'CardOnly', { temperature: 0.7 });
    const select = document.querySelector('#settings_preset_openai');
    const opt = document.createElement('option');
    opt.value = encodeCardBoundOptionValue('Aqua.png', 'CardOnly');
    opt.textContent = 'CardOnly';
    select.appendChild(opt);
    select.value = opt.value;

    const ctx = getContext();
    const ref = ctx.presets.getSelected('openai');
    expect(ref).toEqual({
        collection: 'openai',
        name: 'CardOnly',
        origin: { kind: 'character', avatar: 'Aqua.png' },
    });
});

test('getSelected on non-openai collection unaffected (never decodes)', () => {
    // Non-openai collections have no live manager (textgen mock omitted the
    // preset manager); the call resolves via normalizePresetRef path.
    const ctx = getContext();
    const ref = ctx.presets.getSelected('textgenerationwebui');
    expect(ref).toBeNull();
});

// -------------------- getLive stored:true for card-bound --------------------

test('getLive marks card-bound selected as stored:true source:character', async () => {
    const boundChar = getContext().characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'CardOnly', { temperature: 0.7 });
    const select = document.querySelector('#settings_preset_openai');
    const opt = document.createElement('option');
    opt.value = encodeCardBoundOptionValue('Aqua.png', 'CardOnly');
    opt.textContent = 'CardOnly';
    select.appendChild(opt);
    select.value = opt.value;

    const ctx = getContext();
    const live = ctx.presets.getLive('openai');
    expect(live.stored).toBe(true);
    expect(live.source).toBe('character');
    expect(live.ref.origin).toEqual({ kind: 'character', avatar: 'Aqua.png' });
    expect(live.body.temperature).toBe(0.7);
});

test('getLive global path unchanged (source:live, stored true when name in list)', () => {
    document.querySelector('#settings_preset_openai').value = 'GlobalA';
    const ctx = getContext();
    const live = ctx.presets.getLive('openai');
    expect(live.source).toBe('live');
    expect(live.stored).toBe(true);
    expect(live.ref.origin).toEqual({ kind: 'global' });
});

// -------------------- state.* composite key (client-only) --------------------

test('state.get with character ref prefixes avatar into name (client-only)', async () => {
    const ctx = getContext();
    await ctx.presets.state.get('cpa_session', {
        target: { collection: 'openai', name: 'Same', origin: { kind: 'character', avatar: 'Aqua.png' } },
    });
    const call = getPresetState.mock.calls[0];
    expect(call[1].target.name).toBe('__lc__::' + encodeURIComponent('Aqua.png') + '::Same');
    expect(call[1].target.apiId).toBe('openai');
});

test('state.get with global ref sends plain name (unchanged)', async () => {
    const ctx = getContext();
    await ctx.presets.state.get('cpa_session', {
        target: { collection: 'openai', name: 'GlobalA', origin: { kind: 'global' } },
    });
    const call = getPresetState.mock.calls[0];
    expect(call[1].target.name).toBe('GlobalA');
});

test('state.update with character ref same client-only prefix', async () => {
    const ctx = getContext();
    await ctx.presets.state.update('cpa_session', () => ({ v: 1 }), {
        target: { collection: 'openai', name: 'Same', origin: { kind: 'character', avatar: 'Aqua.png' } },
    });
    const call = updatePresetState.mock.calls[0];
    expect(call[2].target.name).toBe('__lc__::' + encodeURIComponent('Aqua.png') + '::Same');
});

test('state key round-trips: same character + name always maps to same composite key', async () => {
    const ctx = getContext();
    await ctx.presets.state.get('cpa_session', {
        target: { collection: 'openai', name: 'Same', origin: { kind: 'character', avatar: 'Aqua.png' } },
    });
    await ctx.presets.state.get('cpa_session', {
        target: { collection: 'openai', name: 'Same', origin: { kind: 'character', avatar: 'Aqua.png' } },
    });
    const call1 = getPresetState.mock.calls[0][1].target.name;
    const call2 = getPresetState.mock.calls[1][1].target.name;
    expect(call1).toBe(call2);
});
