/**
 * Floor-state adapter for the orchestrator extension.
 *
 * Replaces the legacy two-tier persistence scheme (an index namespace
 * `luker_orchestrator_state` listing anchor playable floors, plus one
 * sidecar namespace `luker_orchestrator_anchor_<N>` per anchor) with a
 * single floor-state-managed data namespace `luker_orchestrator_anchors`
 * whose contents are `{ [playableFloor]: snapshot }`.
 *
 * Each commit tags itself at `(userMessageChatIndex, userMessageSwipeId)`
 * and applies one `add /<playableFloor>` patch op. This shape means:
 *
 *   - swipe of the anchored user turn → commit filtered out by floor-state's
 *     swipe map → the snapshot disappears, exactly what we want
 *   - tail truncation past the anchored floor → commit filtered out by
 *     `truncateCommits` → the snapshot disappears
 *   - branch creation → floor-state's CHAT_BRANCH_CREATED handler copies
 *     surviving commits into the new chat's log → snapshots follow the branch
 *
 * Edit invalidation (the user changes the anchored message text without
 * deleting it) is NOT handled here. The orchestrator stores the anchor's
 * content hash inside each snapshot, and consumers re-validate the hash
 * against the live message before reuse — so stale entries simply fail
 * the validity check instead of being proactively scrubbed. The trade-off
 * is a few orphan KB in the sidecar until the floor is itself deleted /
 * overwritten by a new orchestration; it buys ~150 lines of removed range-
 * invalidation code.
 *
 * Legacy upgrade is one-shot per chat: on first load we read the legacy
 * namespaces, replay each anchor as a floor-state commit, and delete the
 * legacy data. A `__schema` sidecar marks the migration complete so the
 * upgrade is idempotent across reloads.
 */

import {
    getPlayableMessageAt,
    isStoredOrchestrationSnapshotValidForMessages,
    normalizeAnchorPlayableFloor,
    normalizeOrchestrationSnapshot,
} from './anchors.js';

const STATE_NAMESPACE = 'luker_orchestrator_anchors';
const SCHEMA_NAMESPACE = `${STATE_NAMESPACE}__schema`;
const LEGACY_INDEX_NAMESPACE = 'luker_orchestrator_state';
const LEGACY_ANCHOR_NAMESPACE_PREFIX = 'luker_orchestrator_anchor_';
const SCHEMA_VERSION = 1;

let floorStatePromise = null;

/**
 * Lazy singleton holding the floor-state instance for orchestrator anchors.
 * The instance lives for the page session; its data namespace is kept in
 * sync with chat structure by core driving `settleXxx` from `floor-state.js`
 * on every structural transition — callers do not need to recreate it.
 */
export async function getFloorStateInstance(context) {
    if (!floorStatePromise) {
        if (typeof context?.createFloorState !== 'function') {
            throw new Error('[orchestrator] createFloorState API is unavailable in extension context.');
        }
        floorStatePromise = context.createFloorState({ namespace: STATE_NAMESPACE });
    }
    return floorStatePromise;
}

/**
 * Test escape hatch: drop the cached singleton so subsequent
 * `getFloorStateInstance` calls create a fresh instance. Production code
 * never needs this — the instance lives for the page session.
 */
export function resetFloorStateInstanceForTesting() {
    floorStatePromise = null;
}

function getLegacyAnchorNamespace(playableFloor) {
    const normalized = normalizeAnchorPlayableFloor(playableFloor);
    if (!normalized) return '';
    return `${LEGACY_ANCHOR_NAMESPACE_PREFIX}${normalized}`;
}

/**
 * Read the schema sidecar that records whether legacy data has been
 * migrated for this chat. Returns 0 when no sidecar exists.
 */
async function readSchemaVersion(context) {
    if (typeof context?.getChatState !== 'function') return 0;
    const raw = await context.getChatState(SCHEMA_NAMESPACE, {});
    return Math.max(0, Math.floor(Number(raw?.version || 0)));
}

async function writeSchemaVersion(context, version) {
    if (typeof context?.updateChatState !== 'function') return;
    await context.updateChatState(SCHEMA_NAMESPACE, () => ({ version: Number(version) || 0 }), {
        maxOperations: 4,
        maxRetries: 1,
    });
}

/**
 * Read every entry in the legacy index + anchor sidecars for the current
 * chat. Returns the parsed legacy payload plus the per-anchor snapshots
 * already keyed by playable floor, or `null` when no legacy data is
 * present (fresh chat or already migrated).
 */
async function readLegacyOrchestratorState(context) {
    if (typeof context?.getChatState !== 'function') return null;
    const indexPayload = await context.getChatState(LEGACY_INDEX_NAMESPACE, {});
    if (!indexPayload || typeof indexPayload !== 'object') return null;

    const rawAnchors = Array.isArray(indexPayload.anchors) ? indexPayload.anchors : [];
    const anchors = [];
    for (const raw of rawAnchors) {
        const normalized = normalizeAnchorPlayableFloor(raw);
        if (normalized > 0 && !anchors.includes(normalized)) {
            anchors.push(normalized);
        }
    }
    anchors.sort((a, b) => a - b);

    const snapshots = new Map();
    for (const anchorPlayableFloor of anchors) {
        const ns = getLegacyAnchorNamespace(anchorPlayableFloor);
        if (!ns) continue;
        const snapshot = await context.getChatState(ns, {});
        const normalized = normalizeOrchestrationSnapshot(snapshot);
        if (normalized) {
            snapshots.set(anchorPlayableFloor, normalized);
        }
    }

    let legacySnapshot = null;
    if (indexPayload.snapshot && typeof indexPayload.snapshot === 'object') {
        const playableFloor = normalizeAnchorPlayableFloor(
            indexPayload.snapshot.anchorPlayableFloor || indexPayload.snapshot.anchorFloor,
        );
        const normalized = normalizeOrchestrationSnapshot(indexPayload.snapshot);
        if (playableFloor > 0 && normalized) {
            legacySnapshot = { playableFloor, snapshot: normalized };
            if (!snapshots.has(playableFloor)) {
                snapshots.set(playableFloor, normalized);
                anchors.push(playableFloor);
                anchors.sort((a, b) => a - b);
            }
        }
    }

    if (anchors.length === 0 && !legacySnapshot) return null;
    return { anchors, snapshots };
}

/**
 * Delete every legacy namespace touched by the migration, including the
 * pre-anchor `snapshot` sidecar and the anchor index itself. Best-effort:
 * a missing `deleteChatState` helper just leaves orphan files behind,
 * which the consumer ignores anyway.
 */
async function deleteLegacyOrchestratorState(context, anchors) {
    if (typeof context?.deleteChatState !== 'function') return;
    for (const playableFloor of anchors) {
        const ns = getLegacyAnchorNamespace(playableFloor);
        if (!ns) continue;
        await context.deleteChatState(ns, {});
    }
    await context.deleteChatState(LEGACY_INDEX_NAMESPACE, {});
}

/**
 * Replay each legacy anchor as a floor-state commit tagged at the user
 * message that owns that playable floor. Anchors whose user message
 * cannot be located in the current chat (e.g. truncated since the
 * snapshot was taken) are dropped.
 *
 * Returns the number of commits written so callers can log progress.
 */
async function replayLegacyAnchorsAsCommits(context, fs, legacy) {
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    let committed = 0;
    for (const playableFloor of legacy.anchors) {
        const snapshot = legacy.snapshots.get(playableFloor);
        if (!snapshot) continue;
        const target = getPlayableMessageAt(messages, playableFloor);
        if (!target?.message || !target.message.is_user) continue;
        const swipeIdRaw = target.message.swipe_id;
        const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
        const ok = await fs.patch(
            [{ op: 'add', path: `/${playableFloor}`, value: snapshot }],
            { floor: target.index, swipeId },
        );
        if (ok) committed += 1;
    }
    return committed;
}

/**
 * One-shot legacy upgrade. Idempotent — when the schema sidecar already
 * records `SCHEMA_VERSION`, returns immediately without I/O on the
 * legacy namespaces. Safe to call from any chat-loaded entry point.
 *
 * Order is "read legacy → write commits → write schema marker → delete
 * legacy". A crash before the schema marker is written means the next
 * startup re-runs the migration; the commit log is overwrite-only at
 * (floor, swipeId) so the replay is benign. A crash before the legacy
 * delete leaves orphan namespaces that the post-migration code never
 * reads; they are reaped on the next successful migration attempt.
 */
export async function migrateLegacyAnchorsIfNeeded(context) {
    const currentVersion = await readSchemaVersion(context);
    if (currentVersion >= SCHEMA_VERSION) {
        return { migrated: false, reason: 'already-migrated' };
    }

    const legacy = await readLegacyOrchestratorState(context);
    if (!legacy) {
        await writeSchemaVersion(context, SCHEMA_VERSION);
        return { migrated: false, reason: 'no-legacy-data' };
    }

    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const committed = await replayLegacyAnchorsAsCommits(context, fs, legacy);

    await writeSchemaVersion(context, SCHEMA_VERSION);
    await deleteLegacyOrchestratorState(context, legacy.anchors);

    return { migrated: true, committed, anchors: legacy.anchors.slice() };
}

/**
 * Read the current data namespace state. Returns `{}` (not null) so
 * callers can iterate keys without a guard.
 */
export async function loadAnchorMap(context) {
    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const data = await fs.get();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * Write a freshly-completed orchestration snapshot. The commit's
 * (floor, swipeId) tag is derived from the anchor's owning user message
 * so floor-state's structural-event handlers can correctly invalidate it
 * later.
 *
 * Returns `false` when the anchor is incomplete (missing chatIndex /
 * playableFloor) or the underlying patch failed; the caller should treat
 * this as a soft error and surface it to the UI.
 *
 * @param {object} context
 * @param {{ playableFloor: number, chatIndex: number, swipeId: number, hash: string }} anchor
 * @param {{ anchorHash: string, capsuleText: string, stageOutputs: object[] }} snapshot
 * @returns {Promise<boolean>}
 */
export async function commitAnchorSnapshot(context, anchor, snapshot) {
    const playableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const chatIndex = Number(anchor?.chatIndex);
    const swipeId = Number(anchor?.swipeId);
    if (!playableFloor || !Number.isInteger(chatIndex) || chatIndex < 0) {
        return false;
    }
    const normalizedSnapshot = normalizeOrchestrationSnapshot(snapshot);
    if (!normalizedSnapshot) {
        return false;
    }

    const fs = await getFloorStateInstance(context);
    return fs.patch(
        [{ op: 'add', path: `/${playableFloor}`, value: normalizedSnapshot }],
        { floor: chatIndex, swipeId: Number.isInteger(swipeId) && swipeId >= 0 ? swipeId : 0 },
    );
}

/**
 * Convenience: pick the latest still-valid snapshot from the data map
 * given the current chat. "Valid" = stored playable floor still points
 * at a user message AND the stored anchorHash matches the live message
 * text. Used to populate the in-memory cache that drives capsule
 * injection and UI rendering.
 *
 * @param {object} context
 * @param {Object<number, object>} anchorMap
 * @returns {{ playableFloor: number, snapshot: object } | null}
 */
export function pickLatestValidSnapshot(context, anchorMap) {
    if (!anchorMap || typeof anchorMap !== 'object') return null;
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const sortedFloors = Object.keys(anchorMap)
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => b - a);
    for (const playableFloor of sortedFloors) {
        const snapshot = normalizeOrchestrationSnapshot(anchorMap[playableFloor]);
        if (!snapshot) continue;
        if (isStoredOrchestrationSnapshotValidForMessages(playableFloor, snapshot, messages)) {
            return { playableFloor, snapshot };
        }
    }
    return null;
}

export const constants = Object.freeze({
    STATE_NAMESPACE,
    SCHEMA_NAMESPACE,
    LEGACY_INDEX_NAMESPACE,
    LEGACY_ANCHOR_NAMESPACE_PREFIX,
    SCHEMA_VERSION,
});
