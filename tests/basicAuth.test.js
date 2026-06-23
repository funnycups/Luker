import { describe, expect, test } from '@jest/globals';

import basicAuthMiddleware, { isBasicAuthExemptRequest, WS_PROXY_AUTH_BYPASS } from '../src/middleware/basicAuth.js';

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

    test('does not exempt the sync /health endpoint or non-session sync paths', () => {
        // /health is a reachability probe, intentionally still gated by basic auth.
        expect(isBasicAuthExemptRequest({
            method: 'GET',
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

    test('does not exempt /session/offer — it ISSUES tokens and must be basic-auth gated', () => {
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

    test('skips basic auth for requests carrying the WS proxy bypass marker', async () => {
        const request = createRequest({
            method: 'POST',
            path: '/api/backends/chat-completions/generate',
            [WS_PROXY_AUTH_BYPASS]: true,
        });
        const response = createResponseRecorder();
        let nextCalled = false;

        await basicAuthMiddleware(request, response, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(response.statusCode).toBeNull();
    });

    test('rejects requests that try to forge the bypass via headers or string keys', async () => {
        // Header keys arrive lowercased and as strings; the marker is a Symbol,
        // so attacker-controlled inputs can never collide with the real key.
        const request = createRequest({
            method: 'POST',
            path: '/api/backends/chat-completions/generate',
            headers: {
                'ws_proxy_auth_bypass': 'true',
                'x-ws-proxy-auth-bypass': 'true',
            },
            'WS_PROXY_AUTH_BYPASS': true,
        });
        const response = createResponseRecorder();
        let nextCalled = false;

        await basicAuthMiddleware(request, response, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(false);
        expect(response.statusCode).toBe(401);
    });
});
