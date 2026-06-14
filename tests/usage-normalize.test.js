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
