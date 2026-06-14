import { describe, expect, test } from '@jest/globals';

import {
    extractStreamingUsage,
    mergeStreamingUsage,
} from '../public/scripts/openai-streaming-usage.js';

describe('extractStreamingUsage — OpenAI-family (chunk.usage)', () => {
    test('reads usage from a streaming chunk and normalizes to OpenAI snake_case', () => {
        const parsed = {
            choices: [{ index: 0, delta: {} }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        };
        expect(extractStreamingUsage(parsed, 'openai')).toEqual({
            prompt_tokens: 12,
            completion_tokens: 7,
            total_tokens: 19,
        });
    });

    test('preserves prompt_tokens_details.cached_tokens', () => {
        const parsed = {
            usage: {
                prompt_tokens: 100,
                completion_tokens: 5,
                total_tokens: 105,
                prompt_tokens_details: { cached_tokens: 80 },
            },
        };
        expect(extractStreamingUsage(parsed, 'openai')).toEqual({
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 80 },
        });
    });

    test('returns null when chunk has no usage', () => {
        expect(extractStreamingUsage({ choices: [{ delta: { content: 'hi' } }] }, 'openai')).toBeNull();
    });
});

describe('extractStreamingUsage — Claude (message_start + message_delta)', () => {
    test('extracts input_tokens from message_start and normalizes', () => {
        const parsed = {
            type: 'message_start',
            message: { usage: { input_tokens: 50, output_tokens: 1 } },
        };
        expect(extractStreamingUsage(parsed, 'claude')).toEqual({
            prompt_tokens: 50,
            completion_tokens: 1,
            total_tokens: 51,
        });
    });

    test('extracts output_tokens from message_delta and normalizes', () => {
        const parsed = {
            type: 'message_delta',
            usage: { output_tokens: 42 },
        };
        expect(extractStreamingUsage(parsed, 'claude')).toEqual({
            prompt_tokens: 0,
            completion_tokens: 42,
            total_tokens: 42,
        });
    });

    test('surfaces cache_read_input_tokens under prompt_tokens_details', () => {
        const parsed = {
            type: 'message_start',
            message: {
                usage: {
                    input_tokens: 20,
                    output_tokens: 0,
                    cache_read_input_tokens: 500,
                    cache_creation_input_tokens: 100,
                },
            },
        };
        expect(extractStreamingUsage(parsed, 'claude')).toEqual({
            prompt_tokens: 20,
            completion_tokens: 0,
            total_tokens: 20,
            prompt_tokens_details: {
                cached_tokens: 500,
                cache_creation_tokens: 100,
            },
        });
    });

    test('returns null for non-usage event types like content_block_delta', () => {
        const parsed = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
        expect(extractStreamingUsage(parsed, 'claude')).toBeNull();
    });
});

describe('extractStreamingUsage — Gemini (usageMetadata on the chunk)', () => {
    test('extracts usageMetadata fields from a chunk', () => {
        const parsed = {
            candidates: [{ content: { parts: [{ text: 'hi' }] } }],
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                totalTokenCount: 28,
            },
        };
        expect(extractStreamingUsage(parsed, 'makersuite')).toEqual({
            prompt_tokens: 20,
            completion_tokens: 8,
            total_tokens: 28,
        });
    });

    test('folds thoughtsTokenCount into completion_tokens', () => {
        const parsed = {
            usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                thoughtsTokenCount: 30,
                totalTokenCount: 58,
            },
        };
        expect(extractStreamingUsage(parsed, 'vertexai')).toEqual({
            prompt_tokens: 20,
            completion_tokens: 38,
            total_tokens: 58,
            completion_tokens_details: { reasoning_tokens: 30 },
        });
    });

    test('returns null when chunk has no usageMetadata', () => {
        const parsed = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] };
        expect(extractStreamingUsage(parsed, 'makersuite')).toBeNull();
    });
});

describe('mergeStreamingUsage — accumulates across multiple frames', () => {
    test('returns next when prev is null', () => {
        const next = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
        expect(mergeStreamingUsage(null, next)).toEqual(next);
    });

    test('returns prev when next is null', () => {
        const prev = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
        expect(mergeStreamingUsage(prev, null)).toEqual(prev);
    });

    test('takes the larger value per field (Claude message_start has prompt, message_delta has completion)', () => {
        const start = { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 };
        const delta = { prompt_tokens: 0, completion_tokens: 42, total_tokens: 42 };
        expect(mergeStreamingUsage(start, delta)).toEqual({
            prompt_tokens: 50,
            completion_tokens: 42,
            total_tokens: 92,
        });
    });

    test('preserves prompt_tokens_details from whichever frame has it', () => {
        const start = {
            prompt_tokens: 50,
            completion_tokens: 0,
            total_tokens: 50,
            prompt_tokens_details: { cached_tokens: 30 },
        };
        const delta = { prompt_tokens: 0, completion_tokens: 42, total_tokens: 42 };
        expect(mergeStreamingUsage(start, delta)).toEqual({
            prompt_tokens: 50,
            completion_tokens: 42,
            total_tokens: 92,
            prompt_tokens_details: { cached_tokens: 30 },
        });
    });

    test('latest Gemini usageMetadata frame wins (cumulative semantics)', () => {
        const first = { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 };
        const last = { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 };
        expect(mergeStreamingUsage(first, last)).toEqual(last);
    });
});
