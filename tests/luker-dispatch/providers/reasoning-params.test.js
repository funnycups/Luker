// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import {
    REASONING_TOKENS,
    normalizeReasoningToken,
    clampReasoningToken,
    resolveOpenAIEffort,
    passthroughReasoningEffort,
} from '../../../src/luker-dispatch/providers/chat-completions/reasoning-params.js';

describe('normalizeReasoningToken', () => {
    test('keeps canonical tokens', () => {
        for (const token of REASONING_TOKENS) expect(normalizeReasoningToken(token)).toBe(token);
    });
    test('maps legacy min to minimal', () => {
        expect(normalizeReasoningToken('min')).toBe('minimal');
    });
    test('unknown becomes auto', () => {
        expect(normalizeReasoningToken('bogus')).toBe('auto');
        expect(normalizeReasoningToken(undefined)).toBe('auto');
    });
});

describe('clampReasoningToken', () => {
    test('auto is always legal', () => {
        expect(clampReasoningToken('auto', ['low', 'high'])).toBe('auto');
    });
    test('keeps a legal token', () => {
        expect(clampReasoningToken('high', ['auto', 'low', 'high'])).toBe('high');
    });
    test('falls to nearest lower legal token', () => {
        expect(clampReasoningToken('xhigh', ['auto', 'low', 'medium'])).toBe('medium');
    });
});

describe('resolveOpenAIEffort', () => {
    test('auto is omitted and off is none', () => {
        expect(resolveOpenAIEffort('auto', 'gpt-5')).toBeUndefined();
        expect(resolveOpenAIEffort('off', 'gpt-5')).toBe('none');
    });
    test('minimal stays minimal on base gpt-5 and drops to low elsewhere', () => {
        expect(resolveOpenAIEffort('minimal', 'gpt-5')).toBe('minimal');
        expect(resolveOpenAIEffort('minimal', 'gpt-5.1')).toBe('low');
    });
    test('xhigh only on xhigh-capable models', () => {
        expect(resolveOpenAIEffort('xhigh', 'gpt-5.4')).toBe('xhigh');
        expect(resolveOpenAIEffort('xhigh', 'gpt-5')).toBe('high');
    });
    test('max maps to max only on the responses API', () => {
        expect(resolveOpenAIEffort('max', 'gpt-5.6', { responsesApi: true })).toBe('max');
        expect(resolveOpenAIEffort('max', 'gpt-5.6')).toBe('xhigh');
    });
});

describe('passthroughReasoningEffort', () => {
    test('forwards canonical levels verbatim', () => {
        expect(passthroughReasoningEffort('low')).toBe('low');
        expect(passthroughReasoningEffort('xhigh')).toBe('xhigh');
    });
    test('maps off to none and auto to undefined', () => {
        expect(passthroughReasoningEffort('off')).toBe('none');
        expect(passthroughReasoningEffort('auto')).toBeUndefined();
    });
});
