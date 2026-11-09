// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure rules for in-place editing of stored memories (no DOM).
// Values are edited as plain text; arrays round-trip through the list separator so a
// field stored as a list stays a list.

import { i18n, listSeparator } from '../i18n.js';

const LIST_SPLIT = /[、,，\n]+/;

/**
 * Whether a field of a node may be edited here, with a Chinese reason if not.
 * @param {object} node model node (from buildModel)
 * @param {string} key field key, or '' for the title
 */
export function editRule(node, key) {
    if (!node) return { ok: false, reason: i18n('This memory could not be found') };
    if (node.isRollup) return { ok: false, reason: i18n('This summary was merged automatically and is regenerated at the next merge, so it cannot be changed here') };
    if (node.archived) return { ok: false, reason: i18n('Archived memories cannot be changed') };
    if (key === '' && node.type === 'event') return { ok: false, reason: i18n('Event titles are generated from the body; change the body instead') };
    return { ok: true, reason: '' };
}

/** Text shown in the editor for a stored value. */
export function toEditText(value) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.map(v => toEditText(v)).filter(Boolean).join(listSeparator());
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return ''; }
    }
    return String(value);
}

/**
 * Converts edited text back to the stored shape of `original`.
 * Lists stay lists, numbers stay numbers when the text is numeric.
 */
export function fromEditText(text, original) {
    const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (Array.isArray(original)) return value ? value.split(LIST_SPLIT).map(s => s.trim()).filter(Boolean) : [];
    if (typeof original === 'number') {
        const n = Number(value);
        return value !== '' && Number.isFinite(n) ? n : value;
    }
    if (original && typeof original === 'object') {
        try { return JSON.parse(value); } catch { return value; }
    }
    return value;
}

/** True when the edited text would store something different. */
export function isChanged(text, original) {
    return JSON.stringify(fromEditText(text, original)) !== JSON.stringify(original ?? (Array.isArray(original) ? [] : ''))
        && !(toEditText(original) === String(text ?? '').trim());
}

/** Text that already has paragraphs (event bodies, multi-line notes): Enter adds a line. */
export function hasParagraphs(key, text) {
    return key === 'summary' || String(text ?? '').includes('\n');
}
