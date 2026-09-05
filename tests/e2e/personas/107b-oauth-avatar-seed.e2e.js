// #107b — OAuth account creation seeds the provider profile picture.
//
// Background: GitHub /user returns avatar_url and Discord /users/@me
// returns an avatar hash, but createUserFromOAuth discarded both — the
// new account got no avatar:<handle> datum, so the login page rendered
// the default avatar for every OAuth user (and before #107a, a broken
// image).
//
// The GitHub round-trip is not the gesture under test; the avatar
// fetch + storage is. This file runs the real OAuth callback flow
// against a stubbed GitHub API:
//   1. GET /api/users/oauth/start/github issues a state and redirects
//      to github.com (real route, no outbound network yet).
//   2. GET /api/users/oauth/callback/github?code=...&state=... hits the
//      real callback, which exchanges the code + fetches the profile
//      against the stubbed api endpoints (in-process fetch
//      interception), creates the account, downloads the avatar from
//      the stubbed avatar_url, and stores it as a data URL.
//   3. /api/users/list then reports the user with the stored data URL
//      avatar — not the default.
//   4. A second callback login for the same GitHub id does NOT clobber
//      an avatar the user changed afterwards (avatar datum is only
//      written at account creation).
//
// Node's global fetch is patched in-process (undici MockAgent is
// avoided deliberately — patching fetch in the same process the server
// would need the mock to live in the server process, not the test).
// Instead we point the whole flow at a local stub server: the
// callback fetches github.com absolute URLs, so we patch
// globalThis.fetch inside the SERVER process via NODE_OPTIONS?
// Not possible for a spawned child. So instead: the stub runs as a
// plain HTTP server, and the server-side flow is exercised with real
// fetches against it via a hosts override... which also needs root.
//
// The pragmatic path: seed the avatar-datum effect through the real
// HTTP surface and stub the GitHub API with an in-process monkey
// patch via a preload module (--require) in the spawned server. The
// preload replaces globalThis.fetch for github.com/Discord CDN hosts
// only and passes everything else through.

import { test, expect, request as pwRequest } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.e2e-scratch');
const PRELOAD_PATH = resolve(SCRATCH_ROOT, 'oauth-stub-preload.mjs');

// 1x1 transparent PNG.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const STUB_PROFILE = {
    id: '987654',
    login: 'mona',
    name: 'Mona Lisa Octocat',
    email: 'mona@example.com',
    avatar_url: 'https://avatar.stubs.example/mona.png',
};

let stubServer;
let stubUrl;

test.beforeAll(async () => {
    // Local stub for avatar.stubs.example — the preload rewrites only
    // this host, so the GitHub token/profile round-trip must go through
    // the same rewrite (the real github.com is not reachable from CI).
    stubServer = createServer((req, res) => {
        if (req.url === '/login/oauth/access_token') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ access_token: 'stub-token' }));
            return;
        }
        if (req.url === '/api/user') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(STUB_PROFILE));
            return;
        }
        if (req.url === '/mona.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(Buffer.from(TINY_PNG_BASE64, 'base64'));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
    stubUrl = `http://127.0.0.1:${stubServer.address().port}`;

    writePreload();
    server = await startServer({
        batchKey: 'personas',
        scenarioId: 'oauth-avatar-seed',
        extraConfig: { enableUserAccounts: true },
        extraEnv: { NODE_OPTIONS: `--import "${PRELOAD_PATH}"` },
        useExistingDataRoot: await seedDataRoot(),
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await new Promise(r => stubServer.close(r));
});

let server;

/**
 * The preload module rewrites github.com / avatar.stubs.example URLs to
 * the local stub server inside the server process, leaving every other
 * fetch (including the avatar image download) untouched except for the
 * two stubbed hosts.
 */
function writePreload() {
    const preload = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    let url;
    try {
        url = new URL(typeof input === 'string' ? input : input.url);
    } catch {
        return realFetch(input, init);
    }
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
        return realFetch('${stubUrl}/login/oauth/access_token', init);
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/user') {
        return realFetch('${stubUrl}/api/user', init);
    }
    if (url.hostname === 'avatar.stubs.example') {
        return realFetch('${stubUrl}' + url.pathname, init);
    }
    return realFetch(input, init);
};
`;
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    writeFileSync(PRELOAD_PATH, preload);
}

/**
 * Scratch dataRoot: oauth enabled + allowAutoCreate, so the callback
 * creates the account on first login.
 */
async function seedDataRoot() {
    const dataRoot = resolve(SCRATCH_ROOT, 'personas-oauth-avatar-seed');
    mkdirSync(resolve(dataRoot, '_storage'), { recursive: true });

    const adminSettings = {
        storage: { defaultUserQuotaBytes: -1 },
        accountRegistration: { enabled: false },
        oauth: {
            github: { enabled: true, clientId: 'cid', clientSecret: 'csecret', allowAutoCreate: true },
            discord: { enabled: false, clientId: '', clientSecret: '', allowAutoCreate: false, requireGuildMembership: false },
        },
    };
    writeFileSync(resolve(dataRoot, '_storage', storageFile('luker:admin-settings:v1')), JSON.stringify({ key: 'luker:admin-settings:v1', value: adminSettings }));

    return dataRoot;
}

/** node-persist stores datums at sha256(key) under _storage. */
function storageFile(key) {
    return createHash('sha256').update(key).digest('hex');
}

async function newSession() {
    const ctx = await pwRequest.newContext({ baseURL: server.baseURL });
    const csrfRes = await ctx.get('/csrf-token');
    expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
    const { token } = await csrfRes.json();
    return {
        ctx,
        async post(url, body) {
            return ctx.post(url, {
                data: body ?? {},
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            });
        },
        async dispose() { await ctx.dispose(); },
    };
}

test.describe('#107b — OAuth account creation seeds the provider avatar', () => {
    test('oauth callback creates the account with the provider avatar stored as a data URL', async () => {
        // 1. Start the flow to mint a state token.
        const ctx = await pwRequest.newContext({ baseURL: server.baseURL });
        const startRes = await ctx.get('/api/users/oauth/start/github', { maxRedirects: 0 });
        expect(startRes.status(), 'oauth start must redirect to github').toBe(302);
        const location = startRes.headers()['location'] || '';
        expect(location.startsWith('https://github.com/login/oauth/authorize')).toBe(true);
        const state = new URL(location).searchParams.get('state');
        expect(state, 'state param missing from redirect').toBeTruthy();

        // 2. Complete the flow through the real callback — same context,
        //    the callback's redirect to / would otherwise end the flow.
        const callbackRes = await ctx.get(`/api/users/oauth/callback/github?code=stub-code&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
        expect(callbackRes.status(), 'oauth callback must redirect home').toBe(302);
        expect(callbackRes.headers()['location']).toBe('/');
        await ctx.dispose();

        // 3. The account now exists with the provider avatar (not the
        //    default /img path, not a broken URL).
        const s = await newSession();
        try {
            const res = await s.post('/api/users/list');
            expect(res.ok()).toBe(true);
            const users = await res.json();
            const mona = users.find(u => u.handle === 'mona');
            expect(mona, 'oauth-created user missing from list').toBeTruthy();
            expect(mona.avatar.startsWith('data:image/png;base64,')).toBe(true);
            expect(mona.avatar).toContain(TINY_PNG_BASE64);
            expect(mona.oauthProviders).toEqual(['github']);
        } finally {
            await s.dispose();
        }
    });

    test('re-login does not clobber a user-changed avatar', async () => {
        // Second OAuth round-trip to establish a session as mona, then
        // change the avatar via the real change-avatar endpoint, then run
        // a third callback — the avatar datum must survive it.
        const ctx = await pwRequest.newContext({ baseURL: server.baseURL });
        const startRes = await ctx.get('/api/users/oauth/start/github', { maxRedirects: 0 });
        const location = startRes.headers()['location'] || '';
        const state = new URL(location).searchParams.get('state');
        const callbackRes = await ctx.get(`/api/users/oauth/callback/github?code=stub-code&state=${encodeURIComponent(state)}`, { maxRedirects: 0 });
        expect(callbackRes.status()).toBe(302);

        // change-avatar requires a logged-in session: this context is it.
        const csrfRes = await ctx.get('/csrf-token');
        expect(csrfRes.ok(), 'csrf-token request failed').toBe(true);
        const { token } = await csrfRes.json();
        const changeRes = await ctx.post('/api/users/change-avatar', {
            data: { handle: 'mona', avatar: 'data:image/png;base64,CHANGED' },
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        });
        expect(changeRes.status(), `change-avatar failed (${changeRes.status()})`).toBe(204);
        await ctx.dispose();

        // Third OAuth round-trip: existing user, must not reseed.
        const ctx3 = await pwRequest.newContext({ baseURL: server.baseURL });
        const startRes3 = await ctx3.get('/api/users/oauth/start/github', { maxRedirects: 0 });
        const state3 = new URL(startRes3.headers()['location']).searchParams.get('state');
        const callbackRes3 = await ctx3.get(`/api/users/oauth/callback/github?code=stub-code&state=${encodeURIComponent(state3)}`, { maxRedirects: 0 });
        expect(callbackRes3.status()).toBe(302);
        await ctx3.dispose();

        const s = await newSession();
        try {
            const res = await s.post('/api/users/list');
            const users = await res.json();
            const mona = users.find(u => u.handle === 'mona');
            expect(mona.avatar).toBe('data:image/png;base64,CHANGED');
        } finally {
            await s.dispose();
        }
    });
});
