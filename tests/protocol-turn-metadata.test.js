// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test, jest } from '@jest/globals';

import {
    WIRE_PROTOCOLS,
    normalizeFinishReason,
    parseProtocolResponse,
    parsedTurnToChatCompletion,
} from '../public/scripts/lib/protocol-parser/index.js';
const normalizeGeminiResponseToOAI = (raw) => parsedTurnToChatCompletion(parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, raw), raw);
import { dispatchDeepSeek } from '../src/luker-dispatch/providers/chat-completions/deepseek.js';
import { dispatchXai } from '../src/luker-dispatch/providers/chat-completions/xai.js';
import { dispatchAzureOpenAI } from '../src/luker-dispatch/providers/chat-completions/azure-openai.js';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';
import { dispatchToSenderStreaming, normalizeResponse } from '../public/scripts/generate-task.js';
import {
    appendStandardToolRoundMessages,
    buildPersistentToolCallsFromRawCalls,
} from '../public/scripts/lib/iter-tool-calling.js';

describe('normalizeGeminiResponseToOAI — turn metadata and finish reasons', () => {
    test('preserves per-call thoughtSignature, native_parts, and toolUsePromptTokenCount', () => {
        const parts = [
            { thought: true, text: 'reasoning step', thoughtSignature: 'sig-thought' },
            { text: 'Checking tools.' },
            { functionCall: { id: 'gem_1', name: 'lookup', args: { q: 'a' } }, thoughtSignature: 'sig-call-1' },
            { functionCall: { id: 'gem_2', name: 'lookup', args: { q: 'b' } } },
        ];
        const raw = {
            candidates: [{
                content: { role: 'model', parts },
                finishReason: 'STOP',
            }],
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 25,
                thoughtsTokenCount: 40,
                toolUsePromptTokenCount: 15,
                cachedContentTokenCount: 60,
                totalTokenCount: 180,
            },
        };
        const reply = normalizeGeminiResponseToOAI(raw);
        const choice = reply.choices[0];
        expect(choice.finish_reason).toBe('tool_calls');
        expect(choice.native_finish_reason).toBe('STOP');
        expect(choice.message.content).toBe('Checking tools.');
        expect(choice.message.reasoning_content).toBe('reasoning step');
        expect(choice.message.native_parts).toEqual(parts);
        expect(choice.message.tool_calls).toEqual([
            {
                id: 'gem_1',
                type: 'function',
                signature: 'sig-call-1',
                function: { name: 'lookup', arguments: '{"q":"a"}' },
            },
            {
                id: 'gem_2',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"b"}' },
            },
        ]);
        expect(reply.usage).toEqual({
            prompt_tokens: 100,
            completion_tokens: 65,
            total_tokens: 180,
            prompt_tokens_details: {
                cached_tokens: 60,
                tool_use_prompt_tokens: 15,
            },
            completion_tokens_details: {
                reasoning_tokens: 40,
            },
        });
    });

    test('maps Gemini malformed/signature errors to error and CONTINUATION to incomplete', () => {
        for (const reason of ['MALFORMED_FUNCTION_CALL', 'MISSING_THOUGHT_SIGNATURE', 'UNEXPECTED_TOOL_CALL', 'MALFORMED_RESPONSE']) {
            const reply = normalizeGeminiResponseToOAI({
                candidates: [{ content: { parts: [] }, finishReason: reason }],
            });
            expect(reply.choices[0].finish_reason).toBe('error');
            expect(reply.choices[0].native_finish_reason).toBe(reason);
        }

        const cont = normalizeGeminiResponseToOAI({
            candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'CONTINUATION' }],
        });
        expect(cont.choices[0].finish_reason).toBe('incomplete');
        expect(cont.choices[0].native_finish_reason).toBe('CONTINUATION');
    });
});

describe('normalizeFinishReason', () => {
    test('aligns Claude and Gemini streaming termination codes with non-streaming normalization', () => {
        expect(normalizeFinishReason('claude', 'model_context_window_exceeded')).toBe('length');
        expect(normalizeFinishReason('claude', 'pause_turn')).toBe('pause_turn');
        expect(normalizeFinishReason('claude', 'future_reason')).toBe('future_reason');

        expect(normalizeFinishReason('makersuite', 'MALFORMED_FUNCTION_CALL')).toBe('error');
        expect(normalizeFinishReason('makersuite', 'MISSING_THOUGHT_SIGNATURE')).toBe('error');
        expect(normalizeFinishReason('vertexai', 'UNEXPECTED_TOOL_CALL')).toBe('error');
        expect(normalizeFinishReason('makersuite', 'MALFORMED_RESPONSE')).toBe('error');
        expect(normalizeFinishReason('makersuite', 'CONTINUATION')).toBe('incomplete');
        expect(normalizeFinishReason('makersuite', 'FUTURE_GEMINI_REASON')).toBe('FUTURE_GEMINI_REASON');
    });
});

describe('generate-task turn metadata and usage propagation', () => {
    test('normalizeResponse preserves turn metadata, per-call signature/extra_content, and detailed usage', () => {
        const nativeParts = [{ text: 'hi', thoughtSignature: 'sig-1' }];
        const nativeContentBlocks = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'hi' }];
        const responsesOutputItems = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] }];
        const citations = [{ type: 'web_search_result_location', url: 'https://example.com' }];
        const extraContent = { google: { thought_signature: 'oai-compat-sig' } };

        const result = normalizeResponse({
            requestApi: 'openai',
            mode: 'tool',
            raw: {
                choices: [{
                    finish_reason: 'pause_turn',
                    native_finish_reason: 'pause_turn',
                    stop_details: { reason: 'server_tool' },
                    message: {
                        role: 'assistant',
                        content: 'Working on it.',
                        reasoning_content: 'thinking',
                        signature: 'turn-sig',
                        native_parts: nativeParts,
                        native_content_blocks: nativeContentBlocks,
                        responses_output_items: responsesOutputItems,
                        citations,
                        refusal: 'partial refusal',
                        tool_calls: [{
                            id: 'call_1',
                            type: 'function',
                            signature: 'call-sig',
                            extra_content: extraContent,
                            function: { name: 'lookup', arguments: '{"q":"x"}' },
                        }],
                    },
                }],
                usage: {
                    prompt_tokens: 200,
                    completion_tokens: 50,
                    total_tokens: 250,
                    prompt_tokens_details: {
                        cached_tokens: 120,
                        cache_creation_tokens: 30,
                        tool_use_prompt_tokens: 10,
                    },
                    completion_tokens_details: {
                        reasoning_tokens: 22,
                    },
                },
            },
        });

        expect(result.signature).toBe('turn-sig');
        expect(result.nativeParts).toEqual(nativeParts);
        expect(result.nativeContentBlocks).toEqual(nativeContentBlocks);
        expect(result.responsesOutputItems).toEqual(responsesOutputItems);
        expect(result.citations).toEqual(citations);
        expect(result.refusal).toBe('partial refusal');
        expect(result.finishReason).toBe('pause_turn');
        expect(result.nativeFinishReason).toBe('pause_turn');
        expect(result.stopDetails).toEqual({ reason: 'server_tool' });
        expect(result.toolCalls[0].signature).toBe('call-sig');
        expect(result.toolCalls[0].extra_content).toEqual(extraContent);
        expect(result.usage).toEqual({
            promptTokens: 200,
            completionTokens: 50,
            totalTokens: 250,
            cachedTokens: 120,
            cacheCreationTokens: 30,
            reasoningTokens: 22,
            toolUsePromptTokens: 10,
        });
    });

    test('dispatchToSenderStreaming forwards native turn replay fields and per-call metadata into rawTerminal', async () => {
        const nativeParts = [{ functionCall: { id: 'c1', name: 'lookup', args: { q: 'k' } }, thoughtSignature: 'sig-stream' }];
        const extraContent = { google: { thought_signature: 'sig-extra' } };
        const fakeSendOpenAI = jest.fn(async () => async function* () {
            yield {
                text: 'Running',
                toolCalls: [[{
                    id: 'c1',
                    type: 'function',
                    thoughtSignature: 'sig-stream',
                    extra_content: extraContent,
                    function: { name: 'lookup', arguments: '{"q":"k"}' },
                }]],
                state: {
                    reasoning: 'plan',
                    signature: 'turn-stream-sig',
                    nativeParts,
                    nativeContentBlocks: [{ type: 'text', text: 'Running' }],
                    responsesOutputItems: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running' }] }],
                    citations: [{ url: 'https://example.com' }],
                    finishReason: 'tool_calls',
                    nativeFinishReason: 'STOP',
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                },
            };
        });

        const { stream, rawTerminal } = dispatchToSenderStreaming({
            requestApi: 'openai',
            payload: [{ role: 'user', content: 'hi' }],
        }, {
            senders: { sendOpenAIRequest: fakeSendOpenAI },
        });
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThan(0);
        const terminal = await rawTerminal;
        const msg = terminal.choices[0].message;
        expect(msg.signature).toBe('turn-stream-sig');
        expect(msg.native_parts).toEqual(nativeParts);
        expect(msg.native_content_blocks).toEqual([{ type: 'text', text: 'Running' }]);
        expect(msg.responses_output_items).toHaveLength(1);
        expect(msg.citations).toEqual([{ url: 'https://example.com' }]);
        expect(msg.tool_calls[0].signature).toBe('sig-stream');
        expect(msg.tool_calls[0].extra_content).toEqual(extraContent);
        expect(terminal.choices[0].native_finish_reason).toBe('STOP');
    });
});

describe('iter-tool-calling metadata persistence', () => {
    test('preserves per-call signature/extra_content and turn-level replay fields across tool rounds', () => {
        const extraContent = { google: { thought_signature: 'sig-compat' } };
        const persistedCalls = buildPersistentToolCallsFromRawCalls([{
            id: 'call_1',
            name: 'lookup',
            args: { q: 'x' },
            signature: 'sig-1',
            extra_content: extraContent,
        }]);
        expect(persistedCalls[0].signature).toBe('sig-1');
        expect(persistedCalls[0].extra_content).toEqual(extraContent);

        const targetMessages = [];
        appendStandardToolRoundMessages(targetMessages, [{
            id: 'call_1',
            name: 'lookup',
            args: { q: 'x' },
            signature: 'sig-1',
            extra_content: extraContent,
            result: { ok: true },
        }], 'Calling lookup', {
            reasoning: 'plan',
            signature: 'turn-sig',
            nativeParts: [{ text: 'Calling lookup' }],
            nativeContentBlocks: [{ type: 'text', text: 'Calling lookup' }],
            responsesOutputItems: [{ type: 'message', role: 'assistant', content: [] }],
        });
        expect(targetMessages[0].signature).toBe('turn-sig');
        expect(targetMessages[0].native_parts).toEqual([{ text: 'Calling lookup' }]);
        expect(targetMessages[0].native_content_blocks).toEqual([{ type: 'text', text: 'Calling lookup' }]);
        expect(targetMessages[0].responses_output_items).toEqual([{ type: 'message', role: 'assistant', content: [] }]);
        expect(targetMessages[0].tool_calls[0].signature).toBe('sig-1');
        expect(targetMessages[0].tool_calls[0].extra_content).toEqual(extraContent);
    });
});

describe('Chat Completions providers strip internal cross-protocol replay fields', () => {
    function makeChatCtx(source, extraBody, secretMap) {
        const emitted = [];
        return {
            body: {
                model: 'test-model',
                stream: false,
                max_tokens: 64,
                chat_completion_source: source,
                messages: [
                    { role: 'user', content: 'hi' },
                    {
                        role: 'assistant',
                        content: 'reply',
                        native_parts: [{ text: 'reply' }],
                        native_content_blocks: [{ type: 'text', text: 'reply' }],
                        responses_output_items: [{ type: 'message', role: 'assistant', content: [] }],
                        reasoning_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
                    },
                ],
                ...extraBody,
            },
            user: { handle: 'alice', directories: {}, profile: { handle: 'alice' } },
            signal: new AbortController().signal,
            fetch: jest.fn(async () => new Response(JSON.stringify({
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } })),
            secrets: { read: jest.fn((k) => secretMap[k] ?? '') },
            inspection: { start: jest.fn(), attach: jest.fn(), fail: jest.fn() },
            emit: {
                head: (h) => emitted.push({ kind: 'head', data: h }),
                chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
                end: () => emitted.push({ kind: 'end' }),
                error: (e) => emitted.push({ kind: 'error', error: e }),
            },
        };
    }

    test('DeepSeek, xAI, and Azure OpenAI omit native replay fields from wire messages', async () => {
        const dsCtx = makeChatCtx(CHAT_COMPLETION_SOURCES.DEEPSEEK, { model: 'deepseek-chat' }, { api_key_deepseek: 'dk' });
        await dispatchDeepSeek(dsCtx);
        const dsAssistant = JSON.parse(dsCtx.fetch.mock.calls[0][1].body).messages[1];
        expect(dsAssistant.native_parts).toBeUndefined();
        expect(dsAssistant.native_content_blocks).toBeUndefined();
        expect(dsAssistant.responses_output_items).toBeUndefined();
        expect(dsAssistant.reasoning_blocks).toBeUndefined();

        const xaiCtx = makeChatCtx(CHAT_COMPLETION_SOURCES.XAI, { model: 'grok-4' }, { api_key_xai: 'xk' });
        await dispatchXai(xaiCtx);
        const xaiAssistant = JSON.parse(xaiCtx.fetch.mock.calls[0][1].body).messages[1];
        expect(xaiAssistant.native_parts).toBeUndefined();
        expect(xaiAssistant.native_content_blocks).toBeUndefined();
        expect(xaiAssistant.responses_output_items).toBeUndefined();
        expect(xaiAssistant.reasoning_blocks).toBeUndefined();

        const azCtx = makeChatCtx(CHAT_COMPLETION_SOURCES.AZURE_OPENAI, {
            azure_base_url: 'https://example.openai.azure.com',
            azure_deployment_name: 'dep1',
            azure_api_version: '2025-04-01-preview',
        }, { api_key_azure_openai: 'ak' });
        await dispatchAzureOpenAI(azCtx);
        const azAssistant = JSON.parse(azCtx.fetch.mock.calls[0][1].body).messages[1];
        expect(azAssistant.native_parts).toBeUndefined();
        expect(azAssistant.native_content_blocks).toBeUndefined();
        expect(azAssistant.responses_output_items).toBeUndefined();
        expect(azAssistant.reasoning_blocks).toBeUndefined();
    });
});
