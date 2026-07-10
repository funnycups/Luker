// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Pure origin-dispatch helpers for saveOpenAIPreset.
//
// Extracted from openai.js to make the dispatch decision unit-testable
// without importing openai.js (10k lines, jQuery-global, script.js-coupled;
// see tests/character-presets/main-chat-selector.test.js:5-13 for the same
// finding). The e2e spec covers the wired-up flow through real openai.js.
//
// Contract (task-4-brief §7):
//   - readSelectedPresetRef({selectValue, fallbackName}) inspects the raw
//     value from the settings preset <select> element. If it decodes as a
//     ghost card-bound option, returns {name, origin:{kind:'character',
//     avatar}}. Otherwise returns {name: fallbackName || raw,
//     origin:{kind:'global'}}. A malformed sentinel is not a usable global
//     name — we always prefer fallbackName in that case.
//   - decideSavePresetDispatch(currentRef, requestedName) returns
//     {mode:'character', avatar, name} only when the DOM selection is
//     card-bound AND requestedName === currentRef.name. Any other case
//     (global selection, name mismatch, missing avatar, null ref) returns
//     {mode:'global'}.
//
// A name mismatch under a card-bound selection means the user opened the
// "New Preset" dialog while a card-bound entry was active — the intent is
// to create a new GLOBAL preset, not to overwrite the card slot.

import { decodeCardBoundOptionValue } from './preset-ref-codec.js';

/**
 * @typedef {{kind: 'global'} | {kind: 'character', avatar: string}} PresetOrigin
 * @typedef {{name: string, origin: PresetOrigin}} PresetRef
 */

/**
 * @param {{selectValue: string | null | undefined, fallbackName: string | null | undefined}} args
 * @returns {PresetRef}
 */
export function readSelectedPresetRef({ selectValue, fallbackName } = {}) {
    const raw = typeof selectValue === 'string' ? selectValue.trim() : '';
    const fallback = typeof fallbackName === 'string' ? fallbackName.trim() : '';
    const decoded = decodeCardBoundOptionValue(raw);
    if (decoded) {
        return {
            name: decoded.name,
            origin: { kind: 'character', avatar: decoded.avatar },
        };
    }
    // Global path. A raw value that starts with the sentinel but failed to
    // decode is malformed and never a valid global preset name — prefer
    // the fallback to avoid surfacing sentinel text as a preset name.
    const isMalformedSentinel = raw.startsWith('__luker_card__::');
    const globalName = isMalformedSentinel ? fallback : (fallback || raw);
    return { name: globalName, origin: { kind: 'global' } };
}

/**
 * @param {PresetRef | null | undefined} currentRef
 * @param {string} requestedName
 * @returns {{mode: 'character', avatar: string, name: string} | {mode: 'global'}}
 */
export function decideSavePresetDispatch(currentRef, requestedName) {
    if (!currentRef || currentRef.origin?.kind !== 'character') {
        return { mode: 'global' };
    }
    const avatar = String(currentRef.origin.avatar || '').trim();
    if (!avatar) {
        return { mode: 'global' };
    }
    if (String(currentRef.name || '') !== String(requestedName || '')) {
        return { mode: 'global' };
    }
    return { mode: 'character', avatar, name: String(requestedName) };
}
