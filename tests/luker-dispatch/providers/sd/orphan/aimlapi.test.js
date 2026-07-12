// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdAimlapi } from '../../../../../src/luker-dispatch/providers/sd/aimlapi.js';

function fakeCtx({ body = {}, onFetch, secret = 'aiml-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'flux/schnell', prompt: 'a cat', ...body },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({ images: [{ b64_json: 'ZmFrZQ==' }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
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

describe('dispatchSdAimlapi', () => {
    test('happy path (b64_json in images[]): emits {format:"png", data}', async () => {
        const ctx = fakeCtx();
        await dispatchSdAimlapi(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('png');
        expect(payload.data).toBe('ZmFrZQ==');
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.aimlapi.com/v1/images/generations');
        expect(init.headers.Authorization).toBe('Bearer aiml-key');
        // AIMLAPI_HEADERS should be merged
        expect(init.headers['HTTP-Referer']).toBeDefined();
        expect(init.signal).toBeDefined();
    });

    test('url fallback: fetches image URL, base64 encodes', async () => {
        let callN = 0;
        const fetchMock = jest.fn(async () => {
            callN++;
            if (callN === 1) return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/x.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            return new Response(Buffer.from([1, 2, 3]), { status: 200 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdAimlapi(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.data).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdAimlapi(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('aimlapi blew up', { status: 500 })),
        });
        await dispatchSdAimlapi(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('aimlapi blew up');
        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.failImage).toHaveBeenCalled();
        expect(ctx.inspection.failImage.mock.calls[0][1]).toBe(500);
    });

    test('abort mid-request: emit.error, no chunk', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((_url, init) => new Promise((_r, reject) => {
            init.signal?.addEventListener?.('abort', () => {
                const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
            });
        }));
        const ctx = fakeCtx({ signal: ac.signal, onFetch: fetchMock });
        const p = dispatchSdAimlapi(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
