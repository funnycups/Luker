// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdElectronHub } from '../../../../../src/luker-dispatch/providers/sd/electronhub.js';

function fakeCtx({ body = {}, onFetch, secret = 'eh-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'dall-e-3', prompt: 'a cat', size: '1024x1024', quality: 'hd', ...body },
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

describe('dispatchSdElectronHub', () => {
    test('happy path: emits {image}, forwards size/quality', async () => {
        const ctx = fakeCtx();
        await dispatchSdElectronHub(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe('ZmFrZQ==');
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.electronhub.ai/v1/images/generations');
        const sent = JSON.parse(init.body);
        expect(sent.size).toBe('1024x1024');
        expect(sent.quality).toBe('hd');
        expect(sent.response_format).toBe('b64_json');
        expect(init.headers.Authorization).toBe('Bearer eh-key');
        expect(init.signal).toBeDefined();
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdElectronHub(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('electronhub blew up', { status: 500 })),
        });
        await dispatchSdElectronHub(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('electronhub blew up');
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
        const p = dispatchSdElectronHub(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
