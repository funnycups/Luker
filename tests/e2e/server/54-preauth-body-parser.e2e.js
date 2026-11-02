// #54 — pre-auth request body parsing (denial of service).
//
// Luker inherited the upstream middleware order where two global 500 MB
// body parsers were registered BEFORE Basic Auth, the IP whitelist, host
// validation, and the account login gate. Any client that could reach
// the listening socket could make the process buffer and parse a large
// (optionally gzipped) JSON or urlencoded body on any path before any
// access control ran, and repeat that in parallel to exhaust memory.
//
// The fix moves body parsing behind every access control and caps the
// pre-auth parsing surface — the /api/users account bootstrap routes,
// the only pre-login routes that read bodies — at body-parser's
// default 100 KB.
//
// Specs:
//   1. Differential, exposes the bug: a raw socket sends only the
//      HEADERS of a POST with a 50 MB JSON body and never sends the
//      body. If a body parser runs before the auth gate, the server
//      blocks waiting for the missing 50 MB and the probe times out.
//      With auth-before-parse, the 401 arrives with the body unread.
//   2. The pre-auth account routes still parse their small JSON bodies.
//   3. The pre-auth parsing surface is size-capped: a 200 KB body to an
//      account route gets 413 instead of being parsed.
//   4. Authenticated requests keep the large body limit and the parsed
//      value reaches the handler (echoed back through /api/debug/export).
//   5. The pre-auth cap does not leak into the private routers mounted
//      under the same /api/users prefix: a 300 KB avatar still reaches
//      /api/users/change-avatar after login.
//   6. Reviewed conflict decisions fit their current applying route.
//   7. Sync user routes reject an absent account before parsing a body.

import { test, expect } from '@playwright/test';
import net from 'node:net';
import { startServer, tearDownServer } from '../_lib/server.js';

let server;

// The bundled config.yaml ships basicAuthUser.username=user,
// basicAuthUser.password=password; the scenario config turns
// basicAuthMode on without overriding them.
const BASIC_AUTH_HEADER = 'Basic ' + Buffer.from('user:password').toString('base64');

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'preauth-body-parse',
        // listen: true drives --listen=true; basicAuthMode goes through
        // the scenario config.yaml (startServer never passes the CLI
        // flag, and the CLI value only wins when set). Both together
        // mount the basicAuth middleware in server-main.js.
        extraConfig: { listen: true, basicAuthMode: true },
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

async function mintCsrf(handle = server) {
    const res = await fetch(`${handle.baseURL}/csrf-token`, {
        headers: { Authorization: BASIC_AUTH_HEADER },
    });
    expect(res.status).toBe(200);
    const cookie = (res.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ');
    const { token } = await res.json();
    expect(typeof token).toBe('string');
    return { cookie, token };
}

function authenticatedHeaders({ cookie, token }) {
    return {
        Authorization: BASIC_AUTH_HEADER,
        Cookie: cookie,
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
    };
}

test.describe('#54 — body parsing must not run before access control', () => {
    test('unauthenticated request is rejected before its body is read', async () => {
        const statusLine = await new Promise((resolve, reject) => {
            const socket = net.connect(server.port, '127.0.0.1');
            let buffer = '';
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('no response within 10s: the server is buffering the 50 MB request body before the auth gate (pre-auth body-parse DoS)'));
            }, 10_000);
            socket.on('connect', () => {
                socket.write([
                    'POST /api/ping HTTP/1.1',
                    'Host: 127.0.0.1',
                    'Content-Type: application/json',
                    'Content-Length: 50000000',
                    'Connection: close',
                    '',
                    '',
                ].join('\r\n'));
                // The body is intentionally never sent.
            });
            socket.on('data', (d) => {
                buffer += d.toString('utf8');
                const line = buffer.split('\r\n')[0];
                if (line.startsWith('HTTP/')) {
                    clearTimeout(timer);
                    socket.destroy();
                    resolve(line);
                }
            });
            socket.on('error', (err) => {
                clearTimeout(timer);
                socket.destroy();
                reject(err);
            });
        });
        expect(statusLine).toBe('HTTP/1.1 401 Unauthorized');
    });

    test('account routes still parse small JSON bodies before login', async () => {
        const csrf = await mintCsrf();
        const res = await fetch(`${server.baseURL}/api/users/list`, {
            method: 'POST',
            headers: authenticatedHeaders(csrf),
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const users = await res.json();
        expect(Array.isArray(users)).toBe(true);
    });

    test('oversized body to an account route is refused instead of parsed', async () => {
        const csrf = await mintCsrf();
        const res = await fetch(`${server.baseURL}/api/users/list`, {
            method: 'POST',
            headers: authenticatedHeaders(csrf),
            body: JSON.stringify({ pad: 'A'.repeat(200 * 1024) }),
        });
        expect(res.status).toBe(413);
    });

    test('authenticated requests keep the large body limit', async () => {
        const csrf = await mintCsrf();
        // 300 KB: above the 100 KB pre-auth cap, far below the 500 MB
        // authenticated cap. The echo of `userAgent` proves the body was
        // parsed and reached the handler, not merely swallowed.
        const res = await fetch(`${server.baseURL}/api/debug/export`, {
            method: 'POST',
            headers: authenticatedHeaders(csrf),
            body: JSON.stringify({ userAgent: 'preauth-body-parse-spec', pad: 'A'.repeat(300 * 1024) }),
        });
        expect(res.status).toBe(200);
        const bundle = await res.json();
        expect(bundle.client.userAgent).toBe('preauth-body-parse-spec');
    });

    test('the pre-auth cap does not leak into authenticated /api/users routes', async () => {
        // /api/users is mounted twice: the public router before the login
        // gate and the private routers after it. A parser attached to the
        // whole public router also runs for paths that router does not
        // define, so this guards the avatar route — a data URL routinely
        // exceeds 100 KB — against the pre-auth cap.
        const csrf = await mintCsrf();
        const avatar = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
        const res = await fetch(`${server.baseURL}/api/users/change-avatar`, {
            method: 'POST',
            headers: authenticatedHeaders(csrf),
            body: JSON.stringify({ handle: 'default-user', avatar }),
        });
        expect(res.status).toBe(204);
    });

    test('conflict resolutions fit the sync route that applies them', async () => {
        // Reviewed evidence grows with the pending set. Absent records give
        // an unapplied result, proving the complete body reached the owner.
        const csrf = await mintCsrf();
        const choices = conflictChoices(500);
        const body = JSON.stringify(choices);
        expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
        const res = await fetch(`${server.baseURL}/api/sync/v1/conflicts/resolve`, {
            method: 'POST',
            headers: authenticatedHeaders(csrf),
            body,
        });
        expect(res.status).toBe(200);
        const result = await res.json();
        expect(result.results).toEqual(choices.map(({ path }) => ({ path, backends: [], committedBackends: [], applied: false })));
    });

    test('sync user routes authenticate before parsing their bodies', async () => {
        const accountServer = await startServer({
            batchKey: 'server', scenarioId: 'sync-preauth-body-parse',
            extraConfig: { listen: true, basicAuthMode: true, enableUserAccounts: true },
        });
        try {
            const csrf = await mintCsrf(accountServer);
            for (const route of ['pair/start', 'pair/accept', 'backends/s3', 'backends/unknown', 'backends/unknown/s3', 'backends/unknown/unlock', 'device', 'conflicts/resolve', 'notices/dismiss', 'schedule']) {
                const res = await fetch(`${accountServer.baseURL}/api/sync/v1/${route}`, {
                    method: 'POST', headers: authenticatedHeaders(csrf), body: '{',
                });
                expect(res.status, route).toBe(401);
                expect(await res.json(), route).toEqual({ error: 'Auth required' });
            }
        } finally {
            await tearDownServer(accountServer);
        }
    });
});

/** Current reviewed DTO for records absent from the fixture's registry. */
function conflictChoices(count) {
    return Array.from({ length: count }, (_, index) => ({
        path: `worlds/body-parser-resource-${index}.json`,
        choice: 'current',
        review: {
            backendId: 'displayed-backend', selectedOid: null,
            recordVersions: { 'displayed-backend': 'a'.repeat(40) },
            currentVersions: { 'displayed-backend': null },
        },
    }));
}
