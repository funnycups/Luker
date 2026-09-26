// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from '@jest/globals';
import {
    classifyInvocationSummary,
    getOpenToolTaskTailStart,
    isTaskClosingAssistant,
} from '../../public/scripts/tool-invocation-hide.js';

function summary(name) {
    return {
        is_user: false,
        is_system: true,
        mes: `Tool calls: ${name}`,
        extra: { isSmallSys: true, tool_invocations: [{ name, result: 'ok' }] },
    };
}

function assistant(mes, extra = {}) {
    return { is_user: false, is_system: false, mes, extra };
}

function user(mes) {
    return { is_user: true, is_system: false, mes, extra: {} };
}

describe('getOpenToolTaskTailStart', () => {
    test('legacy assistant without finish_reason closes the task', () => {
        const chat = [
            user('q'),
            summary('lookup'),
            assistant('done'),
        ];
        expect(isTaskClosingAssistant(chat[2])).toBe(true);
        expect(getOpenToolTaskTailStart(chat)).toBe(3);
    });

    test('explicit stop closes; tool_calls does not', () => {
        const chat = [
            user('q1'),
            summary('old'),
            assistant('done', { finish_reason: 'stop' }),
            user('q2'),
            assistant('', { finish_reason: 'tool_calls' }),
            summary('live'),
        ];
        expect(getOpenToolTaskTailStart(chat)).toBe(3);
    });

    test('a hidden stop still closes the task', () => {
        const chat = [
            user('q'),
            summary('old'),
            { ...assistant('done', { finish_reason: 'stop' }), is_system: true },
            user('next'),
            summary('live'),
        ];
        expect(getOpenToolTaskTailStart(chat)).toBe(3);
    });

    test('narrator and invocation summaries do not close the task', () => {
        const chat = [
            user('q'),
            assistant('', { finish_reason: 'tool_calls' }),
            summary('live'),
            { is_user: false, is_system: true, mes: 'aside', extra: { type: 'narrator' } },
        ];
        expect(getOpenToolTaskTailStart(chat)).toBe(0);
    });

    test('length does not close the tail', () => {
        const chat = [
            user('q'),
            summary('live'),
            assistant('partial', { finish_reason: 'length' }),
        ];
        expect(getOpenToolTaskTailStart(chat)).toBe(0);
    });
});

describe('classifyInvocationSummary', () => {
    test('closed hidden owner drops', () => {
        expect(classifyInvocationSummary({
            inOpenTail: false,
            ownerHidden: true,
            ownerPresent: false,
        })).toBe('drop');
    });

    test('closed blank owner drops', () => {
        expect(classifyInvocationSummary({
            inOpenTail: false,
            ownerPresent: true,
            ownerBlank: true,
            ownerMergeable: true,
        })).toBe('drop');
    });

    test('closed visible owner merges', () => {
        expect(classifyInvocationSummary({
            inOpenTail: false,
            ownerPresent: true,
            ownerMergeable: true,
        })).toBe('merge');
    });

    test('open tail keeps a hidden owner standalone instead of dropping', () => {
        expect(classifyInvocationSummary({
            inOpenTail: true,
            ownerHidden: true,
            ownerPresent: false,
        })).toBe('keep');
    });

    test('open tail merges a blank but visible owner instead of dropping', () => {
        expect(classifyInvocationSummary({
            inOpenTail: true,
            ownerPresent: true,
            ownerBlank: true,
            ownerMergeable: true,
        })).toBe('merge');
    });

    test('unresolved owner is kept either way', () => {
        expect(classifyInvocationSummary({ inOpenTail: false })).toBe('keep');
        expect(classifyInvocationSummary({ inOpenTail: true })).toBe('keep');
    });
});
