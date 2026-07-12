// Regression tests for the `job.events` envelope contract.
//
// `job.events[i].data` MUST hold the runner envelope
// `{kind: 'head'|'chunk'|'end'|'error', data: <payload>}` — NOT decoded
// SSE payload strings. The primary consumer is `ws-delivery.js:eventToFrame`,
// which dispatches on `data.kind` to build the wire frame the browser's
// WS handler routes by `msg.type`. If entries held payload strings, that
// guard (`typeof data !== 'object'` at ws-delivery.js:28) rejects every
// entry, eventToFrame returns null, no frame is ever sent on the socket,
// and every proxied fetch Response body stays pending forever.
//
// A prior iteration of the runner decoded chunks and pushed SSE payload
// strings into `job.events` directly (commit ce0a43053) to preserve a
// so-called "legacy" replay shape. That silently killed WS delivery for
// every proxied request. This test locks the envelope contract so the
// regression cannot recur.
//
// Recovery-path consumers (`/api/backends/chat-completions/jobs/events{-stream}`)
// only read `entry.seq` off each event (public/script.js:815 `handleEvent`)
// and rely on the periodic `status` frame carrying `job.text` for the
// authoritative recovery text feed. The envelope shape does not regress
// that path.
//
// Independent side channels covered by their own assertions:
//   - `inspectionEvents` (local to the runner, feeds
//     completeInspectionFromStream) still receives decoded SSE payload
//     strings, one per fully-received `data:` frame.
//   - `job.text` accumulates via `accumulateChunkTextIntoJob` on chunk
//     bytes, matching the legacy `forwardStreamingWithGenerationJob`
//     path (CRLF-normalise, `\n\n` framing, partial-chunk reassembly).

import { describe, test, expect } from '@jest/globals';
import { runLukerDispatch } from '../../src/luker-dispatch/runner.js';
import { getTaskByRequestId } from '../../src/endpoints/backends/luker-generation.js';

function fakeRequest({ requestId, body = {}, handle = 'events-shape-alice' } = {}) {
    return {
        headers: requestId ? { 'x-luker-request-id': requestId } : {},
        body,
        user: { profile: { handle }, directories: {} },
    };
}

function fakeResponse() {
    const state = { statusCode: 200, headers: {}, body: null, ended: false };
    return {
        state,
        status(code) { state.statusCode = code; return this; },
        setHeader(k, v) { state.headers[k.toLowerCase()] = v; },
        json(obj) { state.body = obj; state.ended = true; },
        send(obj) { state.body = obj; state.ended = true; },
    };
}

describe('runLukerDispatch — job.events envelope shape (WS delivery contract)', () => {
    test('every chunk emitted by dispatch lands as a `{kind:"chunk", data:<bytes>}` envelope entry', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-chunk-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"a"}\n\n'));
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"b"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-chunk-1', 'events-shape-alice');
        expect(job).not.toBeNull();

        // Expected sequence:
        //   1. chunk (dispatch)
        //   2. chunk (dispatch)
        //   3. end (dispatch's emit.end — flips safeEmit terminal-lock)
        //   4. chunk (runner-appended trailer via emit.trailer, which
        //      bypasses safeEmit's lock — see context.js emit.trailer)
        // The runner's own ctx.emit.end() after the trailer is a no-op
        // because safeEmit already latched terminal on step 3.
        const kinds = job.events.map(e => e?.data?.kind);
        expect(kinds).toEqual(['chunk', 'chunk', 'end', 'chunk']);

        // Each chunk entry's `data.data` is a Uint8Array / Buffer, NOT a
        // string. WS delivery `eventToFrame` base64-encodes bytes before
        // wire; passing a string would double-encode.
        for (const entry of job.events.filter(e => e.data.kind === 'chunk')) {
            const payload = entry.data.data;
            const isBytes = payload instanceof Uint8Array || Buffer.isBuffer(payload);
            expect(isBytes).toBe(true);
        }
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('emit.end lands as a `{kind:"end", data:null}` envelope entry', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-end-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"x"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-end-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // Streaming case: dispatch's emit.end lands as the terminal envelope,
        // then the runner appends its trailer chunk (`data: {"luker":{...}}\n\n`)
        // via emit.trailer which bypasses safeEmit's terminal-lock. So the
        // stored sequence ends with the trailer chunk. The `end` entry sits
        // one before last.
        const endEntry = job.events.find(e => e?.data?.kind === 'end');
        expect(endEntry).toBeDefined();
        expect(endEntry.data.data).toBeNull();
    });

    test('emit.head lands as a `{kind:"head", data:{status, headers}}` envelope entry that ws-delivery eventToFrame turns into a head wire frame', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-head-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"h"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-head-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        const headEntry = job.events.find(e => e?.data?.kind === 'head');
        expect(headEntry).toBeDefined();
        expect(headEntry.data.data.status).toBe(200);
        expect(headEntry.data.data.headers['content-type']).toBe('text/event-stream');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('ws-delivery eventToFrame produces non-null wire frames for every stored entry (integration guard against regression to string-payload shape)', async () => {
        // Cross-module sanity: pipe every stored entry through the real
        // eventToFrame helper and assert none return null. This is the
        // symptom the audit caught in prod — `typeof data !== 'object'`
        // dropped every string-payload entry, so client Response bodies
        // never received a byte on the WS.
        const { runLukerDispatch: run } = await import('../../src/luker-dispatch/runner.js');
        // ws-delivery internals aren't exported directly, so re-import
        // the frame builder by reading the module source. Simpler:
        // reproduce the exact guard here so the test doesn't couple to
        // an unexported symbol. Any future change that renames the guard
        // will show up in the ws-delivery tests, not here.
        function eventToFrameGuardMirror(entry) {
            const data = entry?.data;
            if (!data || typeof data !== 'object') return null;
            if (!['head', 'chunk', 'end', 'error'].includes(data.kind)) return null;
            return { type: data.kind };  // shape-check only
        }

        const req = fakeRequest({ requestId: 'events-envelope-wsguard-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.head({ status: 200, headers: {} });
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"1"}\n\n'));
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"2"}\n\n'));
            ctx.emit.end();
        };
        await run(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-wsguard-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // Every entry must survive the ws-delivery guard.
        const survived = job.events.map(e => eventToFrameGuardMirror(e));
        expect(survived.every(Boolean)).toBe(true);
        // And the type mix contains at least head, chunk, end.
        const types = new Set(survived.map(f => f.type));
        expect(types.has('head')).toBe(true);
        expect(types.has('chunk')).toBe(true);
        expect(types.has('end')).toBe(true);
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('job.text is still accumulated from streaming chunks via accumulateChunkTextIntoJob (envelope shape does not break the recovery text feed)', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-text-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Hello, "}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"world!"}}]}\n\n',
            ));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-text-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        expect(job.text).toBe('Hello, world!');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('SSE frame split across two chunks reassembles for text accumulation (partial-chunk buffer on job._sseBuffer)', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-split-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode('data: {"choices":[{"delta":{"conte'));
            ctx.emit.chunk(new TextEncoder().encode('nt":"reassembled"}}]}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-split-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        expect(job.text).toBe('reassembled');
        // Both chunks land as separate envelope entries (WS delivery
        // preserves per-emit granularity; the browser side reassembles
        // per its own SSE parser).
        const chunkEntries = job.events.filter(e => e?.data?.kind === 'chunk');
        expect(chunkEntries.length).toBeGreaterThanOrEqual(2);
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('CRLF line endings from proxy-wrapped upstreams are normalized before text extraction', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-crlf-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n',
            ));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-crlf-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        expect(job.text).toBe('crlf');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('non-streaming request stores a single chunk envelope + end, and job.text extracts the response content', async () => {
        const req = fakeRequest({ requestId: 'events-envelope-nonstream-1', body: { stream: false } });
        const res = fakeResponse();
        const nonStreamBody = JSON.stringify({
            choices: [{ message: { content: 'the whole message at once' } }],
            usage: { total_tokens: 7 },
        });
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode(nonStreamBody));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-envelope-nonstream-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // Non-stream has NO runner trailer appended (it would corrupt
        // response.json() on the client). Exactly: one chunk envelope +
        // one end envelope.
        expect(job.events).toHaveLength(2);
        expect(job.events[0].data.kind).toBe('chunk');
        expect(job.events[1].data.kind).toBe('end');
        expect(job.text).toBe('the whole message at once');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });
});
