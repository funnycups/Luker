// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdDrawthings } from '../../../../src/luker-dispatch/providers/sd/drawthings.js';

function fakeCtx({ body = {}, onFetch, signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const handle = `sd-drawthings-user-${Math.random().toString(36).slice(2)}`;
    return {
        body: {
            url: 'http://127.0.0.1:7860',
            prompt: 'a cat',
            auth: '',
            steps: 20,
            ...body,
        },
        user: { handle, directories: {}, profile: { handle } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            images: ['b64...'],
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: { read: jest.fn(() => '') },
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

describe('dispatchSdDrawthings', () => {
    test('non-stream: POST to /sdapi/v1/txt2img, url/auth stripped from body, emits JSON chunk', async () => {
        const ctx = fakeCtx({ body: { auth: 'user:pass' } });
        await dispatchSdDrawthings(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.images[0]).toBe('b64...');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');

        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img');
        expect(init.method).toBe('POST');
        expect(String(init.headers.Authorization)).toMatch(/^Basic /);

        // url/auth must not appear in the serialised upstream body.
        const sent = JSON.parse(init.body);
        expect(sent.url).toBeUndefined();
        expect(sent.auth).toBeUndefined();
        expect(sent.prompt).toBe('a cat');

        // signal is threaded (Task 7 abort fix).
        expect(init.signal).toBeDefined();
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('drawthings blew up', { status: 500 })),
        });
        await dispatchSdDrawthings(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('drawthings blew up');
        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.failImage).toHaveBeenCalled();
        expect(ctx.inspection.failImage.mock.calls[0][1]).toBe(500);
    });

    test('abort mid-request: emit.error, no chunk', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((_url, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener?.('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }));
        const ctx = fakeCtx({ signal: ac.signal, onFetch: fetchMock });
        const p = dispatchSdDrawthings(ctx);
        setImmediate(() => ac.abort());
        await p;

        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
