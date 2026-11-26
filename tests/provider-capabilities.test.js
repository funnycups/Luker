// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, jest, test } from '@jest/globals';
import {
    normalizeModelBaseId,
    resolveGeminiModelCapabilities,
    validateGeminiRequestCapabilities,
    resolveClaudeModelCapabilities,
    validateClaudeRequestCapabilities,
    resolveOpenAIModelCapabilities,
    resolveMinimaxModelCapabilities,
    resolveXaiModelCapabilities,
    openAIResponsesSupportsSampling,
    validateOpenAIChatCapabilities,
    createCapabilityConflictError,
} from '../public/scripts/lib/provider-capabilities.js';
import { normalizeResponse } from '../public/scripts/generate-task.js';
import { requestToolCallWithRetry, requestToolCallsWithRetry } from '../public/scripts/lib/iter-tool-calling.js';

describe('provider-capabilities', () => {
    test('normalizeModelBaseId strips vendor and path prefixes', () => {
        expect(normalizeModelBaseId('publishers/google/models/gemini-3-pro-image')).toBe('gemini-3-pro-image');
        expect(normalizeModelBaseId('anthropic/claude-opus-5-5')).toBe('claude-opus-5-5');
        expect(normalizeModelBaseId('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    });

    describe('Gemini model capabilities', () => {
        test('nano-banana-2.1, 3-pro-image, and 3.1-flash-image support image output, imageSize, systemInstruction, and googleSearch', () => {
            for (const model of ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image']) {
                const caps = resolveGeminiModelCapabilities(model);
                expect(caps.imageOutput).toBe('supported');
                expect(caps.imageSize).toBe(true);
                expect(caps.systemInstruction).toBe(true);
                expect(caps.googleSearch).toBe('supported');
                expect(caps.functionCalling).toBe('unsupported');
            }
        });

        test('nano-banana-2.1 supports level thinking and disables unsupported text sampling and seed', () => {
            const caps = resolveGeminiModelCapabilities('gemini-nano-banana-2.1');
            expect(caps.thinkingMode).toBe('level');
            expect(caps.thinkingSupportsOff).toBe(true);
            expect(caps.thinkingSupportsMinimal).toBe(true);
            expect(caps.supportsSampling).toBe(false);
            expect(caps.supportsSeed).toBe(false);
        });

        test('3.1-flash-lite-image supports imageSize and systemInstruction but not googleSearch or functionCalling', () => {
            const caps = resolveGeminiModelCapabilities('gemini-3.1-flash-lite-image');
            expect(caps.imageOutput).toBe('supported');
            expect(caps.imageSize).toBe(true);
            expect(caps.systemInstruction).toBe(true);
            expect(caps.googleSearch).toBe('unsupported');
            expect(caps.functionCalling).toBe('unsupported');
        });

        test('2.5-flash-image supports image output and systemInstruction without imageSize or googleSearch', () => {
            const caps = resolveGeminiModelCapabilities('gemini-2.5-flash-image');
            expect(caps.imageOutput).toBe('supported');
            expect(caps.imageSize).toBe(false);
            expect(caps.systemInstruction).toBe(true);
            expect(caps.googleSearch).toBe('unsupported');
            expect(caps.functionCalling).toBe('unsupported');
        });

        test('Gemini 3 and Gemini 4 allow combining googleSearch with functionDeclarations; Gemini 2.5 rejects it', () => {
            expect(resolveGeminiModelCapabilities('gemini-3.1-pro-preview').combineBuiltinAndFunctionTools).toBe('supported');
            expect(resolveGeminiModelCapabilities('gemini-4-argon').combineBuiltinAndFunctionTools).toBe('supported');
            expect(resolveGeminiModelCapabilities('gemini-2.5-flash').combineBuiltinAndFunctionTools).toBe('unsupported');

            expect(validateGeminiRequestCapabilities({
                model: 'gemini-3.1-pro-preview',
                hasFunctionTools: true,
                enableWebSearch: true,
            })).toBeNull();

            const conflict = validateGeminiRequestCapabilities({
                model: 'gemini-2.5-flash',
                hasFunctionTools: true,
                enableWebSearch: true,
            });
            expect(conflict).not.toBeNull();
            expect(conflict.status).toBe(400);
            expect(conflict.nonRetryable).toBe(true);
            expect(conflict.conflictCode).toBe('gemini_builtin_and_function_tools_conflict');
        });

        test('unknown future models report unknown capabilities instead of fabricating rejection', () => {
            const caps = resolveGeminiModelCapabilities('gemini-next-custom-model');
            expect(caps.imageOutput).toBe('unknown');
            expect(caps.functionCalling).toBe('unknown');
            expect(caps.googleSearch).toBe('unknown');
            expect(caps.systemInstruction).toBe(true);
            expect(validateGeminiRequestCapabilities({
                model: 'gemini-next-custom-model',
                requestImages: true,
                enableWebSearch: true,
            })).toBeNull();
        });

        test('explicit conflicts report non-retryable 400 errors', () => {
            const imgConflict = validateGeminiRequestCapabilities({
                model: 'gemini-2.5-flash',
                requestImages: true,
            });
            expect(imgConflict?.conflictCode).toBe('gemini_image_output_unsupported');
            expect(imgConflict?.nonRetryable).toBe(true);

            const toolConflict = validateGeminiRequestCapabilities({
                model: 'gemini-3-pro-image',
                requestImages: true,
                hasFunctionTools: true,
            });
            expect(toolConflict?.conflictCode).toBe('gemini_function_calling_unsupported');

            const searchConflict = validateGeminiRequestCapabilities({
                model: 'gemini-2.5-flash-image',
                requestImages: true,
                enableWebSearch: true,
            });
            expect(searchConflict?.conflictCode).toBe('gemini_web_search_unsupported');
        });
    });

    describe('Claude model capabilities', () => {
        test('modern Claude 4.1+/4.5+/4.6+/4.7+/5+ support native structured outputs; legacy 3.5 falls back', () => {
            for (const model of [
                'claude-opus-4-1',
                'claude-sonnet-4-5',
                'claude-opus-4-6',
                'claude-sonnet-4-6',
                'claude-opus-4-7',
                'claude-fable-5-1',
                'claude-opus-5-5',
                'claude-sonnet-5-5',
                'claude-haiku-5-5',
            ]) {
                expect(resolveClaudeModelCapabilities(model).supportsNativeStructuredOutput).toBe(true);
            }
            expect(resolveClaudeModelCapabilities('claude-3-5-sonnet-20241022').supportsNativeStructuredOutput).toBe(false);
            expect(resolveClaudeModelCapabilities('claude-3-7-sonnet-20250219').supportsNativeStructuredOutput).toBe(false);
        });

        test('haiku-5-5 and mythos-5 resolve 1M context window while legacy Claude 3.x/Haiku 4.5 stay at 200k', () => {
            expect(resolveClaudeModelCapabilities('claude-haiku-5-5').maxContextTokens).toBe(1000000);
            expect(resolveClaudeModelCapabilities('claude-mythos-5-1').maxContextTokens).toBe(1000000);
            expect(resolveClaudeModelCapabilities('claude-opus-5-5').maxContextTokens).toBe(1000000);
            expect(resolveClaudeModelCapabilities('claude-haiku-4-5').maxContextTokens).toBe(200000);
            expect(resolveClaudeModelCapabilities('claude-3-5-sonnet-20241022').maxContextTokens).toBe(200000);
        });

        test('haiku-5-5 suppresses sampling parameters', () => {
            expect(resolveClaudeModelCapabilities('claude-haiku-5-5').noSampling).toBe(true);
            expect(resolveClaudeModelCapabilities('anthropic/claude-haiku-5-5').noSampling).toBe(true);
        });

        test('validates forced tool_choice conflicts with manual and incompatible adaptive thinking', () => {
            const manualConflict = validateClaudeRequestCapabilities({
                model: 'claude-sonnet-4-5',
                thinking: { type: 'enabled', budget_tokens: 1024 },
                toolChoice: { type: 'tool', name: 'my_tool' },
            });
            expect(manualConflict?.conflictCode).toBe('claude_manual_thinking_forced_tool_conflict');
            expect(manualConflict?.nonRetryable).toBe(true);

            // Adaptive forced tools are rejected on Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1.
            for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1']) {
                const adaptiveConflict = validateClaudeRequestCapabilities({
                    model,
                    thinking: { type: 'adaptive' },
                    toolChoice: { type: 'any' },
                });
                expect(adaptiveConflict?.conflictCode).toBe('claude_adaptive_thinking_forced_tool_conflict');
            }

            // Adaptive forced tools are allowed on Opus 4.6 / Sonnet 4.6 / Opus 4.7 / Haiku 5.5.
            for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-5-5']) {
                expect(validateClaudeRequestCapabilities({
                    model,
                    thinking: { type: 'adaptive' },
                    toolChoice: { type: 'tool', name: 'my_tool' },
                })).toBeNull();
            }

            // Auto tool_choice never conflicts with thinking.
            expect(validateClaudeRequestCapabilities({
                model: 'claude-opus-5-5',
                thinking: { type: 'adaptive' },
                toolChoice: { type: 'auto' },
            })).toBeNull();
        });
    });

    describe('OpenAI model capabilities', () => {
        test('gpt-6-astra, gpt-6.1-sol, gpt-6.2-astra, and gpt-6.2-sol share Responses-only tool and reasoning-none rules', () => {
            for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.2-astra', 'gpt-6.2-sol']) {
                const caps = resolveOpenAIModelCapabilities(model);
                expect(caps.isGpt6).toBe(true);
                expect(caps.isGpt6ResponsesOnlyTools).toBe(true);
                expect(caps.chatCompletionsSupportsTools).toBe(false);
                expect(caps.rejectsReasoningNone).toBe(true);
                expect(caps.supportsVerbosity).toBe(true);
                expect(openAIResponsesSupportsSampling(model, 'low')).toBe(false);

                const conflict = validateOpenAIChatCapabilities({ model, hasTools: true });
                expect(conflict?.conflictCode).toBe('openai_chat_tools_require_responses');
                expect(conflict?.nonRetryable).toBe(true);
            }
        });

        test('gpt-5.4 Responses supports sampling only when effort is none', () => {
            expect(openAIResponsesSupportsSampling('gpt-5.4', 'none')).toBe(true);
            expect(openAIResponsesSupportsSampling('gpt-5.4', 'medium')).toBe(false);
            expect(openAIResponsesSupportsSampling('o4-mini', 'none')).toBe(false);
            expect(openAIResponsesSupportsSampling('gpt-4.1', undefined)).toBe(true);
        });
    });

    describe('MiniMax model capabilities', () => {
        test('resolves M2-her 64K/2048 ceiling, M3 1M context without output cap, and M2 default 204.8K', () => {
            expect(resolveMinimaxModelCapabilities('M2-her')).toMatchObject({
                maxContextTokens: 65536,
                maxOutputTokens: 2048,
                retired: true,
            });
            expect(resolveMinimaxModelCapabilities('MiniMax-M3')).toMatchObject({
                maxContextTokens: 1000000,
                maxOutputTokens: null,
                retired: false,
            });
            expect(resolveMinimaxModelCapabilities('MiniMax-M3.1-Flash')).toMatchObject({
                maxContextTokens: 1000000,
                maxOutputTokens: null,
                retired: false,
            });
            expect(resolveMinimaxModelCapabilities('MiniMax-M2.5')).toMatchObject({
                maxContextTokens: 204800,
                maxOutputTokens: null,
                retired: false,
            });
        });
    });

    describe('xAI model capabilities', () => {
        test('enables reasoning_effort on grok-3-mini and grok-4.5, disables on grok-2/3/4, and keeps unknown for future models', () => {
            expect(resolveXaiModelCapabilities('grok-3-mini').supportsReasoningEffort).toBe(true);
            expect(resolveXaiModelCapabilities('grok-4.5').supportsReasoningEffort).toBe(true);
            expect(resolveXaiModelCapabilities('grok-2-latest').supportsReasoningEffort).toBe(false);
            expect(resolveXaiModelCapabilities('grok-3').supportsReasoningEffort).toBe(false);
            expect(resolveXaiModelCapabilities('grok-4').supportsReasoningEffort).toBe(false);
            expect(resolveXaiModelCapabilities('grok-4-fast').supportsReasoningEffort).toBe(false);
            expect(resolveXaiModelCapabilities('grok-5-preview').supportsReasoningEffort).toBe('unknown');
        });
    });

    describe('generate-task JSON fallback and non-retryable conflict propagation', () => {
        test('normalizeResponse in json mode extracts forced schema tool_calls arguments when text content is empty', () => {
            const res = normalizeResponse({
                requestApi: 'openai',
                mode: 'json',
                raw: {
                    choices: [{
                        message: {
                            content: '',
                            tool_calls: [{
                                id: 'toolu_1',
                                type: 'function',
                                function: { name: 'reply_schema', arguments: '{"ok":true,"count":3}' },
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                },
            });
            expect(res.jsonData).toEqual({ ok: true, count: 3 });
        });

        test('normalizeResponse in json mode extracts native Anthropic tool_use.input and native Anthropic usage', () => {
            const res = normalizeResponse({
                requestApi: 'openai',
                mode: 'json',
                raw: {
                    content: [{ type: 'tool_use', id: 'toolu_2', name: 'reply_schema', input: { ok: true } }],
                    usage: {
                        input_tokens: 120,
                        output_tokens: 30,
                        cache_read_input_tokens: 40,
                        cache_creation_input_tokens: 10,
                    },
                },
            });
            expect(res.jsonData).toEqual({ ok: true });
            expect(res.usage).toEqual({
                promptTokens: 120,
                completionTokens: 30,
                totalTokens: 150,
                cachedTokens: 40,
                cacheCreationTokens: 10,
            });
        });

        test('resolveClaudeModelCapabilities enables defaultThinkingRequiresDisplay on haiku-5-5 and resolveOpenAIModelCapabilities enables supportsReasoningEffort on gpt-6.2', () => {
            expect(resolveClaudeModelCapabilities('claude-haiku-5-5').defaultThinkingRequiresDisplay).toBe(true);
            expect(resolveClaudeModelCapabilities('claude-opus-5-5').alwaysThinking).toBe(true);
            expect(resolveClaudeModelCapabilities('claude-opus-5-5').canDisableThinking).toBe(false);
            expect(resolveOpenAIModelCapabilities('gpt-6.2-astra').supportsReasoningEffort).toBe(true);
            expect(resolveOpenAIModelCapabilities('gpt-6.2-sol').supportsReasoningEffort).toBe(true);
            expect(resolveOpenAIModelCapabilities('gpt-5-chat-latest').supportsReasoningEffort).toBe(false);
            expect(resolveOpenAIModelCapabilities('gpt-5-chat-latest').isKnownNonReasoningModel).toBe(true);
            expect(resolveOpenAIModelCapabilities('gpt-4o').isKnownNonReasoningModel).toBe(true);
            expect(resolveOpenAIModelCapabilities('my-custom-model').isKnownNonReasoningModel).toBe(false);
            expect(validateOpenAIChatCapabilities({ model: 'gpt-5-chat-latest', hasTools: true })?.conflictCode).toBe('openai_chat_tools_unsupported');
            expect(validateOpenAIChatCapabilities({ model: 'o1', hasTools: true })?.conflictCode).toBe('openai_chat_tools_unsupported');
        });

        test('normalizeResponse in json mode prioritizes forced schema tool_calls and tool_use over preamble text', () => {
            const oaiRes = normalizeResponse({
                requestApi: 'openai',
                mode: 'json',
                raw: {
                    choices: [{
                        message: {
                            content: 'Sure, here is the JSON:',
                            tool_calls: [{
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'reply_schema', arguments: '{"ok":true}' },
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                },
            });
            expect(oaiRes.jsonData).toEqual({ ok: true });

            const claudeRes = normalizeResponse({
                requestApi: 'openai',
                mode: 'json',
                raw: {
                    content: [
                        { type: 'text', text: 'Here you go:' },
                        { type: 'tool_use', id: 'toolu_3', name: 'reply_schema', input: { ok: true, items: [1] } },
                    ],
                },
            });
            expect(claudeRes.jsonData).toEqual({ ok: true, items: [1] });
        });

        test('iter-tool-calling stops immediately on non-retryable capability conflicts without burning retries', async () => {
            const conflictErr = createCapabilityConflictError('conflict', {
                provider: 'claude',
                model: 'claude-opus-5-5',
                conflictCode: 'claude_adaptive_thinking_forced_tool_conflict',
            });
            const generateTask = jest.fn(async () => {
                throw conflictErr;
            });
            const ctx = { generateTask };
            const settings = { toolCallRetryMax: 3, rpmLimit: 0 };

            await expect(requestToolCallWithRetry(ctx, settings, {
                taskMessages: [{ role: 'user', content: 'hi' }],
                functionName: 'do_thing',
            })).rejects.toThrow('conflict');
            expect(generateTask).toHaveBeenCalledTimes(1);

            generateTask.mockClear();
            await expect(requestToolCallsWithRetry(ctx, settings, {
                taskMessages: [{ role: 'user', content: 'hi' }],
                tools: [{ type: 'function', function: { name: 'do_thing', parameters: { type: 'object' } } }],
            })).rejects.toThrow('conflict');
            expect(generateTask).toHaveBeenCalledTimes(1);
        });
    });
});
