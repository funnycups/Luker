/**
 * `str_insert` op — inserts text immediately after a unique anchor in a string.
 *
 * Edit shape: { op: 'str_insert', path: string, after_text: string, insert_text: string }
 *
 * - apply: find anchor (which must be unique), splice insert_text after it
 * - inverse: { op: 'str_delete', path, find: insert_text }
 * - detectConflict:
 *     - value_drifted if path holds non-string
 *     - anchor_missing if after_text count is 0
 *     - anchor_ambiguous if after_text count > 1
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    const re = new RegExp(escapeRegex(needle), 'g');
    return (haystack.match(re) || []).length;
}

export function createStrInsertOp() {
    return {
        apply(deps, edit, live) {
            const current = deps.get(live, edit.path);
            const idx = current.indexOf(edit.after_text);
            const insertAt = idx + edit.after_text.length;
            const next = current.slice(0, insertAt) + edit.insert_text + current.slice(insertAt);
            deps.set(live, edit.path, next);
            return live;
        },

        inverse(edit) {
            return {
                op: 'str_delete',
                path: edit.path,
                find: edit.insert_text,
            };
        },

        detectConflict(deps, edit, live) {
            const current = deps.get(live, edit.path);
            if (typeof current !== 'string') {
                return { reason: 'value_drifted', baseline: 'string', current };
            }
            const actual = countOccurrences(current, edit.after_text);
            if (actual === 0) {
                return { reason: 'anchor_missing', baseline: edit.after_text, current: 0 };
            }
            if (actual > 1) {
                return { reason: 'anchor_ambiguous', baseline: 1, current: actual };
            }
            return null;
        },
    };
}
