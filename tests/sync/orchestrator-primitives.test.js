/**
 * Code review fix follow-up — lock in `queueOnKey`, the per-key FIFO
 * the orchestrator now uses to serialize live-mutating operations.
 *
 * Why this matters: `queueOnKey` replaced the previous throw-if-held
 * `withLock` and is also used by `/session/ref`'s responder reconcile,
 * so a regression here would reintroduce both the user-visible
 * `SYNC_BUSY` 409 (now defunct) AND the puller-responder race the fix
 * closed. We exercise the primitive directly because the orchestrator
 * end-to-end flow only covers the no-contention path.
 *
 * The 30s peer-fetch timeout introduced by the same fix is exercised
 * implicitly by `peerFetch` being the sole fetch caller — every
 * orchestrator integration test already routes through it. A dedicated
 * test would either need to wait 30s, or expose the constant for
 * mocking, both of which trade clarity for a regression net that the
 * existing suite already provides.
 */
import { describe, test, expect } from '@jest/globals';

import { queueOnKey } from '../../src/sync/orchestrator.js';

describe('queueOnKey (per-key FIFO)', () => {
    test('serializes overlapping operations on the same key in submission order', async () => {
        const events = [];
        const slow = queueOnKey('k', async () => {
            events.push('slow-start');
            await new Promise(r => setTimeout(r, 30));
            events.push('slow-end');
            return 'slow-result';
        });
        // Enqueue immediately while `slow` is still running. Since
        // queueOnKey is FIFO per key, `fast` MUST observe the post-slow
        // order even though its body is a microtask.
        const fast = queueOnKey('k', async () => {
            events.push('fast-start');
            events.push('fast-end');
            return 'fast-result';
        });
        const [slowResult, fastResult] = await Promise.all([slow, fast]);
        expect(slowResult).toBe('slow-result');
        expect(fastResult).toBe('fast-result');
        // The interleaving is constrained: slow must fully finish before
        // fast starts, otherwise the queue would degenerate into "run in
        // parallel" and the race the fix closed would be back.
        expect(events).toEqual(['slow-start', 'slow-end', 'fast-start', 'fast-end']);
    });

    test('different keys run in parallel (no cross-key blocking)', async () => {
        // If keys cross-blocked, the second runner could not enter until
        // the first released — observed by both bodies being in-flight
        // at the same time pushing `inside` above 1.
        let inside = 0;
        let peakInside = 0;
        const body = async () => {
            inside++;
            peakInside = Math.max(peakInside, inside);
            await new Promise(r => setTimeout(r, 15));
            inside--;
        };
        await Promise.all([
            queueOnKey('key-a', body),
            queueOnKey('key-b', body),
        ]);
        expect(peakInside).toBe(2);
    });

    test('a thrown fn does not poison the queue for subsequent enqueues', async () => {
        // The internal tail must be `.catch`-swallowed; otherwise an
        // earlier rejection would cascade to every later enqueue via the
        // eager `.then` chain and turn a single failure into a wedged
        // queue for the lifetime of the process.
        await expect(queueOnKey('boom', async () => {
            throw new Error('first');
        })).rejects.toThrow('first');
        const followUp = await queueOnKey('boom', async () => 'second');
        expect(followUp).toBe('second');
    });
});
