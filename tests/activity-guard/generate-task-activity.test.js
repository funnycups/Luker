import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
    getActiveActivities,
    hasUnloadGuard,
    hasChatSwitchGuard,
    hasKeepAliveHold,
    hasActiveSource,
    subscribeActivityGuard,
    resolveRequestActivityLeaseOptions,
} from '../../public/scripts/activity-guard.js';
import { generateTask, generateTaskStream } from '../../public/scripts/generate-task.js';
import {
    requestToolCallWithRetry,
    requestToolCallsWithRetry,
} from '../../public/scripts/lib/iter-tool-calling.js';
import { aiRequest, aiTest } from '../../public/scripts/workbench/source-luker.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeInjected(overrides = {}) {
    return {
        profileResolver: ({ apiPresetName } = {}) => ({
            requestApi: apiPresetName === 'kobold' ? 'kobold' : 'openai',
            apiSettingsOverride: null,
        }),
        worldInfoResolver: async () => ({}),
        builder: ({ messages }) => messages,
        rawPromptBuilder: (msgs) => msgs.map(m => `${m.role}: ${m.content}`).join('\n'),
        senders: {},
        ...overrides,
    };
}

describe('resolveRequestActivityLeaseOptions', () => {
    const origLuker = globalThis.Luker;

    afterEach(() => {
        globalThis.Luker = origLuker;
    });

    test('returns null when activity === false', () => {
        expect(resolveRequestActivityLeaseOptions(false, 'core:generate-task')).toBeNull();
    });

    test('returns global ambient defaults and resolves default label lazily via Luker.getContext().translate', () => {
        globalThis.Luker = {
            getContext: () => ({
                translate: (key) => (key === 'Background AI request' ? '后台 AI 请求' : key),
            }),
        };

        expect(resolveRequestActivityLeaseOptions(true, 'core:generate-task')).toEqual({
            source: 'core:generate-task',
            label: '后台 AI 请求',
            scope: 'global',
            ambient: true,
            guardUnload: true,
            keepAlive: true,
        });

        expect(resolveRequestActivityLeaseOptions(undefined, 'core:custom-request', { defaultLabel: 'Explicit label' })).toEqual({
            source: 'core:custom-request',
            label: 'Explicit label',
            scope: 'global',
            ambient: true,
            guardUnload: true,
            keepAlive: true,
        });
    });

    test('falls back to English default label when Luker context is unavailable and merges plain object overrides', () => {
        globalThis.Luker = undefined;

        expect(resolveRequestActivityLeaseOptions(
            { scope: 'chat', label: 'Custom', ambient: false },
            'core:generate-task',
        )).toEqual({
            source: 'core:generate-task',
            label: 'Custom',
            scope: 'chat',
            ambient: false,
            guardUnload: true,
            keepAlive: true,
        });
    });
});

describe('generateTask activity lease', () => {
    beforeEach(() => {
        if (getActiveActivities().length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    afterEach(() => {
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    test('holds baseline core:generate-task lease while sender is pending and releases on resolve', async () => {
        const pending = deferred();
        let observedDuringRequest = null;

        const fakeOpenAI = async () => {
            observedDuringRequest = {
                activities: getActiveActivities(),
                unload: hasUnloadGuard(),
                chatSwitch: hasChatSwitchGuard(),
                keepAlive: hasKeepAliveHold(),
                keepAliveNonAmbient: hasKeepAliveHold({ excludeAmbient: true }),
            };
            return await pending.promise;
        };

        const taskPromise = generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, {
            _injected: makeInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }),
        });

        // Wait until async generateTask reaches sender
        await Promise.resolve();
        await Promise.resolve();

        expect(observedDuringRequest).toBeTruthy();
        expect(observedDuringRequest.unload).toBe(true);
        expect(observedDuringRequest.chatSwitch).toBe(false);
        expect(observedDuringRequest.keepAlive).toBe(true);
        expect(observedDuringRequest.keepAliveNonAmbient).toBe(false);
        expect(observedDuringRequest.activities).toHaveLength(1);
        expect(observedDuringRequest.activities[0]).toMatchObject({
            source: 'core:generate-task',
            label: 'Background AI request',
            scope: 'global',
            ambient: true,
            guardUnload: true,
            guardChatSwitch: false,
            keepAlive: true,
        });

        pending.resolve({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
        const result = await taskPromise;
        expect(result.assistantText).toBe('done');
        expect(getActiveActivities()).toEqual([]);
        expect(hasUnloadGuard()).toBe(false);
    });

    test('releases lease when sender rejects', async () => {
        const fakeOpenAI = async () => {
            expect(hasActiveSource('core:generate-task')).toBe(true);
            throw new Error('upstream boom');
        };

        await expect(generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, {
            _injected: makeInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }),
        })).rejects.toMatchObject({ name: 'GenerateTaskError' });

        expect(getActiveActivities()).toEqual([]);
        expect(hasUnloadGuard()).toBe(false);
    });

    test('acquires NO lease when activity: false', async () => {
        const listener = jest.fn();
        const unsub = subscribeActivityGuard(listener);
        try {
            let activeDuringSender = null;
            const fakeOpenAI = async () => {
                activeDuringSender = getActiveActivities();
                return { choices: [{ message: { content: 'quiet' }, finish_reason: 'stop' }] };
            };

            const res = await generateTask({
                taskMessages: [{ role: 'user', content: 'hi' }],
                activity: false,
            }, {
                _injected: makeInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }),
            });

            expect(res.assistantText).toBe('quiet');
            expect(activeDuringSender).toEqual([]);
            expect(listener).not.toHaveBeenCalled();
        } finally {
            unsub();
        }
    });

    test('honors custom activity object overrides', async () => {
        let observed = null;
        const fakeOpenAI = async () => {
            observed = getActiveActivities();
            return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
        };

        await generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
            activity: { scope: 'chat', label: 'Custom', ambient: false },
        }, {
            _injected: makeInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }),
        });

        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            source: 'core:generate-task',
            scope: 'chat',
            label: 'Custom',
            ambient: false,
            guardUnload: true,
            guardChatSwitch: true,
            keepAlive: true,
        });
        expect(getActiveActivities()).toEqual([]);
    });

    test('holds lease until preset-driven streaming transport completes inside generateTask', async () => {
        const step = deferred();
        const fakeOpenAI = async () => async function* () {
            expect(hasActiveSource('core:generate-task')).toBe(true);
            yield { text: 'part', toolCalls: [], state: { reasoning: '' } };
            await step.promise;
            expect(hasActiveSource('core:generate-task')).toBe(true);
            yield { text: 'part-2', toolCalls: [], state: { reasoning: '', finishReason: 'stop' } };
        };

        const p = generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
            llmPresetName: 'Streamy',
        }, {
            _injected: makeInjected({
                senders: {
                    sendOpenAIRequest: fakeOpenAI,
                    getOpenAiRuntime: () => ({
                        oai_settings: { stream_openai: true },
                        openai_settings: [{ stream_openai: true }],
                        openai_setting_names: { Streamy: 0 },
                    }),
                },
            }),
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(hasActiveSource('core:generate-task')).toBe(true);

        step.resolve();
        const result = await p;
        expect(result.assistantText).toBe('part-2');
        expect(getActiveActivities()).toEqual([]);
    });
});

describe('generateTaskStream activity lease', () => {
    beforeEach(() => {
        if (getActiveActivities().length > 0) {
            throw new Error(`Expected empty activity guard before test, got: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    afterEach(() => {
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    test('acquires lease synchronously before returning and releases after stream completion even when caller ignores result', async () => {
        const chunkGate = deferred();
        const fakeStreamingOpenAI = async () => async function* () {
            expect(hasActiveSource('core:generate-task')).toBe(true);
            yield { text: 'Hello', toolCalls: [], state: { reasoning: '' } };
            await chunkGate.promise;
            expect(hasActiveSource('core:generate-task')).toBe(true);
            yield { text: 'Hello!', toolCalls: [], state: { reasoning: '', finishReason: 'stop' } };
        };

        const { stream } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, {
            _injected: makeInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }),
        });

        // Acquired synchronously on call before any await
        expect(hasActiveSource('core:generate-task')).toBe(true);
        expect(getActiveActivities()[0]).toMatchObject({
            source: 'core:generate-task',
            scope: 'global',
            ambient: true,
            guardUnload: true,
            guardChatSwitch: false,
            keepAlive: true,
        });

        const chunks = [];
        const iterPromise = (async () => {
            for await (const chunk of stream) {
                chunks.push(chunk);
                expect(hasActiveSource('core:generate-task')).toBe(true);
                chunkGate.resolve();
            }
        })();

        await iterPromise;
        // Notice: `result` was ignored, yet lease must already be released
        expect(chunks).toEqual([
            { type: 'text', delta: 'Hello' },
            { type: 'text', delta: '!' },
        ]);
        expect(getActiveActivities()).toEqual([]);
        expect(hasUnloadGuard()).toBe(false);
    });

    test('releases lease after stream error even when caller ignores result', async () => {
        const errGate = deferred();
        const fakeStreamingOpenAI = async () => async function* () {
            yield { text: 'part', toolCalls: [], state: { reasoning: '' } };
            await errGate.promise;
            throw new Error('stream failure');
        };

        const { stream } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, {
            _injected: makeInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }),
        });

        expect(hasActiveSource('core:generate-task')).toBe(true);

        let caught = null;
        try {
            for await (const chunk of stream) {
                void chunk;
                errGate.resolve();
            }
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeTruthy();
        expect(getActiveActivities()).toEqual([]);
        expect(hasUnloadGuard()).toBe(false);
    });

    test('releases lease after stream abort even when caller ignores result', async () => {
        const abortGate = deferred();
        const fakeStreamingOpenAI = async () => async function* () {
            await abortGate.promise;
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
        };

        const { stream } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, {
            _injected: makeInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }),
        });

        expect(hasActiveSource('core:generate-task')).toBe(true);
        abortGate.resolve();

        let caught = null;
        try {
            for await (const _chunk of stream) {
                void _chunk;
            }
        } catch (err) {
            caught = err;
        }

        expect(caught).toMatchObject({ name: 'GenerateTaskError', code: 'aborted' });
        expect(getActiveActivities()).toEqual([]);
    });

    test('acquires NO lease when activity: false', async () => {
        const listener = jest.fn();
        const unsub = subscribeActivityGuard(listener);
        try {
            const fakeStreamingOpenAI = async () => async function* () {
                expect(getActiveActivities()).toEqual([]);
                yield { text: 'ok', toolCalls: [], state: { reasoning: '' } };
            };

            const { stream, result } = generateTaskStream({
                taskMessages: [{ role: 'user', content: 'hi' }],
                activity: false,
            }, {
                _injected: makeInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }),
            });

            expect(getActiveActivities()).toEqual([]);
            for await (const _c of stream) { void _c; }
            await result;
            expect(listener).not.toHaveBeenCalled();
        } finally {
            unsub();
        }
    });

    test('synchronous invalid_input and stream_unavailable throws do not leak a lease', () => {
        expect(() => generateTaskStream({
            taskMessages: [{ role: 'user', content: 'x' }],
            tools: [{ type: 'function', function: { name: 'f' } }],
            jsonSchema: { type: 'object' },
        }, { _injected: makeInjected() })).toThrow();
        expect(getActiveActivities()).toEqual([]);

        expect(() => generateTaskStream({
            taskMessages: [{ role: 'user', content: 'x' }],
        }, {
            _injected: makeInjected({
                profileResolver: () => ({ requestApi: 'kobold', apiSettingsOverride: null }),
            }),
        })).toThrow();
        expect(getActiveActivities()).toEqual([]);
    });
});

describe('iter-tool-calling and workbench source-luker activity forwarding', () => {
    const origLuker = globalThis.Luker;

    afterEach(() => {
        globalThis.Luker = origLuker;
        if (getActiveActivities().length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(getActiveActivities())}`);
        }
    });

    test('requestToolCallWithRetry and requestToolCallsWithRetry forward activity to generateTask and generateTaskStream', async () => {
        const seenSingle = [];
        const seenMulti = [];
        const seenMultiStream = [];

        const ctx = {
            generateTask: async (opts) => {
                seenSingle.push(opts.activity);
                seenMulti.push(opts.activity);
                return {
                    assistantText: '',
                    toolCalls: [{ id: 'c1', name: 'my_tool', args: { ok: true } }],
                };
            },
            generateTaskStream: (opts) => {
                seenMultiStream.push(opts.activity);
                return {
                    stream: (async function* () {
                        yield { type: 'text', delta: '' };
                    })(),
                    result: Promise.resolve({
                        assistantText: '',
                        toolCalls: [{ id: 'c2', name: 'my_tool', args: { ok: true } }],
                    }),
                };
            },
            isStreamingPresetEnabled: () => false,
        };

        await requestToolCallWithRetry(ctx, { rpmLimit: 0, toolCallRetryMax: 0 }, {
            taskMessages: [{ role: 'user', content: 'go' }],
            functionName: 'my_tool',
            parameters: { type: 'object', properties: { ok: { type: 'boolean' } } },
            activity: false,
        });
        expect(seenSingle).toEqual([false]);

        const toolDef = [{
            type: 'function',
            function: { name: 'my_tool', parameters: { type: 'object', properties: {} } },
        }];
        const customActivity = { scope: 'chat', label: 'Iterating', ambient: false };

        await requestToolCallsWithRetry(ctx, { rpmLimit: 0, toolCallRetryMax: 0 }, {
            taskMessages: [{ role: 'user', content: 'go' }],
            tools: toolDef,
            activity: customActivity,
        });
        expect(seenMulti.at(-1)).toEqual(customActivity);

        ctx.isStreamingPresetEnabled = () => true;
        await requestToolCallsWithRetry(ctx, { rpmLimit: 0, toolCallRetryMax: 0 }, {
            taskMessages: [{ role: 'user', content: 'go' }],
            tools: toolDef,
            activity: false,
        });
        expect(seenMultiStream).toEqual([false]);
    });

    test('workbench aiTest opts out with activity: false while aiRequest holds baseline lease unless overridden', async () => {
        const listener = jest.fn();
        const unsub = subscribeActivityGuard(listener);
        const capturedDuringSender = [];

        const fakeOpenAI = async () => {
            capturedDuringSender.push(getActiveActivities());
            return {
                choices: [{
                    message: {
                        content: '',
                        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'wb_ok', arguments: '{}' } }],
                    },
                    finish_reason: 'tool_calls',
                }],
            };
        };

        const injected = makeInjected({ senders: { sendOpenAIRequest: fakeOpenAI } });

        globalThis.Luker = {
            getContext: () => ({
                extensionSettings: {},
                chatCompletionSettings: {},
                presets: { list: () => [] },
                getPresetManager: () => null,
                translate: (s) => s,
                isStreamingPresetEnabled: () => false,
                generateTask: (opts) => generateTask(opts, { _injected: injected }),
                generateTaskStream: (opts) => generateTaskStream(opts, { _injected: injected }),
            }),
        };

        try {
            const elapsed = await aiTest('ask');
            expect(typeof elapsed).toBe('number');
            expect(capturedDuringSender[0]).toEqual([]);
            expect(listener).not.toHaveBeenCalled();

            await aiRequest('ask', {
                messages: [{ role: 'user', content: 'hello' }],
                tools: [{ type: 'function', function: { name: 'wb_ok', parameters: { type: 'object', properties: {} } } }],
            });
            expect(capturedDuringSender[1]).toHaveLength(1);
            expect(capturedDuringSender[1][0]).toMatchObject({
                source: 'core:generate-task',
                scope: 'global',
                ambient: true,
                guardUnload: true,
                keepAlive: true,
            });
        } finally {
            unsub();
        }
    });
});
