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
});
