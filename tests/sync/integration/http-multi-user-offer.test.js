/**
 * `/session/offer` basic-auth resolution in multi-user mode.
 *
 * Spec context: when `enableUserAccounts` is on, the production
 * `setUserDataMiddleware` only populates `req.user` from the session cookie.
 * A cross-server `fetch` from peer B's server to peer A's `/session/offer`
 * has no cookie — only the `Authorization: Basic` header the user typed into
 * the pair form. Without the shim, A returns 401 and the pair never starts.
 *
 * The router shim (`src/endpoints/sync.js`) falls back to
 * `resolveUserFromBasicAuth` when `req.user` is empty AND multi-user mode
 * is on. This file pins that contract end-to-end:
 *
 *   - real `users.js` storage (seeded via `storage.setItem`)
 *   - real router, real session minter, real shadow snapshot
 *   - Express app with NO `req.user` stub middleware, mirroring the
 *     production case where the cross-server request never carries a cookie
 *
 * `SILLYTAVERN_ENABLEUSERACCOUNTS=true` is set at file-top because
 * `users.js` captures `ENABLE_ACCOUNTS` at module-load time; the dynamic
 * `await import` inside `beforeAll` then sees the env var.
 *
 * Single-user mode (the default `enableUserAccounts: false`) is covered by
 * `http-session-lifecycle.test.js`, which still goes green after the shim
 * lands — that verifies the shim short-circuits cleanly when `req.user` is
 * already populated by `setUserDataMiddleware`'s DEFAULT_USER synthesis.
 */
process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';

/* global globalThis */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Buffer } from 'node:buffer';

import express from 'express';
import request from 'supertest';
import storage from 'node-persist';

/** @type {import('express').Router} */
let syncRouter;
let initStorage;
let getPasswordHash;
let getPasswordSalt;
let initUserStorage;
let toKey;
let getUserDirectories;

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-multi-user-'));
const PREV_DATA_ROOT = globalThis.DATA_ROOT;

const HANDLE = 'alice';
const PASSWORD = 'hunter2';

function basicHeader(username, password) {
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

function buildApp() {
    const app = express();
    app.use(express.json());
    // No req.user stub. The shim in `/session/offer` must resolve the user
    // from the basic-auth header on its own. That mirrors the cross-server
    // call shape where peer B's outbound fetch carries no session cookie.
    app.use('/api/sync/v1', syncRouter);
    return app;
}

describe('sync /session/offer multi-user basic-auth fallback', () => {
    beforeAll(async () => {
        globalThis.DATA_ROOT = TEST_DATA_ROOT;
        const usersMod = await import('../../../src/users.js');
        const storageMod = await import('../../../src/storage/index.js');
        ({ getPasswordHash, getPasswordSalt, initUserStorage, toKey, getUserDirectories } = usersMod);
        ({ initStorage } = storageMod);
        await initUserStorage(TEST_DATA_ROOT);
        initStorage({
            mode: 'fs',
            directoriesByHandle: (h) => getUserDirectories(h),
        });
        ({ router: syncRouter } = await import('../../../src/endpoints/sync.js'));
    });

    beforeEach(async () => {
        // Wipe + reseed so each test owns its user state. `getAllUserHandles`
        // walks node-persist, so leftover keys from prior tests would leak.
        await storage.clear();
        const salt = getPasswordSalt();
        await storage.setItem(toKey(HANDLE), {
            handle: HANDLE,
            name: HANDLE,
            created: Date.now(),
            password: getPasswordHash(PASSWORD, salt),
            salt,
            enabled: true,
            admin: false,
        });
        const dirs = getUserDirectories(HANDLE);
        fs.mkdirSync(dirs.root, { recursive: true });
    });

    afterAll(async () => {
        await storage.clear();
        fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
        globalThis.DATA_ROOT = PREV_DATA_ROOT;
    });

    test('issues a token when only Basic credentials are present', async () => {
        const app = buildApp();
        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .set('Authorization', basicHeader(HANDLE, PASSWORD))
            .send({ peerId: 'alice@phone', label: 'Phone', categories: [] });

        expect(r.status).toBe(200);
        expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        expect(r.body.peerId).toBe('alice@phone');

        // The token must bind to the basic-auth-resolved handle, not to
        // some anonymous default. Reach back through the session cache via
        // the manifest route to confirm the bound handle made it through.
        const m = await request(app)
            .get('/api/sync/v1/session/manifest')
            .set('Authorization', `Bearer ${r.body.token}`);
        expect(m.status).toBe(200);
        expect(m.body.handle).toBe(HANDLE);
    });

    test('rejects with 401 when Basic credentials have the wrong password', async () => {
        const app = buildApp();
        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .set('Authorization', basicHeader(HANDLE, 'wrong-password'))
            .send({ peerId: 'alice@phone', categories: [] });

        expect(r.status).toBe(401);
        expect(r.body.error).toBe('Auth required');
    });

    test('rejects with 401 when no Authorization header is present', async () => {
        const app = buildApp();
        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: 'alice@phone', categories: [] });

        expect(r.status).toBe(401);
        expect(r.body.error).toBe('Auth required');
    });

    test('rejects with 401 when the handle is unknown', async () => {
        const app = buildApp();
        const r = await request(app)
            .post('/api/sync/v1/session/offer')
            .set('Authorization', basicHeader('nobody', PASSWORD))
            .send({ peerId: 'alice@phone', categories: [] });

        expect(r.status).toBe(401);
        expect(r.body.error).toBe('Auth required');
    });
});
