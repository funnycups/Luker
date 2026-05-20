/**
 * `unset` op — removes the key at a lodash path entirely.
 *
 * Edit shape: { op: 'unset', path: string, expected_value?: any }
 *
 * Distinct from `set(path, undefined)`: lodash.unset removes the key
 * (so `Object.hasOwn` returns false) while `set(path, undefined)` leaves
 * the key in place with an undefined value.
 *
 * - apply: lodash.unset(live, path)
 * - inverse: { op: 'set', path, oldValue: undefined, newValue: expected_value }
 *     — relies on expected_value being present to know what to restore.
 *     If absent, rollback simply re-creates the path as undefined.
 * - detectConflict:
 *     - path already absent → already_done
 *     - expected_value provided and current deep-unequal → value_drifted
 *     - else → null
 */
export function createUnsetOp() {
    return {
        apply(deps, edit, live) {
            deps.unset(live, edit.path);
            return live;
        },

        inverse(edit) {
            return {
                op: 'set',
                path: edit.path,
                oldValue: undefined,
                newValue: edit.expected_value,
            };
        },

        detectConflict(deps, edit, live) {
            const current = deps.get(live, edit.path);
            const hasPath = current !== undefined ||
                (typeof live === 'object' && live !== null && pathExists(live, edit.path));

            if (!hasPath) {
                return { reason: 'already_done' };
            }
            if (edit.expected_value !== undefined && !deps.isEqual(current, edit.expected_value)) {
                return {
                    reason: 'value_drifted',
                    baseline: edit.expected_value,
                    current,
                };
            }
            return null;
        },
    };
}

// pathExists: a lodash.has equivalent that doesn't require us to pass `has`
// through deps (kept minimal). Returns true iff the path resolves to a key
// that exists, even if the value is undefined.
function pathExists(obj, path) {
    const segments = String(path).match(/[^.[\]]+/g) || [];
    let cursor = obj;
    for (const seg of segments) {
        if (cursor == null || typeof cursor !== 'object') return false;
        if (!Object.hasOwn(cursor, seg)) return false;
        cursor = cursor[seg];
    }
    return true;
}
