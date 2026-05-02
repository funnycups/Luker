/**
 * Pure helpers shared between main.js and persistence.js.
 *
 * Search-tools tracks anchors at the "playable floor" granularity — the
 * 1-based count of non-system messages up to and including a given user
 * turn. The persistence layer keys snapshots in its data namespace by
 * playable floor (because that is what consumers reason about externally)
 * but commits each one at the underlying chat-array index of the anchored
 * user message so floor-state's swipe / delete / branch handlers see the
 * right key. This module is everything the rest of search-tools needs to
 * translate between those two views without dragging in the rest of
 * main.js.
 *
 * Pure module: no I/O, no chat-state interaction, no event subscriptions.
 */

/**
 * Inline copy of `utils.getStringHash` (the cyrb53 variant). Inlined to
 * keep this module loadable from tests — the canonical helper lives in
 * `public/scripts/utils.js`, which transitively pulls in the full app
 * bundle and cannot be imported by a Node-based test runner. The
 * algorithm is fixed; if `utils.getStringHash` ever changes, this copy
 * must be updated in lockstep.
 */
export function hashAnchorText(str, seed = 0) {
    if (typeof str !== 'string') {
        return 0;
    }
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Coerce any input to a non-negative integer playable-floor value.
 * Strings, floats, and negatives all collapse cleanly to 0 ("invalid").
 */
export function normalizeAnchorPlayableFloor(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * Walk `messages`, count non-system entries (each one bumps the playable
 * sequence by 1), and return `{ index, message }` at the position whose
 * playable seq equals `playableFloor`. Returns null when the floor is
 * out of range, zero, or non-integer.
 */
export function getPlayableMessageAt(messages, playableFloor) {
    const source = Array.isArray(messages) ? messages : [];
    const target = normalizeAnchorPlayableFloor(playableFloor);
    if (!target) {
        return null;
    }
    let playableSeq = 0;
    for (let index = 0; index < source.length; index += 1) {
        const message = source[index];
        if (!message || message.is_system) {
            continue;
        }
        playableSeq += 1;
        if (playableSeq === target) {
            return { index, message };
        }
    }
    return null;
}

/**
 * True iff the live message at `playableFloor` is still a user turn whose
 * text hashes to `anchorHash`. Used by `pickLatestValidSnapshot` to skip
 * snapshots whose anchored message has been edited since the snapshot was
 * recorded — those snapshots remain in the data namespace as orphans, but
 * are never surfaced as the "current" snapshot.
 */
export function isAnchoredSnapshotStillValid(messages, playableFloor, anchorHash) {
    const target = getPlayableMessageAt(messages, playableFloor);
    if (!target?.message || target.message.is_system || !target.message.is_user) {
        return false;
    }
    const stored = String(anchorHash || '').trim();
    if (!stored) {
        return false;
    }
    const live = String(hashAnchorText(String(target.message.mes ?? '')));
    return stored === live;
}

/**
 * Find the last user message in `messages`. Returns
 * `{ index: -1, message: null }` when the chat has no user message yet.
 */
export function extractLastUserMessage(messages) {
    const source = Array.isArray(messages) ? messages : [];
    for (let i = source.length - 1; i >= 0; i -= 1) {
        if (source[i]?.is_user) {
            return { index: i, message: source[i] };
        }
    }
    return { index: -1, message: null };
}

/**
 * Build a content-hashed anchor at the last user turn in `messages`. The
 * shape is intentionally minimal — the persistence layer derives chatIndex
 * + swipeId from the live chat at commit time, so anchors can travel
 * through layers that don't know the live chat.
 */
export function buildLastUserAnchorFromMessages(messages) {
    const { index, message } = extractLastUserMessage(messages);
    if (index < 0 || !message) {
        return null;
    }
    const text = String(message.mes ?? '');
    const source = Array.isArray(messages) ? messages : [];
    let playableSeq = 0;
    for (let i = 0; i <= index; i += 1) {
        if (source[i] && !source[i].is_system) {
            playableSeq += 1;
        }
    }
    return {
        floor: index + 1,
        playableFloor: normalizeAnchorPlayableFloor(playableSeq),
        hash: String(hashAnchorText(text)),
    };
}

/**
 * Prefer the live `context.chat` over the per-request `payloadMessages`
 * when building the anchor — the request payload is sometimes built off
 * a stale snapshot of the chat array, while `context.chat` always points
 * at the live one.
 */
export function buildLastUserAnchor(context, payloadMessages) {
    const contextMessages = Array.isArray(context?.chat) ? context.chat : [];
    const contextAnchor = buildLastUserAnchorFromMessages(contextMessages);
    if (contextAnchor) {
        return contextAnchor;
    }
    return buildLastUserAnchorFromMessages(payloadMessages);
}
