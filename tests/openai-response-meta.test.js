// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';

const noop = () => {};
const asyncNoop = async () => {};
class StubClass {}

const metaListeners = new WeakMap();
const disposeCallCounts = new WeakMap();
const mockOnLukerResponseMeta = jest.fn((response, listener) => {
    if (!metaListeners.has(response)) metaListeners.set(response, new Set());
    const set = metaListeners.get(response);
    set.add(listener);
    return () => {
        disposeCallCounts.set(response, (disposeCallCounts.get(response) ?? 0) + 1);
        set.delete(listener);
    };
});

function disposeCount(response) {
    return disposeCallCounts.get(response) ?? 0;
}

let mockCreateProtocolStreamParserImpl = null;

function emitMeta(response, meta) {
    const set = metaListeners.get(response);
    if (!set) return;
    for (const fn of [...set]) fn({ ...meta });
}

function listenerCount(response) {
    return metaListeners.get(response)?.size ?? 0;
}

let liveMainApi = 'openai';
let nextGenId = 1;
const mockCharacters = [{ avatar: 'alice.png', chat: 'chat-1', name: 'Alice' }];

function makeEventStream() {
    let attached = null;
    return {
        _attach(r) { attached = r; },
        get readable() { return attached; },
        getInvalidDiagnostic: () => null,
    };
}

function makeSseResponse({ headers = {}, events = [] } = {}) {
    let idx = 0;
    const readable = {
        getReader: () => ({
            read: async () => {
                if (idx >= events.length) return { done: true, value: undefined };
                return { done: false, value: { data: events[idx++] } };
            },
            cancel: async () => {},
            releaseLock: () => {},
        }),
    };
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
        body: {
            pipeThrough: (stream) => {
                stream._attach(readable);
                return stream;
            },
        },
        clone: function () { return this; },
    };
}

function makeJsonResponse({ headers = {}, body = { choices: [{ message: { content: 'hi' } }] }, jsonGate = null } = {}) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
        json: async () => {
            if (jsonGate) await jsonGate;
            return body;
        },
        text: async () => JSON.stringify(body),
        clone: function () { return this; },
    };
}

jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: noop,
    cancelStatusCheck: noop,
    chat_metadata: {},
    characters: mockCharacters,
    cloneAsJsonWire: (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x))),
    ensureFullSettingsLoaded: asyncNoop,
    event_types: { CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready' },
    eventSource: { on: noop, emit: asyncNoop },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: 0, IN_PROMPT: 1, IN_CHAT: 2 },
    Generate: asyncNoop,
    getCurrentChatId: () => 'chat-1',
    getExtensionPrompt: () => '',
    getExtensionPromptMaxDepth: () => 0,
    getMediaDisplay: () => '',
    getMediaIndex: () => -1,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    is_send_press: false,
    get main_api() { return liveMainApi; },
    name1: 'User',
    name2: 'Alice',
    resultCheckStatus: asyncNoop,
    saveSettingsDebounced: noop,
    setOnlineStatus: noop,
    startStatusLoading: noop,
    substituteParams: (s) => s,
    substituteParamsExtended: (s) => s,
    system_message_types: {},
    this_chid: 0,
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    getGroupNames: () => [],
    groups: [],
    selected_group: null,
}));
jest.unstable_mockModule('../public/scripts/PromptManager.js', () => ({
    chatCompletionDefaultPrompts: [],
    INJECTION_POSITION: { RELATIVE: 0, ABSOLUTE: 1 },
    Prompt: StubClass,
    PromptManager: StubClass,
    promptManagerDefaultPromptOrders: [],
}));
jest.unstable_mockModule('../public/scripts/prompt-injections.js', () => ({
    applyAttachedPromptsToMessages: (m) => m,
    applyPromptManagerOverrides: noop,
    getPromptInjectionGroups: () => [],
    getRelativePromptById: () => null,
    isPromptInjectionPosition: () => false,
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    forceCharacterEditorTokenize: noop,
    getCustomStoppingStrings: () => [],
    persona_description_positions: {},
    power_user: {},
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {},
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/request-throttler.js', () => ({
    acquire: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/max-retries.js', () => ({
    getMaxRequestRetries: () => 0,
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/request-timeout.js', () => ({
    getRequestTimeoutMs: () => 0,
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/network-proxy.js', () => ({
    getNetworkProxy: () => '',
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/profile-retry.js', () => ({
    withProfileRetry: async (fn) => fn(),
}));
jest.unstable_mockModule('../public/scripts/sse-stream.js', () => ({
    getEventSourceStream: () => makeEventStream(),
}));
jest.unstable_mockModule('../public/scripts/ws-delivery.js', () => ({
    getLukerResponseMeta: () => null,
    onLukerResponseMeta: mockOnLukerResponseMeta,
}));
jest.unstable_mockModule('../public/scripts/lib/transient-session.js', () => ({
    transientSessionHeaders: () => ({}),
}));
jest.unstable_mockModule('../public/scripts/lib/provider-capabilities.js', () => ({
    resolveClaudeModelCapabilities: () => ({}),
    resolveGeminiModelCapabilities: () => ({}),
    resolveMinimaxModelCapabilities: () => ({}),
    resolveOpenAIModelCapabilities: () => ({}),
}));
jest.unstable_mockModule('../public/scripts/lib/protocol-parser/index.js', () => ({
    ProtocolParseError: class extends Error {},
    createProtocolStreamParser: (...args) => {
        if (mockCreateProtocolStreamParserImpl) {
            return mockCreateProtocolStreamParserImpl(...args);
        }
        return {
            protocol: 'openai',
            feedFrame: () => ({ textDelta: 'hi', hasMetadataUpdate: false }),
            finish: () => ({}),
            getSnapshot: () => ({}),
        };
    },
    isParsedTurnEmpty: () => false,
    parseCompatChatCompletionResponse: (_p, d) => d,
    parseProtocolResponse: (_p, d) => d,
    parsedTurnToChatCompletion: (d) => d,
    resolveWireProtocol: () => null,
}));
jest.unstable_mockModule('../public/scripts/named-resource-read.js', () => ({
    readPresetDocument: async () => null,
}));
jest.unstable_mockModule('../public/scripts/util/preset-hydration.js', () => ({
    hydrateIndexedPresetEntries: noop,
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    areLookupNamesEqual: (a, b) => a === b,
    findCanonicalNameInList: () => '',
    clamp: (v) => v,
    createThumbnail: async () => '',
    delay: asyncNoop,
    download: noop,
    getAudioDurationFromDataURL: async () => 0,
    getBase64Async: async () => '',
    getFileText: async () => '',
    getImageSizeFromDataURL: async () => ({ width: 0, height: 0 }),
    getSortableDelay: () => 0,
    getOrderedPresetNames: () => [],
    getStringHash: () => 0,
    getVideoDurationFromDataURL: async () => 0,
    isDataURL: () => false,
    isUuid: () => false,
    isValidUrl: () => false,
    parseJsonFile: async () => ({}),
    resetScrollHeight: noop,
    stringFormat: (s) => s,
    textValueMatcher: () => true,
    uuidv4: () => `oai-gen-${nextGenId++}`,
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    countTokensOpenAIAsync: async () => 0,
    countTokensOpenAIItemsAsync: async () => 0,
    getEncodingTokenizerType: () => 0,
    getTokenizerModel: () => '',
    tokenizers: {},
}));
jest.unstable_mockModule('../public/scripts/last-usage.js', () => ({ setLastUsage: noop }));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: () => false }));
jest.unstable_mockModule('../public/scripts/logprobs.js', () => ({ saveLogprobsForActiveMessage: noop }));
jest.unstable_mockModule('../public/scripts/preset-persistence.js', () => ({ persistPreset: async () => ({ ok: true }) }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({ SlashCommandParser: { addCommandObject: noop } }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: { fromProps: (x) => x } }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: {},
    SlashCommandArgument: { fromProps: (x) => x },
    SlashCommandNamedArgument: { fromProps: (x) => x },
}));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: async () => '' }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({ SlashCommandEnumValue: StubClass }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({ commonEnumProviders: {} }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup: asyncNoop,
    Popup: StubClass,
    POPUP_RESULT: {},
    POPUP_TYPE: {},
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
    translate: (s) => String(s ?? ''),
}));
jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
    ToolManager: { canPerformToolCalls: () => false, getToolsForPrompt: () => [] },
}));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: () => null, setItem: noop, removeItem: noop },
}));
jest.unstable_mockModule('../public/scripts/util/AbortReason.js', () => ({ AbortReason: {} }));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/profile-resolver.js', () => ({
    resolveChatCompletionRequestProfile: () => null,
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    COMETAPI_IGNORE_PATTERNS: [],
    IGNORE_SYMBOL: Symbol('IGNORE'),
    MEDIA_DISPLAY: {},
    MEDIA_TYPE: {},
}));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    maybeDeleteLinkedLorebookForPresetDeletion: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/undo-toast.js', () => ({ showUndoToast: noop }));
jest.unstable_mockModule('../public/scripts/extensions/function-call-runtime.js', () => ({
    PlainTextFunctionCallStreamDetector: StubClass,
    TOOL_PROTOCOL_STYLE: { JSON_SCHEMA: 'json_schema', TABLE: 'table' },
    resolveFunctionCallMode: () => 'native',
}));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    syncNanoGptProvidersForModel: noop,
    syncOpenRouterProvidersForModel: noop,
    updateNanoGptProvidersWarning: noop,
    updateOpenRouterProvidersWarning: noop,
}));
jest.unstable_mockModule('../public/scripts/macros/util/escape.js', () => ({
    unescapeMacroBracesInRequestData: (x) => x,
}));
jest.unstable_mockModule('../public/scripts/character/preset-mutation.js', () => ({
    createPresetLineage: () => ({}),
    preparePresetMutation: (x) => x,
}));
jest.unstable_mockModule('../public/scripts/character/save-dispatch.js', () => ({
    readSelectedPresetRef: () => null,
    decideSavePresetDispatch: () => null,
}));
jest.unstable_mockModule('../public/scripts/character/has-unsaved-openai-preset-changes.js', () => ({
    hasUnsavedOpenAIPresetChanges: () => false,
}));
jest.unstable_mockModule('../public/scripts/character/character-bound-preset-state-sync.js', () => ({
    updateCharacterBoundPresetActiveState: noop,
    clearCharacterBoundActiveAfterRemoval: noop,
}));
jest.unstable_mockModule('../public/scripts/character/presets.js', () => ({
    listCharacterBoundPresets: () => [],
    readCharacterBoundState: () => null,
    readCharacterBoundStateRaw: () => ({ presets: [], defaultPresetName: null }),
    getCharacterBoundPreset: () => null,
    addCharacterBoundPreset: asyncNoop,
    updateCharacterBoundPreset: asyncNoop,
    setCharacterBoundDefault: asyncNoop,
    clearAllCharacterBoundPresets: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/st-context.js', () => ({
    getContext: () => ({ characters: mockCharacters, characterId: 0 }),
}));
jest.unstable_mockModule('../public/scripts/chat-message-shape.js', () => ({
    shapeChatMessagePayload: (m) => m,
}));

let sendOpenAIRequest;
let getStreamingReply;
let getLastOpenAIGenerationId;
let isLastOpenAIReplyPersistedByServer;
let oai_settings;

beforeAll(async () => {
    const makeJq = () => {
        const jq = {
            on: () => jq, off: () => jq, val: () => '', prop: () => false, attr: () => jq,
            text: () => '', html: () => '', trigger: () => jq, empty: () => jq, append: () => jq,
            find: () => jq, children: () => jq, addClass: () => jq, removeClass: () => jq,
            toggleClass: () => jq, show: () => jq, hide: () => jq, toggle: () => jq, css: () => jq,
            length: 0,
        };
        return jq;
    };
    globalThis.$ = makeJq;
    globalThis.jQuery = makeJq;
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: noop,
    };
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: noop, removeItem: noop },
    });
    const mod = await import('../public/scripts/openai.js');
    ({ sendOpenAIRequest, getStreamingReply, getLastOpenAIGenerationId, isLastOpenAIReplyPersistedByServer, oai_settings } = mod);
    globalThis.toastr = { info: jest.fn(), error: jest.fn(), warning: jest.fn(), success: jest.fn() };
});

beforeEach(() => {
    liveMainApi = 'openai';
    nextGenId = 1;
    mockCreateProtocolStreamParserImpl = null;
    mockOnLukerResponseMeta.mockClear();
    oai_settings.chat_completion_source = 'openai';
    oai_settings.openai_model = 'gpt-4o';
    oai_settings.stream_openai = true;
    oai_settings.max_context = 4096;
    oai_settings.openai_max_tokens = 200;
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('openai.js onLukerResponseMeta disposal and stale generationId / token guards', () => {
    test('streaming request ignores stale generation_id & stale generation token and disposes listener after drain', async () => {
        const resp = makeSseResponse({
            headers: { 'x-luker-generation-id': 'oai-gen-1' },
            events: [JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }), '[DONE]'],
        });
        globalThis.fetch = jest.fn(async () => resp);

        const stream = await sendOpenAIRequest('normal', [{ role: 'user', content: 'hello' }], new AbortController().signal);
        expect(listenerCount(resp)).toBe(1);
        expect(getLastOpenAIGenerationId()).toBe('oai-gen-1');
        expect(isLastOpenAIReplyPersistedByServer()).toBe(false);

        // Stale mismatched generation_id is ignored
        emitMeta(resp, { generation_id: 'oai-gen-stale', persisted: true });
        expect(isLastOpenAIReplyPersistedByServer()).toBe(false);
        expect(getLastOpenAIGenerationId()).toBe('oai-gen-1');

        // Matching generation_id updates state
        emitMeta(resp, { generation_id: 'oai-gen-1', persisted: true });
        expect(isLastOpenAIReplyPersistedByServer()).toBe(true);

        // Draining stream disposes listener in finally
        const chunks = [];
        for await (const chunk of stream()) {
            chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(0);
        expect(listenerCount(resp)).toBe(0);
    });

    test('disposes previous listener on abort, on new generation (with stale-token rejection), and after non-stream response.json()', async () => {
        // 1. Abort disposes streaming listener
        const abortResp = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-1' } });
        globalThis.fetch = jest.fn(async () => abortResp);
        const ac = new AbortController();
        await sendOpenAIRequest('normal', [{ role: 'user', content: 'abort me' }], ac.signal);
        expect(listenerCount(abortResp)).toBe(1);
        ac.abort();
        expect(listenerCount(abortResp)).toBe(0);

        // 2. Starting a second generation disposes the first listener and rejects late callbacks on it
        const resp1 = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-2' } });
        const resp2 = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-3' } });
        let call = 0;
        globalThis.fetch = jest.fn(async () => (++call === 1 ? resp1 : resp2));
        await sendOpenAIRequest('normal', [{ role: 'user', content: 'first' }], new AbortController().signal);
        expect(listenerCount(resp1)).toBe(1);
        const listener1 = [...metaListeners.get(resp1)][0];

        const ac2 = new AbortController();
        await sendOpenAIRequest('normal', [{ role: 'user', content: 'second' }], ac2.signal);
        expect(listenerCount(resp1)).toBe(0);
        expect(listenerCount(resp2)).toBe(1);
        expect(getLastOpenAIGenerationId()).toBe('oai-gen-3');
        expect(isLastOpenAIReplyPersistedByServer()).toBe(false);

        // Even if listener1 is invoked late directly, stale token guard drops it
        listener1({ generation_id: 'oai-gen-2', persisted: true });
        expect(getLastOpenAIGenerationId()).toBe('oai-gen-3');
        expect(isLastOpenAIReplyPersistedByServer()).toBe(false);

        ac2.abort();
        expect(listenerCount(resp2)).toBe(0);

        // 3. Non-streaming response disposes listener in finally after response.json()
        oai_settings.stream_openai = false;
        let releaseJson;
        const jsonGate = new Promise((res) => { releaseJson = res; });
        const nonStreamResp = makeJsonResponse({
            headers: { 'x-luker-generation-id': 'oai-gen-4' },
            jsonGate,
        });
        globalThis.fetch = jest.fn(async () => nonStreamResp);
        const req = sendOpenAIRequest('normal', [{ role: 'user', content: 'non-stream' }], new AbortController().signal);
        await new Promise(r => setTimeout(r, 0));
        expect(listenerCount(nonStreamResp)).toBe(1);
        emitMeta(nonStreamResp, { generation_id: 'oai-gen-4', persisted: true });
        expect(isLastOpenAIReplyPersistedByServer()).toBe(true);
        releaseJson();
        await req;
        expect(listenerCount(nonStreamResp)).toBe(0);
    });

    test('ignores mismatched x-luker-generation-id header without overwriting persisted state or subscribing', async () => {
        const resp = makeSseResponse({
            headers: {
                'x-luker-generation-id': 'oai-gen-wrong',
                'x-luker-server-persisted': '1',
            },
            events: ['[DONE]'],
        });
        globalThis.fetch = jest.fn(async () => resp);

        const ac = new AbortController();
        const addSpy = jest.spyOn(ac.signal, 'addEventListener');

        await sendOpenAIRequest('normal', [{ role: 'user', content: 'mismatched header' }], ac.signal);

        expect(getLastOpenAIGenerationId()).toBe('oai-gen-1');
        expect(isLastOpenAIReplyPersistedByServer()).toBe(false);
        expect(mockOnLukerResponseMeta).not.toHaveBeenCalled();
        expect(listenerCount(resp)).toBe(0);
        expect(addSpy).not.toHaveBeenCalled();
    });

    test('cleans up response meta and signal abort listeners when stream setup throws', async () => {
        const pipeErrResp = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-1' } });
        pipeErrResp.body.pipeThrough = () => {
            throw new Error('pipe setup boom');
        };
        globalThis.fetch = jest.fn(async () => pipeErrResp);

        const ac1 = new AbortController();
        const addSpy1 = jest.spyOn(ac1.signal, 'addEventListener');
        const removeSpy1 = jest.spyOn(ac1.signal, 'removeEventListener');

        await expect(sendOpenAIRequest('normal', [{ role: 'user', content: 'pipe fail' }], ac1.signal))
            .rejects.toThrow('pipe setup boom');

        expect(listenerCount(pipeErrResp)).toBe(0);
        expect(addSpy1).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        expect(removeSpy1).toHaveBeenCalledWith('abort', addSpy1.mock.calls[0][1]);

        const parserErrResp = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-2' } });
        globalThis.fetch = jest.fn(async () => parserErrResp);
        mockCreateProtocolStreamParserImpl = () => {
            throw new Error('parser init boom');
        };

        const ac2 = new AbortController();
        const addSpy2 = jest.spyOn(ac2.signal, 'addEventListener');
        const removeSpy2 = jest.spyOn(ac2.signal, 'removeEventListener');

        await expect(sendOpenAIRequest('normal', [{ role: 'user', content: 'parser fail' }], ac2.signal))
            .rejects.toThrow('parser init boom');

        expect(listenerCount(parserErrResp)).toBe(0);
        expect(addSpy2).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        expect(removeSpy2).toHaveBeenCalledWith('abort', addSpy2.mock.calls[0][1]);
    });

    test('starting a subsequent generation detaches the previous signal abort listener and clears its disposer', async () => {
        const resp1 = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-1' } });
        const resp2 = makeSseResponse({ headers: { 'x-luker-generation-id': 'oai-gen-2' } });
        let call = 0;
        globalThis.fetch = jest.fn(async () => (++call === 1 ? resp1 : resp2));

        const ac1 = new AbortController();
        const addSpy1 = jest.spyOn(ac1.signal, 'addEventListener');
        const removeSpy1 = jest.spyOn(ac1.signal, 'removeEventListener');
        await sendOpenAIRequest('normal', [{ role: 'user', content: 'first' }], ac1.signal);
        expect(listenerCount(resp1)).toBe(1);
        expect(addSpy1).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        const registeredAbortHandler = addSpy1.mock.calls[0][1];

        const ac2 = new AbortController();
        await sendOpenAIRequest('normal', [{ role: 'user', content: 'second' }], ac2.signal);
        expect(listenerCount(resp1)).toBe(0);
        expect(disposeCount(resp1)).toBe(1);
        expect(removeSpy1).toHaveBeenCalledWith('abort', registeredAbortHandler);

        // Aborting signal1 afterwards must not call resp1's disposer a second time or affect resp2.
        ac1.abort();
        expect(disposeCount(resp1)).toBe(1);
        expect(listenerCount(resp2)).toBe(1);

        ac2.abort();
        expect(listenerCount(resp2)).toBe(0);
    });
});

describe('openai.js getStreamingReply compatibility export', () => {
    test('extracts streaming text and reasoning state across OpenAI, Claude, Gemini, OpenRouter, and Mistral', () => {
        expect(typeof getStreamingReply).toBe('function');

        const oaiState = { reasoning: '' };
        expect(getStreamingReply({ choices: [{ delta: { content: 'hello' } }] }, oaiState, { chatCompletionSource: 'openai' })).toBe('hello');

        const claudeState = { reasoning: '', reasoningBlocks: [] };
        getStreamingReply({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'a' } }, claudeState, { chatCompletionSource: 'claude', overrideShowThoughts: true });
        getStreamingReply({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } }, claudeState, { chatCompletionSource: 'claude', overrideShowThoughts: true });
        getStreamingReply({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }, claudeState, { chatCompletionSource: 'claude', overrideShowThoughts: true });
        expect(getStreamingReply({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }, claudeState, { chatCompletionSource: 'claude', overrideShowThoughts: true })).toBe('world');
        expect(claudeState.reasoning).toBe('b');
        expect(claudeState.reasoningBlocks[0]).toEqual({ type: 'thinking', thinking: 'ab', signature: 'sig-1' });

        const geminiState = { reasoning: '', images: [], signature: '' };
        expect(getStreamingReply({
            candidates: [{ content: { parts: [{ thought: true, text: 'plan' }, { text: 'reply', thoughtSignature: 'gsig' }] } }],
        }, geminiState, { chatCompletionSource: 'makersuite', overrideShowThoughts: true })).toBe('reply');
        expect(geminiState.reasoning).toBe('plan');
        expect(geminiState.signature).toBe('gsig');

        const orState = { reasoning: '', images: [], reasoningDetails: [], toolSignatures: {} };
        expect(getStreamingReply({
            choices: [{
                delta: {
                    content: 'ok',
                    reasoning: 'think',
                    reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_1', data: 'enc' }],
                },
            }],
        }, orState, { chatCompletionSource: 'openrouter', overrideShowThoughts: true })).toBe('ok');
        expect(orState.reasoning).toBe('think');
        expect(orState.toolSignatures).toEqual({ call_1: 'enc' });

        const mistralState = { reasoning: '' };
        expect(getStreamingReply({
            choices: [{ delta: { content: [{ thinking: [{ text: 'm-think' }], text: 'm-text' }] } }],
        }, mistralState, { chatCompletionSource: 'mistralai', overrideShowThoughts: true })).toBe('m-text');
        expect(mistralState.reasoning).toBe('m-think');
    });
});
