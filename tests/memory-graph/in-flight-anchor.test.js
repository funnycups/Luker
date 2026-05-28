import { describe, test, expect } from '@jest/globals';

import { resolveInFlightAnchor } from '../../public/scripts/extensions/memory-graph/persistence.js';

describe('resolveInFlightAnchor', () => {
    test('returns null when chat is missing or empty', () => {
        expect(resolveInFlightAnchor({})).toBeNull();
        expect(resolveInFlightAnchor({ chat: [] })).toBeNull();
        expect(resolveInFlightAnchor(null)).toBeNull();
    });

    test('returns null when chat tail is a user message', () => {
        const chat = [
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'u1' },
        ];
        expect(resolveInFlightAnchor({ chat })).toBeNull();
    });

    test('returns { floor, turnSeq } when chat tail is a non-empty assistant message', () => {
        const chat = [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'u2' },
            { is_user: false, mes: 'a2 in flight' },
        ];
        expect(resolveInFlightAnchor({ chat })).toEqual({ floor: 3, turnSeq: 2 });
    });

    test('treats an empty placeholder assistant tail as in-flight (turnSeq = priorCount + 1)', () => {
        const chat = [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: true, mes: 'u2' },
            { is_user: false, mes: '' }, // empty placeholder pre-streaming
        ];
        expect(resolveInFlightAnchor({ chat })).toEqual({ floor: 3, turnSeq: 2 });
    });

    test('regenerate case: tail is assistant slot being rewritten, turnSeq counts it', () => {
        // chat[2] is the slot being regenerated; its existing content does not change
        // the in-flight seq calculation — priorCount over chat[0..1] = 1, +1 = 2
        const chat = [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: 'a1' },
            { is_user: false, mes: 'a2 prior attempt' },
        ];
        expect(resolveInFlightAnchor({ chat })).toEqual({ floor: 2, turnSeq: 2 });
    });

    test('skips non-extractable assistant messages in the prior-count walk', () => {
        // mes='' on chat[1] is non-extractable; it does NOT count toward priorSeq
        const chat = [
            { is_user: true, mes: 'u1' },
            { is_user: false, mes: '' }, // non-extractable empty assistant earlier
            { is_user: true, mes: 'u2' },
            { is_user: false, mes: 'a2 in flight' },
        ];
        expect(resolveInFlightAnchor({ chat })).toEqual({ floor: 3, turnSeq: 1 });
    });
});
