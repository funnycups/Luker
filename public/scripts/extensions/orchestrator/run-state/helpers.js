// public/scripts/extensions/orchestrator/run-state/helpers.js
/**
 * Convenience wrappers that handle the round/section status finalization
 * so the four runners can stay terse. They always re-throw to preserve
 * upstream error handling.
 */

export function withRound(store, runId, roundSpec, fn) {
    const roundId = store.appendRound({ runId, round: roundSpec });
    try {
        const out = fn(roundId);
        store.setRoundStatus({ runId, roundId, status: 'done' });
        return out;
    } catch (err) {
        try { store.setRoundStatus({ runId, roundId, status: 'failed' }); }
        catch (_) { /* store may be cleared; swallow */ }
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
        try { store.setSectionStatus({ runId, roundId, sectionId, status: 'failed' }); }
        catch (_) { /* store may be cleared; swallow */ }
        throw err;
    }
}
