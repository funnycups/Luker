/**
 * Anchor + active-snapshot cache for the orchestrator.
 *
 * Owns two pieces of module-private state, both scoped to the active
 * chat by `chatKey`:
 *
 *   1. `latestAnchorMap` — a copy of the floor-state data namespace
 *      (`{ playableFloor → snapshot }`) that the UI / panel rendering
 *      paths read synchronously. It is rebuilt after every orchestration
 *      commit, after every chat-structural event, and on chat change.
 *      A null value means "no chat is loaded"; an empty object means
 *      "loaded but no anchors yet".
 *
 *   2. `latestOrchestrationSnapshot` — the single anchor entry that is
 *      currently "active" for capsule injection. Picked by
 *      `pickLatestValidSnapshot` (highest playable floor whose anchor
 *      message still exists and whose stored content hash matches the
 *      live message). Falls to null when no entry is valid.
 *
 * Both state slots are cleared together by `clearCacheForChatChange`
 * when the page chat key transitions away from the cached chat.
 *
 * The set of structural events that can invalidate cached entries is
 * handled by `persistence.js` at the floor-state layer; this module
 * just rereads the data namespace and reselects the active snapshot
 * via `refreshOrchestratorStateAfterStructuralEvent`.
 *
 * `getChatKey` and `getCurrentAvatar` live here because every cache
 * operation needs them; the runner inline trace builders (loop / agenda
 * / spec) also import `getChatKey` from this module so the run-panel
 * store can scope the active run to the current chat.
 */

import {
    buildLastUserAnchor,
    compactStageOutputs,
    getPlayableMessageAt,
    isStoredOrchestrationSnapshotValidForMessages,
    normalizeAnchorPlayableFloor,
} from './anchors.js';
import {
    commitAnchorSnapshot,
    loadAnchorMap,
    migrateLegacyAnchorsIfNeeded,
    pickLatestValidSnapshot,
} from './persistence.js';

const MODULE_NAME = 'orchestrator';

let latestOrchestrationSnapshot = null;
let latestAnchorMap = null;

export function getCurrentAvatar(context) {
    return context?.characters?.[context?.characterId]?.avatar || '';
}

export function getChatKey(context) {
    if (context?.groupId) {
        return `group:${context.groupId}`;
    }
    const avatar = String(context?.characters?.[context?.characterId]?.avatar || '').trim();
    const chatId = String(context?.chatId || context?.getCurrentChatId?.() || '').trim();
    if (!avatar || !chatId) {
        return '';
    }
    return `char:${avatar}:${chatId}`;
}

export function getActiveSnapshot() {
    return latestOrchestrationSnapshot;
}

export function setActiveSnapshot(snapshot) {
    latestOrchestrationSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
}

export function clearCacheForChatChange() {
    latestOrchestrationSnapshot = null;
    latestAnchorMap = null;
}

export function setLatestAnchorMap(chatKey, anchors) {
    const normalizedChatKey = String(chatKey || '').trim();
    if (!normalizedChatKey) {
        latestAnchorMap = null;
        return;
    }
    const map = anchors && typeof anchors === 'object' && !Array.isArray(anchors) ? anchors : {};
    latestAnchorMap = { chatKey: normalizedChatKey, anchors: structuredClone(map) };
}

export function getLoadedAnchorMap(context) {
    const chatKey = getChatKey(context);
    if (!latestAnchorMap || String(latestAnchorMap.chatKey || '') !== String(chatKey || '')) {
        return {};
    }
    return latestAnchorMap.anchors;
}

export function getLoadedOrchestrationHistoryAnchors(context) {
    const map = getLoadedAnchorMap(context);
    return Object.keys(map)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0)
        .sort((a, b) => a - b);
}

export function setLatestOrchestrationSnapshotFromPick(chatKey, pick) {
    const normalizedChatKey = String(chatKey || '').trim();
    if (!normalizedChatKey || !pick) {
        latestOrchestrationSnapshot = null;
        return;
    }
    latestOrchestrationSnapshot = {
        chatKey: normalizedChatKey,
        anchorPlayableFloor: normalizeAnchorPlayableFloor(pick.playableFloor),
        anchorHash: String(pick.snapshot?.anchorHash || '').trim(),
        capsuleText: String(pick.snapshot?.capsuleText || '').trim(),
        stageOutputs: Array.isArray(pick.snapshot?.stageOutputs)
            ? structuredClone(pick.snapshot.stageOutputs)
            : [],
    };
}

/**
 * Refresh `latestOrchestrationSnapshot` from the cached anchor map for
 * the given chat. Synchronous. Uses `pickLatestValidSnapshot` to find
 * the highest-floor entry whose anchor message still exists and whose
 * stored hash matches the live message text.
 */
export function refreshActiveSnapshotFromCache(context) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        return null;
    }
    const map = getLoadedAnchorMap(context);
    const pick = pickLatestValidSnapshot(context, map);
    setLatestOrchestrationSnapshotFromPick(chatKey, pick);
    return latestOrchestrationSnapshot;
}

/**
 * Read the floor-state data namespace, run the legacy migration if a
 * pre-floor-state chat is being opened for the first time, and refresh
 * the in-memory caches that drive UI rendering.
 *
 * Safe to call repeatedly — the migration is idempotent and the
 * floor-state instance shares its ready gate so concurrent calls
 * coalesce on the same `fs.ready()` promise.
 */
export async function loadOrchestratorChatState(context) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        latestAnchorMap = null;
        return;
    }

    try {
        await migrateLegacyAnchorsIfNeeded(context);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] legacy anchor migration failed`, error);
    }

    let map = {};
    try {
        map = await loadAnchorMap(context);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] loadAnchorMap failed`, error);
    }

    setLatestAnchorMap(chatKey, map);
    refreshActiveSnapshotFromCache(context);
}

export function getLatestOrchestrationEntry(context) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return null;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    const injectedText = String(latestOrchestrationSnapshot.capsuleText || '').trim();
    if (!injectedText) {
        return null;
    }
    return {
        anchorPlayableFloor: normalizeAnchorPlayableFloor(latestOrchestrationSnapshot.anchorPlayableFloor),
        injectedText,
    };
}

export function canReuseLatestOrchestrationSnapshot(chatKey, anchor) {
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return false;
    }
    if (!anchor || typeof anchor !== 'object') {
        return false;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }
    return normalizeAnchorPlayableFloor(latestOrchestrationSnapshot.anchorPlayableFloor) === normalizeAnchorPlayableFloor(anchor.playableFloor)
        && String(latestOrchestrationSnapshot.anchorHash || '') === String(anchor.hash || '');
}

/**
 * Persist a freshly-completed orchestration as a floor-state commit, and
 * refresh the in-memory cache + active snapshot so subsequent reads see
 * the new entry. Anchors past the new floor are not proactively pruned —
 * floor-state's structural-event handlers drop them when the user
 * actually deletes / swipes the higher floors. If the user merely
 * generates again at a lower floor without truncating, the higher
 * entries stay in the namespace but are filtered at consume time by the
 * anchor-hash + is_user check.
 *
 * Returns the freshly-stored active snapshot, or null when the input
 * was incomplete. Callers that need a UI rebuild after the state
 * changes should run their own `ensureUi` step on the result.
 */
export async function storeCompletedOrchestrationSnapshot(context, anchor, capsuleText, stageOutputs) {
    const chatKey = getChatKey(context);
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const anchorHash = String(anchor?.hash || '').trim();
    const nextCapsuleText = String(capsuleText || '').trim();
    if (!chatKey || !anchorPlayableFloor || !anchorHash || !nextCapsuleText) {
        return null;
    }

    const nextSnapshot = {
        anchorHash,
        capsuleText: nextCapsuleText,
        stageOutputs: compactStageOutputs(stageOutputs || []),
    };

    const ok = await commitAnchorSnapshot(context, anchor, nextSnapshot);
    if (!ok) {
        throw new Error('Failed to persist orchestration snapshot.');
    }

    const map = { ...getLoadedAnchorMap(context), [anchorPlayableFloor]: nextSnapshot };
    setLatestAnchorMap(chatKey, map);
    setLatestOrchestrationSnapshotFromPick(chatKey, {
        playableFloor: anchorPlayableFloor,
        snapshot: nextSnapshot,
    });
    return latestOrchestrationSnapshot;
}

function shallowEqualAnchorMaps(left, right) {
    const leftKeys = Object.keys(left || {}).sort();
    const rightKeys = Object.keys(right || {}).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i++) {
        if (leftKeys[i] !== rightKeys[i]) return false;
    }
    return true;
}

function shallowEqualActiveSnapshots(left, right) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return String(left.chatKey || '') === String(right.chatKey || '')
        && Number(left.anchorPlayableFloor || 0) === Number(right.anchorPlayableFloor || 0)
        && String(left.anchorHash || '') === String(right.anchorHash || '')
        && String(left.capsuleText || '') === String(right.capsuleText || '');
}

/**
 * After a structural event (chat change, message delete, message edit),
 * re-read the floor-state data namespace and reselect the active snapshot.
 * Returns whether the active snapshot or the anchor set actually changed,
 * so callers can decide whether to clear the capsule prompt and refresh
 * the UI.
 */
export async function refreshOrchestratorStateAfterStructuralEvent(context) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        latestAnchorMap = null;
        return { activeChanged: false, mapChanged: false };
    }

    const previousActive = latestOrchestrationSnapshot;
    const previousMap = getLoadedAnchorMap(context);

    let map = {};
    try {
        map = await loadAnchorMap(context);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] loadAnchorMap (structural) failed`, error);
    }
    setLatestAnchorMap(chatKey, map);
    refreshActiveSnapshotFromCache(context);

    const mapChanged = !shallowEqualAnchorMaps(previousMap, map);
    const activeChanged = !shallowEqualActiveSnapshots(previousActive, latestOrchestrationSnapshot);
    return { activeChanged, mapChanged };
}

/**
 * Persist a snapshot that the user just hand-edited (Edit Last
 * Orchestration popup). Re-reads the live chat to derive the floor-state
 * commit tag (chatIndex + swipeId) so future structural events can still
 * invalidate the entry correctly.
 */
export async function persistEditedSnapshotToFloorState(context, snapshot) {
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(snapshot?.anchorPlayableFloor);
    if (!anchorPlayableFloor) return false;
    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const target = getPlayableMessageAt(messages, anchorPlayableFloor);
    if (!target?.message || !target.message.is_user) return false;
    const swipeIdRaw = target.message.swipe_id;
    const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
    const anchor = {
        playableFloor: anchorPlayableFloor,
        chatIndex: target.index,
        swipeId,
        hash: String(snapshot?.anchorHash || ''),
    };
    const dataSnapshot = {
        anchorHash: String(snapshot?.anchorHash || ''),
        capsuleText: String(snapshot?.capsuleText || ''),
        stageOutputs: Array.isArray(snapshot?.stageOutputs) ? snapshot.stageOutputs : [],
    };
    const ok = await commitAnchorSnapshot(context, anchor, dataSnapshot);
    if (!ok) return false;
    const chatKey = getChatKey(context);
    if (chatKey) {
        const map = { ...getLoadedAnchorMap(context), [anchorPlayableFloor]: dataSnapshot };
        setLatestAnchorMap(chatKey, map);
    }
    return true;
}

/**
 * Find the most recent prior orchestration capsule text that is still
 * valid for the current chat array. Used by runtime modules to inject
 * the previous orchestration into a node prompt prelude.
 *
 * Caches the result on `payload.__lukerOrchPreviousCapsuleText` so the
 * function can be called multiple times within a single orchestration
 * run without rescanning the anchor map.
 */
export async function getPreviousOrchestrationCapsuleText(context, payload) {
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, '__lukerOrchPreviousCapsuleText')) {
        return String(payload.__lukerOrchPreviousCapsuleText || '');
    }
    const coreMessages = Array.isArray(payload?.coreChat) ? payload.coreChat : [];
    const chatKey = getChatKey(context);
    const currentAnchor = buildLastUserAnchor(context, coreMessages);
    const currentAnchorPlayableFloor = normalizeAnchorPlayableFloor(currentAnchor?.playableFloor);
    if (!chatKey || !currentAnchorPlayableFloor) {
        return '';
    }

    const messages = coreMessages.length > 0
        ? coreMessages
        : (Array.isArray(context?.chat) ? context.chat : []);
    const candidateAnchors = getLoadedOrchestrationHistoryAnchors(context)
        .filter(anchorPlayableFloor => anchorPlayableFloor < currentAnchorPlayableFloor)
        .sort((left, right) => right - left);

    const anchorMap = getLoadedAnchorMap(context);
    for (const anchorPlayableFloor of candidateAnchors) {
        const snapshot = anchorMap[anchorPlayableFloor];
        if (!snapshot || !isStoredOrchestrationSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages)) {
            continue;
        }
        const previousCapsuleText = String(snapshot.capsuleText || '').trim();
        if (payload && typeof payload === 'object') {
            payload.__lukerOrchPreviousCapsuleText = previousCapsuleText;
        }
        return previousCapsuleText;
    }

    if (payload && typeof payload === 'object') {
        payload.__lukerOrchPreviousCapsuleText = '';
    }
    return '';
}
