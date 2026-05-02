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
 * `persistence.js` and `main.js`.
 */

/**
 * Inline copy of `utils.getStringHash` (the cyrb53 variant). Inlined
 * to keep this module loadable from tests — the canonical helper lives
 * in `public/scripts/utils.js`, which transitively pulls in the full
 * app bundle and cannot be imported by a Node-based test runner. The
 * algorithm is fixed; if `utils.getStringHash` ever changes, this copy
 * must be updated in lockstep.
 */
function hashStringForAnchor(str, seed = 0) {
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
 * Coerce a value to a positive integer playable floor. Returns 0 for any
 * non-positive / non-integer / negative value so callers can treat 0 as
 * "no anchor".
 *
 * @param {*} value
 * @returns {number}
 */
export function normalizeAnchorPlayableFloor(value) {
    const normalized = Math.max(0, Math.floor(Number(value) || 0));
    return normalized > 0 ? normalized : 0;
}

/**
 * Find the last user message in the chat. Returns
 * `{ index: -1, message: null }` when the chat has no user message yet
 * (or when the input is not an array) so callers can branch without
 * optional chaining.
 *
 * @param {Array} messages
 * @returns {{ index: number, message: object | null }}
 */
export function extractLastUserMessage(messages) {
    if (!Array.isArray(messages)) {
        return { index: -1, message: null };
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.is_user) {
            return { index: i, message: messages[i] };
        }
    }
    return { index: -1, message: null };
}

/**
 * Hash source for the user message at `endIndex`. Centralized so the
 * commit-time hash and the consume-time hash stay in lockstep.
 *
 * @param {Array} messages
 * @param {number} endIndex
 * @returns {string}
 */
export function buildAnchorHashSource(messages, endIndex) {
    const message = messages[endIndex];
    return String(message?.mes ?? '');
}

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
    const { index, message } = extractLastUserMessage(messages);
    if (index < 0 || !message) {
        return null;
    }
    const hashSource = buildAnchorHashSource(messages, index);
    const playableFloor = messages
        .slice(0, index + 1)
        .reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0);
    const swipeIdRaw = message.swipe_id;
    const swipeId = Number.isInteger(swipeIdRaw) && swipeIdRaw >= 0 ? swipeIdRaw : 0;
    return {
        chatIndex: index,
        playableFloor,
        swipeId,
        hash: String(hashStringForAnchor(hashSource)),
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
 * Locate the chat message at the given playable ordinal. Used to verify
 * that a stored snapshot's anchor still points at a user message before
 * trusting its `anchorHash`.
 *
 * @param {Array} messages
 * @param {number} playableFloor
 * @returns {{ index: number, message: object } | null}
 */
export function getPlayableMessageAt(messages, playableFloor) {
    const source = Array.isArray(messages) ? messages : [];
    const targetPlayableFloor = normalizeAnchorPlayableFloor(playableFloor);
    if (!targetPlayableFloor) {
        return null;
    }
    let playableSeq = 0;
    for (let index = 0; index < source.length; index++) {
        const message = source[index];
        if (!message || message.is_system) {
            continue;
        }
        playableSeq += 1;
        if (playableSeq === targetPlayableFloor) {
            return { index, message };
        }
    }
    return null;
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
    const target = getPlayableMessageAt(messages, anchorPlayableFloor);
    if (!target?.message || target.message.is_system || !target.message.is_user) {
        return false;
    }
    const storedHash = String(normalizedSnapshot.anchorHash || '').trim();
    if (!storedHash) {
        return false;
    }
    const currentHash = String(hashStringForAnchor(buildAnchorHashSource(messages, target.index)));
    return currentHash === storedHash;
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
