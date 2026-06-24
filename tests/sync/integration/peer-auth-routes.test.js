/**
 * End-to-end coverage for persisted peer credentials in multi-user mode.
 *
 * Three contracts live here:
 *
 *   1. `DELETE /peers/:peerId/auth` clears the stored credentials and
 *      flips the `GET /peers` `hasStoredCredentials` flag to false.
 *
 *   2. `GET /peers` NEVER leaks the password — neither before nor after
 *      pairing. The server-side projection replaces the credential blob
 *      with a boolean, so even a state.json read via the API can't
 *      shoulder-surf the secret.
 *
 *   3. `POST /peers/:peerId/sync` reuses the stored peerAuth on its
 *      outbound `/session/offer` call when the caller body omits it.
 *      This is the load-bearing user-visible behavior: pre-this-change
 *      "Sync now" 401'd on multi-user setups because the credentials
 *      lived only in the pair form.
 *
 * Harness shape mirrors `handle-mismatch.test.js`: A is a real listener
 * in multi-user mode (req.user resolved from basic-auth); B drives the
 * test via supertest with a stub req.user middleware (mimics B's
 * session-cookie path). Both run against the same `alice` handle
 * because the handle-mismatch gate (spec §3.4) requires matching, but
 * each gets its own data root so their `.sync/state.json` files don't
 * collide.
 *
 * `SILLYTAVERN_ENABLEUSERACCOUNTS=true` is set at file-top because
 * `users.js` captures `ENABLE_ACCOUNTS` at module-load time.
 */
process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';

/* global globalThis */
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
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

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-peer-auth-routes-'));
const PREV_DATA_ROOT = globalThis.DATA_ROOT;

const HANDLE = 'alice';
const PASSWORD = 'hunter2';

function basicHeader(username, password) {
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

/**
 * A's app: no req.user stub. The route's basic-auth shim must resolve
 * the user from the Authorization header on cross-server requests, like
 * production does when B's outbound fetch carries no session cookie.
 *
 * `aRoot` is the data root the resolver hands to recordPeer/readSyncState
 * via getUserDirectories. We override the resolved directories with this
 * isolated root by stubbing AFTER basic-auth runs.
 */
function buildAppA() {
    const app = express();
    app.use(express.json());
    app.use('/api/sync/v1', syncRouter);
    return app;
}

/**
 * B's app: full stub for req.user, including a unique directories.root
 * that isolates B's `.sync/state.json` from A's. This is what supertest
 * drives directly — the "browser → own server" leg of pairing/sync.
 */
function buildAppB(bRoot) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle: HANDLE, admin: false, enabled: true, name: HANDLE, created: 0, password: '', salt: '' },
            directories: { ...getUserDirectories(HANDLE), root: bRoot },
        };
        next();
    });
    app.use('/api/sync/v1', syncRouter);
    return app;
}

function startListener(app) {
    return new Promise(resolve => {
        const server = http.createServer(app).listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                server,
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

async function seedUser(handle, password) {
    const salt = getPasswordSalt();
    await storage.setItem(toKey(handle), {
        handle,
        name: handle,
        created: Date.now(),
        password: getPasswordHash(password, salt),
        salt,
        enabled: true,
        admin: false,
    });
    const dirs = getUserDirectories(handle);
    fs.mkdirSync(dirs.root, { recursive: true });
    return dirs;
}

describe('persisted peer credentials — routes', () => {
    let aListener;
    let bRoot;
    let bApp;

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
        await storage.clear();
        await seedUser(HANDLE, PASSWORD);
        // B gets its own isolated root so B's recorded peer state can't
        // be confused with A's (which lives at getUserDirectories(HANDLE).root).
        bRoot = fs.mkdtempSync(path.join(TEST_DATA_ROOT, 'b-root-'));
        bApp = buildAppB(bRoot);
        aListener = await startListener(buildAppA());
    });

    afterEach(async () => {
        if (aListener) await aListener.close();
        aListener = null;
    });

    afterAll(async () => {
        await storage.clear();
        fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
        globalThis.DATA_ROOT = PREV_DATA_ROOT;
    });

    /**
     * Drive the pair flow. We skip A's `/pair/start` (its UI-only auth
     * gate would 401 a basic-auth request because the browser-only
     * routes don't run the basic-auth shim) and instead hand B a fixed
     * remotePeerId — `alice@deadbeef`. The peerId format only has to
     * match the handle prefix; A's `/session/offer` consumes whatever
     * id the caller sends and minds its per-peer shadow accordingly.
     * The same shortcut is used in `handle-mismatch.test.js`.
     */
    async function pairAandB({ peerAuth }) {
        const remotePeerId = `${HANDLE}@deadbeef`;
        const acceptRes = await request(bApp)
            .post('/api/sync/v1/pair/accept')
            .send({
                peerBaseUrl: aListener.baseUrl,
                remotePeerId,
                label: 'A',
                categories: ['characters'],
                peerAuth,
            });
        expect(acceptRes.status).toBe(200);
        return remotePeerId;
    }

    test('GET /peers does not include the password before pairing', async () => {
        // Empty registry — proves the route's projection is safe even
        // with no peers. Defends against the trivial regression of
        // forgetting to apply the projection to the empty-map case.
        const res = await request(bApp).get('/api/sync/v1/peers');
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    });

    test('GET /peers does not leak the password after pairing with credentials', async () => {
        const peerId = await pairAandB({ peerAuth: { username: HANDLE, password: PASSWORD } });

        const res = await request(bApp).get('/api/sync/v1/peers');
        expect(res.status).toBe(200);
        const peer = res.body.peers[peerId];
        expect(peer).toBeTruthy();
        // No leakage of the credential blob nor of the password value
        // in any shape, anywhere in the response.
        expect(peer.peerAuth).toBeUndefined();
        expect(peer.password).toBeUndefined();
        expect(peer.hasStoredCredentials).toBe(true);
        expect(JSON.stringify(res.body)).not.toMatch(PASSWORD);
        expect(JSON.stringify(res.body)).not.toMatch(/"password"\s*:/);
    });

    test('GET /peers reports hasStoredCredentials:false when pair was credential-less', async () => {
        // Pair without auth — A is in multi-user mode so the offer call
        // would 401 without credentials. Skip the pair flow and seed B's
        // registry directly to assert the projection on entries that
        // never had peerAuth.
        const { recordPeer } = await import('../../../src/sync/state.js');
        await recordPeer({
            userRoot: bRoot,
            peerId: `${HANDLE}@deadbeef`,
            label: 'A',
            categories: ['characters'],
            peerBaseUrl: aListener.baseUrl,
        });

        const res = await request(bApp).get('/api/sync/v1/peers');
        expect(res.status).toBe(200);
        const peer = res.body.peers[`${HANDLE}@deadbeef`];
        expect(peer.hasStoredCredentials).toBe(false);
        expect(peer.peerAuth).toBeUndefined();
    });

    test('DELETE /peers/:peerId/auth clears stored credentials', async () => {
        const peerId = await pairAandB({ peerAuth: { username: HANDLE, password: PASSWORD } });

        // Sanity: state.json on B has the peerAuth blob (this is what we're
        // about to drop). We poke disk directly so the test fails loudly
        // if the recordPeer storage contract regresses to "store under a
        // different key".
        const stateBefore = JSON.parse(fs.readFileSync(path.join(bRoot, '.sync', 'state.json'), 'utf8'));
        expect(stateBefore.peers[peerId].peerAuth).toEqual({ username: HANDLE, password: PASSWORD });

        const del = await request(bApp).delete(`/api/sync/v1/peers/${encodeURIComponent(peerId)}/auth`);
        expect(del.status).toBe(200);
        expect(del.body).toEqual({ ok: true });

        // After delete: the field is gone on disk, and the projected
        // GET /peers flag flips to false so the UI hides the button.
        const stateAfter = JSON.parse(fs.readFileSync(path.join(bRoot, '.sync', 'state.json'), 'utf8'));
        expect(stateAfter.peers[peerId].peerAuth).toBeUndefined();
        // Other fields untouched.
        expect(stateAfter.peers[peerId].label).toBe('A');
        expect(stateAfter.peers[peerId].peerBaseUrl).toBe(aListener.baseUrl);

        const peers = await request(bApp).get('/api/sync/v1/peers');
        expect(peers.body.peers[peerId].hasStoredCredentials).toBe(false);
    });

    test('DELETE /peers/:peerId/auth is idempotent on absent peer', async () => {
        const del = await request(bApp).delete('/api/sync/v1/peers/never-paired/auth');
        expect(del.status).toBe(200);
        expect(del.body).toEqual({ ok: true });
    });

    test('DELETE /peers/:peerId/auth rejects unsafe peerId', async () => {
        const del = await request(bApp).delete('/api/sync/v1/peers/..%2Fescape/auth');
        expect(del.status).toBe(400);
    });

    test('POST /peers/:peerId/sync uses stored peerAuth when caller omits it', async () => {
        // Pair so B's registry has peerAuth for A. Then close A's real
        // listener and stand up a fake peer that asserts the inbound
        // Authorization header. We point B's registry at the fake.
        const peerId = await pairAandB({ peerAuth: { username: HANDLE, password: PASSWORD } });
        await aListener.close();
        aListener = null;

        // Fake peer: receives /session/offer, asserts the header, and
        // returns a deterministic failure. We don't need to drive the
        // full /pull flow — proving the Authorization header reached the
        // peer is the load-bearing observation.
        let observedAuth = null;
        const fake = express();
        fake.use(express.json());
        fake.post('/api/sync/v1/session/offer', (req, res) => {
            observedAuth = req.header('authorization');
            // 401 surfaces back to the caller as a 401 stage:'offer'.
            // The test cares only about the captured header.
            res.status(401).json({ error: 'fake-offer-rejection' });
        });
        const fakeListener = await startListener(fake);

        try {
            // Rewrite peerBaseUrl on B's stored entry so /peers/:peerId/sync
            // dials the fake. We can't keep the real listener alive — the
            // pair already burned a session — so we surgically swap the URL
            // in state.json. clearPeerAuth + re-pair would be the alternate
            // path but it's longer and proves the same thing.
            const statePath = path.join(bRoot, '.sync', 'state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state.peers[peerId].peerBaseUrl = fakeListener.baseUrl;
            fs.writeFileSync(statePath, JSON.stringify(state));

            const syncRes = await request(bApp)
                .post(`/api/sync/v1/peers/${encodeURIComponent(peerId)}/sync`)
                .send({});  // no peerAuth in body — must fall back to stored
            // We get a 401 stage:'offer' back from the fake peer; that's
            // fine. The proof is the observed header.
            expect(syncRes.status).toBe(401);
            expect(syncRes.body.stage).toBe('offer');
            expect(observedAuth).toBe(basicHeader(HANDLE, PASSWORD));
        } finally {
            await fakeListener.close();
        }
    });

    test('POST /peers/:peerId/sync sends no Authorization when no credentials stored', async () => {
        // Seed a credential-less peer on B and point it at a fake that
        // captures the header. Should see no Authorization on the wire.
        const { recordPeer } = await import('../../../src/sync/state.js');
        await aListener.close();
        aListener = null;

        let observedAuth = 'sentinel';
        const fake = express();
        fake.use(express.json());
        fake.post('/api/sync/v1/session/offer', (req, res) => {
            observedAuth = req.header('authorization') ?? null;
            res.status(401).json({ error: 'fake-offer-rejection' });
        });
        const fakeListener = await startListener(fake);
        const peerId = `${HANDLE}@deadbeef`;
        try {
            await recordPeer({
                userRoot: bRoot,
                peerId,
                label: 'A',
                categories: ['characters'],
                peerBaseUrl: fakeListener.baseUrl,
            });

            const syncRes = await request(bApp)
                .post(`/api/sync/v1/peers/${encodeURIComponent(peerId)}/sync`)
                .send({});
            expect(syncRes.status).toBe(401);
            // Either undefined (express returns undefined for missing
            // headers) or null (our fallback). Anything else means a
            // stale credential leaked from somewhere else.
            expect(observedAuth).toBeNull();
        } finally {
            await fakeListener.close();
        }
    });

    test('POST /peers/:peerId/sync prefers body peerAuth over stored', async () => {
        // Pair stored 'alice/hunter2'; call sync-now with a different
        // body credential and prove the body wins (one-shot override).
        const peerId = await pairAandB({ peerAuth: { username: HANDLE, password: PASSWORD } });
        await aListener.close();
        aListener = null;

        let observedAuth = null;
        const fake = express();
        fake.use(express.json());
        fake.post('/api/sync/v1/session/offer', (req, res) => {
            observedAuth = req.header('authorization');
            res.status(401).json({ error: 'fake-offer-rejection' });
        });
        const fakeListener = await startListener(fake);
        try {
            const statePath = path.join(bRoot, '.sync', 'state.json');
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            state.peers[peerId].peerBaseUrl = fakeListener.baseUrl;
            fs.writeFileSync(statePath, JSON.stringify(state));

            await request(bApp)
                .post(`/api/sync/v1/peers/${encodeURIComponent(peerId)}/sync`)
                .send({ peerAuth: { username: 'override-user', password: 'override-pw' } });
            expect(observedAuth).toBe(basicHeader('override-user', 'override-pw'));
        } finally {
            await fakeListener.close();
        }
    });
});
