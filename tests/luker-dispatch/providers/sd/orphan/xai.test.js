// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdXai } from '../../../../../src/luker-dispatch/providers/sd/xai.js';

function fakeCtx({ body = {}, onFetch, secret = 'xai-key', signal, respData } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'grok-2-image', prompt: 'a cat', aspect_ratio: '1:1', resolution: '1024x1024', ...body },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: respData || 'ZmFrZQ==' }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
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

describe('dispatchSdXai', () => {
    test('happy path (raw base64): emits {image, format:"jpg"}', async () => {
        const ctx = fakeCtx();
        await dispatchSdXai(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe('ZmFrZQ==');
        expect(payload.format).toBe('jpg');
        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer xai-key');
        expect(init.signal).toBeDefined();
    });

    test('data URL response: format derived from mime type', async () => {
        const ctx = fakeCtx({ respData: 'data:image/png;base64,cG5n' });
        await dispatchSdXai(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe('cG5n');
        expect(payload.format).toBe('png');
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdXai(ctx);
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
        const p = dispatchSdXai(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
