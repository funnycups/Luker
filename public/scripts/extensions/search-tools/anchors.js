/**
 * Pure helpers shared between main.js and persistence.js.
 *
 * Search-tools tracks anchors at the "playable floor" granularity — the
 * 1-based count of non-system messages up to and including a given user
 * turn. The persistence layer keys snapshots in its data namespace by
 * playable floor (because that is what consumers reason about externally)
 * but commits each one at the underlying chat-array index of the anchored
 * user message so floor-state's swipe / delete / branch handlers see the
 * right key. The playable-floor primitives live in
 * `public/scripts/lib/playable-anchor.js`; this module owns the
 * search-tools anchor shape.
 *
 * Pure module: no I/O, no chat-state interaction, no event subscriptions.
 */

import {
    computeLastUserAnchorCore,
    getPlayableMessageAt,
    normalizeAnchorPlayableFloor,
} from '../../lib/playable-anchor.js';

export { getPlayableMessageAt, normalizeAnchorPlayableFloor };

/**
 * Build a content-hashed anchor at the last user turn in `messages`. The
 * shape is intentionally minimal — the persistence layer derives chatIndex
 * + swipeId from the live chat at commit time, so anchors can travel
 * through layers that don't know the live chat.
 */
export function buildLastUserAnchorFromMessages(messages) {
    const core = computeLastUserAnchorCore(messages);
    if (!core) {
        return null;
    }
    return {
        floor: core.index + 1,
        playableFloor: normalizeAnchorPlayableFloor(core.playableFloor),
        hash: core.hash,
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
