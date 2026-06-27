// SPDX-License-Identifier: AGPL-3.0-or-later
//
// External API for memory-graph. Injection observation surface for other
// extensions; richer read access lives in `api.js` via
// `openSession(context)` (or directly via `getMemoryGraphReadApi(store, context)`
// for callers that already hold a store reference).
//
// Contracts:
//   - All exports are READ-ONLY. Do not mutate the snapshots returned.
//   - This module never triggers store loading.

// ---------------------------------------------------------------------------
// Currently-injected node id capture
// ---------------------------------------------------------------------------
//
// memory-graph's main flow records the id sets that get injected into the
// main model context for the current chat turn here. Other extensions read
// the union as `excludeIds` to avoid surfacing nodes the model already has,
// and may subscribe via `addInjectionChangedListener` to be notified each
// time the snapshot updates.

let injectedState = {
    alwaysInjectIds: new Set(),
    recallSelectedIds: new Set(),
};

// Most-recent visibleIds snapshot recorded alongside the injected id sets.
// Defaults to an empty Set until callers begin supplying it.
let _lastVisibleIds = new Set();

// Subscribers to injection-changed events. Each entry is a callback that
// receives the snapshot object built by `__recordInjectedNodeIds`. Listener
// callbacks are wrapped in try/catch so one bad listener cannot block others.
const _changeListeners = new Set();

function toIdSet(value) {
    if (!value) return new Set();
    if (value instanceof Set) {
        return new Set(value);
    }
    if (typeof value[Symbol.iterator] === 'function') {
        const out = new Set();
        for (const item of value) {
            if (item === undefined || item === null) continue;
            const id = String(item).trim();
            if (id) out.add(id);
        }
        return out;
    }
    return new Set();
}

/**
 * Returns the node id sets that memory-graph's main flow has currently injected
 * into the main model context for this chat. Three classes:
 *   - alwaysInjectIds: nodes flagged alwaysInject (persistent injection)
 *   - recallSelectedIds: nodes selected by this turn's recall pipeline
 *   - visibleIds: nodes inside the active recall/visibility window (may be
 *     empty until a caller starts supplying them)
 *
 * Callers union the id sets for dedup against the main-flow injection
 * decision (e.g. so a recall pipeline doesn't re-surface nodes the model
 * already has).
 *
 * @param {object} _context unused at MVP; reserved for chat-scoped state
 * @returns {{alwaysInjectIds: Set<string>, recallSelectedIds: Set<string>, visibleIds: Set<string>}}
 */
export function getCurrentlyInjectedNodeIds(_context) {
    return {
        alwaysInjectIds: new Set(injectedState.alwaysInjectIds),
        recallSelectedIds: new Set(injectedState.recallSelectedIds),
        visibleIds: new Set(_lastVisibleIds),
    };
}

/**
 * InjectionState alias. Returns the same shape as `getCurrentlyInjectedNodeIds`
 * — defensive copies of the three id Sets that describe the current main-flow
 * injection decision.
 *
 * Kept as a separate export so read-api consumers can program against the
 * InjectionState name without worrying about future divergence between the two.
 *
 * @param {object} _context unused at MVP; reserved for chat-scoped state
 * @returns {{alwaysInjectIds: Set<string>, recallSelectedIds: Set<string>, visibleIds: Set<string>}}
 */
export function getMemoryGraphInjectionState(_context) {
    return getCurrentlyInjectedNodeIds(_context);
}

/**
 * Internal: invoked by main.js when the main-flow injection decision settles
 * (recall has resolved selectedNodes + alwaysInjectNodes). All three inputs
 * may be Sets, arrays, or any iterable of id strings; each defaults to an
 * empty Set when omitted.
 *
 * After the state is updated, any callbacks registered via
 * `addInjectionChangedListener` are invoked once with a frozen snapshot
 * containing defensive copies of the three id Sets. Listener errors are
 * caught and logged so one bad subscriber cannot block the others.
 *
 * @param {{alwaysInjectIds?: Iterable<string>, recallSelectedIds?: Iterable<string>, visibleIds?: Iterable<string>}} payload
 */
export function __recordInjectedNodeIds(payload) {
    injectedState = {
        alwaysInjectIds: toIdSet(payload?.alwaysInjectIds),
        recallSelectedIds: toIdSet(payload?.recallSelectedIds),
    };
    _lastVisibleIds = toIdSet(payload?.visibleIds);

    // Build a frozen snapshot for listeners. Object.freeze only seals the
    // wrapper object — the inner Sets stay mutable. That is intentional:
    // each listener gets its own defensive Set copies, so accidental mutation
    // by one listener cannot leak into others.
    const snapshot = Object.freeze({
        alwaysInjectIds: new Set(injectedState.alwaysInjectIds),
        recallSelectedIds: new Set(injectedState.recallSelectedIds),
        visibleIds: new Set(_lastVisibleIds),
    });

    for (const cb of _changeListeners) {
        try {
            cb(snapshot);
        } catch (err) {
            try {
                console.warn('[memory-graph/external-api] injection-changed listener threw:', err);
            } catch (_) { /* logger itself failed; ignore */ }
        }
    }
}

/**
 * Registers a callback that fires whenever `__recordInjectedNodeIds` updates
 * the injection snapshot. The callback receives a frozen object containing
 * defensive copies of `{ alwaysInjectIds, recallSelectedIds, visibleIds }`.
 *
 * Returns an idempotent unsubscribe function — calling it more than once is
 * safe and returns no value either way.
 *
 * @param {(snapshot: {alwaysInjectIds: Set<string>, recallSelectedIds: Set<string>, visibleIds: Set<string>}) => void} cb
 * @returns {() => void} unsubscribe
 */
export function addInjectionChangedListener(cb) {
    if (typeof cb !== 'function') {
        return () => { /* no-op for invalid input */ };
    }
    _changeListeners.add(cb);
    return () => { _changeListeners.delete(cb); };
}

/**
 * Removes a previously registered injection-changed listener. Returns true
 * if the listener was present and removed, false otherwise — matches the
 * semantics of `Set.prototype.delete`.
 *
 * @param {Function} cb the callback originally passed to `addInjectionChangedListener`
 * @returns {boolean}
 */
export function removeInjectionChangedListener(cb) {
    return _changeListeners.delete(cb);
}

/** @internal test helper: set a snapshot directly */
export function __setInjectedForTest(payload) {
    __recordInjectedNodeIds(payload);
}

/** @internal test helper: clear the snapshot back to empty sets */
export function __resetInjectedForTest() {
    injectedState = {
        alwaysInjectIds: new Set(),
        recallSelectedIds: new Set(),
    };
}

/**
 * @internal test helper: drop every registered injection-changed listener
 * and reset the cached visibleIds snapshot to an empty Set.
 */
export function __resetListenersForTest() {
    _changeListeners.clear();
    _lastVisibleIds = new Set();
}

/**
 * @internal test helper: overwrite the cached visibleIds snapshot directly,
 * bypassing `__recordInjectedNodeIds`. Useful when a test wants to assert
 * `getCurrentlyInjectedNodeIds` / `getMemoryGraphInjectionState` exposes the
 * visible-ids field without firing change listeners.
 *
 * @param {Iterable<string>} ids
 */
export function __setVisibleIdsForTest(ids) {
    _lastVisibleIds = toIdSet(ids);
}
