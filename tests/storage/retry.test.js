import { jest } from '@jest/globals';
import { withRetry, isTransientError } from '../../src/storage/retry.js';

describe('isTransientError', () => {
    test('mysql deadlock', () => {
        expect(isTransientError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    });
    test('mysql lock wait timeout', () => {
        expect(isTransientError({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(true);
    });
    test('node ECONNRESET', () => {
        expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    });
    test('mysql connection lost', () => {
        expect(isTransientError({ code: 'PROTOCOL_CONNECTION_LOST' })).toBe(true);
    });
    test('postgres serialization failure 40001', () => {
        expect(isTransientError({ code: '40001' })).toBe(true);
    });
    test('postgres deadlock 40P01', () => {
        expect(isTransientError({ code: '40P01' })).toBe(true);
    });
    test('postgres connection failure 08006', () => {
        expect(isTransientError({ code: '08006' })).toBe(true);
    });
    test('postgres admin shutdown 57P03', () => {
        expect(isTransientError({ code: '57P03' })).toBe(true);
    });
    test('generic error is not transient', () => {
        expect(isTransientError({ code: 'ER_NO_SUCH_TABLE' })).toBe(false);
        expect(isTransientError(new Error('boom'))).toBe(false);
        expect(isTransientError(null)).toBe(false);
    });
});

describe('withRetry', () => {
    test('returns value on first success without sleeping', async () => {
        const fn = jest.fn(() => Promise.resolve('ok'));
        const out = await withRetry(fn, { retries: 3, baseMs: 1 });
        expect(out).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on transient and eventually succeeds', async () => {
        let calls = 0;
        const out = await withRetry(async () => {
            calls++;
            if (calls < 3) {
                const e = new Error('deadlock');
                e.code = 'ER_LOCK_DEADLOCK';
                throw e;
            }
            return 'done';
        }, { retries: 3, baseMs: 1 });
        expect(out).toBe('done');
        expect(calls).toBe(3);
    });

    test('throws the final error after exhausting retries', async () => {
        let calls = 0;
        const promise = withRetry(async () => {
            calls++;
            const e = new Error('still deadlocked');
            e.code = 'ER_LOCK_DEADLOCK';
            throw e;
        }, { retries: 2, baseMs: 1 });
        await expect(promise).rejects.toThrow('still deadlocked');
        expect(calls).toBe(3); // initial + 2 retries
    });

    test('does NOT retry non-transient errors', async () => {
        const fn = jest.fn(() => Promise.reject(new Error('no such table')));
        await expect(withRetry(fn, { retries: 5, baseMs: 1 })).rejects.toThrow('no such table');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('honors custom isRetryable predicate', async () => {
        let calls = 0;
        const out = await withRetry(async () => {
            calls++;
            if (calls < 2) throw new Error('custom retryable');
            return 'ok';
        }, { retries: 3, baseMs: 1, isRetryable: (e) => e.message === 'custom retryable' });
        expect(out).toBe('ok');
        expect(calls).toBe(2);
    });
});
