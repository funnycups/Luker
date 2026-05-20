/**
 * `list_insert` op — inserts a value into an array at a specified position.
 *
 * Edit shape: { op: 'list_insert', path: string, anchor: AnchorSpec, value: any }
 * AnchorSpec: one of:
 *   { before_index: number }   insert at index (existing element at that index shifts right)
 *   { after_index: number }    insert at index+1 (or end if last)
 *   { after_value: any }       insert after the unique element equal to this value
 *
 * - apply: resolve anchor → insert index; splice in value; mutate `edit._inserted_at`
 *   for the inverse to know which index to remove (mutation acceptable per engine
 *   semantics — see ops/str-delete.js for same pattern)
 * - inverse: { op: 'list_remove', path, index: _inserted_at, expected_value: value }
 * - detectConflict:
 *     - value_drifted if path is not an array
 *     - anchor_missing if after_value not in array
 *     - anchor_ambiguous if after_value appears multiple times
 */
function resolveInsertIndex(arr, anchor, deps) {
    if (anchor.before_index !== undefined) {
        return Math.max(0, Math.min(arr.length, anchor.before_index));
    }
    if (anchor.after_index !== undefined) {
        return Math.max(0, Math.min(arr.length, anchor.after_index + 1));
    }
    if (anchor.after_value !== undefined) {
        const matches = [];
        for (let i = 0; i < arr.length; i += 1) {
            if (deps.isEqual(arr[i], anchor.after_value)) {
                matches.push(i);
            }
        }
        if (matches.length === 1) {
            return matches[0] + 1;
        }
        return null;     // signals "cannot resolve"
    }
    return null;
}

export function createListInsertOp() {
    return {
        apply(deps, edit, live) {
            const arr = deps.get(live, edit.path);
            const idx = resolveInsertIndex(arr, edit.anchor, deps);
            const next = [...arr];
            next.splice(idx, 0, edit.value);
            deps.set(live, edit.path, next);
            edit._inserted_at = idx;
            return live;
        },

        inverse(edit) {
            return {
                op: 'list_remove',
                path: edit.path,
                index: edit._inserted_at,
                expected_value: edit.value,
            };
        },

        detectConflict(deps, edit, live) {
            const arr = deps.get(live, edit.path);
            if (!Array.isArray(arr)) {
                return { reason: 'value_drifted', baseline: 'array', current: arr };
            }
            const anchor = edit.anchor || {};
            if (anchor.after_value !== undefined) {
                const matches = arr.filter(item => deps.isEqual(item, anchor.after_value));
                if (matches.length === 0) {
                    return { reason: 'anchor_missing', baseline: anchor.after_value, current: 0 };
                }
                if (matches.length > 1) {
                    return { reason: 'anchor_ambiguous', baseline: 1, current: matches.length };
                }
            }
            // index-based anchors clamp gracefully, no conflict
            return null;
        },
    };
}
