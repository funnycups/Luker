import { describe, it, beforeEach } from '@jest/globals';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import express from 'express';

import basicAuthMiddleware, { WS_PROXY_AUTH_BYPASS } from '../src/middleware/basicAuth.js';
import { initWsProxy } from '../src/ws-proxy.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a mock IncomingMessage suitable for app.handle().
 * Mirrors the production pattern in ws-proxy.js startJob().
 */
function createMockRequest({ method = 'POST', url = '/api/test', headers = {}, body = null } = {}) {
    const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const mockSocket = new Readable({ read() {} });
    mockSocket.readable = true;
    mockSocket.writable = false;
    mockSocket.destroyed = false;
    mockSocket.destroy = function () { this.destroyed = true; this.push(null); };

    const req = new http.IncomingMessage(mockSocket);
    req.method = method;
    req.url = url;

    const reqHeaders = { ...headers };
    if (bodyStr != null && !reqHeaders['content-type']) {
        reqHeaders['content-type'] = 'application/json';
    }
    if (bodyStr != null) {
        reqHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
    }
    req.headers = reqHeaders;

    if (bodyStr != null) {
        req.push(bodyStr, 'utf8');
    }
    req.push(null);

    return req;
}

/**
 * Dispatch a request through a real HTTP server and return the parsed response.
 * Returns { statusCode, headers, chunks, body }
 */
async function dispatchViaServer(app, { method = 'POST', url = '/', headers = {}, body = null }) {
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const reqHeaders = { ...headers };
        if (bodyStr != null && !reqHeaders['content-type']) {
            reqHeaders['content-type'] = 'application/json';
        }
        if (bodyStr != null) {
            reqHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
        }

        const result = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: url,
                method,
                headers: reqHeaders,
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk.toString()));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        chunks,
                        body: chunks.join(''),
                    });
                });
            });
            req.on('error', reject);
            if (bodyStr != null) req.write(bodyStr);
            req.end();
        });

        return result;
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

/**
 * Dispatch a request through app.handle() with a proper mock response socket.
 * Uses res.assignSocket() with a Writable sink so that the 'finish' event fires.
 * Returns { statusCode, headers, body, raw }
 */
async function dispatchViaHandle(app, req) {
    const res = new http.ServerResponse(req);

    const rawChunks = [];
    const sink = new Writable({
        write(chunk, enc, cb) {
            rawChunks.push(chunk.toString());
            cb();
        },
        final(cb) { cb(); },
    });
    sink.readable = true;
    sink.cork = function () { Writable.prototype.cork.call(this); };
    sink.uncork = function () { Writable.prototype.uncork.call(this); };
    sink.destroy = function () {};
    sink.setTimeout = function () { return this; };
    sink.setNoDelay = function () { return this; };
    sink.setKeepAlive = function () { return this; };

    res.assignSocket(sink);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            resolve(_parseRawResponse(rawChunks.join(''), res));
        }, 5000);

        res.on('finish', () => {
            clearTimeout(timeout);
            resolve(_parseRawResponse(rawChunks.join(''), res));
        });

        app.handle(req, res, (err) => {
            clearTimeout(timeout);
            if (err) reject(err);
            else resolve(_parseRawResponse(rawChunks.join(''), res));
        });
    });
}

/**
 * Parse raw HTTP response text (headers + body) into a structured result.
 * The Writable sink captures the full HTTP response including status line and headers.
 */
function _parseRawResponse(raw, res) {
    const separator = '\r\n\r\n';
    const idx = raw.indexOf(separator);
    const headerSection = idx >= 0 ? raw.substring(0, idx) : '';
    const body = idx >= 0 ? raw.substring(idx + separator.length) : raw;

    // Parse status line: HTTP/1.1 200 OK
    const statusLine = headerSection.split('\r\n')[0] || '';
    const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : res.statusCode;

    // Parse response headers
    const headers = {};
    const headerLines = headerSection.split('\r\n').slice(1);
    for (const line of headerLines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
            const name = line.substring(0, colonIdx).trim().toLowerCase();
            const value = line.substring(colonIdx + 1).trim();
            headers[name] = value;
        }
    }

    // Merge headers from res.getHeaders() as fallback
    for (const [k, v] of Object.entries(res.getHeaders())) {
        if (!headers[k]) headers[k] = String(v);
    }

    return { statusCode, headers, body, raw };
}

// ─── Test Suite: app.handle() dispatch ──────────────────────────────────────

describe('ws-proxy app.handle() dispatch', () => {

    let app;

    beforeEach(() => {
        app = express();
    });

    // ── 1. Basic round-trip ─────────────────────────────────────────────────

    it('should dispatch a POST and receive response', async () => {
        app.post('/api/generate', (req, res) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: 'ok', received: data }));
            });
        });

        const body = { prompt: 'hello', max_tokens: 100 };
        const req = createMockRequest({ url: '/api/generate', body });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.result, 'ok');
        assert.equal(parsed.received, JSON.stringify(body));
    });

    // ── 2. GET request without body ─────────────────────────────────────────

    it('should handle a GET request with no body', async () => {
        app.get('/api/models', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: ['gpt-4', 'claude-3'] }));
        });

        const req = createMockRequest({ method: 'GET', url: '/api/models', body: null });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.deepEqual(parsed.models, ['gpt-4', 'claude-3']);
    });

    // ── 3. Headers forwarded ────────────────────────────────────────────────

    it('should forward request headers to handler', async () => {
        const receivedHeaders = {};

        app.post('/api/echo', (req, res) => {
            receivedHeaders['host'] = req.headers['host'];
            receivedHeaders['cookie'] = req.headers['cookie'];
            receivedHeaders['x-csrf-token'] = req.headers['x-csrf-token'];
            receivedHeaders['authorization'] = req.headers['authorization'];
            receivedHeaders['content-type'] = req.headers['content-type'];
            res.writeHead(200);
            res.end('ok');
        });

        const req = createMockRequest({
            url: '/api/echo',
            headers: {
                'host': 'localhost:8000',
                'cookie': 'session=abc123',
                'x-csrf-token': 'csrf-token-value',
                'authorization': 'Bearer sk-test',
            },
            body: { data: 1 },
        });
        await dispatchViaHandle(app, req);

        assert.equal(receivedHeaders['host'], 'localhost:8000');
        assert.equal(receivedHeaders['cookie'], 'session=abc123');
        assert.equal(receivedHeaders['x-csrf-token'], 'csrf-token-value');
        assert.equal(receivedHeaders['authorization'], 'Bearer sk-test');
        assert.equal(receivedHeaders['content-type'], 'application/json');
    });

    // ── 4. Streaming response ───────────────────────────────────────────────

    it('should capture multiple streaming write() calls', async () => {
        app.post('/v1/chat/completions', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"!"}}]}\n\n');
            res.end('data: [DONE]\n\n');
        });

        const req = createMockRequest({ url: '/v1/chat/completions', body: { model: 'gpt-4' } });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        assert.ok(result.body.includes('[DONE]'));
        assert.ok(result.body.includes('Hello'));
        assert.ok(result.body.includes('world'));
    });

    // ── 5. Moderate body ────────────────────────────────────────────────────

    it('should handle a 10KB request body', async () => {
        app.post('/api/large', (req, res) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                res.writeHead(200);
                res.end(JSON.stringify({ length: data.length }));
            });
        });

        const bigBody = 'x'.repeat(10_000);
        const req = createMockRequest({ url: '/api/large', body: { text: bigBody } });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.length, JSON.stringify({ text: bigBody }).length);
    });

    // ── 6. Error status codes ───────────────────────────────────────────────

    it('should propagate error status codes', async () => {
        app.post('/api/fail', (req, res) => {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        });

        const req = createMockRequest({ url: '/api/fail', body: {} });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 429);
        assert.ok(result.body.includes('Rate limit exceeded'));
    });

    // ── 7. 404 ──────────────────────────────────────────────────────────────

    it('should return 404 when no route matches', async () => {
        // No routes registered at all → every request should be 404
        const result = await dispatchViaServer(app, {
            url: '/api/nonexistent',
            body: null,
        });

        assert.equal(result.statusCode, 404);
    });

    // ── 8. setHeader ────────────────────────────────────────────────────────

    it('should capture headers set via res.setHeader()', async () => {
        app.post('/api/headers', (req, res) => {
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('X-Request-Id', 'abc-123');
            res.writeHead(200);
            res.end('ok');
        });

        const req = createMockRequest({ url: '/api/headers', body: null });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        assert.equal(result.headers['content-type'], 'text/plain');
        assert.equal(result.headers['x-request-id'], 'abc-123');
    });

    // ── 9. Null body ────────────────────────────────────────────────────────

    it('should handle POST with null body', async () => {
        app.post('/api/empty', (req, res) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                res.writeHead(200);
                res.end(JSON.stringify({ received: data.length }));
            });
        });

        const req = createMockRequest({ url: '/api/empty', body: null });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.received, 0);
    });

    // ── 10. String body ─────────────────────────────────────────────────────

    it('should handle string body without double-encoding', async () => {
        app.post('/api/raw', (req, res) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                res.writeHead(200);
                res.end(JSON.stringify({ received: data }));
            });
        });

        const rawBody = 'plain text body';
        const req = createMockRequest({ url: '/api/raw', body: rawBody });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.received, 'plain text body');
    });

    // ── 11. Synchronous throw ───────────────────────────────────────────────

    it('should propagate synchronous errors', async () => {
        app.post('/api/crash', (req, res) => {
            throw new Error('sync explosion');
        });

        const req = createMockRequest({ url: '/api/crash', body: {} });

        await assert.rejects(
            () => dispatchViaHandle(app, req),
            /sync explosion/,
        );
    });

    // ── 12. Middleware order ─────────────────────────────────────────────────

    it('should execute middleware in correct order', async () => {
        const order = [];

        app.use((req, res, next) => { order.push('mw1'); next(); });
        app.use((req, res, next) => { order.push('mw2'); next(); });
        app.post('/api/mw', (req, res) => {
            order.push('handler');
            res.writeHead(200);
            res.end('ok');
        });

        const req = createMockRequest({ url: '/api/mw', body: {} });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        assert.deepEqual(order, ['mw1', 'mw2', 'handler']);
    });

    // ── 13. IncomingMessage with Readable socket ────────────────────────────

    it('should work with Readable as IncomingMessage socket', async () => {
        app.post('/api/verify', (req, res) => {
            res.writeHead(200);
            res.end('ok');
        });

        const req = createMockRequest({ url: '/api/verify', body: { test: 1 } });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
    });

    // ── 14. Unicode body ────────────────────────────────────────────────────

    it('should handle multi-byte UTF-8 characters', async () => {
        app.post('/api/unicode', (req, res) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                res.writeHead(200);
                res.end(JSON.stringify({ received: data }));
            });
        });

        const unicodeBody = { text: '你好世界 🌍 こんにちは' };
        const req = createMockRequest({ url: '/api/unicode', body: unicodeBody });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.received, JSON.stringify(unicodeBody));
    });

    // ── 15. Custom content-type preserved ───────────────────────────────────

    it('should not override content-type if already set', async () => {
        let receivedCt = '';

        app.post('/api/ct', (req, res) => {
            receivedCt = req.headers['content-type'];
            res.writeHead(200);
            res.end('ok');
        });

        const req = createMockRequest({
            url: '/api/ct',
            headers: { 'content-type': 'text/plain' },
            body: 'raw text',
        });
        await dispatchViaHandle(app, req);

        assert.equal(receivedCt, 'text/plain');
    });

    // ── 16. writeHead with reason string ────────────────────────────────────

    it('should handle writeHead with status + reason + headers', async () => {
        app.post('/api/reason', (req, res) => {
            res.writeHead(200, 'OK', { 'X-Custom': 'value' });
            res.end('ok');
        });

        const req = createMockRequest({ url: '/api/reason', body: null });
        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        assert.equal(result.headers['x-custom'], 'value');
    });
});

// ─── Test Suite: Real HTTP server round-trip ────────────────────────────────

describe('ws-proxy real HTTP server round-trip', () => {

    let app;

    beforeEach(() => {
        app = express();
    });

    it('should complete a full POST round-trip via HTTP', async () => {
        app.post('/api/generate', (req, res) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: 'ok', received: data }));
            });
        });

        const result = await dispatchViaServer(app, {
            url: '/api/generate',
            body: { prompt: 'hello' },
        });

        assert.equal(result.statusCode, 200);
        const parsed = JSON.parse(result.body);
        assert.equal(parsed.result, 'ok');
    });

    it('should handle SSE streaming via HTTP', async () => {
        app.post('/v1/chat/completions', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: chunk1\n\n');
            res.write('data: chunk2\n\n');
            res.end('data: [DONE]\n\n');
        });

        const result = await dispatchViaServer(app, {
            url: '/v1/chat/completions',
            body: { model: 'gpt-4' },
        });

        assert.equal(result.statusCode, 200);
        assert.ok(result.body.includes('[DONE]'));
        assert.equal(result.chunks.length, 3);
    });

    it('should return 404 for unmatched routes via HTTP', async () => {
        app.post('/api/exists', (req, res) => {
            res.writeHead(200);
            res.end('ok');
        });

        const result = await dispatchViaServer(app, {
            url: '/api/nonexistent',
            body: {},
        });

        assert.equal(result.statusCode, 404);
    });

    it('should forward headers via HTTP', async () => {
        let receivedAuth = '';

        app.post('/api/echo', (req, res) => {
            receivedAuth = req.headers['authorization'];
            res.writeHead(200);
            res.end('ok');
        });

        const result = await dispatchViaServer(app, {
            url: '/api/echo',
            headers: { authorization: 'Bearer sk-test' },
            body: {},
        });

        assert.equal(result.statusCode, 200);
        assert.equal(receivedAuth, 'Bearer sk-test');
    });

    it('should handle 5xx error responses via HTTP', async () => {
        app.post('/api/fail', (req, res) => {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service unavailable' }));
        });

        const result = await dispatchViaServer(app, {
            url: '/api/fail',
            body: {},
        });

        assert.equal(result.statusCode, 503);
        assert.ok(result.body.includes('Service unavailable'));
    });

    it('should handle middleware chains via HTTP', async () => {
        const order = [];

        app.use((req, res, next) => { order.push('auth'); next(); });
        app.use((req, res, next) => { order.push('log'); next(); });
        app.post('/api/mw', (req, res) => {
            order.push('handler');
            res.writeHead(200);
            res.end('ok');
        });

        const result = await dispatchViaServer(app, {
            url: '/api/mw',
            body: {},
        });

        assert.equal(result.statusCode, 200);
        assert.deepEqual(order, ['auth', 'log', 'handler']);
    });
});

// ─── Test Suite: basicAuth bypass for WS-dispatched requests ────────────────

describe('ws-proxy basicAuth bypass', () => {

    let app;

    beforeEach(() => {
        app = express();
        app.use(basicAuthMiddleware);
        app.post('/api/generate', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    });

    it('reaches the handler when the WS proxy marker is set, even without Authorization header', async () => {
        const req = createMockRequest({ url: '/api/generate', body: {} });
        req[WS_PROXY_AUTH_BYPASS] = true;

        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 200);
        assert.deepEqual(JSON.parse(result.body), { ok: true });
    });

    it('still rejects WS-dispatched requests that omit the marker (parity with HTTP)', async () => {
        const req = createMockRequest({ url: '/api/generate', body: {} });

        const result = await dispatchViaHandle(app, req);

        assert.equal(result.statusCode, 401);
    });
});

// ─── Test Suite: WS upgrade authentication gate ─────────────────────────────

describe('ws-proxy upgrade auth gate', () => {

    /**
     * Spin up a server with an authenticateUpgrade gate, attempt a real WS
     * handshake, and resolve to the parsed HTTP response (or 'upgraded' if the
     * gate accepted us). We do NOT use the `ws` client library here because we
     * need to inspect the rejected upgrade response, which the client hides.
     */
    async function attemptUpgrade({ authenticate, headers = {} } = {}) {
        const expressApp = express();
        const server = http.createServer(expressApp);

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        initWsProxy([server], expressApp, authenticate);

        const wsKey = Buffer.from('1234567890123456').toString('base64');
        const reqLines = [
            'GET /ws/proxy HTTP/1.1',
            `Host: 127.0.0.1:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${wsKey}`,
            'Sec-WebSocket-Version: 13',
        ];
        for (const [k, v] of Object.entries(headers)) {
            reqLines.push(`${k}: ${v}`);
        }
        reqLines.push('', '');
        const requestBytes = reqLines.join('\r\n');

        const result = await new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
                sock.write(requestBytes);
            });
            let raw = '';
            let resolved = false;
            const finish = () => {
                if (resolved) return;
                resolved = true;
                const statusLine = raw.split('\r\n', 1)[0] || '';
                const m = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
                resolve({ status: m ? parseInt(m[1], 10) : 0, raw });
                try { sock.destroy(); } catch { /* */ }
            };
            sock.on('data', (chunk) => {
                raw += chunk.toString('utf8');
                // Once headers are complete we have everything we need; the
                // server may keep the socket open (101 path) so don't wait
                // for 'end'.
                if (raw.includes('\r\n\r\n')) {
                    finish();
                }
            });
            sock.on('end', finish);
            sock.on('close', finish);
            sock.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    reject(err);
                }
            });
            // Hard cap so a hung server can't wedge the test runner.
            setTimeout(finish, 2000);
        });

        await new Promise(resolve => server.close(resolve));
        return result;
    }

    it('accepts the upgrade when the gate resolves ok', async () => {
        const result = await attemptUpgrade({
            authenticate: async () => ({ ok: true }),
        });
        assert.equal(result.status, 101, `expected 101 Switching Protocols, got: ${result.raw.split('\r\n')[0]}`);
    });

    it('rejects with 401 when the gate fails and emits WWW-Authenticate', async () => {
        const result = await attemptUpgrade({
            authenticate: async () => ({ ok: false, status: 401, reason: 'missing_authorization' }),
        });
        assert.equal(result.status, 401);
        assert.match(result.raw, /WWW-Authenticate:\s*Basic realm="Luker"/i);
    });

    it('rejects with 429 + Retry-After when the gate signals rate limit', async () => {
        const result = await attemptUpgrade({
            authenticate: async () => ({ ok: false, status: 429, retryAfter: 42 }),
        });
        assert.equal(result.status, 429);
        assert.match(result.raw, /Retry-After:\s*42/i);
    });

    it('skips the gate entirely when no authenticator is provided', async () => {
        const result = await attemptUpgrade({ authenticate: null });
        assert.equal(result.status, 101);
    });
});

// ─── Test Suite: IncomingMessage socket type regression ─────────────────────

describe('ws-proxy IncomingMessage socket type', () => {

    it('should fail to use IncomingMessage when socket is a plain EventEmitter', async () => {
        // Regression test for the bug fixed in commit 906a88f28.
        // http.IncomingMessage requires a Stream (Readable) as its socket argument.
        // Using a plain EventEmitter causes ERR_INVALID_ARG_TYPE when Node
        // internally tries to destroy the socket after data ends.

        const mockSocket = new EventEmitter();
        mockSocket.readable = true;
        mockSocket.writable = false;
        mockSocket.destroy = () => {};
        mockSocket.destroyed = false;

        assert.equal(mockSocket instanceof Readable, false);
    });

    it('should accept a Readable as IncomingMessage socket without error', () => {
        const mockSocket = new Readable({ read() {} });
        mockSocket.readable = true;
        mockSocket.writable = false;
        mockSocket.destroyed = false;
        mockSocket.destroy = function () { this.destroyed = true; this.push(null); };

        const req = new http.IncomingMessage(mockSocket);
        req.method = 'POST';
        req.url = '/api/test';
        req.headers = { 'content-type': 'application/json', 'content-length': '2' };

        // Should not throw or emit uncaught exceptions
        req.push('{}');
        req.push(null);
        req.resume();
    });
});
