// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdStability } from '../../../../src/luker-dispatch/providers/sd/stability.js';

function fakeCtx({ body = {}, onFetch, secret = 'sk-stab-x', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const handle = `sd-stab-user-${Math.random().toString(36).slice(2)}`;
    return {
        body: {
            model: 'stable-image-core',
            payload: { prompt: 'a cat', aspect_ratio: '1:1' },
            ...body,
        },
        user: { handle, directories: {}, profile: { handle } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(Buffer.from([137, 80, 78, 71]), {
            status: 200, headers: { 'content-type': 'image/png' },
        })),
        secrets: { read: jest.fn(() => secret) },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn(),
            fail: jest.fn(),
            startImage: jest.fn(),
            completeImage: jest.fn(),
            failImage: jest.fn(),
            abort: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
        _abortController: ac,
    };
}

const chunkToStr = (c) => Buffer.from(c.data).toString('utf8');

describe('dispatchSdStability', () => {
    test('stable-image-ultra → v2beta/ultra endpoint, raw base64 text chunk', async () => {
        const ctx = fakeCtx({ body: { model: 'stable-image-ultra' } });
        await dispatchSdStability(ctx);

        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.stability.ai/v2beta/stable-image/generate/ultra');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        // Chunk is UTF-8 bytes of a base64 STRING (NOT JSON).
        const text = chunkToStr(chunks[0]);
        // Should be plain base64, no braces / colons.
        expect(text).not.toMatch(/[{}:]/);
        expect(Buffer.from(text, 'base64')).toEqual(Buffer.from([137, 80, 78, 71]));
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
    });

    test('stable-image-core → v2beta/core endpoint', async () => {
        const ctx = fakeCtx({ body: { model: 'stable-image-core' } });
        await dispatchSdStability(ctx);

        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.stability.ai/v2beta/stable-image/generate/core');
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(1);
    });

    test('stable-diffusion-3 → v2beta/sd3 endpoint', async () => {
        const ctx = fakeCtx({ body: { model: 'stable-diffusion-3' } });
        await dispatchSdStability(ctx);

        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.stability.ai/v2beta/stable-image/generate/sd3');
    });

    test('abort mid-request: emit.error, no chunk (Task 7 fix — was zero-abort)', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((_url, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener?.('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }));
        const ctx = fakeCtx({ signal: ac.signal, onFetch: fetchMock });
        // Confirm signal is forwarded.
        const p = dispatchSdStability(ctx);
        setImmediate(() => ac.abort());
        await p;

        // Signal was actually threaded through.
        const [, init] = fetchMock.mock.calls[0];
        expect(init.signal).toBe(ac.signal);
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
