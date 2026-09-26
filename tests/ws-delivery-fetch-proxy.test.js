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
        global.window = global.window || {};
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
        expect(mockDelivery.subscribe).toHaveBeenCalledWith('test-uuid-fixed', expect.any(Object));
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
});
