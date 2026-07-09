// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdComfyRunPod } from '../../../../../src/luker-dispatch/providers/sd/comfyrunpod.js';

function fakeCtx({ body = {}, onFetch, secret = 'sk-runpod-x', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: {
            url: 'https://api.runpod.ai/v2/xyz',
            prompt: JSON.stringify({ prompt: { foo: 'bar' } }),
            ...body,
        },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async (url, init) => {
            const s = String(url);
            if (s.endsWith('/run')) {
                return new Response(JSON.stringify({ id: 'job-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s.includes('/status/')) {
                return new Response(JSON.stringify({ output: { images: [{ filename: 'x.png', data: 'ZmFrZQ==' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('nope', { status: 500 });
        }),
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
        _abortController: ac,
    };
}

const chunkToStr = (c) => Buffer.from(c.data).toString('utf8');

describe('dispatchSdComfyRunPod', () => {
    test('happy path: submits run, polls status, emits {format,data}', async () => {
        const ctx = fakeCtx();
        await dispatchSdComfyRunPod(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('png');
        expect(payload.data).toBe('ZmFrZQ==');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
        expect(ctx.inspection.completeImage).toHaveBeenCalledWith({ format: 'png' });

        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer sk-runpod-x');
        expect(init.signal).toBeDefined();
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdComfyRunPod(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('polls multiple times until output arrives', async () => {
        let statusCalls = 0;
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (s.endsWith('/run')) {
                return new Response(JSON.stringify({ id: 'job-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s.includes('/status/')) {
                statusCalls++;
                if (statusCalls < 3) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
                return new Response(JSON.stringify({ output: { images: [{ filename: 'x.jpg', data: 'aGVsbG8=' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('nope', { status: 500 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdComfyRunPod(ctx);
        expect(statusCalls).toBeGreaterThanOrEqual(3);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('jpg');
    });

    test('abort mid-request: emit.error, no chunk', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((_url, init) => new Promise((_r, reject) => {
            init.signal?.addEventListener?.('abort', () => {
                const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
            });
        }));
        const ctx = fakeCtx({ signal: ac.signal, onFetch: fetchMock });
        const p = dispatchSdComfyRunPod(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
