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

// Canonical list of character-card fields the unified editor knows how to
// commit. Mirrors the union of:
//   - CHARACTER_EDITOR_ROOT_TEXT_FIELDS  (name / description / personality /
//                                         scenario / first_mes / mes_example)
//   - CHARACTER_EDITOR_DATA_TEXT_FIELDS  (system_prompt /
//                                         post_history_instructions /
//                                         creator_notes)
//   - CHARACTER_EDITOR_DATA_ARRAY_FIELDS (alternate_greetings — array-typed,
//                                         AI should set as JSON string when
//                                         the tool API allows; this enum
//                                         lets unknown names fail fast at
//                                         schema validation instead of at
//                                         commit time)
// Defined in `extensions/character-editor-assistant/main.js`. Adding new
// fields requires updating both sides — `commitCharacterEditorOperations`
// will silently skip unknown fields otherwise.
export const CEA_CARD_FIELD_ENUM = Object.freeze([
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
    'creator_notes',
    'alternate_greetings',
]);

export function isKnownCardField(name) {
    return CEA_CARD_FIELD_ENUM.includes(String(name || ''));
}

// ---------------------------------------------------------------------------
// Edit tools (cea_*)
//
// Seven tools span the two halves of `live`:
//   - card-field tools route to the built-in `set` / `str_replace` ops
//   - lorebook-entry tools route to the CEA-registered custom ops keyed by uid
//     (add / update / remove / str_replace-per-field)
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

const CEA_EDIT_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'cea_set_card_field',
            description: 'Set a character card field to a new value. `field` is restricted to the canonical card fields enum.',
            parameters: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        enum: [...CEA_CARD_FIELD_ENUM],
                        description: 'Card field name. Restricted to: name / description / personality / scenario / first_mes / mes_example / system_prompt / post_history_instructions / creator_notes / alternate_greetings.',
                    },
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
            description: 'Find-and-replace a substring inside a character card field. By default `oldString` must occur exactly once — fails otherwise; widen with surrounding context until unique, or pass `replaceAll: true` to replace every occurrence. `field` is restricted to the canonical card fields enum.',
            parameters: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        enum: [...CEA_CARD_FIELD_ENUM],
                        description: 'Card field name. Restricted to the canonical card fields enum (see cea_set_card_field).',
                    },
                    oldString: { type: 'string', description: 'Substring to locate. Must occur exactly once unless `replaceAll` is true.' },
                    newString: { type: 'string', description: 'Replacement text.' },
                    replaceAll: { type: 'boolean', description: 'Optional. When true, replace every occurrence of `oldString`. Default false (unique-or-fail).' },
                },
                required: ['field', 'oldString', 'newString'],
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
            description: 'Patch fields of an existing lorebook entry, identified by uid. book_name selects which world book to target. Prefer cea_str_replace_lorebook_entry_field for partial text edits within a single field.',
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
            name: 'cea_str_replace_lorebook_entry_field',
            description: 'Find-and-replace a substring inside a single field of a lorebook entry. Mirrors cea_str_replace_card_field for lorebook entries — preferred over cea_update_lorebook_entry when you only want to tweak a portion of one field (typically `content`) without resending the entire field. By default `oldString` must occur exactly once; pass `replaceAll: true` to replace every occurrence. Bails out without staging an edit when `oldString` is not present in the current value.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Target world book name.' },
                    uid: { type: 'integer', description: 'uid of the entry to edit.' },
                    field: { type: 'string', description: 'Entry field to edit (commonly `content`; also valid: `comment`, `key`, etc.).' },
                    oldString: { type: 'string', description: 'Substring to locate inside the field. Must occur exactly once unless `replaceAll` is true.' },
                    newString: { type: 'string', description: 'Replacement text.' },
                    replaceAll: { type: 'boolean', description: 'Optional. When true, replace every occurrence of `oldString`. Default false (unique-or-fail).' },
                },
                required: ['book_name', 'uid', 'field', 'oldString', 'newString'],
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
 * Operates on the unified editor's `live` shape:
 *   - `live.character`             — the active character card fields
 *   - `live.lorebooks[bookName]`   — per-book entries + meta, keyed by
 *                                    `args.book_name`
 *
 * Path scheme:
 *   - card-field ops emit `card.<field>` (rebased to bare `<field>` by
 *     studio.js's `rebasePathToTarget` at commit time)
 *   - lorebook ops emit `lorebook.entries` / `lorebook.<meta>` (likewise
 *     rebased to `entries` / `<meta>` against the per-book commit slot)
 * The path strings are deliberately decoupled from the live-shape lookup
 * so the lookup can read the right `live.lorebooks[name]` slot while the
 * commit still routes through the legacy rebase contract.
 */
async function normalizeUnifiedToolCallToEdit(call, ctx) {
    const name = call?.function?.name;
    const args = parseArgs(call);
    if (args === null) return null;
    const live = ctx?.live ?? {};
    const bookName = String(args?.book_name ?? '').trim();
    const liveBook = bookName ? (live?.lorebooks?.[bookName] ?? null) : null;

    if (name === 'cea_set_card_field') {
        return [{
            op: 'set',
            path: `card.${args.field}`,
            oldValue: live?.character?.[args.field],
            newValue: args.value,
        }];
    }
    if (name === 'cea_str_replace_card_field') {
        // Engine op uses `find`/`replace` field names (load-bearing — persisted
        // in CEA session storage via normalizeEdit). Tool args use the
        // Edit-tool naming `oldString`/`newString`/`replaceAll`; we lower
        // them into engine-op shape here. `replaceAll: true` → count actual
        // occurrences on live and pass that as expected_count, so the
        // engine's conflict gate still rejects external drift while
        // replacing every current match. `replaceAll: false` (default) →
        // expected_count: 1, the engine's unique-or-fail invariant.
        const find = String(args.oldString ?? '');
        const replace = String(args.newString ?? '');
        const liveValue = String(live?.character?.[args.field] ?? '');
        const occurrences = find ? liveValue.split(find).length - 1 : 0;
        const expectedCount = Boolean(args.replaceAll) ? Math.max(1, occurrences) : 1;
        return [{
            op: 'str_replace',
            path: `card.${args.field}`,
            find,
            replace,
            expected_count: expectedCount,
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
        // Capture `before` from the per-book live snapshot for only the
        // fields the patch touches. This makes the edit self-contained:
        // inverse(edit) just swaps `patch` and `before`. The lookup MUST
        // index by `args.book_name` — the unified editor's live shape is
        // `lorebooks: { [bookName]: { entries: { [uid]: ... } } }`, not a
        // singular `lorebook`. A miss leaves `before` populated with
        // undefineds and the apply-time `value_drifted` conflict detector
        // rejects the commit.
        const cur = liveBook?.entries?.[args.uid];
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
    if (name === 'cea_str_replace_lorebook_entry_field') {
        // Per-field find/replace on a single entry. Lowered to a
        // `lorebook_entry_update` so the apply / inverse / conflict
        // detector path can stay shared with the full-update variant.
        //
        // Anchor / validation failures throw with an explicit code so
        // studio.js's catch arm surfaces a real `{error: ...}` tool
        // result. Silently returning `[]` here used to collapse onto
        // the generic "likely already matches" iter-studio noop and
        // the AI would think its broken patch had succeeded.
        const field = String(args.field ?? '');
        if (!field) {
            throw new Error(`${name}: invalid_args — field is required.`);
        }
        const find = String(args.oldString ?? '');
        const replace = String(args.newString ?? '');
        const cur = liveBook?.entries?.[args.uid];
        const currentValue = cur && Object.hasOwn(cur, field) ? String(cur[field] ?? '') : '';
        if (find === '') {
            throw new Error(`${name}: invalid_args — oldString must be a non-empty string (use the regular update tool to clear a field).`);
        }
        // Apply the replacement client-side so we can stage a precise
        // `{ before, patch }` pair: the apply step won't re-run the find
        // (it sees this as a plain field update). Default semantics:
        // `oldString` must occur exactly once unless `replaceAll: true`.
        const occurrences = currentValue.split(find).length - 1;
        if (occurrences === 0) {
            throw new Error(`${name}: not_found — oldString is not present in lorebook entry "${args.uid}".${field} (book "${bookName}"). Re-read the current field with cea_read_live_fields before retrying.`);
        }
        if (!args.replaceAll && occurrences !== 1) {
            throw new Error(`${name}: multiple_matches — oldString occurs ${occurrences} times in lorebook entry "${args.uid}".${field} (book "${bookName}"). Widen oldString with surrounding context until it matches exactly once, or pass replaceAll: true.`);
        }
        const nextValue = currentValue.split(find).join(replace);
        return [{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: args.uid,
            patch: { [field]: nextValue },
            before: { [field]: cur?.[field] },
        }];
    }
    if (name === 'cea_remove_lorebook_entry') {
        // Snapshot the live entry so the inverse `lorebook_entry_add`
        // can faithfully restore it without re-reading state. Same
        // per-book lookup contract as `cea_update_lorebook_entry`.
        const entry = liveBook?.entries?.[args.uid];
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
            oldValue: liveBook?.[args.key],
            newValue: args.value,
        }];
    }
    return [];
}

// ---------------------------------------------------------------------------
// Control tools
//
// CEA editor currently has no control tools. The multi-round auto-continue
// loop is program-driven by tool-call presence (any tool call → next round,
// none → stop). The empty map + predicate stay here so the runner's
// `isControlCall` callback contract is uniform across popups.
// ---------------------------------------------------------------------------

export const CONTROL_TOOL_NAMES = Object.freeze({});

const CONTROL_TOOL_NAME_SET = new Set();

export function isCeaEditorControlCall(call) {
    return CONTROL_TOOL_NAME_SET.has(String(call?.name || ''));
}

export const CONTROL_TOOL_DEFS = [];

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
        ...CEA_EDIT_TOOL_DEFS,
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
    const adapted = adaptCallToOpenAiShape(call);
    const ctx = { live: opts?.live ?? {}, context: opts?.context };
    const edits = await normalizeUnifiedToolCallToEdit(adapted, ctx);
    if (!Array.isArray(edits)) {
        return null;
    }
    return edits.map(edit => annotateTarget(edit, call, opts?.live));
}

/**
 * `normalizeUnifiedToolCallToEdit` reads `call.function.name` and
 * `call.function.arguments` (JSON-string, OpenAI shape). The unified
 * editor's call objects are already parsed into `{ id, name, args }`.
 * Adapter wraps the parsed args back into a JSON string so we can reuse
 * the helper without copying its switch statement.
 */
function adaptCallToOpenAiShape(call) {
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
    // All lorebook tools share the `cea_*` + `lorebook` substring convention
    // (cea_add_lorebook_entry, cea_update_lorebook_entry,
    // cea_str_replace_lorebook_entry_field, cea_remove_lorebook_entry,
    // cea_set_lorebook_metadata). The single substring check covers every
    // tool that targets a world book — keep that invariant when adding
    // future lorebook tools so target routing stays declarative.
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
