// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdPollinations } from '../../../../src/luker-dispatch/providers/sd/pollinations.js';

function fakeCtx({ body = {}, onFetch, secret = 'sk-poll-x', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const handle = `sd-poll-user-${Math.random().toString(36).slice(2)}`;
    return {
        body: {
            prompt: 'a cat',
            model: 'flux',
            negative_prompt: '',
            seed: -1,
            width: 512,
            height: 512,
            enhance: false,
            ...body,
        },
        user: { handle, directories: {}, profile: { handle } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(Buffer.from([1, 2, 3, 4]), {
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

describe('dispatchSdPollinations', () => {
    test('non-stream: GET pollinations.ai/image/... emits {image,format} chunk', async () => {
        const ctx = fakeCtx();
        await dispatchSdPollinations(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('png');
        expect(Buffer.from(payload.image, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
        expect(ctx.inspection.completeImage).toHaveBeenCalled();

        const [url, init] = ctx.fetch.mock.calls[0];
        const asStr = String(url);
        expect(asStr).toMatch(/^https:\/\/gen\.pollinations\.ai\/image\/a%20cat/);
        expect(asStr).toMatch(/model=flux/);
        expect(init.method).toBe('GET');
        expect(init.headers.Authorization).toBe('Bearer sk-poll-x');
        // signal is threaded (Task 7 abort fix).
        expect(init.signal).toBeDefined();
    });

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdPollinations(ctx);

        expect(fetchMock).not.toHaveBeenCalled();
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0].error.message).toMatch(/key/i);
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response('pollinations blew up', { status: 500 })),
        });
        await dispatchSdPollinations(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('pollinations blew up');
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
        const p = dispatchSdPollinations(ctx);
        setImmediate(() => ac.abort());
        await p;

        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
