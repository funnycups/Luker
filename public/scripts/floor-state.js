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

    // ready gate: pending while one or more long-running operations
    // (rematerialize, patch+commit, init) are in flight, resolved otherwise.
    // Counted so nested / overlapping begin/end calls compose correctly — the
    // gate only resolves when the LAST in-flight operation completes.
    let pendingCount = 0;
    let readyPromise = Promise.resolve();
    let pendingResolver = null;

    function beginPending() {
        if (pendingCount === 0) {
            readyPromise = new Promise((resolve) => { pendingResolver = resolve; });
        }
        pendingCount++;
    }

    function endPending() {
        if (pendingCount === 0) return;
        pendingCount--;
        if (pendingCount === 0 && pendingResolver) {
            const r = pendingResolver;
            pendingResolver = null;
            r();
        }
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

    /**
     * Inherit the source chat's commit log into a freshly-created branch / checkpoint
     * chat. The host (`createBranch` in `bookmarks.js`) only copies the chat file
     * itself; chat-state sidecars do NOT follow automatically. Without this handler
     * the next CHAT_CHANGED into the new branch would find an empty log and reset
     * the data namespace to {}, silently losing all accumulated state.
     *
     * Strategy: read the source chat's log, truncate commits past the branch point
     * (mesId is the last included floor; new chat length = mesId + 1), and write
     * the result to the target chat's log sidecar. We do NOT seed the target's
     * data namespace — the next CHAT_CHANGED on the new branch will rematerialize
     * using the branch's actual chat array (and the swipe map derived from it).
     */
    async function handleBranchCreated(payload) {
        if (destroyed) return;
        const sourceTarget = payload?.sourceTarget;
        const targetTarget = payload?.targetTarget;
        const mesId = Number(payload?.mesId);
        if (!sourceTarget || typeof sourceTarget !== 'object') return;
        if (!targetTarget || typeof targetTarget !== 'object') return;
        if (!Number.isInteger(mesId) || mesId < 0) return;
        try {
            const raw = await runtime.getChatState(logNamespace, { target: sourceTarget });
            const sourceLog = normalizeLog(raw);
            const survivors = truncateCommits(sourceLog.commits, mesId + 1);
            if (survivors.length === 0) return;
            const result = await runtime.updateChatState(
                logNamespace,
                () => ({ version: LOG_VERSION, commits: survivors }),
                { target: targetTarget },
            );
            if (!result || result.ok === false) {
                console.warn(`[floor-state:${namespace}] branch inheritance write failed`, result);
            }
        } catch (error) {
            console.warn(`[floor-state:${namespace}] branch inheritance failed`, error);
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
    const onBranchCreated = (payload) => handleBranchCreated(payload);

    runtime.eventSource.on(runtime.event_types.CHAT_CHANGED, onChatChanged);
    runtime.eventSource.on(runtime.event_types.MESSAGE_SWIPED, onMessageSwiped);
    runtime.eventSource.on(runtime.event_types.MESSAGE_DELETED, onMessageDeleted);
    runtime.eventSource.on(runtime.event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted);
    if (runtime.event_types.CHAT_BRANCH_CREATED) {
        runtime.eventSource.on(runtime.event_types.CHAT_BRANCH_CREATED, onBranchCreated);
    }

    // --- public API ---

    /**
     * Apply RFC 6902 operations to the data namespace and append a commit
     * tagged with the current chat tail (floor, swipeId).
     *
     * Order is commit-first: appending the log entry before writing the data
     * namespace makes the log the source of truth in any race with a concurrent
     * rematerialize. If the data write fails we recover by replaying the log,
     * so a successful return implies "the operation is recorded and the data
     * namespace reflects it (or will, after the recovery rematerialize)".
     *
     * @param {object[]} operations
     * @returns {Promise<boolean>} true on success
     */
    async function patch(operations) {
        if (destroyed) return false;
        if (!Array.isArray(operations) || operations.length === 0) return true;

        const target = inferCommitTargetFromChat(runtime.getChat());
        if (!target) return true;

        beginPending();
        try {
            const appended = await appendCommit({
                floor: target.floor,
                swipeId: target.swipeId,
                patches: operations,
            });
            if (!appended) return false;

            const ok = await runtime.patchChatState(namespace, operations);
            if (!ok) {
                console.warn(`[floor-state:${namespace}] patch data-namespace write failed; reconciling from log`);
                await rematerialize();
            }
            return true;
        } finally {
            endPending();
        }
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
        if (runtime.event_types.CHAT_BRANCH_CREATED) {
            runtime.eventSource.removeListener(runtime.event_types.CHAT_BRANCH_CREATED, onBranchCreated);
        }
        // Force-resolve any pending gate so callers awaiting ready() unblock; in-flight
        // work will complete on its own without further side effects on this instance.
        pendingCount = 0;
        if (pendingResolver) {
            const r = pendingResolver;
            pendingResolver = null;
            r();
        }
    }

    const instance = Object.freeze({
        namespace,
        patch,
        update,
        get,
        ready,
        destroy,
    });

    // Initial rematerialize: catch the data namespace up to the persisted log
    // so `fs.get()` reflects the source of truth even when the instance is
    // created after CHAT_CHANGED already fired, or when the previous session
    // left the namespace out of sync. Skipped when the log is absent or empty
    // to avoid clobbering a never-touched namespace with `{}`. Wrapped in the
    // ready gate so callers can `await fs.ready()` to wait for it.
    beginPending();
    (async () => {
        try {
            if (destroyed) return;
            const log = await readLog();
            if (destroyed) return;
            if (log.commits.length === 0) return;
            const swipeMap = buildSwipeMapFromChat(runtime.getChat());
            const targetState = computeTargetState(log.commits, swipeMap);
            const result = await runtime.updateChatState(namespace, () => targetState);
            if (!result || result.ok === false) {
                console.warn(`[floor-state:${namespace}] initial rematerialize write failed`, result);
            }
        } catch (error) {
            console.warn(`[floor-state:${namespace}] initial rematerialize failed`, error);
        } finally {
            endPending();
        }
    })();

    return instance;
}
