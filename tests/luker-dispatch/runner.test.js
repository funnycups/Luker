import { jest } from '@jest/globals';
import { runLukerDispatch } from '../../src/luker-dispatch/runner.js';

function fakeRequest({ requestId, body = {}, handle = 'alice' } = {}) {
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

describe('runLukerDispatch', () => {
    test('missing x-luker-request-id header: server auto-mints and returns via x-luker-generation-id', async () => {
        const req = fakeRequest({ requestId: null });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(200);
        const mintedId = res.state.headers['x-luker-generation-id'];
        expect(typeof mintedId).toBe('string');
        expect(mintedId.length).toBeGreaterThan(10);
    });

    test('body.luker_generation.job_id overrides header (client-supplied uuid path)', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'header-id-should-lose', body: { luker_generation: { job_id: 'body-id-wins' } } });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.headers['x-luker-generation-id']).toBe('body-id-wins');
        await new Promise(r => setTimeout(r, 20));
        // Job must be findable by the body id (what /jobs/status?id= will use).
        expect(getTaskByRequestId('body-id-wins', 'alice')).not.toBeNull();
    });

    test('400 when select throws', async () => {
        const req = fakeRequest({ requestId: 'select-err-1', body: { unknown: true } });
        const res = fakeResponse();
        const select = () => { throw new Error('unsupported provider'); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(400);
        expect(res.state.body).toEqual({ error: 'unsupported provider' });
    });

    test('200 immediately with x-luker headers, dispatch runs in background', async () => {
        const req = fakeRequest({ requestId: 'ok-1' });
        const res = fakeResponse();
        let ranAt = null;
        const select = () => async (ctx) => {
            ranAt = 'dispatch-ran';
            ctx.emit.chunk(new Uint8Array([65]));  // 'A'
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(200);
        expect(res.state.headers['x-luker-generation-id']).toBe('ok-1');
        expect(res.state.headers['x-luker-server-persisted']).toBe('0');
        expect(res.state.body).toEqual({});
        // dispatch runs via setImmediate; wait a tick
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        expect(ranAt).toBe('dispatch-ran');
    });

    test('background dispatch throw routed to emit.error', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'err-in-dispatch-1' });
        const res = fakeResponse();
        const select = () => async () => { throw new Error('upstream 500'); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        // Wait for background
        await new Promise(r => setTimeout(r, 20));
        const job = getTaskByRequestId('err-in-dispatch-1', 'alice');
        expect(job).not.toBeNull();
        expect(job.status).toBe('failed');
        expect(job.error).toContain('upstream 500');
    });

    test('runner completes request-inspector entry on dispatch success (regression: stuck-on-running)', async () => {
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const req = fakeRequest({ requestId: 'inspect-success-1', body: { chat_completion_source: 'claude', model: 'claude-3', stream: true } });
        const res = fakeResponse();
        // Dispatch simulates calling ctx.inspection.start() at entry (as real
        // providers do) then emitting the reply.
        const select = () => async (ctx) => {
            ctx.inspection.start();
            ctx.emit.chunk(new TextEncoder().encode('hello'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const buf = getBufferForHandle('alice');
        const entry = buf.find(e => e.id === req.__inspectorId);
        expect(entry).toBeDefined();
        // Regression: inspector previously stuck on 'running' because no
        // dispatch called completeInspection. Runner now covers it.
        expect(entry.status).toBe('success');
        expect(entry.httpStatus).toBe(200);
        expect(typeof entry.durationMs).toBe('number');
    });

    test('runner fails request-inspector entry on dispatch throw', async () => {
        const { getBufferForHandle } = await import('../../src/request-inspector.js');
        const req = fakeRequest({ requestId: 'inspect-fail-1', body: { chat_completion_source: 'claude', model: 'claude-3', stream: true } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.inspection.start();
            throw new Error('upstream 401');
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        const buf = getBufferForHandle('alice');
        const entry = buf.find(e => e.id === req.__inspectorId);
        expect(entry).toBeDefined();
        expect(entry.status).toBe('error');
        expect(entry.error).toContain('upstream 401');
    });

    test('runner advances job to awaiting_ack after dispatch success (regression: stuck-on-running)', async () => {
        const { getTaskByRequestId } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'complete-job-1', body: { model: 'test-model' } });
        const res = fakeResponse();
        const select = () => async (ctx) => {
            ctx.emit.chunk(new TextEncoder().encode('hi'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 30));
        const job = getTaskByRequestId('complete-job-1', 'alice');
        expect(job).not.toBeNull();
        // Was 'running' pre-fix — auto-persist grace timer never armed,
        // /jobs/status never reached terminal state, client SSE hung.
        expect(job.status).toBe('awaiting_ack');
        expect(job.modelName).toBe('test-model');
        // Cancel the persistence timer so this test doesn't leak a setTimeout.
        if (job.persistenceTimer) { clearTimeout(job.persistenceTimer); job.persistenceTimer = null; }
    });

    test('runner attaches job to request so getJobFromRequest works downstream', async () => {
        const { getJobFromRequest } = await import('../../src/endpoints/backends/luker-generation.js');
        const req = fakeRequest({ requestId: 'attach-job-1' });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        // Should be attached even before the setImmediate background fires
        // — attachJobToRequest is on the sync path before response.json.
        const attached = getJobFromRequest(req);
        expect(attached).not.toBeNull();
        expect(attached.id).toBe('attach-job-1');
        await new Promise(r => setTimeout(r, 20));
        // Cleanup timer.
        if (attached.persistenceTimer) { clearTimeout(attached.persistenceTimer); attached.persistenceTimer = null; }
    });

    test('runner emits legacy luker trailer SSE frame so client openai.js:4316 can read generation_id/persisted', async () => {
        const req = fakeRequest({ requestId: 'trailer-test-1', body: { stream: true } });
        const res = fakeResponse();
        const emittedChunks = [];
        const select = () => async (ctx) => {
            // Capture BOTH chunk and trailer emits — trailer bypasses
            // safeEmit's terminal-lock and is what the runner uses to
            // append the {luker:{...}} frame AFTER dispatch has already
            // called emit.end.
            const origChunk = ctx.emit.chunk;
            ctx.emit.chunk = (bytes) => {
                emittedChunks.push(bytes);
                origChunk(bytes);
            };
            const origTrailer = ctx.emit.trailer;
            ctx.emit.trailer = (bytes) => {
                emittedChunks.push(bytes);
                origTrailer(bytes);
            };
            ctx.emit.chunk(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await new Promise(r => setTimeout(r, 20));
        // Find the trailer frame with the luker envelope.
        const decoded = emittedChunks.map(b => new TextDecoder().decode(b)).join('');
        expect(decoded).toContain('"luker":');
        expect(decoded).toContain('"generation_id":"trailer-test-1"');
        expect(decoded).toContain('"persisted":');
        expect(decoded).toContain('"status":');
    });
});
