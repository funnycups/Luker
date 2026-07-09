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
    test('400 when x-luker-request-id header missing', async () => {
        const req = fakeRequest({ requestId: null });
        const res = fakeResponse();
        const select = () => async (ctx) => { ctx.emit.end(); };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        expect(res.state.statusCode).toBe(400);
        expect(res.state.body).toEqual({ error: 'x-luker-request-id header required' });
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
});
