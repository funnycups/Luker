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
