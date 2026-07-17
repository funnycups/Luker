/**
 * First-chunk barrier for orchestrator sub-agent fan-out.
 *
 * See tests/orchestrator/dispatch-barrier/dispatch-barrier.test.js for
 * the full contract; this module implements it.
 *
 * Model:
 *   - One barrier instance per orchestrator run (director dispatcher,
 *     spec pipeline, agenda pipeline). Instances share no state.
 *   - Keys are typically the resolved connection-profile name for a
 *     dispatch. When two dispatches share a key the second/third/... one
 *     is a follower that awaits the lead's first upstream chunk before
 *     firing its own request. This gives the upstream provider (e.g.
 *     Anthropic) time to warm its prompt cache so the followers hit
 *     cache-read instead of racing cold cache-writes.
 *   - `acquire()` is synchronous and atomic — under JS's single-threaded
 *     model, all concurrent `Promise.all(nodes.map(...))` fan-outs pass
 *     through it serially, so the first arrival wins the lead slot with
 *     no race condition.
 *   - `signalFirstChunk()` is idempotent so streaming code can call it
 *     on every delta without gating "am I the first?".
 *   - `release()` on a lead frees the slot for the next batch AND
 *     resolves any still-waiting followers (fail-open: a lead that
 *     errored / aborted before ever streaming must not hang siblings).
 *   - `release()` on a follower is a no-op — only the lead owns the slot.
 *   - Followers always RESOLVE, never reject. The barrier is a pure
 *     latency optimization; siblings must not fail because the lead did.
 *   - Falsy keys (null / '' / undefined) opt out entirely: every caller
 *     is a solo lead with no coordination. Used when the caller cannot
 *     compute a stable grouping key (e.g. preset name failed to resolve).
 */

export function createFirstChunkBarrier() {
    // Map<key, { firstChunkPromise, resolveFirstChunk }>
    // A slot exists iff there is a live lead for that key; followers
    // read `firstChunkPromise` off the slot and never touch it themselves.
    const slots = new Map();

    function acquire(key) {
        // Opt-out for falsy keys — degenerate slots always claim
        // lead-role but do no coordination. Keeps callers branch-free.
        if (!key) {
            return {
                role: 'lead',
                wait: Promise.resolve(),
                signalFirstChunk: () => {},
                release: () => {},
            };
        }

        const existing = slots.get(key);
        if (existing) {
            // Follower: share the lead's promise. `wait` never rejects —
            // release() also resolves it, so a lead failure fails-open.
            return {
                role: 'follower',
                wait: existing.firstChunkPromise,
                signalFirstChunk: () => {},
                release: () => {},
            };
        }

        // New lead — install the slot BEFORE returning so the very
        // next synchronous `acquire(key)` sees us and becomes a
        // follower. This atomicity relies on JS's single-threaded
        // execution model.
        let resolveFirstChunk;
        const firstChunkPromise = new Promise(resolve => { resolveFirstChunk = resolve; });
        const slot = { firstChunkPromise, resolveFirstChunk };
        slots.set(key, slot);

        // Guard release / signal against being called after the slot
        // has already been evicted (e.g. release() then a late
        // signalFirstChunk() from a straggling stream chunk) so callers
        // can safely fire both in any order.
        let evicted = false;

        return {
            role: 'lead',
            wait: Promise.resolve(),
            signalFirstChunk: () => {
                // Idempotent — Promise.resolve is a no-op after settle.
                resolveFirstChunk();
            },
            release: () => {
                if (evicted) return;
                evicted = true;
                // Resolve any still-waiting followers (fail-open) BEFORE
                // evicting the slot — otherwise a follower that raced
                // `acquire()` between signal and release could sit on a
                // never-resolving promise if we cleared the slot first.
                resolveFirstChunk();
                // Only evict if we're still the current occupant. A late
                // release from an evicted lead must not clobber a
                // subsequent batch's lead (which would silently release
                // that batch's followers too early).
                if (slots.get(key) === slot) {
                    slots.delete(key);
                }
            },
        };
    }

    return { acquire };
}
