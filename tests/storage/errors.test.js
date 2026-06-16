import { ConflictError, NotFoundError } from '../../src/storage/errors.js';

describe('storage errors', () => {
    test('ConflictError carries a code and message', () => {
        const err = new ConflictError('integrity_mismatch', { expected: 'a', actual: 'b' });
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('ConflictError');
        expect(err.code).toBe('integrity_mismatch');
        expect(err.details).toEqual({ expected: 'a', actual: 'b' });
    });

    test('NotFoundError carries a resource description', () => {
        const err = new NotFoundError('chat', { handle: 'u', name: 'x' });
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('NotFoundError');
        expect(err.resource).toBe('chat');
        expect(err.details).toEqual({ handle: 'u', name: 'x' });
    });
});
