// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';
import { applyPatch as applyJsonPatch, compare as compareJsonPatch } from '../public/scripts/util/fast-json-patch.js';
import { cloneAsJsonWire } from '../public/scripts/util/json-clone.js';
import { STATE_ERROR_REASONS } from '../public/scripts/lib/state-errors.js';
import { resetResourceReads } from '../public/scripts/resource-read.js';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getJsonPointerValue(root, path) {
    if (path === '') return { found: true, value: root };
    if (typeof path !== 'string' || !path.startsWith('/')) return { found: false, value: undefined };
    const segments = path.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cursor = root;
    for (const segment of segments) {
        if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
            return { found: false, value: undefined };
        }
        cursor = cursor[segment];
    }
    return { found: true, value: cursor };
}

function attachObjectPatchTests(previousState, operations) {
    let workingState = cloneAsJsonWire(previousState);
    let lastTestedPath = null;
    const guarded = [];
    for (const op of operations) {
        const opName = String(op.op || '').trim().toLowerCase();
        const path = typeof op.path === 'string' ? op.path : null;
        if ((opName === 'replace' || opName === 'remove') && path && path !== lastTestedPath) {
            const resolved = getJsonPointerValue(workingState, path);
            if (resolved.found) {
                guarded.push({ op: 'test', path, value: cloneAsJsonWire(resolved.value) });
                lastTestedPath = path;
            }
        }
        guarded.push(op);
        try {
            workingState = applyJsonPatch(workingState, [op], true, false)?.newDocument;
        } catch {
            // Keep operation list intact.
        }
        if (opName === 'add' || opName === 'remove') {
            lastTestedPath = null;
        }
    }
    return guarded;
}

function buildObjectPatchOperations(previousState, nextState, options = {}) {
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 2000;
    const next = isPlainObject(nextState) ? nextState : null;
    if (!next) return [];
    const previous = isPlainObject(previousState) ? previousState : {};
    const operations = compareJsonPatch(previous, next);
    if (operations.length > maxOperations) {
        return [{ op: 'replace', path: '', value: cloneAsJsonWire(next) }];
    }
    return attachObjectPatchTests(previous, operations);
}

async function buildObjectPatchOperationsAsync(previousState, nextState, options = {}) {
    return buildObjectPatchOperations(previousState, nextState, options);
}

const buildObjectPatchOperationsSpy = jest.fn(buildObjectPatchOperations);
const buildObjectPatchOperationsAsyncSpy = jest.fn(buildObjectPatchOperationsAsync);

const character = { avatar: 'Alice.png', data: { extensions: {} } };
const charactersArray = [character];

const mockPresetManager = {
    getPresetList: () => ({ preset_names: ['Default'] }),
    getSelectedPresetName: () => 'Default',
    getStoredPreset: () => ({}),
    getPresetSettings: () => ({}),
    getCompletionPresetByName: () => null,
    readPresetExtensionField: () => null,
    writePresetExtensionField: async () => {},
    updateList: () => {},
};

jest.unstable_mockModule('../public/script.js', () => ({
    characters: charactersArray,
    this_chid: 0,
    animation_duration: 0,
    EXTENSIONS_CLIENT_VERSION: '1.0.0',
    ensureFullSettingsLoaded: async () => {},
    cloneAsJsonWire,
    buildObjectPatchOperations: buildObjectPatchOperationsSpy,
    buildObjectPatchOperationsAsync: buildObjectPatchOperationsAsyncSpy,
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
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
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
    listPresetDocuments: () => Promise.resolve([]),
    readPresetDocument: () => Promise.resolve(null),
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
    settingsReady: false,
}));

function nsStub(extra = {}) {
    return Object.assign(Object.create(null), { __esModule: true, ...extra });
}

jest.unstable_mockModule('../public/scripts/lib/edits/index.js', () => nsStub());
jest.unstable_mockModule('../public/scripts/iteration-library/index.js', () => nsStub());
jest.unstable_mockModule('../public/scripts/extensions/luker-tabs.js', () => nsStub());
jest.unstable_mockModule('../public/scripts/extensions/field-help.js', () => nsStub());
jest.unstable_mockModule('../public/scripts/run-panel/index.js', () => nsStub());

jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({
    getPresetManager: () => mockPresetManager,
    presetManagerRegistry: { openai: mockPresetManager },
}));
jest.unstable_mockModule('../public/scripts/preset-persistence.js', () => ({
    persistPreset: async () => ({ ok: true }),
}));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    getChatCompletionModel: () => 'test-model',
    oai_settings: {},
    openai_settings: [],
    openai_setting_names: {},
    sendOpenAIRequest: () => Promise.resolve(''),
    proxies: [],
    ZAI_ENDPOINT: '',
    stripOpenAIConnectionFieldsFromPreset: (p) => p,
    saveOpenAIPreset: () => Promise.resolve(),
    hasUnsavedOpenAIPresetChanges: () => false,
    promptManager: {},
    applyPresetByName: () => Promise.resolve(),
    syncSavedCharacterBoundPreset: () => Promise.resolve(false),
    maybeApplyCharacterBoundPreset: () => Promise.resolve(),
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
jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplate: () => '',
    renderTemplateAsync: async () => '',
}));
jest.unstable_mockModule('../public/scripts/user.js', () => ({
    isAdmin: () => true,
    accountsEnabled: false,
    currentUser: null,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    groups: [], openGroupChat: () => Promise.resolve(), selected_group: null, unshallowGroupMembers: () => Promise.resolve(),
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    addLocaleData: () => {},
    getCurrentLocale: () => 'en-US',
    t: (k) => k,
    translate: (k) => k,
    createScopedI18n: () => ({ i18n: (k) => String(k ?? ''), i18nFormat: (k) => String(k ?? '') }),
}));
jest.unstable_mockModule('../public/scripts/loader.js', () => ({
    hideLoader: () => {}, showLoader: () => {},
}));
jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({
    loader: {},
}));
jest.unstable_mockModule('../public/scripts/macros.js', () => ({
    MacrosParser: { registerMacro: () => {}, unregisterMacro: () => {} },
}));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    getDedicatedPersonaEntriesFromCharacter: () => null,
    setCharacterDedicatedPersonaEntries: async () => {},
}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup: () => Promise.resolve(''),
    Popup: class {},
    POPUP_RESULT: { CANCELLED: 0, AFFIRMATIVE: 1 },
    POPUP_TYPE: { DISPLAY: 0 },
    PopupUtils: { BuildTextWithHeader: (header, text) => `${header}\n${text ?? ''}` },
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: {}, registerDebugFunction: () => {}, performFuzzySearch: () => [],
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    humanizedDateTime: () => '', isMobile: () => false, shouldSendOnEnter: () => true,
}));
jest.unstable_mockModule('../public/scripts/scrapers.js', () => ({
    ScraperManager: { registerDataBankScraper: () => {} },
}));
jest.unstable_mockModule('../public/scripts/slash-commands.js', () => ({
    executeSlashCommands: () => Promise.resolve({}),
    executeSlashCommandsWithOptions: () => Promise.resolve({}),
    registerSlashCommand: () => {},
}));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: class {},
}));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: {}, SlashCommandArgument: class {}, SlashCommandNamedArgument: class {},
}));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
    SlashCommandEnumValue: class {},
}));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: () => {} },
}));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    tag_map: {}, tags: [], importTags: () => {},
}));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    getTextGenServer: () => '', getTextGenGenerationData: () => ({}), textgenerationwebui_settings: {}, textgen_types: {},
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    tokenizers: {}, tokenizer_settings: {}, getTextTokens: () => [], getTokenCount: () => 0, getTokenCountAsync: async () => 0, getTokenizerModel: () => '',
}));
jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
    ToolManager: {
        registerFunctionTool: () => {}, unregisterFunctionTool: () => {},
        isToolCallingSupported: () => false, canPerformToolCalls: () => false,
    },
}));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: {},
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    areLookupNamesEqual: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
    findCanonicalNameInList: () => '',
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
    equalsIgnoreCaseAndAccents: (a, b) => a === b,
    delay: () => Promise.resolve(),
    deleteValueByPath: () => {},
    isSubsetOf: () => false,
    sanitizeSelector: (s) => s,
    setValueByPath: () => {},
    versionCompare: () => 0,
}));
jest.unstable_mockModule('../public/scripts/variables.js', () => ({
    addGlobalVariable: () => {}, addLocalVariable: () => {},
    decrementGlobalVariable: () => {}, decrementLocalVariable: () => {},
    deleteGlobalVariable: () => {}, deleteLocalVariable: () => {},
    existsGlobalVariable: () => false, existsLocalVariable: () => false,
    getGlobalVariable: () => null, getLocalVariable: () => null,
    incrementGlobalVariable: () => {}, incrementLocalVariable: () => {},
    popLocalVariable: () => null, pushLocalVariable: () => {},
    setGlobalVariable: () => {}, setLocalVariable: () => {},
}));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
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
jest.unstable_mockModule('../public/scripts/custom-request.js', () => ({
    ChatCompletionService: {}, TextCompletionService: {},
}));
jest.unstable_mockModule('../public/scripts/extensions/shared.js', () => ({
    ConnectionManagerRequestService: {},
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    getChatCompletionConnectionProfiles: () => [], resolveChatCompletionRequestProfile: () => null,
}));
jest.unstable_mockModule('../public/scripts/reasoning.js', () => ({
    updateReasoningUI: () => {}, parseReasoningFromString: () => ({ reasoning: '', content: '' }),
    getReasoningTemplateByName: () => null, removeReasoningFromString: (s) => String(s ?? ''),
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    IGNORE_SYMBOL: Symbol('IGNORE'),
    inject_ids: {},
    debounce_timeout: { relaxed: 0 },
}));
jest.unstable_mockModule('../public/scripts/macros/macro-system.js', () => ({
    macros: { register: () => {}, registry: { unregisterMacro: () => {} } },
}));
jest.unstable_mockModule('../public/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (s) => String(s ?? ''), regex_placement: {},
}));
jest.unstable_mockModule('../public/scripts/messages.js', () => ({
    addMessages: () => {}, updateMessages: () => {}, deleteMessages: () => {},
    getMessage: () => null, getMessageCount: () => 0,
}));
jest.unstable_mockModule('../public/scripts/floor-state.js', () => ({
    createFloorState: () => ({}),
}));
jest.unstable_mockModule('../public/scripts/generate-task.js', () => ({
    generateTask: () => Promise.resolve({}), generateTaskStream: () => Promise.resolve({}),
    GenerateTaskError: class extends Error {}, resolveOpenAiStreamFlag: () => false,
}));
jest.unstable_mockModule('../public/scripts/message-takeover.js', () => ({
    createMessageEditorHandle: () => null, TakeoverError: class extends Error {},
}));
jest.unstable_mockModule('../public/scripts/horde.js', () => ({
    generateHorde: () => Promise.resolve(''),
}));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({
    getKoboldGenerationData: () => ({}), kai_settings: {}, koboldai_settings: {}, koboldai_setting_names: {},
}));
jest.unstable_mockModule('../public/scripts/nai-settings.js', () => ({
    getNovelGenerationData: () => ({}), nai_settings: {}, novelai_settings: {}, novelai_setting_names: {},
}));
jest.unstable_mockModule('../public/scripts/skills/api.js', () => ({
    skillsApi: {},
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {}, secret_state: {},
}));
jest.unstable_mockModule('../public/scripts/embedding-service.js', () => ({
    EmbeddingService: class {},
}));

const trackedIntervals = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = realSetInterval(...args);
    trackedIntervals.push(handle);
    return handle;
};

const extensionsMod = await import('../public/scripts/extensions.js');
const { getContext } = await import('../public/scripts/st-context.js');
globalThis.Luker = { getContext };
await import('../public/scripts/lukerContext.js');

globalThis.setInterval = realSetInterval;
for (const handle of trackedIntervals) {
    handle?.unref?.();
    clearInterval(handle);
}

const {
    getGlobalState,
    getGlobalStateBatch,
    setGlobalState,
    patchGlobalState,
    updateGlobalState,
    deleteGlobalState,
} = extensionsMod;

function makeJsonResponse(body, { status = 200, statusText = 'OK', headers = {} } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        headers: {
            get: (key) => headers[String(key).toLowerCase()] ?? (key.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        text: async () => text,
        json: async () => JSON.parse(text),
    };
}

describe('global state client helpers', () => {
    let fetchMock;

    beforeEach(() => {
        resetResourceReads();
        buildObjectPatchOperationsSpy.mockClear();
        buildObjectPatchOperationsAsyncSpy.mockClear();
        fetchMock = jest.fn(async (url) => {
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        });
        globalThis.fetch = fetchMock;
    });

    test('all 6 global state helpers are exposed on Layer 1 (extensions.js), Layer 2 (lukerContext), and Layer 3 (Luker.getContext())', () => {
        const ctx = globalThis.Luker.getContext();
        const l2 = globalThis.lukerContext;
        for (const name of [
            'getGlobalState',
            'getGlobalStateBatch',
            'setGlobalState',
            'patchGlobalState',
            'updateGlobalState',
            'deleteGlobalState',
        ]) {
            expect(typeof extensionsMod[name]).toBe('function');
            expect(ctx[name]).toBe(extensionsMod[name]);
            expect(l2[name]).toBe(extensionsMod[name]);
        }
    });

    test.each([
        '',
        '   ',
        null,
        undefined,
        123,
        true,
        {},
        [],
        '../x',
        '../secret',
        '.hidden',
        'a/b',
        'a\\b',
        'foo..bar',
        'x\0y',
        'bad\nns',
        'bad\x7fns',
    ])('rejects invalid namespace %p with VALIDATION_ARGS without issuing fetch', async (badNs) => {
        const getRes = await getGlobalState(badNs);
        expect(getRes).toEqual({
            ok: false,
            state: null,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.any(String),
        });

        const batchRes = await getGlobalStateBatch(['valid_ns', badNs]);
        expect(batchRes).toEqual({
            ok: false,
            results: new Map(),
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.any(String),
        });

        const setRes = await setGlobalState(badNs, { a: 1 });
        expect(setRes).toEqual({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.any(String),
        });

        const patchRes = await patchGlobalState(badNs, [{ op: 'add', path: '/a', value: 1 }]);
        expect(patchRes).toEqual({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.any(String),
        });

        const updateRes = await updateGlobalState(badNs, (s) => s);
        expect(updateRes).toEqual({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.any(String),
        });

        const delRes = await deleteGlobalState(badNs);
        expect(delRes).toEqual({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.any(String),
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('patchGlobalState and updateGlobalState validate operations/updater locally without issuing fetch', async () => {
        expect(await patchGlobalState('ns', [])).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
        });
        expect(await patchGlobalState('ns', 'bad')).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
        });
        expect(await updateGlobalState('ns', 'not-a-fn')).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
        });
        expect(await getGlobalStateBatch([])).toEqual({ ok: true, results: new Map() });
        expect(await getGlobalStateBatch(['', '  ', 123])).toMatchObject({
            ok: false,
            results: new Map(),
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('getGlobalState reads via GET /api/state/get preserving namespace case and handles null/error envelopes', async () => {
        fetchMock.mockImplementation(async (url) => {
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/get?account=default-user&namespace=MyPlugin') {
                return makeJsonResponse({ ok: true, data: { count: 3 } });
            }
            if (url === '/api/state/get?account=default-user&namespace=AbsentNs') {
                return makeJsonResponse({ ok: true, data: null });
            }
            if (url === '/api/state/get?account=default-user&namespace=BrokenNs') {
                return makeJsonResponse({ error: 'boom' }, { status: 500, statusText: 'Internal Server Error' });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        expect(await getGlobalState('  MyPlugin  ')).toEqual({
            ok: true,
            state: { count: 3 },
        });
        expect(await getGlobalState('AbsentNs')).toEqual({
            ok: true,
            state: null,
        });
        const httpErr = await getGlobalState('BrokenNs');
        expect(httpErr).toMatchObject({
            ok: false,
            state: null,
            reason: STATE_ERROR_REASONS.HTTP_ERROR,
        });

        fetchMock.mockRejectedValueOnce(new TypeError('network down'));
        const transportErr = await getGlobalState('NetErrNs');
        expect(transportErr).toMatchObject({
            ok: false,
            state: null,
            reason: STATE_ERROR_REASONS.TRANSPORT_ERROR,
        });
    });

    test('getGlobalStateBatch deduplicates namespaces and maps results into a Map', async () => {
        fetchMock.mockImplementation(async (url) => {
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/get?account=default-user&namespace=Alpha') {
                return makeJsonResponse({ ok: true, data: { a: 1 } });
            }
            if (url === '/api/state/get?account=default-user&namespace=Missing') {
                return makeJsonResponse({ ok: true, data: null });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const res = await getGlobalStateBatch(['Alpha', 'Missing', '  Alpha  ']);
        expect(res.ok).toBe(true);
        expect(res.results).toBeInstanceOf(Map);
        expect(Array.from(res.results.entries())).toEqual([
            ['Alpha', { ok: true, state: { a: 1 } }],
            ['Missing', { ok: true, state: null }],
        ]);
        const stateGets = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/state/get'));
        expect(stateGets).toHaveLength(2);
    });

    test('setGlobalState posts to /api/state/set, invalidates GET cache, and maps HTTP/transport errors', async () => {
        const calls = [];
        fetchMock.mockImplementation(async (url, init) => {
            calls.push({ url, init });
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/set') {
                return makeJsonResponse({ ok: true });
            }
            if (url === '/api/state/get?account=default-user&namespace=Workbench') {
                return makeJsonResponse({ ok: true, data: { theme: 'dark' } });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const res = await setGlobalState('  Workbench  ', { theme: 'dark' });
        expect(res).toEqual({ ok: true, state: { theme: 'dark' } });

        const postCall = calls.find(c => c.url === '/api/state/set');
        expect(postCall.init.method).toBe('POST');
        expect(postCall.init.cache).toBe('no-cache');
        expect(JSON.parse(postCall.init.body)).toEqual({
            namespace: 'Workbench',
            data: { theme: 'dark' },
        });

        // Bootstrap was fetched to invalidate '/api/state/get?account=default-user&namespace=Workbench'
        expect(calls.some(c => c.url === '/api/bootstrap/metadata')).toBe(true);

        fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: 'Expected body.data object.' }, { status: 400, statusText: 'Bad Request' }));
        expect(await setGlobalState('Workbench', [1, 2])).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.HTTP_ERROR,
        });

        fetchMock.mockRejectedValueOnce(new Error('offline'));
        expect(await setGlobalState('Workbench', { x: 1 })).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.TRANSPORT_ERROR,
        });
    });

    test('patchGlobalState posts to /api/state/patch, returns applied/created, and maps 409/HTTP/transport errors', async () => {
        const ops = [{ op: 'add', path: '/tab', value: 'studio' }];
        const calls = [];
        fetchMock.mockImplementation(async (url, init) => {
            calls.push({ url, init });
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/patch') {
                return makeJsonResponse({ ok: true, applied: 1, created: true });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        expect(await patchGlobalState('Workbench', ops)).toEqual({
            ok: true,
            applied: 1,
            created: true,
        });
        const patchCall = calls.find(c => c.url === '/api/state/patch');
        expect(patchCall.init.method).toBe('POST');
        expect(JSON.parse(patchCall.init.body)).toEqual({ namespace: 'Workbench', operations: ops });

        fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: 'conflict' }, { status: 409, statusText: 'Conflict' }));
        expect(await patchGlobalState('Workbench', ops)).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.CONFLICT,
        });

        fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: 'bad patch' }, { status: 400, statusText: 'Bad Request' }));
        expect(await patchGlobalState('Workbench', ops)).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.HTTP_ERROR,
        });

        fetchMock.mockRejectedValueOnce(new Error('reset by peer'));
        expect(await patchGlobalState('Workbench', ops)).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.TRANSPORT_ERROR,
        });
    });

    test('updateGlobalState handles no-op, reducer errors, sync/async diff options, and 409 retry budget', async () => {
        let serverDoc = { count: 1, untouched: true };
        let injectConflictOnce = true;
        const attempts = [];
        const patchBodies = [];

        fetchMock.mockImplementation(async (url, init) => {
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/get?account=default-user&namespace=CounterNs') {
                return makeJsonResponse({ ok: true, data: serverDoc });
            }
            if (url === '/api/state/patch') {
                const body = JSON.parse(init.body);
                patchBodies.push(body);
                if (injectConflictOnce) {
                    injectConflictOnce = false;
                    serverDoc = { count: 5, untouched: true };
                    return makeJsonResponse({ error: 'conflict' }, { status: 409, statusText: 'Conflict' });
                }
                serverDoc = { count: 6, untouched: true };
                return makeJsonResponse({ ok: true, applied: body.operations.length, created: false });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const retryRes = await updateGlobalState('CounterNs', (current, meta) => {
            attempts.push({ current, meta });
            return { ...current, count: (current.count || 0) + 1 };
        });

        expect(retryRes).toEqual({
            ok: true,
            state: { count: 6, untouched: true },
            updated: true,
            created: false,
        });
        expect(attempts).toEqual([
            { current: { count: 1, untouched: true }, meta: { attempt: 0, namespace: 'CounterNs' } },
            { current: { count: 5, untouched: true }, meta: { attempt: 1, namespace: 'CounterNs' } },
        ]);
        expect(patchBodies).toHaveLength(2);
        expect(patchBodies[0].operations).toEqual([
            { op: 'test', path: '/count', value: 1 },
            { op: 'replace', path: '/count', value: 2 },
        ]);
        expect(patchBodies[1].operations).toEqual([
            { op: 'test', path: '/count', value: 5 },
            { op: 'replace', path: '/count', value: 6 },
        ]);

        // Exhausted retries -> CONFLICT
        fetchMock.mockImplementation(async (url) => {
            if (url === '/api/bootstrap/metadata') return makeJsonResponse({ account: 'default-user' });
            if (url.startsWith('/api/state/get')) return makeJsonResponse({ ok: true, data: { count: 6 } });
            if (url === '/api/state/patch') return makeJsonResponse({ error: 'conflict' }, { status: 409 });
            throw new Error(`Unexpected URL: ${url}`);
        });
        expect(await updateGlobalState('CounterNs', (c) => ({ ...c, count: 7 }), { maxRetries: 1 })).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.CONFLICT,
        });

        // Null/undefined or identical return -> updated: false without patching
        const patchCountBefore = fetchMock.mock.calls.filter(([u]) => u === '/api/state/patch').length;
        expect(await updateGlobalState('CounterNs', () => null)).toEqual({
            ok: true,
            state: { count: 6 },
            updated: false,
        });
        expect(await updateGlobalState('CounterNs', (c) => ({ ...c }))).toEqual({
            ok: true,
            state: { count: 6 },
            updated: false,
        });
        expect(fetchMock.mock.calls.filter(([u]) => u === '/api/state/patch')).toHaveLength(patchCountBefore);

        // Reducer throwing / returning non-plain object -> VALIDATION_ARGS
        expect(await updateGlobalState('CounterNs', () => { throw new Error('boom'); })).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
            hint: expect.stringContaining('reducer threw: boom'),
        });
        expect(await updateGlobalState('CounterNs', () => ['not', 'object'])).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.VALIDATION_ARGS,
        });

        // asyncDiff: false uses sync diff helper
        fetchMock.mockImplementation(async (url) => {
            if (url === '/api/bootstrap/metadata') return makeJsonResponse({ account: 'default-user' });
            if (url.startsWith('/api/state/get')) return makeJsonResponse({ ok: true, data: null });
            if (url === '/api/state/patch') return makeJsonResponse({ ok: true, applied: 1, created: true });
            throw new Error(`Unexpected URL: ${url}`);
        });
        const syncRes = await updateGlobalState('FreshNs', () => ({ hello: 'world' }), { asyncDiff: false });
        expect(syncRes).toEqual({
            ok: true,
            state: { hello: 'world' },
            updated: true,
            created: true,
        });
        expect(buildObjectPatchOperationsSpy).toHaveBeenCalledTimes(1);
    });

    test('deleteGlobalState posts to /api/state/delete, invalidates GET cache, and maps errors', async () => {
        const calls = [];
        fetchMock.mockImplementation(async (url, init) => {
            calls.push({ url, init });
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/delete') {
                return makeJsonResponse({ ok: true, deleted: true });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        expect(await deleteGlobalState('  OldNs  ')).toEqual({ ok: true });
        const delCall = calls.find(c => c.url === '/api/state/delete');
        expect(delCall.init.method).toBe('POST');
        expect(delCall.init.cache).toBe('no-cache');
        expect(JSON.parse(delCall.init.body)).toEqual({ namespace: 'OldNs' });
        expect(calls.some(c => c.url === '/api/bootstrap/metadata')).toBe(true);

        fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' }));
        expect(await deleteGlobalState('OldNs')).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.HTTP_ERROR,
        });

        fetchMock.mockRejectedValueOnce(new Error('network error'));
        expect(await deleteGlobalState('OldNs')).toMatchObject({
            ok: false,
            reason: STATE_ERROR_REASONS.TRANSPORT_ERROR,
        });
    });

    test('state-resource.js preserves case for /api/state/get, aborts stale overlapping reads on mutation, and keeps lowercase for character state', async () => {
        let resolveSlowGet;
        fetchMock.mockImplementation(async (url) => {
            if (url === '/api/bootstrap/metadata') {
                return makeJsonResponse({ account: 'default-user' });
            }
            if (url === '/api/state/get?account=default-user&namespace=MixedCaseNs') {
                return new Promise((resolve) => {
                    resolveSlowGet = () => resolve(makeJsonResponse({ ok: true, data: { stale: true } }));
                });
            }
            if (url === '/api/state/set') {
                return makeJsonResponse({ ok: true });
            }
            if (url === '/api/characters/state/get?account=default-user&avatar=Alice.png&namespace=mixedcasens') {
                return makeJsonResponse({ ok: true, data: { char: true } });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const slowReadPromise = getGlobalState('MixedCaseNs');
        // Wait until the slow GET has actually started
        await new Promise((r) => setTimeout(r, 10));

        const writeRes = await setGlobalState('MixedCaseNs', { fresh: true });
        expect(writeRes).toEqual({ ok: true, state: { fresh: true } });

        resolveSlowGet();
        const slowReadResult = await slowReadPromise;
        expect(slowReadResult.ok).toBe(false);
        expect(slowReadResult.reason).toBe(STATE_ERROR_REASONS.TRANSPORT_ERROR);

        // Character state still normalizes namespace to lowercase
        expect(await extensionsMod.getCharacterState('Alice.png', 'MixedCaseNs')).toEqual({
            ok: true,
            state: { char: true },
        });
    });
});
