/**
 * `set` op — replaces the value at a lodash path.
 *
 * Edit shape: { op: 'set', path: string, oldValue: any, newValue: any }
 *
 * - apply: lodash.set(live, path, newValue)
 * - inverse: { op: 'set', path, oldValue: newValue, newValue: oldValue }
 * - detectConflict:
 *     - current === newValue (deep) → already_done
 *     - current !== oldValue (deep) AND current !== newValue → value_drifted
 *     - else → null (clean apply)
 */
export function createSetOp() {
    return {
        apply(deps, edit, live) {
            deps.set(live, edit.path, edit.newValue);
            return live;
        },

        inverse(edit) {
            return {
                op: 'set',
                path: edit.path,
                oldValue: edit.newValue,
                newValue: edit.oldValue,
            };
        },

        detectConflict(deps, edit, live) {
            const current = deps.get(live, edit.path);
            if (deps.isEqual(current, edit.newValue)) {
                return { reason: 'already_done' };
            }
            if (!deps.isEqual(current, edit.oldValue)) {
                return {
                    reason: 'value_drifted',
                    baseline: edit.oldValue,
                    current,
                };
            }
            return null;
        },
    };
}
