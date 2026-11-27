import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    getActiveActivities,
    hasUnloadGuard,
    hasChatSwitchGuard,
    hasKeepAliveHold,
    hasActiveSource,
    subscribeActivityGuard,
} from '../../public/scripts/activity-guard.js';
import { createCompletionServices } from '../../public/scripts/custom-request-core.js';

const { ChatCompletionService, TextCompletionService } = createCompletionServices({
    getPresetManager: () => null,
    extractJsonFromData: (json) => json?.choices?.[0]?.message?.content ?? '{}',
    extractMessageFromData: (json) => json?.choices?.[0]?.message?.content ?? json?.results?.[0]?.text ?? '',
    getGenerateUrl: (type) => `/api/generate/${type}`,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    getName1: () => 'User',
    getName2: () => 'Char',
    getTextGenServer: () => 'http://127.0.0.1:5000',
    createTextGenGenerationData: (_s, model, prompt, maxTokens) => ({ prompt, model, max_tokens: maxTokens }),
    getTextGenSettingNames: () => [],
    getTextGenSettings: () => ({}),
    extractReasoningFromData: () => '',
    formatInstructModeChat: (_n, content) => content,
    formatInstructModePrompt: () => '',
    getInstructStoppingSequences: () => [],
    tryParseStreamingError: () => {},
    createGenerationParameters: async () => ({ generate_data: {} }),
    isOpenAIConnectionPresetField: () => false,
    getOpenAISettingsToUpdate: () => ({}),
    getOpenAISettings: () => ({}),
});

function makeSseBody(events) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const ev of events) {
                controller.enqueue(encoder.encode(`data: ${ev}\n\n`));
            }
            controller.close();
        },
    });
}

function makeControlledSseBody() {
    const encoder = new TextEncoder();
    let streamController;
    const body = new ReadableStream({
        start(controller) {
            streamController = controller;
        },
    });
    return {
        body,
        push(data) {
            streamController.enqueue(encoder.encode(`data: ${data}\n\n`));
        },
        close() {
            streamController.close();
        },
        error(err) {
            streamController.error(err);
        },
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('custom-request automatic activity leases', () => {
    const origFetch = globalThis.fetch;

    beforeEach(() => {
        if (getActiveActivities().length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    describe.each([
        {
            name: 'ChatCompletionService',
            getService: () => ChatCompletionService,
            makePayload: (stream = false) => ({
                stream,
                messages: [{ role: 'user', content: 'hi' }],
                chat_completion_source: 'openai',
                max_tokens: 100,
            }),
            makeOkJson: () => ({ choices: [{ message: { content: 'chat reply' } }] }),
            makeChunk: (text) => JSON.stringify({ choices: [{ delta: { content: text } }] }),
        },
        {
            name: 'TextCompletionService',
            getService: () => TextCompletionService,
            makePayload: (stream = false) => ({
                stream,
                prompt: 'hi',
                api_type: 'ooba',
                api_server: 'http://127.0.0.1:5000',
                max_tokens: 100,
            }),
            makeOkJson: () => ({ choices: [{ message: { content: 'text reply' } }], results: [{ text: 'text reply' }] }),
            makeChunk: (text) => JSON.stringify({ choices: [{ text }] }),
        },
    ])('$name', ({ getService, makePayload, makeOkJson, makeChunk }) => {
        test('non-streaming holds core:custom-request lease across fetch + response.json, releases on resolve, and omits activity from POST body', async () => {
            const Service = getService();
            const fetchGate = deferred();
            const jsonGate = deferred();
            let observedDuringFetch = null;
            let observedDuringJson = null;
            let postedBody = null;

            globalThis.fetch = jest.fn(async (_url, init) => {
                postedBody = JSON.parse(init.body);
                observedDuringFetch = getActiveActivities();
                await fetchGate.promise;
                return {
                    ok: true,
                    json: async () => {
                        observedDuringJson = getActiveActivities();
                        await jsonGate.promise;
                        return makeOkJson();
                    },
                };
            });

            const payload = makePayload(false);
            const reqPromise = Service.sendRequest(payload, true, null);

            await Promise.resolve();
            expect(observedDuringFetch).toHaveLength(1);
            expect(hasUnloadGuard()).toBe(true);
            expect(hasChatSwitchGuard()).toBe(false);
            expect(hasKeepAliveHold()).toBe(true);
            expect(hasKeepAliveHold({ excludeAmbient: true })).toBe(false);
            expect(observedDuringFetch[0]).toMatchObject({
                source: 'core:custom-request',
                label: expect.stringMatching(/\S/),
                scope: 'global',
                ambient: true,
                guardUnload: true,
                guardChatSwitch: false,
                keepAlive: true,
            });
            expect(Object.hasOwn(payload, 'activity')).toBe(false);
            expect(Object.hasOwn(postedBody, 'activity')).toBe(false);

            fetchGate.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(observedDuringJson).toHaveLength(1);
            expect(hasActiveSource('core:custom-request')).toBe(true);

            jsonGate.resolve();
            const res = await reqPromise;
            expect(res.content).toBeTruthy();
            expect(getActiveActivities()).toEqual([]);
            expect(hasUnloadGuard()).toBe(false);
        });

        test('non-streaming releases lease on HTTP error', async () => {
            const Service = getService();
            globalThis.fetch = jest.fn(async () => {
                expect(hasActiveSource('core:custom-request')).toBe(true);
                return {
                    ok: false,
                    status: 500,
                    json: async () => ({ error: { message: 'Server failed' } }),
                };
            });

            await expect(Service.sendRequest(makePayload(false), true, null)).rejects.toThrow('Server failed');
            expect(getActiveActivities()).toEqual([]);
        });

        test('non-streaming respects activity: false in 4th parameter', async () => {
            const Service = getService();
            const listener = jest.fn();
            const unsub = subscribeActivityGuard(listener);
            try {
                let activeDuringFetch = null;
                globalThis.fetch = jest.fn(async () => {
                    activeDuringFetch = getActiveActivities();
                    return { ok: true, json: async () => makeOkJson() };
                });

                await Service.sendRequest(makePayload(false), true, null, { activity: false });
                expect(activeDuringFetch).toEqual([]);
                expect(listener).not.toHaveBeenCalled();
            } finally {
                unsub();
            }
        });

        test('streaming setup releases before returning factory so dropping un-invoked factory never leaks', async () => {
            const Service = getService();
            const fetchGate = deferred();
            let activeDuringFetch = null;
            let postedBody = null;

            globalThis.fetch = jest.fn(async (_url, init) => {
                postedBody = JSON.parse(init.body);
                activeDuringFetch = getActiveActivities();
                await fetchGate.promise;
                return {
                    ok: true,
                    body: makeSseBody([makeChunk('hello'), '[DONE]']),
                };
            });

            const reqPromise = Service.sendRequest(makePayload(true), true, null);
            await Promise.resolve();
            expect(activeDuringFetch).toHaveLength(1);
            expect(hasActiveSource('core:custom-request')).toBe(true);
            expect(Object.hasOwn(postedBody, 'activity')).toBe(false);

            fetchGate.resolve();
            const streamFactory = await reqPromise;
            expect(typeof streamFactory).toBe('function');

            expect(hasUnloadGuard()).toBe(false);
            expect(getActiveActivities()).toEqual([]);
        });

        test('streaming setup releases on HTTP error', async () => {
            const Service = getService();
            globalThis.fetch = jest.fn(async () => {
                expect(hasActiveSource('core:custom-request')).toBe(true);
                return {
                    ok: false,
                    status: 502,
                    text: async () => 'bad gateway',
                };
            });

            await expect(Service.sendRequest(makePayload(true), true, null)).rejects.toThrow('Got response status 502');
            expect(getActiveActivities()).toEqual([]);
        });

        test('stream consumption holds fresh lease during reads and releases on normal EOF', async () => {
            const Service = getService();
            const sse = makeControlledSseBody();

            globalThis.fetch = jest.fn(async () => ({
                ok: true,
                body: sse.body,
            }));

            const streamFactory = await Service.sendRequest(makePayload(true), true, null);
            expect(getActiveActivities()).toEqual([]);

            const collected = [];
            const consumePromise = (async () => {
                for await (const frame of streamFactory()) {
                    expect(hasActiveSource('core:custom-request')).toBe(true);
                    collected.push(frame.text);
                }
            })();

            await Promise.resolve();
            expect(hasActiveSource('core:custom-request')).toBe(true);
            expect(hasUnloadGuard()).toBe(true);

            sse.push(makeChunk('hel'));
            sse.push(makeChunk('lo'));
            sse.push('[DONE]');
            sse.close();

            await consumePromise;
            expect(collected).toEqual(['hel', 'hello']);
            expect(getActiveActivities()).toEqual([]);
            expect(hasUnloadGuard()).toBe(false);
        });

        test('stream consumption releases on stream error', async () => {
            const Service = getService();
            const sse = makeControlledSseBody();

            globalThis.fetch = jest.fn(async () => ({
                ok: true,
                body: sse.body,
            }));

            const streamFactory = await Service.sendRequest(makePayload(true), true, null);
            expect(getActiveActivities()).toEqual([]);

            let caught = null;
            const consumePromise = (async () => {
                try {
                    for await (const frame of streamFactory()) {
                        void frame;
                        expect(hasActiveSource('core:custom-request')).toBe(true);
                    }
                } catch (err) {
                    caught = err;
                }
            })();

            await Promise.resolve();
            expect(hasActiveSource('core:custom-request')).toBe(true);

            sse.push('not-valid-json');
            sse.close();

            await consumePromise;
            expect(caught).toBeTruthy();
            expect(getActiveActivities()).toEqual([]);
            expect(hasUnloadGuard()).toBe(false);
        });

        test('stream consumption releases on early break (.return())', async () => {
            const Service = getService();
            const sse = makeControlledSseBody();

            globalThis.fetch = jest.fn(async () => ({
                ok: true,
                body: sse.body,
            }));

            const streamFactory = await Service.sendRequest(makePayload(true), true, null);
            expect(getActiveActivities()).toEqual([]);

            const consumePromise = (async () => {
                for await (const frame of streamFactory()) {
                    void frame;
                    expect(hasActiveSource('core:custom-request')).toBe(true);
                    break;
                }
            })();

            await Promise.resolve();
            expect(hasActiveSource('core:custom-request')).toBe(true);

            sse.push(makeChunk('first'));
            await consumePromise;
            expect(getActiveActivities()).toEqual([]);
            expect(hasUnloadGuard()).toBe(false);
        });

        test('streaming respects activity: false across both setup and stream consumption', async () => {
            const Service = getService();
            const listener = jest.fn();
            const unsub = subscribeActivityGuard(listener);
            try {
                globalThis.fetch = jest.fn(async () => {
                    expect(getActiveActivities()).toEqual([]);
                    return { ok: true, body: makeSseBody([makeChunk('hi'), '[DONE]']) };
                });

                const streamFactory = await Service.sendRequest(makePayload(true), true, null, { activity: false });
                for await (const frame of streamFactory()) {
                    void frame;
                    expect(getActiveActivities()).toEqual([]);
                }
                expect(listener).not.toHaveBeenCalled();
            } finally {
                unsub();
            }
        });

        test('processRequest forwards activity override without leaking it into POST body', async () => {
            const Service = getService();
            let observed = null;
            let postedBody = null;
            globalThis.fetch = jest.fn(async (_url, init) => {
                postedBody = JSON.parse(init.body);
                observed = getActiveActivities();
                return { ok: true, json: async () => makeOkJson() };
            });

            await Service.processRequest(
                makePayload(false),
                { activity: { scope: 'chat', label: 'Custom op', ambient: false } },
                true,
                null,
            );
            expect(observed).toHaveLength(1);
            expect(observed[0]).toMatchObject({
                source: 'core:custom-request',
                scope: 'chat',
                label: 'Custom op',
                ambient: false,
                guardChatSwitch: true,
            });
            expect(Object.hasOwn(postedBody, 'activity')).toBe(false);
            expect(getActiveActivities()).toEqual([]);
        });
    });
});
