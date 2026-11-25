/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

const aliceRaw = {
    name: 'Alice',
    avatar: 'alice.png',
    data: {
        extensions: {
            regex_scripts: [{ id: 'a-1', scriptName: 'Alice Rule', findRegex: '/a/g', replaceString: 'b', placement: [1], trimStrings: [] }],
        },
    },
};
const bobRaw = {
    name: 'Bob',
    avatar: 'bob.png',
    data: {
        extensions: {
            regex_scripts: [{ id: 'b-1', scriptName: 'Bob Rule', findRegex: '/c/g', replaceString: 'd', placement: [2], trimStrings: [] }],
        },
    },
};
const charactersArray = [aliceRaw, bobRaw];
let currentCharacterId = 1;
const extensionSettings = {
    disabledExtensions: [],
    regex: [],
    character_allowed_regex: ['alice.png', 'bob.png'],
    preset_allowed_regex: {},
};

const mockPresetManager = {
    getPresetList: () => ({ preset_names: [] }),
    getSelectedPresetName: () => '',
    getStoredPreset: () => null,
    getPresetSettings: () => null,
    getCompletionPresetByName: () => null,
    readPresetExtensionField: () => null,
    writePresetExtensionField: jest.fn(async () => {}),
    updateList: jest.fn(),
    resolvePresetName: (name) => name,
    getAllPresets: () => [],
};

jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
    getPresetManager: () => mockPresetManager,
    presetManagerRegistry: { openai: mockPresetManager },
}));
jest.unstable_mockModule('fflate', () => ({
    gzipSync: () => new Uint8Array(),
    gzip: () => new Uint8Array(),
    unzlibSync: () => new Uint8Array(),
    strFromU8: () => '',
    strToU8: () => new Uint8Array(),
    default: {},
}));
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
    getPresetState: async () => null,
    listPresetDocuments: async () => [],
    readPresetDocument: async () => null,
    getPresetStateBatch: async () => ({}),
    patchPresetState: async () => ({}),
    updatePresetState: async () => ({}),
    deleteChatState: async () => {},
    deletePresetState: async () => ({}),
    deleteAllPresetState: async () => ({}),
    swipe_right: () => {},
    swipe_left: () => {},
    generateRaw: async () => '',
    generateRawData: async () => ({}),
    showSwipeButtons: () => {},
    hideSwipeButtons: () => {},
    deleteMessage: async () => {},
    refreshSwipeButtons: () => {},
    swipe: () => {},
    isSwipingAllowed: () => false,
    swipeState: {},
    ensureMessageMediaIsArray: () => [],
    getMediaDisplay: () => '',
    getMediaIndex: () => -1,
    scrollChatToBottom: () => {},
    scrollOnMediaLoad: () => {},
    getOneCharacter: async () => {},
    getCharacterSource: () => '',
    createRawPrompt: () => '',
    getGenerateUrl: () => '',
    amount_gen: 100,
    closeCurrentChat: async () => {},
    doNewChat: async () => {},
    getPastCharacterChats: async () => [],
    deleteCharacterChatByName: async () => {},
    updateCharacterData: () => {},
    persistCharacterData: async () => {},
    persistCharacterDataDebounced: () => {},
    saveSettings: async () => ({ ok: true }),
    createModelIcon: () => '',
    resolveChatStateTarget: () => ({ is_group: false, avatar_url: 'alice.png', file_name: 'chat' }),
    converter: { makeHtml: (s) => String(s ?? '') },
    sendTextareaMessage: async () => {},
    buildObjectPatchOperationsAsync: async () => [],
    settingsReady: true,
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    writeExtensionField: jest.fn(async (id, ns, value) => {
        const c = charactersArray[id];
        if (!c) return false;
        c.data ??= {};
        c.data.extensions ??= {};
        c.data.extensions[ns] = typeof value === 'function'
            ? await value(structuredClone(c.data.extensions[ns]))
            : structuredClone(value);
        return true;
    }),
    writeExtensionFieldBulk: async () => {},
    extensionNames: [],
    extension_settings: extensionSettings,
    getExtensionManifest: () => null,
    ModuleWorkerWrapper: class {},
    openThirdPartyExtensionMenu: async () => {},
    registerExtensionApi: () => {},
    getExtensionApi: () => null,
    getCharacterState: () => null,
    setCharacterState: async () => {},
    patchCharacterState: async () => {},
    updateCharacterState: async () => {},
    getCharacterStateBatch: () => ({}),
    deleteCharacterState: async () => {},
    getGlobalState: () => null,
    setGlobalState: async () => {},
    patchGlobalState: async () => {},
    updateGlobalState: async () => {},
    getGlobalStateBatch: () => ({}),
    deleteGlobalState: async () => {},
    renderExtensionTemplate: () => '',
    renderExtensionTemplateAsync: async () => '',
    saveMetadataDebounced: () => {},
    UNSET_VALUE: '__@@UNSET@@__',
}));
jest.unstable_mockModule('../../public/scripts/preset-persistence.js', () => ({
    persistPreset: async () => ({ ok: true }),
}));
jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    getChatCompletionModel: () => 'test-model',
    oai_settings: {},
    openai_settings: [],
    openai_setting_names: {},
    sendOpenAIRequest: async () => '',
    proxies: [],
    ZAI_ENDPOINT: '',
    stripOpenAIConnectionFieldsFromPreset: (p) => p,
    saveOpenAIPreset: async () => {},
    hasUnsavedOpenAIPresetChanges: () => false,
    promptManager: {},
    applyPresetByName: async () => {},
    syncSavedCharacterBoundPreset: async () => false,
    maybeApplyCharacterBoundPreset: async () => {},
    parseExampleIntoIndividual: () => [],
    getChatCompletionPreset: () => null,
    chat_completion_sources: {},
    MINIMAX_ENDPOINT: '',
    SILICONFLOW_ENDPOINT: '',
    model_list: [],
    custom_prompt_post_processing_types: {},
    tryParseStreamingError: () => null,
    createGenerationParameters: () => ({}),
    isOpenAIConnectionPresetField: () => false,
    settingsToUpdate: {},
    Message: class {},
    MessageCollection: class {},
    TokenHandler: class {},
    OpenAITtsProvider: class {},
}));
function nsStub(extra = {}) {
    return Object.assign(Object.create(null), { __esModule: true, ...extra });
}
jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/extensions/luker-tabs.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/extensions/field-help.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
    groups: [], openGroupChat: async () => {}, selected_group: null, unshallowGroupMembers: async () => {},
}));
jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    addLocaleData: () => {}, createScopedI18n: () => ({ t: (k) => k, translate: (k) => k, format: (k) => k, has: () => false }), getCurrentLocale: () => 'en-US', t: (k) => (Array.isArray(k) ? k.join('') : String(k)), translate: (k) => String(k),
}));
jest.unstable_mockModule('../../public/scripts/loader.js', () => ({ hideLoader: () => {}, showLoader: () => {} }));
jest.unstable_mockModule('../../public/scripts/action-loader.js', () => ({ loader: {} }));
jest.unstable_mockModule('../../public/scripts/macros.js', () => ({ MacrosParser: { registerMacro: () => {}, unregisterMacro: () => {} } }));
jest.unstable_mockModule('../../public/scripts/personas.js', () => ({
    getDedicatedPersonaEntriesFromCharacter: () => null,
    setCharacterDedicatedPersonaEntries: async () => {},
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: async () => '', Popup: class {}, POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 }, POPUP_TYPE: { DISPLAY: 0 },
    PopupUtils: { BuildTextWithHeader: (h, t) => `${h}\n${t ?? ''}` },
}));
jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({ power_user: {}, registerDebugFunction: () => {}, performFuzzySearch: () => [] }));
jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({ humanizedDateTime: () => '', isMobile: () => false, shouldSendOnEnter: () => true }));
jest.unstable_mockModule('../../public/scripts/scrapers.js', () => ({ ScraperManager: { registerDataBankScraper: () => {} } }));
jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({ executeSlashCommands: async () => ({}), executeSlashCommandsWithOptions: async () => ({}), registerSlashCommand: () => {} }));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: class {} }));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({ ARGUMENT_TYPE: {}, SlashCommandArgument: class {}, SlashCommandNamedArgument: class {} }));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({ SlashCommandEnumValue: class {} }));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({ SlashCommandParser: { addCommandObject: () => {} } }));
jest.unstable_mockModule('../../public/scripts/tags.js', () => ({ tag_map: {}, tags: [], importTags: () => {} }));
jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({ getTextGenServer: () => '', getTextGenGenerationData: () => ({}), textgenerationwebui_settings: {}, textgen_types: {} }));
jest.unstable_mockModule('../../public/scripts/tokenizers.js', () => ({ tokenizers: {}, tokenizer_settings: {}, getTextTokens: () => [], getTokenCount: () => 0, getTokenCountAsync: async () => 0, getTokenizerModel: () => '' }));
jest.unstable_mockModule('../../public/scripts/tool-calling.js', () => ({ ToolManager: { registerFunctionTool: () => {}, unregisterFunctionTool: () => {}, isToolCallingSupported: () => false, canPerformToolCalls: () => false } }));
jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({ accountStorage: {} }));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    areLookupNamesEqual: (a, b) => a === b,
    findCanonicalNameInList: () => '',
    timestampToMoment: () => null,
    uuidv4: () => 'test-uuid',
    importFromExternalUrl: async () => {},
    getCharaFilename: () => '',
    escapeHtml: (s) => String(s ?? ''),
    download: () => {},
    getFileText: async () => '',
    getStringHash: () => '',
    createThumbnail: async () => '',
    isValidUrl: () => false,
    equalsIgnoreCaseAndAccents: (a, b) => a === b,
    regexFromString: (s) => new RegExp(s),
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
    convertCharacterBook: () => ({}), getWorldInfoPrompt: async () => '',
    loadWorldInfo: async () => ({}), loadWorldInfoBatch: async () => ({}),
    reloadEditor: () => {}, saveWorldInfo: async () => {},
    updateWorldInfoList: async () => {},
    wi_anchor_position: {}, world_info_position: {}, world_names: [],
    getCharaAuxWorlds: () => [], createNewWorldInfo: async () => {},
    importEmbeddedWorldInfo: async () => {},
    charUpdatePrimaryWorld: async () => {},
    getCharacterEmbeddedWorld: () => null,
    newWorldInfoEntryTemplate: () => ({}), createWorldInfoEntry: async () => {},
    setWorldInfoButtonClass: () => {}, setGlobalWorldInfoSelection: () => {},
    deleteWorldInfoEntry: async () => {}, deleteWorldInfo: async () => {},
    selected_world_info: [],
    getChatWorldInfoNames: () => [], setChatWorldInfoSelection: () => {},
    getSortedEntries: async () => [],
}));
jest.unstable_mockModule('../../public/scripts/custom-request.js', () => ({ ChatCompletionService: {}, TextCompletionService: {} }));
jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({ ConnectionManagerRequestService: {} }));
jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({ getChatCompletionConnectionProfiles: () => [], resolveChatCompletionRequestProfile: () => null }));
jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({ updateReasoningUI: () => {}, parseReasoningFromString: () => ({ reasoning: '', content: '' }), getReasoningTemplateByName: () => null, removeReasoningFromString: (s) => String(s ?? '') }));
jest.unstable_mockModule('../../public/scripts/constants.js', () => ({ IGNORE_SYMBOL: Symbol('IGNORE'), inject_ids: {} }));
jest.unstable_mockModule('../../public/scripts/macros/macro-system.js', () => ({ macros: { register: () => {}, registry: { unregisterMacro: () => {} } } }));
jest.unstable_mockModule('../../public/scripts/messages.js', () => ({ addMessages: () => {}, updateMessages: () => {}, deleteMessages: () => {}, getMessage: () => null, getMessageCount: () => 0 }));
jest.unstable_mockModule('../../public/scripts/floor-state.js', () => ({ createFloorState: () => ({}) }));
jest.unstable_mockModule('../../public/scripts/generate-task.js', () => ({ generateTask: async () => ({}), generateTaskStream: async () => ({}), GenerateTaskError: class extends Error {}, resolveOpenAiStreamFlag: () => false }));
jest.unstable_mockModule('../../public/scripts/message-takeover.js', () => ({ createMessageEditorHandle: () => null, TakeoverError: class extends Error {} }));
jest.unstable_mockModule('../../public/scripts/horde.js', () => ({ generateHorde: async () => '' }));
jest.unstable_mockModule('../../public/scripts/kai-settings.js', () => ({ getKoboldGenerationData: () => ({}), kai_settings: {}, koboldai_settings: {}, koboldai_setting_names: {} }));
jest.unstable_mockModule('../../public/scripts/nai-settings.js', () => ({ getNovelGenerationData: () => ({}), nai_settings: {}, novelai_settings: {}, novelai_setting_names: {} }));
jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({ skillsApi: {} }));
jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({ SECRET_KEYS: {}, secret_state: {} }));
jest.unstable_mockModule('../../public/scripts/embedding-service.js', () => ({ EmbeddingService: class {} }));
jest.unstable_mockModule('../../public/scripts/user.js', () => ({ accountsEnabled: false, currentUser: null }));
jest.unstable_mockModule('../../public/scripts/extensions/regex/redos-reporter.js', () => ({
    isRegexScriptPaused: () => false,
    recordRegexExecution: () => {},
    resetRegexScriptState: () => {},
}));

const { getContext, unwrapCharacterApiProxy } = await import('../../public/scripts/st-context.js');

describe('real st-context CharacterApiProxy unwrapping with real regex engine', () => {
    beforeEach(() => {
        currentCharacterId = 1; // Bob is active; we target Alice's proxy
        aliceRaw.data.extensions.regex_scripts = [
            { id: 'a-1', scriptName: 'Alice Rule', findRegex: '/a/g', replaceString: 'b', placement: [1], trimStrings: [] },
        ];
        bobRaw.data.extensions.regex_scripts = [
            { id: 'b-1', scriptName: 'Bob Rule', findRegex: '/c/g', replaceString: 'd', placement: [2], trimStrings: [] },
        ];
    });

    test('real getContext().characters[0] proxy unwraps to raw character and works in getContext().regex scoped reads & writes', async () => {
        const ctx = getContext();
        const aliceProxy = ctx.characters[0];

        expect(aliceProxy).not.toBe(aliceRaw);
        expect(unwrapCharacterApiProxy(aliceProxy)).toBe(aliceRaw);
        expect(unwrapCharacterApiProxy(ctx.characters)).toBe(charactersArray);

        const readScripts = ctx.regex.getScriptsByType(ctx.regex.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: ctx.regex.SCRIPT_TYPES.SCOPED, character: aliceProxy },
        });
        expect(readScripts.map(s => s.id)).toEqual(['a-1']);

        const nextScripts = [
            ...readScripts,
            { id: 'a-2', scriptName: 'Alice Added', findRegex: '/x/g', replaceString: 'y', placement: [2], trimStrings: [] },
        ];
        await ctx.regex.saveScriptsByType(nextScripts, ctx.regex.SCRIPT_TYPES.SCOPED, {
            target: { scriptType: ctx.regex.SCRIPT_TYPES.SCOPED, character: aliceProxy },
        });

        expect(aliceRaw.data.extensions.regex_scripts.map(s => s.id)).toEqual(['a-1', 'a-2']);
        expect(bobRaw.data.extensions.regex_scripts.map(s => s.id)).toEqual(['b-1']);
    });
});
