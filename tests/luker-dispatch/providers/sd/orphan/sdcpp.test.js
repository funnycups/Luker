// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdCpp } from '../../../../../src/luker-dispatch/providers/sd/sdcpp.js';

function fakeCtx({ body = {}, onFetch, signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: {
            url: 'http://127.0.0.1:7861',
            model: 'sd-v1-5',
            prompt: 'a cat',
            negative_prompt: '',
            width: 512,
            height: 512,
            steps: 20,
            cfg_scale: 7,
            seed: -1,
            batch_size: 1,
            sampler_name: 'euler',
            scheduler: 'karras',
            clip_skip: 1,
            ...body,
        },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({ images: ['b64...'] }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: { read: jest.fn(() => '') },
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

describe('dispatchSdCpp', () => {
    test('happy path: POST to /sdapi/v1/txt2img, clip_skip=1 stripped, JSON forwarded', async () => {
        const ctx = fakeCtx();
        await dispatchSdCpp(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.images[0]).toBe('b64...');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');

        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:7861/sdapi/v1/txt2img');
        const sent = JSON.parse(init.body);
        // clip_skip=1 must be stripped
        expect(sent.clip_skip).toBeUndefined();
        expect(sent.prompt).toBe('a cat');
        expect(init.signal).toBeDefined();
    });

    test('clip_skip > 1 is preserved', async () => {
        const ctx = fakeCtx({ body: { clip_skip: 2 } });
        await dispatchSdCpp(ctx);
        const [, init] = ctx.fetch.mock.calls[0];
        const sent = JSON.parse(init.body);
        expect(sent.clip_skip).toBe(2);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('sdcpp blew up', { status: 500 })),
        });
        await dispatchSdCpp(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('sdcpp blew up');
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
        const p = dispatchSdCpp(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
