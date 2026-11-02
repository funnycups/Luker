import { describe, expect, test } from '@jest/globals';

import basicAuthMiddleware, { isBasicAuthExemptRequest } from '../src/middleware/basicAuth.js';

function createResponseRecorder() {
    return {
        headers: {},
        statusCode: null,
        body: undefined,
        set(name, value) {
            this.headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        sendStatus(code) {
            this.statusCode = code;
            return this;
        },
    };
}

function createRequest(overrides = {}) {
    return {
        method: 'GET',
        path: '/',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        ...overrides,
    };
}

describe('isBasicAuthExemptRequest', () => {
    test('matches the LAN migration transfer route for GET requests', () => {
        const request = {
            method: 'GET',
            path: `/api/users/transfer/backup/${'a'.repeat(64)}`,
        };

        expect(isBasicAuthExemptRequest(request)).toBe(true);
    });

    test('rejects non-GET methods and non-matching paths', () => {
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: `/api/users/transfer/backup/${'a'.repeat(64)}`,
        })).toBe(false);

        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/users/transfer/backup/not-a-valid-token',
        })).toBe(false);

        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/users/login',
        })).toBe(false);
    });

    test('matches LAN-sync session routes on both GET and POST', () => {
        // GET — peer fetches manifest / single object.
        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/sync/v1/session/manifest',
        })).toBe(true);
        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: `/api/sync/v1/session/object/${'a'.repeat(40)}`,
        })).toBe(true);

        // POST — peer uploads object / ref / close.
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/object',
        })).toBe(true);
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/ref',
        })).toBe(true);
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/close',
        })).toBe(true);
    });

    test('exempts the sync /health probe but not other non-session sync paths', () => {
        // /health reports only the protocol version so a peer can check
        // compatibility before pairing.
        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/sync/v1/health',
        })).toBe(true);
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/health',
        })).toBe(false);
        // Anything outside `/session/` is not exempt.
        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/sync/v1/',
        })).toBe(false);
        // Unexpected HTTP methods on session paths still go through basic auth.
        expect(isBasicAuthExemptRequest({
            method: 'DELETE',
            path: '/api/sync/v1/session/object',
        })).toBe(false);
    });

    test('does not exempt /session/offer without a pairing credential — it ISSUES tokens', () => {
        // The offer route is the bootstrap: the user authenticates with
        // their normal credentials, then receives a bearer token to use on
        // the rest of the /session/* routes. If the bypass swallowed it,
        // any unauthenticated client on the LAN could mint tokens.
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/offer',
        })).toBe(false);
        // Trailing slash variant also stays gated.
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/offer/',
        })).toBe(false);
        // GET is not a valid method for the route, but the test asserts
        // the bypass is not accidentally permissive on this path either.
        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/sync/v1/session/offer',
        })).toBe(false);
    });

    test('exempts /session/offer carrying a pairing credential in single-user mode', () => {
        // The route verifies the credential against the peer registry.
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/offer',
            headers: { 'x-sync-peer-secret': 'a'.repeat(64) },
        })).toBe(true);
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: '/api/sync/v1/session/offer',
            headers: { 'x-sync-pair-code': 'b'.repeat(64) },
        })).toBe(true);
    });
});

describe('basicAuthMiddleware', () => {
    test('skips basic auth for the one-time LAN migration transfer route', async () => {
        const request = createRequest({
            method: 'GET',
            path: `/api/users/transfer/backup/${'b'.repeat(64)}`,
        });
        const response = createResponseRecorder();
        let nextCalled = false;

        await basicAuthMiddleware(request, response, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(response.statusCode).toBeNull();
    });

    test('still rejects unrelated routes without basic auth credentials', async () => {
        const request = createRequest({
            method: 'GET',
            path: '/api/users/oauth/providers',
        });
        const response = createResponseRecorder();
        let nextCalled = false;

        await basicAuthMiddleware(request, response, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(false);
        expect(response.statusCode).toBe(401);
        expect(response.headers['WWW-Authenticate']).toBe('Basic realm="Luker", charset="UTF-8"');
    });
});
