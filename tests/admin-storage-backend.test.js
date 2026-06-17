import { buildStorageBackendCreds } from '../public/scripts/admin-storage-backend.js';

describe('buildStorageBackendCreds — admin Storage Backend cred builder', () => {
    test('fs returns empty object — no creds applicable', () => {
        expect(buildStorageBackendCreds('fs', {})).toEqual({});
        expect(buildStorageBackendCreds('fs', { mysqlUrl: 'mysql://x' })).toEqual({});
    });

    test('sqlite returns empty object — no creds applicable', () => {
        expect(buildStorageBackendCreds('sqlite', {})).toEqual({});
        expect(buildStorageBackendCreds('sqlite', { postgresUrl: 'postgresql://x' })).toEqual({});
    });

    test('mysql with all inputs empty returns {} — endpoint will fall back to config.yaml', () => {
        expect(buildStorageBackendCreds('mysql', {})).toEqual({});
        expect(buildStorageBackendCreds('mysql', { mysqlUrl: '', mysqlPoolSize: '' })).toEqual({});
        expect(buildStorageBackendCreds('mysql', { mysqlUrl: '   ', mysqlPoolSize: '   ' })).toEqual({});
    });

    test('mysql URL only — payload has only url, not poolSize', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: 'mysql://op:pw@db:3306/luker',
        })).toEqual({ mysql: { url: 'mysql://op:pw@db:3306/luker' } });
    });

    test('mysql poolSize only — payload has only poolSize', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlPoolSize: '25',
        })).toEqual({ mysql: { poolSize: 25 } });
    });

    test('mysql url + poolSize — both fields land in payload', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: 'mysql://op@h/db',
            mysqlPoolSize: '50',
        })).toEqual({ mysql: { url: 'mysql://op@h/db', poolSize: 50 } });
    });

    test('mysql url is trimmed', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: '  mysql://op@h/db  ',
        })).toEqual({ mysql: { url: 'mysql://op@h/db' } });
    });

    test('mysql non-numeric poolSize is dropped silently', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: 'mysql://op@h/db',
            mysqlPoolSize: 'abc',
        })).toEqual({ mysql: { url: 'mysql://op@h/db' } });
    });

    test('mysql non-positive poolSize is dropped silently', () => {
        // 0 / negative pool sizes are not meaningful — drop them so the
        // endpoint falls back to whatever config.yaml has.
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: 'mysql://op@h/db',
            mysqlPoolSize: '0',
        })).toEqual({ mysql: { url: 'mysql://op@h/db' } });
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: 'mysql://op@h/db',
            mysqlPoolSize: '-5',
        })).toEqual({ mysql: { url: 'mysql://op@h/db' } });
    });

    test('postgres branch mirrors mysql behavior', () => {
        expect(buildStorageBackendCreds('postgres', {
            postgresUrl: 'postgresql://op@h/db',
            postgresPoolSize: '15',
        })).toEqual({ postgres: { url: 'postgresql://op@h/db', poolSize: 15 } });
    });

    test('postgres fields do not leak when targetMode is mysql', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: 'mysql://m@h/db',
            postgresUrl: 'postgresql://p@h/db',
        })).toEqual({ mysql: { url: 'mysql://m@h/db' } });
    });

    test('mysql fields do not leak when targetMode is postgres', () => {
        expect(buildStorageBackendCreds('postgres', {
            mysqlUrl: 'mysql://m@h/db',
            postgresUrl: 'postgresql://p@h/db',
        })).toEqual({ postgres: { url: 'postgresql://p@h/db' } });
    });

    test('unknown mode returns empty object — defensive default', () => {
        expect(buildStorageBackendCreds('mongodb', { mysqlUrl: 'x' })).toEqual({});
        expect(buildStorageBackendCreds('', {})).toEqual({});
    });

    test('null and undefined input strings are tolerated', () => {
        expect(buildStorageBackendCreds('mysql', {
            mysqlUrl: null,
            mysqlPoolSize: undefined,
        })).toEqual({});
    });
});
