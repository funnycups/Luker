// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iteration-library/render-scheduler — coalesce a burst of render
 * requests into one paint.
 *
 * Each iter-studio popup used to own a hand-rolled `scheduleBusRender`
 * driven by `queueMicrotask`. Because a microtask runs at the end of the
 * current job, consecutive `bus.propose()` / `bus.approve()` /
 * `bus.drainOutcomes()` mutations within a single tool-call round each
 * triggered an O(cards) full re-render instead of coalescing per frame.
 *
 * This module batches schedule() calls into the next animation frame:
 *
 *   - Multiple synchronous schedule()s before the next frame coalesce
 *     into ONE handler() call.
 *   - A schedule() that arrives WHILE the handler is awaiting queues a
 *     follow-up frame so mid-render mutations still surface.
 *   - flush() runs the handler now (popup teardown wants the final
 *     persist + render without waiting for rAF).
 *   - dispose() cancels any pending frame and turns subsequent
 *     schedule()s into no-ops (popup close path).
 *
 * Test environments inject a synchronous frameRequester so jest doesn't
 * need to wait for real rAF. Production uses requestAnimationFrame when
 * available, falling back to queueMicrotask in headless / node contexts.
 *
 * @param {Object} options
 * @param {() => Promise<void>} options.handler  Callback invoked on each
 *   frame the scheduler has been marked dirty for. Awaited so an
 *   exception or a long persistSession+render doesn't trigger an
 *   overlapping flush.
 * @param {(cb: (now?: number) => any) => any} [options.frameRequester]
 *   Override for rAF scheduling — used by tests; default uses
 *   requestAnimationFrame, then queueMicrotask, then setTimeout(0).
 * @param {(err: Error) => void} [options.onError]
 *   Notified when the handler throws so callers can surface to a logger
 *   without the scheduler swallowing the failure silently.
 * @returns {{ schedule: () => void, flush: () => Promise<void>, dispose: () => void }}
 */
export function createRenderScheduler({ handler, frameRequester, onError } = {}) {
    if (typeof handler !== 'function') {
        throw new Error('createRenderScheduler: handler must be a function');
    }
    const requestFrame = typeof frameRequester === 'function'
        ? frameRequester
        : defaultFrameRequester;

    let dirty = false;        // schedule() since last flush start?
    let framed = false;       // a frame callback is already pending
    let running = false;      // handler is currently awaiting
    let disposed = false;
    // Track in-flight runs so flush() can await whatever is mid-render
    // instead of overlapping. Without this, flush() called during a
    // bus mutation could spawn a second handler call that races the
    // first against the same DOM.
    let inflight = Promise.resolve();

    async function runOnce() {
        // Snapshot + clear before the handler runs so a schedule() while
        // we're awaiting queues a fresh frame (see queueIfDirty below).
        dirty = false;
        running = true;
        try {
            await handler();
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (typeof onError === 'function') {
                try {
                    onError(error);
                } catch (hookErr) {
                    console.error('[render-scheduler] onError handler threw:', hookErr);
                }
            } else {
                throw error;
            }
        } finally {
            running = false;
            queueIfDirty();
        }
    }

    function startRun() {
        const run = runOnce();
        inflight = run.catch(() => {});
        return run;
    }

    function queueIfDirty() {
        if (disposed) return;
        if (!dirty) return;
        if (framed) return;
        framed = true;
        requestFrame(async () => {
            framed = false;
            if (disposed) return;
            // flush() may have consumed the dirty flag or started a run
            // between scheduling and firing — re-check before running so
            // we never overlap two handler invocations.
            if (!dirty || running) return;
            await startRun();
        });
    }

    function schedule() {
        if (disposed) return;
        dirty = true;
        // Don't queue a fresh frame while a handler is in-flight —
        // queueIfDirty in the finally branch picks the dirty flag up and
        // requests the next frame, which keeps the "one paint per frame"
        // invariant even when mutations arrive mid-render.
        if (running) return;
        queueIfDirty();
    }

    async function flush() {
        while (!disposed) {
            if (running) {
                await inflight;
                continue;
            }
            if (!dirty) return;
            await startRun();
        }
    }

    function dispose() {
        disposed = true;
        dirty = false;
    }

    return { schedule, flush, dispose };
}

function defaultFrameRequester(cb) {
    if (typeof globalThis !== 'undefined') {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === 'function') {
            return raf(cb);
        }
        if (typeof globalThis.queueMicrotask === 'function') {
            globalThis.queueMicrotask(() => cb());
            return 0;
        }
    }
    return setTimeout(() => cb(), 0);
}
