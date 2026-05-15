import { describe, expect, test } from '@jest/globals';
import { generateTask, GenerateTaskError } from '../../public/scripts/generate-task.js';

const baseInjected = (overrides = {}) => ({
    profileResolver: ({ profileName }) => ({
        requestApi: 'openai',
        apiSettingsOverride: profileName === 'P1' ? { reverse_proxy: 'http://x' } : null,
    }),
    worldInfoResolver: async () => ({ worldInfoBeforeEntries: [], worldInfoAfterEntries: [] }),
    builder: ({ messages }) => messages,
    rawPromptBuilder: (msgs) => msgs.map(m => `${m.role}: ${m.content}`).join('\n'),
    senders: {},
    ...overrides,
});

describe('generateTask end-to-end', () => {
    test('openai text path returns unified result shape', async () => {
        const fakeOpenAI = async () => ({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
        const result = await generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }) });
        expect(result.assistantText).toBe('ok');
        expect(result.finishReason).toBe('stop');
        expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
        expect(result.toolCalls).toEqual([]);
        expect(result.jsonData).toBeNull();
        expect(result.reasoning).toBeNull();
    });

    test('apiPresetName resolves apiSettingsOverride and reaches sender', async () => {
        let capturedOverride = null;
        const fakeOpenAI = async (type, msgs, signal, opts) => {
            capturedOverride = opts.apiSettingsOverride;
            return { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] };
        };
        await generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
            apiPresetName: 'P1',
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }) });
        expect(capturedOverride).toEqual({ reverse_proxy: 'http://x' });
    });

    test('AbortError from sender wraps to code=aborted', async () => {
        const fakeOpenAI = async () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        };
        await expect(generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }) }))
            .rejects.toMatchObject({ name: 'GenerateTaskError', code: 'aborted' });
    });

    test('tool mode parses args and exposes raw call', async () => {
        const fakeOpenAI = async () => ({
            choices: [{
                message: {
                    content: '',
                    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
                },
                finish_reason: 'tool_calls',
            }],
        });
        const result = await generateTask({
            taskMessages: [{ role: 'user', content: 'hi' }],
            tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
            toolChoice: { type: 'function', function: { name: 'lookup' } },
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }) });
        expect(result.toolCalls[0].args).toEqual({ q: 'x' });
        expect(result.toolCalls[0].name).toBe('lookup');
        expect(result.toolCalls[0].raw.id).toBe('c1');
        expect(result.finishReason).toBe('tool_calls');
    });

    test('jsonSchema mode returns parsed jsonData', async () => {
        // sendOpenAIRequest returns the full chat-completion data object in production
        const fakeOpenAI = async () => ({
            choices: [{ message: { content: '{"answer":42,"reason":"because"}' } }],
        });
        const result = await generateTask({
            taskMessages: [{ role: 'user', content: 'compute' }],
            jsonSchema: { schema: { type: 'object', properties: { answer: { type: 'number' } } } },
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }) });
        expect(result.jsonData).toEqual({ answer: 42, reason: 'because' });
        expect(result.assistantText).toBe('');
    });

    test('llmPresetName ignored on non-openai with console.warn', async () => {
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...a) => warns.push(a.join(' '));
        try {
            const inj = baseInjected({
                profileResolver: () => ({ requestApi: 'kobold', apiSettingsOverride: null }),
                senders: {
                    generateHorde: async () => ({ results: [{ text: 'k' }] }),
                    getKoboldGenerationData: () => ({}),
                    getKoboldRuntime: () => ({
                        kai_settings: { preset_settings: 'X' },
                        koboldai_settings: { X: {} },
                        koboldai_setting_names: { X: 'X' },
                        amount_gen: 100,
                        max_context: 2000,
                    }),
                    getGenerateUrl: () => 'http://test',
                    getRequestHeaders: () => ({}),
                    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ text: 'k' }] }) }),
                },
            });
            await generateTask({
                taskMessages: [{ role: 'user', content: 'hi' }],
                llmPresetName: 'P1',
                apiPresetName: 'KoboldProfile',
            }, { _injected: inj });
        } finally {
            console.warn = origWarn;
        }
        expect(warns.some(w => /non-openai/i.test(w))).toBe(true);
    });

    test('GenerateTaskError from sender passes through unwrapped (not double-wrapped)', async () => {
        const fakeOpenAI = async () => {
            throw new GenerateTaskError('rate_limit', 'too fast');
        };
        try {
            await generateTask({
                taskMessages: [{ role: 'user', content: 'hi' }],
            }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeOpenAI } }) });
            throw new Error('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(GenerateTaskError);
            expect(e.code).toBe('rate_limit');
            expect(e.message).toBe('too fast');
            // No cause from wrapping — passed through
            expect(e.cause).toBeNull();
        }
    });

    test('substituteMacros default true: builder receives substituted content', async () => {
        let capturedMessages = null;
        const fakeSubstitute = (content, options) => {
            const cleaned = options?.skipSideEffects
                ? content.replace(/\{\{setvar::[^}]*\}\}/g, '')
                : content;
            return cleaned.replace(/\{\{user\}\}/g, 'Alice');
        };
        const inj = baseInjected({
            substituteParams: fakeSubstitute,
            builder: ({ messages }) => {
                capturedMessages = messages;
                return messages;
            },
            senders: {
                sendOpenAIRequest: async () => ({
                    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                }),
            },
        });
        await generateTask({
            taskMessages: [{ role: 'user', content: 'Hi {{user}} {{setvar::x::1}}' }],
        }, { _injected: inj });
        expect(capturedMessages).toEqual([{ role: 'user', content: 'Hi Alice ' }]);
    });

    test('substituteMacros: false leaves taskMessages content untouched', async () => {
        let capturedMessages = null;
        let substituteCalls = 0;
        const fakeSubstitute = (content) => { substituteCalls += 1; return content.replace(/\{\{user\}\}/g, 'Alice'); };
        const inj = baseInjected({
            substituteParams: fakeSubstitute,
            builder: ({ messages }) => {
                capturedMessages = messages;
                return messages;
            },
            senders: {
                sendOpenAIRequest: async () => ({
                    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                }),
            },
        });
        await generateTask({
            taskMessages: [{ role: 'user', content: 'Hi {{user}}' }],
            substituteMacros: false,
        }, { _injected: inj });
        expect(capturedMessages).toEqual([{ role: 'user', content: 'Hi {{user}}' }]);
        expect(substituteCalls).toBe(0);
    });
});

import { generateTaskStream } from '../../public/scripts/generate-task.js';

describe('generateTaskStream — input validation', () => {
    test('rejects tools + jsonSchema combination with invalid_input', () => {
        expect(() => generateTaskStream({
            taskMessages: [{ role: 'user', content: 'x' }],
            tools: [{ type: 'function', function: { name: 'f' } }],
            jsonSchema: { type: 'object' },
        }, { _injected: baseInjected() })).toThrow(expect.objectContaining({
            name: 'GenerateTaskError',
            code: 'invalid_input',
        }));
    });

    test('rejects non-openai resolved api with stream_unavailable', () => {
        const injected = baseInjected({
            profileResolver: () => ({ requestApi: 'kobold', apiSettingsOverride: null }),
        });
        expect(() => generateTaskStream({
            taskMessages: [{ role: 'user', content: 'x' }],
        }, { _injected: injected })).toThrow(expect.objectContaining({
            name: 'GenerateTaskError',
            code: 'stream_unavailable',
        }));
    });
});

describe('generateTaskStream — openai happy path', () => {
    test('yields text deltas and resolves result with terminal shape', async () => {
        const fakeStreamingOpenAI = async () => {
            return async function* gen() {
                yield { text: 'Hello', toolCalls: [], state: { reasoning: '', signature: '', images: [], toolSignatures: {} } };
                yield { text: 'Hello, world!', toolCalls: [], state: { reasoning: '', signature: '', images: [], toolSignatures: {} } };
            };
        };
        const { stream, result } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }) });

        const collected = [];
        for await (const chunk of stream) collected.push(chunk);
        expect(collected).toEqual([
            { type: 'text', delta: 'Hello' },
            { type: 'text', delta: ', world!' },
        ]);

        const final = await result;
        expect(final.assistantText).toBe('Hello, world!');
        expect(final.toolCalls).toEqual([]);
        expect(final.jsonData).toBeNull();
        expect(final.reasoning).toBeNull();
    });

    test('not consuming stream still resolves result with full content', async () => {
        const fakeStreamingOpenAI = async () => {
            return async function* gen() {
                yield { text: 'partial', toolCalls: [], state: { reasoning: '', signature: '', images: [], toolSignatures: {} } };
                yield { text: 'partial-final', toolCalls: [], state: { reasoning: '', signature: '', images: [], toolSignatures: {} } };
            };
        };
        const { result } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }) });

        const final = await result;
        expect(final.assistantText).toBe('partial-final');
    });

    test('jsonSchema mode parses streamed content into result.jsonData', async () => {
        let capturedJsonSchema = null;
        const fakeStreamingOpenAI = async (type, msgs, signal, opts) => {
            capturedJsonSchema = opts.jsonSchema;
            return async function* gen() {
                yield { text: '{"name":', toolCalls: [], state: { reasoning: '', signature: '', images: [], toolSignatures: {} } };
                yield { text: '{"name": "Alice"}', toolCalls: [], state: { reasoning: '', signature: '', images: [], toolSignatures: {} } };
            };
        };
        const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
        const { result } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
            jsonSchema: schema,
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }) });

        const final = await result;
        expect(final.jsonData).toEqual({ name: 'Alice' });
        expect(final.finishReason).toBe('stop');
        expect(capturedJsonSchema).toEqual(schema);  // confirm passthrough to sender
    });
});

describe('generateTaskStream — error propagation', () => {
    test('AbortError surfaces as same GenerateTaskError on both stream and result', async () => {
        const fakeStreamingOpenAI = async () => {
            return async function* gen() {
                const e = new Error('aborted');
                e.name = 'AbortError';
                throw e;
            };
        };
        const { stream, result } = generateTaskStream({
            taskMessages: [{ role: 'user', content: 'hi' }],
        }, { _injected: baseInjected({ senders: { sendOpenAIRequest: fakeStreamingOpenAI } }) });

        let streamErr = null;
        try {
            for await (const _ of stream) { /* drain */ }
        } catch (e) { streamErr = e; }

        let resultErr = null;
        try { await result; } catch (e) { resultErr = e; }

        expect(streamErr).toBeTruthy();
        expect(streamErr.name).toBe('GenerateTaskError');
        expect(streamErr.code).toBe('aborted');
        expect(resultErr).toBe(streamErr);  // same instance
    });
});
