/**
 * Anchor helpers for the orchestrator.
 *
 * An "anchor" identifies the user turn that an orchestration result is
 * bound to. Three pieces of information together describe one anchor:
 *
 *   - playableFloor — 1-based ordinal of the user message inside the
 *     "playable" sequence of the chat (the chat with system messages
 *     skipped). Stable when system messages are inserted/removed; this
 *     is the user-facing identifier and the key under which snapshots
 *     are stored in the floor-state data namespace.
 *   - chatIndex — 0-based position of the same message in the raw chat
 *     array. Required by the floor-state commit log because floor-state
 *     filters / truncates / renumbers commits by chat index.
 *   - hash — content hash of the user message text. The orchestration
 *     result is content-bound: editing the anchored message invalidates
 *     the snapshot even when its position has not changed.
 *
 * This module is pure: no I/O, no chat-state interaction, no event
 * subscriptions. Persistence and event wiring live in
 * `persistence.js` and `main.js`. Playable-floor primitives come from
 * public/scripts/lib/playable-anchor.js.
 */

import {
    computeLastUserAnchorCore,
    isPlayableAnchorHashValid,
} from '../../lib/playable-anchor.js';

export {
    extractLastUserMessage,
    getPlayableMessageAt,
    normalizeAnchorPlayableFloor,
} from '../../lib/playable-anchor.js';

/**
 * Slice the chat array down to the most recent `assistantTurns` assistant
 * turns plus the user messages immediately preceding the cutoff turn.
 * System messages are skipped during the count. Returns the full array
 * when fewer assistant turns exist than requested.
 *
 * @param {Array} messages
 * @param {number} assistantTurns
 * @returns {Array}
 */
export function getRecentMessages(messages, assistantTurns) {
    const source = Array.isArray(messages) ? messages : [];
    const targetTurns = Math.max(1, Math.floor(Number(assistantTurns) || 1));

    let matchedTurns = 0;
    let startIndex = -1;
    for (let i = source.length - 1; i >= 0; i -= 1) {
        const message = source[i];
        if (!message || message.is_system) {
            continue;
        }
        if (!message.is_user) {
            matchedTurns += 1;
            if (matchedTurns >= targetTurns) {
                startIndex = i;
                break;
            }
        }
    }

    if (startIndex < 0) {
        return source.slice();
    }

    while (startIndex > 0) {
        const prev = source[startIndex - 1];
        if (!prev || prev.is_system || !prev.is_user) {
            break;
        }
        startIndex -= 1;
    }

    return source.slice(startIndex);
}

/**
 * Build the full anchor record from a chat array. Includes both the
 * playable ordinal (data-namespace key) and the raw chat index + swipeId
 * (floor-state commit tag) so callers don't have to re-derive them.
 *
 * Returns `null` when there is no user message yet.
 *
 * @param {Array} messages
 * @returns {{ playableFloor: number, chatIndex: number, swipeId: number, hash: string } | null}
 */
export function buildLastUserAnchorFromMessages(messages) {
    const core = computeLastUserAnchorCore(messages);
    if (!core) {
        return null;
    }
    const swipeIdRaw = core.message.swipe_id;
    const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
    return {
        chatIndex: core.index,
        playableFloor: core.playableFloor,
        swipeId,
        hash: core.hash,
    };
}

/**
 * Prefer the live `context.chat` over the payload's snapshot when both
 * are present — the payload's `coreChat` may be a stale slice from the
 * generation pipeline. Falls back to the payload when no context chat
 * is available (e.g. very early in the bootstrap).
 *
 * @param {object} context
 * @param {Array} payloadMessages
 * @returns {{ playableFloor: number, chatIndex: number, swipeId: number, hash: string } | null}
 */
export function buildLastUserAnchor(context, payloadMessages) {
    const contextMessages = Array.isArray(context?.chat) ? context.chat : [];
    const contextAnchor = buildLastUserAnchorFromMessages(contextMessages);
    if (contextAnchor) {
        return contextAnchor;
    }
    return buildLastUserAnchorFromMessages(payloadMessages);
}

/**
 * Coerce arbitrary persisted JSON into the canonical snapshot shape, or
 * `null` when the input lacks the required fields. Defensive — a stored
 * snapshot may have been written by an older version or hand-edited.
 *
 * @param {*} raw
 * @returns {{ anchorHash: string, capsuleText: string, stageOutputs: object[] } | null}
 */
export function normalizeOrchestrationSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }
    const capsuleText = String(source.capsuleText || '').trim();
    if (!capsuleText) {
        return null;
    }
    return {
        anchorHash: String(source.anchorHash || '').trim(),
        capsuleText,
        stageOutputs: Array.isArray(source.stageOutputs) ? structuredClone(source.stageOutputs) : [],
    };
}

/**
 * Decide whether a stored snapshot is still safe to reuse for the current
 * chat array: the playable ordinal must still point at a user message,
 * and that message's content hash must match the stored hash.
 *
 * @param {number} anchorPlayableFloor
 * @param {*} snapshot
 * @param {Array} messages
 * @returns {boolean}
 */
export function isStoredOrchestrationSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages) {
    const normalizedSnapshot = normalizeOrchestrationSnapshot(snapshot);
    if (!normalizedSnapshot) {
        return false;
    }
    return isPlayableAnchorHashValid(messages, anchorPlayableFloor, normalizedSnapshot.anchorHash);
}

/**
 * Strip stage outputs down to the fields callers actually consume. The
 * runtime trace carries diagnostics we don't want to persist (preview
 * text, replay results, attempt timing) — only `id`, `mode`, and per-node
 * `{node, output}` survive.
 *
 * @param {object[]} stageOutputs
 * @returns {object[]}
 */
export function compactStageOutputs(stageOutputs) {
    return (Array.isArray(stageOutputs) ? stageOutputs : []).map(stage => ({
        id: stage.id,
        mode: stage.mode,
        nodes: (Array.isArray(stage.nodes) ? stage.nodes : []).map(node => ({
            node: node.node,
            output: node.output,
        })),
    }));
}

/**
 * Deep-clone a node output for snapshot storage. Strings pass through
 * (they are immutable); objects are structured-cloned so future runtime
 * mutations don't bleed into the persisted snapshot.
 *
 * @param {*} output
 * @returns {*}
 */
export function normalizeNodeOutputForSnapshot(output) {
    if (typeof output === 'string') {
        return output;
    }
    if (output && typeof output === 'object') {
        return structuredClone(output);
    }
    return output;
}
