// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import {
    REASONING_TOKENS,
    normalizeReasoningToken,
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

describe('resolveOpenAIEffort', () => {
    test('auto is omitted and off is none (low for gpt-6-astra and gpt-6.1-sol)', () => {
        expect(resolveOpenAIEffort('auto', 'gpt-5')).toBeUndefined();
        expect(resolveOpenAIEffort('off', 'gpt-5')).toBe('none');
        expect(resolveOpenAIEffort('off', 'gpt-6-astra')).toBe('low');
        expect(resolveOpenAIEffort('off', 'gpt-6.1-sol')).toBe('low');
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

describe('dead exports cleanup', () => {
    test('removed reasoning helper exports are not exported', async () => {
        const mod = await import('../../../src/luker-dispatch/providers/chat-completions/reasoning-params.js');
        expect(mod.isReasoningOff).toBeUndefined();
        expect(mod.isReasoningAuto).toBeUndefined();
        expect(mod.clampReasoningToken).toBeUndefined();
    });
});
