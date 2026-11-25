// tests/lib/abort-utils.test.js
import { describe, test, expect } from '@jest/globals';
import { isAbortError, isStrictAbortError } from '../../public/scripts/lib/abort-utils.js';

describe('isStrictAbortError', () => {
    test('accepts an error named AbortError', () => {
        const err = new Error('stop');
        err.name = 'AbortError';
        expect(isStrictAbortError(err)).toBe(true);
    });

    test('accepts a DOMException AbortError', () => {
        expect(isStrictAbortError(new DOMException('Operation aborted.', 'AbortError'))).toBe(true);
    });

    test('accepts any error when the signal is aborted', () => {
        const ctrl = new AbortController();
        ctrl.abort();
        expect(isStrictAbortError(new Error('socket hang up'), ctrl.signal)).toBe(true);
        expect(isStrictAbortError(null, ctrl.signal)).toBe(true);
    });

    test('rejects errors whose message only mentions abort', () => {
        const ctrl = new AbortController();
        expect(isStrictAbortError(new Error('upstream aborted the connection'))).toBe(false);
        expect(isStrictAbortError(new Error('upstream aborted the connection'), ctrl.signal)).toBe(false);
    });
});

describe('isAbortError', () => {
    test('accepts abort-worded messages and aborted signals', () => {
        const ctrl = new AbortController();
        ctrl.abort();
        expect(isAbortError(new Error('Orchestration aborted.'))).toBe(true);
        expect(isAbortError(null, ctrl.signal)).toBe(true);
        expect(isAbortError(new Error('rate limited'))).toBe(false);
    });
});
