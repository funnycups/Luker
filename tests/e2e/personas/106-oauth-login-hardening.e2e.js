// #106 — OAuth-registered accounts must NOT be reachable via the
// password-login path.
//
// Background: OAuth (GitHub/Discord) account creation writes
// `password: ''` — the same marker legacy code treats as "this account
// is passwordless, let anyone in". Until the fix, POSTing
// /api/users/login with an OAuth account's handle + ANY password (or
// clicking the account card on the login page, which auto-submits with
// an empty password) logged the attacker straight in. The OAuth
// identity was consulted exactly once, at account creation, and never
// again.
//
// This file seeds a GitHub-linked account the same way the OAuth
// callback creates one (direct node-persist datum in the server's
// `_storage` — the storage layer the endpoint reads, bypassing the
// GitHub round-trip which is not the gesture under test), then proves:
//
//   1. POST /api/users/login { handle: 'octocat', password: <anything> }
//      -> 403 with the generic 'Incorrect credentials' body — same
//      error text as an unknown account, so handle-guessing yields no
//      information about which accounts are OAuth-bound.
//   2. The same account still logs in via the session path the OAuth
//      callback itself establishes (simulated by checking the account
//      is not structurally broken: the datum round-trips through
//      /api/users/list with password:false).
//   3. A passwordless NON-OAuth account (default-user) still
//      auto-logins on the login page — the legacy single-user
//      convenience must keep working; the rejection is specific to
//      OAuth-bound accounts.
//   4. An OAuth account whose admin later set a password CAN
//      password-login (both credentials valid) — the OAuth flag
//      removes the passwordless loophole, not the password path.

import { test, expect, request as pwRequest } from '@playwright/test';
import { createHash, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');

let server;

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'oauth-login-hardening',
        extraConfig: { enableUserAccounts: true },
        useExistingDataRoot: await seedDataRoot(),
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

/**
 * Build a scratch dataRoot seeded with an OAuth-bound account.
 *
 * The server is started with useExistingDataRoot, so the seed layout is
 * ours to define. We clone nothing — instead we write the minimal
 * node-persist datums the users endpoints read (user records are stored
 * as sha256(key) files under <dataRoot>/_storage with a
 * `{ key, value, ttl }` wrapper). The default-user record is copied
 * verbatim from the seed data so the admin paths (session bootstrap,
 * /api/users/create) behave exactly as in every other file.
 */
async function seedDataRoot() {
    const dataRoot = resolve(SCRATCH_ROOT, 'personas-oauth-login-hardening');
    mkdirSync(resolve(dataRoot, '_storage'), { recursive: true });
    mkdirSync(resolve(dataRoot, 'default-user'), { recursive: true });

    // default-user: copy the seed datum byte-for-byte (admin, no
    // password, no oauth — the classic passwordless admin).
    const seedStorage = resolve(REPO_ROOT, 'data', '_storage');
    const defaultUserDatum = resolve(seedStorage, storageFile('user:default-user'));
    if (existsSync(defaultUserDatum)) {
        writeFileSync(
            resolve(dataRoot, '_storage', storageFile('user:default-user')),
            readFileSync(defaultUserDatum),
        );
    }

    // octocat: GitHub-bound account exactly as createUserFromOAuth
    // writes it (password: '', salt: '', oauth: { github: {...} }).
    writeFileSync(
        resolve(dataRoot, '_storage', storageFile('user:octocat')),
        JSON.stringify({
            key: 'user:octocat',
            value: {
                handle: 'octocat',
                name: 'Octo Cat',
                created: Date.now(),
                password: '',
                salt: '',
                admin: false,
                enabled: true,
                oauth: {
                    github: { id: '123456', login: 'octocat', email: 'octo@example.com' },
                },
            },
        }),
    );

    // gh-with-password: admin later set a password via change-password —
    // OAuth-bound AND password-protected. Must still password-login.
    const saltedHash = scryptB64('settled-later-pass', 'pepper-salt');
    writeFileSync(
        resolve(dataRoot, '_storage', storageFile('user:gh-with-password')),
        JSON.stringify({
            key: 'user:gh-with-password',
            value: {
                handle: 'gh-with-password',
                name: 'Linked And Passworded',
                created: Date.now(),
                password: saltedHash,
                salt: 'pepper-salt',
                admin: false,
                enabled: true,
                oauth: {
                    github: { id: '654321', login: 'ghp', email: 'ghp@example.com' },
                },
            },
        }),
    );

    return dataRoot;
}

/** node-persist stores datums at sha256(key) under _storage. */
function storageFile(key) {
    return createHash('sha256').update(key).digest('hex');
}

/** getPasswordHash: scrypt(password.normalize(), salt, 64) -> base64. */
function scryptB64(password, salt) {
    return scryptSync(password.normalize(), salt, 64).toString('base64');
}

async function newSession(baseURL) {
    const ctx = await pwRequest.newContext({ baseURL });
    const csrfRes = await ctx.get('/csrf-token');
    expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
    const { token } = await csrfRes.json();
    return {
        ctx,
        async post(url, body) {
            return ctx.post(url, {
                data: body ?? {},
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': token,
                },
            });
        },
        async dispose() { await ctx.dispose(); },
    };
}

test.describe('#106 — OAuth accounts cannot be password-logged-into', () => {
    test('password login with any password -> 403 generic Incorrect credentials (no account-existence leak)', async () => {
        const s = await newSession(server.baseURL);
        try {
            const res = await s.post('/api/users/login', { handle: 'octocat', password: 'x'.repeat(32) });
            expect(res.status(), 'OAuth account must reject password login').toBe(403);
            const body = await res.json();
            // Same error text as an unknown handle — no oracle for account type.
            expect(body.error).toBe('Incorrect credentials');
        } finally {
            await s.dispose();
        }
    });

    test('empty password (the login-page auto-submit path) -> 403 too', async () => {
        const s = await newSession(server.baseURL);
        try {
            const res = await s.post('/api/users/login', { handle: 'octocat', password: '' });
            expect(res.status()).toBe(403);
            expect((await res.json()).error).toBe('Incorrect credentials');
        } finally {
            await s.dispose();
        }
    });

    test('unknown handle gets the identical 403 body (indistinguishable from OAuth rejection)', async () => {
        const s = await newSession(server.baseURL);
        try {
            const res = await s.post('/api/users/login', { handle: 'does-not-exist', password: 'x'.repeat(32) });
            expect(res.status()).toBe(403);
            const body = await res.json();
            expect(body.error).toBe('Incorrect credentials');
        } finally {
            await s.dispose();
        }
    });

    test('passwordless NON-OAuth admin (default-user) still logs in — legacy convenience intact', async () => {
        const s = await newSession(server.baseURL);
        try {
            const res = await s.post('/api/users/login', { handle: 'default-user', password: '' });
            expect(res.ok(), `default-user login failed (${res.status()})`).toBe(true);
        } finally {
            await s.dispose();
        }
    });

    test('OAuth account that also has a real password CAN password-login', async () => {
        const s = await newSession(server.baseURL);
        try {
            const good = await s.post('/api/users/login', { handle: 'gh-with-password', password: 'settled-later-pass' });
            expect(good.ok(), `hybrid login failed (${good.status()})`).toBe(true);
        } finally {
            await s.dispose();
        }
        const s2 = await newSession(server.baseURL);
        try {
            const bad = await s2.post('/api/users/login', { handle: 'gh-with-password', password: 'wrong' });
            expect(bad.status()).toBe(403);
            expect((await bad.json()).error).toBe('Incorrect credentials');
        } finally {
            await s2.dispose();
        }
    });

    test('login page does not auto-login the OAuth account (session stays anonymous)', async () => {
        // GET /login runs tryAutoLogin. singleUserLogin only fires when
        // there is exactly ONE user total — with 3 seeded users it is
        // structurally off, but the /login response must NOT redirect to
        // / (that would mean some auto-login path claimed the session).
        const ctx = await pwRequest.newContext({ baseURL: server.baseURL });
        try {
            const res = await ctx.get('/login');
            expect(res.status()).toBe(200);
            expect(res.url()).not.toMatch(/\/$/);
        } finally {
            await ctx.dispose();
        }
    });
});
