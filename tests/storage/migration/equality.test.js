import { stripChatEngineMeta, recordsEqual } from '../../../src/storage/migration/equality.js';

describe('stripChatEngineMeta', () => {
    test('returns null/undefined unchanged', () => {
        expect(stripChatEngineMeta(null)).toBeNull();
        expect(stripChatEngineMeta(undefined)).toBeUndefined();
    });

    test('drops engine-managed top-level fields', () => {
        const rec = {
            integrity: 'abc',
            updatedAt: 1234,
            createdAt: 99,
            key: { kind: 'chat', handle: 'u', name: 'c1' },
            header: { user_name: 'U' },
            body: [{ mes: 'hi' }],
        };
        const stripped = stripChatEngineMeta(rec);
        expect(stripped).not.toHaveProperty('integrity');
        expect(stripped).not.toHaveProperty('updatedAt');
        expect(stripped).not.toHaveProperty('createdAt');
        expect(stripped).not.toHaveProperty('key');
        expect(stripped.header).toEqual({ user_name: 'U' });
        expect(stripped.body).toEqual([{ mes: 'hi' }]);
    });

    test('drops chat_metadata.integrity but keeps other chat_metadata fields', () => {
        const rec = {
            header: {
                user_name: 'U',
                chat_metadata: { integrity: 'rot', foo: 'bar', variables: { v: 1 } },
            },
            body: [],
        };
        const stripped = stripChatEngineMeta(rec);
        expect(stripped.header.chat_metadata).toEqual({ foo: 'bar', variables: { v: 1 } });
    });

    test('handles missing header gracefully', () => {
        const rec = { body: [{ mes: 'hi' }] };
        const stripped = stripChatEngineMeta(rec);
        expect(stripped.header).toEqual({});
        expect(stripped.body).toEqual([{ mes: 'hi' }]);
    });

    test('handles header without chat_metadata', () => {
        const rec = { header: { user_name: 'U' }, body: [] };
        const stripped = stripChatEngineMeta(rec);
        expect(stripped.header).toEqual({ user_name: 'U' });
    });

    test('two records with different integrity but same payload compare equal', () => {
        const a = {
            integrity: 'abc',
            updatedAt: 100,
            header: { user_name: 'U', chat_metadata: { integrity: 'abc', x: 1 } },
            body: [{ mes: 'hi' }],
        };
        const b = {
            integrity: 'xyz',
            updatedAt: 200,
            header: { user_name: 'U', chat_metadata: { integrity: 'xyz', x: 1 } },
            body: [{ mes: 'hi' }],
        };
        expect(stripChatEngineMeta(a)).toEqual(stripChatEngineMeta(b));
    });
});

describe('recordsEqual', () => {
    test('uses tolerant chat comparison for kind=chat', () => {
        const a = {
            integrity: 'rot-a',
            updatedAt: 1,
            header: { user_name: 'U', chat_metadata: { integrity: 'rot-a' } },
            body: [{ mes: 'hi' }],
        };
        const b = {
            integrity: 'rot-b',
            updatedAt: 999,
            header: { user_name: 'U', chat_metadata: { integrity: 'rot-b' } },
            body: [{ mes: 'hi' }],
        };
        expect(recordsEqual('chat', a, b)).toBe(true);
    });

    test('chat comparison still catches body differences', () => {
        const a = { header: {}, body: [{ mes: 'hi' }] };
        const b = { header: {}, body: [{ mes: 'bye' }] };
        expect(recordsEqual('chat', a, b)).toBe(false);
    });

    test('chat comparison catches header differences (non-integrity)', () => {
        const a = { header: { user_name: 'U' }, body: [] };
        const b = { header: { user_name: 'V' }, body: [] };
        expect(recordsEqual('chat', a, b)).toBe(false);
    });

    test('uses exact deep-equal for non-chat kinds', () => {
        expect(recordsEqual('settings', { x: 1 }, { x: 1 })).toBe(true);
        expect(recordsEqual('settings', { x: 1 }, { x: 2 })).toBe(false);
        expect(recordsEqual('preset', { temp: 0.7 }, { temp: 0.7 })).toBe(true);
        expect(recordsEqual('preset', { temp: 0.7 }, { temp: 0.8 })).toBe(false);
    });

    test('non-chat comparison is strict (no tolerance)', () => {
        // Settings docs that would compare equal under chat tolerance must NOT
        // compare equal under exact equality if any field differs.
        const a = { x: 1, updatedAt: 100 };
        const b = { x: 1, updatedAt: 200 };
        expect(recordsEqual('settings', a, b)).toBe(false);
    });

    test('handles null on both sides', () => {
        expect(recordsEqual('settings', null, null)).toBe(true);
        expect(recordsEqual('chat', null, null)).toBe(true);
    });

    test('handles null vs object', () => {
        expect(recordsEqual('settings', null, { x: 1 })).toBe(false);
        expect(recordsEqual('chat', null, { header: {}, body: [] })).toBe(false);
    });
});
