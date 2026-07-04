/**
 * Storage-mode regression guard for `/session/offer` and `/availability`.
 *
 * Earlier revisions of LAN Sync gated `/session/offer`, `/pull`,
 * `/pair/start`, `/pair/accept`, `/peers/:peerId/sync` with a 412 when the
 * storage engine was `mysql` or `postgres`, and reported the same modes as
 * `available: false` on `/availability`. Once the orchestrator started
 * routing SQL-engine data through the per-record materializer, those gates
 * became dead weight. This file pins the new contract — every storage
 * engine is accepted — so a future regression that re-introduces a
 * storage-mode gate fails loudly here instead of silently shipping.
 *
 * Test architecture: rather than spinning up a real MySQL/Postgres
 * (`makeEndpointHarness` skips those modes when the corresponding
 * `LUKER_DISABLE_*_TESTS` env is set, which is the default in CI), we
 * stub `getStorageEngine` for this file alone via
 * `jest.unstable_mockModule` and stand up a minimal Express app whose
 * `req.user` is populated by a small inline middleware. The router under
 * test (`src/endpoints/sync.js`) imports `getStorageEngine` from the
 * same `src/storage/index.js` module path the mock replaces, so the
 * router sees the stubbed `kind` without touching any database.
 *
 * The mock is module-level (top of file, before any imports of the
 * router) because `jest.unstable_mockModule` only intercepts dynamic
 * `import()` after the mock is registered; static `import` statements
 * are resolved before the mock applies.
 */
import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let currentEngineKind = 'fs';

jest.unstable_mockModule('../../../src/storage/index.js', () => {
    // Static reject stub for repo accessors that aren't exercised by this
    // suite but ARE imported transitively (sync.js → users.js →
    // endpoints/content-manager.js pulls getNamedDocRepo/getWorldInfoRepo/
    // getPresetRepo/getSettingsRepo at module-load). Keep the mock complete
    // so ESM link doesn't fail with `does not provide an export named ...`
    // whenever a new getXxxRepo joins storage/index.js.
    const notWiredForThisSuite = (name) => () => {
        throw new Error(`${name}() is not wired in http-storage-gate.test.js mock; the /session/offer + /availability handlers under test don't touch it.`);
    };
    return {
        // Materialize/dematerialize call `engine.withTransaction(handle, fn)`
        // before reading the enabled-category set; with an empty categories
        // array nothing actually runs inside the txn, but the type guard at
        // the top of materializeUserDataIntoWorkdir still demands the
        // function exist. Hand back the tx-callable shape with a stub
        // that's never invoked under empty `categories: []`.
        getStorageEngine: () => ({
            kind: currentEngineKind,
            withTransaction: async (_handle, fn) => fn({}),
        }),
        getChatRepo: notWiredForThisSuite('getChatRepo'),
        getSettingsRepo: notWiredForThisSuite('getSettingsRepo'),
        getPresetRepo: notWiredForThisSuite('getPresetRepo'),
        getWorldInfoRepo: notWiredForThisSuite('getWorldInfoRepo'),
        getNamedDocRepo: notWiredForThisSuite('getNamedDocRepo'),
        getGroupRepo: notWiredForThisSuite('getGroupRepo'),
        getStatsRepo: notWiredForThisSuite('getStatsRepo'),
        initStorage: notWiredForThisSuite('initStorage'),
        setReadOnly: () => {},
        isReadOnly: () => false,
        withReadOnlyBypass: async (fn) => fn(),
    };
});

/** @type {import('express').Router} */
let syncRouter;

beforeAll(async () => {
    ({ router: syncRouter } = await import('../../../src/endpoints/sync.js'));
});

function buildApp({ handle = 'alice', dataRoot = '/tmp/luker-storage-gate-not-real' } = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle, admin: true, enabled: true },
            directories: { root: dataRoot },
        };
        next();
    });
    app.use('/api/sync/v1', syncRouter);
    return app;
}

describe('sync /session/offer accepts every storage mode', () => {
    for (const kind of ['fs', 'sqlite', 'mysql', 'postgres']) {
        test(`issues a token when storage mode is ${kind}`, async () => {
            currentEngineKind = kind;
            const app = buildApp();

            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .send({ peerId: 'alice@phone', label: 'Phone', categories: [] });

            expect(r.status).toBe(200);
            expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        });
    }
});

describe('sync /availability is always available', () => {
    for (const kind of ['fs', 'sqlite', 'mysql', 'postgres']) {
        test(`reports available on ${kind}`, async () => {
            currentEngineKind = kind;
            const app = buildApp();
            const r = await request(app).get('/api/sync/v1/availability');
            expect(r.status).toBe(200);
            expect(r.body).toEqual({ available: true });
        });
    }
});
