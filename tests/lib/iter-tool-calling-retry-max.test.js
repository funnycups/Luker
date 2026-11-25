import { describe, test, expect, jest } from '@jest/globals';
import {
    normalizeToolCallRetryMax,
    requestToolCallsWithRetry,
    requestToolCallWithRetry,
} from '../../public/scripts/lib/iter-tool-calling.js';

const TOOLS = [{
    type: 'function',
    function: { name: 'noop', description: 'Stub tool.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
}];

describe('normalizeToolCallRetryMax', () => {
    test.each([
        [0, 7, 0],
        [3, 7, 3],
        [12, 7, 12],
        [250, 7, 250],
        [2.9, 7, 2],
        [-4, 7, 0],
        ['5', 7, 5],
        [' 11 ', 7, 11],
        ['', 7, 7],
        ['   ', 7, 7],
        [null, 7, 7],
        [undefined, 7, 7],
        ['many', 7, 7],
        [Number.NaN, 7, 7],
        [Number.POSITIVE_INFINITY, 7, 7],
    ])('(%p, %p) → %p', (value, fallback, expected) => {
        expect(normalizeToolCallRetryMax(value, fallback)).toBe(expected);
    });
});

describe('shared runners honor retry counts above the former cap of 10', () => {
    test('requestToolCallsWithRetry makes toolCallRetryMax + 1 attempts', async () => {
        const context = { generateTask: jest.fn(async () => ({ assistantText: '', toolCalls: [] })) };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 12 }, { tools: TOOLS }))
                .rejects.toThrow(/did not contain any matching tool calls/);
        } finally {
            warn.mockRestore();
        }
        expect(context.generateTask).toHaveBeenCalledTimes(13);
    });

    test('retriesOverride is normalized the same way', async () => {
        const context = { generateTask: jest.fn(async () => ({ assistantText: '', toolCalls: [] })) };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(requestToolCallsWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 1 }, { tools: TOOLS, retriesOverride: 11 }))
                .rejects.toThrow();
        } finally {
            warn.mockRestore();
        }
        expect(context.generateTask).toHaveBeenCalledTimes(12);
    });

    test('requestToolCallWithRetry makes toolCallRetryMax + 1 attempts', async () => {
        const context = { generateTask: jest.fn(async () => ({ toolCalls: [] })) };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await expect(requestToolCallWithRetry(context, { rpmLimit: 0, toolCallRetryMax: 11 }, { functionName: 'noop' }))
                .rejects.toThrow(/not 'noop'/);
        } finally {
            warn.mockRestore();
        }
        expect(context.generateTask).toHaveBeenCalledTimes(12);
    });

    test('a missing setting still means no retry', async () => {
        const context = { generateTask: jest.fn(async () => ({ assistantText: '', toolCalls: [] })) };
        await expect(requestToolCallsWithRetry(context, { rpmLimit: 0 }, { tools: TOOLS })).rejects.toThrow();
        expect(context.generateTask).toHaveBeenCalledTimes(1);
    });
});
