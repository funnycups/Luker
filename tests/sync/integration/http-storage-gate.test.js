/**
 * Plan Task 12, spec §6.3 — `/session/offer` must refuse with HTTP 412
 * when the configured storage engine is `mysql` or `postgres`.
 *
 * Rationale: those modes keep the bulk of user data on an external
 * database the Luker process doesn't own. File-level sync would only
 * round-trip the metadata sidecars and silently miss everything else, so
 * we make the unsupported state explicit at the earliest point (the
 * bootstrap endpoint) rather than letting the user discover it after a
 * long snapshot copy.
 *
 * Test architecture: rather than spinning up a real MySQL/Postgres
 * (`makeEndpointHarness` skips those modes when the corresponding
 * `LUKER_DISABLE_*_TESTS` env is set, which is the default in CI), we
 * stub `getStorageEngine` for this file alone via
 * `jest.unstable_mockModule` and stand up a minimal Express app whose
 * `req.user` is populated by a small inline middleware. The router under
 * test (`src/endpoints/sync.js`) imports `getStorageEngine` from the
 * same `src/storage/index.js` module path the mock replaces, so the gate
 * sees the stubbed `kind` without touching any database.
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

jest.unstable_mockModule('../../../src/storage/index.js', () => ({
    getStorageEngine: () => ({ kind: currentEngineKind }),
    // The endpoints under test only ever touch `getStorageEngine` and
    // `getUserDirectories` (no repos), so we don't need to re-export the
    // repo getters. The session/offer handler reads exclusively from
    // `req.user.directories.root`, which the inline middleware below
    // supplies — no `getUserDirectories(handle)` call path is hit.
}));

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

describe('sync /session/offer storage-mode gate', () => {
    test('returns 412 when storage mode is mysql', async () => {
        currentEngineKind = 'mysql';
        const app = buildApp();

        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: 'alice@phone', label: 'Phone', categories: [] });

        expect(r.status).toBe(412);
        expect(r.body.error).toMatch(/storage mode mysql/i);
        expect(r.body.token).toBeUndefined();
    });

    test('returns 412 when storage mode is postgres', async () => {
        currentEngineKind = 'postgres';
        const app = buildApp();

        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: 'alice@phone', label: 'Phone', categories: [] });

        expect(r.status).toBe(412);
        expect(r.body.error).toMatch(/storage mode postgres/i);
    });

    test('still issues a token when storage mode is fs', async () => {
        // Sanity that the gate is the only reason mysql/postgres fail —
        // not, say, a missing `req.user` shape that would also reject fs.
        currentEngineKind = 'fs';
        const app = buildApp();

        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: 'alice@phone', label: 'Phone', categories: [] });

        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
    });

    test('still issues a token when storage mode is sqlite', async () => {
        currentEngineKind = 'sqlite';
        const app = buildApp();

        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: 'alice@phone', label: 'Phone', categories: [] });

        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('sync /availability storage-mode gate', () => {
    test('reports unavailable with reason=storage_mode on mysql', async () => {
        currentEngineKind = 'mysql';
        const app = buildApp();
        const r = await request(app).get('/api/sync/v1/availability');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ available: false, reason: 'storage_mode', mode: 'mysql' });
    });

    test('reports unavailable with reason=storage_mode on postgres', async () => {
        currentEngineKind = 'postgres';
        const app = buildApp();
        const r = await request(app).get('/api/sync/v1/availability');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ available: false, reason: 'storage_mode', mode: 'postgres' });
    });

    test('reports available on fs', async () => {
        currentEngineKind = 'fs';
        const app = buildApp();
        const r = await request(app).get('/api/sync/v1/availability');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ available: true });
    });

    test('reports available on sqlite — sync IS supported in sqlite mode via the whole-DB blob category', async () => {
        currentEngineKind = 'sqlite';
        const app = buildApp();
        const r = await request(app).get('/api/sync/v1/availability');
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ available: true });
    });
});
