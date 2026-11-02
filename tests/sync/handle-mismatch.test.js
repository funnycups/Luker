/**
 * Server-side handle-mismatch gate for LAN Sync.
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
 *
 * The route cases run on `startLanDevice`, whose user store supplies its
 * own user.
 */
process.env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import storage from 'node-persist';

let sanitizeHandleForPeerId;
let assertSafeBackendId;
let initStorage;
let getPasswordHash;
let getPasswordSalt;
let initUserStorage;
let toKey;
let getUserDirectories;
let startLanDevice;
let upsertLanBackend;

const TEST_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-handle-mismatch-'));
const PREV_DATA_ROOT = globalThis.DATA_ROOT;

const HANDLE = 'alice';
const PASSWORD = 'hunter2';

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
        await initStorage({
            mode: 'fs',
            directoriesByHandle: (h) => getUserDirectories(h),
        });
        ({ sanitizeHandleForPeerId } = await import('../../src/endpoints/sync.js'));
        ({ assertSafeBackendId, upsertLanBackend } = await import('../../src/sync/state.js'));
        ({ startLanDevice } = await import('./_lib/lan-devices.js'));
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
            expect(sanitizeHandleForPeerId('alice\'s')).toBe('alice_s');
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

        test('never produces a leading dot or a dot run', () => {
            expect(sanitizeHandleForPeerId('.alice')).toBe('_alice');
            expect(sanitizeHandleForPeerId('alice.')).toBe('alice.');
            expect(sanitizeHandleForPeerId('a..b')).toBe('a_.b');
            expect(sanitizeHandleForPeerId('...')).toBe('__.');
        });

        test('every generated peer id is a valid backend id', () => {
            for (const handle of ['.alice', 'alice.', 'a..b', '...', '.', 'alice.lock', 'a@{b', 'a b/c', '']) {
                expect(() => assertSafeBackendId(`${sanitizeHandleForPeerId(handle)}@0a1b2c3d`)).not.toThrow();
            }
        });
    });

    describe('POST /session/offer', () => {
        const SECRET = 'e'.repeat(64);
        let device;

        async function deviceWithBackend(handle, backendId) {
            device = await startLanDevice({ handle });
            await upsertLanBackend({ userRoot: device.userRoot, backendId, label: 'Phone', categories: [], syncSecret: SECRET });
            return device;
        }

        afterEach(async () => {
            if (device) await device.close();
            device = null;
        });

        test('200 when peerId prefix matches the local user', async () => {
            const d = await deviceWithBackend(HANDLE, `${HANDLE}@deadbeef`);
            const r = await d.offer({ peerId: `${HANDLE}@deadbeef`, label: 'Phone', protocol: 2 }, { secret: SECRET });
            expect(r.status).toBe(200);
            expect(r.body.token).toMatch(/^[a-f0-9]{64}$/);
        });

        test('412 HANDLE_MISMATCH when peerId prefix differs', async () => {
            const d = await deviceWithBackend(HANDLE, `${HANDLE}@deadbeef`);
            const r = await d.offer({ peerId: 'bob@deadbeef', label: 'Phone', protocol: 2 }, { secret: SECRET });
            expect(r.status).toBe(412);
            expect(r.body).toMatchObject({ code: 'HANDLE_MISMATCH', expectedHandle: 'alice', gotHandle: 'bob' });
        });

        test('412 when peerId is missing an @ suffix entirely', async () => {
            // `peerId.split('@')[0]` returns the whole string when there
            // is no `@`. A peerId without a suffix still has to match
            // the local handle prefix — anything else is a bug or an
            // attacker probing the route.
            const d = await deviceWithBackend(HANDLE, `${HANDLE}@deadbeef`);
            const r = await d.offer({ peerId: 'mallory', label: 'X', protocol: 2 }, { secret: SECRET });
            expect(r.status).toBe(412);
            expect(r.body.code).toBe('HANDLE_MISMATCH');
            expect(r.body.gotHandle).toBe('mallory');
        });

        test('uses the SANITIZED form on both sides of the comparison', async () => {
            // A handle containing a character the sanitizer rewrites
            // ("/" becomes "_"). The mint side produced "Alice_Foo@..." in
            // the peerId; the gate must compare against the same
            // sanitized form, not the raw handle, or the legitimate peer
            // would be rejected as a mismatch.
            const d = await deviceWithBackend('Alice/Foo', 'Alice_Foo@deadbeef');
            const ok = await d.offer({ peerId: 'Alice_Foo@deadbeef', label: 'X', protocol: 2 }, { secret: SECRET });
            expect(ok.status).toBe(200);
            expect(ok.body.token).toMatch(/^[a-f0-9]{64}$/);
            const raw = await d.offer({ peerId: 'Alice@deadbeef', label: 'X', protocol: 2 }, { secret: SECRET });
            expect(raw.status).toBe(412);
            expect(raw.body).toMatchObject({ code: 'HANDLE_MISMATCH', expectedHandle: 'Alice_Foo', gotHandle: 'Alice' });
        });
    });

    describe('POST /pair/accept', () => {
        let devices = [];
        const lanDevice = async options => {
            const device = await startLanDevice(options);
            devices.push(device);
            return device;
        };
        const accept = (device, peerBaseUrl, remotePeerId) => device.call('POST', '/pair/accept', {
            body: { peerBaseUrl, remotePeerId, label: 'Other', categories: ['characters'], pairCode: 'c'.repeat(64) },
        });

        afterEach(async () => {
            for (const device of devices) await device.close();
            devices = [];
        });

        test('past local gate when remotePeerId prefix matches the local accepting user', async () => {
            const local = await lanDevice({ handle: HANDLE });
            const res = await accept(local, 'http://127.0.0.1:1', `${HANDLE}@deadbeef`);
            expect(res.status).not.toBe(412);
            expect(res.body).toMatchObject({ stage: 'offer', code: 'PEER_UNREACHABLE' });
        });

        test('412 HANDLE_MISMATCH when remotePeerId prefix differs from local handle', async () => {
            const local = await lanDevice({ handle: HANDLE });
            const res = await accept(local, 'http://127.0.0.1:1', 'bob@deadbeef');
            expect(res).toEqual({ status: 412, body: { error: 'Handle mismatch', code: 'HANDLE_MISMATCH', expectedHandle: 'alice', gotHandle: 'bob' } });
        });

        test('412 fires BEFORE the outbound fetch (no peer network call)', async () => {
            const local = await lanDevice({ handle: HANDLE });
            const peer = await lanDevice({ handle: 'bob' });
            const res = await accept(local, peer.baseUrl, 'bob@deadbeef');
            expect(res.status).toBe(412);
            expect(res.body.stage).toBeUndefined();
            expect(peer.requests).toEqual([]);
        });

        test('uses sanitized form for comparison', async () => {
            const local = await lanDevice({ handle: 'Alice/Foo' });
            const res = await accept(local, 'http://127.0.0.1:1', 'Alice_Foo@deadbeef');
            expect(res.status).not.toBe(412);
            expect(res.body.stage).toBe('offer');
        });
    });
});
