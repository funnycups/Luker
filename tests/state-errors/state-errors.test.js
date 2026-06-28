import { describe, test, expect } from '@jest/globals';
import {
    STATE_ERROR_REASONS,
    isValidReason,
    makeStateError,
    makeStateOk,
    STATE_HINT_MAX_LENGTH,
} from '../../public/scripts/state-errors.js';

describe('STATE_ERROR_REASONS', () => {
    test('contains exactly the 9 spec-defined reasons', () => {
        expect(Object.keys(STATE_ERROR_REASONS).sort()).toEqual([
            'CONFLICT',
            'HTTP_ERROR',
            'INSTANCE_DESTROYED',
            'LOG_WRITE_FAILED',
            'REPLAY_BROKEN',
            'TRANSPORT_ERROR',
            'VALIDATION_ARGS',
            'VALIDATION_COMMIT',
            'VALIDATION_TARGET',
        ]);
    });
    test('enum values match keys (so consumers can switch on reason)', () => {
        for (const k of Object.keys(STATE_ERROR_REASONS)) {
            expect(STATE_ERROR_REASONS[k]).toBe(k);
        }
    });
    test('enum object is frozen', () => {
        expect(Object.isFrozen(STATE_ERROR_REASONS)).toBe(true);
    });
});

describe('isValidReason', () => {
    test.each([
        'VALIDATION_ARGS', 'VALIDATION_TARGET', 'VALIDATION_COMMIT',
        'INSTANCE_DESTROYED', 'CONFLICT', 'HTTP_ERROR', 'TRANSPORT_ERROR',
        'REPLAY_BROKEN', 'LOG_WRITE_FAILED',
    ])('accepts %s', (r) => expect(isValidReason(r)).toBe(true));
    test.each(['NOPE', '', null, undefined, 0, {}, []])('rejects %p', (r) => {
        expect(isValidReason(r)).toBe(false);
    });
});

describe('makeStateError', () => {
    test('returns the envelope shape', () => {
        expect(makeStateError('CONFLICT', 'HTTP 409 after 1 retry'))
            .toEqual({ ok: false, reason: 'CONFLICT', hint: 'HTTP 409 after 1 retry' });
    });
    test('rejects unknown reasons', () => {
        expect(() => makeStateError('NOPE', 'x')).toThrow(/NOPE/);
    });
    test('caps hint at 120 chars', () => {
        const long = 'x'.repeat(200);
        const out = makeStateError('HTTP_ERROR', long);
        expect(out.hint.length).toBe(STATE_HINT_MAX_LENGTH);
    });
    test('coerces non-string hint to string', () => {
        expect(makeStateError('TRANSPORT_ERROR', 42).hint).toBe('42');
    });
});

describe('makeStateOk', () => {
    test('returns ok:true with extras spread in', () => {
        expect(makeStateOk({ state: { x: 1 }, updated: true }))
            .toEqual({ ok: true, state: { x: 1 }, updated: true });
    });
    test('extras default to empty', () => {
        expect(makeStateOk()).toEqual({ ok: true });
    });
});
