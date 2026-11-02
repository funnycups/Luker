/**
 * `/session/offer` credential resolution in multi-user mode.
 *
 * A cross-server `fetch` from peer B's server to peer A's `/session/offer`
 * carries no session cookie. The offer authenticates with the one-time
 * pairing code or the durable peer secret, verified against the user's
 * registered LAN backend; basic-auth credentials alone do not mint a
 * session. This file pins that contract end-to-end:
 *
 *   - real `users.js` storage (seeded via `storage.setItem`)
 *   - real router, real session minter, real shadow snapshot
 *   - Express app with NO `req.user` stub middleware, mirroring the
 *     production case where the cross-server request never carries a cookie
 *
 * `SILLYTAVERN_ENABLEUSERACCOUNTS=true` is set at file-top because
 * `users.js` captures `ENABLE_ACCOUNTS` at module-load time; the dynamic
 * `await import` inside `beforeAll` then sees the env var.
 */
process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';

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
let isBasicAuthExemptRequest;
let callbackDevice;
const previousPrivatePolicy = process.env.LUKER_SYNC_ALLOW_PRIVATE_ADDRESSES_FOR_USERS;

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

describe('sync /session/offer in multi-user mode', () => {
    beforeAll(async () => {
        process.env.LUKER_SYNC_ALLOW_PRIVATE_ADDRESSES_FOR_USERS = 'true';
        globalThis.DATA_ROOT = TEST_DATA_ROOT;
        const usersMod = await import('../../../src/users.js');
        const storageMod = await import('../../../src/storage/index.js');
        ({ getPasswordHash, getPasswordSalt, initUserStorage, toKey, getUserDirectories } = usersMod);
        ({ initStorage } = storageMod);
        await initUserStorage(TEST_DATA_ROOT);
        await initStorage({
            mode: 'fs',
            directoriesByHandle: (h) => getUserDirectories(h),
        });
        ({ router: syncRouter } = await import('../../../src/endpoints/sync.js'));
        ({ isBasicAuthExemptRequest } = await import('../../../src/middleware/basicAuth.js'));
        const { startLanDevice } = await import('../_lib/lan-devices.js');
        callbackDevice = await startLanDevice({ handle: HANDLE });
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
        await callbackDevice.close();
        if (previousPrivatePolicy === undefined) delete process.env.LUKER_SYNC_ALLOW_PRIVATE_ADDRESSES_FOR_USERS;
        else process.env.LUKER_SYNC_ALLOW_PRIVATE_ADDRESSES_FOR_USERS = previousPrivatePolicy;
        await storage.clear();
        fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
        globalThis.DATA_ROOT = PREV_DATA_ROOT;
    });

    test('an offer with only basic credentials gets 401 PEER_AUTH_REQUIRED', async () => {
        const app = buildApp();
        for (const authorization of [basicHeader(HANDLE, PASSWORD), basicHeader(HANDLE, 'wrong-password'), basicHeader('nobody', PASSWORD)]) {
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('Authorization', authorization)
                .send({ peerId: 'alice@phone', label: 'Phone', protocol: 2 });
            expect(r.status).toBe(401);
            expect(r.body.code).toBe('PEER_AUTH_REQUIRED');
        }
        const none = await request(app)
            .post('/api/sync/v1/session/offer')
            .send({ peerId: 'alice@phone', protocol: 2 });
        expect(none.status).toBe(401);
        expect(none.body.code).toBe('PEER_AUTH_REQUIRED');
    });

    describe('pairing-code handshake', () => {
        const PEER_ID = 'alice@phone';

        test('basic-auth middleware exempts offer calls carrying a pairing credential', () => {
            // Cross-server offer calls carry either the one-time pairing
            // code (first pair) or the durable peer secret (every later
            // sync). Those requests must reach the route handler, which
            // verifies the credential against the peer registry and 401s
            // on a mismatch. Without a header the route stays gated.
            expect(isBasicAuthExemptRequest({
                method: 'POST',
                path: '/api/sync/v1/session/offer',
                headers: { 'x-sync-pair-code': 'a'.repeat(64) },
            })).toBe(true);
            expect(isBasicAuthExemptRequest({
                method: 'POST',
                path: '/api/sync/v1/session/offer',
                headers: { 'x-sync-peer-secret': 'b'.repeat(64) },
            })).toBe(true);
            expect(isBasicAuthExemptRequest({
                method: 'POST',
                path: '/api/sync/v1/session/offer',
                headers: {},
            })).toBe(false);
        });

        test('one-time pair code resolves the user and returns a durable secret', async () => {
            const { createPairingCode } = await import('../../../src/sync/session.js');
            const { upsertLanBackend } = await import('../../../src/sync/state.js');
            const dirs = getUserDirectories(HANDLE);
            await upsertLanBackend({ userRoot: dirs.root, backendId: PEER_ID, label: 'Phone', categories: [] });
            const code = createPairingCode({ handle: HANDLE, peerId: PEER_ID });

            const app = buildApp();
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Pair-Code', code)
                .send({ peerId: PEER_ID, label: 'Phone', protocol: 2, callback: callbackDevice.userStore.selfCallback() });

            expect(r.status).toBe(200);
            expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
            expect(r.body.syncSecret).toMatch(/^[a-f0-9]{64}$/);

            // The secret was persisted on the peer entry so later offers
            // can present it without the one-time code.
            const { readRegistry } = await import('../../../src/sync/state.js');
            expect((await readRegistry({ userRoot: dirs.root })).backends[PEER_ID].lan.syncSecret).toBe(r.body.syncSecret);
        });

        test('pair code is single-use — a replay gets 401', async () => {
            const { createPairingCode } = await import('../../../src/sync/session.js');
            const { upsertLanBackend } = await import('../../../src/sync/state.js');
            const dirs = getUserDirectories(HANDLE);
            await upsertLanBackend({ userRoot: dirs.root, backendId: PEER_ID, label: 'Phone', categories: [] });
            const code = createPairingCode({ handle: HANDLE, peerId: PEER_ID });

            const app = buildApp();
            const first = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Pair-Code', code)
                .send({ peerId: PEER_ID, protocol: 2, callback: callbackDevice.userStore.selfCallback() });
            expect(first.status).toBe(200);

            const replay = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Pair-Code', code)
                .send({ peerId: PEER_ID, protocol: 2, callback: callbackDevice.userStore.selfCallback() });
            expect(replay.status).toBe(401);
            expect(replay.body.code).toBe('PEER_AUTH_FAILED');
        });

        test('durable secret authenticates every later offer', async () => {
            const { createPairingCode } = await import('../../../src/sync/session.js');
            const { upsertLanBackend } = await import('../../../src/sync/state.js');
            const dirs = getUserDirectories(HANDLE);
            await upsertLanBackend({ userRoot: dirs.root, backendId: PEER_ID, label: 'Phone', categories: [] });
            const code = createPairingCode({ handle: HANDLE, peerId: PEER_ID });

            const app = buildApp();
            const handshake = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Pair-Code', code)
                .send({ peerId: PEER_ID, protocol: 2, callback: callbackDevice.userStore.selfCallback() });
            expect(handshake.status).toBe(200);

            const later = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Peer-Secret', handshake.body.syncSecret)
                .send({ peerId: PEER_ID, protocol: 2, callback: callbackDevice.userStore.selfCallback() });
            expect(later.status).toBe(200);
            expect(later.body.token).toMatch(/^[a-f0-9]{64}$/);
            // A later offer does NOT mint a fresh secret.
            expect(later.body.syncSecret).toBeUndefined();
        });

        test('wrong or missing credentials still get 401', async () => {
            const { createPairingCode } = await import('../../../src/sync/session.js');
            const { upsertLanBackend } = await import('../../../src/sync/state.js');
            const dirs = getUserDirectories(HANDLE);
            await upsertLanBackend({ userRoot: dirs.root, backendId: PEER_ID, label: 'Phone', categories: [] });
            const code = createPairingCode({ handle: HANDLE, peerId: PEER_ID });

            const app = buildApp();
            const handshake = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Pair-Code', code)
                .send({ peerId: PEER_ID, protocol: 2, callback: callbackDevice.userStore.selfCallback() });
            expect(handshake.status).toBe(200);

            const wrongSecret = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Peer-Secret', 'a'.repeat(64))
                .send({ peerId: PEER_ID, protocol: 2 });
            expect(wrongSecret.status).toBe(401);

            const none = await request(app)
                .post('/api/sync/v1/session/offer')
                .send({ peerId: PEER_ID, protocol: 2 });
            expect(none.status).toBe(401);
        });

        test('a pair code bound to another peerId cannot be replayed against this one', async () => {
            const { createPairingCode } = await import('../../../src/sync/session.js');
            const { upsertLanBackend } = await import('../../../src/sync/state.js');
            const dirs = getUserDirectories(HANDLE);
            await upsertLanBackend({ userRoot: dirs.root, backendId: PEER_ID, label: 'Phone', categories: [] });
            await upsertLanBackend({ userRoot: dirs.root, backendId: 'alice@tablet', label: 'Tablet', categories: [] });
            const code = createPairingCode({ handle: HANDLE, peerId: 'alice@tablet' });

            const app = buildApp();
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('X-Sync-Pair-Code', code)
                .send({ peerId: PEER_ID, protocol: 2 });
            expect(r.status).toBe(401);
        });
    });
});
