// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Encoding used by the ghost `<option value>` in #settings_preset_openai,
 * and reused by st-context.js getSelected() to reverse the decode.
 *
 * The prefix `__luker_card__::` is a DOM-visible sentinel that flags the
 * option as pointing to a character-bound preset rather than the global
 * preset library. The tail encodes `<avatar>::<name>` with
 * encodeURIComponent so that `::` occurring inside a preset name (or an
 * avatar filename) survives round-trip through decode.
 *
 * NOTE: this prefix is intentionally distinct from the server-side state
 * key prefix `__lc__::` used by composeStateTarget in st-context.js — they
 * live at different layers with different escaping needs.
 */

export const CARD_BOUND_OPTION_PREFIX = '__luker_card__::';

export function encodeCardBoundOptionValue(avatar, name) {
    return CARD_BOUND_OPTION_PREFIX + encodeURIComponent(avatar) + '::' + encodeURIComponent(name);
}

export function decodeCardBoundOptionValue(value) {
    if (typeof value !== 'string' || !value.startsWith(CARD_BOUND_OPTION_PREFIX)) return null;
    const tail = value.slice(CARD_BOUND_OPTION_PREFIX.length);
    const parts = tail.split('::');
    if (parts.length !== 2) return null;
    try {
        return { avatar: decodeURIComponent(parts[0]), name: decodeURIComponent(parts[1]) };
    } catch {
        return null;
    }
}
