// Custom edits-lib op for CardApp's atomic file rename.
//
// File-op surface — registered at CardApp boot via direct import of
// edits-lib's registerOp. Uses the server's POST /api/card-app/:charId/rename
// atomic endpoint at commit time instead of decomposing rename into
// delete-then-create (which would lose atomicity and risk losing content
// mid-operation).

/**
 * @param {object} [deps]
 * @param {(charId: string, from: string, to: string) => Promise<void>} [deps.renameFile]
 *   Atomic rename helper. Only used by the commit walker, not the op itself —
 *   the op only mutates the live snapshot during applyEdits().
 */
export function createCardAppRenameFileOp() {
    return {
        apply(live, edit) {
            const files = { ...(live?.files || {}) };
            const content = files[edit.from];
            if (content === undefined) {
                throw new Error(`cardapp_rename_file: source missing (from=${edit.from})`);
            }
            delete files[edit.from];
            files[edit.to] = content;
            return { ...live, files };
        },

        inverse(edit) {
            return {
                op: 'cardapp_rename_file',
                from: edit.to,
                to: edit.from,
            };
        },

        detectConflict(_deps, edit, live) {
            const files = live?.files || {};
            if (!(edit.from in files)) {
                return { reason: 'rename_source_missing', detail: `file ${edit.from} does not exist` };
            }
            if (edit.to in files) {
                return { reason: 'rename_target_exists', detail: `file ${edit.to} already exists` };
            }
            return null;
        },
    };
}
