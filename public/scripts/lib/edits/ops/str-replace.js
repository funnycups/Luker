/**
 * `str_replace` op — find/replace inside a string-valued path.
 *
 * Edit shape: { op: 'str_replace', path: string, find: string, replace: string, expected_count?: number }
 *
 * The intent of `expected_count` is to enforce `find`'s multiplicity in
 * the source — if the AI says "replace the one occurrence of X" it should
 * set expected_count = 1, and if external drift adds another X, that's
 * caught as a conflict instead of a silent over-replace.
 *
 * When matched (or expected_count omitted AND count === 1), ALL matching
 * occurrences are replaced. (This pairs with the AI tool's understanding
 * that "replace this unique anchor" is the dominant use case.)
 *
 * - apply: validate string; count matches; replace all if count == expected (default 1)
 * - inverse: swap find and replace (relies on result being uniquely findable)
 * - detectConflict:
 *     - value_drifted when path holds non-string
 *     - anchor_missing when find count is 0
 *     - anchor_ambiguous when count differs from expected_count (default 1)
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    const re = new RegExp(escapeRegex(needle), 'g');
    return (haystack.match(re) || []).length;
}

export function createStrReplaceOp() {
    return {
        apply(deps, edit, live) {
            const current = deps.get(live, edit.path);
            const re = new RegExp(escapeRegex(edit.find), 'g');
            deps.set(live, edit.path, current.replace(re, edit.replace));
            return live;
        },

        inverse(edit) {
            return {
                op: 'str_replace',
                path: edit.path,
                find: edit.replace,
                replace: edit.find,
                expected_count: edit.expected_count,
            };
        },

        detectConflict(deps, edit, live) {
            const current = deps.get(live, edit.path);
            if (typeof current !== 'string') {
                return {
                    reason: 'value_drifted',
                    baseline: 'string',
                    current,
                };
            }
            const actual = countOccurrences(current, edit.find);
            if (actual === 0) {
                return { reason: 'anchor_missing', baseline: edit.find, current: 0 };
            }
            const expected = edit.expected_count ?? 1;
            if (actual !== expected) {
                return {
                    reason: 'anchor_ambiguous',
                    baseline: expected,
                    current: actual,
                };
            }
            return null;
        },
    };
}
