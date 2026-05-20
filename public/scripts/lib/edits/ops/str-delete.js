/**
 * `str_delete` op — removes a unique substring from a string-valued path.
 *
 * Edit shape (initial):  { op: 'str_delete', path: string, find: string }
 * Edit shape (after apply augments it): the same plus
 *   `_anchor_context`: { before: string, after: string }
 * to support precise re-insertion on inverse.
 *
 * - apply: locate `find` (must be unique), capture surrounding context for
 *   inverse, splice it out
 * - inverse: { op: 'str_insert', path, after_text: <context.before>, insert_text: find }
 * - detectConflict:
 *     - value_drifted if path is non-string
 *     - anchor_missing if find count 0
 *     - anchor_ambiguous if count > 1
 *
 * NOTE on mutation: `apply` writes `_anchor_context` directly onto the edit
 * object. The engine's `applyEdits` only `cloneDeep`s `live`, not `edits`,
 * so this mutation propagates to the caller's edit array. Callers should
 * read `result.clean` (the engine-tracked array of applied edits) for the
 * augmented edits and treat the input array as consumed.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    const re = new RegExp(escapeRegex(needle), 'g');
    return (haystack.match(re) || []).length;
}

// How many chars on each side to capture as the inverse anchor.
// 24 is long enough to disambiguate in typical text but short enough to
// stay searchable in the rolled-back live.
const ANCHOR_CONTEXT_LEN = 24;

export function createStrDeleteOp() {
    return {
        apply(deps, edit, live) {
            const current = deps.get(live, edit.path);
            const idx = current.indexOf(edit.find);
            const before = current.slice(Math.max(0, idx - ANCHOR_CONTEXT_LEN), idx);
            const after = current.slice(idx + edit.find.length,
                idx + edit.find.length + ANCHOR_CONTEXT_LEN);
            // Mutate the edit object in place so the engine's `clean` array
            // captures this for later inverse use. See file-level NOTE on
            // mutation; callers must treat the input edits array as consumed.
            edit._anchor_context = { before, after };
            const next = current.slice(0, idx) + current.slice(idx + edit.find.length);
            deps.set(live, edit.path, next);
            return live;
        },

        inverse(edit) {
            const before = edit._anchor_context && edit._anchor_context.before;
            if (typeof before !== 'string' || !before) {
                // No anchor context captured — fall back to re-inserting at start.
                // This is a degraded path; rollback may not be perfectly placed.
                return {
                    op: 'set',
                    path: edit.path,
                    oldValue: undefined,
                    newValue: edit.find,
                };
            }
            return {
                op: 'str_insert',
                path: edit.path,
                after_text: before,
                insert_text: edit.find,
            };
        },

        detectConflict(deps, edit, live) {
            const current = deps.get(live, edit.path);
            if (typeof current !== 'string') {
                return { reason: 'value_drifted', baseline: 'string', current };
            }
            const actual = countOccurrences(current, edit.find);
            if (actual === 0) {
                return { reason: 'anchor_missing', baseline: edit.find, current: 0 };
            }
            if (actual > 1) {
                return { reason: 'anchor_ambiguous', baseline: 1, current: actual };
            }
            return null;
        },
    };
}
