// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Listens to one or more run-panel stores (the orchestrator's, and the
// search agent's) and keeps:
//   - a live copy of each store's current run, plus per-section start/end
//     stamps (the stores only time rounds; spec nodes share one round)
//   - a small history of finished runs, persisted to localStorage
//
// Store events carry ids only; data is read via getCurrentRun(). No DOM.
// `storage` is injectable so Node tests can pass a Map-backed shim.

import { i18n } from '../i18n.js';

const HISTORY_KEY = 'orchestraLens.history.v1';
const MAX_RUNS = 30;
const MAX_BODY = 24000;
const TERMINAL = new Set(['done', 'failed']);

function safeJson(value) {
    if (value == null) return null;
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function cloneRun(run, { truncate = false } = {}) {
    if (!run) return null;
    const cut = (text) => {
        const value = String(text ?? '');
        return truncate && value.length > MAX_BODY ? `${value.slice(0, MAX_BODY)}\n…${i18n('(content too long, truncated)')}` : value;
    };
    return {
        runId: run.runId,
        mode: run.mode,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        chatKey: run.chatKey,
        finalText: run.finalText == null ? null : cut(run.finalText),
        error: run.error,
        tokensSpent: run.tokensSpent ? { ...run.tokensSpent } : null,
        quiet: Boolean(run.quiet),
        rounds: (run.rounds || []).map(round => ({
            id: round.id,
            label: round.label,
            status: round.status,
            startedAt: round.startedAt,
            endedAt: round.endedAt,
            sections: (round.sections || []).map(section => ({
                id: section.id,
                kind: section.kind,
                title: section.title,
                status: section.status,
                body: cut(section.body),
                meta: safeJson(section.meta),
            })),
        })),
    };
}

export function createMemoryStorage() {
    const map = new Map();
    return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

/**
 * @param {{ storage?: Storage, now?: () => number, wallNow?: () => number, getRunContext?: (source: string) => object }} options
 *   getRunContext: called once when a run starts; returns { chatId, floor, chatLabel, presetName }.
 */
export function createRecorder({ storage = globalThis.localStorage, now = () => globalThis.performance?.now?.() ?? Date.now(), wallNow = () => Date.now(), getRunContext = () => ({}) } = {}) {
    // store → { source, unsubscribe, current }
    // current = { run (live ref), times, context, startedAtWall, finished, source, seq }
    const attached = new Map();
    const listeners = new Set();
    let history = loadHistory();
    let latest = null; // the most recently started `current` across stores
    let seq = 0;
    let notifyQueued = false;

    function loadHistory() {
        try {
            const parsed = JSON.parse(storage?.getItem(HISTORY_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    function saveHistory() {
        try {
            storage?.setItem(HISTORY_KEY, JSON.stringify(history));
        } catch {
            // Quota: drop the oldest half and retry once.
            history = history.slice(0, Math.floor(history.length / 2));
            try { storage?.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* give up quietly */ }
        }
    }

    function emit(kind, source) {
        for (const fn of [...listeners]) {
            try { fn(kind, source); } catch (err) { console.error('[orchestrator/lens] listener failed', err); }
        }
    }

    // Token streams fire many events per frame; collapse UI notifications.
    function emitSoon() {
        if (notifyQueued) return;
        notifyQueued = true;
        const flush = () => { notifyQueued = false; emit('update'); };
        if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(flush);
        else queueMicrotask(flush);
    }

    function contextFor(source) {
        try { return getRunContext(source) || {}; } catch { return {}; }
    }

    function begin(entry, run, startedAtWall) {
        entry.current = { run, times: {}, context: contextFor(entry.source), startedAtWall, finished: run?.status !== 'running', source: entry.source, seq: ++seq };
        latest = entry.current;
    }

    function snapshot(current, { truncate = false } = {}) {
        if (!current) return null;
        if (!current.run) return current.lastSnap || null;
        const snap = cloneRun(current.run, { truncate });
        snap.times = JSON.parse(JSON.stringify(current.times));
        snap.startedAtWall = current.startedAtWall;
        snap.now = now();
        snap.source = current.source;
        snap.chatId = String(current.context.chatId || '');
        snap.chatLabel = String(current.context.chatLabel || '');
        snap.floor = Number(current.context.floor) || 0;
        snap.presetName = String(current.context.presetName || '');
        current.lastSnap = snap;
        return snap;
    }

    function finalize(current) {
        if (!current || current.finished) return;
        const snap = snapshot(current, { truncate: true });
        current.finished = true;
        if (!snap || snap.quiet) return;
        history = [snap, ...history.filter(item => item.runId !== snap.runId || item.source !== snap.source)].slice(0, MAX_RUNS);
        saveHistory();
    }

    function onEvent(entry, event) {
        const run = entry.store.getCurrentRun?.() || null;
        const current = entry.current;
        const stamp = (field) => {
            if (!current) return;
            const key = `${event.roundId}/${event.sectionId}`;
            const times = current.times[key] || (current.times[key] = {});
            if (field === 'start' && times.start != null) return;
            times[field] = now();
        };
        switch (event?.type) {
            case 'run_started':
                begin(entry, run, wallNow());
                emit('start', entry.source);
                return;
            case 'section_ensured':
                stamp('start');
                break;
            case 'section_status':
                if (TERMINAL.has(event.status)) stamp('end');
                break;
            case 'run_finished':
                // Director can report twice (stop + cleanup); keep the first.
                if (current && run && current.run === run && !current.finished) {
                    finalize(current);
                    emit('finish', entry.source);
                }
                return;
            case 'run_cleared':
                if (current) {
                    finalize(current);
                    current.run = null;
                    current.cleared = true;
                }
                emit('clear', entry.source);
                return;
            default:
                break;
        }
        if (current && run && current.run !== run) current.run = run;
        emitSoon();
    }

    const running = () => [...attached.values()].map(entry => entry.current).filter(c => c?.run?.status === 'running');

    return {
        /** Idempotent per store. `source` names where runs come from ('orchestrator' | 'search'). */
        attach(store, source = 'orchestrator') {
            if (!store?.subscribe || attached.has(store)) return;
            const entry = { store, source, current: null, unsubscribe: null };
            attached.set(store, entry);
            entry.unsubscribe = store.subscribe(event => onEvent(entry, event));
            // A run may already be in flight when we attach.
            const run = store.getCurrentRun?.();
            if (run) begin(entry, run, wallNow() - Math.max(0, now() - (run.startedAt || now())));
        },
        detach() {
            for (const entry of attached.values()) entry.unsubscribe?.();
            attached.clear();
        },
        hasSource: (source) => [...attached.values()].some(entry => entry.source === source),
        /** Live run (fresh snapshot each call) or the last one seen, across all stores. */
        current: () => snapshot(latest),
        /** Live / last run of every store, newest first. */
        currents: () => [...attached.values()].map(entry => entry.current).filter(Boolean).sort((a, b) => b.seq - a.seq).map(c => snapshot(c)).filter(Boolean),
        isRunning: () => running().length > 0,
        stop() {
            const live = running().sort((a, b) => b.seq - a.seq)[0];
            const fn = live?.run?.stopFn || live?.run?.abortFn;
            if (typeof fn !== 'function') return false;
            fn();
            return true;
        },
        history: () => history.slice(),
        removeWhere(predicate) {
            history = history.filter(item => !predicate(item));
            saveHistory();
            emit('history');
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
