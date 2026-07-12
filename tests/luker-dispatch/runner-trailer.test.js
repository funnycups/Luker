// Focused tests for the luker trailer frame the runner appends at the tail
// of every streaming chat/text dispatch. Legacy behavior lived in
// `forwardStreamingWithGenerationJob`; the refactor split the trailer between
// the runner and the dispatch and — before the fix — dropped the frame
// entirely because:
//   1. Trailer emit ran BEFORE completeGenerationJobFromText, so
//      `job.persisted` was always `false` and `job.status` was always
//      `'running'` in the payload.
//   2. Trailer went through `emit.chunk` → safeEmit, but dispatches emit
//      `end` at their own tail; safeEmit's terminal-lock swallowed every
//      subsequent chunk. The frame never reached job.events / clients.
//
// The client consumers (openai.js:4324 / kai-settings.js:288 /
// nai-settings.js:807 / textgen-settings.js / script.js) all read the
// `{luker:{generation_id, persisted, status}}` envelope from the SSE stream
// to learn the server-side job id + persisted flag.
//
// These tests exercise: (a) trailer arrives even when dispatch has already
// called emit.end, and (b) `persisted`/`status` reflect state AFTER
// completeGenerationJobFromText fired.

import { jest } from '@jest/globals';

function fakeRequest({ requestId, body = {}, handle = 'trailer-alice' } = {}) {
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

function collectTrailer(ctx, collector) {
    const origTrailer = ctx.emit.trailer;
    ctx.emit.trailer = (bytes) => {
        collector.push(bytes);
        origTrailer(bytes);
    };
}

describe('runLukerDispatch — trailer frame (Task 2C)', () => {
    test('trailer is emitted even after dispatch has already called emit.end (bypasses safeEmit terminal-lock)', async () => {
        const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');
        const req = fakeRequest({ requestId: 'trailer-after-end-1', body: { stream: true } });
        const res = fakeResponse();
        const trailerFrames = [];
        const chunkFrames = [];
        const select = () => async (ctx) => {
            collectTrailer(ctx, trailerFrames);
            const origChunk = ctx.emit.chunk;
            ctx.emit.chunk = (bytes) => { chunkFrames.push(bytes); origChunk(bytes); };
            // Emit a payload chunk, then immediately emit.end. This flips
            // ctx.terminal=true. Any subsequent ctx.emit.chunk would be a
            // no-op under safeEmit's terminal-lock. Only ctx.emit.trailer
            // is allowed to append past the lock.
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"x"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        // Exactly one trailer frame was appended by the runner AFTER
        // dispatch's own emit.end.
        expect(trailerFrames).toHaveLength(1);
        const decoded = new TextDecoder().decode(trailerFrames[0]);
        expect(decoded.startsWith('data: ')).toBe(true);
        expect(decoded.endsWith('\n\n')).toBe(true);
        const payload = JSON.parse(decoded.slice(6).trim());
        expect(payload).toEqual({
            luker: expect.objectContaining({
                generation_id: 'trailer-after-end-1',
                persisted: expect.any(Boolean),
                status: expect.any(String),
            }),
        });
    });

    // The "persisted=true round-trip" case is exercised in
    // ./runner-trailer-persisted.test.js — that scenario needs a
    // module-level mock of completeGenerationJobFromText, which does not
    // compose with the real luker-generation module used by the tests
    // above.

    test('trailer is NOT emitted for non-streaming requests (would corrupt the single JSON body the client awaits response.json() on)', async () => {
        const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');
        const req = fakeRequest({ requestId: 'trailer-nonstream-1', body: { stream: false } });
        const res = fakeResponse();
        const trailerFrames = [];
        const select = () => async (ctx) => {
            collectTrailer(ctx, trailerFrames);
            ctx.emit.chunk(new TextEncoder().encode('{"content":"non-stream body"}'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        expect(trailerFrames).toHaveLength(0);
    });

    test('trailer is ordered AFTER dispatch chunks in the on-wire event sequence', async () => {
        const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');
        const req = fakeRequest({ requestId: 'trailer-order-1', body: { stream: true } });
        const res = fakeResponse();
        // Record every byte the client would see, in order. Both chunk and
        // trailer flow through the same wire; the runner-side trailer must
        // land after the last dispatch chunk.
        const wire = [];
        const select = () => async (ctx) => {
            const origChunk = ctx.emit.chunk;
            const origTrailer = ctx.emit.trailer;
            ctx.emit.chunk = (b) => { wire.push({ kind: 'chunk', text: new TextDecoder().decode(b) }); origChunk(b); };
            ctx.emit.trailer = (b) => { wire.push({ kind: 'trailer', text: new TextDecoder().decode(b) }); origTrailer(b); };
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"a"}\n\n'));
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"b"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const kinds = wire.map(w => w.kind);
        expect(kinds).toEqual(['chunk', 'chunk', 'trailer']);
        expect(wire[wire.length - 1].text).toContain('"luker":');
    });
});
