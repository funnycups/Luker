// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdHuggingface } from '../../../../../src/luker-dispatch/providers/sd/huggingface.js';

function fakeCtx({ body = {}, onFetch, secret = 'hf-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'runwayml/stable-diffusion-v1-5', prompt: 'a cat', ...body },
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

describe('dispatchSdHuggingface', () => {
    test('happy path: POST to inference URL, emits {image}', async () => {
        const ctx = fakeCtx();
        await dispatchSdHuggingface(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe(Buffer.from([1, 2, 3]).toString('base64'));
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api-inference.huggingface.co/models/runwayml/stable-diffusion-v1-5');
        expect(init.headers.Authorization).toBe('Bearer hf-key');
        expect(init.signal).toBeDefined();
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdHuggingface(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('huggingface blew up', { status: 500 })),
        });
        await dispatchSdHuggingface(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('huggingface blew up');
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
        const p = dispatchSdHuggingface(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
