// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

// -------------------------------------------------------------------------
// One-and-only character fixture used by every test in this file.  Layer 1
// looks it up via `getContext().characters.indexOf(character)`; the mocked
// `../../public/script.js` module below exports this same array reference so
// identity survives.  st-context.js wraps the raw list in a Proxy that
// returns per-element wrapping proxies (cached, so `wrappedA === wrappedA`
// across reads).  Test code drives `ctx.presets.*` with wrapped elements
// (fetched via `ctx.characters[0]`) so `indexOf` in Layer 1 sees a hit.
// -------------------------------------------------------------------------
const character = { avatar: 'Aqua.png', data: { extensions: {} } };
const charactersArray = [character];
let currentCharacterId = 0;

// -------------------------------------------------------------------------
// preset-manager mock
// -------------------------------------------------------------------------
const mockPresetManager = {
    getPresetList: () => ({ preset_names: ['GlobalA', 'GlobalB'] }),
    getSelectedPresetName: () => 'GlobalA',
    getStoredPreset: (name) => ({ temperature: 0.5, __from: `global:${name}` }),
    getPresetSettings: (name) => ({ temperature: 0.5, __from: `live:${name}` }),
    getCompletionPresetByName: (name) => name === 'GlobalOnly' ? { temperature: 0.9 } : null,
    readPresetExtensionField: () => null,
    writePresetExtensionField: jest.fn(async () => {}),
    updateList: jest.fn(),
};
jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
    getPresetManager: () => mockPresetManager,
    presetManagerRegistry: { openai: mockPresetManager },
    // A few oai_settings-related helpers preset-manager.js may re-export.
    // The st-context.js import site only takes `getPresetManager`, so any
    // additional names live-mocked here are defensive — stripping them
    // avoids polluting the surface.
}));

// -------------------------------------------------------------------------
// script.js mock — st-context.js pulls ~105 named imports from ../script.js.
// A Proxy factory doesn't satisfy ESM link-time named-export validation, so
// enumerate every symbol as a data value or callable no-op.  Only
// `characters` + `this_chid` are live; the rest are structurally-shaped
// stubs.  See the `import { ... } from '../script.js'` block at
// public/scripts/st-context.js:1-109 for the canonical list.
// -------------------------------------------------------------------------
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
    getPresetState: () => null,
    getPresetStateBatch: () => ({}),
    patchPresetState: () => Promise.resolve(),
    updatePresetState: () => Promise.resolve(),
    deleteChatState: () => Promise.resolve(),
    deletePresetState: () => Promise.resolve(),
    deleteAllPresetState: () => Promise.resolve(),
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

// -------------------------------------------------------------------------
// extensions.js — the only ext-side call we care about is writeExtensionField
// mutating character.data.extensions.luker with REPLACE semantics.
// -------------------------------------------------------------------------
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    writeExtensionField: jest.fn(async (id, ns, value) => {
        // Mirror public/scripts/extensions.js:writeExtensionField — replace
        // the whole `data.extensions[ns]` slot.  Layer 1 pre-spreads
        // siblings, so we don't need to.
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

// -------------------------------------------------------------------------
// preset-persistence.js — st-context.js's savePresetBody delegates the
// global branch to persistPreset.  Stub it as a jest.fn so we can assert
// it's *not* called when dispatch routes to the character branch.
// -------------------------------------------------------------------------
const persistPresetFn = jest.fn(async ({ apiId, name, preset }) => ({
    ok: true,
    mode: 'update',
    operations: [],
    response: null,
    data: { name },
}));
jest.unstable_mockModule('../../public/scripts/preset-persistence.js', () => ({
    persistPreset: persistPresetFn,
}));

// -------------------------------------------------------------------------
// openai.js — st-context.js imports many names; Layer 1 also imports
// stripOpenAIConnectionFieldsFromPreset.  Provide both.
// -------------------------------------------------------------------------
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
    // Names pulled by transitive imports of openai.js (instruct-mode, tools, etc.).
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

// -------------------------------------------------------------------------
// Import the SUT (real st-context.js) + Layer 1 (real character/presets.js).
// -------------------------------------------------------------------------

// Sweep-mock the rest of st-context.js's import graph.  For modules imported
// via `import * as X` in st-context.js we can hand back a permissive Proxy;
// for named-import modules we must declare each name explicitly (ESM link
// step validates named-export presence structurally, not via [[Get]]).
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

// Namespace-import mocks (import * as X from ...) — Proxy is fine.
jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/iteration-library/index.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/extensions/luker-tabs.js', () => nsStub());
jest.unstable_mockModule('../../public/scripts/extensions/field-help.js', () => nsStub());

// Named-import mocks — declare every symbol st-context.js pulls from each.
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
    MacrosParser: {
        registerMacro: () => {}, unregisterMacro: () => {},
    },
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
    ScraperManager: {
        registerDataBankScraper: () => {},
    },
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
    deleteWorldInfoEntry: () => Promise.resolve(), deleteWorldInfo: () => Promise.resolve(),
    selected_world_info: [],
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

beforeEach(() => {
    // Reset fixture between tests to keep them independent.
    character.data.extensions = {};
    persistPresetFn.mockClear();
    mockPresetManager.updateList.mockClear();
    currentCharacterId = 0;
});

// -------------------- normalizePresetRef origin passthrough --------------------

test('normalizePresetRef preserves origin when passed as character', () => {
    const ctx = getContext();
    const ref = ctx.presets.resolve({
        collection: 'openai',
        name: 'GlobalA',
        origin: { kind: 'character', avatar: 'Aqua.png' },
    });
    expect(ref).not.toBeNull();
    expect(ref.origin).toEqual({ kind: 'character', avatar: 'Aqua.png' });
    expect(ref.name).toBe('GlobalA');
    expect(ref.collection).toBe('openai');
});

test('normalizePresetRef defaults origin to {kind:global} when absent', () => {
    const ctx = getContext();
    const ref = ctx.presets.resolve({ collection: 'openai', name: 'GlobalA' });
    expect(ref).not.toBeNull();
    expect(ref.origin).toEqual({ kind: 'global' });
});

// -------------------- getStored origin dispatch --------------------

test('getStored dispatches character ref to Layer 1', async () => {
    const ctx = getContext();
    const boundChar = ctx.characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'CardOnly', { temperature: 0.7 });
    const snapshot = ctx.presets.getStored({
        collection: 'openai',
        name: 'CardOnly',
        origin: { kind: 'character', avatar: 'Aqua.png' },
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot.body.temperature).toBe(0.7);
    expect(snapshot.source).toBe('character');
    expect(snapshot.ref.origin).toEqual({ kind: 'character', avatar: 'Aqua.png' });
});

test('getStored dispatches global ref to PresetManager (unchanged)', () => {
    const ctx = getContext();
    const snapshot = ctx.presets.getStored({
        collection: 'openai',
        name: 'GlobalA',
        origin: { kind: 'global' },
    });
    expect(snapshot.body).toMatchObject({ __from: 'global:GlobalA' });
    expect(snapshot.source).toBe('stored');
});

test('getStored returns null when character ref points to nonexistent avatar', () => {
    const ctx = getContext();
    const snapshot = ctx.presets.getStored({
        collection: 'openai',
        name: 'X',
        origin: { kind: 'character', avatar: 'Missing.png' },
    });
    expect(snapshot).toBeNull();
});

// -------------------- save origin dispatch --------------------

test('save with character ref writes card via Layer 1, does NOT call persistPreset', async () => {
    const ctx = getContext();
    const boundChar = ctx.characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'CardOnly', { temperature: 0.7 });
    persistPresetFn.mockClear();

    const result = await ctx.presets.save(
        { collection: 'openai', name: 'CardOnly', origin: { kind: 'character', avatar: 'Aqua.png' } },
        { temperature: 0.95 },
    );

    expect(result.ok).toBe(true);
    expect(result.ref.origin).toEqual({ kind: 'character', avatar: 'Aqua.png' });
    expect(result.mode).toBe('character');
    expect(persistPresetFn).not.toHaveBeenCalled();
    const stored = characterPresets.getCharacterBoundPreset(boundChar, 'CardOnly');
    expect(stored.preset.temperature).toBe(0.95);
});

test('save with global ref goes through persistPreset (unchanged)', async () => {
    const ctx = getContext();
    const boundChar = ctx.characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'CardOnly', { temperature: 0.7 });
    const before = JSON.parse(JSON.stringify(character.data.extensions.luker.chat_completion_preset));
    persistPresetFn.mockClear();

    await ctx.presets.save(
        { collection: 'openai', name: 'GlobalA', origin: { kind: 'global' } },
        { temperature: 0.95 },
    );

    expect(persistPresetFn).toHaveBeenCalledTimes(1);
    // Card state unchanged
    expect(character.data.extensions.luker.chat_completion_preset).toEqual(before);
});

test('save with character ref, missing avatar returns {ok:false}', async () => {
    const ctx = getContext();
    const result = await ctx.presets.save(
        { collection: 'openai', name: 'X', origin: { kind: 'character', avatar: 'Missing.png' } },
        {},
    );
    expect(result.ok).toBe(false);
});

// -------------------- list merge --------------------

test('list merges card refs + global refs, same name kept with different origin', async () => {
    const ctx = getContext();
    const boundChar = ctx.characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'GlobalA', { temperature: 0.1 });
    await characterPresets.addCharacterBoundPreset(boundChar, 'CardOnly', { temperature: 0.2 });

    const refs = ctx.presets.list('openai');
    const bag = refs.map(r => `${r.origin.kind}:${r.name}`).sort();
    expect(bag).toEqual([
        'character:CardOnly',
        'character:GlobalA',
        'global:GlobalA',
        'global:GlobalB',
    ].sort());
});

test('list returns global-only when no character selected', () => {
    currentCharacterId = -1;
    const ctx = getContext();
    const refs = ctx.presets.list('openai');
    expect(refs.every(r => r.origin.kind === 'global')).toBe(true);
    expect(refs.map(r => r.name).sort()).toEqual(['GlobalA', 'GlobalB']);
});

// -------------------- resolveGlobalOnly --------------------

test('resolveGlobalOnly(name) never returns character ref, even if card has that name', async () => {
    const ctx = getContext();
    const boundChar = ctx.characters[0];
    await characterPresets.addCharacterBoundPreset(boundChar, 'GlobalA', { temperature: 0.1 });
    const ref = ctx.presets.resolveGlobalOnly('GlobalA');
    expect(ref).not.toBeNull();
    expect(ref.origin).toEqual({ kind: 'global' });
});

test('resolveGlobalOnly returns null when name is unknown globally', () => {
    const ctx = getContext();
    expect(ctx.presets.resolveGlobalOnly('DoesNotExist')).toBeNull();
});

// -------------------- ctx.character.presets namespace --------------------

test('ctx.character.presets exposes Layer 1 by same signature', () => {
    const ctx = getContext();
    expect(typeof ctx.character.presets.list).toBe('function');
    expect(typeof ctx.character.presets.get).toBe('function');
    expect(typeof ctx.character.presets.add).toBe('function');
    expect(typeof ctx.character.presets.update).toBe('function');
    expect(typeof ctx.character.presets.remove).toBe('function');
    expect(typeof ctx.character.presets.setDefault).toBe('function');
    expect(typeof ctx.character.presets.resolveByName).toBe('function');
    expect(typeof ctx.character.presets.clearAll).toBe('function');
});

test('ctx.character.presets.add really writes through Layer 1', async () => {
    const ctx = getContext();
    const boundChar = ctx.characters[0];
    await ctx.character.presets.add(boundChar, 'ViaCtx', { temperature: 0.42 });
    expect(character.data.extensions.luker.chat_completion_preset.presets[0].name).toBe('ViaCtx');
});

// -------------------- lukerContext skeleton --------------------

test('lukerContext.js sets globalThis.lukerContext to the same object as getContext()', async () => {
    await import('../../public/scripts/lukerContext.js');
    expect(globalThis.lukerContext).toBeDefined();
    expect(typeof globalThis.lukerContext.character.presets.add).toBe('function');
    // Sanity check: the two access paths reach the same Layer 1 fn.
    expect(globalThis.lukerContext.character.presets.add).toBe(getContext().character.presets.add);
});
