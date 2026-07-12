// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
    dispatchSdComfy,
    __setWebSocketForTest,
    __resetWebSocketForTest,
} from '../../../../src/luker-dispatch/providers/sd/comfy.js';

// Fake WebSocket that stands in for the upstream `ws` module. Injected via
// the module's __setWebSocketForTest hook — this avoids ESM mock friction
// (`ws` is CJS and does not play cleanly with jest.unstable_mockModule).
class FakeWebSocket extends EventEmitter {
    static instances = [];
    static onNew = null;
    constructor(url) {
        super();
        this.url = url;
        this.terminated = false;
        this.closed = false;
        FakeWebSocket.instances.push(this);
        if (FakeWebSocket.onNew) {
            setImmediate(() => FakeWebSocket.onNew(this));
        }
    }
    terminate() { this.terminated = true; }
    close(code = 1000) {
        if (this.closed) return;
        this.closed = true;
        setImmediate(() => this.emit('close', code));
    }
}

function fakeCtx({ body = {}, onFetch, signal } = {}) {
    const emitted = [];
    const ac = new AbortController();
    const closeHandlers = new Set();
    const handle = `sd-comfy-user-${Math.random().toString(36).slice(2)}`;
    return {
        body: {
            url: 'http://127.0.0.1:8188',
            prompt: JSON.stringify({ '1': { class_type: 'KSampler' } }),
            auth: '',
            ...body,
        },
        user: { handle, directories: {}, profile: { handle } },
        signal: signal || ac.signal,
        fetch: onFetch,
        abort: jest.fn(() => ac.abort()),
        onRequestClose: jest.fn((cb) => {
            closeHandlers.add(cb);
            return () => closeHandlers.delete(cb);
        }),
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
        _closeHandlers: closeHandlers,
    };
}

const chunkToStr = (c) => Buffer.from(c.data).toString('utf8');

const PROMPT_ID = 'p-test-1';

function buildStandardFetch({ interruptOnPromptId } = {}) {
    return jest.fn(async (url) => {
        const u = String(url);
        if (u.endsWith('/prompt')) {
            return new Response(JSON.stringify({ prompt_id: PROMPT_ID }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }
        if (u.endsWith('/interrupt')) {
            if (interruptOnPromptId) interruptOnPromptId();
            return new Response('{}', { status: 200 });
        }
        if (u.includes(`/history/${PROMPT_ID}`)) {
            return new Response(JSON.stringify({
                [PROMPT_ID]: {
                    status: { status_str: 'success' },
                    outputs: {
                        '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
                    },
                },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('/view')) {
            return new Response(Buffer.from([137, 80, 78, 71]), {
                status: 200, headers: { 'content-type': 'image/png' },
            });
        }
        throw new Error(`unexpected fetch: ${u}`);
    });
}

beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.onNew = null;
    __setWebSocketForTest(FakeWebSocket);
});

afterEach(() => {
    __resetWebSocketForTest();
});

describe('dispatchSdComfy', () => {
    test('main flow: prompt → WS executing done → history → view → emit chunk', async () => {
        FakeWebSocket.onNew = (ws) => {
            ws.emit('open');
            setTimeout(() => {
                ws.emit('message', Buffer.from(JSON.stringify({
                    type: 'executing',
                    data: { prompt_id: PROMPT_ID, node: null },
                })));
            }, 20);
        };
        const ctx = fakeCtx({ onFetch: buildStandardFetch() });
        await dispatchSdComfy(ctx);

        const chunks = ctx._emitted.filter(e => e.kind === 'chunk');
        expect(chunks).toHaveLength(1);
        const payload = JSON.parse(chunkToStr(chunks[0]));
        expect(payload.format).toBe('png');
        // base64 of 0x89 0x50 0x4E 0x47
        expect(Buffer.from(payload.data, 'base64')).toEqual(Buffer.from([137, 80, 78, 71]));
        expect(ctx._emitted[ctx._emitted.length - 1].kind).toBe('end');
        expect(ctx.inspection.completeImage).toHaveBeenCalledWith(expect.objectContaining({ format: 'png' }));
    });

    test('/interrupt fired on abort mid-generation', async () => {
        let interruptFired = false;
        // WS opens but never sends completion.
        FakeWebSocket.onNew = (ws) => {
            setImmediate(() => ws.emit('open'));
        };
        const ac = new AbortController();
        const ctx = fakeCtx({
            signal: ac.signal,
            onFetch: buildStandardFetch({ interruptOnPromptId: () => { interruptFired = true; } }),
        });
        const p = dispatchSdComfy(ctx);
        // Give the dispatch time to POST /prompt and open the WS.
        await new Promise(r => setTimeout(r, 20));
        ac.abort();
        await p;

        expect(interruptFired).toBe(true);
        expect(ctx.inspection.abort).toHaveBeenCalled();
        expect(ctx._emitted.some(e => e.kind === 'error')).toBe(true);
    });

    test('execution_error message → emit.error', async () => {
        FakeWebSocket.onNew = (ws) => {
            ws.emit('open');
            setTimeout(() => {
                ws.emit('message', Buffer.from(JSON.stringify({
                    type: 'execution_error',
                    data: {
                        prompt_id: PROMPT_ID,
                        node_type: 'KSampler', node_id: '1',
                        exception_type: 'RuntimeError',
                        exception_message: 'OOM',
                    },
                })));
            }, 30);
        };
        const ctx = fakeCtx({ onFetch: buildStandardFetch() });
        await dispatchSdComfy(ctx);

        const errs = ctx._emitted.filter(e => e.kind === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0].error.message).toContain('KSampler');
        expect(errs[0].error.message).toContain('OOM');
        expect(ctx.inspection.failImage).toHaveBeenCalled();
    });

    test('/prompt HTTP 500 → emit.error, no WS opened', async () => {
        const fetchMock = jest.fn(async (url) => {
            if (String(url).endsWith('/prompt')) {
                return new Response('bad workflow', { status: 500 });
            }
            throw new Error(`unexpected: ${url}`);
        });
        const ctx = fakeCtx({ onFetch: fetchMock });
        await dispatchSdComfy(ctx);

        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(ctx._emitted.filter(e => e.kind === 'error')).toHaveLength(1);
        expect(ctx.inspection.failImage).toHaveBeenCalled();
    });

    test('all upstream ctx.fetch calls (prompt/history/view) receive ctx.signal', async () => {
        FakeWebSocket.onNew = (ws) => {
            ws.emit('open');
            setTimeout(() => {
                ws.emit('message', Buffer.from(JSON.stringify({
                    type: 'executing',
                    data: { prompt_id: PROMPT_ID, node: null },
                })));
            }, 20);
        };
        const ctx = fakeCtx({ onFetch: buildStandardFetch() });
        await dispatchSdComfy(ctx);

        // Fire-and-forget /interrupt is not expected here (no abort fired),
        // so ctx.fetch calls should be: /prompt, /history/<id>, /view.
        const relevantCalls = ctx.fetch.mock.calls.filter(([u]) => {
            const s = String(u);
            return s.endsWith('/prompt') || s.includes('/history/') || s.includes('/view');
        });
        expect(relevantCalls.length).toBe(3);
        for (const [, init] of relevantCalls) {
            expect(init).toBeDefined();
            expect(init.signal).toBe(ctx.signal);
        }
    });

    test('client disconnect (onRequestClose fires) → POST /interrupt + ctx.abort()', async () => {
        // WS opens but never delivers a completion frame, so the dispatch
        // is parked inside waitForComfyCompletion until signal aborts.
        FakeWebSocket.onNew = (ws) => {
            setImmediate(() => ws.emit('open'));
        };
        let interruptFired = false;
        const ctx = fakeCtx({
            onFetch: buildStandardFetch({ interruptOnPromptId: () => { interruptFired = true; } }),
        });
        const p = dispatchSdComfy(ctx);
        // Let dispatch POST /prompt and register its close handler.
        await new Promise(r => setTimeout(r, 20));
        expect(ctx.onRequestClose).toHaveBeenCalledTimes(1);
        expect(ctx._closeHandlers.size).toBe(1);

        // Simulate runner-side request 'close' fanout.
        for (const cb of ctx._closeHandlers) cb();
        await p;

        expect(interruptFired).toBe(true);
        expect(ctx.abort).toHaveBeenCalled();
        expect(ctx._abortController.signal.aborted).toBe(true);
        // The dispatch exits via the "Aborted" error path from
        // waitForComfyCompletion, so emit.error must have fired.
        expect(ctx._emitted.some(e => e.kind === 'error')).toBe(true);
    });

    test('close handler is disposed on normal success so late close does not POST /interrupt', async () => {
        FakeWebSocket.onNew = (ws) => {
            ws.emit('open');
            setTimeout(() => {
                ws.emit('message', Buffer.from(JSON.stringify({
                    type: 'executing',
                    data: { prompt_id: PROMPT_ID, node: null },
                })));
            }, 20);
        };
        let interruptFired = false;
        const ctx = fakeCtx({
            onFetch: buildStandardFetch({ interruptOnPromptId: () => { interruptFired = true; } }),
        });
        await dispatchSdComfy(ctx);

        // finally-block disposer must have cleared the registered handler.
        expect(ctx._closeHandlers.size).toBe(0);
        // Even if we tried to fire the (now-empty) set, no /interrupt.
        for (const cb of ctx._closeHandlers) cb();
        expect(interruptFired).toBe(false);
    });
});
