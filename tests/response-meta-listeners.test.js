// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, jest } from '@jest/globals';

const metaListeners = new WeakMap();
const disposedListeners = [];

function emitMeta(response, meta) {
    const set = metaListeners.get(response);
    if (!set) return;
    for (const fn of [...set]) fn({ ...meta });
}

function listenerCount(response) {
    return metaListeners.get(response)?.size ?? 0;
}

const mockOnLukerResponseMeta = jest.fn((response, listener) => {
    if (!metaListeners.has(response)) metaListeners.set(response, new Set());
    const set = metaListeners.get(response);
    set.add(listener);
    return () => {
        if (set.delete(listener)) {
            disposedListeners.push({ response, listener });
        }
    };
});

function makeSseResponse({ ok = true, status = 200, headers = {}, events = [] } = {}) {
    let idx = 0;
    const readable = {
        getReader: () => ({
            read: async () => {
                if (idx >= events.length) return { done: true, value: undefined };
                return { done: false, value: { data: events[idx++] } };
            },
        }),
    };
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        headers: {
            get: (name) => headers[String(name).toLowerCase()] ?? null,
        },
        text: async () => JSON.stringify({ error: { message: 'boom' } }),
        body: {
            pipeThrough: (stream) => {
                stream._attach(readable);
                return stream;
            },
        },
    };
}

let mockEventStreamFactory = () => {
    let attached = null;
    return {
        _attach(r) { attached = r; },
        get readable() { return attached; },
    };
};

const noop = () => {};
const asyncNoop = async () => {};

jest.unstable_mockModule('../public/script.js', () => ({
    ensureFullSettingsLoaded: asyncNoop,
    getRequestHeaders: () => ({}),
    saveSettingsDebounced: noop,
    getStoppingStrings: () => [],
    substituteParams: (s) => s,
    setOnlineStatus: noop,
    resultCheckStatus: asyncNoop,
    main_api: 'kobold',
    max_context: 4096,
    online_status: 'no_connection',
    abortStatusCheck: noop,
    startStatusLoading: noop,
    setGenerationParamsFromPreset: noop,
    eventSource: { on: noop, emit: asyncNoop },
    event_types: {},
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
}));
jest.unstable_mockModule('../public/scripts/instruct-mode.js', () => ({
    autoSelectInstructPreset: noop,
    selectContextPreset: noop,
    selectInstructPreset: noop,
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/profile-retry.js', () => ({
    withProfileRetry: async (fn) => fn(),
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/request-timeout.js', () => ({
    getRequestTimeoutMs: () => 0,
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    MAX_CONTEXT_DEFAULT: 4096,
    MAX_RESPONSE_DEFAULT: 300,
    power_user: {},
    registerDebugFunction: noop,
}));
jest.unstable_mockModule('../public/scripts/sse-stream.js', () => ({
    getEventSourceStream: () => mockEventStreamFactory(),
}));
jest.unstable_mockModule('../public/scripts/ws-delivery.js', () => ({
    onLukerResponseMeta: mockOnLukerResponseMeta,
}));
jest.unstable_mockModule('../public/scripts/util/preset-hydration.js', () => ({
    hydrateIndexedPresetEntries: noop,
    hydrateOrderedPresetEntries: noop,
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    getOrderedPresetNames: () => [],
    getSortableDelay: () => 0,
    versionCompare: () => 0,
    getStringHash: () => 0,
    onlyUnique: () => true,
    arraysEqual: () => true,
    isObject: (x) => Boolean(x) && typeof x === 'object',
}));
jest.unstable_mockModule('../public/scripts/macros/util/escape.js', () => ({
    unescapeMacroBracesInRequestData: (x) => x,
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTextTokens: () => [],
    tokenizers: {},
    TOKENIZER_SUPPORTED_KEY: '',
    getEncodingTokenizerType: () => 0,
    getTokenizerBestMatch: () => 0,
}));
jest.unstable_mockModule('../public/scripts/logit-bias.js', () => ({
    BIAS_CACHE: new Map(),
    createNewLogitBiasEntry: noop,
    displayLogitBias: noop,
    getLogitBiasListResult: () => [],
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: asyncNoop,
}));
jest.unstable_mockModule('../public/scripts/chat-templates.js', () => ({
    deriveTemplatesFromChatTemplate: () => ({}),
}));
jest.unstable_mockModule('../public/scripts/samplerSelect.js', () => ({
    getActiveManualApiSamplers: () => [],
    loadApiSelectedSamplers: noop,
    isSamplerManualPriorityEnabled: () => false,
}));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: noop,
    getCurrentOpenRouterModelTokenizer: noop,
    loadAphroditeModels: noop,
    loadDreamGenModels: noop,
    loadFeatherlessModels: noop,
    loadGenericModels: noop,
    loadInfermaticAIModels: noop,
    loadLlamaCppModels: noop,
    loadMancerModels: noop,
    loadOllamaModels: noop,
    loadOpenRouterModels: noop,
    loadTabbyModels: noop,
    loadTogetherAIModels: noop,
    loadVllmModels: noop,
    updateOpenRouterProvidersWarning: noop,
}));
jest.unstable_mockModule('../public/scripts/util/AbortReason.js', () => ({ AbortReason: {} }));

let generateKoboldWithStreaming;
let generateNovelWithStreaming;
let generateTextGenWithStreaming;

beforeAll(async () => {
    const makeJq = () => {
        const jq = {
            on: () => jq,
            off: () => jq,
            val: () => '',
            prop: () => false,
            attr: () => jq,
            text: () => '',
            html: () => '',
            trigger: () => jq,
            empty: () => jq,
            append: () => jq,
            find: () => jq,
            children: () => jq,
            addClass: () => jq,
            removeClass: () => jq,
            toggleClass: () => jq,
            show: () => jq,
            hide: () => jq,
            toggle: () => jq,
            css: () => jq,
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
        addEventListener: () => {},
    };
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    globalThis.toastr = { info: jest.fn(), error: jest.fn(), warning: jest.fn(), success: jest.fn() };
    ({ generateKoboldWithStreaming } = await import('../public/scripts/kai-settings.js'));
    ({ generateNovelWithStreaming } = await import('../public/scripts/nai-settings.js'));
    ({ generateTextGenWithStreaming } = await import('../public/scripts/textgen-settings.js'));
});

beforeEach(() => {
    mockOnLukerResponseMeta.mockClear();
    disposedListeners.length = 0;
});

describe.each([
    ['kai-settings (kobold)', () => generateKoboldWithStreaming, JSON.stringify({ token: 'hi' })],
    ['nai-settings (novel)', () => generateNovelWithStreaming, JSON.stringify({ token: 'hi' })],
    ['textgen-settings (textgen)', () => generateTextGenWithStreaming, JSON.stringify({ choices: [{ text: 'hi' }] })],
])('%s onLukerResponseMeta disposal and generationId guard', (_label, getFn, sseEvent) => {
    test('ignores stale meta with mismatched generation_id and disposes listener after stream completes', async () => {
        const resp = makeSseResponse({
            headers: { 'x-luker-generation-id': 'gen-1' },
            events: [sseEvent],
        });
        globalThis.fetch = jest.fn(async () => resp);

        const received = [];
        const onLukerMeta = jest.fn((m) => received.push(m));
        const controller = new AbortController();
        const stream = await getFn()({ luker_generation: { job_id: 'gen-1' } }, controller.signal, { onLukerMeta });

        expect(listenerCount(resp)).toBe(1);

        // Stale generation_id is ignored
        emitMeta(resp, { generation_id: 'gen-stale', persisted: true });
        expect(received.filter(m => m.generationId === 'gen-stale')).toEqual([]);
        expect(received.filter(m => m.persisted === true)).toEqual([]);

        // Matching generation_id is forwarded
        emitMeta(resp, { generation_id: 'gen-1', persisted: true });
        expect(received).toContainEqual({ persisted: true });

        // Drain generator -> listener must be disposed in finally
        const chunks = [];
        for await (const chunk of stream()) {
            chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(0);
        expect(listenerCount(resp)).toBe(0);

        // Late meta after completion does nothing
        onLukerMeta.mockClear();
        emitMeta(resp, { generation_id: 'gen-1', persisted: false });
        expect(onLukerMeta).not.toHaveBeenCalled();
    });

    test('disposes listener on !response.ok and on signal abort', async () => {
        const errResp = makeSseResponse({ ok: false, status: 500 });
        globalThis.fetch = jest.fn(async () => errResp);
        await expect(getFn()({ luker_generation: { job_id: 'gen-err' } }, new AbortController().signal, {
            onLukerMeta: jest.fn(),
        })).rejects.toThrow(/500|boom/);
        expect(listenerCount(errResp)).toBe(0);

        const abortResp = makeSseResponse({ events: [sseEvent] });
        globalThis.fetch = jest.fn(async () => abortResp);
        const ac = new AbortController();
        await getFn()({ luker_generation: { job_id: 'gen-abort' } }, ac.signal, {
            onLukerMeta: jest.fn(),
        });
        expect(listenerCount(abortResp)).toBe(1);
        ac.abort();
        expect(listenerCount(abortResp)).toBe(0);
    });

    test('ignores mismatched x-luker-generation-id header without overwriting persisted state or subscribing', async () => {
        const resp = makeSseResponse({
            headers: {
                'x-luker-generation-id': 'gen-other',
                'x-luker-server-persisted': '1',
            },
            events: [sseEvent],
        });
        globalThis.fetch = jest.fn(async () => resp);

        const onLukerMeta = jest.fn();
        const ac = new AbortController();
        const addSpy = jest.spyOn(ac.signal, 'addEventListener');

        await getFn()({ luker_generation: { job_id: 'gen-1' } }, ac.signal, { onLukerMeta });

        expect(onLukerMeta).not.toHaveBeenCalled();
        expect(mockOnLukerResponseMeta).not.toHaveBeenCalled();
        expect(listenerCount(resp)).toBe(0);
        expect(addSpy).not.toHaveBeenCalled();
    });

    test('cleans up response meta and signal abort listeners when stream setup throws', async () => {
        const resp = makeSseResponse({ headers: { 'x-luker-generation-id': 'gen-setup-err' }, events: [sseEvent] });
        resp.body.pipeThrough = () => {
            throw new Error('pipeThrough setup failed');
        };
        globalThis.fetch = jest.fn(async () => resp);

        const ac = new AbortController();
        const addSpy = jest.spyOn(ac.signal, 'addEventListener');
        const removeSpy = jest.spyOn(ac.signal, 'removeEventListener');

        await expect(getFn()({ luker_generation: { job_id: 'gen-setup-err' } }, ac.signal, {
            onLukerMeta: jest.fn(),
        })).rejects.toThrow('pipeThrough setup failed');

        expect(listenerCount(resp)).toBe(0);
        expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        const registeredHandler = addSpy.mock.calls[0][1];
        expect(removeSpy).toHaveBeenCalledWith('abort', registeredHandler);
    });

    test('does not attach signal abort listener when onLukerMeta is omitted or synchronously disposed via onLukerMetaDisposer', async () => {
        const respNoMeta = makeSseResponse({ events: [sseEvent] });
        globalThis.fetch = jest.fn(async () => respNoMeta);
        const acNoMeta = new AbortController();
        const addNoMetaSpy = jest.spyOn(acNoMeta.signal, 'addEventListener');

        await getFn()({ luker_generation: { job_id: 'gen-nometa' } }, acNoMeta.signal);
        expect(addNoMetaSpy).not.toHaveBeenCalled();
        expect(listenerCount(respNoMeta)).toBe(0);

        const respSyncDispose = makeSseResponse({ headers: { 'x-luker-generation-id': 'gen-sync-dispose' }, events: [sseEvent] });
        globalThis.fetch = jest.fn(async () => respSyncDispose);
        const acSyncDispose = new AbortController();
        const addSyncDisposeSpy = jest.spyOn(acSyncDispose.signal, 'addEventListener');

        await getFn()({ luker_generation: { job_id: 'gen-sync-dispose' } }, acSyncDispose.signal, {
            onLukerMeta: jest.fn(),
            onLukerMetaDisposer: (dispose) => { dispose(); },
        });
        expect(listenerCount(respSyncDispose)).toBe(0);
        expect(addSyncDisposeSpy).not.toHaveBeenCalled();
    });
});
