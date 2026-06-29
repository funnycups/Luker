/**
 * Floor-state adapter for the memory-graph extension.
 *
 * The generic FloorState (public/scripts/floor-state.js) owns the persistence
 * model: a commit log in `<ns>__floor_log` is the only source of truth, and
 * `fs.get()` materializes by replaying surviving commits filtered by
 * (floor, swipeId) from the live chat. The four structural events
 * (MESSAGE_DELETED / MESSAGE_SWIPED / MESSAGE_SWIPE_DELETED / CHAT_CHANGED)
 * are settled by core before plugin listeners observe them.
 *
 * Responsibilities:
 *  - Lazy singleton holding the FloorState instance for the memory-graph
 *    namespace (recreated when the extension reloads, never per-chat).
 *  - Translate memory-graph's "log entry of ops" shape into snapshot-style
 *    `fs.patch` calls, reusing the existing `applyMemoryLogEntryToStore`
 *    so we don't duplicate op semantics.
 *  - Sidecar for non-floor-bound metadata (lastRecallTrace etc.) lives in
 *    `<ns>__meta` and is written directly via the chat-state API — those
 *    fields would otherwise be replayed-then-overwritten by the floor-state
 *    rebuild from `{}`.
 *  - One-shot upgrade from the old persisted schema (opLog inside the data
 *    namespace, schemaVersion 1) to the new layout (commits in
 *    `<ns>__floor_log`, metadata in `<ns>__meta`, graph in main namespace).
 */

import { LEVEL, normalizeText, isExtractableAssistantMessage } from './primitives.js';
import {
    addEdge,
    dropNode,
    repairStoreAfterRollback,
    cloneRollbackNodeSnapshot,
    cloneRollbackEdgeSnapshot,
    getRollbackEdgeKey,
    compareNodesByTimeline,
    getSemanticCoverageSeq,
} from './graph-ops.js';
import { runMigrationPipeline } from './migrations/index.js';

const MODULE_NAME = 'memory_graph';
const META_NAMESPACE = `${MODULE_NAME}__meta`;
const LOG_NAMESPACE = `${MODULE_NAME}__floor_log`;
const FLOOR_STATE_LOG_VERSION = 1;
const SCHEMA_VERSION = 2;

/**
 * Bumped on every backwards-incompatible change to the persisted store
 * shape. Used by `normalizePersistedMemoryState` to flag a state as
 * "needs re-save" when the version stamp is missing or older than this.
 *
 * Versions are intentionally not range-checked; we only differentiate
 * "current" from "anything else, please rewrite on next save".
 */
const PERSISTED_STORE_VERSION = 8;

/**
 * Walk the chat array counting `isExtractableAssistantMessage` matches and
 * return the chat index whose count equals `assistantSeq` (1-based).
 *
 * Symmetric inverse of `findAffectedAssistantSeqFromMessageIndex`. Caller
 * must pass the `isExtractableAssistantMessage` predicate so we don't
 * duplicate it here.
 *
 * @param {Array} chat
 * @param {number} assistantSeq
 * @param {(message: any) => boolean} isExtractableAssistantMessage
 * @returns {number | null} chat index, or null if no such floor exists yet
 */
export function getFloorFromAssistantSeq(chat, assistantSeq, isExtractableAssistantMessage) {
    const target = Math.floor(Number(assistantSeq || 0));
    if (!Number.isInteger(target) || target <= 0) return null;
    const source = Array.isArray(chat) ? chat : [];
    let count = 0;
    for (let i = 0; i < source.length; i++) {
        if (!isExtractableAssistantMessage(source[i])) continue;
        count += 1;
        if (count === target) return i;
    }
    return null;
}

let floorStatePromise = null;

/**
 * Lazy singleton — first call kicks off `createFloorState`, subsequent
 * calls reuse the same Promise. The instance lives for the page session;
 * its data namespace is kept in sync with chat structure by core driving
 * `settleXxx` from `floor-state.js` on every structural transition, so
 * callers don't need to re-create it on chat switches.
 */
export async function getFloorStateInstance(context) {
    if (!floorStatePromise) {
        if (typeof context?.createFloorState !== 'function') {
            throw new Error('[memory-graph] createFloorState API is unavailable in extension context.');
        }
        // Caching a rejected Promise would pin every later call to the same
        // failure even after the underlying issue clears; drop the cache on
        // failure so the next call retries from scratch.
        floorStatePromise = context.createFloorState({ namespace: MODULE_NAME })
            .catch((err) => {
                floorStatePromise = null;
                throw err;
            });
    }
    return floorStatePromise;
}

/**
 * Drop the cached singleton so the next `getFloorStateInstance` call
 * creates a fresh instance against the current chat. Use after
 * `fs.destroy({purge})`, when the chat target has changed under us, or
 * in tests that want a cold start.
 */
export function resetFloorStateInstance() {
    floorStatePromise = null;
}

/**
 * @deprecated keep the old name around for any test still importing it.
 */
export function resetFloorStateInstanceForTesting() {
    floorStatePromise = null;
}

/**
 * Read the metadata sidecar (`<ns>__meta`). May return `null` when the
 * sidecar has never been written for this chat OR when the read failed —
 * callers treat both the same (no cached meta, derive from store).
 *
 * Unwraps the state-API envelope here so the returned value is the raw
 * meta object (or null), matching the contract this function has always
 * had — leaking the envelope poisons every consumer that spreads or
 * indexes the result.
 */
export async function loadMetaFields(context, target = undefined) {
    const options = target ? { target } : undefined;
    const result = await context.getChatState(META_NAMESPACE, options);
    return result?.ok ? result.state : null;
}

/**
 * Write the metadata sidecar. Caller must pass the full meta object — we
 * don't merge against existing.
 *
 * Returns the state-API envelope ({ok, reason, hint, state, …}) untouched so
 * each caller can decide which `reason` values are recoverable (e.g.
 * `VALIDATION_TARGET` for background flushes with no active chat) and which
 * deserve an error.
 */
export async function persistMetaFields(context, meta, target = undefined) {
    const options = target ? { target, maxOperations: 16000 } : { maxOperations: 16000 };
    return await context.updateChatState(META_NAMESPACE, () => meta, options);
}

/**
 * One-shot upgrade from any historical chat-state shape to the current
 * v2 floor-state layout. The actual translation logic lives in the
 * `migrations/` registry; this function is the IO wrapper that reads the
 * three chat-state namespaces, runs the pipeline, and writes results
 * back in the (log → data → meta) order required for crash idempotency.
 *
 * @param {object} context
 * @param {object|undefined} target — chat target; default = current chat
 * @param {(message: any) => boolean} isExtractableAssistantMessage
 * @param {(store: object, entry: object) => void} applyMemoryLogEntryToStore
 * @returns {Promise<{migrated: boolean, migrations: string[]}>}
 */
export async function migrateLegacyMemoryGraphState(
    context,
    target,
    isExtractableAssistantMessage,
    applyMemoryLogEntryToStore,
) {
    const targetOption = target ? { target } : undefined;
    const targetWriteOption = target
        ? { target, maxOperations: 16000 }
        : { maxOperations: 16000 };

    // getChatState now always returns an envelope {ok, state, reason?, hint?}.
    // The migration detectors operate on raw payload shapes, so unwrap here —
    // leaking the envelope makes every detector return false, which silently
    // stamps __meta with a polluted base object and leaves the load path
    // reading the envelope back as "unrecognized" forever.
    const [dataRead, metaRead, logRead] = await Promise.all([
        context.getChatState(MODULE_NAME, targetOption),
        context.getChatState(META_NAMESPACE, targetOption),
        context.getChatState(LOG_NAMESPACE, targetOption),
    ]);
    const data = dataRead?.ok ? dataRead.state : null;
    const meta = metaRead?.ok ? metaRead.state : null;
    const log = logRead?.ok ? logRead.state : null;

    const ctx = {
        chat: Array.isArray(context?.chat) ? context.chat : [],
        isExtractableAssistantMessage,
        applyMemoryLogEntryToStore,
        buildObjectPatchOperationsAsync: context.buildObjectPatchOperationsAsync,
        getFloorFromAssistantSeq,
        buildMemoryLogOpsFromStore,
        getStoreCoveredSeqTo,
        FLOOR_STATE_LOG_VERSION,
        SCHEMA_VERSION,
    };

    const result = await runMigrationPipeline({ data, meta, log }, ctx);

    if (!result.changed) {
        // fresh install / 已最新:仅在 meta 缺 schemaVersion 时补 stamp
        if (!meta || Number(meta?.schemaVersion || 0) < SCHEMA_VERSION) {
            const baseMeta = meta && typeof meta === 'object' ? meta : {};
            const stampResult = await context.updateChatState(
                META_NAMESPACE,
                () => ({ ...baseMeta, schemaVersion: SCHEMA_VERSION }),
                targetWriteOption,
            );
            if (!stampResult?.ok) {
                console.warn(`[${MODULE_NAME}] migration: meta stamp failed (reason=${stampResult?.reason}, hint=${stampResult?.hint})`, { target });
            } else {
                console.info(`[${MODULE_NAME}] migration: stamped __meta.schemaVersion=${SCHEMA_VERSION} (no shape detected, data was ${data == null ? 'absent' : 'unrecognized'})`);
            }
        } else {
            console.info(`[${MODULE_NAME}] migration: already at schemaVersion=${SCHEMA_VERSION}, no-op`);
        }
        return { migrated: false, migrations: result.migrations };
    }

    // 写顺序:log → data → meta(schemaVersion 最后落,保证 idempotency)。
    // 任意一步失败立即抛错,wrapper 的 caller 会 catch + 警告;不继续往下写以免
    // 留下"data 已新但 meta 没 stamp"等中间态(实际上这种中间态下次启动还会
    // 重跑迁移,但 silent 失败更难定位)。
    const commitCount = Array.isArray(result.log?.commits) ? result.log.commits.length : 0;
    console.info(`[${MODULE_NAME}] migration: pipeline=[${result.migrations.join(' → ')}] producing ${commitCount} commits, writing log → data → meta`);

    const logResult = await context.updateChatState(LOG_NAMESPACE, () => result.log, targetWriteOption);
    if (!logResult?.ok) {
        throw new Error(`[${MODULE_NAME}] migration: __floor_log write failed (reason=${logResult?.reason}, hint=${logResult?.hint})`);
    }
    const dataResult = await context.updateChatState(MODULE_NAME, () => result.data, targetWriteOption);
    if (!dataResult?.ok) {
        throw new Error(`[${MODULE_NAME}] migration: data namespace write failed (reason=${dataResult?.reason}, hint=${dataResult?.hint})`);
    }
    const metaResult = await context.updateChatState(META_NAMESPACE, () => result.meta, targetWriteOption);
    if (!metaResult?.ok) {
        throw new Error(`[${MODULE_NAME}] migration: __meta write failed (reason=${metaResult?.reason}, hint=${metaResult?.hint})`);
    }
    console.info(`[${MODULE_NAME}] migration: complete, schemaVersion=${SCHEMA_VERSION} stamped`);
    return { migrated: true, migrations: result.migrations };
}

export const constants = Object.freeze({
    MODULE_NAME,
    META_NAMESPACE,
    LOG_NAMESPACE,
    FLOOR_STATE_LOG_VERSION,
    SCHEMA_VERSION,
    PERSISTED_STORE_VERSION,
});

// =============================================================================
// Store ↔ persistence transformations
// =============================================================================
//
// The runtime "store" is the in-memory graph cache main.js mutates as it
// extracts / recalls / compresses. The "persisted state" is the JSON shape
// floor-state and the v1 legacy chat-state used. The functions below encode
// every transformation between those two views: empty constructors,
// normalization, opLog encode/decode, payload+meta split, and the meta cache
// that mirrors the `<ns>__meta` sidecar in memory.
//
// All of this is pure data shuffling — no I/O, no event emission. Every
// function is safe to call from tests with a hand-rolled context.

/**
 * Cache of `<ns>__meta` sidecar contents keyed by chat key. Mirrors what
 * persistence.js writes to disk so callers can synchronously read meta
 * fields without round-tripping through `getChatState`. Cleared by
 * `clearCachedMeta` on chat delete / rename.
 */
const memoryMetaCache = new Map();

export function getCachedMeta(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) return null;
    return memoryMetaCache.get(key) || null;
}

export function setCachedMeta(chatKey, meta) {
    const key = String(chatKey || '').trim();
    if (!key) return;
    memoryMetaCache.set(key, meta || {});
}

/**
 * Drop a chat's cached meta entry. Call this from `CHAT_DELETED` /
 * `CHAT_RENAMED` handlers so a freshly-created chat with the same key
 * doesn't read stale metadata.
 */
export function clearCachedMeta(chatKey) {
    const key = String(chatKey || '').trim();
    if (!key) return;
    memoryMetaCache.delete(key);
}

/**
 * Construct a fresh empty runtime store. Every field has a stable default
 * so downstream code can assume `Math.max(store.appliedSeqTo, …)` is safe.
 */
export function createEmptyStore() {
    return {
        nodes: {},
        edges: [],
        nodeSeq: 0,
        seqCounter: 0,
        appliedSeqTo: 0,
        loggedSeqTo: 0,
        sourceMessageCount: 0,
        lastRecallTrace: [],
        lastRecallProjection: null,
    };
}

/**
 * Construct a fresh empty persisted state in v8 shape. `version` is
 * stamped on every `synthesizePersistedStateFromStoreAndMeta` call so
 * stored states always advertise their format.
 */
export function createEmptyPersistedMemoryState() {
    return {
        version: PERSISTED_STORE_VERSION,
        coveredSeqTo: 0,
        sourceMessageCount: 0,
        lastRecallTrace: [],
        lastRecallProjection: null,
        opLog: [],
    };
}

/**
 * Repair / canonicalize a runtime store after it's been deserialized from
 * disk or imported from a foreign source. Safe to call on any input —
 * non-objects collapse to the empty store.
 *
 * Performs three classes of fix-up the import / advanced-JSON-edit paths
 * rely on:
 *   1. Drop nodes that aren't SEMANTIC (e.g. legacy `thread` nodes, or
 *      future levels we don't yet handle) and rebuild every kept node from
 *      a fixed field whitelist. Foreign sources cannot inject extra fields
 *      that quietly survive into the runtime.
 *   2. Rederive `nodeSeq` from the highest `n_<N>` id and `seqCounter`
 *      from the highest node `seqTo`. Without this, an import whose
 *      counters have desynced from its node ids (common after manual
 *      JSON edits) makes the next `nextNodeId` collide with an existing
 *      node and silently overwrite it.
 *   3. Cascade the coverage watermarks: `appliedSeqTo` falls back to
 *      `seqCounter` when the input doesn't carry a finite value, then
 *      `loggedSeqTo >= appliedSeqTo` and `seqCounter >= loggedSeqTo`.
 *
 * Edge rebuild + parent/child link repair is delegated to
 * `repairStoreAfterRollback`, which uses `cloneRollbackEdgeSnapshot` to
 * normalize edge types and dedupe.
 *
 * Always returns a fresh independent object — callers using this for "before
 * snapshot" patterns (commit-diff's `beforeStore` / `afterStore`, editor's
 * pre-edit snapshot, extraction's working+committed pair) rely on that
 * isolation.
 */
export function normalizeStoreForRuntime(store) {
    const empty = createEmptyStore();
    if (!store || typeof store !== 'object') {
        return empty;
    }
    const normalized = { ...empty, ...store };
    const rawNodes = (normalized.nodes && typeof normalized.nodes === 'object' && !Array.isArray(normalized.nodes))
        ? normalized.nodes
        : {};
    normalized.nodes = {};
    normalized.edges = Array.isArray(normalized.edges) ? normalized.edges : [];
    normalized.lastRecallTrace = Array.isArray(normalized.lastRecallTrace) ? normalized.lastRecallTrace : [];
    normalized.lastRecallProjection = (normalized.lastRecallProjection && typeof normalized.lastRecallProjection === 'object')
        ? normalized.lastRecallProjection
        : null;
    normalized.nodeSeq = Math.max(0, Math.floor(Number(normalized.nodeSeq || 0)));
    normalized.seqCounter = Math.max(0, Math.floor(Number(normalized.seqCounter || 0)));
    normalized.loggedSeqTo = Math.max(0, Math.floor(Number(normalized.loggedSeqTo || 0)));
    normalized.sourceMessageCount = Math.max(0, Number(normalized.sourceMessageCount || 0));

    for (const [id, rawNode] of Object.entries(rawNodes)) {
        if (!rawNode || typeof rawNode !== 'object') continue;
        const nodeId = String(id || '').trim();
        if (!nodeId) continue;
        const level = String(rawNode.level || LEVEL.SEMANTIC).trim();
        if (level !== LEVEL.SEMANTIC) continue;
        const seqTo = Number.isFinite(Number(rawNode.seqTo))
            ? Math.max(0, Math.floor(Number(rawNode.seqTo)))
            : 0;
        const fields = rawNode.fields && typeof rawNode.fields === 'object' && !Array.isArray(rawNode.fields)
            ? { ...rawNode.fields }
            : {};
        normalized.nodes[nodeId] = {
            id: nodeId,
            type: String(rawNode.type || 'semantic'),
            level: LEVEL.SEMANTIC,
            title: normalizeText(rawNode.title || nodeId),
            seqTo,
            fields,
            semanticDepth: Number.isFinite(Number(rawNode.semanticDepth)) ? Number(rawNode.semanticDepth) : 0,
            semanticRollup: Boolean(rawNode.semanticRollup),
            childrenIds: Array.isArray(rawNode.childrenIds) ? rawNode.childrenIds.map(child => String(child || '').trim()).filter(Boolean) : [],
            parentId: String(rawNode.parentId || '').trim(),
            archived: Boolean(rawNode.archived),
        };
        normalized.seqCounter = Math.max(normalized.seqCounter, seqTo);
        const extractedNodeSeq = Number(String(nodeId).replace(/^n_/, ''));
        if (Number.isFinite(extractedNodeSeq)) {
            normalized.nodeSeq = Math.max(normalized.nodeSeq, extractedNodeSeq);
        }
    }

    normalized.appliedSeqTo = Math.max(
        0,
        Math.floor(Number.isFinite(Number(store.appliedSeqTo)) ? Number(store.appliedSeqTo) : normalized.seqCounter),
    );
    normalized.loggedSeqTo = Math.max(normalized.loggedSeqTo, normalized.appliedSeqTo);
    normalized.seqCounter = Math.max(normalized.seqCounter, normalized.loggedSeqTo);

    repairStoreAfterRollback(normalized);
    return normalized;
}

/**
 * Single op in a memory-log entry. Four shapes:
 *   { type: 'upsert_node', node }
 *   { type: 'delete_node', nodeId }
 *   { type: 'upsert_edge', edge }
 *   { type: 'delete_edge', edge }
 *
 * Returns null for malformed input so the caller's `.filter(Boolean)`
 * drops bad ops without aborting the whole entry.
 */
function normalizeMemoryLogOperation(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const type = String(raw.type || '').trim().toLowerCase();
    if (type === 'upsert_node') {
        const node = cloneRollbackNodeSnapshot(raw.node || raw);
        return node ? { type, node } : null;
    }
    if (type === 'delete_node') {
        const nodeId = String(raw?.nodeId || raw?.id || '').trim();
        return nodeId ? { type, nodeId } : null;
    }
    if (type === 'upsert_edge' || type === 'delete_edge') {
        const edge = cloneRollbackEdgeSnapshot(raw?.edge || raw);
        return edge ? { type, edge } : null;
    }
    return null;
}

function normalizeMemoryLogEntry(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    // entry.seq gates the whole batch; replay/branch trimming must not split ops inside one entry.
    const seq = Math.max(0, Math.floor(Number(raw.seq || 0)));
    const ops = Array.isArray(raw.ops)
        ? raw.ops.map(normalizeMemoryLogOperation).filter(Boolean)
        : [];
    if (seq <= 0 && ops.length === 0) {
        return null;
    }
    return { seq, ops };
}

function getLatestLoggedSeq(stateOrLog) {
    const log = Array.isArray(stateOrLog)
        ? stateOrLog
        : (Array.isArray(stateOrLog?.opLog) ? stateOrLog.opLog : []);
    return log.reduce((maxSeq, entry) => Math.max(maxSeq, Math.max(0, Math.floor(Number(entry?.seq || 0)))), 0);
}

function getPersistedCoveredSeqTo(state) {
    const rawCoveredSeqTo = Number.isFinite(Number(state?.coveredSeqTo))
        ? Math.max(0, Math.floor(Number(state.coveredSeqTo)))
        : 0;
    return Math.max(rawCoveredSeqTo, getLatestLoggedSeq(state));
}

/**
 * Highest seq this runtime store can claim coverage for. Combines three
 * independent signals so a store recovered from any subset of metadata
 * still reports the correct watermark:
 *   - `appliedSeqTo` (what's been persisted-and-replayed)
 *   - `loggedSeqTo`  (what's in the floor-state log)
 *   - the live semantic-node coverage (in case both above were lost)
 */
export function getStoreCoveredSeqTo(store) {
    return Math.max(
        0,
        Math.floor(Number(store?.appliedSeqTo || 0)),
        Math.floor(Number(store?.loggedSeqTo || 0)),
        Math.floor(Number(getSemanticCoverageSeq(store) || 0)),
    );
}

function normalizePersistedStateBase(raw) {
    const normalized = createEmptyPersistedMemoryState();
    if (!raw || typeof raw !== 'object') {
        return normalized;
    }
    normalized.sourceMessageCount = Math.max(0, Number(raw.sourceMessageCount || 0));
    normalized.lastRecallTrace = Array.isArray(raw.lastRecallTrace) ? structuredClone(raw.lastRecallTrace) : [];
    normalized.lastRecallProjection = raw.lastRecallProjection && typeof raw.lastRecallProjection === 'object'
        ? structuredClone(raw.lastRecallProjection)
        : null;
    normalized.opLog = Array.isArray(raw.opLog)
        ? raw.opLog.map(normalizeMemoryLogEntry).filter(Boolean)
        : [];
    normalized.coveredSeqTo = getPersistedCoveredSeqTo({
        coveredSeqTo: raw.coveredSeqTo,
        opLog: normalized.opLog,
    });
    return normalized;
}

/**
 * Encode the current store as a sequence of opLog ops. Used by the
 * legacy-state migration path that turns an in-memory v7 store into a
 * single v8 entry, and by export.
 */
export function buildMemoryLogOpsFromStore(store) {
    const normalized = normalizeStoreForRuntime(store);
    const ops = [];
    const nodes = Object.values(normalized.nodes || {}).sort(compareNodesByTimeline);
    for (const node of nodes) {
        const snapshot = cloneRollbackNodeSnapshot(node);
        if (snapshot) {
            ops.push({ type: 'upsert_node', node: snapshot });
        }
    }
    for (const edge of Array.isArray(normalized.edges) ? normalized.edges : []) {
        const snapshot = cloneRollbackEdgeSnapshot(edge);
        if (snapshot) {
            ops.push({ type: 'upsert_edge', edge: snapshot });
        }
    }
    return ops;
}

function buildLegacyMigrationSeq(context, legacyStore) {
    void context;
    return getStoreCoveredSeqTo(legacyStore);
}

function buildPersistedStateFromLegacyStore(raw, context) {
    const normalized = createEmptyPersistedMemoryState();
    const legacyStore = normalizeStoreForRuntime(raw || createEmptyStore());
    normalized.sourceMessageCount = Math.max(0, Number(legacyStore.sourceMessageCount || 0));
    normalized.lastRecallTrace = structuredClone(Array.isArray(legacyStore.lastRecallTrace) ? legacyStore.lastRecallTrace : []);
    normalized.lastRecallProjection = legacyStore.lastRecallProjection && typeof legacyStore.lastRecallProjection === 'object'
        ? structuredClone(legacyStore.lastRecallProjection)
        : null;

    const hasLegacyPayload = Object.keys(legacyStore.nodes || {}).length > 0
        || (Array.isArray(legacyStore.edges) && legacyStore.edges.length > 0)
        || normalized.sourceMessageCount > 0
        || normalized.lastRecallTrace.length > 0
        || Boolean(normalized.lastRecallProjection);
    if (hasLegacyPayload) {
        const seq = buildLegacyMigrationSeq(context, legacyStore);
        normalized.coveredSeqTo = Math.max(0, seq);
        const ops = buildMemoryLogOpsFromStore(legacyStore);
        if (seq > 0 || ops.length > 0) {
            normalized.opLog = [{ seq: Math.max(0, seq), ops }];
        }
    }
    return { state: normalized, migrated: hasLegacyPayload };
}

/**
 * Two-shape input dispatcher: a v8-style state passes through
 * `normalizePersistedStateBase`; anything else is treated as a legacy v7
 * store and gets wrapped in a single migration entry. Returns
 * `{ state, migrated }` so callers know whether to schedule a write.
 */
export function normalizePersistedMemoryState(raw, context) {
    if (raw && typeof raw === 'object' && Array.isArray(raw.opLog)) {
        return {
            state: normalizePersistedStateBase(raw),
            migrated: Number(raw.version || 0) !== PERSISTED_STORE_VERSION,
        };
    }
    if (raw && typeof raw === 'object') {
        return buildPersistedStateFromLegacyStore(raw, context);
    }
    return {
        state: createEmptyPersistedMemoryState(),
        migrated: false,
    };
}

/**
 * Cheap "is this state actually populated?" test. Used to decide whether
 * to skip a write when the store is empty in all the ways that matter.
 */
export function hasPersistedMemoryStatePayload(state) {
    const normalized = normalizePersistedStateBase(state);
    return normalized.coveredSeqTo > 0
        || normalized.opLog.length > 0
        || normalized.lastRecallTrace.length > 0
        || Boolean(normalized.lastRecallProjection)
        || normalized.sourceMessageCount > 0;
}

/**
 * Apply a single `upsert_node` snapshot to the store, also bumping the
 * counters that drive new-id allocation. Used by `applyMemoryLogEntryToStore`.
 */
export function applyLoggedNodeSnapshot(store, node) {
    const snapshot = cloneRollbackNodeSnapshot(node);
    if (!snapshot) {
        return;
    }
    store.nodes[snapshot.id] = snapshot;
    const extractedNodeSeq = Number(String(snapshot.id || '').replace(/^n_/, ''));
    if (Number.isFinite(extractedNodeSeq)) {
        store.nodeSeq = Math.max(store.nodeSeq, extractedNodeSeq);
    }
    store.seqCounter = Math.max(store.seqCounter, Math.max(0, Number(snapshot.seqTo || 0)));
}

function removeLoggedEdge(store, edge) {
    const key = getRollbackEdgeKey(edge);
    if (!key) {
        return;
    }
    store.edges = (Array.isArray(store.edges) ? store.edges : []).filter(item => getRollbackEdgeKey(item) !== key);
}

/**
 * Replay one memory-log entry into a runtime store. Each op type is
 * dispatched through the corresponding graph-ops primitive. Bumps the
 * three coverage counters (`loggedSeqTo`, `seqCounter`, `appliedSeqTo`)
 * to the entry's `seq` so subsequent writes see a consistent watermark.
 */
export function applyMemoryLogEntryToStore(store, entry) {
    if (!store || typeof store !== 'object' || !entry || typeof entry !== 'object') {
        return;
    }
    for (const operation of Array.isArray(entry.ops) ? entry.ops : []) {
        const type = String(operation?.type || '').trim().toLowerCase();
        if (type === 'delete_edge') {
            removeLoggedEdge(store, operation.edge);
            continue;
        }
        if (type === 'delete_node') {
            const nodeId = String(operation?.nodeId || '').trim();
            if (nodeId) {
                dropNode(store, nodeId, true);
            }
            continue;
        }
        if (type === 'upsert_node') {
            applyLoggedNodeSnapshot(store, operation.node);
            continue;
        }
        if (type === 'upsert_edge') {
            const edge = cloneRollbackEdgeSnapshot(operation.edge);
            if (edge) {
                addEdge(store, edge.from, edge.to, edge.type);
            }
        }
    }
    repairStoreAfterRollback(store);
    store.loggedSeqTo = Math.max(store.loggedSeqTo, Math.max(0, Math.floor(Number(entry.seq || 0))));
    store.seqCounter = Math.max(store.seqCounter, store.loggedSeqTo);
    store.appliedSeqTo = Math.max(store.appliedSeqTo, Math.max(0, Math.floor(Number(entry.seq || 0))));
}

/**
 * Build a fresh runtime store by replaying every entry in the persisted
 * state's opLog from scratch. Used by the legacy-state path; v2 callers
 * use `buildRuntimeStoreFromGraphPayloadAndMeta` against the floor-state
 * payload instead.
 */
export function buildRuntimeStoreFromPersistedState(state) {
    const normalizedState = normalizePersistedStateBase(state);
    const runtimeStore = createEmptyStore();
    for (const entry of normalizedState.opLog) {
        applyMemoryLogEntryToStore(runtimeStore, entry);
    }
    runtimeStore.appliedSeqTo = Math.max(runtimeStore.appliedSeqTo, getPersistedCoveredSeqTo(normalizedState));
    runtimeStore.loggedSeqTo = Math.max(runtimeStore.loggedSeqTo, getLatestLoggedSeq(normalizedState), runtimeStore.appliedSeqTo);
    runtimeStore.seqCounter = Math.max(runtimeStore.seqCounter, runtimeStore.loggedSeqTo);
    runtimeStore.lastRecallTrace = structuredClone(Array.isArray(normalizedState.lastRecallTrace) ? normalizedState.lastRecallTrace : []);
    runtimeStore.lastRecallProjection = normalizedState.lastRecallProjection && typeof normalizedState.lastRecallProjection === 'object'
        ? structuredClone(normalizedState.lastRecallProjection)
        : null;
    runtimeStore.sourceMessageCount = Math.max(0, Number(normalizedState.sourceMessageCount || 0));
    return runtimeStore;
}

/**
 * Coerce a persisted vectorIndexState blob into the runtime shape that
 * `ensureVectorIndexState` would have produced. Defensive against partial /
 * malformed data left over from old meta sidecars or interrupted writes.
 * Returns null when the input has nothing usable (caller falls back to lazy
 * init via `ensureVectorIndexState`).
 */
export function normalizeVectorIndexState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const nodeToHash = (raw.nodeToHash && typeof raw.nodeToHash === 'object' && !Array.isArray(raw.nodeToHash))
        ? structuredClone(raw.nodeToHash)
        : {};
    const hashToNodeId = (raw.hashToNodeId && typeof raw.hashToNodeId === 'object' && !Array.isArray(raw.hashToNodeId))
        ? structuredClone(raw.hashToNodeId)
        : {};
    return {
        source: String(raw.source || ''),
        model: String(raw.model || ''),
        collectionId: String(raw.collectionId || ''),
        nodeToHash,
        hashToNodeId,
        dirty: Boolean(raw.dirty),
        lastWarning: String(raw.lastWarning || ''),
    };
}

/**
 * Extract the meta-sidecar shape from a runtime store. This is what gets
 * written to `<ns>__meta` on every persist call.
 */
export function metaFieldsFromStore(store) {
    return {
        schemaVersion: SCHEMA_VERSION,
        sourceMessageCount: Math.max(0, Number(store?.sourceMessageCount || 0)),
        lastRecallTrace: structuredClone(Array.isArray(store?.lastRecallTrace) ? store.lastRecallTrace : []),
        lastRecallProjection: store?.lastRecallProjection && typeof store.lastRecallProjection === 'object'
            ? structuredClone(store.lastRecallProjection)
            : null,
        vectorIndexState: normalizeVectorIndexState(store?.vectorIndexState),
    };
}

/**
 * Extract the floor-state payload shape from a runtime store. This is
 * what callers snapshot into the data namespace on each commit (see
 * `commitMemoryStoreReplaceByChatKey` / `commitMemoryStoreDiffByChatKey`
 * in main.js). Excludes the meta fields (those go to `<ns>__meta`).
 */
export function graphPayloadFromStore(store) {
    const normalized = normalizeStoreForRuntime(store);
    const appliedSeq = Math.max(0, Math.floor(Number(normalized.appliedSeqTo || 0)));
    const loggedSeq = Math.max(appliedSeq, Math.floor(Number(normalized.loggedSeqTo || 0)));
    return {
        nodes: structuredClone(normalized.nodes || {}),
        edges: structuredClone(Array.isArray(normalized.edges) ? normalized.edges : []),
        nodeSeq: Math.max(0, Math.floor(Number(normalized.nodeSeq || 0))),
        seqCounter: Math.max(0, Math.floor(Number(normalized.seqCounter || 0))),
        appliedSeqTo: appliedSeq,
        loggedSeqTo: loggedSeq,
        coveredAssistantSeq: appliedSeq,
    };
}

/**
 * Inverse of the (graph payload, meta) split: reconstruct a runtime
 * store from the two halves as read from floor-state + the meta sidecar.
 */
export function buildRuntimeStoreFromGraphPayloadAndMeta(payload, meta) {
    const runtime = createEmptyStore();
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        if (payload.nodes && typeof payload.nodes === 'object') {
            runtime.nodes = structuredClone(payload.nodes);
        }
        if (Array.isArray(payload.edges)) {
            runtime.edges = structuredClone(payload.edges);
        }
        runtime.nodeSeq = Math.max(0, Math.floor(Number(payload.nodeSeq || 0)));
        runtime.seqCounter = Math.max(0, Math.floor(Number(payload.seqCounter || 0)));
        runtime.appliedSeqTo = Math.max(0, Math.floor(Number(payload.appliedSeqTo || 0)));
        runtime.loggedSeqTo = Math.max(0, Math.floor(Number(payload.loggedSeqTo || 0)));
        const covered = Math.max(0, Math.floor(Number(payload.coveredAssistantSeq || 0)));
        runtime.appliedSeqTo = Math.max(runtime.appliedSeqTo, covered);
        runtime.loggedSeqTo = Math.max(runtime.loggedSeqTo, runtime.appliedSeqTo);
        runtime.seqCounter = Math.max(runtime.seqCounter, runtime.loggedSeqTo);
    }
    if (meta && typeof meta === 'object') {
        runtime.sourceMessageCount = Math.max(0, Number(meta.sourceMessageCount || 0));
        runtime.lastRecallTrace = Array.isArray(meta.lastRecallTrace)
            ? structuredClone(meta.lastRecallTrace) : [];
        runtime.lastRecallProjection = meta.lastRecallProjection && typeof meta.lastRecallProjection === 'object'
            ? structuredClone(meta.lastRecallProjection) : null;
        const restoredVectorIndex = normalizeVectorIndexState(meta.vectorIndexState);
        if (restoredVectorIndex) {
            runtime.vectorIndexState = restoredVectorIndex;
        }
    }
    return normalizeStoreForRuntime(runtime);
}

/**
 * Synthesize a v8 persisted-state shape from a (store, meta) pair WITHOUT
 * an opLog. Used on the v2 path where the floor-state log is authoritative
 * and the data-namespace persisted-state shim only carries meta + the
 * coverage watermark for legacy readers.
 */
export function synthesizePersistedStateFromStoreAndMeta(store, meta) {
    const state = createEmptyPersistedMemoryState();
    state.coveredSeqTo = getStoreCoveredSeqTo(store);
    state.sourceMessageCount = meta && typeof meta === 'object'
        ? Math.max(0, Number(meta.sourceMessageCount || 0))
        : Math.max(0, Number(store?.sourceMessageCount || 0));
    state.lastRecallTrace = meta && typeof meta === 'object' && Array.isArray(meta.lastRecallTrace)
        ? structuredClone(meta.lastRecallTrace) : [];
    state.lastRecallProjection = meta && typeof meta === 'object' && meta.lastRecallProjection && typeof meta.lastRecallProjection === 'object'
        ? structuredClone(meta.lastRecallProjection) : null;
    // opLog stays empty — under v2 there is no opLog, the floor-state log is authoritative.
    return state;
}

/**
 * Convert an assistant-seq watermark into a chat-array index ("floor")
 * for the supplied context. Returns null when the seq points past the
 * current chat (e.g. messages haven't arrived yet).
 */
export function seqToFloor(context, seq) {
    const target = Math.max(0, Math.floor(Number(seq || 0)));
    if (target <= 0) return null;
    return getFloorFromAssistantSeq(
        Array.isArray(context?.chat) ? context.chat : [],
        target,
        isExtractableAssistantMessage,
    );
}

/**
 * Active swipe id at the given chat floor, or null when the floor is
 * invalid. `swipe_id` is normalized to a non-negative integer (0 when
 * absent) so callers can compare values directly.
 */
export function activeSwipeIdAtFloor(context, floor) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (!Number.isInteger(floor) || floor < 0 || floor >= chat.length) return null;
    const raw = chat[floor]?.swipe_id;
    return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Inspect the in-flight chat tail and return the floor + assistant-seq the
 * currently-generating turn occupies, or null when there is no in-flight
 * assistant slot (chat empty, or tail is a user message).
 *
 * Anchors memory-graph session writes (orchestrator director / loop sub-agent
 * tool calls) so their floor-state commits land on the turn that produced them
 * rather than on the previous turn's floor (which is what `store.seqCounter`
 * would resolve to — extraction has not run for the in-flight turn yet).
 *
 * An empty / whitespace-only assistant placeholder at the tail still counts
 * as in-flight: the slot exists, the director is writing FOR that slot, and
 * `turnSeq` here predicts the seq the slot will occupy once extraction reaches
 * it. `priorSeq` walks chat[0..floor-1] with `isExtractableAssistantMessage`
 * so a non-extractable placeholder earlier in chat does not inflate the count.
 *
 * @param {{ chat?: any[] } | null | undefined} context
 * @returns {{ floor: number, turnSeq: number } | null}
 */
export function resolveInFlightAnchor(context) {
    const chat = Array.isArray(context?.chat) ? context.chat : null;
    if (!chat || chat.length === 0) return null;
    const floor = chat.length - 1;
    const tail = chat[floor];
    if (!tail || tail.is_user !== false) return null;
    let priorSeq = 0;
    for (let i = 0; i < floor; i++) {
        if (isExtractableAssistantMessage(chat[i])) priorSeq++;
    }
    return { floor, turnSeq: priorSeq + 1 };
}

/**
 * True when the comparable metadata (coverage watermark, source count,
 * lastRecallTrace, lastRecallProjection) differs between two stores.
 * Used to skip no-op writes — if nothing the persistence layer cares
 * about changed, we don't touch the meta sidecar.
 */
export function hasPersistedStoreMetadataChanges(beforeStore, afterStore) {
    const beforeTrace = JSON.stringify(Array.isArray(beforeStore?.lastRecallTrace) ? beforeStore.lastRecallTrace : []);
    const afterTrace = JSON.stringify(Array.isArray(afterStore?.lastRecallTrace) ? afterStore.lastRecallTrace : []);
    const beforeProjection = JSON.stringify(beforeStore?.lastRecallProjection && typeof beforeStore.lastRecallProjection === 'object'
        ? beforeStore.lastRecallProjection
        : null);
    const afterProjection = JSON.stringify(afterStore?.lastRecallProjection && typeof afterStore.lastRecallProjection === 'object'
        ? afterStore.lastRecallProjection
        : null);
    return getStoreCoveredSeqTo(beforeStore) !== getStoreCoveredSeqTo(afterStore)
        || Math.max(0, Number(beforeStore?.sourceMessageCount || 0)) !== Math.max(0, Number(afterStore?.sourceMessageCount || 0))
        || beforeTrace !== afterTrace
        || beforeProjection !== afterProjection;
}
