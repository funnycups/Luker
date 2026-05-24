// Unified CEA editor tool catalog.
//
// The unified editor runs through the shared iteration-library runner
// with the same `TOOL_DEFS` / `isControlCall` / `onControlCall` contract
// as the orchestrator, memory-graph schema iteration, and CPA popups.
// This module is the bridge: it produces the OpenAI-style function
// definitions the model sees, classifies which calls are reads vs edits
// vs control, and adapts each tool call into the shape the runner /
// apply step expect.
//
// What lives where:
//   - Edit-tool schemas (cea_set_card_field, cea_add_lorebook_entry, …)
//     and the per-tool edit normalization are defined below. The unified
//     editor is their sole consumer; both halves of the live snapshot
//     (`live.character` and `live.lorebooks[name]`) get the same set of
//     ops, distinguished only by the `target` annotation attached after
//     normalization.
//   - Read-tool schemas use short canonical names (lorebook_query, …)
//     and are defined here. Execution dispatches to main.js's legacy
//     helper-tool runner (renaming the call to the legacy `luker_card_*`
//     name) so we don't duplicate the read-side logic.
//   - The two control tools (continue / finalize) are defined here and
//     namespaced with `luker_cea_editor_*`.

import { runCharacterEditorHelperToolCall } from '../main.js';

// ---------------------------------------------------------------------------
// Edit tools (cea_*)
//
// Six tools span the two halves of `live`:
//   - card-field tools route to the built-in `set` / `str_replace` ops
//   - lorebook-entry tools route to the CEA-registered custom ops keyed by uid
//   - `cea_set_lorebook_metadata` covers top-level lorebook fields (e.g.
//     scan_depth, recursive_scan). Note: renaming a lorebook via `bookName`
//     is rejected at commit time (see `commitLorebookOperations` in main.js);
//     the live-state apply path can't perform the rename-then-delete dance
//     that world-info.js's renameWorldInfo does. Users have to rename via
//     the world-info panel.
//
// Each tool definition is OpenAI-style JSON-schema so the catalog can be
// forwarded to any provider that consumes the function-calling format.
// ---------------------------------------------------------------------------

const CHAR_ITER_EDIT_TOOL_DEFS = [
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
            description: 'Add a new lorebook entry. The entry object must include uid. book_name selects which world book to target (call world_book_list first if unsure which books are bound to this character).',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    entry: {
                        type: 'object',
                        description: 'The new entry, including uid, key, content, and any other lorebook fields.',
                    },
                },
                required: ['book_name', 'entry'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_update_lorebook_entry',
            description: 'Patch fields of an existing lorebook entry, identified by uid. book_name selects which world book to target.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    uid: { type: 'integer', description: 'uid of the entry to update.' },
                    patch: {
                        type: 'object',
                        description: 'Object of fields to merge into the entry (shallow merge).',
                    },
                },
                required: ['book_name', 'uid', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_remove_lorebook_entry',
            description: 'Remove a lorebook entry by uid. book_name selects which world book to target.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    uid: { type: 'integer', description: 'uid of the entry to remove.' },
                },
                required: ['book_name', 'uid'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cea_set_lorebook_metadata',
            description: 'Set a top-level lorebook metadata field (e.g. scan_depth, recursive_scan). book_name selects which world book to target. Do not use this to rename the lorebook itself — bookName renames are rejected at commit time; the user must rename via the world-info panel.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    key: { type: 'string', description: 'Metadata key (e.g. scan_depth). Setting `bookName` is rejected — use the world-info panel to rename a lorebook.' },
                    value: { description: 'New value for the metadata field.' },
                },
                required: ['book_name', 'key', 'value'],
            },
        },
    },
];

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
 * Convert a single `cea_*` edit tool call into a list of edit ops over the
 * `live` snapshot. Returns `null` only when args fail to parse; an empty
 * array means "valid call but no edits" (e.g. unrecognized tool name).
 *
 * Operates on the character-iteration shape — `live.card` and `live.lorebook`.
 * The unified editor's per-target wrapper (`normalizeToolCallToEdit` below)
 * remaps `live.character` / `live.lorebooks[name]` onto this shape, calls
 * here, then annotates the edits with `target` metadata.
 */
async function charIterNormalizeToolCallToEdit(call, ctx) {
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
            entry: entry ? JSON.parse(JSON.stringify(entry)) : undefined,
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

// ---------------------------------------------------------------------------
// Control tools
// ---------------------------------------------------------------------------

export const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_cea_editor_continue_iteration',
    finalize: 'luker_cea_editor_finalize_iteration',
});

const CONTROL_TOOL_NAME_SET = new Set(Object.values(CONTROL_TOOL_NAMES));

export function isCeaEditorControlCall(call) {
    return CONTROL_TOOL_NAME_SET.has(String(call?.name || ''));
}

export const CONTROL_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.continue,
            description: 'Request one automatic follow-up round after the current tools have run. Use only when more iteration is genuinely needed; otherwise call luker_cea_editor_finalize_iteration.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.finalize,
            description: 'Finalize this character/lorebook iteration with a concise summary. The popup stops auto-continuing after this call.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'Short user-facing summary of what changed.' },
                },
                additionalProperties: false,
            },
        },
    },
];

// ---------------------------------------------------------------------------
// Read tools (short canonical names)
// ---------------------------------------------------------------------------

// Short-name → legacy on-the-wire name map. The legacy helper-tool runner
// in main.js dispatches on the legacy names (`luker_card_query_lorebook_entries`
// etc.), so we translate when invoking. The model only ever sees the short
// names so the wire surface stays consistent across the iter popups.
const READ_TOOL_LEGACY_NAMES = Object.freeze({
    lorebook_query: 'luker_card_query_lorebook_entries',
    lorebook_list: 'luker_card_list_lorebook_entries',
    lorebook_get: 'luker_card_get_lorebook_entries',
    world_book_list: 'luker_card_list_world_books',
    simulate_prompt: 'luker_card_simulate_prompt',
    // web_search has no fixed legacy name — `Luker.searchTools.toolNames.SEARCH`
    // resolves it at runtime. We handle it specially in runCeaEditorReadTool.
    web_search: null,
});

const READ_TOOL_NAME_SET = new Set(Object.keys(READ_TOOL_LEGACY_NAMES));

export function isCeaEditorReadTool(name) {
    return READ_TOOL_NAME_SET.has(String(name || ''));
}

// Short-name read-tool schemas. Mirrors the legacy `getToolDefs()` output
// from createCharacterEditorLorebookToolApi / SimulateToolApi /
// WorldBookListToolApi in main.js, but with the short canonical names so
// the model sees a clean surface. Web-search is gated on `hasSearchTools`.
const READ_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'lorebook_list',
            description: 'List compact lorebook entry index rows (uid, name, enabled) for a world book. Call world_book_list first to know which book names exist. Optional range narrows the inclusive UID window, for example 0~100.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    range: { type: 'string', description: 'Optional inclusive UID range such as 0~100, 50~, ~100, or a single uid like 42.' },
                },
                required: ['book_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_query',
            description: 'Search a world book and return lightweight matching entries. Call world_book_list first to know which book names exist. Use this before lorebook_get to narrow candidates.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    text: { type: 'string' },
                    search_mode: { type: 'string', enum: ['any', 'activation'] },
                    constant: { type: 'boolean' },
                    enabled: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 1, maximum: 20 },
                },
                required: ['book_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lorebook_get',
            description: 'Fetch full lorebook entries from a world book by uid after narrowing candidates with lorebook_query.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    uids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 10 },
                },
                required: ['book_name', 'uids'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'world_book_list',
            description: 'List world book names visible to the character being edited, tagged with their scope (character, character_aux, chat, global).',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: 'simulate_prompt',
            description: 'Simulate current prompt assembly with character card and world info. Prefer text to append one user turn to the current chat. Use messages only when the user explicitly supplied a structured message array.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'Preferred. Append this user text to the current chat and simulate with world info activation.' },
                    messages: {
                        type: 'array',
                        description: 'Explicit message array. Use only when the user already gave structured records/messages.',
                        items: {
                            type: 'object',
                            properties: {
                                role: { type: 'string' },
                                content: { type: 'string' },
                                mes: { type: 'string' },
                                is_user: { type: 'boolean' },
                                is_system: { type: 'boolean' },
                            },
                            additionalProperties: true,
                        },
                    },
                },
                additionalProperties: false,
            },
        },
    },
];

const WEB_SEARCH_TOOL_DEF = Object.freeze({
    type: 'function',
    function: {
        name: 'web_search',
        description: 'Search the public web and return a list of result links and snippets.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query.' },
                limit: { type: 'integer', minimum: 1, maximum: 20 },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
});

// ---------------------------------------------------------------------------
// buildCeaEditorToolSet
// ---------------------------------------------------------------------------

/**
 * Build the full OpenAI-style tool list for one round of the unified editor.
 *
 * Composition:
 *   - 6 edit tools (cea_*) defined above
 *   - 6 read tools defined above (short canonical names)
 *     (web_search included iff `opts.hasSearchTools` is true)
 *   - 2 control tools (luker_cea_editor_*)
 *
 * The function signature accepts `context` and `settings` for parity with
 * the other adapter `build…ToolSet` helpers in this codebase, even though
 * the current implementation only reads `opts.hasSearchTools`. Future
 * read-tool gating can thread `live` through here without breaking
 * callers.
 *
 * @param {Object} _context        SillyTavern context (reserved).
 * @param {Object} _settings       CEA settings (reserved).
 * @param {Object} [opts]
 * @param {Object} [opts.live]     Current state.live { character, lorebooks }.
 * @param {boolean} [opts.hasSearchTools] Whether Luker.searchTools is wired.
 * @returns {Array<Object>} Tool defs.
 */
export function buildCeaEditorToolSet(_context, _settings, opts = {}) {
    const hasSearchTools = Boolean(opts?.hasSearchTools);
    const readTools = hasSearchTools
        ? [...READ_TOOL_DEFS, WEB_SEARCH_TOOL_DEF]
        : READ_TOOL_DEFS.slice();
    return [
        ...CHAR_ITER_EDIT_TOOL_DEFS,
        ...readTools,
        ...CONTROL_TOOL_DEFS,
    ];
}

// ---------------------------------------------------------------------------
// normalizeToolCallToEdit (with target annotation)
// ---------------------------------------------------------------------------

/**
 * Convert a single tool call into 0..N edits with target metadata.
 *
 * Delegates the per-tool op shaping to `charIterNormalizeToolCallToEdit`
 * (defined above; covers all six `cea_*` edit verbs), then annotates
 * each edit with a `target` object so the apply step can route between
 * `state.live.character` and `state.live.lorebooks[bookName]`.
 *
 * Returns `null` only when the underlying normalize signals malformed args
 * (distinct from `[]`, which means "valid call but no edits").
 *
 * @param {Object} call      { id, name, args }
 * @param {Object} opts
 * @param {Object} [opts.context] SillyTavern context (forwarded).
 * @param {Object} [opts.live]    state.live snapshot (forwarded).
 * @returns {Promise<Array<Object>|null>}
 */
export async function normalizeToolCallToEdit(call, opts = {}) {
    const adapted = adaptCallToCharIterShape(call);
    const charIterCtx = { live: opts?.live ?? {}, context: opts?.context };
    const edits = await charIterNormalizeToolCallToEdit(adapted, charIterCtx);
    if (!Array.isArray(edits)) {
        return null;
    }
    return edits.map(edit => annotateTarget(edit, call, opts?.live));
}

/**
 * The local `charIterNormalizeToolCallToEdit` helper reads
 * `call.function.name` and `call.function.arguments` (JSON-string, OpenAI
 * shape). The unified editor's call objects are already parsed into
 * `{ id, name, args }`. Adapter wraps the parsed args back into a JSON
 * string so we can reuse that helper without copying its switch statement.
 */
function adaptCallToCharIterShape(call) {
    const name = String(call?.name || '');
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    let argString;
    try {
        argString = JSON.stringify(args);
    } catch {
        argString = '{}';
    }
    return {
        id: call?.id,
        function: { name, arguments: argString },
    };
}

/**
 * Attach `target` metadata to an edit, derived from the tool name + args.
 *   - card-field tools (cea_set_card_field / cea_str_replace_card_field)
 *     → target.kind = 'character'
 *   - lorebook tools (cea_add/update/remove_lorebook_entry,
 *     cea_set_lorebook_metadata) → target.kind = 'lorebook', plus
 *     target.bookName from args.book_name when present.
 *
 * Fallback: if the LLM omits book_name despite the schema requiring it
 * (defensive — providers sometimes drop required fields silently) AND the
 * live snapshot has exactly one lorebook bound to the character, use that
 * book's name. With zero or multiple bound books we cannot safely guess,
 * so we leave bookName empty and the apply path drops the edit with a
 * console warning.
 */
function annotateTarget(edit, call, live = null) {
    const name = String(call?.name || '');
    if (name === 'cea_set_card_field' || name === 'cea_str_replace_card_field') {
        return { ...edit, target: { kind: 'character' } };
    }
    if (name.startsWith('cea_') && name.includes('lorebook')) {
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        let bookName = String(args.book_name ?? args.world_name ?? '').trim();
        if (!bookName && live && typeof live === 'object') {
            const lorebooks = live.lorebooks && typeof live.lorebooks === 'object' ? live.lorebooks : {};
            const candidates = Object.keys(lorebooks);
            if (candidates.length === 1) {
                bookName = String(candidates[0]).trim();
            }
        }
        return {
            ...edit,
            target: bookName ? { kind: 'lorebook', bookName } : { kind: 'lorebook' },
        };
    }
    return edit;
}

// ---------------------------------------------------------------------------
// runCeaEditorReadTool
// ---------------------------------------------------------------------------

/**
 * Execute a read tool synchronously and return its result for the next
 * round's tool_result message.
 *
 * Translates the short canonical tool name (lorebook_query, …) to the
 * legacy on-the-wire name (luker_card_query_lorebook_entries, …) and
 * dispatches to main.js's `runCharacterEditorHelperToolCall`. For
 * web_search, resolves the live tool name from `Luker.searchTools` at
 * call time (the legacy name isn't a constant).
 *
 * Returns `{ ok: true, result }` on success and `{ ok: false, error }`
 * on failure so the studio.js loop can append a tool_result regardless.
 *
 * @param {Object} call
 * @param {Object} opts
 * @param {Object} [opts.context]     SillyTavern context (forwarded).
 * @param {Object} [opts.settings]    CEA settings (forwarded).
 * @param {Array}  [opts.helperApis]  Helper-tool APIs from main.js
 *   (`[lorebookToolApi, simulateToolApi, worldBookListToolApi, searchApi?]`).
 * @returns {Promise<{ ok: boolean, result?: any, error?: string }>}
 */
export async function runCeaEditorReadTool(call, opts = {}) {
    const shortName = String(call?.name || '');
    if (!isCeaEditorReadTool(shortName)) {
        return { ok: false, error: `Not a read tool: ${shortName || '(empty)'}` };
    }
    const helperApis = Array.isArray(opts?.helperApis) ? opts.helperApis : [];
    let legacyName = READ_TOOL_LEGACY_NAMES[shortName];
    if (shortName === 'web_search') {
        legacyName = resolveWebSearchLegacyName(helperApis);
        if (!legacyName) {
            return { ok: false, error: 'web_search is not wired (Luker.searchTools missing).' };
        }
    }
    if (!legacyName) {
        return { ok: false, error: `Unknown legacy mapping for ${shortName}.` };
    }
    const legacyCall = {
        id: call?.id,
        name: legacyName,
        args: call?.args && typeof call.args === 'object' ? call.args : {},
    };
    try {
        const raw = await runCharacterEditorHelperToolCall(legacyCall, helperApis);
        const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'result')
            ? raw.result
            : raw;
        return { ok: true, result };
    } catch (err) {
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}

function resolveWebSearchLegacyName(helperApis) {
    for (const api of Array.isArray(helperApis) ? helperApis : []) {
        const name = String(api?.toolNames?.SEARCH || '').trim();
        if (name) {
            return name;
        }
    }
    return '';
}
