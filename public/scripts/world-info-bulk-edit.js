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

/**
 * Inspect entries against a patch and build a minimal change record.
 *
 * @param {Record<string, object>} entriesByUid  data.entries
 * @param {Array<string|number>} uids            candidate uids
 * @param {Record<string, any>} patch            { fieldKey: newValue, ... }; values equal to BULK_PATCH_KEEP_SENTINEL are stripped
 * @returns {{ changedUids: string[], snapshot: Array<{ uid: string, oldValues: Record<string, any> }> }}
 */
export function buildBulkFieldPatchSnapshot(entriesByUid, uids, patch) {
    const cleanPatch = stripKeepSentinel(patch);
    const patchKeys = Object.keys(cleanPatch);

    if (!entriesByUid || typeof entriesByUid !== 'object'
        || !Array.isArray(uids) || patchKeys.length === 0) {
        return { changedUids: [], snapshot: [] };
    }

    const changedUids = [];
    const snapshot = [];

    for (const rawUid of uids) {
        const uid = String(rawUid ?? '').trim();
        if (!uid || !Object.hasOwn(entriesByUid, uid)) continue;
        const entry = entriesByUid[uid];
        if (!entry || typeof entry !== 'object') continue;

        const oldValues = {};
        let dirty = false;

        for (const key of patchKeys) {
            const oldValue = Object.hasOwn(entry, key) ? entry[key] : undefined;
            if (!sameValue(oldValue, cleanPatch[key])) {
                oldValues[key] = oldValue;
                dirty = true;
            }
        }

        if (dirty) {
            changedUids.push(uid);
            snapshot.push({ uid, oldValues });
        }
    }

    return { changedUids, snapshot };
}

/**
 * Apply patch fields to the given uids in-place. No-op for unknown uids.
 *
 * @param {Record<string, object>} entriesByUid
 * @param {Array<string>} changedUids
 * @param {Record<string, any>} patch
 */
export function applyPatchToEntries(entriesByUid, changedUids, patch) {
    if (!entriesByUid || typeof entriesByUid !== 'object' || !Array.isArray(changedUids)) return;
    const cleanPatch = stripKeepSentinel(patch);

    for (const uid of changedUids) {
        const key = String(uid ?? '').trim();
        if (!key || !Object.hasOwn(entriesByUid, key)) continue;
        const entry = entriesByUid[key];
        if (!entry || typeof entry !== 'object') continue;
        for (const [fieldKey, value] of Object.entries(cleanPatch)) {
            entry[fieldKey] = value;
        }
    }
}

/**
 * Reverse a snapshot produced by buildBulkFieldPatchSnapshot.
 * If oldValues[fieldKey] is undefined, the property is deleted from the entry.
 *
 * @param {Record<string, object>} entriesByUid
 * @param {Array<{ uid: string, oldValues: Record<string, any> }>} snapshot
 */
export function restoreEntriesFromSnapshot(entriesByUid, snapshot) {
    if (!entriesByUid || typeof entriesByUid !== 'object' || !Array.isArray(snapshot)) return;

    for (const record of snapshot) {
        const uid = String(record?.uid ?? '').trim();
        if (!uid || !Object.hasOwn(entriesByUid, uid)) continue;
        const entry = entriesByUid[uid];
        if (!entry || typeof entry !== 'object') continue;
        const oldValues = record?.oldValues || {};
        for (const [fieldKey, oldValue] of Object.entries(oldValues)) {
            if (oldValue === undefined) {
                delete entry[fieldKey];
            } else {
                entry[fieldKey] = oldValue;
            }
        }
    }
}

function stripKeepSentinel(patch) {
    const out = {};
    if (!patch || typeof patch !== 'object') return out;
    for (const [k, v] of Object.entries(patch)) {
        if (v === BULK_PATCH_KEEP_SENTINEL) continue;
        out[k] = v;
    }
    return out;
}
