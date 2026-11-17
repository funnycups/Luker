/**
 * Floor-state adapter for the search-tools extension.
 *
 * The store keeps one evolving payload in floor-state:
 *
 *   { entries: { [entryId]: { title, keywords, content, alwaysInject } } }
 *
 * floor-state's log (`<ns>__floor_log`) is the only persisted truth: each
 * commit carries the prev → next diff of that payload (RFC 6902), so
 * entries that did not change are never re-serialized. The data namespace
 * is legacy — floor-state migrates and deletes it.
 *
 * Each commit is tagged at `(userMessageChatIndex, userMessageSwipeId)` of
 * the user turn the run belongs to, so floor-state's structural handlers
 * drop it correctly:
 *
 *   - swipe of that user turn → commit filtered out by the swipe map
 *   - truncation past that floor → commit filtered out by `truncateCommits`
 *   - branch creation → floor-state's CHAT_BRANCH_CREATED handler copies
 *     surviving commits into the new chat's log
 *
 * Message text is deliberately NOT part of the payload. Editing the
 * anchored turn does not invalidate stored entries; whether a previous run
 * may be reused is decided in memory by the caller, which compares the
 * anchored text hash. Swiping or deleting the owning turn is what drops
 * the data.
 *
 * Legacy shape: chats written before the payload became `{ entries }` hold
 * `{ [playableFloor]: snapshot }` in the same namespace. `loadManagedEntries`
 * reads either shape; the first write after a legacy read diffs it away with
 * root-level `remove /N` + `add /entries` operations. Both are single-segment,
 * so they replay correctly against `{}` even when the legacy commits they were
 * diffed against have already been dropped.
 */

import {
    getPlayableMessageAt,
    normalizeAnchorPlayableFloor,
} from './anchors.js';

function getStateErrors(context = null) {
    const se = context?.stateErrors ?? globalThis.Luker?.getContext?.()?.stateErrors;
    if (!se) {
        throw new Error('Luker.getContext().stateErrors is unavailable');
    }
    return se;
}

const STATE_NAMESPACE = 'luker_search_tools_anchors';

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

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** True when the payload already carries the current `{ entries }` shape. */
function isEntriesPayload(payload) {
    return isPlainObject(payload) && isPlainObject(payload.entries);
}

/**
 * Key normalized entry objects by `entryId`. The id becomes the key, so it
 * is not repeated inside the value.
 */
export function toEntriesMap(entries) {
    const map = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!isPlainObject(entry)) continue;
        const entryId = String(entry.entryId || '').trim();
        if (!entryId) continue;
        map[entryId] = {
            title: String(entry.title || ''),
            keywords: Array.isArray(entry.keywords) ? entry.keywords.slice() : [],
            content: String(entry.content || ''),
            alwaysInject: Boolean(entry.alwaysInject),
        };
    }
    return map;
}

/** Inverse of `toEntriesMap`: the array shape the rest of the plugin uses. */
export function fromEntriesMap(map) {
    if (!isPlainObject(map)) return [];
    return Object.entries(map).map(([entryId, entry]) => ({
        entryId,
        title: String(entry?.title || ''),
        keywords: Array.isArray(entry?.keywords) ? entry.keywords.slice() : [],
        content: String(entry?.content || ''),
        alwaysInject: Boolean(entry?.alwaysInject),
    }));
}

/**
 * Derive the entries map from a legacy `{ [playableFloor]: snapshot }`
 * payload. The highest floor's `managedEntries` is the newest complete set.
 */
function entriesFromLegacyPayload(payload) {
    if (!isPlainObject(payload)) return {};
    const floors = Object.keys(payload)
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => b - a);
    for (const floor of floors) {
        const snapshot = payload[floor];
        if (!isPlainObject(snapshot) || !Array.isArray(snapshot.managedEntries)) continue;
        return toEntriesMap(snapshot.managedEntries);
    }
    return {};
}

async function readPayload(context) {
    const fs = await getFloorStateInstance(context);
    const readyResult = await fs.ready();
    if (readyResult && readyResult.ok === false) {
        throw new Error(`[search-tools] floor-state ready failed (${readyResult.reason}): ${readyResult.hint}`);
    }
    const getResult = await fs.get();
    if (!getResult.ok) {
        throw new Error(`[search-tools] floor-state get failed (${getResult.reason}): ${getResult.hint}`);
    }
    return isPlainObject(getResult.state) ? getResult.state : {};
}

/**
 * Read the current managed-entry set, keyed by `entryId`. Returns `{}` for
 * a chat that has never stored anything. A legacy `{ [playableFloor]: snapshot }`
 * payload is read too — the newest complete set is derived from it, and the
 * next write replaces it with the current shape.
 */
export async function loadManagedEntries(context) {
    const payload = await readPayload(context);
    if (isEntriesPayload(payload)) {
        return payload.entries;
    }
    return entriesFromLegacyPayload(payload);
}

/**
 * Commit a completed search-agent result. The supplied entries become the
 * whole current set: entries absent from it are dropped. floor-state diffs
 * the payload, so unchanged entries are not re-serialized; a legacy payload
 * is replaced in one self-contained root commit.
 *
 * Returns a state envelope — `{ ok: false, reason, hint }` when the anchor
 * cannot be resolved against the current chat (the user message at that
 * playable floor is missing / no longer is_user), otherwise the envelope
 * returned by `fs.update` / `fs.patch`.
 *
 * @param {object} context — getContext() result
 * @param {{ playableFloor: number }} anchor
 * @param {object[]} entries — normalized managed entries (`entryId` present)
 * @returns {Promise<{ ok: boolean, updated?: boolean, reason?: string, hint?: string }>}
 */
export async function commitManagedEntries(context, anchor, entries) {
    const { STATE_ERROR_REASONS, makeStateError } = getStateErrors(context);
    const playableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    if (!playableFloor) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_ARGS, 'invalid anchor playableFloor');
    }

    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const target = getPlayableMessageAt(messages, playableFloor);
    if (!target?.message || !target.message.is_user) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_TARGET, 'anchored user message no longer present at playable floor');
    }

    const nextEntries = toEntriesMap(entries);
    const fs = await getFloorStateInstance(context);
    // The reducer returns the whole payload, so a legacy
    // `{ [playableFloor]: snapshot }` state is diffed away with root-level
    // `remove /N` + `add /entries` operations — both single-segment, so they
    // replay correctly against `{}` even when the legacy commits have already
    // been dropped. In the steady state only the entries that actually
    // changed show up in the commit.
    // Only `floor` is pinned; floor-state reads the swipe id from the message.
    return fs.update(() => ({ entries: nextEntries }), { floor: target.index });
}

export const constants = Object.freeze({
    STATE_NAMESPACE,
});
