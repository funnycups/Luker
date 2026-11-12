// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Listens to one or more run-panel stores (orchestrator, search-tools, …)
// and keeps:
//   - a live copy of each store's current run, plus per-section start/end stamps
//   - a per-account history of finished runs in localStorage
//
// Runs are keyed internally by composite `${source}:${runId}` so independent
// stores whose counters both start at 1 never collide on lookup, stop,
// delete, or trace export.

import { accountLocalStorage } from '../lens-shared/current-account.js';
import { i18n } from './dock-i18n.js';

export const HISTORY_KEY = 'orchestraLens.history.v1';
const TERMINAL = new Set(['done', 'failed']);
const UNINITIALIZED = Symbol('uninitialized');

export function runKeyOf(source, runId) {
    return `${String(source || 'orchestrator')}:${String(runId ?? '')}`;
}

export function parseRunKey(target) {
    if (!target) return { source: '', runId: '', runKey: '' };
    if (typeof target === 'string') {
        const idx = target.indexOf(':');
        if (idx < 0) return { source: '', runId: target, runKey: target };
        return { source: target.slice(0, idx), runId: target.slice(idx + 1), runKey: target };
    }
    if (typeof target === 'object') {
        if (target.runKey && !target.source) return parseRunKey(target.runKey);
        const source = String(target.source || '');
        const runId = target.runId == null ? '' : String(target.runId);
        return { source, runId, runKey: source ? runKeyOf(source, runId) : runId };
    }
    return { source: '', runId: '', runKey: '' };
}

function safeJson(value) {
    if (value == null) return null;
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function cloneRun(run) {
    if (!run) return null;
    return {
        runId: run.runId,
        mode: run.mode,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        chatKey: run.chatKey,
        finalText: run.finalText == null ? null : String(run.finalText),
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
                body: String(section.body ?? ''),
                meta: safeJson(section.meta),
            })),
        })),
    };
}

export function serializeRunTrace(run) {
    if (!run) return '';
    return JSON.stringify(run, (key, value) => (key === 'abortFn' || key === 'stopFn' ? undefined : value), 2);
}

export function createMemoryStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

function isQuotaError(err) {
    return Boolean(
        err?.name === 'QuotaExceededError'
        || err?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || err?.code === 22
        || err?.code === 1014
        || /quota/i.test(String(err?.message || '')),
    );
}

/**
 * @param {{
 *   storage?: Storage,
 *   now?: () => number,
 *   wallNow?: () => number,
 *   getRunContext?: (source: string) => object,
 *   onError?: (error: { type: string, message: string, cause?: unknown }) => void,
 * }} [options]
 */
export function createRecorder({
    storage = accountLocalStorage(),
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    wallNow = () => Date.now(),
    getRunContext = () => ({}),
    onError = null,
} = {}) {
    const attached = new Map();
    const listeners = new Set();
    const hasHandleFn = typeof storage?.getHandle === 'function';

    let history = null;
    let owner = UNINITIALIZED;
    let storageError = null;
    let latest = null;
    let seq = 0;
    let notifyQueued = false;

    const isUnauthenticated = () => hasHandleFn && !storage.getHandle();

    function emit(kind, payload) {
        for (const fn of [...listeners]) {
            try { fn(kind, payload); } catch (err) { console.error('[run-panel/recorder] listener failed', err); }
        }
    }

    function reportError(type, cause) {
        const message = type === 'parse'
            ? i18n('Run history could not be loaded (stored data is corrupted). Existing data was preserved.')
            : type === 'quota'
                ? i18n('Run history could not be saved (storage quota exceeded).')
                : i18n('Run history could not be saved.');
        storageError = { type, message, cause };
        console.error('[run-panel/recorder]', message, cause);
        globalThis.toastr?.error?.(message);
        try { onError?.(storageError); } catch (err) { console.error('[run-panel/recorder] onError failed', err); }
        emit('error', storageError);
    }

    function loadHistory() {
        if (isUnauthenticated()) return [];
        const raw = storage?.getItem(HISTORY_KEY);
        if (raw == null || raw === '') return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                reportError('parse', new TypeError('Run history JSON is not an array'));
                return [];
            }
            return parsed.map(item => (item && item.runId != null && item.source
                ? { ...item, runKey: item.runKey || runKeyOf(item.source, item.runId) }
                : item));
        } catch (err) {
            reportError('parse', err);
            return [];
        }
    }

    const runs = () => {
        if (isUnauthenticated()) return [];
        const current = hasHandleFn ? storage.getHandle() : undefined;
        if (current !== owner || history === null) {
            owner = current;
            storageError = null;
            history = loadHistory();
        }
        return history;
    };

    function saveHistory() {
        if (isUnauthenticated()) return false;
        if (storageError?.type === 'parse') {
            reportError('parse', storageError.cause);
            return false;
        }
        try {
            storage?.setItem(HISTORY_KEY, JSON.stringify(history));
            if (storageError?.type === 'quota' || storageError?.type === 'storage') {
                storageError = null;
            }
            return true;
        } catch (err) {
            reportError(isQuotaError(err) ? 'quota' : 'storage', err);
            return false;
        }
    }

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
        entry.current = {
            run,
            times: {},
            context: contextFor(entry.source),
            startedAtWall,
            finished: run?.status !== 'running',
            source: entry.source,
            seq: ++seq,
        };
        latest = entry.current;
    }

    function snapshot(current) {
        if (!current) return null;
        if (!current.run) return current.lastSnap || null;
        const snap = cloneRun(current.run);
        snap.times = JSON.parse(JSON.stringify(current.times));
        snap.startedAtWall = current.startedAtWall;
        snap.now = now();
        snap.source = current.source;
        snap.runKey = runKeyOf(current.source, snap.runId);
        snap.chatId = String(current.context.chatId || '');
        snap.chatLabel = String(current.context.chatLabel || '');
        snap.floor = Number(current.context.floor) || 0;
        snap.presetName = String(current.context.presetName || '');
        current.lastSnap = snap;
        return snap;
    }

    function finalize(current) {
        if (!current || current.finished) return;
        const snap = snapshot(current);
        current.finished = true;
        if (!snap || isUnauthenticated()) return;
        const existing = runs();
        if (storageError?.type === 'parse') {
            reportError('parse', storageError.cause);
            return;
        }
        const prevHistory = history;
        history = [snap, ...existing.filter(item => runKeyOf(item.source, item.runId) !== snap.runKey)];
        if (!saveHistory()) {
            history = prevHistory;
        }
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
    const currentSnapshots = () => [...attached.values()]
        .map(entry => entry.current)
        .filter(Boolean)
        .sort((a, b) => b.seq - a.seq)
        .map(c => snapshot(c))
        .filter(Boolean);

    return {
        attach(store, source = 'orchestrator') {
            if (!store?.subscribe || attached.has(store)) return;
            const entry = { store, source: String(source || 'orchestrator'), current: null, unsubscribe: null };
            attached.set(store, entry);
            entry.unsubscribe = store.subscribe(event => onEvent(entry, event));
            const run = store.getCurrentRun?.();
            if (run) begin(entry, run, wallNow() - Math.max(0, now() - (run.startedAt || now())));
        },
        detach() {
            for (const entry of attached.values()) entry.unsubscribe?.();
            attached.clear();
        },
        hasSource: (source) => [...attached.values()].some(entry => entry.source === source),
        current: () => snapshot(latest),
        currents: currentSnapshots,
        getRun(target) {
            const { source, runId, runKey } = parseRunKey(target);
            if (!runKey) return null;
            const match = (item) => {
                if (source) return runKeyOf(item.source, item.runId) === runKey;
                return String(item.runId) === runId;
            };
            return currentSnapshots().find(match) || runs().find(match) || null;
        },
        isRunning: () => running().length > 0,
        stop(target) {
            const { source, runId, runKey } = parseRunKey(target);
            const live = running().sort((a, b) => b.seq - a.seq).find((current) => {
                if (!target) return true;
                if (source) return runKeyOf(current.source, current.run.runId) === runKey;
                return String(current.run.runId) === runId;
            });
            const fn = live?.run?.stopFn || live?.run?.abortFn;
            if (typeof fn !== 'function') return false;
            fn();
            return true;
        },
        history: () => runs().slice(),
        getStorageError: () => storageError,
        removeRun(target) {
            if (isUnauthenticated()) return;
            const { source, runId, runKey } = parseRunKey(target);
            if (!runKey) return;
            const existing = runs();
            if (storageError?.type === 'parse') {
                reportError('parse', storageError.cause);
                return;
            }
            const prevHistory = history;
            history = existing.filter((item) => {
                if (source) return runKeyOf(item.source, item.runId) !== runKey;
                return String(item.runId) !== runId;
            });
            if (!saveHistory()) history = prevHistory;
            else emit('history');
        },
        removeWhere(predicate) {
            if (isUnauthenticated()) return;
            const existing = runs();
            if (storageError?.type === 'parse') {
                reportError('parse', storageError.cause);
                return;
            }
            const prevHistory = history;
            history = existing.filter(item => !predicate(item));
            if (!saveHistory()) history = prevHistory;
            else emit('history');
        },
        clearHistory() {
            if (isUnauthenticated()) return;
            storageError = null;
            history = [];
            storage?.removeItem(HISTORY_KEY);
            emit('history');
        },
        serializeRunTrace(target) {
            const run = target && typeof target === 'object' && Array.isArray(target.rounds)
                ? target
                : this.getRun(target);
            return serializeRunTrace(run);
        },
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
}
