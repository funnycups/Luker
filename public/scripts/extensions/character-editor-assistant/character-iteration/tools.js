/**
 * Parse a tool-call's JSON arguments. Returns `null` if the JSON is malformed
 * so the caller can short-circuit and emit no edits (the orchestrator treats
 * `null` distinctly from `[]`, which means "valid call but no edits").
 */
function parseArgs(call) {
    try {
        return JSON.parse(call?.function?.arguments ?? '{}');
    } catch {
        return null;
    }
}

/**
 * Static tool catalog for the CEA Character Editor adapter.
 *
 * Six tools span the two halves of `live`:
 *   - card-field tools route to the built-in `set` / `str_replace` ops
 *   - lorebook-entry tools route to the CEA-registered custom ops keyed by uid
 *   - `cea_set_lorebook_metadata` covers top-level lorebook fields (e.g. bookName)
 *
 * Each tool definition is OpenAI-style JSON-schema so the catalog can be
 * forwarded to any provider that consumes the function-calling format.
 */
export const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'cea_set_card_field',
            description: 'Set a character card field to a new value.',
            parameters: {
                type: 'object',
                properties: {
                    field: { type: 'string', description: 'Card field name (e.g. name, description, personality).' },
                    value: { type: 'string', description: 'New value for the field.' },
                },
                required: ['field', 'value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_str_replace_card_field',
            description: 'Find-and-replace a substring inside a character card field.',
            parameters: {
                type: 'object',
                properties: {
                    field: { type: 'string', description: 'Card field name.' },
                    find: { type: 'string', description: 'Substring to locate.' },
                    replace: { type: 'string', description: 'Replacement text.' },
                },
                required: ['field', 'find', 'replace'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_add_lorebook_entry',
            description: 'Add a new lorebook entry. The entry object must include uid.',
            parameters: {
                type: 'object',
                properties: {
                    entry: {
                        type: 'object',
                        description: 'The new entry, including uid, key, content, and any other lorebook fields.',
                    },
                },
                required: ['entry'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_update_lorebook_entry',
            description: 'Patch fields of an existing lorebook entry, identified by uid.',
            parameters: {
                type: 'object',
                properties: {
                    uid: { type: 'integer', description: 'uid of the entry to update.' },
                    patch: {
                        type: 'object',
                        description: 'Object of fields to merge into the entry (shallow merge).',
                    },
                },
                required: ['uid', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_remove_lorebook_entry',
            description: 'Remove a lorebook entry by uid.',
            parameters: {
                type: 'object',
                properties: {
                    uid: { type: 'integer', description: 'uid of the entry to remove.' },
                },
                required: ['uid'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_set_lorebook_metadata',
            description: 'Set a top-level lorebook metadata field (e.g. bookName).',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Metadata key (e.g. bookName).' },
                    value: { description: 'New value for the metadata field.' },
                },
                required: ['key', 'value'],
            },
        },
    },
];

/**
 * Friendly name + emoji icon for each CEA tool, used in the pending-
 * approval popup so users see `✏️ Set card field` rather than
 * `cea_set_card_field`. Mirrors the pre-Plan-2 lorebook-sync popup's
 * tool labels.
 */
export const TOOL_DISPLAY = Object.freeze({
    cea_set_card_field: '✏️ Set card field',
    cea_str_replace_card_field: '🔄 Replace text in card field',
    cea_add_lorebook_entry: '➕ Add lorebook entry',
    cea_update_lorebook_entry: '✏️ Update lorebook entry',
    cea_remove_lorebook_entry: '🗑️ Remove lorebook entry',
    cea_set_lorebook_metadata: '⚙️ Set lorebook metadata',
});

export async function normalizeToolCallToEdit(call, ctx) {
    const name = call?.function?.name;
    const args = parseArgs(call);
    if (args === null) return null;
    const live = ctx?.live ?? {};

    if (name === 'cea_set_card_field') {
        return [{
            op: 'set',
            path: `card.${args.field}`,
            oldValue: live.card?.[args.field],
            newValue: args.value,
        }];
    }
    if (name === 'cea_str_replace_card_field') {
        return [{
            op: 'str_replace',
            path: `card.${args.field}`,
            find: String(args.find ?? ''),
            replace: String(args.replace ?? ''),
        }];
    }
    if (name === 'cea_add_lorebook_entry') {
        return [{
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: args.entry?.uid,
            entry: args.entry,
        }];
    }
    if (name === 'cea_update_lorebook_entry') {
        // Capture `before` from live state at emission time, for only the
        // fields the patch touches. This makes the edit self-contained:
        // inverse(edit) just swaps `patch` and `before`.
        const cur = live.lorebook?.entries?.[args.uid];
        const before = {};
        for (const k of Object.keys(args.patch || {})) {
            before[k] = cur?.[k];
        }
        return [{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: args.uid,
            patch: args.patch,
            before,
        }];
    }
    if (name === 'cea_remove_lorebook_entry') {
        // Snapshot the live entry so the inverse `lorebook_entry_add`
        // can faithfully restore it without re-reading state.
        const entry = live.lorebook?.entries?.[args.uid];
        return [{
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: args.uid,
            entry: entry ? structuredClone(entry) : undefined,
        }];
    }
    if (name === 'cea_set_lorebook_metadata') {
        return [{
            op: 'set',
            path: `lorebook.${args.key}`,
            oldValue: live.lorebook?.[args.key],
            newValue: args.value,
        }];
    }
    return [];
}
