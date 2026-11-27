// SPDX-License-Identifier: AGPL-3.0-or-later

const LOOKUP_VARIATION_SELECTORS_RE = /[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]/gu;

/**
 * Normalizes a visible name for tolerant lookups.
 * Exact display strings are preserved elsewhere; this is only for comparisons.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeLookupText(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '';
    }

    return text.normalize('NFC').replace(LOOKUP_VARIATION_SELECTORS_RE, '');
}

/**
 * Compares two names using tolerant lookup normalization.
 * Prefers exact string equality before falling back to normalized comparison.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {boolean}
 */
export function areLookupNamesEqual(a, b, { caseInsensitive = false } = {}) {
    const left = String(a ?? '').trim();
    const right = String(b ?? '').trim();
    if (!left || !right) {
        return left === right;
    }
    if (left === right) {
        return true;
    }
    const normalizedLeft = normalizeLookupText(left);
    const normalizedRight = normalizeLookupText(right);
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    return caseInsensitive && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

/**
 * Finds the canonical name from a list for a given lookup target.
 * Matches in strictness order: exact trimmed equality, lookup-normalized
 * equality, and (when `caseInsensitive` is true) case-insensitive
 * lookup-normalized equality.
 *
 * @param {string[]} list
 * @param {string} name
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {string}
 */
export function findCanonicalNameInList(list, name, { caseInsensitive = false } = {}) {
    const requested = String(name ?? '').trim();
    if (!requested || !Array.isArray(list)) {
        return '';
    }

    const exactMatch = list.find(item => String(item ?? '').trim() === requested);
    if (exactMatch) {
        return exactMatch;
    }

    const normalizedMatch = list.find(item => areLookupNamesEqual(item, requested));
    if (normalizedMatch) {
        return normalizedMatch;
    }

    if (caseInsensitive) {
        return list.find(item => areLookupNamesEqual(item, requested, { caseInsensitive: true })) || '';
    }

    return '';
}

/**
 * Finds the canonical index from a list for a given lookup target.
 *
 * @param {string[]} list
 * @param {string} name
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {number}
 */
export function findCanonicalIndexInList(list, name, options = undefined) {
    const canonical = findCanonicalNameInList(list, name, options);
    return canonical ? list.indexOf(canonical) : -1;
}
