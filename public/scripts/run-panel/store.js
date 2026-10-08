// public/scripts/run-panel/store.js
/**
 * createRunStore — a factory producing an isolated in-memory run store.
 *
 * Each consumer (orchestrator, search-tools, …) creates its own store, so
 * concurrent runs never collide. Methods mirror the original orchestrator
 * RunStateStore; the only behavioral additions are that RUN_CLEARED carries
 * the runId and SECTION_STATUS carries meta.
 */

import * as EV from './events.js';

export function createRunStore() {
    let currentRun = null;
    let runCounter = 0;
    const listeners = new Set();

    function emit(event) {
        for (const fn of listeners) {
            try { fn(event); } catch (err) { console.error('RunStore listener threw:', err); }
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') throw new Error('subscribe requires a function');
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function ensureRunningMatchesId(runId) {
        if (!currentRun) {
            throw new Error(`RunStore: no current run (expected ${runId})`);
        }
        if (currentRun.runId !== runId) {
            throw new Error(
                `RunStore: runId mismatch (current=${currentRun.runId}, expected=${runId})`,
            );
        }
    }

    function startRun({ mode, chatKey, abortFn = null, stopFn = null, quiet = false }) {
        if (currentRun && currentRun.status === 'running') {
            throw new Error('A run is already in progress.');
        }
        if (currentRun) currentRun = null;
        runCounter += 1;
        const runId = `run_${runCounter}_${Date.now().toString(36)}`;
        currentRun = {
            runId,
            mode: String(mode || ''),
            status: 'running',
            startedAt: performance.now(),
            endedAt: null,
            chatKey: chatKey == null ? null : String(chatKey),
            rounds: [],
            finalText: null,
            error: null,
            tokensSpent: null,
            cost: null,
            abortFn: typeof abortFn === 'function' ? abortFn : null,
            stopFn: typeof stopFn === 'function' ? stopFn : null,
            quiet: Boolean(quiet),
        };
        emit({ type: EV.RUN_STARTED, runId, mode: currentRun.mode, quiet: currentRun.quiet });
        return runId;
    }

    function getCurrentRun() { return currentRun; }

    function clearCurrentRun() {
        if (currentRun !== null) {
            const runId = currentRun.runId;
            currentRun = null;
            emit({ type: EV.RUN_CLEARED, runId });
        }
    }

    function findRound(roundId) {
        return currentRun.rounds.find((r) => r.id === roundId) || null;
    }

    function appendRound({ runId, round }) {
        ensureRunningMatchesId(runId);
        if (!round || typeof round.id !== 'string' || !round.id) {
            throw new Error('appendRound: round.id required');
        }
        if (findRound(round.id)) {
            throw new Error(`appendRound: duplicate round id ${round.id}`);
        }
        currentRun.rounds.push({
            id: round.id,
            label: String(round.label || round.id),
            status: 'running',
            startedAt: performance.now(),
            endedAt: null,
            sections: [],
        });
        emit({ type: EV.ROUND_APPENDED, runId, roundId: round.id });
        return round.id;
    }

    const TERMINAL_STEP_STATUSES = new Set(['done', 'failed']);

    function setRoundStatus({ runId, roundId, status }) {
        ensureRunningMatchesId(runId);
        const r = findRound(roundId);
        if (!r) throw new Error(`setRoundStatus: round ${roundId} not found`);
        r.status = String(status);
        if (TERMINAL_STEP_STATUSES.has(r.status) && r.endedAt === null) {
            r.endedAt = performance.now();
        }
        emit({ type: EV.ROUND_STATUS, runId, roundId, status: r.status });
    }

    function findSection(round, sectionId) {
        return round.sections.find((s) => s.id === sectionId) || null;
    }

    function ensureSection({ runId, roundId, section }) {
        ensureRunningMatchesId(runId);
        const r = findRound(roundId);
        if (!r) throw new Error(`ensureSection: round ${roundId} not found`);
        if (!section || typeof section.id !== 'string' || !section.id) {
            throw new Error('ensureSection: section.id required');
        }
        let s = findSection(r, section.id);
        if (s) return s.id;
        s = {
            id: section.id,
            kind: String(section.kind || 'note'),
            title: String(section.title || section.id),
            status: 'running',
            body: '',
            meta: section.meta != null ? section.meta : null,
        };
        r.sections.push(s);
        emit({ type: EV.SECTION_ENSURED, runId, roundId, sectionId: s.id });
        return s.id;
    }

    function appendToSection({ runId, roundId, sectionId, delta }) {
        ensureRunningMatchesId(runId);
        const r = findRound(roundId);
        if (!r) throw new Error(`appendToSection: round ${roundId} not found`);
        const s = findSection(r, sectionId);
        if (!s) throw new Error(`appendToSection: section ${sectionId} not found`);
        if (delta == null) return;
        s.body += String(delta);
        emit({ type: EV.SECTION_APPENDED, runId, roundId, sectionId, delta: String(delta) });
    }

    function setSectionStatus({ runId, roundId, sectionId, status, meta }) {
        ensureRunningMatchesId(runId);
        const r = findRound(roundId);
        if (!r) throw new Error(`setSectionStatus: round ${roundId} not found`);
        const s = findSection(r, sectionId);
        if (!s) throw new Error(`setSectionStatus: section ${sectionId} not found`);
        s.status = String(status);
        if (meta !== undefined) s.meta = meta;
        emit({ type: EV.SECTION_STATUS, runId, roundId, sectionId, status: s.status, meta: s.meta });
    }

    function finishRun({ runId, status, finalText = null, error = null }) {
        ensureRunningMatchesId(runId);
        currentRun.status = String(status);
        currentRun.endedAt = performance.now();
        if (finalText != null) currentRun.finalText = String(finalText);
        if (error != null) currentRun.error = String(error);
        emit({ type: EV.RUN_FINISHED, runId, status: currentRun.status });
    }

    function setRunMeta({ runId, tokensSpent, cost }) {
        ensureRunningMatchesId(runId);
        if (tokensSpent !== undefined) currentRun.tokensSpent = tokensSpent;
        if (cost !== undefined) currentRun.cost = cost;
        emit({ type: EV.RUN_META, runId });
    }

    function addTokenUsage({ runId, usage }) {
        ensureRunningMatchesId(runId);
        if (!usage || typeof usage !== 'object') return;
        const prompt = Number(usage.promptTokens ?? usage.prompt ?? 0) || 0;
        const completion = Number(usage.completionTokens ?? usage.completion ?? 0) || 0;
        const totalFromUsage = Number(usage.totalTokens ?? usage.total ?? 0) || 0;
        const total = totalFromUsage || (prompt + completion);
        if (prompt === 0 && completion === 0 && total === 0) return;
        const prev = currentRun.tokensSpent || { prompt: 0, completion: 0, total: 0 };
        currentRun.tokensSpent = {
            prompt: prev.prompt + prompt,
            completion: prev.completion + completion,
            total: prev.total + total,
        };
        emit({ type: EV.RUN_META, runId });
    }

    return {
        subscribe,
        getCurrentRun,
        startRun,
        clearCurrentRun,
        appendRound,
        setRoundStatus,
        ensureSection,
        appendToSection,
        setSectionStatus,
        finishRun,
        setRunMeta,
        addTokenUsage,
    };
}
