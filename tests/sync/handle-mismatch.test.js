/**
 * Server-side handle-mismatch gate for LAN Sync (spec §3.4).
 *
 * `/session/offer` and `/pair/accept` MUST reject any peerId whose
 * sanitized prefix differs from the local user's sanitized handle.
 * Without this gate, Alice's device could pair with Bob's device and
 * silently overwrite one user's data with the other's on the next sync.
 *
 * The frontend (`public/scripts/lan-sync.js`) duplicates the check
 * pre-flight, but that's UX polish — anyone who hits the route via
 * console / curl / direct fetch must still be blocked, so the gate
 * lives here too as the backstop.
 *
 * `sanitizeHandleForPeerId` is exported from the same module and
 * covered alongside the route tests: it's load-bearing for the
 * comparison and the frontend duplicates its regex literally, so a
 * change in either place should fail loudly here.
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
let sanitizeHandleForPeerId;
let initStorage;
let getPasswordHash;
let getPasswordSalt;
let initUserStorage;
let toKey;
let getUserDirectories;

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-handle-mismatch-'));
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
    // No req.user stub — the basic-auth shim must populate it. Mirrors
    // the multi-user offer test's harness so the same routes that work
    // for cross-server fetch also exercise the handle gate.
    app.use('/api/sync/v1', syncRouter);
    return app;
}

/**
 * Variant of buildApp for `/pair/accept`, which is browser→own-server
 * only and so does NOT carry the basic-auth shim. In production
 * `setUserDataMiddleware` populates `req.user` from the session cookie;
 * we stub that for the local handle so we can drive the route directly.
 *
 * @param {string} handle
 */
function buildAppWithUser(handle) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            profile: { handle, admin: false, enabled: true, name: handle, created: 0, password: '', salt: '' },
            directories: getUserDirectories(handle),
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

describe('handle-mismatch gate', () => {
    beforeAll(async () => {
        globalThis.DATA_ROOT = TEST_DATA_ROOT;
        const usersMod = await import('../../src/users.js');
        const storageMod = await import('../../src/storage/index.js');
        ({ getPasswordHash, getPasswordSalt, initUserStorage, toKey, getUserDirectories } = usersMod);
        ({ initStorage } = storageMod);
        await initUserStorage(TEST_DATA_ROOT);
        initStorage({
            mode: 'fs',
            directoriesByHandle: (h) => getUserDirectories(h),
        });
        ({ router: syncRouter, sanitizeHandleForPeerId } = await import('../../src/endpoints/sync.js'));
    });

    beforeEach(async () => {
        await storage.clear();
        await seedUser(HANDLE, PASSWORD);
    });

    afterAll(async () => {
        await storage.clear();
        fs.rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
        globalThis.DATA_ROOT = PREV_DATA_ROOT;
    });

    describe('sanitizeHandleForPeerId', () => {
        test('passes through valid alphanumerics, dots, dashes, underscores', () => {
            expect(sanitizeHandleForPeerId('alice')).toBe('alice');
            expect(sanitizeHandleForPeerId('Alice42')).toBe('Alice42');
            expect(sanitizeHandleForPeerId('a.b-c_d')).toBe('a.b-c_d');
            expect(sanitizeHandleForPeerId('a.b.c.d')).toBe('a.b.c.d');
            expect(sanitizeHandleForPeerId('123')).toBe('123');
        });

        test('replaces unsafe characters with underscore', () => {
            expect(sanitizeHandleForPeerId('Alice/Foo')).toBe('Alice_Foo');
            expect(sanitizeHandleForPeerId('a b c')).toBe('a_b_c');
            expect(sanitizeHandleForPeerId('a@b')).toBe('a_b');
            expect(sanitizeHandleForPeerId('a#b$c%d')).toBe('a_b_c_d');
            expect(sanitizeHandleForPeerId("alice's")).toBe('alice_s');
        });

        test('falls back to "peer" on empty or nullish input', () => {
            expect(sanitizeHandleForPeerId('')).toBe('peer');
            expect(sanitizeHandleForPeerId(null)).toBe('peer');
            expect(sanitizeHandleForPeerId(undefined)).toBe('peer');
        });

        test('coerces non-strings via String() first', () => {
            // The helper accepts arbitrary input because the call sites
            // (server fetch body, frontend prefill) may hand it anything;
            // it must never throw. Falsy values (0, false, '') route
            // through the `|| 'peer'` fallback.
            expect(sanitizeHandleForPeerId(42)).toBe('42');
            expect(sanitizeHandleForPeerId(0)).toBe('peer');
            expect(sanitizeHandleForPeerId(false)).toBe('peer');
        });

        test('leaves leading/trailing dots intact', () => {
            // Dots are in the safe set — peerId path safety is enforced
            // separately by `assertSafePeerId`, which rejects standalone
            // `.` and `..` segments. The handle sanitizer is just about
            // the prefix half.
            expect(sanitizeHandleForPeerId('.alice')).toBe('.alice');
            expect(sanitizeHandleForPeerId('alice.')).toBe('alice.');
        });
    });

    describe('POST /session/offer', () => {
        test('200 when peerId prefix matches the basic-auth user', async () => {
            const app = buildApp();
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('Authorization', basicHeader(HANDLE, PASSWORD))
                .send({ peerId: `${HANDLE}@deadbeef`, label: 'Phone', categories: [] });
            expect(r.status).toBe(200);
            expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        });

        test('412 HANDLE_MISMATCH when peerId prefix differs', async () => {
            const app = buildApp();
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('Authorization', basicHeader(HANDLE, PASSWORD))
                .send({ peerId: 'bob@deadbeef', label: 'Phone', categories: [] });
            expect(r.status).toBe(412);
            expect(r.body).toEqual({
                error: 'Handle mismatch',
                code: 'HANDLE_MISMATCH',
                expectedHandle: 'alice',
                gotHandle: 'bob',
            });
        });

        test('412 when peerId is missing an @ suffix entirely', async () => {
            // `peerId.split('@')[0]` returns the whole string when there
            // is no `@`. A peerId without a suffix still has to match
            // the local handle prefix — anything else is a bug or an
            // attacker probing the route.
            const app = buildApp();
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('Authorization', basicHeader(HANDLE, PASSWORD))
                .send({ peerId: 'mallory', label: 'X', categories: [] });
            expect(r.status).toBe(412);
            expect(r.body.code).toBe('HANDLE_MISMATCH');
            expect(r.body.gotHandle).toBe('mallory');
        });

        test('uses the SANITIZED form on both sides of the comparison', async () => {
            // Seed a handle containing a character the sanitizer rewrites
            // ("/" becomes "_"). The mint side produced "alice_foo@..." in
            // the peerId; the gate must compare against the same
            // sanitized form, not the raw handle, or the legitimate peer
            // would be rejected as a mismatch.
            //
            // Note: users.js validates handles on REGISTRATION but we
            // seed node-persist directly here, so we can hand the gate
            // a profile.handle that the sanitizer actually has work to
            // do on. That is the contract we care about: server-side
            // gate uses the sanitized form.
            const handle = 'Alice/Foo';
            const password = 'pw';
            await seedUser(handle, password);

            const app = buildApp();
            const r = await request(app)
                .post('/api/sync/v1/session/offer')
                .set('Authorization', basicHeader(handle, password))
                .send({ peerId: 'Alice_Foo@deadbeef', label: 'X', categories: [] });
            expect(r.status).toBe(200);
            expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    describe('POST /pair/accept', () => {
        // Stand up a second app representing the OTHER device so the
        // mismatch test can prove the gate fires WITHOUT reaching it.
        // The peer's handle and password don't matter — the gate
        // short-circuits before any outbound auth happens.
        let peerListener;

        beforeEach(async () => {
            peerListener = await startListener(buildApp());
        });

        afterEach(async () => {
            if (peerListener) await peerListener.close();
        });

        test('past local gate when remotePeerId prefix matches the local accepting user', async () => {
            // Same-handle pairing: alice's local device accepts a link
            // whose peerId encodes "alice". The spec accepts this by
            // design — the user verifies cross-server identity out of
            // band. The load-bearing assertion here is that the LOCAL
            // gate did NOT fire (we're driving against an unreachable
            // peer so the call must surface 502 stage:'offer'; a 412
            // would mean the local gate fired before the fetch).
            const aliceMintedPeerId = `${HANDLE}@deadbeef`;
            const app = buildAppWithUser(HANDLE);
            const accept = await request(app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: 'http://127.0.0.1:1',
                    remotePeerId: aliceMintedPeerId,
                    label: 'Other Alice',
                    categories: ['characters'],
                });
            expect(accept.status).toBe(502);
            expect(accept.body.stage).toBe('offer');
        });

        test('412 HANDLE_MISMATCH when remotePeerId prefix differs from local handle', async () => {
            const app = buildAppWithUser(HANDLE);
            const accept = await request(app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: peerListener.baseUrl,
                    remotePeerId: 'bob@deadbeef',
                    label: 'Bob',
                    categories: ['characters'],
                });
            expect(accept.status).toBe(412);
            expect(accept.body).toEqual({
                error: 'Handle mismatch',
                code: 'HANDLE_MISMATCH',
                expectedHandle: 'alice',
                gotHandle: 'bob',
            });
        });

        test('412 fires BEFORE the outbound fetch (no peer network call)', async () => {
            // Close the peer listener: if the gate didn't fire first,
            // /pair/accept's outbound fetch would 502 (peer unreachable)
            // and we'd see stage:'offer'. A clean 412 with no stage
            // proves the gate short-circuited.
            await peerListener.close();
            peerListener = null;

            const app = buildAppWithUser(HANDLE);
            const accept = await request(app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: 'http://127.0.0.1:1',
                    remotePeerId: 'bob@deadbeef',
                    label: 'Bob',
                    categories: ['characters'],
                });
            expect(accept.status).toBe(412);
            expect(accept.body.code).toBe('HANDLE_MISMATCH');
            expect(accept.body.stage).toBeUndefined();
        });

        test('uses sanitized form for comparison', async () => {
            // Local user with "/" in handle accepts a link whose peerId
            // already encodes the sanitized prefix. Should pass the
            // local gate; we drive against an unreachable peer so the
            // call surfaces 502 stage:'offer' — proves the local gate
            // accepted the sanitized match.
            const handle = 'Alice/Foo';
            const password = 'pw';
            await seedUser(handle, password);

            const app = buildAppWithUser(handle);
            const accept = await request(app)
                .post('/api/sync/v1/pair/accept')
                .send({
                    peerBaseUrl: 'http://127.0.0.1:1',
                    remotePeerId: 'Alice_Foo@deadbeef',
                    label: 'Other',
                    categories: ['characters'],
                });
            expect(accept.status).toBe(502);
            expect(accept.body.stage).toBe('offer');
        });
    });
});
