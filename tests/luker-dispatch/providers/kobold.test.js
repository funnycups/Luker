// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchKobold } from '../../../src/luker-dispatch/providers/kobold.js';

function fakeCtx({ body = {}, onFetch, signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attachedInspections = [];
    return {
        body: {
            api_server: 'http://127.0.0.1:5001',
            prompt: 'hello',
            streaming: false,
            can_abort: false,
            max_context_length: 2048,
            max_length: 128,
            gui_settings: false,
            temperature: 0.7,
            rep_pen: 1.1,
            ...body,
        },
        user: { handle: 'alice', directories: {}, profile: { handle: 'alice' } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async () => new Response(JSON.stringify({
            results: [{ text: 'hello back' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })),
        secrets: {
            read: jest.fn(() => ''),
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

describe('dispatchKobold', () => {
    test('non-streaming: emits chunk with JSON body then end', async () => {
        const ctx = fakeCtx();
        await dispatchKobold(ctx);

        const kinds = ctx._emitted.map(e => e.kind);
        expect(kinds).toContain('chunk');
        expect(kinds[kinds.length - 1]).toBe('end');

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(chunkToStr(chunks[0]));
        expect(parsed.results[0].text).toBe('hello back');

        expect(ctx.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:5001/v1/generate');
        expect(init.method).toBe('POST');
        const sent = JSON.parse(init.body);
        expect(sent.prompt).toBe('hello');
        expect(sent.temperature).toBe(0.7);
    });

    test('streaming: forwards raw SSE chunks then end', async () => {
        const sseBody =
            'event: message\ndata: {"token":"he"}\n\n' +
            'event: message\ndata: {"token":"llo"}\n\n';
        const ctx = fakeCtx({
            body: { streaming: true },
            onFetch: jest.fn(async () => new Response(sseBody, {
                status: 200, headers: { 'content-type': 'text/event-stream' },
            })),
        });
        await dispatchKobold(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks.length).toBeGreaterThan(0);
        const decoded = chunks.map(chunkToStr).join('');
        expect(decoded).toContain('"token":"he"');
        expect(decoded).toContain('"token":"llo"');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');

        // Streaming URL suffix.
        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:5001/extra/generate/stream');
    });

    test('localhost → 127.0.0.1 rewrite', async () => {
        const ctx = fakeCtx({
            body: { api_server: 'http://localhost:5001' },
        });
        await dispatchKobold(ctx);
        const [url] = ctx.fetch.mock.calls[0];
        expect(String(url)).toBe('http://127.0.0.1:5001/v1/generate');
    });

    test('retry on 403: retries up to success', async () => {
        let calls = 0;
        const fetchMock = jest.fn(async () => {
            calls++;
            if (calls <= 2) {
                const err = new Error('busy');
                err.status = 403;
                throw err;
            }
            return new Response(JSON.stringify({ results: [{ text: 'finally' }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchKobold(ctx);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const chunk = ctx._emitted.find(e => e.kind === 'chunk');
        expect(chunk).toBeDefined();
        const parsed = JSON.parse(chunkToStr(chunk));
        expect(parsed.results[0].text).toBe('finally');
    }, 30000);

    test('can_abort → POST /extra/abort fired on signal abort', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((url, init) => {
            if (String(url).includes('/extra/abort')) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            // The primary /v1/generate call hangs until aborted.
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener?.('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        const ctx = fakeCtx({
            signal: ac.signal,
            body: { can_abort: true },
            onFetch: fetchMock,
        });
        const p = dispatchKobold(ctx);
        await new Promise(r => setImmediate(r));
        ac.abort();
        await p;
        await new Promise(r => setImmediate(r));

        const abortCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/extra/abort'));
        expect(abortCalls).toHaveLength(1);
        const [abortUrl, abortInit] = abortCalls[0];
        expect(String(abortUrl)).toBe('http://127.0.0.1:5001/extra/abort');
        expect(abortInit.method).toBe('POST');
    });

    test('upstream error reshape: {"detail":{"msg":"foo"}} → emit.error contains foo', async () => {
        const ctx = fakeCtx({
            onFetch: jest.fn(async () => new Response(JSON.stringify({
                detail: { msg: 'foo bar upstream complaint' },
            }), { status: 400, headers: { 'content-type': 'application/json' } })),
        });
        await dispatchKobold(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].error.message).toContain('foo bar upstream complaint');
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx.inspection.fail).toHaveBeenCalled();
    });

    test('ctx.signal abort mid-request: emits error, no chunk', async () => {
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
        const p = dispatchKobold(ctx);
        setImmediate(() => ac.abort());
        await p;
        expect(ctx._emitted.filter(e => e.kind === 'chunk')).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error').length).toBeGreaterThan(0);
    });
});
