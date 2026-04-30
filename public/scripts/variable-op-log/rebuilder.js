/**
 * @file Variable state rebuilder
 *
 * When the chat structure changes (delete, swipe switch, swipe delete, chat
 * change), the cached `chat_metadata.variables` may no longer reflect the
 * truth implied by the surviving `var_ops` log. `rebuildVariables` walks
 * every message's var_ops in order and updates the cache so:
 *
 *   • Keys touched by some surviving op land at their replayed value.
 *   • Keys *not* touched by any surviving op are left exactly as they were.
 *
 * The "leave untouched" half is the whole point — chat_metadata.variables
 * also holds values written by world-info side effects, slash commands,
 * QR scripts, third-party extensions, and legacy pre-Luker chats. Wiping
 * them on every rebuild would shred data we don't own.
 *
 * The tracked-key set is computed *fresh* every call from the surviving
 * ops; nothing is persisted. This means a key written by AI in some
 * since-deleted message naturally exits our scope on rebuild — control
 * returns to whatever else (WI, scripts) was managing it.
 */

import { applyOp } from './apply.js';

/**
 * @typedef {import('./apply.js').VarOp} VarOp
 */

/**
 * @typedef {{ extra?: { var_ops?: VarOp[] } }} ChatMessage
 */

/**
 * @typedef {Object} RebuildStats
 * @property {number} touchedMessages - Messages contributing at least one op
 * @property {number} totalOps - Total ops applied
 * @property {number} trackedKeys - Distinct keys appearing in surviving ops
 */

/**
 * Rebuild `state` from `chat`, only mutating keys that appear in surviving
 * `var_ops`. Returns rebuild stats for diagnostics.
 *
 * @param {ChatMessage[]} chat - Array of chat messages (e.g. ST's `chat`)
 * @param {Record<string, any>} state - The variables cache to update in place
 * @returns {RebuildStats}
 */
export function rebuildVariables(chat, state) {
    if (!Array.isArray(chat) || !state || typeof state !== 'object') {
        return { touchedMessages: 0, totalOps: 0, trackedKeys: 0 };
    }

    const replayed = {};
    const trackedKeys = new Set();
    let touchedMessages = 0;
    let totalOps = 0;

    for (const msg of chat) {
        const ops = msg?.extra?.var_ops;
        if (!Array.isArray(ops) || ops.length === 0) continue;
        touchedMessages++;
        for (const op of ops) {
            if (!op || typeof op.key !== 'string' || !op.key) continue;
            trackedKeys.add(op.key);
            applyOp(replayed, op);
            totalOps++;
        }
    }

    for (const key of trackedKeys) {
        if (Object.prototype.hasOwnProperty.call(replayed, key)) {
            state[key] = replayed[key];
        } else {
            // Key only appears in deletevar ops — remove from state
            delete state[key];
        }
    }

    return {
        touchedMessages,
        totalOps,
        trackedKeys: trackedKeys.size,
    };
}

/**
 * Returns the set of keys currently managed by the op-log (i.e. mentioned
 * by at least one surviving op). Useful for the operation panel to filter
 * which variables it owns.
 *
 * @param {ChatMessage[]} chat
 * @returns {Set<string>}
 */
export function getTrackedKeys(chat) {
    const out = new Set();
    if (!Array.isArray(chat)) return out;
    for (const msg of chat) {
        const ops = msg?.extra?.var_ops;
        if (!Array.isArray(ops)) continue;
        for (const op of ops) {
            if (op && typeof op.key === 'string' && op.key) {
                out.add(op.key);
            }
        }
    }
    return out;
}

/**
 * Compute a fresh state object as if rebuilding from scratch — without
 * touching any caller state. Useful for the operation panel preview.
 *
 * @param {ChatMessage[]} chat
 * @returns {Record<string, any>}
 */
export function computeReplayedState(chat) {
    const state = {};
    if (!Array.isArray(chat)) return state;
    for (const msg of chat) {
        const ops = msg?.extra?.var_ops;
        if (!Array.isArray(ops)) continue;
        for (const op of ops) applyOp(state, op);
    }
    return state;
}
