// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdNanoGpt } from '../../../../../src/luker-dispatch/providers/sd/nanogpt.js';

function fakeCtx({ body = {}, onFetch, secret = 'nano-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'foo', prompt: 'a cat', ...body },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: 'ZmFrZQ==' }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: { read: jest.fn(() => secret) },
        generation: { startJob: jest.fn(() => null), appendEvent: jest.fn(), hasActiveKeepAliveJob: jest.fn(() => false) },
        inspection: {
            start: jest.fn(), attach: jest.fn(), fail: jest.fn(),
            startImage: jest.fn(), completeImage: jest.fn(), failImage: jest.fn(), abort: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
    };
}

const chunkToStr = (c) => Buffer.from(c.data).toString('utf8');

describe('dispatchSdNanoGpt', () => {
    test('happy path: uses x-api-key header, emits {image}', async () => {
        const ctx = fakeCtx();
        await dispatchSdNanoGpt(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe('ZmFrZQ==');
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://nano-gpt.com/api/generate-image');
        expect(init.headers['x-api-key']).toBe('nano-key');
        expect(init.headers.Authorization).toBeUndefined();
        expect(init.signal).toBeDefined();
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdNanoGpt(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('abort mid-request: emit.error, no chunk', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((_url, init) => new Promise((_r, reject) => {
            init.signal?.addEventListener?.('abort', () => {
                const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
            });
        }));
        const ctx = fakeCtx({ signal: ac.signal, onFetch: fetchMock });
        const p = dispatchSdNanoGpt(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
