import { describe, expect, test } from '@jest/globals';

import {
    normalizeClaudeResponseToOAI,
    normalizeGeminiResponseToOAI,
    normalizeCohereResponseToOAI,
} from '../src/endpoints/backends/chat-completions.js';

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

    test('surfaces cache_read/cache_creation under prompt_tokens_details', () => {
        const raw = {
            content: [{ type: 'text', text: 'cached' }],
            stop_reason: 'end_turn',
            usage: {
                input_tokens: 5,
                output_tokens: 3,
                cache_read_input_tokens: 100,
                cache_creation_input_tokens: 50,
            },
        };
        const reply = normalizeClaudeResponseToOAI(raw);
        expect(reply.usage).toEqual({
            prompt_tokens: 5,
            completion_tokens: 3,
            total_tokens: 8,
            prompt_tokens_details: {
                cached_tokens: 100,
                cache_creation_tokens: 50,
            },
        });
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
