// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// iteration-library/render-scheduler — coalesces a burst of render
// requests into one paint, replacing the legacy `queueMicrotask` flush
// each iter-studio popup used to do by hand.
//
// Why this exists: the popups subscribe to ProposalBus.onChange, which
// fires after every bus mutation. A single LLM tool-call round can
// produce N mutations (propose, then approve-all if auto-apply is on,
// then drain ...). With the old microtask scheduler, N mutations within
// the same async tick still triggered N renders because each microtask
// flush completed before the next mutation queued. (queueMicrotask runs
// at the end of the current job, not at end-of-tick — a burst of awaits
// during the LLM round interleaves new mutations between flushes.)
//
// Scheduler contract:
//   1. Multiple synchronous schedule() calls before the next animation
//      frame coalesce into ONE render() invocation.
//   2. A schedule() during an in-flight render() defers to the next
//      frame instead of dropping (else a mutation that arrives mid-render
//      vanishes from the UI).
//   3. The handler is async; the scheduler awaits it before considering
//      itself idle, so concurrent schedule()s don't fire overlapping
//      renders against the same DOM.
//   4. Test environments can inject a `frameRequester` (sync stub) so
//      Jest can drive the scheduler without rAF.

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createRenderScheduler } from '../../public/scripts/iteration-library/render-scheduler.js';

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

describe('iteration-library/render-scheduler', () => {
    test('N synchronous schedule() calls coalesce into exactly 1 handler call', async () => {
        const handler = jest.fn(async () => {});
        // Sync frame requester: invokes the callback immediately on the
        // next tick (microtask), so the test stays synchronous without
        // real rAF.
        const frames = [];
        const frameRequester = (fn) => { frames.push(fn); };
        const scheduler = createRenderScheduler({ handler, frameRequester });

        for (let i = 0; i < 50; i++) scheduler.schedule();
        expect(handler).not.toHaveBeenCalled();
        expect(frames.length).toBe(1);

        await frames[0](Date.now());
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('schedule() after the frame fires queues a fresh render', async () => {
        const handler = jest.fn(async () => {});
        const frames = [];
        const frameRequester = (fn) => { frames.push(fn); };
        const scheduler = createRenderScheduler({ handler, frameRequester });

        scheduler.schedule();
        await frames[0]();
        expect(handler).toHaveBeenCalledTimes(1);

        // Second burst — new frame requested, second render fires.
        scheduler.schedule();
        scheduler.schedule();
        expect(frames.length).toBe(2);
        await frames[1]();
        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('schedule() during an in-flight handler queues another frame', async () => {
        const inFlightStart = deferred();
        const inFlightFinish = deferred();
        const handler = jest.fn(async () => {
            inFlightStart.resolve();
            await inFlightFinish.promise;
        });
        const frames = [];
        const frameRequester = (fn) => { frames.push(fn); };
        const scheduler = createRenderScheduler({ handler, frameRequester });

        scheduler.schedule();
        const firstFlush = frames[0]();
        await inFlightStart.promise;
        // Handler is still awaiting. A schedule() arriving NOW must
        // produce a follow-up frame (else we'd silently drop a mutation
        // that landed mid-render).
        scheduler.schedule();
        // Let the handler finish.
        inFlightFinish.resolve();
        await firstFlush;
        expect(handler).toHaveBeenCalledTimes(1);
        expect(frames.length).toBe(2);
        await frames[1]();
        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('handler errors do not wedge the scheduler', async () => {
        let attempt = 0;
        const handler = jest.fn(async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('boom');
        });
        const frames = [];
        const onError = jest.fn();
        const scheduler = createRenderScheduler({
            handler,
            frameRequester: (fn) => { frames.push(fn); },
            onError,
        });

        scheduler.schedule();
        await frames[0]();
        expect(handler).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.any(Error));

        // Scheduler must still be operable after a failure.
        scheduler.schedule();
        await frames[1]();
        expect(handler).toHaveBeenCalledTimes(2);
    });

    test('flush() runs the handler immediately, bypassing the frame queue', async () => {
        const handler = jest.fn(async () => {});
        const frames = [];
        const scheduler = createRenderScheduler({
            handler,
            frameRequester: (fn) => { frames.push(fn); },
        });

        scheduler.schedule();
        await scheduler.flush();
        expect(handler).toHaveBeenCalledTimes(1);
        // The pending frame, when it eventually runs, should NOT
        // double-render — flush() consumed the dirty flag.
        expect(frames.length).toBe(1);
        await frames[0]();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('schedule() after dispose() is a no-op', async () => {
        const handler = jest.fn(async () => {});
        const frames = [];
        const scheduler = createRenderScheduler({
            handler,
            frameRequester: (fn) => { frames.push(fn); },
        });
        scheduler.dispose();
        scheduler.schedule();
        expect(frames.length).toBe(0);
        await scheduler.flush();
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('iteration-library/render-scheduler — default frame requester', () => {
    let originalRaf;
    beforeEach(() => {
        originalRaf = globalThis.requestAnimationFrame;
    });
    afterEach(() => {
        if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
        else globalThis.requestAnimationFrame = originalRaf;
    });

    test('uses requestAnimationFrame when available', async () => {
        const rafCalls = [];
        globalThis.requestAnimationFrame = (fn) => {
            rafCalls.push(fn);
            return rafCalls.length;
        };
        const handler = jest.fn(async () => {});
        const scheduler = createRenderScheduler({ handler });
        scheduler.schedule();
        expect(rafCalls.length).toBe(1);
        await rafCalls[0]();
        expect(handler).toHaveBeenCalledTimes(1);
    });

    test('falls back to queueMicrotask when rAF is unavailable (node/jest)', async () => {
        delete globalThis.requestAnimationFrame;
        const handler = jest.fn(async () => {});
        const scheduler = createRenderScheduler({ handler });
        scheduler.schedule();
        // queueMicrotask runs at end of current job — await to drain.
        await Promise.resolve();
        await Promise.resolve();
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
