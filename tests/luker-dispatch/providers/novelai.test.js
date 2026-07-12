// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchNovelAI } from '../../../src/luker-dispatch/providers/novelai.js';

function fakeCtx({ body = {}, onFetch, secret = 'nai-fake-token', signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
    return {
        body: {
            model: 'clio-v1',
            input: 'hello',
            streaming: false,
            max_length: 128,
            temperature: 0.7,
            ...body,
        },
        user: { handle: 'alice', directories: {}, profile: { handle: 'alice' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            output: 'hello back',
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: {
            read: jest.fn(() => secret),
        },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn((url) => attachedInspections.push(url)),
            fail: jest.fn(),
        },
        emit: {
            head: (h) => emitted.push({ kind: 'head', data: h }),
            chunk: (b) => emitted.push({ kind: 'chunk', data: b }),
            end: () => emitted.push({ kind: 'end' }),
            error: (e) => emitted.push({ kind: 'error', error: e }),
        },
        _emitted: emitted,
        _abortController: ac,
        _attachedInspections: attachedInspections,
    };
}

function chunkToStr(c) {
    return Buffer.from(c.data).toString('utf8');
}

describe('dispatchNovelAI', () => {
    test('non-streaming, kayra model → TEXT_NOVELAI URL', async () => {
        const ctx = fakeCtx({ body: { model: 'kayra-v1' } });
        await dispatchNovelAI(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(chunkToStr(chunks[0]));
        expect(parsed.output).toBe('hello back');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://text.novelai.net/ai/generate');
        expect(init.headers.Authorization).toBe('Bearer nai-fake-token');
        expect(init.method).toBe('POST');
    });

    test('non-streaming, default (non-kayra/erato) model → API_NOVELAI URL', async () => {
        const ctx = fakeCtx({ body: { model: 'euterpe-v2' } });
        await dispatchNovelAI(ctx);

        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://api.novelai.net/ai/generate');
    });

    test('streaming: forwards raw SSE chunks then end (kayra)', async () => {
        const sseBody =
            'event: newToken\ndata: {"token":"he"}\n\n' +
            'event: newToken\ndata: {"token":"llo"}\n\n';
        const ctx = fakeCtx({
            body: { streaming: true, model: 'kayra-v1' },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })),
        });
        await dispatchNovelAI(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(chunkToStr).join('');
        expect(decoded).toContain('"token":"he"');
        expect(decoded).toContain('"token":"llo"');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');

        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('https://text.novelai.net/ai/generate-stream');
    });

    test('missing API key emits error, no fetch', async () => {
        const ctx = fakeCtx({ secret: '' });
        await dispatchNovelAI(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('NovelAI Access Token is missing');
        expect(ctx.fetch).not.toHaveBeenCalled();
    });

    test('eos_token_id special-case for prefix theme_textadventure', async () => {
        // kayra → 49405
        const ctxKayra = fakeCtx({
            body: { model: 'kayra-v1', prefix: 'theme_textadventure' },
        });
        await dispatchNovelAI(ctxKayra);
        const [, kInit] = ctxKayra.fetch.mock.calls[0];
        const kSent = JSON.parse(kInit.body);
        expect(kSent.parameters.eos_token_id).toBe(49405);

        // erato → 29
        const ctxErato = fakeCtx({
            body: { model: 'llama-3-erato-v1', prefix: 'theme_textadventure' },
        });
        await dispatchNovelAI(ctxErato);
        const [, eInit] = ctxErato.fetch.mock.calls[0];
        const eSent = JSON.parse(eInit.body);
        expect(eSent.parameters.eos_token_id).toBe(29);

        // non-textadventure prefix → no eos_token_id
        const ctxOther = fakeCtx({
            body: { model: 'kayra-v1', prefix: 'style_fantasy' },
        });
        await dispatchNovelAI(ctxOther);
        const [, oInit] = ctxOther.fetch.mock.calls[0];
        const oSent = JSON.parse(oInit.body);
        expect(oSent.parameters.eos_token_id).toBeUndefined();
    });

    test('upstream non-2xx: surfaces status+body via head+chunk+end (no emit.error)', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify({
                message: 'Unauthorized access token',
            }), { status: 401, headers: { 'content-type': 'application/json' } })),
        });
        await dispatchNovelAI(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(401);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const decoded = new TextDecoder().decode(chunks[0].data);
        const parsed = JSON.parse(decoded);
        expect(parsed.message).toBe('Unauthorized access token');

        const ends = ctx._emitted.filter(e => e.kind === 'end');
        expect(ends).toHaveLength(1);

        expect(ctx.inspection.fail).toHaveBeenCalledTimes(1);
        expect(ctx.inspection.fail.mock.calls[0][1]).toBe(401);
    });

    test('ctx.signal abort: emits error, no chunk', async () => {
        const ac = new AbortController();
        const ctx = fakeCtx({
            signal: ac.signal,
            onFetch: jest.fn((_url, init) => new Promise((_resolve, reject) => {
                init.signal?.addEventListener?.('abort', () => {
                    const err = new Error('The user aborted a request.');
                    err.name = 'AbortError';
                    reject(err);
                });
            })),
        });
        const p = dispatchNovelAI(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
