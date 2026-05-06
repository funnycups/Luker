/**
 * Floor State — instance-based API for plugins / CardApps.
 *
 * Each instance owns one chat-state namespace (the "data" namespace) and
 * a private commit log stored in a sibling namespace (`<ns>__floor_log`).
 * Instances no longer subscribe to the global event bus; instead, every
 * live instance is registered into a module-level `allInstances` set, and
 * core code calls the `settle*` exports (`settleMessageDeleted`,
 * `settleMessageSwiped`, `settleMessageSwipeDeleted`, `settleChatChanged`,
 * `settleBranchCreated`) **before** the corresponding `eventSource.emit(...)`
 * notifies plugin listeners. This guarantees that any plugin observing a
 * structural event sees a fully settled floor-state — there is no longer
 * a race between floor-state's listener and plugin listeners on the
 * shared event bus.
 *
 * Why per-instance:
 *  - swipe / delete / chat-change semantics are intrinsically per-namespace;
 *    a shared global log forced unrelated namespaces to be coupled
 *  - one namespace = one owner = clear contract; double-write conflicts
 *    with raw chat-state are precluded by convention
 *  - tests can mock the deps cleanly
 *
 * Plugins must call `instance.destroy()` if they want to detach from
 * the registry (rare; typically the instance lives for the page session).
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
    resolveCommitTarget,
} from './floor-state/core.js';

const LOG_SUFFIX = '__floor_log';

/**
 * Resolve runtime deps from script.js. Lazy so test files can
 * import this module without pulling in the full app bundle.
 *
 * Floor-state no longer subscribes to the global event bus; structural
 * events are driven by core via the settle* exports below. So
 * eventSource/event_types are not needed here.
 */
async function makeDefaultDeps() {
    const script = await import('../script.js');
    return {
        getChatState: script.getChatState,
        patchChatState: script.patchChatState,
        updateChatState: script.updateChatState,
        buildObjectPatchOperationsAsync: script.buildObjectPatchOperationsAsync,
        getChat: () => script.chat,
    };
}

/**
 * Module-level registry of all live FloorState instances. Each instance
 * registers itself in `createFloorStateWithDeps` and removes itself in
 * `destroy()`. Core code calls the `settle*` exports below to drive every
 * registered instance through a structural event in lock-step BEFORE the
 * corresponding `eventSource.emit(...)` notifies plugin subscribers — so
 * plugin handlers always observe a settled floor-state.
 *
 * Each plugin still owns its own instance with its own namespace and ready
 * gate; the registry only enumerates them.
 */
const allInstances = new Set();

/**
 * Drive every live instance through a MESSAGE_DELETED settle.
 * Call BEFORE `eventSource.emit(MESSAGE_DELETED, ...)` from core.
 *
 * Serial loop: instances live in independent namespaces and don't depend
 * on each other, but the underlying chat-state writer typically serializes
 * per-chat anyway, so a parallel `Promise.all` would not buy speed.
 *
 * @param {number} newChatLength
 * @returns {Promise<void>}
 */
export async function settleMessageDeleted(newChatLength) {
    for (const inst of allInstances) {
        await inst.__handleMessageDeleted(newChatLength);
    }
}

/**
 * Drive every live instance through a MESSAGE_SWIPED settle.
 * Call BEFORE `eventSource.emit(MESSAGE_SWIPED, ...)` from core.
 */
export async function settleMessageSwiped() {
    for (const inst of allInstances) {
        await inst.__handleMessageSwiped();
    }
}

/**
 * Drive every live instance through a MESSAGE_SWIPE_DELETED settle.
 * Call BEFORE `eventSource.emit(MESSAGE_SWIPE_DELETED, ...)` from core.
 *
 * @param {{messageId: number, swipeId: number}} payload
 */
export async function settleMessageSwipeDeleted(payload) {
    for (const inst of allInstances) {
        await inst.__handleSwipeDeleted(payload);
    }
}

/**
 * Drive every live instance through a CHAT_CHANGED settle.
 * Call BEFORE `eventSource.emit(CHAT_CHANGED, ...)` from core.
 */
export async function settleChatChanged() {
    for (const inst of allInstances) {
        await inst.__handleChatChanged();
    }
}

/**
 * Drive every live instance through a CHAT_BRANCH_CREATED settle.
 * Call BEFORE `eventSource.emit(CHAT_BRANCH_CREATED, ...)` from core.
 */
export async function settleBranchCreated(payload) {
    for (const inst of allInstances) {
        await inst.__handleBranchCreated(payload);
    }
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
     * Read and normalize the private commit log. Returns `{ log, existed }`
     * so callers that need to distinguish "log namespace truly never written"
     * from "log namespace exists but is empty" can do so — see the rematerialize
     * shortcut below for why this matters (a legacy chat with un-migrated data
     * sitting in the data namespace must not have its data clobbered by a
     * synthetic empty target state computed from a never-written log).
     */
    async function readLogWithExistence() {
        const raw = await runtime.getChatState(logNamespace);
        return { log: normalizeLog(raw), existed: raw != null };
    }

    async function readLog() {
        const { log } = await readLogWithExistence();
        return log;
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
     *
     * Defensive skip: if the log namespace has NEVER been written (raw null
     * from getChatState), we leave the data namespace alone. This prevents
     * data loss for legacy chats whose data namespace holds un-migrated
     * payload (e.g. memory-graph v8 opLog) when a structural event fires
     * before the plugin's migration code has had a chance to populate the
     * log. Once the log has been written even once (truncate to empty,
     * appendCommit, etc.), the namespace is "owned" by floor-state and
     * subsequent rematerializes proceed normally — including legitimate
     * resets to {} after all messages are deleted.
     */
    async function rematerialize() {
        if (destroyed) return;
        try {
            const { log, existed } = await readLogWithExistence();
            if (!existed && log.commits.length === 0) {
                console.info(`[floor-state:${namespace}] skipping rematerialize: log namespace never written, preserving existing data namespace`);
                return;
            }
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

    // --- structural-event handlers (driven by core via settle* exports) ---

    const __handleChatChanged = async () => {
        beginPending();
        try { await rematerialize(); }
        finally { endPending(); }
    };
    const __handleMessageSwiped = async () => {
        beginPending();
        try { await rematerialize(); }
        finally { endPending(); }
    };
    const __handleMessageDeleted = (newChatLength) => handleMessageDeleted(newChatLength);
    const __handleSwipeDeleted = (payload) => handleSwipeDeleted(payload);
    const __handleBranchCreated = (payload) => handleBranchCreated(payload);

    // --- public API ---

    /**
     * Apply RFC 6902 operations to the data namespace and append a commit
     * tagged with the current chat tail (floor, swipeId).
     *
     * The operations MUST be an incremental diff from the current materialized
     * data namespace state to the desired next state. Replay (`computeTargetState`
     * in core.js) walks commits in order and applies surviving patches against
     * `{}` — each commit assumes the prior surviving commits' patches are
     * already in place. Snapshot-from-empty patches (a commit that overwrites
     * the whole state) defeat the point of the log: every commit then carries
     * a full state copy, blowing up log size.
     *
     * If you have a fresh `next` object rather than a precomputed diff, prefer
     * `update(reducer)` — it reads the current state, runs your reducer, and
     * computes the diff for you.
     *
     * Order is commit-first: appending the log entry before writing the data
     * namespace makes the log the source of truth in any race with a concurrent
     * rematerialize. If the data write fails we recover by replaying the log,
     * so a successful return implies "the operation is recorded and the data
     * namespace reflects it (or will, after the recovery rematerialize)".
     *
     * Plugins that attach state to a non-tail floor (e.g. a memory extension
     * tagging an older message) can pass an explicit `{ floor }` — the swipeId
     * is then read from that floor's current swipe, or can be pinned with
     * `{ floor, swipeId }`. An invalid override (out-of-range floor, negative
     * swipeId) is rejected so misuse fails fast instead of silently
     * mis-attributing the commit.
     *
     * @param {object[]} operations — incremental RFC 6902 diff (prev → next)
     * @param {{floor?: number, swipeId?: number}} [options]
     * @returns {Promise<boolean>} true on success
     */
    async function patch(operations, options) {
        if (destroyed) return false;
        if (!Array.isArray(operations) || operations.length === 0) return true;

        const hasOverride = options !== null && options !== undefined
            && typeof options === 'object'
            && options.floor !== undefined && options.floor !== null;
        const target = hasOverride
            ? resolveCommitTarget(runtime.getChat(), options)
            : inferCommitTargetFromChat(runtime.getChat());
        if (!target) {
            if (hasOverride) {
                console.warn(`[floor-state:${namespace}] patch rejected: invalid floor/swipeId override`, options);
                return false;
            }
            return true;
        }

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
     * Read current state, run reducer, diff into incremental RFC 6902
     * operations, apply patch + append commit. Returns false on patch
     * failure. Preferred over `patch()` when you have a fresh `next` object
     * rather than a precomputed diff — `update` guarantees the recorded
     * patches are incremental against the current materialized state, which
     * is what replay expects.
     *
     * Accepts the same `{ floor, swipeId? }` override as `patch()`; when
     * provided, the resulting commit is tagged with the override instead of
     * the chat tail. The reducer always sees the materialized current state —
     * the override only controls which (floor, swipeId) the diff is attributed
     * to in the commit log.
     *
     * @param {(state: object) => object} reducer
     * @param {{floor?: number, swipeId?: number}} [options]
     * @returns {Promise<boolean>}
     */
    async function update(reducer, options) {
        if (destroyed) return false;
        if (typeof reducer !== 'function') return false;

        const current = (await runtime.getChatState(namespace)) ?? {};
        const next = await reducer(current);
        if (!next || typeof next !== 'object' || Array.isArray(next)) return true;

        const operations = await runtime.buildObjectPatchOperationsAsync(current, next);
        if (!Array.isArray(operations) || operations.length === 0) return true;
        return patch(operations, options);
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
     * Detach from the registry. Optional — most instances live for the page session.
     */
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        allInstances.delete(instance);
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
        // Internal handlers driven by floor-state.settle* — not for plugin use.
        __handleChatChanged,
        __handleMessageSwiped,
        __handleMessageDeleted,
        __handleSwipeDeleted,
        __handleBranchCreated,
    });

    allInstances.add(instance);

    // Test-only convenience: if the test mock event source exposes
    // `_bindInstance`, auto-register so existing tests that drive structural
    // events via `eventSource.emit(...)` continue to work without touching
    // every test setup. Production deps don't include an eventSource, so
    // this branch is silently inert in the real app.
    if (typeof deps?.eventSource?._bindInstance === 'function') {
        deps.eventSource._bindInstance(instance);
    }

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
