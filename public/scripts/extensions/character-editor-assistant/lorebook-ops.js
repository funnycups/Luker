/**
 * CEA-specific custom edits-lib ops for lorebook entries.
 * Lorebook entries are uid-keyed objects (`lorebook.entries[uid]`), not array-indexed,
 * so we cannot use built-in list_* ops which key by numeric array index.
 */

function getEntries(deps, live, path) {
    return deps.get(live, path) || {};
}

export function createLorebookEntryAddOp() {
    return {
        apply(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            entries[edit.uid] = deps.cloneDeep(edit.entry);
            deps.set(live, edit.path, entries);
            return live;
        },
        inverse(edit) {
            return {
                op: 'lorebook_entry_remove',
                path: edit.path,
                uid: edit.uid,
                entry: edit.entry,
            };
        },
        detectConflict(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            if (entries[edit.uid]) {
                return {
                    reason: 'duplicate',
                    baseline: undefined,
                    current: entries[edit.uid],
                };
            }
            return null;
        },
    };
}

export function createLorebookEntryUpdateOp() {
    return {
        apply(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            const cur = entries[edit.uid];
            if (!cur) return live;   // detectConflict will flag; defensive no-op here
            for (const key of Object.keys(edit.patch || {})) {
                cur[key] = deps.cloneDeep(edit.patch[key]);
            }
            return live;
        },
        inverse(edit) {
            return {
                op: 'lorebook_entry_update',
                path: edit.path,
                uid: edit.uid,
                patch: edit.before,
                before: edit.patch,
            };
        },
        detectConflict(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            const cur = entries[edit.uid];
            if (!cur) {
                return { reason: 'not_found', baseline: edit.before, current: undefined };
            }
            // already_done: every patched field already matches the desired post-patch value
            const allMatch = Object.keys(edit.patch || {}).every(
                (k) => deps.isEqual(cur[k], edit.patch[k]),
            );
            if (allMatch) {
                return { reason: 'already_done', baseline: edit.before, current: deps.cloneDeep(cur) };
            }
            // value_drifted: at least one field in `before` differs from current — adapter assumed a different pre-state
            const anyDrift = Object.keys(edit.before || {}).some(
                (k) => !deps.isEqual(cur[k], edit.before[k]),
            );
            if (anyDrift) {
                return { reason: 'value_drifted', baseline: edit.before, current: deps.cloneDeep(cur) };
            }
            return null;
        },
    };
}

export function createLorebookEntryRemoveOp() {
    return {
        apply(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            delete entries[edit.uid];
            deps.set(live, edit.path, entries);
            return live;
        },
        inverse(edit) {
            return {
                op: 'lorebook_entry_add',
                path: edit.path,
                uid: edit.uid,
                entry: edit.entry,
            };
        },
        detectConflict(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            const cur = entries[edit.uid];
            if (!cur) {
                return { reason: 'not_found', baseline: edit.entry, current: undefined };
            }
            if (!deps.isEqual(cur, edit.entry)) {
                return { reason: 'value_drifted', baseline: edit.entry, current: deps.cloneDeep(cur) };
            }
            return null;
        },
    };
}
