/**
 * Floor State — instance-based API for plugins / CardApps.
 *
 * Each instance owns one chat-state namespace (the "data" namespace) and
 * a private commit log stored in a sibling namespace (`<ns>__floor_log`).
 * The instance subscribes to four chat-structure events on the global
 * eventSource and rebuilds its data namespace by replaying its private
 * log against the current chat's swipe map.
 *
 * Why per-instance:
 *  - swipe / delete / chat-change semantics are intrinsically per-namespace;
 *    a shared global log forced unrelated namespaces to be coupled
 *  - one namespace = one owner = clear contract; double-write conflicts
 *    with raw chat-state are precluded by convention
 *  - tests can mock the deps cleanly
 *
 * Plugins must call `instance.destroy()` if they want to detach from
 * events (rare; typically the instance lives for the page session).
 */

import {
    LOG_VERSION,
    isValidCommit,
    normalizeLog,
    buildSwipeMapFromChat,
    computeTargetState,
    truncateCommits,
    removeSwipeFromCommits,
    inferCommitTargetFromChat,
} from './floor-state/core.js';

const LOG_SUFFIX = '__floor_log';

/**
 * Resolve runtime deps from script.js + events.js. Lazy so test files can
 * import this module without pulling in the full app bundle.
 */
async function makeDefaultDeps() {
    const script = await import('../../script.js');
    const events = await import('../events.js');
    return {
        getChatState: script.getChatState,
        patchChatState: script.patchChatState,
        updateChatState: script.updateChatState,
        buildObjectPatchOperationsAsync: script.buildObjectPatchOperationsAsync,
        eventSource: events.eventSource,
        event_types: events.event_types,
        getChat: () => script.chat,
    };
}

/**
 * Create a floor state instance bound to a chat-state namespace.
 *
 * Returns a Promise so default deps can be lazily resolved without
 * forcing module-load-time evaluation of script.js (which has DOM /
 * jQuery side effects unsuitable for Node test environments).
 *
 * @param {{ namespace: string }} options
 * @returns {Promise<FloorStateInstance>}
 */
export async function createFloorState(options) {
    const deps = await makeDefaultDeps();
    return createFloorStateWithDeps(options, deps);
}

/**
 * Synchronous variant accepting injected deps. Exported for tests; CardApp
 * and plugin code should prefer createFloorState() above.
 *
 * @param {{ namespace: string }} options
 * @param {object} deps
 * @returns {FloorStateInstance}
 */
export function createFloorStateWithDeps(options, deps) {
    const namespace = String(options?.namespace ?? '').trim().toLowerCase();
    if (!namespace) {
        throw new Error('[floor-state] createFloorState requires a non-empty namespace');
    }
    if (namespace.endsWith(LOG_SUFFIX)) {
        throw new Error(`[floor-state] namespace must not end with "${LOG_SUFFIX}"`);
    }
    const logNamespace = `${namespace}${LOG_SUFFIX}`;
    const runtime = deps;

    let destroyed = false;

    // ready gate: pending while a rematerialize is running, resolved otherwise.
    let readyPromise = Promise.resolve();
    let pendingResolver = null;

    function beginPending() {
        if (pendingResolver) return; // already pending; reuse same promise
        readyPromise = new Promise((resolve) => { pendingResolver = resolve; });
    }

    function endPending() {
        const r = pendingResolver;
        pendingResolver = null;
        if (r) r();
    }

    /**
     * Read and normalize the private commit log.
     */
    async function readLog() {
        const raw = await runtime.getChatState(logNamespace);
        return normalizeLog(raw);
    }

    /**
     * Replace the entire commit log with the given log object.
     */
    async function writeLog(nextLog) {
        const result = await runtime.updateChatState(logNamespace, () => nextLog);
        if (!result || result.ok === false) {
            console.warn(`[floor-state:${namespace}] writeLog failed`, result);
            return false;
        }
        return true;
    }

    /**
     * Append a single commit. Read-modify-write under updateChatState's
     * own retry semantics; commit log lives in its own namespace so this
     * does not contend with business writes.
     */
    async function appendCommit(commit) {
        if (!isValidCommit(commit)) return false;
        const result = await runtime.updateChatState(logNamespace, (current) => {
            const next = normalizeLog(current);
            next.commits.push(commit);
            return next;
        });
        if (!result || result.ok === false) {
            console.warn(`[floor-state:${namespace}] appendCommit failed`, result);
            return false;
        }
        return true;
    }

    /**
     * Compute the target state from the log + current chat, and overwrite
     * the data namespace with it.
     *
     * The ready gate is managed by the caller (event handlers) so that
     * compound operations like truncate+rematerialize stay pending in a
     * single observable transition.
     */
    async function rematerialize() {
        if (destroyed) return;
        try {
            const log = await readLog();
            const swipeMap = buildSwipeMapFromChat(runtime.getChat());
            const targetState = computeTargetState(log.commits, swipeMap);
            const result = await runtime.updateChatState(namespace, () => targetState);
            if (!result || result.ok === false) {
                console.warn(`[floor-state:${namespace}] rematerialize write failed`, result);
            }
        } catch (error) {
            console.warn(`[floor-state:${namespace}] rematerialize failed`, error);
        }
    }

    /**
     * Truncate commits at floor >= newChatLength then rematerialize.
     */
    async function handleMessageDeleted(newChatLength) {
        if (destroyed) return;
        beginPending();
        try {
            const log = await readLog();
            const survivors = truncateCommits(log.commits, Number(newChatLength));
            if (survivors.length !== log.commits.length) {
                await writeLog({ version: LOG_VERSION, commits: survivors });
            }
            await rematerialize();
        } catch (error) {
            console.warn(`[floor-state:${namespace}] truncate failed`, error);
        } finally {
            endPending();
        }
    }

    /**
     * Drop deleted swipe and shift higher swipeIds down on that floor.
     */
    async function handleSwipeDeleted(payload) {
        if (destroyed) return;
        const messageId = Number(payload?.messageId);
        const swipeId = Number(payload?.swipeId);
        if (!Number.isInteger(messageId) || !Number.isInteger(swipeId)) return;
        beginPending();
        try {
            const log = await readLog();
            const next = removeSwipeFromCommits(log.commits, messageId, swipeId);
            if (next.length !== log.commits.length || next.some((c, i) => c !== log.commits[i])) {
                await writeLog({ version: LOG_VERSION, commits: next });
            }
            await rematerialize();
        } catch (error) {
            console.warn(`[floor-state:${namespace}] swipe-delete failed`, error);
        } finally {
            endPending();
        }
    }

    // --- event wiring ---

    const onChatChanged = async () => {
        beginPending();
        try { await rematerialize(); }
        finally { endPending(); }
    };
    const onMessageSwiped = async () => {
        beginPending();
        try { await rematerialize(); }
        finally { endPending(); }
    };
    const onMessageDeleted = (newChatLength) => handleMessageDeleted(newChatLength);
    const onMessageSwipeDeleted = (payload) => handleSwipeDeleted(payload);

    runtime.eventSource.on(runtime.event_types.CHAT_CHANGED, onChatChanged);
    runtime.eventSource.on(runtime.event_types.MESSAGE_SWIPED, onMessageSwiped);
    runtime.eventSource.on(runtime.event_types.MESSAGE_DELETED, onMessageDeleted);
    runtime.eventSource.on(runtime.event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);

    // --- public API ---

    /**
     * Apply RFC 6902 operations to the data namespace and append a commit
     * tagged with the current chat tail (floor, swipeId).
     *
     * @param {object[]} operations
     * @returns {Promise<boolean>} true on success
     */
    async function patch(operations) {
        if (destroyed) return false;
        if (!Array.isArray(operations) || operations.length === 0) return true;

        const ok = await runtime.patchChatState(namespace, operations);
        if (!ok) return false;

        const target = inferCommitTargetFromChat(runtime.getChat());
        if (!target) return true;

        await appendCommit({
            floor: target.floor,
            swipeId: target.swipeId,
            patches: operations,
        });
        return true;
    }

    /**
     * Read current state, run reducer, diff into RFC 6902 operations,
     * apply patch + append commit. Returns false on patch failure.
     *
     * @param {(state: object) => object} reducer
     * @returns {Promise<boolean>}
     */
    async function update(reducer) {
        if (destroyed) return false;
        if (typeof reducer !== 'function') return false;

        const current = (await runtime.getChatState(namespace)) ?? {};
        const next = await reducer(current);
        if (!next || typeof next !== 'object' || Array.isArray(next)) return true;

        const operations = await runtime.buildObjectPatchOperationsAsync(current, next);
        if (!Array.isArray(operations) || operations.length === 0) return true;
        return patch(operations);
    }

    /**
     * Read current data namespace state.
     *
     * @returns {Promise<object|null>}
     */
    async function get() {
        if (destroyed) return null;
        return (await runtime.getChatState(namespace)) ?? null;
    }

    /**
     * Resolve when no rematerialize is in flight. Plugins that read state
     * inside event handlers should `await ready()` first to avoid stale reads.
     *
     * @returns {Promise<void>}
     */
    function ready() {
        return readyPromise;
    }

    /**
     * Detach event listeners. Optional — most instances live for the page session.
     */
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        runtime.eventSource.removeListener(runtime.event_types.CHAT_CHANGED, onChatChanged);
        runtime.eventSource.removeListener(runtime.event_types.MESSAGE_SWIPED, onMessageSwiped);
        runtime.eventSource.removeListener(runtime.event_types.MESSAGE_DELETED, onMessageDeleted);
        runtime.eventSource.removeListener(runtime.event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
        endPending();
    }

    return Object.freeze({
        namespace,
        patch,
        update,
        get,
        ready,
        destroy,
    });
}
