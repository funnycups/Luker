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
    shouldKeepCommit,
    truncateCommits,
    removeSwipeFromCommits,
    inferCommitTargetFromChat,
    resolveCommitTarget,
} from './floor-state/core.js';
import { applyPatch } from './util/fast-json-patch.js';

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
    // (truncate, swipe-delete, patch+commit) are in flight, resolved otherwise.
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
    // Serialize update() so each (get → reducer → diff → patch) sequence
    // runs to completion before the next starts. Without this, two concurrent
    // updates would both read the same materialized state, each compute a
    // diff against it, and write two commits whose RFC 6902 `test` ops both
    // assert the same prev value — the second commit's chain is invalid and
    // a subsequent replay throws. Director sub-agent tool calls hit this in
    // practice; the resulting broken log can only be recovered via the
    // data-namespace migration path.
    let updateQueue = Promise.resolve();

    function invalidateCache() {
        cachedReplay = CACHE_UNSET;
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
        if (destroyed) return;
        invalidateCache();
    };
    const __handleMessageSwiped = async () => {
        if (destroyed) return;
        invalidateCache();
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

        const run = async () => {
            const current = (await get()) ?? {};
            const next = await reducer(current);
            if (!next || typeof next !== 'object' || Array.isArray(next)) return true;

            const operations = await runtime.buildObjectPatchOperationsAsync(current, next);
            if (!Array.isArray(operations) || operations.length === 0) return true;
            return patch(operations, options);
        };
        const queued = updateQueue.then(run, run);
        updateQueue = queued.catch(() => {});
        return queued;
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
     * Replay can throw when the commit chain is broken (RFC 6902 `test`
     * failures from a historical concurrent write — fs.update is now
     * serialized but old logs written before that fix may still contain
     * stale-prev-base commits). When that happens we locate the first
     * failing commit, identify its `floor`, back the full log up to
     * `<ns>__orphans`, and truncate every commit on that floor or later.
     * The race producing these bad commits always writes to the in-flight
     * (chat-tail) floor, so a truncate by broken floor preserves all prior
     * floors' state and discards the racing siblings together with the
     * actual broken commit — equivalent to the user manually deleting the
     * in-flight message.
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
        try {
            cachedReplay = computeTargetState(log.commits, swipeMap);
        } catch (error) {
            console.warn(`[floor-state:${namespace}] replay failed, truncating by broken floor`, error);
            const recovered = await recoverByTruncatingBrokenFloor(log, swipeMap, error);
            if (recovered === null) {
                cachedReplay = null;
                return null;
            }
            cachedReplay = recovered;
        }
        return structuredClone(cachedReplay);
    }

    /**
     * Locate the first commit whose patches throw on replay, back the full
     * log up to `<ns>__orphans` (annotated with brokenCommitIndex /
     * brokenFloor / error), then rewrite the log keeping only commits whose
     * floor is strictly less than the broken floor. Returns the recomputed
     * target state, or null when nothing survives the truncate.
     *
     * Truncating by floor (not by commit index) is deliberate: concurrent
     * writes that produce broken commits all target the same in-flight chat
     * tail, so the broken commit's siblings on that floor are part of the
     * same racing batch and would otherwise leave half-applied garbage in
     * the graph. Truncating the whole floor produces the same outcome as
     * the user manually deleting that message — which is what they'd do
     * anyway once they noticed the broken state.
     */
    async function recoverByTruncatingBrokenFloor(log, swipeMap, replayError) {
        const probe = {};
        let brokenIndex = -1;
        for (let i = 0; i < log.commits.length; i++) {
            const commit = log.commits[i];
            if (!shouldKeepCommit(commit, swipeMap)) continue;
            try {
                applyPatch(probe, commit.patches, false, true);
            } catch (_) {
                brokenIndex = i;
                break;
            }
        }
        if (brokenIndex < 0) {
            // Either the per-commit probe didn't reproduce the failure (a
            // race we can't classify) or every commit was filtered out by
            // swipeMap. Surface the original error rather than silently
            // returning empty.
            throw replayError;
        }
        const brokenFloor = log.commits[brokenIndex].floor;
        if (typeof runtime.updateChatState === 'function') {
            try {
                await runtime.updateChatState(
                    `${namespace}__orphans`,
                    () => ({
                        recoveredFromBrokenLog: true,
                        replayError: String(replayError?.message || replayError || 'unknown'),
                        brokenCommitIndex: brokenIndex,
                        brokenFloor,
                        brokenLog: log,
                    }),
                    { maxOperations: 16000 },
                );
            } catch (backupErr) {
                console.warn(`[floor-state:${namespace}] recovery: orphans backup write failed, continuing`, backupErr);
            }
        }
        const survivors = log.commits.filter((c) => c.floor < brokenFloor);
        const ok = await writeLog({ version: LOG_VERSION, commits: survivors });
        if (!ok) {
            console.warn(`[floor-state:${namespace}] recovery: truncated log write failed, leaving broken log in place`);
            throw replayError;
        }
        if (survivors.length === 0) return null;
        return computeTargetState(survivors, buildSwipeMapFromChat(runtime.getChat()));
    }

    /**
     * One-shot promotion of the legacy data namespace into a fresh log
     * baseline. Runs on first `get()` per instance. Two cases:
     *
     *   1. `data == null` — nothing to promote, mark done and skip.
     *
     *   2. `data != null` — capture any drift between the data sidecar and
     *      log replay to `<namespace>__orphans`, then delete the data
     *      sidecar.
     *
     * If replay throws while computing the drift baseline we silently
     * swallow the failure and still delete the data sidecar: the broken-log
     * recovery in `get()` handles replay failures on its own and the
     * orphans backup it writes carries everything needed for forensics.
     *
     * Idempotent: success marks `migrationDone = true`. Failure also marks
     * done — we don't want to loop on a permanently broken state; the next
     * `get()` will surface the underlying error to the caller.
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
                let replay = {};
                if (log.commits.length > 0) {
                    try {
                        replay = computeTargetState(log.commits, buildSwipeMapFromChat(runtime.getChat()));
                    } catch (_) {
                        // Leave replay as {} — the diff will then treat the
                        // entire data sidecar as drift, which is the right
                        // call when the log is broken: get()'s recovery
                        // will truncate the log next.
                    }
                }
                await captureOrphansAndDeleteData(data, replay);
                migrationDone = true;
            } catch (error) {
                console.warn(`[floor-state:${namespace}] migration failed, marking done to avoid loop`, error);
                migrationDone = true;
            } finally {
                migrationPromise = null;
            }
        })();
        return migrationPromise;
    }

    async function captureOrphansAndDeleteData(data, replay) {
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
    }

    /**
     * Resolve when no write or structural settle is in flight. Plugins that
     * read state inside event handlers should `await ready()` first to avoid
     * stale reads against an unsettled log.
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

    return instance;
}
