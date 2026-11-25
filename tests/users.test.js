import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import http from 'node:http';
import { ensureRun, trackScope } from './harness/jest-run.js';
import { currentScopeForResources } from './harness/storage-scope.js';

import cookieSession from 'cookie-session';
import express from 'express';
import storage from 'node-persist';

import {
    getCookieSecret,
    getCookieSessionName,
    getPasswordHash,
    getPasswordSalt,
    initUserStorage,
    resolveUserFromBasicAuth,
    toKey,
} from '../src/users.js';

let testDataRoot;
const PREV_DATA_ROOT = globalThis.DATA_ROOT;

async function seedUser({ handle, password, enabled = true, admin = false }) {
    const salt = getPasswordSalt();
    const record = {
        handle,
        name: handle,
        created: Date.now(),
        password: password ? getPasswordHash(password, salt) : '',
        salt,
        enabled,
        admin,
    };
    await storage.setItem(toKey(handle), record);
    return record;
}

function basicHeader(username, password) {
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return `Basic ${token}`;
}

function requestWith(headers = {}, session) {
    const req = { headers };
    if (session !== undefined) req.session = session;
    return req;
}

describe('resolveUserFromBasicAuth', () => {
    beforeAll(async () => {
        const run = await ensureRun();
        const scope = trackScope(await run.scope({ kind: 'scenario', label: 'users-basic-auth' }));
        testDataRoot = (await scope.directory('luker-users-test')).path;
        globalThis.DATA_ROOT = testDataRoot;
        await initUserStorage(testDataRoot);
    });

    beforeEach(async () => {
        // Wipe between tests so getAllUserHandles() reflects only the
        // fixtures the current test seeded.
        await storage.clear();
    });

    afterAll(async () => {
        await storage.clear();
        globalThis.DATA_ROOT = PREV_DATA_ROOT;
    });

    test('returns null when no Authorization header is present', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const result = await resolveUserFromBasicAuth(requestWith({}, {}));
        expect(result).toBeNull();
    });

    test('returns null when the scheme is not Basic', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: 'Bearer some-token',
        }, {}));
        expect(result).toBeNull();
    });

    test('returns null for a handle that does not exist', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: basicHeader('nobody', 'hunter2'),
        }, {}));
        expect(result).toBeNull();
    });

    test('returns null for a known handle with the wrong password', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: basicHeader('alice', 'wrong-password'),
        }, {}));
        expect(result).toBeNull();
    });

    test('returns null for a disabled user even with the correct password', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2', enabled: false });
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: basicHeader('alice', 'hunter2'),
        }, {}));
        expect(result).toBeNull();
    });

    test('returns {profile, directories} on a successful credential match', async () => {
        const seeded = await seedUser({ handle: 'alice', password: 'hunter2' });
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: basicHeader('alice', 'hunter2'),
        }, {}));

        expect(result).not.toBeNull();
        expect(result.profile.handle).toBe('alice');
        expect(result.profile.password).toBe(seeded.password);
        expect(typeof result.directories.root).toBe('string');
        expect(result.directories.root.startsWith(testDataRoot)).toBe(true);
    });

    test('does not mutate request.session on success', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const session = { handle: 'preset-handle', version: 'preset-version' };
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: basicHeader('alice', 'hunter2'),
        }, session));

        expect(result).not.toBeNull();
        expect(session.handle).toBe('preset-handle');
        expect(session.version).toBe('preset-version');
    });

    test('does not throw when request.session is undefined', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const req = { headers: { authorization: basicHeader('alice', 'hunter2') } };
        // No `session` property at all — mirrors a route without session middleware.
        const result = await resolveUserFromBasicAuth(req);
        expect(result).not.toBeNull();
        expect(result.profile.handle).toBe('alice');
    });

    test('returns null for malformed credentials (no colon after decoding)', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        // A base64 payload that has no ':' separator decodes to "aliceonly".
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: 'Basic ' + Buffer.from('aliceonly', 'utf8').toString('base64'),
        }, {}));
        expect(result).toBeNull();
    });

    test('returns null for an empty credentials segment', async () => {
        await seedUser({ handle: 'alice', password: 'hunter2' });
        const result = await resolveUserFromBasicAuth(requestWith({
            authorization: 'Basic',
        }, {}));
        expect(result).toBeNull();
    });
});

describe('getCookieSessionName', () => {
    async function withSessionServer(dataRoot, fn) {
        const secret = getCookieSecret(dataRoot);
        const cookieName = getCookieSessionName(secret);
        const app = express();
        app.use(cookieSession({
            name: cookieName,
            sameSite: 'lax',
            httpOnly: true,
            secret,
        }));
        app.post('/login', (req, res) => {
            req.session.handle = 'alice';
            res.json({ ok: true });
        });
        app.get('/whoami', (req, res) => {
            res.json({ handle: req.session?.handle ?? null });
        });

        const server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        try {
            return await fn({ baseUrl: `http://127.0.0.1:${port}`, cookieName, secret });
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    }

    test('derives a deterministic session-<8hex> cookie name without exposing the secret', () => {
        const secret = 'test-secret-value-for-deterministic-derivation';
        const first = getCookieSessionName(secret);
        const second = getCookieSessionName(secret);

        expect(first).toMatch(/^session-[0-9a-f]{8}$/);
        expect(second).toBe(first);
        expect(first).not.toContain(secret);
    });

    test('produces distinct cookie names for distinct secrets', () => {
        expect(getCookieSessionName('secret-alpha')).not.toBe(getCookieSessionName('secret-beta'));
    });

    test('throws when called without a non-empty string secret', () => {
        expect(() => getCookieSessionName('')).toThrow();
        expect(() => getCookieSessionName(/** @type {any} */ (undefined))).toThrow();
        expect(() => getCookieSessionName(/** @type {any} */ (null))).toThrow();
    });

    test('keeps sessions valid across restarts sharing a data root while isolating other data roots', async () => {
        const dataRootA = (await currentScopeForResources().directory('luker-session-a')).path;
        const dataRootB = (await currentScopeForResources().directory('luker-session-b')).path;

        let cookieHeader = '';
        let nameA = '';

        await withSessionServer(dataRootA, async ({ baseUrl, cookieName }) => {
            nameA = cookieName;
            const loginRes = await fetch(`${baseUrl}/login`, { method: 'POST' });
            expect(loginRes.status).toBe(200);
            const setCookies = loginRes.headers.getSetCookie();
            expect(setCookies.some(c => c.startsWith(`${cookieName}=`))).toBe(true);
            cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
        });

        // A fresh server instance using the same persisted dataRoot recognizes the cookie.
        await withSessionServer(dataRootA, async ({ baseUrl, cookieName }) => {
            expect(cookieName).toBe(nameA);
            const whoamiRes = await fetch(`${baseUrl}/whoami`, {
                headers: { Cookie: cookieHeader },
            });
            expect(whoamiRes.status).toBe(200);
            expect(await whoamiRes.json()).toEqual({ handle: 'alice' });
        });

        // A separate dataRoot derives its own cookie name and does not accept dataRootA's cookie.
        await withSessionServer(dataRootB, async ({ baseUrl, cookieName }) => {
            expect(cookieName).not.toBe(nameA);
            const whoamiRes = await fetch(`${baseUrl}/whoami`, {
                headers: { Cookie: cookieHeader },
            });
            expect(whoamiRes.status).toBe(200);
            expect(await whoamiRes.json()).toEqual({ handle: null });
        });
    });
});
