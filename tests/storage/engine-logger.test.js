import { jest } from '@jest/globals';
import { logEngineError } from '../../src/storage/engine-logger.js';

describe('logEngineError', () => {
    let errSpy;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
    afterEach(() => { errSpy.mockRestore(); });

    test('writes a single line with engine, op, handle, code, message', () => {
        const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
        logEngineError('mysql', 'ping', 'alice', err);
        expect(errSpy).toHaveBeenCalledTimes(1);
        const line = errSpy.mock.calls[0][0];
        expect(line).toMatch(/^\[storage:mysql\] op=ping handle=alice err=ECONNREFUSED: connection refused$/);
    });

    test('substitutes "-" when handle is null/undefined', () => {
        logEngineError('postgres', 'acquire', null, new Error('pool exhausted'));
        const line = errSpy.mock.calls[0][0];
        expect(line).toMatch(/handle=- /);
    });

    test('falls back to err.name when code is missing', () => {
        const err = new Error('boom');
        err.name = 'CustomError';
        logEngineError('sqlite', 'tx', 'bob', err);
        const line = errSpy.mock.calls[0][0];
        expect(line).toContain('err=CustomError');
    });

    test('appends meta object as second console.error arg when non-empty', () => {
        logEngineError('mysql', 'tx', 'alice', new Error('x'), { retries: 3 });
        expect(errSpy.mock.calls[0][1]).toEqual({ retries: 3 });
    });

    test('omits meta arg when empty', () => {
        logEngineError('mysql', 'tx', 'alice', new Error('x'));
        expect(errSpy.mock.calls[0].length).toBe(1);
    });
});
