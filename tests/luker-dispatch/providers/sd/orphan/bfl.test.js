// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdBfl } from '../../../../../src/luker-dispatch/providers/sd/bfl.js';

function fakeCtx({ body = {}, onFetch, secret = 'bfl-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'flux-pro', prompt: 'a cat', width: 1024, height: 1024, steps: 20, guidance: 3, seed: 42, ...body },
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

// jest.useFakeTimers doesn't play well with node-fetch Response promises;
// tests use a small number of real 2500ms polls. testTimeout=15000 gives
// ~5 polls of headroom which is plenty.

describe('dispatchSdBfl', () => {
    test('happy path: submit → poll → Ready → emit {image}', async () => {
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (/api\.bfl\.ml\/v1\/flux-pro$/.test(s)) {
                return new Response(JSON.stringify({ id: 'task-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s.includes('/get_result')) {
                return new Response(JSON.stringify({ status: 'Ready', result: { sample: 'https://cdn.bfl.ml/x.jpg' } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://cdn.bfl.ml/x.jpg') {
                return new Response(Buffer.from([1, 2, 3]), { status: 200 });
            }
            return new Response('nope', { status: 500 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdBfl(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe(Buffer.from([1, 2, 3]).toString('base64'));
        const [firstUrl, firstInit] = fetchMock.mock.calls[0];
        expect(String(firstUrl)).toBe('https://api.bfl.ml/v1/flux-pro');
        expect(firstInit.headers['x-key']).toBe('bfl-key');
        expect(firstInit.signal).toBeDefined();
    }, 15000);

    test('multi-attempt: Pending → Ready', async () => {
        let pollCount = 0;
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (/api\.bfl\.ml\/v1\/flux-pro$/.test(s)) {
                return new Response(JSON.stringify({ id: 'task-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s.includes('/get_result')) {
                pollCount++;
                if (pollCount === 1) return new Response(JSON.stringify({ status: 'Pending' }), { status: 200, headers: { 'content-type': 'application/json' } });
                return new Response(JSON.stringify({ status: 'Ready', result: { sample: 'https://cdn.bfl.ml/y.jpg' } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s === 'https://cdn.bfl.ml/y.jpg') {
                return new Response(Buffer.from([4, 5, 6]), { status: 200 });
            }
            return new Response('nope', { status: 500 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdBfl(ctx);
        expect(pollCount).toBeGreaterThanOrEqual(2);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
    }, 15000);

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdBfl(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('-ultra model: adds aspect_ratio, drops steps/guidance/width/height', async () => {
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (s.endsWith('flux-pro-1.1-ultra')) {
                return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (s.includes('/get_result')) {
                return new Response(JSON.stringify({ status: 'Ready', result: { sample: 'https://cdn.bfl.ml/u.jpg' } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(Buffer.from([1]), { status: 200 });
        });
        const ctx = fakeCtx({ body: { model: 'flux-pro-1.1-ultra', width: 1024, height: 768 }, onFetch: fetchMock });
        await dispatchSdBfl(ctx);
        const [, firstInit] = fetchMock.mock.calls[0];
        const sent = JSON.parse(firstInit.body);
        expect(sent.aspect_ratio).toBeDefined();
        expect(sent.steps).toBeUndefined();
        expect(sent.guidance).toBeUndefined();
        expect(sent.width).toBeUndefined();
        expect(sent.height).toBeUndefined();
    }, 15000);
});
