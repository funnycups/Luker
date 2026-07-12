// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdZai } from '../../../../../src/luker-dispatch/providers/sd/zai.js';

function fakeCtx({ body = {}, onFetch, secret = 'zai-key', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    return {
        body: { model: 'cogview-3', prompt: 'a cat', size: '1024x1024', quality: 'standard', ...body },
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

describe('dispatchSdZai', () => {
    test('happy path (.z.ai host): emits {image, format}', async () => {
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (s === 'https://api.z.ai/api/paas/v4/images/generations') {
                return new Response(JSON.stringify({ data: [{ url: 'https://cdn.z.ai/x.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(Buffer.from([1, 2, 3]), { status: 200 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdZai(ctx);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.image).toBe(Buffer.from([1, 2, 3]).toString('base64'));
        expect(payload.format).toBe('png');
        const [, firstInit] = fetchMock.mock.calls[0];
        expect(firstInit.headers.Authorization).toBe('Bearer zai-key');
        expect(firstInit.signal).toBeDefined();
    });

    test('.ufileos.com host also accepted', async () => {
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (s.includes('paas')) {
                return new Response(JSON.stringify({ data: [{ url: 'https://obj.ufileos.com/x.jpg' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(Buffer.from([9]), { status: 200 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdZai(ctx);
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(1);
    });

    test('foreign hostname rejected (whitelist guard)', async () => {
        const fetchMock = jest.fn(async () => new Response(JSON.stringify({ data: [{ url: 'https://evil.example.com/x.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdZai(ctx);
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toMatch(/hostname/i);
    });

    test('404 retry then success', async () => {
        let imgAttempts = 0;
        const fetchMock = jest.fn(async (url) => {
            const s = String(url);
            if (s.includes('paas')) {
                return new Response(JSON.stringify({ data: [{ url: 'https://cdn.z.ai/x.png' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            imgAttempts++;
            if (imgAttempts === 1) return new Response('nope', { status: 404 });
            return new Response(Buffer.from([1]), { status: 200 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdZai(ctx);
        expect(imgAttempts).toBeGreaterThanOrEqual(2);
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(1);
    }, 15000);

    test('missing API key → emit.error, no fetch', async () => {
        const fetchMock = jest.fn();
        const ctx = fakeCtx({ secret: '', onFetch: fetchMock });
        await dispatchSdZai(ctx);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });

    test('generate HTTP 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const fetchMock = jest.fn(async () => new Response('zai blew up', { status: 500 }));
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdZai(ctx);

        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(0);
        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);
        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('zai blew up');
        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.failImage).toHaveBeenCalled();
        expect(ctx.inspection.failImage.mock.calls[0][1]).toBe(500);
    });
});
