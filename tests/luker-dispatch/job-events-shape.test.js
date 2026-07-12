// Regression test for Task 2E: `job.events[i].data` must hold SSE payload
// strings (legacy shape) — not the runner-internal envelope
// `{kind:'chunk', data:<Uint8Array>}`.
//
// Consumers:
//   - /api/backends/chat-completions/jobs/events (POST replay) —
//     chat-completions.js:405 pipes `job.events` verbatim back to the
//     client. Frontend `handleEvent` in public/script.js:815 does
//     `JSON.parse(event.data)` on each entry's `data` string to pull
//     `seq` (and, historically, delta text). An envelope object would
//     deserialize as `{kind:'chunk', data:{0:65,1:66,...}}` — non-JSON
//     usable for text extraction and orders of magnitude larger on-wire.
//   - `extractTextFromStreamingFrameData` inside appendGenerationEvent —
//     it JSON.parses the entry data and pulls a delta text off common
//     provider shapes. If the entry is an envelope, `JSON.parse` throws
//     (silently caught) and no text is extracted for that frame.
//
// The runner is expected to SSE-frame each incoming chunk (chunk bytes
// can straddle frame boundaries, so a buffer is needed) and push one
// entry per fully-received `data: ...\n\n` frame. Non-stream chats
// (single JSON body) push once with the whole body text.

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

describe('runLukerDispatch — job.events legacy shape (Task 2E)', () => {
    test('streaming chunk with two SSE frames → two job.events entries, each with a payload STRING (not envelope)', async () => {
        const req = fakeRequest({ requestId: 'events-shape-stream-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            // Two full SSE frames in a single chunk.
            ctx.emit.chunk(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n' +
                'data: {"choices":[{"delta":{"content":"bar"}}]}\n\n',
            ));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-shape-stream-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // Two content frames were emitted; the runner also appends its
        // own trailer frame for streaming ({"luker":{...}}), which
        // extractTextFromStreamingFrameData skips (returns '' for
        // parsed.luker). Assert on the first two entries specifically.
        expect(job.events.length).toBeGreaterThanOrEqual(2);

        const first = job.events[0];
        const second = job.events[1];

        // Shape: each entry is {seq, data, ts}; `data` is a raw SSE
        // payload STRING (JSON.parse-able), not the runner envelope
        // {kind, data:Uint8Array}.
        expect(typeof first.data).toBe('string');
        expect(typeof second.data).toBe('string');
        // Sanity: JSON.parse succeeds and the payload has the shape the
        // frontend + extractTextFromStreamingFrameData expect.
        expect(() => JSON.parse(first.data)).not.toThrow();
        expect(() => JSON.parse(second.data)).not.toThrow();
        expect(JSON.parse(first.data).choices[0].delta.content).toBe('foo');
        expect(JSON.parse(second.data).choices[0].delta.content).toBe('bar');
        // Cleanup persistence timer.
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('SSE frame split across two chunks reassembles into ONE job.events entry with the full payload string', async () => {
        const req = fakeRequest({ requestId: 'events-shape-split-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            // Split the frame mid-payload; runner's sseBuffer must
            // rejoin them before flushing. Legacy behavior was one
            // entry per fully-received data payload — not one per
            // TCP chunk.
            ctx.emit.chunk(new TextEncoder().encode('data: {"choices":[{"delta":{"conte'));
            ctx.emit.chunk(new TextEncoder().encode('nt":"reassembled"}}]}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-shape-split-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // First real content event should be the reassembled payload —
        // NOT two half-chunk envelopes.
        expect(job.events.length).toBeGreaterThanOrEqual(1);
        const first = job.events[0];
        expect(typeof first.data).toBe('string');
        expect(JSON.parse(first.data).choices[0].delta.content).toBe('reassembled');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('SSE tail frame without \\n\\n terminator still flushes into job.events on end (usage/message_delta frames at the very tail must not drop)', async () => {
        const req = fakeRequest({ requestId: 'events-shape-tail-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            // Real providers often send the terminal usage frame without
            // the closing \n\n before EOF.
            ctx.emit.chunk(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"before"}}]}\n\n' +
                'data: {"usage":{"total_tokens":42}}',
            ));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-shape-tail-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // Both frames should have made it in as strings.
        expect(job.events.length).toBeGreaterThanOrEqual(2);
        expect(typeof job.events[0].data).toBe('string');
        expect(typeof job.events[1].data).toBe('string');
        const second = JSON.parse(job.events[1].data);
        expect(second.usage.total_tokens).toBe(42);
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('non-streaming request pushes the full JSON body as a single job.events entry (string, JSON.parse-able)', async () => {
        const req = fakeRequest({ requestId: 'events-shape-nonstream-1', body: { stream: false } });
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

        const job = getTaskByRequestId('events-shape-nonstream-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        // Non-stream has NO runner trailer appended (it would corrupt
        // response.json() on the client), so job.events holds exactly
        // one entry.
        expect(job.events).toHaveLength(1);
        expect(typeof job.events[0].data).toBe('string');
        expect(job.events[0].data).toBe(nonStreamBody);
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('CRLF line endings from proxy-wrapped upstreams are normalized before SSE framing', async () => {
        const req = fakeRequest({ requestId: 'events-shape-crlf-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            // nginx / Cloudflare proxy sometimes rewrites \n → \r\n on
            // SSE. Runner's CRLF → LF normalize must happen before the
            // `\n\n` frame-delimiter scan or the frame never flushes.
            ctx.emit.chunk(new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n',
            ));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));

        const job = getTaskByRequestId('events-shape-crlf-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        expect(job.events.length).toBeGreaterThanOrEqual(1);
        expect(typeof job.events[0].data).toBe('string');
        expect(JSON.parse(job.events[0].data).choices[0].delta.content).toBe('crlf');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('job.text is still accumulated from delta text (appendGenerationEvent runs extractTextFromStreamingFrameData on each string payload)', async () => {
        // The runner used to double-extract by calling BOTH
        // accumulateChunkTextIntoJob (envelope path) and going through
        // appendGenerationEvent (which also extracts). We dropped the
        // former; the latter must still work end-to-end.
        const req = fakeRequest({ requestId: 'events-shape-text-1', body: { stream: true } });
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

        const job = getTaskByRequestId('events-shape-text-1', 'events-shape-alice');
        expect(job).not.toBeNull();
        expect(job.text).toBe('Hello, world!');
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });
});
