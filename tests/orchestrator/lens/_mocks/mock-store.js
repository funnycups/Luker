// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Minimal stand-in for Luker's run-panel store (same method names, same
// id-only events) so the tests can replay runs without Luker.

export function createMockRunStore({ now = () => performance.now() } = {}) {
    let current = null;
    let counter = 0;
    const listeners = new Set();
    const emit = (event) => { for (const fn of [...listeners]) fn(event); };
    const round = (id) => current?.rounds.find(r => r.id === id);
    const section = (r, id) => round(r)?.sections.find(s => s.id === id);

    return {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        getCurrentRun: () => current,
        startRun({ mode, chatKey = null, quiet = false, stopFn = null }) {
            counter += 1;
            current = { runId: `run_${counter}_${Date.now().toString(36)}`, mode, status: 'running', startedAt: now(), endedAt: null, chatKey, rounds: [], finalText: null, error: null, tokensSpent: null, cost: null, abortFn: null, stopFn, quiet };
            emit({ type: 'run_started', runId: current.runId, mode, quiet });
            return current.runId;
        },
        appendRound({ runId, round: r }) {
            current.rounds.push({ id: r.id, label: r.label || r.id, status: 'running', startedAt: now(), endedAt: null, sections: [] });
            emit({ type: 'round_appended', runId, roundId: r.id });
            return r.id;
        },
        setRoundStatus({ runId, roundId, status }) {
            const r = round(roundId);
            r.status = status;
            if (status === 'done' || status === 'failed') r.endedAt = now();
            emit({ type: 'round_status', runId, roundId, status });
        },
        ensureSection({ runId, roundId, section: s }) {
            const r = round(roundId);
            if (!r.sections.some(x => x.id === s.id)) {
                r.sections.push({ id: s.id, kind: s.kind || 'note', title: s.title || s.id, status: 'running', body: '', meta: s.meta ?? null });
                emit({ type: 'section_ensured', runId, roundId, sectionId: s.id });
            }
            return s.id;
        },
        appendToSection({ runId, roundId, sectionId, delta }) {
            section(roundId, sectionId).body += String(delta);
            emit({ type: 'section_appended', runId, roundId, sectionId, delta });
        },
        setSectionStatus({ runId, roundId, sectionId, status, meta }) {
            const s = section(roundId, sectionId);
            s.status = status;
            if (meta !== undefined) s.meta = meta;
            emit({ type: 'section_status', runId, roundId, sectionId, status, meta: s.meta });
        },
        addTokenUsage({ runId, usage }) {
            const prev = current.tokensSpent || { prompt: 0, completion: 0, total: 0 };
            current.tokensSpent = { prompt: prev.prompt + (usage.prompt || 0), completion: prev.completion + (usage.completion || 0), total: prev.total + (usage.prompt || 0) + (usage.completion || 0) };
            emit({ type: 'run_meta', runId });
        },
        finishRun({ runId, status, finalText = null, error = null }) {
            current.status = status;
            current.endedAt = now();
            if (finalText != null) current.finalText = finalText;
            if (error != null) current.error = error;
            emit({ type: 'run_finished', runId, status });
        },
        clearCurrentRun() {
            const runId = current?.runId;
            current = null;
            emit({ type: 'run_cleared', runId });
        },
    };
}
