/**
 * Floor-state adapter for the search-tools extension.
 *
 * Replaces the legacy two-tier persistence scheme — the index namespace
 * `luker_search_tools_state` (listing anchor playable floors plus a
 * fallback `managedEntries` array) with one per-anchor sidecar
 * `luker_search_tools_state_anchor_<N>` per anchor — with a single
 * floor-state-managed data namespace `luker_search_tools_anchors` whose
 * contents are `{ [playableFloor]: snapshot }`.
 *
 * The new namespace is intentionally renamed: floor-state's CHAT_CHANGED
 * handler rebuilds the data namespace from the log every time a chat is
 * opened, and an empty log produces `{}`. If we reused the old name, any
 * un-migrated chat would have its v3 envelope destroyed the moment the
 * floor-state instance saw it. A separate name keeps legacy data
 * untouched until the one-shot migration in this module reads it.
 *
 * Each commit tags itself at `(userMessageChatIndex, userMessageSwipeId)`
 * so floor-state's structural-event handlers correctly invalidate it:
 *
 *   - swipe of the anchored user turn → commit filtered out by the swipe
 *     map → snapshot disappears
 *   - tail truncation past the anchored floor → commit filtered out by
 *     `truncateCommits` → snapshot disappears
 *   - branch creation → floor-state's CHAT_BRANCH_CREATED handler copies
 *     surviving commits into the new chat's log → snapshots follow the
 *     branch automatically
 *
 * Edit invalidation (the user changes the anchored message text without
 * deleting it) is NOT handled here. Each snapshot embeds its anchor
 * content hash and `pickLatestValidSnapshot` skips entries whose live
 * message no longer matches — so stale entries simply fail the validity
 * check instead of being proactively scrubbed. The trade-off is a few
 * orphan KB in the data namespace until the floor is itself deleted /
 * overwritten by a new search-agent run; it buys the removal of the
 * MESSAGE_EDITED handler and the entire `invalidateStoredSearchAgentAnchors`
 * machinery from main.js.
 *
 * A `<ns>__meta` sidecar carries non-floor-bound metadata: the
 * schemaVersion stamp, and the legacy `fallbackManagedEntries` (entries
 * lifted from a pre-existing chat lorebook by the one-shot world-info
 * migration in main.js, before any search-agent snapshot existed). The
 * sidecar is written directly via the chat-state API — those fields would
 * otherwise be replayed-then-overwritten by floor-state's rebuild from
 * `{}`.
 *
 * Legacy upgrade is one-shot per chat: on first load we read the legacy
 * namespaces, replay each anchor's snapshot as a floor-state commit at
 * its user-message floor, write the legacy `managedEntries` array to the
 * meta sidecar, and delete the legacy index + per-anchor sidecars. The
 * schema version stamped in the meta sidecar marks the migration
 * complete so the upgrade is idempotent across reloads.
 */

import {
    getPlayableMessageAt,
    isAnchoredSnapshotStillValid,
    normalizeAnchorPlayableFloor,
} from './anchors.js';
import { STATE_ERROR_REASONS, makeStateError } from '../../state-errors.js';

const STATE_NAMESPACE = 'luker_search_tools_anchors';
const META_NAMESPACE = `${STATE_NAMESPACE}__meta`;
const LEGACY_INDEX_NAMESPACE = 'luker_search_tools_state';
const LEGACY_ANCHOR_NAMESPACE_PREFIX = `${LEGACY_INDEX_NAMESPACE}_anchor_`;
const SCHEMA_VERSION = 1;

let floorStatePromise = null;

/**
 * Lazy singleton holding the floor-state instance for search-tools. The
 * instance lives for the page session; its data namespace is kept in sync
 * with chat structure by core driving `settleXxx` from `floor-state.js`
 * on every structural transition — callers do not need to recreate it.
 */
export async function getFloorStateInstance(context) {
    if (!floorStatePromise) {
        if (typeof context?.createFloorState !== 'function') {
            throw new Error('[search-tools] createFloorState API is unavailable in extension context.');
        }
        // Caching a rejected Promise would pin every later call to the same
        // failure even after the underlying issue clears; drop the cache on
        // failure so the next call retries from scratch.
        floorStatePromise = context.createFloorState({ namespace: STATE_NAMESPACE })
            .catch((err) => {
                floorStatePromise = null;
                throw err;
            });
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
 * Read the meta sidecar (`<ns>__meta`). Returns a plain object with
 * `schemaVersion` and `fallbackManagedEntries` defaulted, never null,
 * so callers don't have to guard.
 */
export async function loadMetaSidecar(context) {
    if (typeof context?.getChatState !== 'function') {
        return { schemaVersion: 0, fallbackManagedEntries: [] };
    }
    const result = await context.getChatState(META_NAMESPACE, {});
    if (!result.ok) {
        console.warn(`[search-tools] meta sidecar read failed (reason=${result.reason}, hint=${result.hint})`);
        return { schemaVersion: 0, fallbackManagedEntries: [] };
    }
    const source = result.state && typeof result.state === 'object' ? result.state : {};
    return {
        schemaVersion: Math.max(0, Math.floor(Number(source.schemaVersion || 0))),
        fallbackManagedEntries: Array.isArray(source.fallbackManagedEntries)
            ? source.fallbackManagedEntries
            : [],
    };
}

async function writeMetaSidecar(context, meta) {
    if (typeof context?.updateChatState !== 'function') return false;
    const result = await context.updateChatState(META_NAMESPACE, () => meta, {
        maxOperations: 2000,
        maxRetries: 1,
    });
    if (!result.ok) {
        throw new Error(`[search-tools] meta sidecar write failed (${result.reason}): ${result.hint}`);
    }
    return true;
}

/**
 * Persist the legacy "fallback managed entries" — the array of managed
 * lorebook entries lifted from a pre-existing chat world-info book by the
 * one-shot migration in main.js, before any per-anchor snapshot exists.
 * Once any snapshot exists, the snapshot's `managedEntries` is the source
 * of truth and this fallback is unused.
 *
 * Caller is expected to pass a normalized array (search-tools' own
 * `normalizeStoredManagedEntries` shape); persistence keeps it opaque.
 */
export async function persistFallbackManagedEntries(context, entries) {
    const current = await loadMetaSidecar(context);
    const safe = Array.isArray(entries) ? entries : [];
    await writeMetaSidecar(context, {
        ...current,
        fallbackManagedEntries: safe,
    });
}

/**
 * Read the data namespace as a `{ [playableFloor]: snapshot }` map.
 * Returns `{}` (not null) so callers can iterate keys without a guard.
 */
export async function loadAnchorMap(context) {
    const fs = await getFloorStateInstance(context);
    const readyResult = await fs.ready();
    if (readyResult && readyResult.ok === false) {
        console.warn(`[search-tools] floor-state ready failed (reason=${readyResult.reason}, hint=${readyResult.hint})`);
        return {};
    }
    const getResult = await fs.get();
    if (!getResult.ok) {
        console.warn(`[search-tools] floor-state get failed (reason=${getResult.reason}, hint=${getResult.hint})`);
        return {};
    }
    const data = getResult.state;
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/**
 * Write a freshly-completed search-agent snapshot. The commit's
 * (floor, swipeId) tag is derived from the anchored user message in the
 * live chat so floor-state's structural-event handlers can correctly
 * invalidate it later.
 *
 * Returns a state envelope: `{ ok: false, reason, hint }` when the anchor
 * cannot be resolved against the current chat (the user message at that
 * playable floor is missing / no longer is_user) or the snapshot fails
 * validation, otherwise the envelope returned by `fs.patch`
 * (`{ ok: true, updated: boolean }` on success, or
 * `{ ok: false, reason, hint }` on failure). Callers should branch on
 * `result.ok` and surface non-ok envelopes to the UI as soft errors.
 *
 * @param {object} context — getContext() result
 * @param {{ playableFloor: number, hash: string }} anchor
 * @param {object} snapshot — opaque payload (the search-agent result),
 *   stored as-is under `/${playableFloor}` in the data namespace.
 * @returns {Promise<{ ok: boolean, updated?: boolean, reason?: string, hint?: string }>}
 */
export async function commitAnchorSnapshot(context, anchor, snapshot) {
    const playableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    if (!playableFloor) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_ARGS, 'invalid anchor playableFloor');
    }
    if (!snapshot || typeof snapshot !== 'object') {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_ARGS, 'snapshot must be a non-null object');
    }

    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const target = getPlayableMessageAt(messages, playableFloor);
    if (!target?.message || !target.message.is_user) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_TARGET, 'anchored user message no longer present at playable floor');
    }

    const swipeIdRaw = target.message.swipe_id;
    const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;

    const fs = await getFloorStateInstance(context);
    return fs.patch(
        [{ op: 'add', path: `/${playableFloor}`, value: snapshot }],
        { floor: target.index, swipeId },
    );
}

/**
 * Pick the highest-floor entry from `anchorMap` whose anchored user
 * message still exists and whose stored anchorHash still matches the
 * live message text. Returns `{ playableFloor, snapshot }` or null.
 *
 * Snapshots whose anchor was edited (text changed without delete) fail
 * the hash check and are skipped — they remain in the data namespace as
 * orphans, but the consumer never sees them. The orphan is reaped when
 * the floor is itself swiped or deleted, or overwritten by a new commit
 * at the same floor.
 */
export function pickLatestValidSnapshot(context, anchorMap) {
    if (!anchorMap || typeof anchorMap !== 'object') return null;
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const sortedFloors = Object.keys(anchorMap)
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => b - a);
    for (const playableFloor of sortedFloors) {
        const snapshot = anchorMap[playableFloor];
        if (!snapshot || typeof snapshot !== 'object') continue;
        if (!isAnchoredSnapshotStillValid(messages, playableFloor, snapshot.anchorHash)) continue;
        return { playableFloor, snapshot };
    }
    return null;
}

/**
 * Read every entry in the legacy index + per-anchor sidecars for the
 * current chat. Returns the parsed legacy payload plus the per-anchor
 * snapshots already keyed by playable floor, or null when no legacy
 * data is present (fresh chat or already migrated).
 */
async function readLegacySearchToolsState(context) {
    if (typeof context?.getChatState !== 'function') return null;
    const indexResult = await context.getChatState(LEGACY_INDEX_NAMESPACE, {});
    if (!indexResult.ok) {
        throw new Error(`[search-tools] legacy index unreadable (${indexResult.reason}): ${indexResult.hint}`);
    }
    const indexPayload = indexResult.state;
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
    for (const playableFloor of anchors) {
        const ns = getLegacyAnchorNamespace(playableFloor);
        if (!ns) continue;
        const sidecarResult = await context.getChatState(ns, {});
        if (!sidecarResult.ok) {
            throw new Error(`[search-tools] legacy sidecar unreadable for floor ${playableFloor} (${sidecarResult.reason}): ${sidecarResult.hint}`);
        }
        const sidecar = sidecarResult.state;
        if (sidecar && typeof sidecar === 'object') {
            snapshots.set(playableFloor, sidecar);
        }
    }

    // The pre-anchor-list v1/v2 shape stored a single snapshot inline at
    // `indexPayload.snapshot`; promote it to the anchor list so it gets
    // replayed alongside the rest.
    const legacyTopLevelSnapshot = indexPayload.snapshot && typeof indexPayload.snapshot === 'object'
        ? indexPayload.snapshot
        : null;
    if (legacyTopLevelSnapshot) {
        const playableFloor = normalizeAnchorPlayableFloor(
            legacyTopLevelSnapshot.anchorPlayableFloor || legacyTopLevelSnapshot.anchorFloor,
        );
        if (playableFloor > 0 && !snapshots.has(playableFloor)) {
            snapshots.set(playableFloor, legacyTopLevelSnapshot);
            anchors.push(playableFloor);
            anchors.sort((a, b) => a - b);
        }
    }

    const managedEntries = Array.isArray(indexPayload.managedEntries)
        ? indexPayload.managedEntries
        : [];

    if (anchors.length === 0 && managedEntries.length === 0 && !legacyTopLevelSnapshot) {
        return null;
    }
    return { anchors, snapshots, managedEntries };
}

/**
 * Best-effort delete of every legacy namespace touched by the migration,
 * including the index ns itself. A missing `deleteChatState` helper just
 * leaves orphan files behind, which the post-migration code never reads.
 */
async function deleteLegacySearchToolsState(context, anchors) {
    if (typeof context?.deleteChatState !== 'function') return;
    for (const playableFloor of anchors) {
        const ns = getLegacyAnchorNamespace(playableFloor);
        if (!ns) continue;
        const result = await context.deleteChatState(ns, {});
        if (!result.ok) {
            console.warn(`[search-tools] legacy anchor cleanup for ${ns} failed (reason=${result.reason}, hint=${result.hint})`);
        }
    }
    const indexResult = await context.deleteChatState(LEGACY_INDEX_NAMESPACE, {});
    if (!indexResult.ok) {
        console.warn(`[search-tools] legacy index cleanup failed (reason=${indexResult.reason}, hint=${indexResult.hint})`);
    }
}

/**
 * Replay each legacy anchor as a floor-state commit tagged at the user
 * message that owns that playable floor. Anchors whose user message
 * cannot be located in the current chat (e.g. truncated since the
 * snapshot was taken) are dropped.
 *
 * Returns `{ committed, skipped }` so callers can log progress. Aborts
 * early (returning the partial counts) when fs.patch reports
 * REPLAY_BROKEN / INSTANCE_DESTROYED / LOG_WRITE_FAILED — those reasons
 * indicate the floor-state instance itself is wedged and continuing
 * would just rack up more failures.
 */
async function replayLegacyAnchorsAsCommits(context, fs, legacy) {
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    let committed = 0;
    let skipped = 0;
    for (const playableFloor of legacy.anchors) {
        const snapshot = legacy.snapshots.get(playableFloor);
        if (!snapshot || typeof snapshot !== 'object') continue;
        const target = getPlayableMessageAt(messages, playableFloor);
        if (!target?.message || !target.message.is_user) continue;
        const swipeIdRaw = target.message.swipe_id;
        const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
        const result = await fs.patch(
            [{ op: 'add', path: `/${playableFloor}`, value: snapshot }],
            { floor: target.index, swipeId },
        );
        if (result.ok) {
            committed += 1;
            continue;
        }
        if (result.reason === STATE_ERROR_REASONS.REPLAY_BROKEN
            || result.reason === STATE_ERROR_REASONS.INSTANCE_DESTROYED
            || result.reason === STATE_ERROR_REASONS.LOG_WRITE_FAILED) {
            console.warn(`[search-tools] migration aborted at anchor F${playableFloor} (reason=${result.reason}, hint=${result.hint})`);
            return { committed, skipped: legacy.anchors.length - committed };
        }
        skipped += 1;
        console.warn(`[search-tools] migration: anchor F${playableFloor} dropped (reason=${result.reason}, hint=${result.hint})`);
    }
    return { committed, skipped };
}

/**
 * One-shot legacy upgrade. Idempotent — when the meta sidecar already
 * records `SCHEMA_VERSION`, returns immediately without I/O on the
 * legacy namespaces. Safe to call from any chat-loaded entry point.
 *
 * Order is "read legacy → write commits → stamp schema → delete legacy
 * sidecars". A crash before the schema marker is written means the next
 * startup re-runs the migration; the commit log is overwrite-only at
 * (floor, swipeId) so the replay is benign. A crash before the legacy
 * delete leaves orphan namespaces that the post-migration code never
 * reads; they are reaped on the next successful migration attempt.
 *
 * Atomicity: `writeMetaSidecar` throws on hard failure, so the
 * `deleteLegacySearchToolsState` below is gated on schema-stamp success.
 * The explicit try/catch makes this contract local and documented — if
 * the schema stamp ever silently fails, legacy data MUST be preserved
 * so the next boot can retry the migration end-to-end.
 */
export async function migrateLegacyAnchorsIfNeeded(context) {
    const meta = await loadMetaSidecar(context);
    if (meta.schemaVersion >= SCHEMA_VERSION) {
        return { migrated: false, reason: 'already-migrated' };
    }

    const legacy = await readLegacySearchToolsState(context);
    if (!legacy) {
        await writeMetaSidecar(context, { ...meta, schemaVersion: SCHEMA_VERSION });
        return { migrated: false, reason: 'no-legacy-data' };
    }

    const fs = await getFloorStateInstance(context);
    await fs.ready();
    const { committed } = await replayLegacyAnchorsAsCommits(context, fs, legacy);

    try {
        await writeMetaSidecar(context, {
            schemaVersion: SCHEMA_VERSION,
            fallbackManagedEntries: legacy.managedEntries,
        });
    } catch (e) {
        console.warn(`[search-tools] migration schema stamp failed: ${e.message}; legacy data preserved`);
        throw e;  // do NOT proceed to deleteLegacySearchToolsState
    }
    await deleteLegacySearchToolsState(context, legacy.anchors);

    return {
        migrated: true,
        committed,
        anchors: legacy.anchors.slice(),
        fallbackManagedEntryCount: legacy.managedEntries.length,
    };
}

export const constants = Object.freeze({
    STATE_NAMESPACE,
    META_NAMESPACE,
    LEGACY_INDEX_NAMESPACE,
    LEGACY_ANCHOR_NAMESPACE_PREFIX,
    SCHEMA_VERSION,
});
