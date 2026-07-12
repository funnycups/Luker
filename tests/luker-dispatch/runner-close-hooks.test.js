// SPDX-License-Identifier: AGPL-3.0-or-later
import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { runLukerDispatch } from '../../src/luker-dispatch/runner.js';

// Runner intentionally does NOT default-bind request 'close' to abort so
// generation-jobs can survive a mid-flight disconnect and be reclaimed via
// GET /api/generation/active. Dispatches that hold external state whose
// only stop channel is the client connection (ComfyUI /interrupt) opt in
// via ctx.onRequestClose(cb). These tests pin that contract.

function fakeRequest({ requestId, body = {}, handle } = {}) {
    const req = new EventEmitter();
    req.headers = requestId ? { 'x-luker-request-id': requestId } : {};
    req.body = body;
    req.user = { profile: { handle: handle || `close-hook-${Math.random().toString(36).slice(2)}` }, directories: {} };
    return req;
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

async function flushBackground() {
    // Runner dispatches via setImmediate; give it enough ticks to reach the
    // point where the dispatch has registered its close hook.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
}

describe('runLukerDispatch — request close hook wiring', () => {
    test('client disconnect does NOT auto-abort ctx.signal (job-survives-disconnect contract)', async () => {
        const req = fakeRequest({ requestId: 'no-default-abort-1' });
        const res = fakeResponse();
        let capturedSignal = null;
        // Dispatch parks until we tell it to end so we can observe signal
        // state after emitting request 'close'.
        let releaseDispatch;
        const dispatchDone = new Promise(r => { releaseDispatch = r; });
        const select = () => async (ctx) => {
            capturedSignal = ctx.signal;
            await dispatchDone;
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await flushBackground();
        expect(capturedSignal).not.toBeNull();
        expect(capturedSignal.aborted).toBe(false);

        // Simulate client TCP-close.
        req.emit('close');
        await new Promise(r => setImmediate(r));

        // The generation-job survives disconnect contract: no auto-abort
        // just because the client dropped. Explicit user cancel goes
        // through POST /api/generation/:id/abort instead.
        expect(capturedSignal.aborted).toBe(false);

        releaseDispatch();
        await flushBackground();
    });

    test('ctx.onRequestClose fires every registered handler on request close', async () => {
        const req = fakeRequest({ requestId: 'multi-handler-1' });
        const res = fakeResponse();
        const fired = [];
        let releaseDispatch;
        const dispatchDone = new Promise(r => { releaseDispatch = r; });
        const select = () => async (ctx) => {
            ctx.onRequestClose(() => fired.push('a'));
            ctx.onRequestClose(() => fired.push('b'));
            ctx.onRequestClose(() => fired.push('c'));
            await dispatchDone;
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await flushBackground();
        req.emit('close');
        await new Promise(r => setImmediate(r));
        expect(fired.sort()).toEqual(['a', 'b', 'c']);
        releaseDispatch();
        await flushBackground();
    });

    test('one handler throwing does not block the others', async () => {
        const req = fakeRequest({ requestId: 'handler-throw-1' });
        const res = fakeResponse();
        const fired = [];
        let releaseDispatch;
        const dispatchDone = new Promise(r => { releaseDispatch = r; });
        // Silence the expected warn from the runner's handler-catch.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const select = () => async (ctx) => {
            ctx.onRequestClose(() => fired.push('before'));
            ctx.onRequestClose(() => { throw new Error('boom'); });
            ctx.onRequestClose(() => fired.push('after'));
            await dispatchDone;
            ctx.emit.end();
        };
        try {
            await runLukerDispatch(req, res, { endpoint: 'test', select });
            await flushBackground();
            req.emit('close');
            await new Promise(r => setImmediate(r));
            expect(fired).toEqual(['before', 'after']);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('onRequestClose handler threw'),
                expect.any(Error),
            );
        } finally {
            warnSpy.mockRestore();
            releaseDispatch();
            await flushBackground();
        }
    });

    test('disposer removes handler so a later close does not fire it', async () => {
        const req = fakeRequest({ requestId: 'disposer-1' });
        const res = fakeResponse();
        const fired = [];
        let releaseDispatch;
        const dispatchDone = new Promise(r => { releaseDispatch = r; });
        const select = () => async (ctx) => {
            const dispose = ctx.onRequestClose(() => fired.push('should-not-fire'));
            ctx.onRequestClose(() => fired.push('kept'));
            dispose();
            await dispatchDone;
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await flushBackground();
        req.emit('close');
        await new Promise(r => setImmediate(r));
        expect(fired).toEqual(['kept']);
        releaseDispatch();
        await flushBackground();
    });

    test('ctx.abort() flips ctx.signal (used by comfy /interrupt path)', async () => {
        const req = fakeRequest({ requestId: 'ctx-abort-1' });
        const res = fakeResponse();
        let capturedSignal = null;
        let releaseDispatch;
        const dispatchDone = new Promise(r => { releaseDispatch = r; });
        const select = () => async (ctx) => {
            capturedSignal = ctx.signal;
            ctx.onRequestClose(() => ctx.abort());
            await dispatchDone;
            ctx.emit.end();
        };
        await runLukerDispatch(req, res, { endpoint: 'test', select });
        await flushBackground();
        expect(capturedSignal.aborted).toBe(false);
        req.emit('close');
        await new Promise(r => setImmediate(r));
        expect(capturedSignal.aborted).toBe(true);
        releaseDispatch();
        await flushBackground();
    });
});
