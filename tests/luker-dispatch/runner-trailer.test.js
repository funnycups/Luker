// SPDX-License-Identifier: AGPL-3.0-or-later
// Focused tests for the dedicated out-of-band `meta` channel emitted by the
// runner after dispatch completes. Internal metadata (`generation_id`,
// `persisted`, `status`) travels on its own WS `meta` frame strictly before the
// terminal `end` frame, leaving response.body 100% verbatim upstream bytes for
// both streaming and non-streaming requests.

import { getTaskByRequestId } from '../../src/endpoints/backends/luker-generation.js';

function fakeRequest({ requestId, body = {}, handle = 'meta-alice' } = {}) {
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

describe('runLukerDispatch — dedicated out-of-band meta frame', () => {
    test('streaming: emits meta frame after chunks and strictly before end, with zero synthetic luker bytes in chunks', async () => {
        const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');
        const req = fakeRequest({ requestId: 'meta-stream-1', body: { stream: true } });
        const res = fakeResponse();
        const chunkFrames = [];
        const select = () => async (ctx) => {
            const origChunk = ctx.emit.chunk;
            ctx.emit.chunk = (bytes) => { chunkFrames.push(bytes); origChunk(bytes); };
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"x"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));

        expect(chunkFrames).toHaveLength(1);
        expect(new TextDecoder().decode(chunkFrames[0])).toBe('data: {"delta":"x"}\n\n');

        const job = getTaskByRequestId('meta-stream-1', 'meta-alice');
        expect(job).not.toBeNull();
        expect(job.events.map(e => e.data?.kind)).toEqual(['chunk', 'meta', 'end']);
        const metaEntry = job.events.find(e => e.data?.kind === 'meta');
        expect(metaEntry.data.data).toEqual(expect.objectContaining({
            generation_id: 'meta-stream-1',
            persisted: expect.any(Boolean),
            status: expect.any(String),
        }));
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('non-streaming: emits meta frame before end without touching the raw JSON chunk body', async () => {
        const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');
        const req = fakeRequest({ requestId: 'meta-nonstream-1', body: { stream: false } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode('{"content":"non-stream body"}'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));

        const job = getTaskByRequestId('meta-nonstream-1', 'meta-alice');
        expect(job).not.toBeNull();
        expect(job.events.map(e => e.data?.kind)).toEqual(['chunk', 'meta', 'end']);
        const chunkPayload = new TextDecoder().decode(job.events[0].data.data);
        expect(chunkPayload).toBe('{"content":"non-stream body"}');
        expect(job.events[1].data.data).toEqual(expect.objectContaining({
            generation_id: 'meta-nonstream-1',
            persisted: expect.any(Boolean),
            status: expect.any(String),
        }));
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('ordering: head -> chunks -> meta -> end is strictly preserved in job.events', async () => {
        const { runLukerDispatch } = await import('../../src/luker-dispatch/runner.js');
        const req = fakeRequest({ requestId: 'meta-order-1', body: { stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.head({ status: 200, headers: { 'content-type': 'text/event-stream' } });
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"a"}\n\n'));
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"b"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));

        const job = getTaskByRequestId('meta-order-1', 'meta-alice');
        expect(job.events.map(e => e.data?.kind)).toEqual(['head', 'chunk', 'chunk', 'meta', 'end']);
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });
});
