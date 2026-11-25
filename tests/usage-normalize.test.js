import { describe, expect, test } from '@jest/globals';

import {
    WIRE_PROTOCOLS,
    parseProtocolResponse,
    parsedTurnToChatCompletion,
} from '../public/scripts/lib/protocol-parser/index.js';

const normalizeClaudeResponseToOAI = (raw) => parsedTurnToChatCompletion(parseProtocolResponse(WIRE_PROTOCOLS.CLAUDE, raw), raw);
const normalizeGeminiResponseToOAI = (raw) => parsedTurnToChatCompletion(parseProtocolResponse(WIRE_PROTOCOLS.GEMINI, raw), raw);
const normalizeCohereResponseToOAI = (raw) => parsedTurnToChatCompletion(parseProtocolResponse(WIRE_PROTOCOLS.COHERE, raw), raw);

describe('normalizeClaudeResponseToOAI — usage normalization', () => {
    test('maps input_tokens/output_tokens to OpenAI snake_case shape', () => {
        const raw = {
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 12, output_tokens: 7 },
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 12,
            completion_tokens: 7,
            total_tokens: 19,
        });
    });

    test('sums disjoint input_tokens + cache_read + cache_creation and preserves thinking_tokens', () => {
        const raw = {
            content: [{ type: 'text', text: 'cached' }],
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 5,
                output_tokens: 20,
                cache_read_input_tokens: 100,
                cache_creation_input_tokens: 50,
                output_tokens_details: { thinking_tokens: 12 },
            },
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 155,
            completion_tokens: 20,
            total_tokens: 175,
            prompt_tokens_details: {
                cached_tokens: 100,
                cache_creation_tokens: 50,
            },
            completion_tokens_details: {
                reasoning_tokens: 12,
            },
        });
    });

    test('preserves pause_turn, model_context_window_exceeded, stop_details, citations, and native_content_blocks', () => {
        const rawPaused = {
            content: [
                { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
                { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'test' } },
                { type: 'text', text: 'cited', citations: [{ type: 'web_search_result_location', url: 'https://example.com' }] },
            ],
            stop_reason: 'pause_turn',
            stop_sequence: 'END',
            stop_details: { reason: 'server_tool' },
        };
        const pausedReply = normalizeClaudeResponseToOAI(rawPaused);
        expect(pausedReply.choices[0].finish_reason).toBe('pause_turn');
        expect(pausedReply.choices[0].native_finish_reason).toBe('pause_turn');
        expect(pausedReply.choices[0].stop_sequence).toBe('END');
        expect(pausedReply.choices[0].stop_details).toEqual({ reason: 'server_tool' });
        expect(pausedReply.choices[0].message.native_content_blocks).toEqual(rawPaused.content);
        expect(pausedReply.choices[0].message.citations).toHaveLength(1);

        const truncated = normalizeClaudeResponseToOAI({
            content: [{ type: 'text', text: 'cut' }],
            stop_reason: 'model_context_window_exceeded',
        });
        expect(truncated.choices[0].finish_reason).toBe('length');
        expect(truncated.choices[0].native_finish_reason).toBe('model_context_window_exceeded');
    });

    test('omits usage entirely when raw.usage is missing', () => {
        const raw = { content: [{ type: 'text', text: 'no-usage' }], stop_reason: 'end_turn' };
        const reply = normalizeClaudeResponseToOAI(raw);
        expect(reply.usage).toBeUndefined();
    });
});

describe('normalizeClaudeResponseToOAI — reasoning_blocks preservation', () => {
    test('preserves thinking block with signature on message.reasoning_blocks', () => {
        const raw = {
            content: [
                { type: 'thinking', thinking: 'plan step one', signature: 'sig-abc' },
                { type: 'text', text: 'answer' },
            ],
            stop_reason: 'end_turn',
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        const message = reply.choices[0].message;
        expect(message.reasoning_blocks).toEqual([
            { type: 'thinking', thinking: 'plan step one', signature: 'sig-abc' },
        ]);
        expect(message.content).toBe('answer');
        // reasoning_content text kept as a separate string for legacy consumers
        expect(message.reasoning_content).toBe('plan step one');
    });

    test('preserves redacted_thinking block with data field on message.reasoning_blocks', () => {
        const raw = {
            content: [
                { type: 'redacted_thinking', data: 'encrypted-blob' },
                { type: 'text', text: 'ok' },
            ],
            stop_reason: 'end_turn',
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        const message = reply.choices[0].message;
        expect(message.reasoning_blocks).toEqual([
            { type: 'redacted_thinking', data: 'encrypted-blob' },
        ]);
        // redacted_thinking has no plaintext, so no reasoning_content
        expect(message.reasoning_content).toBeUndefined();
    });

    test('keeps thinking and redacted_thinking order and pairs tool_use into tool_calls', () => {
        const raw = {
            content: [
                { type: 'thinking', thinking: 'first thought', signature: 'sig-1' },
                { type: 'redacted_thinking', data: 'blob-1' },
                { type: 'thinking', thinking: 'second thought', signature: 'sig-2' },
                { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'cats' } },
            ],
            stop_reason: 'tool_use',
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        const message = reply.choices[0].message;
        expect(message.reasoning_blocks.map(b => b.type)).toEqual([
            'thinking', 'redacted_thinking', 'thinking',
        ]);
        expect(message.reasoning_blocks[0].signature).toBe('sig-1');
        expect(message.reasoning_blocks[1].data).toBe('blob-1');
        expect(message.reasoning_blocks[2].signature).toBe('sig-2');
        expect(message.tool_calls).toHaveLength(1);
        expect(message.tool_calls[0].id).toBe('toolu_1');
        expect(message.tool_calls[0].function.name).toBe('search');
    });

    test('omits reasoning_blocks entirely when no thinking blocks are present', () => {
        const raw = {
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        expect(reply.choices[0].message.reasoning_blocks).toBeUndefined();
    });

    test('omits signature when thinking block has no signature field', () => {
        const raw = {
            content: [
                { type: 'thinking', thinking: 'unsigned thought' },
                { type: 'text', text: 'ok' },
            ],
            stop_reason: 'end_turn',
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        expect(reply.choices[0].message.reasoning_blocks[0]).toEqual({
            type: 'thinking',
            thinking: 'unsigned thought',
        });
    });
});

describe('normalizeGeminiResponseToOAI — usage normalization', () => {
    test('maps usageMetadata fields to OpenAI snake_case shape', () => {
        const raw = {
            candidates: [{
                content: { parts: [{ text: 'hi' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                totalTokenCount: 28,
            },
        };
        const reply = normalizeGeminiResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
        });
    });

    test('folds thoughtsTokenCount into completion_tokens and exposes it under details', () => {
        const raw = {
            candidates: [{
                content: { parts: [{ text: 'hi' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                thoughtsTokenCount: 30,
                totalTokenCount: 58,
            },
        };
        const reply = normalizeGeminiResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 20,
            completion_tokens: 38,
            total_tokens: 58,
            completion_tokens_details: { reasoning_tokens: 30 },
        });
    });

    test('maps cachedContentTokenCount to prompt_tokens_details.cached_tokens', () => {
        const raw = {
            candidates: [{
                content: { parts: [{ text: 'hi' }] },
                finishReason: 'STOP',
            }],
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                totalTokenCount: 28,
                cachedContentTokenCount: 15,
            },
        };
        const reply = normalizeGeminiResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
            prompt_tokens_details: { cached_tokens: 15 },
        });
    });

    test('omits usage entirely when usageMetadata is missing', () => {
        const raw = {
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        };
        const reply = normalizeGeminiResponseToOAI(raw);
        expect(reply.usage).toBeUndefined();
    });
});

describe('normalizeCohereResponseToOAI — usage normalization', () => {
    test('prefers billed_units shape', () => {
        const raw = {
            id: 'cohere-1',
            message: { content: [{ type: 'text', text: 'hi' }] },
            finish_reason: 'complete',
            usage: {
                billed_units: { input_tokens: 11, output_tokens: 4 },
                tokens: { input_tokens: 100, output_tokens: 4 },
            },
        };
        const reply = normalizeCohereResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 11,
            completion_tokens: 4,
            total_tokens: 15,
        });
    });

    test('falls back to legacy prompt_tokens/completion_tokens if present', () => {
        const raw = {
            id: 'cohere-2',
            message: { content: [{ type: 'text', text: 'hi' }] },
            finish_reason: 'complete',
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        };
        const reply = normalizeCohereResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 9,
            completion_tokens: 2,
            total_tokens: 11,
        });
    });

    test('omits usage entirely when raw.usage is missing', () => {
        const raw = {
            id: 'cohere-3',
            message: { content: [{ type: 'text', text: 'hi' }] },
            finish_reason: 'complete',
        };
        const reply = normalizeCohereResponseToOAI(raw);
        expect(reply.usage).toBeUndefined();
    });
});
