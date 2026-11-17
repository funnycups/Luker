// SPDX-License-Identifier: AGPL-3.0-or-later

import { jest } from '@jest/globals';

const PROXY_URL = '/api/backends/chat-completions/generate';

describe('installFetchProxy', () => {
    let mockDelivery;
    let originalFetch;

    beforeEach(() => {
        mockDelivery = {
            subscribe: jest.fn((requestId) => {
                const encoder = new TextEncoder();
                return {
                    stream: new ReadableStream({
                        start(c) {
                            c.enqueue(encoder.encode('data: hello\n\n'));
                            c.close();
                        },
                    }),
                    headPromise: Promise.resolve({ status: 200, headers: {} }),
                    unsubscribe: jest.fn(),
                };
            }),
        };
        originalFetch = jest.fn(async (url, init) => {
            const requestId = init?.headers?.['x-luker-request-id'];
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'x-luker-generation-id': requestId,
                    'x-luker-server-persisted': '0',
                },
            });
        });
        global.crypto = { randomUUID: () => 'test-uuid-fixed' };
        global.window = { Response, Headers, DOMException };
    });

    test('passes through non-proxied URLs untouched', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch });
        await window.fetch('/api/user/profile');
        expect(originalFetch).toHaveBeenCalledWith('/api/user/profile', undefined);
        expect(mockDelivery.subscribe).not.toHaveBeenCalled();
    });

    test('proxies /api/backends/chat-completions/generate through delivery', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch });
        const resp = await window.fetch(PROXY_URL, {
            method: 'POST', headers: {}, body: '{}',
        });
        expect(originalFetch).toHaveBeenCalledTimes(1);
        const [calledUrl, calledInit] = originalFetch.mock.calls[0];
        expect(calledUrl).toBe(PROXY_URL);
        expect(calledInit.headers['x-luker-request-id']).toBe('test-uuid-fixed');
        expect(mockDelivery.subscribe).toHaveBeenCalledWith('test-uuid-fixed', expect.any(Object), expect.any(Object));
        // Fake response carries x-luker-* headers
        expect(resp.headers.get('x-luker-generation-id')).toBe('test-uuid-fixed');
        expect(resp.status).toBe(200);
        // Body from stream
        const text = await new Response(resp.body).text();
        expect(text).toBe('data: hello\n\n');
    });

    test('non-2xx HTTP response passes through unchanged (no subscribe)', async () => {
        const failFetch = jest.fn(async () => new Response('bad', { status: 400 }));
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch: failFetch });
        const resp = await window.fetch(PROXY_URL, { method: 'POST' });
        expect(resp.status).toBe(400);
        expect(mockDelivery.subscribe).not.toHaveBeenCalled();
    });

    test('forwards luker_generation.request_timeout_ms to subscribe options and wires abort notification as onTimeout', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch });
        let capturedOptions = null;
        mockDelivery.subscribe.mockImplementation((requestId, headers, options) => {
            capturedOptions = options;
            return {
                stream: new ReadableStream({ start(c) { c.close(); } }),
                headPromise: Promise.resolve({ status: 200, headers: {} }),
                unsubscribe: jest.fn(),
            };
        });
        await window.fetch(PROXY_URL, {
            method: 'POST',
            headers: {},
            body: JSON.stringify({ luker_generation: { job_id: 'job-t', request_timeout_ms: 1500 } }),
        });
        expect(capturedOptions.timeoutMs).toBe(1500);
        originalFetch.mockClear();
        capturedOptions.onTimeout('job-t');
        expect(originalFetch).toHaveBeenCalledWith(
            '/api/generation/job-t/abort',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    test('defaults the timeout option to 0 when the body carries none', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch });
        let capturedOptions = null;
        mockDelivery.subscribe.mockImplementation((requestId, headers, options) => {
            capturedOptions = options;
            return {
                stream: new ReadableStream({ start(c) { c.close(); } }),
                headPromise: Promise.resolve({ status: 200, headers: {} }),
                unsubscribe: jest.fn(),
            };
        });
        await window.fetch(PROXY_URL, { method: 'POST', headers: {}, body: '{}' });
        expect(capturedOptions.timeoutMs).toBe(0);
    });

    test('defaults content-type to application/json for non-streaming requests when head omits content-type', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch });
        const resp = await window.fetch(PROXY_URL, {
            method: 'POST',
            headers: {},
            body: JSON.stringify({ stream: false }),
        });
        expect(resp.headers.get('content-type')).toBe('application/json; charset=utf-8');
    });

    test('defaults content-type to text/event-stream for streaming requests when head omits content-type', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        installFetchProxy(mockDelivery, { originalFetch });
        const streamResp = await window.fetch(PROXY_URL, {
            method: 'POST',
            headers: {},
            body: JSON.stringify({ stream: true }),
        });
        expect(streamResp.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

        delete window.__lukerFetchProxyDisposer;
        installFetchProxy(mockDelivery, { originalFetch });
        const legacyStreamingResp = await window.fetch('/api/backends/kobold/generate', {
            method: 'POST',
            headers: {},
            body: JSON.stringify({ streaming: true }),
        });
        expect(legacyStreamingResp.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    });

    test('preserves explicit content-type supplied by head headers', async () => {
        const { installFetchProxy } = await import('../public/scripts/ws-delivery.js');
        mockDelivery.subscribe.mockImplementation(() => ({
            stream: new ReadableStream({ start(c) { c.close(); } }),
            headPromise: Promise.resolve({ status: 200, headers: { 'content-type': 'image/png' } }),
            unsubscribe: jest.fn(),
        }));
        installFetchProxy(mockDelivery, { originalFetch });
        const resp = await window.fetch('/api/sd/generate', {
            method: 'POST',
            headers: {},
            body: JSON.stringify({ prompt: 'scenic landscape' }),
        });
        expect(resp.headers.get('content-type')).toBe('image/png');
    });
});
