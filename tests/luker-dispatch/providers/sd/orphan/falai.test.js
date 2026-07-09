// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdFalai } from '../../../../../src/luker-dispatch/providers/sd/falai.js';

function fakeCtx({ body = {}, onFetch, secret = 'falai-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'flux/schnell', prompt: 'a cat', width: 512, height: 512, steps: 20, guidance: 3, seed: 1, ...body },
        user: { handle: 'u', directories: {}, profile: { handle: 'u' } },
        signal: signal || ac.signal,
        fetch: onFetch,
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

describe('dispatchSdFalai', () => {
    test('happy path: submit → COMPLETED → emit {image}, uses Key auth scheme', async () => {
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (/queue\.fal\.run\/fal-ai\/flux\/schnell$/.test(s)) {
                return new Response(JSON.stringify({ status_url: 'https://queue.fal.run/status/1' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://queue.fal.run/status/1') {
                return new Response(JSON.stringify({ status: 'COMPLETED', response_url: 'https://queue.fal.run/result/1' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://queue.fal.run/result/1') {
                return new Response(JSON.stringify({ detail: null, images: [{ url: 'https://cdn.fal.ai/x.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://cdn.fal.ai/x.png') {
                return new Response(Buffer.from([7, 8, 9]), { status: 200 });
            }
            return new Response('nope', { status: 500 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdFalai(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe(Buffer.from([7, 8, 9]).toString('base64'));
        const [, firstInit] = fetchMock.mock.calls[0];
        expect(firstInit.headers.Authorization).toBe('Key falai-key');
        expect(firstInit.signal).toBeDefined();
    }, 15000);

    test('multi-attempt: IN_QUEUE → IN_PROGRESS → COMPLETED', async () => {
        let statusCount = 0;
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (s.endsWith('flux/schnell')) {
                return new Response(JSON.stringify({ status_url: 'https://queue.fal.run/status/2' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://queue.fal.run/status/2') {
                statusCount++;
                if (statusCount === 1) return new Response(JSON.stringify({ status: 'IN_QUEUE' }), { status: 200, headers: { 'content-type': 'application/json' } });
                if (statusCount === 2) return new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200, headers: { 'content-type': 'application/json' } });
                return new Response(JSON.stringify({ status: 'COMPLETED', response_url: 'https://queue.fal.run/result/2' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://queue.fal.run/result/2') {
                return new Response(JSON.stringify({ detail: null, images: [{ url: 'https://cdn.fal.ai/y.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(Buffer.from([1]), { status: 200 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdFalai(ctx);
        expect(statusCount).toBeGreaterThanOrEqual(3);
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(1);
    }, 15000);

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdFalai(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
