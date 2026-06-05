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
        deleteChatState: script.deleteChatState,
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

    // Replay cache. `fs.get()` derives the materialized state from the log
    // (commit chain replay) rather than reading a separate persisted data
    // namespace; this cache memoizes the replay so consecutive `get()` calls
    // don't re-walk the log. Invalidated on every write path (patch,
    // structural event handlers) so a stale cache is impossible once a
    // mutation lands.
    const CACHE_UNSET = Symbol('floor-state:cache-unset');
    let cachedReplay = CACHE_UNSET;
    let migrationDone = false;
    let migrationPromise = null;

    function invalidateCache() {
        cachedReplay = CACHE_UNSET;
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
     * Invalidate the in-memory replay cache. Called after any structural
     * change to the log or chat (truncate, swipe-delete, swipe-switch,
     * chat-changed) so the next `get()` re-runs `computeTargetState` against
     * the updated log + swipeMap.
     *
     * No disk write: the data namespace is no longer a persisted source of
     * truth in this design. The log is. So there's nothing to reconcile to —
     * the next read just replays.
     */
    async function rematerialize() {
        if (destroyed) return;
        invalidateCache();
    }

    /**
     * Truncate commits at floor >= newChatLength, then invalidate the cache.
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
            invalidateCache();
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
            invalidateCache();
        } catch (error) {
            console.warn(`[floor-state:${namespace}] swipe-delete failed`, error);
        } finally {
            endPending();
        }
    }

    /**
     * Inherit the source chat's commit log into a freshly-created branch /
     * checkpoint chat. The host (`createBranch` in `bookmarks.js`) only copies
     * the chat file itself; chat-state sidecars do NOT follow automatically.
     * Without this handler the next CHAT_CHANGED into the new branch would
     * find an empty log and silently lose all accumulated state.
     *
     * Strategy: read the source chat's log, truncate commits past the branch
     * point (mesId is the last included floor; new chat length = mesId + 1),
     * and write the result to the target chat's log sidecar. The target's
     * materialized state is derived on first `get()` against the new log.
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
     * Apply RFC 6902 operations as a new commit at the current chat tail
     * (floor, swipeId).
     *
     * The operations MUST be an incremental diff from the current materialized
     * state to the desired next state. Replay (`computeTargetState` in core.js)
     * walks commits in order and applies surviving patches against `{}` — each
     * commit assumes the prior surviving commits' patches are already in place.
     * Snapshot-from-empty patches (a commit that overwrites the whole state)
     * defeat the point of the log: every commit then carries a full state copy,
     * blowing up log size.
     *
     * If you have a fresh `next` object rather than a precomputed diff, prefer
     * `update(reducer)` — it reads the current state, runs your reducer, and
     * computes the diff for you.
     *
     * Single-write semantics: the log is the only persisted source of truth.
     * Materialized state is derived on demand via `get()` (log replay). A
     * successful patch means exactly one log append landed; there is no
     * separate data-namespace write that could disagree with the log.
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
            invalidateCache();
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

        const current = (await get()) ?? {};
        const next = await reducer(current);
        if (!next || typeof next !== 'object' || Array.isArray(next)) return true;

        const operations = await runtime.buildObjectPatchOperationsAsync(current, next);
        if (!Array.isArray(operations) || operations.length === 0) return true;
        return patch(operations, options);
    }

    /**
     * Replace the entire commit log with the supplied commit list, atomically.
     *
     * Use this for import / rebuild / reset workflows — anything that wants
     * to install a fresh history rather than append to the existing one.
     * Passing an empty array clears the log.
     *
     * Every commit is validated against `isValidCommit` plus a chat-range
     * check on its `floor` (must be `< chat.length`); the whole batch is
     * rejected if any commit fails, so the log never lands in a partly-valid
     * state. Single underlying write — there is no separate data namespace
     * to keep in sync (the log is the only persisted source of truth; see
     * `get()` for replay semantics).
     *
     * @param {object[]} commits — commit list in replay order
     * @returns {Promise<boolean>} true when the new log is durably persisted
     */
    async function reset(commits) {
        if (destroyed) return false;
        if (!Array.isArray(commits)) return false;
        const chat = runtime.getChat();
        const chatLen = Array.isArray(chat) ? chat.length : 0;
        for (let i = 0; i < commits.length; i++) {
            const commit = commits[i];
            if (!isValidCommit(commit)) {
                console.warn(`[floor-state:${namespace}] reset rejected: commit ${i} is malformed`, commit);
                return false;
            }
            if (commit.floor >= chatLen) {
                console.warn(`[floor-state:${namespace}] reset rejected: commit ${i} floor=${commit.floor} is out of range (chat.length=${chatLen})`);
                return false;
            }
        }
        beginPending();
        try {
            const ok = await writeLog({ version: LOG_VERSION, commits });
            if (!ok) return false;
            invalidateCache();
            return true;
        } finally {
            endPending();
        }
    }

    /**
     * Materialize the log into in-memory state. Replays surviving commits
     * filtered by the current chat's swipe map. Pure function over the log
     * + chat — never touches disk for the data namespace (that namespace is
     * no longer the source of truth; the log is). Result is structuredClone'd
     * for the caller so cache contents stay encapsulated.
     *
     * @returns {Promise<object|null>}
     */
    async function get() {
        if (destroyed) return null;
        await migrateIfNeeded();
        if (cachedReplay !== CACHE_UNSET) {
            return cachedReplay === null ? null : structuredClone(cachedReplay);
        }
        const log = await readLog();
        if (log.commits.length === 0) {
            cachedReplay = null;
            return null;
        }
        const swipeMap = buildSwipeMapFromChat(runtime.getChat());
        cachedReplay = computeTargetState(log.commits, swipeMap);
        return structuredClone(cachedReplay);
    }

    /**
     * One-time migration: when this instance loads against a namespace whose
     * legacy data sidecar still exists (pre-refactor chats), capture any drift
     * between data-sidecar contents and log replay into a `__orphans` backup
     * sidecar, then delete the legacy data sidecar. After migration runs,
     * subsequent loads see a null data namespace and skip immediately.
     *
     * Idempotent: the only state we need to remember between calls is whether
     * the data sidecar still exists. If `deleteChatState` fails (chat_sync
     * lock, transient backend error), we still mark migrationDone so we don't
     * loop — the dead sidecar is harmless going forward because reads now
     * derive from the log, not from data.
     */
    async function migrateIfNeeded() {
        if (migrationDone) return;
        if (migrationPromise) return migrationPromise;
        migrationPromise = (async () => {
            try {
                const data = await runtime.getChatState(namespace);
                if (data == null || typeof data !== 'object') {
                    migrationDone = true;
                    return;
                }
                const log = await readLog();
                const swipeMap = buildSwipeMapFromChat(runtime.getChat());
                const replay = log.commits.length === 0
                    ? {}
                    : computeTargetState(log.commits, swipeMap);
                let diff = [];
                if (typeof runtime.buildObjectPatchOperationsAsync === 'function') {
                    try {
                        diff = await runtime.buildObjectPatchOperationsAsync(replay, data);
                    } catch (diffErr) {
                        console.warn(`[floor-state:${namespace}] migration: diff failed, treating entire data as drift`, diffErr);
                        diff = [{ op: 'replace', path: '', value: data }];
                    }
                }
                if (Array.isArray(diff) && diff.length > 0 && typeof runtime.updateChatState === 'function') {
                    try {
                        await runtime.updateChatState(
                            `${namespace}__orphans`,
                            () => ({
                                timestamp: new Date().toISOString(),
                                dataPayload: data,
                                replayPayload: replay,
                                diff,
                            }),
                            { maxOperations: 16000 },
                        );
                    } catch (backupErr) {
                        console.warn(`[floor-state:${namespace}] migration: orphans backup write failed, continuing`, backupErr);
                    }
                }
                if (typeof runtime.deleteChatState === 'function') {
                    try {
                        await runtime.deleteChatState(namespace);
                    } catch (deleteErr) {
                        console.warn(`[floor-state:${namespace}] migration: deleteChatState failed, continuing`, deleteErr);
                    }
                }
                migrationDone = true;
            } catch (error) {
                console.warn(`[floor-state:${namespace}] migration failed, will retry on next get()`, error);
            } finally {
                migrationPromise = null;
            }
        })();
        return migrationPromise;
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
     *
     * `purge: true` additionally deletes the log sidecar from disk for the
     * current target. Use this when the namespace is being permanently
     * abandoned (e.g. a plugin's "reset / wipe" UI action). The data
     * namespace, if any legacy file still exists, is left alone — that one
     * is migration's responsibility on next mount.
     *
     * @param {{purge?: boolean}} [options]
     * @returns {Promise<boolean>} true on success (always true unless purge
     *     was requested and the underlying delete failed)
     */
    async function destroy({ purge = false } = {}) {
        if (destroyed) return true;
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
        invalidateCache();
        if (!purge) return true;
        if (typeof runtime.deleteChatState !== 'function') {
            console.warn(`[floor-state:${namespace}] destroy(purge): deleteChatState is unavailable; log sidecar left on disk`);
            return false;
        }
        try {
            await runtime.deleteChatState(logNamespace);
            return true;
        } catch (error) {
            console.warn(`[floor-state:${namespace}] destroy(purge): deleteChatState failed`, error);
            return false;
        }
    }

    const instance = Object.freeze({
        namespace,
        patch,
        update,
        reset,
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

    // No initial rematerialize: the data namespace is no longer a separate
    // persisted source of truth. First `get()` lazily replays the log into
    // the in-memory cache; one-time migration (legacy data sidecar cleanup)
    // is folded into `get()`'s migrateIfNeeded path.

    return instance;
}
