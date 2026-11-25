// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Playable-floor anchor primitives shared by plugins that bind a stored
 * result to the last user turn (orchestrator snapshots, search-tools
 * snapshots).
 *
 * A playable floor is the 1-based ordinal of a message among non-system
 * messages. The anchor hash is the stringified cyrb53 of the message
 * text. Each plugin wraps `computeLastUserAnchorCore` into its own
 * persisted anchor shape.
 */

import { getStringHash } from './string-hash.js';

export function normalizeAnchorPlayableFloor(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}

/**
 * @param {Array} messages
 * @param {number} playableFloor
 * @returns {{ index: number, message: object } | null}
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
 * @param {Array} messages
 * @returns {{ index: number, message: object | null }}
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

export function hashAnchorText(text) {
    return String(getStringHash(String(text ?? '')));
}

/**
 * @param {Array} messages
 * @returns {{ index: number, message: object, playableFloor: number, hash: string } | null}
 */
export function computeLastUserAnchorCore(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const { index, message } = extractLastUserMessage(source);
    if (index < 0 || !message) {
        return null;
    }
    let playableFloor = 0;
    for (let i = 0; i <= index; i += 1) {
        if (source[i] && !source[i].is_system) {
            playableFloor += 1;
        }
    }
    return { index, message, playableFloor, hash: hashAnchorText(message.mes) };
}

/**
 * True when the message at `playableFloor` is still a user turn whose
 * text hashes to `anchorHash` (trimmed, non-empty).
 */
export function isPlayableAnchorHashValid(messages, playableFloor, anchorHash) {
    const target = getPlayableMessageAt(messages, playableFloor);
    if (!target?.message || target.message.is_system || !target.message.is_user) {
        return false;
    }
    const stored = String(anchorHash || '').trim();
    if (!stored) {
        return false;
    }
    return hashAnchorText(target.message.mes) === stored;
}
