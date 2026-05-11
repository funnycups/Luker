/**
 * @file Pure floor-level op-log primitives.
 *
 * No globals, no DOM, no SillyTavern imports — works on any chat-shaped array
 * and any state object. Lets tests exercise the floor-binding pathway
 * without pulling in script.js. The runtime wrapper in `index.js` wires
 * these to the live `chat` / `chat_metadata.variables`.
 */

import { applyOp } from './apply.js';

/**
 * Mirror `message.mes` and `message.extra` into the active
 * `swipe_info[swipe_id]` slot so a change made to the live object survives
 * the next swipe-out. Idempotent — safe to call multiple times for the same
 * message and swipe.
 *
 * @param {any} message
 * @returns {void}
 */
export function mirrorMessageExtraToCurrentSwipe(message) {
    if (!message || typeof message.swipe_id !== 'number') return;
    if (!Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) return;
    if (message.swipe_id < 0 || message.swipe_id >= message.swipe_info.length) return;
    message.swipes[message.swipe_id] = message.mes;
    const slot = message.swipe_info[message.swipe_id];
    if (slot) {
        slot.extra = structuredClone(message.extra ?? {});
    }
}

/**
 * Append a synthetic op to a specific floor's `extra.var_ops`, forward-apply
 * it to `state`, and mirror to the floor's current swipe. The op is bound to
 * whatever swipe is currently active on that message — selecting a different
 * swipe restores that swipe's recorded `extra.var_ops` and the rebuilder
 * replays from there.
 *
 * Pure with respect to its inputs except for mutation of the chat message
 * and the `state` argument. Caller is responsible for chat persistence.
 *
 * @param {Array<any>} chat - Chat messages array
 * @param {Record<string, any>} state - Variables state to forward-apply onto
 *   (typically `chat_metadata.variables`)
 * @param {number} messageId - Floor index into `chat`
 * @param {import('./apply.js').VarOp} op - Op record (op/key/value)
 * @returns {void}
 * @throws if no message exists at that floor, or if `op` lacks a string key
 */
export function pushFloorVarOp(chat, state, messageId, op) {
    if (!Array.isArray(chat)) {
        throw new Error('[variable-op-log] pushFloorVarOp: chat must be an array');
    }
    const message = chat[messageId];
    if (!message) {
        throw new Error(`[variable-op-log] pushFloorVarOp: no message at floor ${messageId}`);
    }
    if (!op || typeof op !== 'object' || typeof op.key !== 'string' || !op.key) {
        throw new Error('[variable-op-log] pushFloorVarOp: op requires a non-empty string key');
    }
    if (!state || typeof state !== 'object') {
        throw new Error('[variable-op-log] pushFloorVarOp: state must be an object');
    }
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.var_ops)) {
        message.extra.var_ops = [];
    }
    message.extra.var_ops.push(op);
    applyOp(state, op);
    mirrorMessageExtraToCurrentSwipe(message);
}
