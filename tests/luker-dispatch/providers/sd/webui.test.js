// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { dispatchSdWebui } from '../../../../src/luker-dispatch/providers/sd/webui.js';

function fakeCtx({ body = {}, onFetch, signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const attached = [];
    const handle = `sd-webui-user-${Math.random().toString(36).slice(2)}`;
    return {
        body: {
            url: 'http://127.0.0.1:7860',
            prompt: 'a cat',
            negative_prompt: '',
            width: 512,
            height: 512,
            steps: 20,
            auth: '',
            ...body,
        },
        user: { handle, directories: {}, profile: { handle } },
        signal: signal || ac.signal,
        fetch: onFetch || jest.fn(async (url) => {
            if (String(url).endsWith('/sdapi/v1/options')) {
                return new Response(JSON.stringify({ sd_model_checkpoint: 'x' }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ images: ['b64...'] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }),
        secrets: { read: jest.fn(() => '') },
        generation: {
            startJob: jest.fn(() => null),
            appendEvent: jest.fn(),
            hasActiveKeepAliveJob: jest.fn(() => false),
        },
        inspection: {
            start: jest.fn(),
            attach: jest.fn((url) => attached.push(String(url))),
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
        _attached: attached,
    };
}

const chunkToStr = (c) => Buffer.from(c.data).toString('utf8');

describe('dispatchSdWebui', () => {
    test('non-stream: emits JSON chunk then end', async () => {
        const ctx = fakeCtx();
        await dispatchSdWebui(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const parsed = JSON.parse(chunkToStr(chunks[0]));
        expect(parsed.images[0]).toBe('b64...');
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
        expect(ctx.inspection.startImage).toHaveBeenCalled();
        expect(ctx.inspection.completeImage).toHaveBeenCalled();
    });

    test('sends Basic auth header when body.auth set', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/sdapi/v1/options')) {
                return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ images: ['b'] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
        const ctx = fakeCtx({
            body: { auth: 'user:pass' },
            onFetch: fetchMock,
        });
        await dispatchSdWebui(ctx);

        const txt2imgCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sdapi/v1/txt2img'));
        expect(txt2imgCall).toBeDefined();
        const [, init] = txt2imgCall;
        expect(String(init.headers.Authorization)).toMatch(/^Basic /);
        expect(init.method).toBe('POST');
    });

    test('forge probe: when options lacks forge_preset, strips override_settings.forge_additional_modules', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/sdapi/v1/options')) {
                // Not Forge — no `forge_preset` key.
                return new Response(JSON.stringify({ sd_model_checkpoint: 'x' }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ images: ['b'] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
        const ctx = fakeCtx({
            body: {
                override_settings: {
                    forge_additional_modules: ['x.safetensors'],
                    sd_model_checkpoint: 'sd15',
                },
            },
            onFetch: fetchMock,
        });
        await dispatchSdWebui(ctx);

        const txt2imgCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sdapi/v1/txt2img'));
        expect(txt2imgCall).toBeDefined();
        const [, init] = txt2imgCall;
        const sent = JSON.parse(init.body);
        expect(sent.override_settings.forge_additional_modules).toBeUndefined();
        expect(sent.override_settings.sd_model_checkpoint).toBe('sd15');

        // Original ctx.body should not be mutated.
        expect(ctx.body.override_settings.forge_additional_modules).toEqual(['x.safetensors']);
    });

    test('forge probe: when options has forge_preset, keeps forge_additional_modules', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/sdapi/v1/options')) {
                return new Response(JSON.stringify({ forge_preset: 'sd' }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            return new Response(JSON.stringify({ images: ['b'] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        });
        const ctx = fakeCtx({
            body: {
                override_settings: { forge_additional_modules: ['x.safetensors'] },
            },
            onFetch: fetchMock,
        });
        await dispatchSdWebui(ctx);

        const txt2imgCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sdapi/v1/txt2img'));
        const [, init] = txt2imgCall;
        const sent = JSON.parse(init.body);
        expect(sent.override_settings.forge_additional_modules).toEqual(['x.safetensors']);
    });

    test('abort → POST /sdapi/v1/interrupt fired', async () => {
        const ac = new AbortController();
        const fetchMock = jest.fn((url, init) => {
            if (String(url).endsWith('/sdapi/v1/options')) {
                return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
            }
            if (String(url).endsWith('/sdapi/v1/interrupt')) {
                return Promise.resolve(new Response('{}', { status: 200 }));
            }
            // txt2img hangs until aborted.
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener?.('abort', () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        const ctx = fakeCtx({ signal: ac.signal, onFetch: fetchMock });
        const p = dispatchSdWebui(ctx);
        await new Promise(r => setImmediate(r));
        ac.abort();
        await p;

        const interruptCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sdapi/v1/interrupt'));
        expect(interruptCalls.length).toBeGreaterThanOrEqual(1);
        expect(interruptCalls[0][1].method).toBe('POST');
    });

    test('upstream 500 → head+chunk+end with raw error body (no emit.error)', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/sdapi/v1/options')) {
                return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response('nope', { status: 500 });
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdWebui(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(0);

        const heads = ctx._emitted.filter(e => e.kind === 'head');
        expect(heads).toHaveLength(1);
        expect(heads[0].data.status).toBe(500);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        expect(new TextDecoder().decode(chunks[0].data)).toBe('nope');

        expect(ctx._emitted.filter(e => e.kind === 'end')).toHaveLength(1);
        expect(ctx.inspection.failImage).toHaveBeenCalled();
        expect(ctx.inspection.failImage.mock.calls[0][1]).toBe(500);
    });
});
