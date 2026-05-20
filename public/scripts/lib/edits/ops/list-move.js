/**
 * `list_move` op — relocates an array element from one index to another.
 *
 * Edit shape: { op: 'list_move', path: string, from_index: number, to_index: number, expected_value?: any }
 *
 * - apply: splice from from_index, splice into to_index (accounting for shift)
 * - inverse: swap from_index and to_index
 * - detectConflict:
 *     - value_drifted if path is not an array
 *     - value_drifted if from_index out of bounds
 *     - value_drifted if expected_value at from_index doesn't match
 *     - already_done if from_index === to_index
 */
export function createListMoveOp() {
    return {
        apply(deps, edit, live) {
            const arr = deps.get(live, edit.path);
            const next = [...arr];
            const [moved] = next.splice(edit.from_index, 1);
            // Insert at to_index in the new array (splice already shifted).
            next.splice(edit.to_index, 0, moved);
            deps.set(live, edit.path, next);
            return live;
        },

        inverse(edit) {
            return {
                op: 'list_move',
                path: edit.path,
                from_index: edit.to_index,
                to_index: edit.from_index,
                expected_value: edit.expected_value,
            };
        },

        detectConflict(deps, edit, live) {
            const arr = deps.get(live, edit.path);
            if (!Array.isArray(arr)) {
                return { reason: 'value_drifted', baseline: 'array', current: arr };
            }
            if (edit.from_index === edit.to_index) {
                return { reason: 'already_done' };
            }
            if (edit.from_index < 0 || edit.from_index >= arr.length) {
                return {
                    reason: 'value_drifted',
                    baseline: `from < ${arr.length}`,
                    current: `from_index=${edit.from_index}`,
                };
            }
            if (edit.expected_value !== undefined &&
                !deps.isEqual(arr[edit.from_index], edit.expected_value)) {
                return {
                    reason: 'value_drifted',
                    baseline: edit.expected_value,
                    current: arr[edit.from_index],
                };
            }
            return null;
        },
    };
}
