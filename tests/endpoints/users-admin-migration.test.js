/* global globalThis */
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// ----- Mocks -----
// Mock modules BEFORE importing users-admin.js. unstable_mockModule defers
// resolution so we can build mocks that close over per-test state.

const mockState = {
    handles: [],
    migrateUserBehavior: null,  // (handle) => Promise; throws to simulate failure
    initStorageCalled: false,
    persistCalled: false,
    requireAdminPass: true,
};

jest.unstable_mockModule('../../src/storage/index.js', () => ({
    getStorageEngine: () => ({ kind: 'fs', close: async () => {} }),
    initStorage: () => { mockState.initStorageCalled = true; },
    isReadOnly: () => false,
    setReadOnly: () => {},
}));

jest.unstable_mockModule('../../src/users.js', () => ({
    // Names actually exercised by the routes under test.
    getAllUserHandles: async () => [...mockState.handles],
    getUserDirectories: (h) => ({ root: `/tmp/${h}` }),
    requireAdminMiddleware: (req, res, next) => {
        if (mockState.requireAdminPass) return next();
        return res.status(403).send({ error: 'admin_required' });
    },
    // Stubs for names destructured at users-admin.js module top-level but
    // never reached by the /storage/* routes. ESM link fails if a named
    // import resolves to undefined, so we expose each export explicitly.
    KEY_PREFIX: 'user:',
    toKey: (h) => `user:${h}`,
    getUserAvatar: async () => null,
    getPasswordSalt: () => '',
    getPasswordHash: () => '',
    ensurePublicDirectoriesExist: async () => {},
}));

jest.unstable_mockModule('../../src/storage/migration/runner.js', () => ({
    MigrationRunner: class {
        constructor() {}
        async migrateUser(handle, { onProgress } = {}) {
            if (onProgress) onProgress({ stage: 'starting' });
            if (mockState.migrateUserBehavior) {
                await mockState.migrateUserBehavior(handle);
            }
            return { handle, verified: true, errors: [] };
        }
    },
}));

jest.unstable_mockModule('../../src/storage/engines/fs-engine.js', () => ({
    FsEngine: class { constructor() { this.kind = 'fs'; } async close() {} },
}));
jest.unstable_mockModule('../../src/storage/engines/sqlite-engine.js', () => ({
    SqliteEngine: class { constructor() { this.kind = 'sqlite'; } async close() {} },
}));
jest.unstable_mockModule('../../src/storage/engines/mysql-engine.js', () => ({
    MysqlEngine: class { constructor() { this.kind = 'mysql'; } async close() {} },
}));
jest.unstable_mockModule('../../src/storage/engines/postgres-engine.js', () => ({
    PgEngine: class { constructor() { this.kind = 'postgres'; } async close() {} },
}));

jest.unstable_mockModule('../../src/storage/repositories/chat-repo.js', () => ({ ChatRepo: class {} }));
jest.unstable_mockModule('../../src/storage/repositories/settings-repo.js', () => ({ SettingsRepo: class {} }));
jest.unstable_mockModule('../../src/storage/repositories/preset-repo.js', () => ({ PresetRepo: class {} }));
jest.unstable_mockModule('../../src/storage/repositories/world-info-repo.js', () => ({ WorldInfoRepo: class {} }));
jest.unstable_mockModule('../../src/storage/repositories/named-doc-repo.js', () => ({ NamedDocRepo: class {} }));
jest.unstable_mockModule('../../src/storage/repositories/group-repo.js', () => ({ GroupRepo: class {} }));
jest.unstable_mockModule('../../src/storage/repositories/stats-repo.js', () => ({ StatsRepo: class {} }));

jest.unstable_mockModule('../../src/storage/config-persistence.js', () => ({
    resolveStorageDbConfig: ({ inline, fromConfig }) => {
        const url = inline?.url || fromConfig?.url;
        if (!url) return null;
        return { engine: { url }, inlineFields: inline ? { url: inline.url } : null };
    },
    persistStorageBackendToConfig: async () => {
        mockState.persistCalled = true;
        return { ok: true };
    },
}));

// Note: util.js is NOT mocked — jest.setup.js already configures it via
// setConfigFilePath/reloadConfigCache, and many of the modules transitively
// imported by users-admin.js (content-manager, plugin-loader, etc.) pull
// named exports from util.js that the brief's minimal mock would not cover.

// Now import the router under test.
const { router } = await import('../../src/endpoints/users-admin.js');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
}

// Default mockState — restored before every test so describes are insulated
// from one another. Each describe's own beforeEach only sets per-scenario
// handles (and any explicit overrides).
const DEFAULT_MOCK_STATE = {
    handles: [],
    migrateUserBehavior: null,
    initStorageCalled: false,
    persistCalled: false,
    requireAdminPass: true,
};

// Top-level isolation: clear module-level _migrationState (and READ_ONLY) in
// users-admin.js via the public reset endpoint, and reset all mockState
// fields. Runs before each describe's own beforeEach, so per-test setup
// always starts from a clean slate. The reset endpoint is itself exercised
// by cases 5/6.
let _appForReset;
beforeEach(async () => {
    if (!_appForReset) _appForReset = makeApp();
    Object.assign(mockState, DEFAULT_MOCK_STATE);
    await request(_appForReset).post('/storage/migrate/reset').send({ confirm: true });
});

describe('POST /storage/migrate — fresh run', () => {
    beforeEach(() => {
        mockState.handles = ['a', 'b', 'c'];
        globalThis.DATA_ROOT = '/tmp/data';
    });

    test('all 3 users succeed -> 200 ok + swap + state cleared', async () => {
        const app = makeApp();
        const res = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.currentMode).toBe('postgres');
        for (const h of ['a', 'b', 'c']) {
            expect(res.body.perUser[h].status).toBe('done');
        }
        expect(mockState.initStorageCalled).toBe(true);
        expect(mockState.persistCalled).toBe(true);

        // /storage/status now reports no migration in progress
        const statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.migrationInProgress).toBe(false);
        expect(statusRes.body.state).toBeNull();
    });
});

describe('POST /storage/migrate — partial failure', () => {
    beforeEach(() => {
        mockState.handles = ['a', 'b', 'c'];
        globalThis.DATA_ROOT = '/tmp/data';
    });

    test('user b throws -> 500 + state preserved + a/c done + b failed', async () => {
        mockState.migrateUserBehavior = async (h) => {
            if (h === 'b') throw new Error('connection lost');
        };
        const app = makeApp();
        const res = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });
        expect(res.status).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.perUser.a.status).toBe('done');
        expect(res.body.perUser.b.status).toBe('failed');
        expect(res.body.perUser.b.error).toMatch(/connection lost/);
        expect(res.body.perUser.c.status).toBe('done');
        // initStorage NOT called — source engine retained
        expect(mockState.initStorageCalled).toBe(false);

        // state survives
        const statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.migrationInProgress).toBe(true);
        expect(statusRes.body.state.perUser.b.status).toBe('failed');
    });
});

describe('POST /storage/migrate — resume', () => {
    beforeEach(() => {
        mockState.handles = ['a', 'b', 'c'];
        globalThis.DATA_ROOT = '/tmp/data';
    });

    test('second POST with same target only retries failed user', async () => {
        const app = makeApp();
        // First call: b fails. Track which handles got migrateUser called so
        // we can verify the full a/b/c flow actually ran (guards against the
        // describe inheriting leaked state from an earlier suite).
        const firstCalls = [];
        mockState.migrateUserBehavior = async (h) => {
            firstCalls.push(h);
            if (h === 'b') throw new Error('connection lost');
        };
        await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });
        expect(firstCalls).toEqual(['a', 'b', 'c']);

        // Second call: b succeeds. Track which handles got migrateUser called.
        const calls = [];
        mockState.migrateUserBehavior = async (h) => { calls.push(h); };
        const res = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        // Only b should have been migrated; a and c were already done
        expect(calls).toEqual(['b']);
        expect(mockState.initStorageCalled).toBe(true);
    });
});

describe('POST /storage/migrate — fingerprint mismatch', () => {
    beforeEach(() => {
        mockState.handles = ['a'];
        globalThis.DATA_ROOT = '/tmp/data';
    });

    test('different target while migration in progress -> 409', async () => {
        const app = makeApp();
        // First call: a fails, state preserved
        mockState.migrateUserBehavior = async () => { throw new Error('boom'); };
        await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });

        // Second call: different target
        const res = await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'mysql', mysql: { url: 'mysql://u:p@h/d' } });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('migration_in_progress_different_target');
        expect(res.body.currentTargetMode).toBe('postgres');
    });
});

describe('POST /storage/migrate/reset', () => {
    beforeEach(() => {
        mockState.handles = ['a'];
        globalThis.DATA_ROOT = '/tmp/data';
    });

    test('without confirm -> 400', async () => {
        const app = makeApp();
        const res = await request(app)
            .post('/storage/migrate/reset')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('reset_requires_confirm');
    });

    test('with confirm + state present -> 200 + state cleared', async () => {
        const app = makeApp();
        // Create some state by failing a migration
        mockState.migrateUserBehavior = async () => { throw new Error('boom'); };
        await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });

        let statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.migrationInProgress).toBe(true);

        const resetRes = await request(app)
            .post('/storage/migrate/reset')
            .send({ confirm: true });
        expect(resetRes.status).toBe(200);
        expect(resetRes.body.ok).toBe(true);

        statusRes = await request(app).post('/storage/status').send({});
        expect(statusRes.body.migrationInProgress).toBe(false);
        expect(statusRes.body.state).toBeNull();
    });
});

describe('POST /storage/status — staleSeconds', () => {
    beforeEach(() => {
        mockState.handles = ['a'];
        globalThis.DATA_ROOT = '/tmp/data';
    });

    test('staleSeconds reflects time since last progress', async () => {
        const app = makeApp();
        // Create state via a failure (sync — completes in ms)
        mockState.migrateUserBehavior = async () => { throw new Error('boom'); };
        await request(app)
            .post('/storage/migrate')
            .send({ targetMode: 'postgres', postgres: { url: 'postgresql://u:p@h/d' } });

        const res = await request(app).post('/storage/status').send({});
        expect(res.body.state).not.toBeNull();
        expect(typeof res.body.state.staleSeconds).toBe('number');
        expect(res.body.state.staleSeconds).toBeGreaterThanOrEqual(0);
        // First check is very fresh — staleSeconds <= 5 is generous for slow CI
        expect(res.body.state.staleSeconds).toBeLessThanOrEqual(5);
    });
});
