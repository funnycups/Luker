// Custom edits-lib op for CardApp's 3-tier fuzzy patch semantics.
//
// File-op surface — registered at CardApp boot via direct import of
// edits-lib's registerOp. The op is a thin wrapper around the existing
// applyPatch helper from studio.js so patch behavior is preserved
// bit-for-bit (exact → trim trailing whitespace → tab/space
// indent normalization).

/**
 * @param {object} deps
 * @param {(content: string, oldText: string, newText: string) => string|null} deps.applyPatch
 *   Three-tier fuzzy matcher. Returns the patched content, or null when
 *   no tier matches.
 */
export function createCardAppPatchFileOp({ applyPatch }) {
    if (typeof applyPatch !== 'function') {
        throw new Error('createCardAppPatchFileOp: deps.applyPatch must be a function');
    }

    return {
        apply(live, edit) {
            const current = live?.files?.[edit.path] ?? '';
            const next = applyPatch(current, edit.old_text, edit.new_text);
            if (next === null) {
                throw new Error(`cardapp_patch_file: patch did not apply (path=${edit.path})`);
            }
            return {
                ...live,
                files: { ...(live.files || {}), [edit.path]: next },
            };
        },

        inverse(edit) {
            return {
                op: 'cardapp_patch_file',
                path: edit.path,
                old_text: edit.new_text,
                new_text: edit.old_text,
            };
        },

        detectConflict(_deps, edit, live) {
            const current = live?.files?.[edit.path];
            if (current === undefined) {
                // File absent. Only OK if old_text is empty (patch-as-create).
                if (!edit.old_text) return null;
                return { reason: 'patch_target_missing', detail: `file ${edit.path} does not exist` };
            }
            // Run the 3-tier matcher in detect-only mode (it has no side effects).
            const probe = applyPatch(current, edit.old_text, edit.new_text);
            if (probe === null) {
                return { reason: 'patch_target_missing', detail: `old_text not found in ${edit.path}` };
            }
            return null;
        },
    };
}
