/**
 * First-chunk barrier for orchestrator fan-out.
 *
 * When an orchestrator (director sub-agent fan-out, spec parallel stage,
 * agenda round) issues N concurrent LLM requests that share the same
 * upstream cache prefix (typically: same connection profile / api preset),
 * the first request must warm the upstream prompt cache before the rest
 * fire — otherwise each request writes its own cache entry against a
 * cold state and the concurrent write traffic can trip provider rate
 * limits (Anthropic's per-minute input-token cap counts cache writes).
 *
 * The barrier exposes a pure claim-or-wait primitive:
 *   - First caller for a key becomes the LEAD and gets `role: 'lead'` +
 *     a `signalFirstChunk()` to fire once the upstream response begins.
 *   - Subsequent callers on the same key become FOLLOWERS and get a
 *     `wait` promise that resolves the moment the lead signals its
 *     first chunk (or fails / releases).
 *   - Every caller must eventually `release()`; that removes the slot
 *     so the next batch can pick a fresh lead.
 *
 * Rationale for key details:
 *   - `signalFirstChunk` is idempotent so streaming code can call it on
 *     every chunk without worrying about "am I the first one?".
 *   - `release()` also resolves any still-waiting followers so a lead
 *     that errors before ever streaming a chunk doesn't hang everyone
 *     — the followers just proceed cold (they'll cache-miss too, but
 *     that's identical to the pre-barrier baseline; no regression).
 *   - Followers are always resolved (never rejected). The barrier is
 *     a pure optimization; a broken lead must not kill its siblings.
 */

import { describe, test, expect } from '@jest/globals';
import { createFirstChunkBarrier } from '../../../public/scripts/extensions/orchestrator/dispatch-barrier.js';

describe('createFirstChunkBarrier', () => {
    test('first acquire on a fresh key returns role="lead"', () => {
        const barrier = createFirstChunkBarrier();
        const slot = barrier.acquire('preset-A');
        expect(slot.role).toBe('lead');
        expect(typeof slot.signalFirstChunk).toBe('function');
        expect(typeof slot.release).toBe('function');
        expect(slot.wait).toBeInstanceOf(Promise);
    });

    test('second acquire on same key returns role="follower" with a wait promise', () => {
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const follower = barrier.acquire('preset-A');
        expect(lead.role).toBe('lead');
        expect(follower.role).toBe('follower');
        expect(follower.wait).toBeInstanceOf(Promise);
    });

    test('follower.wait resolves when lead signals first chunk', async () => {
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const follower = barrier.acquire('preset-A');

        // Follower is not yet resolved.
        let resolved = false;
        follower.wait.then(() => { resolved = true; });
        await Promise.resolve(); // flush microtasks
        expect(resolved).toBe(false);

        lead.signalFirstChunk();
        await follower.wait;
        expect(resolved).toBe(true);
    });

    test('multiple followers on same key all resolve on single signalFirstChunk', async () => {
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const f1 = barrier.acquire('preset-A');
        const f2 = barrier.acquire('preset-A');
        const f3 = barrier.acquire('preset-A');

        lead.signalFirstChunk();
        // All three followers get the same underlying resolution.
        // If any follower's wait leaked into a separate never-resolved
        // promise, Promise.all would hang and the test would time out.
        await expect(Promise.all([f1.wait, f2.wait, f3.wait])).resolves.toBeDefined();
    });

    test('signalFirstChunk is idempotent — extra calls are no-ops', async () => {
        // Streaming code fires signalFirstChunk on every chunk delta
        // rather than gating "was this the first one?" — the barrier
        // absorbs the extras so callers don't need bookkeeping.
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const follower = barrier.acquire('preset-A');
        lead.signalFirstChunk();
        lead.signalFirstChunk();
        lead.signalFirstChunk();
        await expect(follower.wait).resolves.toBeUndefined();
    });

    test('different keys are independent — follower on B does not wait for A', async () => {
        const barrier = createFirstChunkBarrier();
        const leadA = barrier.acquire('preset-A');
        const leadB = barrier.acquire('preset-B');
        expect(leadA.role).toBe('lead');
        expect(leadB.role).toBe('lead');

        // A follower for B does NOT block on A.
        const followerB = barrier.acquire('preset-B');
        expect(followerB.role).toBe('follower');
        let bResolved = false;
        followerB.wait.then(() => { bResolved = true; });
        leadB.signalFirstChunk();
        await followerB.wait;
        expect(bResolved).toBe(true);
        // A never signaled — but that's fine, no one was waiting on it.
    });

    test('release before signalFirstChunk still resolves followers (fail-open)', async () => {
        // If the lead's LLM request fails / aborts before ever streaming
        // a chunk, we must not leave followers hanging. Release resolves
        // followers so they proceed cold (equivalent to pre-barrier
        // behavior — no regression, just no cache-warm benefit).
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const follower = barrier.acquire('preset-A');
        lead.release();
        await expect(follower.wait).resolves.toBeUndefined(); // must not hang
    });

    test('after lead releases, next acquire on same key becomes a new lead', () => {
        const barrier = createFirstChunkBarrier();
        const lead1 = barrier.acquire('preset-A');
        lead1.signalFirstChunk();
        lead1.release();

        // Next batch — the slot must be free.
        const lead2 = barrier.acquire('preset-A');
        expect(lead2.role).toBe('lead');
    });

    test('followers acquired while lead is still in-flight all share one wait', async () => {
        // Regression guard: middleware code must not accidentally
        // create a fresh promise per follower — they must all resolve
        // from the same underlying source so a single signalFirstChunk
        // wakes them all.
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const followers = Array.from({ length: 5 }, () => barrier.acquire('preset-A'));
        followers.forEach(f => expect(f.role).toBe('follower'));

        const resolutionOrder = [];
        const waits = followers.map((f, i) => f.wait.then(() => resolutionOrder.push(i)));
        lead.signalFirstChunk();
        await Promise.all(waits);
        // All resolved (order is scheduler-dependent, we only check completeness).
        expect(resolutionOrder).toHaveLength(5);
    });

    test('release removes slot even if signalFirstChunk was called', () => {
        // A lead that finishes normally: signals first chunk during
        // streaming, then releases when the round is done. The next
        // acquire on the same key MUST see a fresh slot (new lead).
        const barrier = createFirstChunkBarrier();
        const lead1 = barrier.acquire('preset-A');
        lead1.signalFirstChunk();
        lead1.release();
        const lead2 = barrier.acquire('preset-A');
        expect(lead2.role).toBe('lead');
    });

    test('follower.release is a no-op — only lead controls the slot', () => {
        // Follower.release() exists for API symmetry (callers don't
        // branch on role for cleanup) but must not evict the slot
        // out from under the lead.
        const barrier = createFirstChunkBarrier();
        const lead = barrier.acquire('preset-A');
        const follower = barrier.acquire('preset-A');
        follower.release();
        // The slot should still be occupied by the lead — a new
        // caller must become a follower, not a fresh lead.
        const another = barrier.acquire('preset-A');
        expect(another.role).toBe('follower');
        lead.signalFirstChunk();
        return Promise.all([follower.wait, another.wait]);
    });

    test('null / empty key skips barrier — always returns solo lead role', () => {
        // Guard for the "no preset name resolved" edge — barrier
        // opts out rather than crashing. Every acquire on a falsy key
        // is a lead (no cross-request coordination possible).
        const barrier = createFirstChunkBarrier();
        const slot1 = barrier.acquire(null);
        const slot2 = barrier.acquire('');
        const slot3 = barrier.acquire(undefined);
        expect(slot1.role).toBe('lead');
        expect(slot2.role).toBe('lead');
        expect(slot3.role).toBe('lead');
        // No barrier means signalFirstChunk / release are no-ops that don't blow up.
        slot1.signalFirstChunk();
        slot1.release();
    });
});
