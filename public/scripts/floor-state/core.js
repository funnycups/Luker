/**
 * Floor State — pure algorithm layer.
 *
 * This module contains only side-effect-free helpers: log normalization,
 * commit validation, swipe map construction, target state computation.
 *
 * Each FloorState instance owns one chat-state namespace and its private
 * commit log. The instance layer (floor-state.js) wires these helpers to
 * the runtime: chat array, eventSource, getChatState/patchChatState/
 * updateChatState.
 *
 * Concepts:
 *  - floor: chat array index (0-based) where the commit was created.
 *  - swipeId: which swipe of that floor's message the commit belongs to.
 *  - patches: RFC 6902 operations applied to the namespace state.
 *  - swipeMap: object {floor: activeSwipeId} derived from the live chat
 *    array; used to filter commits whose swipe is no longer active.
 */

import { applyPatch } from '../util/fast-json-patch.js';

export const LOG_VERSION = 1;

/**
 * Decide whether a commit object is structurally valid.
 *
 * @param {*} commit
 * @returns {boolean}
 */
export function isValidCommit(commit) {
    if (!commit || typeof commit !== 'object') return false;
    if (!Number.isInteger(commit.floor) || commit.floor < 0) return false;
    if (!Number.isInteger(commit.swipeId) || commit.swipeId < 0) return false;
    if (!Array.isArray(commit.patches) || commit.patches.length === 0) return false;
    return true;
}

/**
 * Normalize a raw log object read from chat state into the canonical
 * {version, commits[]} shape. Filters out malformed commits.
 *
 * @param {*} raw
 * @returns {{ version: number, commits: object[] }}
 */
export function normalizeLog(raw) {
    if (!raw || typeof raw !== 'object') {
        return { version: LOG_VERSION, commits: [] };
    }
    const commits = Array.isArray(raw.commits)
        ? raw.commits.filter(isValidCommit)
        : [];
    return { version: LOG_VERSION, commits };
}

/**
 * Build {floor: activeSwipeId} map from the live chat array.
 *
 * @param {Array} chat
 * @returns {Object<number, number>}
 */
export function buildSwipeMapFromChat(chat) {
    const map = Object.create(null);
    if (!Array.isArray(chat)) return map;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message || typeof message !== 'object') {
            map[i] = 0;
            continue;
        }
        const raw = message.swipe_id;
        map[i] = Number.isInteger(raw) && raw >= 0 ? raw : 0;
    }
    return map;
}

/**
 * Decide whether a commit should be replayed given the current swipeMap.
 * A commit survives only when its (floor, swipeId) still corresponds to
 * the currently active swipe on that floor.
 *
 * @param {object} commit
 * @param {Object<number, number>} swipeMap
 * @returns {boolean}
 */
export function shouldKeepCommit(commit, swipeMap) {
    const activeSwipe = swipeMap[commit.floor];
    if (!Number.isInteger(activeSwipe)) return false;
    return commit.swipeId === activeSwipe;
}

/**
 * Replay all valid commits sequentially against an empty object to compute
 * the target state for a single namespace.
 *
 * @param {object[]} commits
 * @param {Object<number, number>} swipeMap
 * @returns {object} target state
 */
export function computeTargetState(commits, swipeMap) {
    const state = {};
    for (const commit of commits) {
        if (!shouldKeepCommit(commit, swipeMap)) continue;
        applyPatch(state, commit.patches, false, true);
    }
    return state;
}

/**
 * Truncate commits whose floor is at or beyond the new chat length.
 * Used when MESSAGE_DELETED reduces chat length to N.
 *
 * @param {object[]} commits
 * @param {number} newChatLength
 * @returns {object[]} surviving commits
 */
export function truncateCommits(commits, newChatLength) {
    if (!Number.isInteger(newChatLength) || newChatLength < 0) return commits.slice();
    return commits.filter((c) => c.floor < newChatLength);
}

/**
 * Drop all commits on a given floor whose swipeId equals the deleted one,
 * and decrement swipeId for commits whose swipeId is greater than the
 * deleted one. Used when MESSAGE_SWIPE_DELETED removes a swipe.
 *
 * @param {object[]} commits
 * @param {number} floor
 * @param {number} deletedSwipeId
 * @returns {object[]}
 */
export function removeSwipeFromCommits(commits, floor, deletedSwipeId) {
    if (!Number.isInteger(floor) || !Number.isInteger(deletedSwipeId)) return commits.slice();
    const out = [];
    for (const c of commits) {
        if (c.floor !== floor) {
            out.push(c);
            continue;
        }
        if (c.swipeId === deletedSwipeId) continue;
        if (c.swipeId > deletedSwipeId) {
            out.push({ ...c, swipeId: c.swipeId - 1 });
        } else {
            out.push(c);
        }
    }
    return out;
}

/**
 * Infer (floor, swipeId) for a new commit from the live chat array.
 * The newest message is the target unless explicit values are provided.
 *
 * @param {Array} chat
 * @returns {{floor: number, swipeId: number} | null}
 */
export function inferCommitTargetFromChat(chat) {
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const floor = chat.length - 1;
    const message = chat[floor];
    const raw = message?.swipe_id;
    const swipeId = Number.isInteger(raw) && raw >= 0 ? raw : 0;
    return { floor, swipeId };
}

/**
 * Resolve a commit target, preferring an explicit override over chat-tail
 * inference. The override may pin only `floor` (the swipeId is then read
 * from `chat[floor].swipe_id`, defaulting to 0) or both `floor` and
 * `swipeId`. The override `floor` must be a valid index into `chat` —
 * anything else returns `null` so the caller can flag a misuse.
 *
 * Used by plugins that attach state to a non-tail floor (e.g. memory
 * extensions tagging an older message). Returning the tail by default
 * keeps the existing `fs.patch(ops)` callsites working unchanged.
 *
 * @param {Array} chat
 * @param {{floor?: number, swipeId?: number} | null | undefined} override
 * @returns {{floor: number, swipeId: number} | null}
 */
export function resolveCommitTarget(chat, override) {
    if (override === null || override === undefined) {
        return inferCommitTargetFromChat(chat);
    }
    if (typeof override !== 'object') return null;
    if (override.floor === undefined || override.floor === null) {
        // No explicit floor → fall back to inference even if other fields
        // were passed; a swipeId without a floor has no anchor.
        return inferCommitTargetFromChat(chat);
    }
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const floor = Number(override.floor);
    if (!Number.isInteger(floor) || floor < 0 || floor >= chat.length) return null;
    let swipeId;
    if (override.swipeId !== undefined && override.swipeId !== null) {
        swipeId = Number(override.swipeId);
        if (!Number.isInteger(swipeId) || swipeId < 0) return null;
    } else {
        const raw = chat[floor]?.swipe_id;
        swipeId = Number.isInteger(raw) && raw >= 0 ? raw : 0;
    }
    return { floor, swipeId };
}
