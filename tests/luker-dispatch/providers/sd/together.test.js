// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdTogether } from '../../../../src/luker-dispatch/providers/sd/together.js';

function fakeCtx({ body = {}, onFetch, secret = 'sk-together-x', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const handle = `sd-together-user-${Math.random().toString(36).slice(2)}`;
    return {
        body: {
            prompt: 'a cat',
            negative_prompt: '',
            height: 512,
            width: 512,
            model: 'stabilityai/stable-diffusion-xl-base-1.0',
            steps: 20,
            seed: -1,
            ...body,
        },
        user: { handle, directories: {}, profile: { handle } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            data: [{ b64_json: 'ZmFrZQ==' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
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

describe('dispatchSdTogether', () => {
    test('non-stream: emits {format:"jpg", data:<b64>} chunk then end', async () => {
        const ctx = fakeCtx();
        await dispatchSdTogether(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('jpg');
        expect(payload.data).toBe('ZmFrZQ==');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
        expect(ctx.inspection.completeImage).toHaveBeenCalled();

        // Bearer key is sent.
        const [, init] = ctx.fetch.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer sk-together-x');
        // signal is threaded (Task 7 abort fix).
        expect(init.signal).toBeDefined();
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdTogether(ctx);

        expect(fetchMock).not.toHaveBeenCalled();
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0].error.message).toMatch(/key/i);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('together blew up', { status: 500 })),
        });
        await dispatchSdTogether(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('together blew up');
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
        const p = dispatchSdTogether(ctx);
        setImmediate(() => ac.abort());
        await p;

        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
