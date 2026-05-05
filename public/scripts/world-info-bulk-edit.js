/**
 * Pure helpers for the world-book bulk field-edit feature.
 *
 * Intentionally has zero dependencies on DOM, jQuery, or the rest of
 * world-info.js to keep it cheap to unit-test and to avoid circular
 * imports. Higher-level orchestration (Popups, toasts, save) lives in
 * world-info.js and consumes these helpers.
 */

/**
 * Sentinel used by the matched-fields tri-state UI to mark a field as
 * "leave alone". Patch builders strip any property whose value is this
 * sentinel before passing the patch to applyPatchToEntries.
 */
export const BULK_PATCH_KEEP_SENTINEL = Symbol('bulk-patch-keep');

/**
 * @param {Record<string, object>} entriesByUid  data.entries
 * @param {Array<string|number>} uids            selected uids
 * @param {string} fieldKey                       entry property name
 * @returns {{ kind: 'common', value: any } | { kind: 'mixed' }}
 */
export function inferCommonValue(entriesByUid, uids, fieldKey) {
    if (!entriesByUid || typeof entriesByUid !== 'object' || !Array.isArray(uids) || uids.length === 0) {
        return { kind: 'mixed' };
    }

    let firstSeen = false;
    let firstValue;

    for (const uid of uids) {
        const key = String(uid ?? '').trim();
        if (!key || !Object.hasOwn(entriesByUid, key)) {
            return { kind: 'mixed' };
        }
        const entry = entriesByUid[key];
        if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, fieldKey)) {
            return { kind: 'mixed' };
        }
        const value = entry[fieldKey];
        if (!firstSeen) {
            firstSeen = true;
            firstValue = value;
            continue;
        }
        if (!sameValue(firstValue, value)) {
            return { kind: 'mixed' };
        }
    }

    return firstSeen ? { kind: 'common', value: firstValue } : { kind: 'mixed' };
}

// Compares scalars (via Object.is) and arrays element-wise. Plain objects
// are intentionally treated as never-equal — the bulk-editable fields are
// all scalars or arrays today; revisit if an object-valued field is added.
function sameValue(a, b) {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!sameValue(a[i], b[i])) return false;
        }
        return true;
    }
    return false;
}
