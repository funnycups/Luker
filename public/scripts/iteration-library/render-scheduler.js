// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * iteration-library/render-scheduler — coalesce a burst of render
 * requests into one paint.
 *
 * Each iter-studio popup (orchestrator, CPA, CEA, MG schema) used to
 * own a hand-rolled `scheduleBusRender` driven by `queueMicrotask`. The
 * microtask flush ran at the end of the current async job, so each
 * `bus.propose()` / `bus.approve()` / `bus.drainOutcomes()` produced its
 * own render even when called back-to-back in a tool-call round —
 * dozens of full re-renders per LLM round, each rebuilding every diff
 * card in the popup. Trace-20260617T154806 captured 1,079 renders in
 * 106s of one chat send (~64s main thread).
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
            if (typeof onError === 'function') {
                try { onError(err instanceof Error ? err : new Error(String(err))); }
                catch { /* onError must not wedge the scheduler either */ }
            }
        } finally {
            running = false;
            queueIfDirty();
        }
    }

    function queueIfDirty() {
        if (disposed) return;
        if (!dirty) return;
        if (framed) return;
        framed = true;
        requestFrame(async () => {
            framed = false;
            if (disposed) return;
            // flush() may have consumed the dirty flag between scheduling
            // and firing — re-check before running so we don't double-
            // render on top of a manual flush.
            if (!dirty) return;
            inflight = runOnce();
            await inflight;
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
        if (disposed) return;
        // Wait for any in-flight handler so flush()'s caller doesn't race
        // a frame-driven render against its own teardown persist.
        await inflight;
        if (!dirty) return;
        await runOnce();
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
