/**
 * `list_remove` op — splices an array element out at a given index.
 *
 * Edit shape: { op: 'list_remove', path: string, index: number, expected_value?: any }
 *
 * - apply: capture removed value as edit._removed for inverse; splice out
 * - inverse: { op: 'list_insert', path, anchor: { before_index: <removed index> }, value: <removed> }
 * - detectConflict:
 *     - value_drifted if path is not an array
 *     - value_drifted if index out of bounds
 *     - value_drifted if expected_value provided and current at index doesn't match
 */
export function createListRemoveOp() {
    return {
        apply(deps, edit, live) {
            const arr = deps.get(live, edit.path);
            const next = [...arr];
            const [removed] = next.splice(edit.index, 1);
            deps.set(live, edit.path, next);
            edit._removed = removed;
            edit._removed_at = edit.index;
            return live;
        },

        inverse(edit) {
            return {
                op: 'list_insert',
                path: edit.path,
                anchor: { before_index: edit._removed_at },
                value: edit._removed !== undefined ? edit._removed : edit.expected_value,
            };
        },

        detectConflict(deps, edit, live) {
            const arr = deps.get(live, edit.path);
            if (!Array.isArray(arr)) {
                return { reason: 'value_drifted', baseline: 'array', current: arr };
            }
            if (edit.index < 0 || edit.index >= arr.length) {
                return {
                    reason: 'value_drifted',
                    baseline: `index < ${arr.length}`,
                    current: `index=${edit.index}`,
                };
            }
            if (edit.expected_value !== undefined &&
                !deps.isEqual(arr[edit.index], edit.expected_value)) {
                return {
                    reason: 'value_drifted',
                    baseline: edit.expected_value,
                    current: arr[edit.index],
                };
            }
            return null;
        },
    };
}
