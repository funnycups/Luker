// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdWorkersai } from '../../../../../src/luker-dispatch/providers/sd/workersai.js';

function fakeCtx({ body = {}, onFetch, secret = 'cf-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: {
            account_id: 'acct-123',
            model: '@cf/lykon/dreamshaper-8-lcm',
            prompt: 'a cat',
            width: 512,
            height: 512,
            steps: 20,
            scale: 7,
            seed: 42,
            ...body,
        },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })),
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

describe('dispatchSdWorkersai', () => {
    test('happy path (binary): emits {format:"png", image}', async () => {
        const ctx = fakeCtx();
        await dispatchSdWorkersai(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('png');
        expect(payload.image).toBe(Buffer.from([1, 2, 3]).toString('base64'));
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/lykon/dreamshaper-8-lcm');
        expect(init.headers.Authorization).toBe('Bearer cf-key');
        expect(init.headers['Content-Type']).toBe('application/json');
        expect(init.signal).toBeDefined();
    });

    test('JSON partner-model response', async () => {
        const fetchMock = jest.fn(async () => new Response(JSON.stringify({ result: { image: 'b64x' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdWorkersai(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe('b64x');
    });

    test('flux-2 model uses FormData (no JSON Content-Type)', async () => {
        const fetchMock = jest.fn(async () => new Response(Buffer.from([1]), { status: 200, headers: { 'content-type': 'image/png' } }));
        const ctx = fakeCtx({ body: { model: '@cf/black-forest-labs/flux-2' }, onFetch: fetchMock });
        await dispatchSdWorkersai(ctx);
        const [, init] = fetchMock.mock.calls[0];
        // Content-Type must NOT be application/json for flux-2
        expect(init.headers['Content-Type']).toBeUndefined();
        // body should be FormData
        expect(init.body).toBeInstanceOf(FormData);
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdWorkersai(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('missing account_id → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ body: { account_id: '' }, onFetch: fetchMock });
        await dispatchSdWorkersai(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('workersai blew up', { status: 500 })),
        });
        await dispatchSdWorkersai(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('workersai blew up');
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
        const p = dispatchSdWorkersai(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
