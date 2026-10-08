// public/scripts/run-panel/helpers.js
/**
 * Convenience wrappers that finalize round/section status. They take the
 * store as their first argument so callers can use any store instance.
 */

export function withRound(store, runId, roundSpec, fn) {
    const roundId = store.appendRound({ runId, round: roundSpec });
    try {
        const out = fn(roundId);
        if (out && typeof out.then === 'function') {
            return out.then(
                (value) => {
                    store.setRoundStatus({ runId, roundId, status: 'done' });
                    return value;
                },
                (err) => {
                    try { store.setRoundStatus({ runId, roundId, status: 'failed' }); } catch (_) { /* store may be cleared; swallow */ }
                    throw err;
                },
            );
        }
        store.setRoundStatus({ runId, roundId, status: 'done' });
        return out;
    } catch (err) {
        try { store.setRoundStatus({ runId, roundId, status: 'failed' }); } catch (_) { /* store may be cleared; swallow */ }
        throw err;
    }
}

export async function withStreamingSection(store, runId, roundId, sectionSpec, asyncFn) {
    const sectionId = store.ensureSection({ runId, roundId, section: sectionSpec });
    const append = (delta) => store.appendToSection({ runId, roundId, sectionId, delta });
    try {
        const out = await asyncFn(append, sectionId);
        store.setSectionStatus({ runId, roundId, sectionId, status: 'done' });
        return out;
    } catch (err) {
        try { store.setSectionStatus({ runId, roundId, sectionId, status: 'failed' }); } catch (_) { /* store may be cleared; swallow */ }
        throw err;
    }
}
