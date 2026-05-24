// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CPA — plugin-owned tool catalog + tool-call normalizer.
 *
 * Ported verbatim from cpa-iteration-adapter.js (the shell-driven adapter
 * that Stage 3 retires). This module exposes only the static, side-effect-
 * free pieces:
 *
 *   - TOOL_DISPLAY:         friendly UI labels keyed by tool name
 *   - EDITABLE_TOOL_NAMES:  Set of tools that translate to edits-lib ops
 *   - buildToolCatalog:     OpenAI-style function definitions, gated by
 *                           hasReference (cross-preset tools only appear
 *                           when a reference preset is selected)
 *   - classifyToolCall:     "editable" vs "control" for the runner
 *   - normalizeToolCallToEdit: async; returns edits-lib op array or null
 *
 * normalizeToolCallToEdit may need to read a reference preset body when
 * dispatching `preset_copy_from_reference`. That fetch is plumbed via
 * `ctx.getReferencePresetBody(name)` so this module stays pure.
 */

import { lodash } from '../../../../lib.js';

export const EDITABLE_TOOL_NAMES = new Set([
    'preset_set_field',
    'preset_str_replace',
    'preset_str_insert',
    'preset_str_delete',
    'preset_list_insert',
    'preset_list_remove',
    'preset_list_move',
    'preset_upsert_prompt_entry',
    'preset_remove_prompt_entry',
    'preset_upsert_prompt_order_item',
    'preset_remove_prompt_order_item',
    'preset_copy_from_reference',
]);

export const TOOL_DISPLAY = Object.freeze({
    preset_set_field:                '✏️ Set field',
    preset_str_replace:              '🔄 Replace text',
    preset_str_insert:               '➕ Insert text',
    preset_str_delete:               '➖ Delete text',
    preset_list_insert:              '➕ Insert into list',
    preset_list_remove:              '➖ Remove from list',
    preset_list_move:                '🔀 Move in list',
    preset_upsert_prompt_entry:      '🆕 Upsert prompt entry',
    preset_remove_prompt_entry:      '🗑️ Remove prompt entry',
    preset_upsert_prompt_order_item: '↕️ Place in prompt order',
    preset_remove_prompt_order_item: '🗑️ Remove from prompt order',
    preset_copy_from_reference:      '📋 Copy from reference',
    preset_read_live_fields:         '📖 Read fields',
    preset_read_reference_fields:    '📖 Read reference fields',
    preset_diff_reference:           '🔍 Diff reference',
    preset_simulate:                 '🧪 Simulate prompt',
    preset_clone_to_new:             '📋 Clone to new preset',
    luker_cpa_continue_iteration:    '↻ Continue iteration',
    luker_cpa_finalize_iteration:    '✓ Finalize iteration',
});

/**
 * Control-tool names used to steer the multi-round auto-continue loop.
 * Filtered OUT of `editToolCalls` so they never normalize to edits, and
 * passed to the runner via `isControlCall` so the runner can route them
 * to `onControlCall` instead of `onToolCall` in per-event callbacks.
 *
 * Names are namespaced `luker_cpa_*` to match the orchestrator's
 * `luker_orch_*` pattern (and memory-graph's `luker_mg_*`), so the
 * shared runner has no hardcoded allowlist.
 */
export const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_cpa_continue_iteration',
    finalize: 'luker_cpa_finalize_iteration',
});
export const CONTROL_TOOL_NAME_SET = new Set([
    CONTROL_TOOL_NAMES.continue,
    CONTROL_TOOL_NAMES.finalize,
]);
export function isCpaControlCall(toolCall) {
    return CONTROL_TOOL_NAME_SET.has(String(toolCall?.name || ''));
}

export const READ_TOOL_NAMES = new Set([
    'preset_read_live_fields',
    'preset_read_reference_fields',
    'preset_diff_reference',
    'preset_simulate',
    // preset_clone_to_new isn't pure inspection — it saves a new preset and
    // swaps the popup target. We still route it through the read-tool
    // dispatcher so the executor's result threads back into the next round
    // as a `role: 'tool'` reply (the model needs to learn whether the clone
    // succeeded before continuing). Treat as a side-effecting read.
    'preset_clone_to_new',
]);
export function isCpaReadTool(name) {
    return READ_TOOL_NAMES.has(String(name || ''));
}

function parseArgs(call) {
    try { return JSON.parse(call?.function?.arguments ?? '{}'); }
    catch { return null; }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    const re = new RegExp(escapeRegex(needle), 'g');
    return (String(haystack).match(re) || []).length;
}

/**
 * Pre-flight uniqueness check for str_insert / str_delete. The engine's
 * str_* ops already enforce uniqueness via `anchor_ambiguous`, but they
 * hardcode expected_count = 1. CPA's tool schemas accept `expected_count`
 * so the AI can declare its intent ("I know this text appears N times,
 * that's expected"); throwing here surfaces the mismatch to the assistant
 * message + chat UI instead of waiting for the engine's conflict tracker.
 *
 * When expected_count is omitted, defaults to 1 (the engine's invariant).
 * The lib's engine only edits the FIRST match, so expected_count > 1 is
 * disallowed: it would imply multi-edit semantics the underlying op
 * doesn't support.
 */
function assertStrOpUniqueness({ path, value, needle, expected_count, opLabel }) {
    if (typeof value !== 'string') {
        throw new Error(`${opLabel} expects a string at ${path}, got ${typeof value}.`);
    }
    const expected = Number.isInteger(expected_count) && expected_count >= 1 ? expected_count : 1;
    if (expected !== 1) {
        throw new Error(`${opLabel} only supports expected_count = 1 (got ${expected}); the underlying engine edits a unique anchor.`);
    }
    const actual = countOccurrences(value, needle);
    if (actual !== expected) {
        throw new Error(`${opLabel} expected ${expected} match(es) of "${String(needle).slice(0, 40)}" in ${path}, found ${actual}.`);
    }
}

function normalizePromptIdentifier(value, fallback = '') {
    return String(value ?? fallback ?? '').trim();
}

function findPromptEntryIndex(prompts, identifier) {
    return (Array.isArray(prompts) ? prompts : []).findIndex((entry) =>
        normalizePromptIdentifier(entry?.identifier, entry?.id) === identifier,
    );
}

/**
 * Upsert one prompts[] entry by identifier, mutating `body` in place.
 *
 * BUG-CRITICAL: when CREATING (entry not yet present), also append
 * `{identifier, enabled}` to every existing prompt_order[*].order group
 * unless `auto_add_to_order: false`. Without this the entry exists in
 * prompts[] but is silently ignored at generation time — the bug users
 * hit ("AI says inserted, only created"). UPDATING an existing entry
 * never touches prompt_order; the entry stays where it was placed.
 */
function upsertPromptEntryInBody(body, edit) {
    const identifier = normalizePromptIdentifier(edit?.identifier);
    if (!identifier) throw new Error('Prompt identifier is required.');
    if (!Array.isArray(body.prompts)) body.prompts = [];

    const promptIndex = findPromptEntryIndex(body.prompts, identifier);
    const isCreate = promptIndex < 0;
    const current = isCreate
        ? { identifier }
        : (body.prompts[promptIndex] && typeof body.prompts[promptIndex] === 'object'
            ? { ...body.prompts[promptIndex] }
            : { identifier });

    const next = { ...current, identifier };
    if (Object.hasOwn(edit, 'content'))            next.content = String(edit.content ?? '');
    if (Object.hasOwn(edit, 'role'))               next.role = String(edit.role ?? '').trim();
    if (Object.hasOwn(edit, 'enabled'))            next.enabled = Boolean(edit.enabled);
    if (Object.hasOwn(edit, 'name'))               next.name = String(edit.name ?? '').trim();
    if (Object.hasOwn(edit, 'marker'))             next.marker = Boolean(edit.marker);
    if (Object.hasOwn(edit, 'injection_position')) next.injection_position = edit.injection_position;
    if (Object.hasOwn(edit, 'injection_depth'))    next.injection_depth = edit.injection_depth;
    if (Object.hasOwn(edit, 'injection_order'))    next.injection_order = edit.injection_order;

    if (!isCreate) {
        body.prompts[promptIndex] = next;
        return;
    }
    if (!Object.hasOwn(next, 'content')) {
        throw new Error(`New prompt entry ${identifier} requires content.`);
    }
    body.prompts.push(next);

    const autoAdd = !Object.hasOwn(edit, 'auto_add_to_order') || Boolean(edit.auto_add_to_order);
    if (!autoAdd) return;

    const orderEntry = { identifier, enabled: Object.hasOwn(edit, 'enabled') ? Boolean(edit.enabled) : true };
    if (!Array.isArray(body.prompt_order)) body.prompt_order = [];

    // Optional `position` lets a single upsert call place the new entry
    // precisely instead of forcing a follow-up preset_upsert_prompt_order_item.
    // 1-based; clamped per-group so a position past the end appends instead
    // of failing on a too-short group.
    const rawPosition = Number(edit?.position);
    const explicitPosition = Number.isInteger(rawPosition) && rawPosition >= 1 ? rawPosition : null;

    if (body.prompt_order.length === 0) {
        body.prompt_order.push({ character_id: '', order: [orderEntry] });
        return;
    }
    for (const group of body.prompt_order) {
        if (!group || typeof group !== 'object') continue;
        if (!Array.isArray(group.order)) group.order = [];
        if (group.order.some((item) => normalizePromptIdentifier(item?.identifier) === identifier)) continue;
        if (explicitPosition !== null) {
            const idx = Math.max(0, Math.min(group.order.length, explicitPosition - 1));
            group.order.splice(idx, 0, { ...orderEntry });
        } else {
            group.order.push({ ...orderEntry });
        }
    }
}

function removePromptEntryFromBody(body, identifier) {
    const id = normalizePromptIdentifier(identifier);
    if (!id) return;
    if (Array.isArray(body.prompts)) {
        body.prompts = body.prompts.filter((entry) =>
            normalizePromptIdentifier(entry?.identifier, entry?.id) !== id,
        );
    }
    if (Array.isArray(body.prompt_order)) {
        body.prompt_order = body.prompt_order
            .map((group) => {
                const g = group && typeof group === 'object' ? { ...group } : {};
                g.order = Array.isArray(g.order)
                    ? g.order.filter((item) => normalizePromptIdentifier(item?.identifier) !== id)
                    : [];
                return g;
            })
            .filter((group) => Array.isArray(group.order) && group.order.length > 0);
    }
}

function getOrCreatePromptOrderGroup(body, characterId) {
    const cid = String(characterId ?? '').trim();
    if (!Array.isArray(body.prompt_order)) body.prompt_order = [];
    let group = body.prompt_order.find((entry) => String(entry?.character_id ?? '').trim() === cid);
    if (group && typeof group === 'object') {
        if (!Array.isArray(group.order)) group.order = [];
        return group;
    }
    group = { character_id: cid, order: [] };
    body.prompt_order.push(group);
    return group;
}

function upsertPromptOrderItemInBody(body, edit) {
    const characterId = String(edit?.character_id ?? '').trim();
    const identifier = normalizePromptIdentifier(edit?.identifier);
    const rawPos = Number(edit?.position);
    if (!identifier) throw new Error('identifier is required.');
    if (!Number.isInteger(rawPos) || rawPos < 1) {
        throw new Error('1-based position is required.');
    }
    const group = getOrCreatePromptOrderGroup(body, characterId);
    const nextOrder = (Array.isArray(group.order) ? group.order : [])
        .filter((item) => normalizePromptIdentifier(item?.identifier) !== identifier);
    const enabled = Object.hasOwn(edit, 'enabled') ? Boolean(edit.enabled) : true;
    const targetIndex = Math.max(0, Math.min(nextOrder.length, rawPos - 1));
    nextOrder.splice(targetIndex, 0, { identifier, enabled });
    group.order = nextOrder;
}

function removePromptOrderItemFromBody(body, characterId, identifier) {
    const cid = String(characterId ?? '').trim();
    const id = normalizePromptIdentifier(identifier);
    if (!id || !Array.isArray(body.prompt_order)) return;
    body.prompt_order = body.prompt_order
        .map((group) => {
            if (String(group?.character_id ?? '').trim() !== cid) return group;
            const g = group && typeof group === 'object' ? { ...group } : { character_id: cid };
            g.order = Array.isArray(g.order)
                ? g.order.filter((item) => normalizePromptIdentifier(item?.identifier) !== id)
                : [];
            return g;
        })
        .filter((group) => Array.isArray(group.order) && group.order.length > 0);
}

/**
 * Emit coarse `set` edits for whichever of {prompts, prompt_order} the
 * sandbox actually changed compared to live. Same-content arrays are
 * skipped so no-op tool calls don't pollute the staged-edit list.
 *
 * TODO(CPA-7): refactor to emit per-entry edits (one `set` op per modified
 * prompts[i] / prompt_order[i].order[j]) instead of a single full-array
 * dump. The current full-array `set` keeps conflict resolution simple but
 * makes the diff card show the entire array as "changed" even when only
 * one entry moved. The shared library's per-leaf split for non-empty
 * paths (C-LIB-3) will cover most of this once it lands; until then,
 * preserving the full-array shape avoids regressing the existing flow.
 */
function buildPromptAwareEdits(live, sandbox) {
    const edits = [];
    if (!lodash.isEqual(live?.prompts, sandbox?.prompts)) {
        edits.push({
            op: 'set',
            path: 'prompts',
            oldValue: structuredClone(live?.prompts ?? null),
            newValue: structuredClone(sandbox?.prompts ?? null),
        });
    }
    if (!lodash.isEqual(live?.prompt_order, sandbox?.prompt_order)) {
        edits.push({
            op: 'set',
            path: 'prompt_order',
            oldValue: structuredClone(live?.prompt_order ?? null),
            newValue: structuredClone(sandbox?.prompt_order ?? null),
        });
    }
    return edits;
}

export function buildToolCatalog({ hasReference = false } = {}) {
    const tools = [
        // ---- Generic edit primitives ----
        {
            type: 'function',
            function: {
                name: 'preset_set_field',
                description: 'Set or replace a single preset field by lodash-style path. value_json must be valid JSON text.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Lodash-style path, e.g. temperature or prompts[0].content.' },
                        value_json: { type: 'string', description: 'JSON text of the new value.' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'value_json'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_str_replace',
                description: 'Replace a unique substring inside a string-valued preset field. Cheaper than rewriting the whole field and surfaces drift if surrounding text changed externally. `find` must occur exactly expected_count times (default 1).',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        find: { type: 'string' },
                        replace: { type: 'string' },
                        expected_count: { type: 'integer' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'find', 'replace'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_str_insert',
                description: 'Insert text immediately after a unique anchor substring in a string-valued preset field. `after_text` must occur exactly expected_count times (default 1).',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        after_text: { type: 'string' },
                        insert_text: { type: 'string' },
                        expected_count: { type: 'integer', minimum: 1, default: 1, description: 'Number of expected matches for "after_text" (default 1). The op fails if matches != expected_count.' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'after_text', 'insert_text'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_str_delete',
                description: 'Remove a unique substring from a string-valued preset field. `find` must occur exactly expected_count times (default 1).',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        find: { type: 'string' },
                        expected_count: { type: 'integer', minimum: 1, default: 1, description: 'Number of expected matches for "find" (default 1). The op fails if matches != expected_count.' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'find'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_list_insert',
                description: 'Insert a value into an array-valued preset field. Anchor specifies position. For prompts[] / prompt_order[*].order, prefer the prompt-specific tools instead.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        anchor: { description: '{ after: index } or { before: index }.' },
                        value: { description: 'Value to insert.' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'anchor', 'value'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_list_remove',
                description: 'Remove an element from an array-valued preset field at a given index.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        index: { type: 'integer' },
                        expected_value: { description: 'Optional snapshot of the value at index for drift detection.' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'index'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_list_move',
                description: 'Move an element within an array-valued preset field.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        from_index: { type: 'integer' },
                        to_index: { type: 'integer' },
                        expected_value: { description: 'Optional snapshot of the value at from_index.' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'from_index', 'to_index'],
                },
            },
        },
        // ---- Prompt-aware tools ----
        {
            type: 'function',
            function: {
                name: 'preset_upsert_prompt_entry',
                description: 'Create or update one prompts[] entry by identifier. When CREATING a new entry, this also inserts {identifier, enabled} into every existing prompt_order group so the new entry is immediately active — pass `position` (1-based) to control where it lands, otherwise it appends to the end. Pass auto_add_to_order: false to skip prompt_order entirely. UPDATES never touch prompt_order. Prefer this over raw preset_list_insert on prompts[] for adding new entries.',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string', description: 'Stable prompt identifier (e.g. "main", "nsfw", "jailbreak", or a uuid).' },
                        content: { type: 'string', description: 'Prompt text. Required when creating a new entry.' },
                        role: { type: 'string', description: 'Optional role: system / user / assistant.' },
                        enabled: { type: 'boolean' },
                        name: { type: 'string' },
                        marker: { type: 'boolean' },
                        injection_position: { type: 'number' },
                        injection_depth: { type: 'number' },
                        injection_order: { type: 'number' },
                        position: { type: 'integer', description: '1-based slot inside each prompt_order group. Only honoured when creating a new entry. Clamped per group, so a value past the end appends. Omit (default) to append to every group.' },
                        auto_add_to_order: { type: 'boolean', description: 'Default true when creating. Set false to leave the new entry out of prompt_order (it will be inert until placed via preset_upsert_prompt_order_item).' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_remove_prompt_entry',
                description: 'Remove one prompts[] entry by identifier and also strip it from every prompt_order group.',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_upsert_prompt_order_item',
                description: 'Insert or move one prompt_order item. position is 1-based within the target character_id group. If the group does not yet exist, it is created. Use this to place an entry that was created with auto_add_to_order: false, or to re-position an existing entry.',
                parameters: {
                    type: 'object',
                    properties: {
                        character_id: { type: 'string', description: 'Group identifier ("" for the default group, or a character id like "100001").' },
                        identifier: { type: 'string' },
                        position: { type: 'integer', description: '1-based position within the group.' },
                        enabled: { type: 'boolean' },
                        reason: { type: 'string' },
                    },
                    required: ['character_id', 'identifier', 'position'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_remove_prompt_order_item',
                description: 'Remove one prompt_order item by character_id and identifier. The underlying prompts[] entry is left untouched — use preset_remove_prompt_entry to delete it entirely.',
                parameters: {
                    type: 'object',
                    properties: {
                        character_id: { type: 'string' },
                        identifier: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['character_id', 'identifier'],
                },
            },
        },
    ];

    if (hasReference) {
        tools.push({
            type: 'function',
            function: {
                name: 'preset_copy_from_reference',
                description: 'Copy one field from the selected reference preset into the current live preset. Use from_path when source and target paths differ.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        from_path: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path'],
                },
            },
        });
    }

    // ---- Control / inspection tools ----
    tools.push(
        {
            type: 'function',
            function: {
                name: 'preset_read_live_fields',
                description: 'Read exact values from the current live preset by lodash-style paths, without modifying anything.',
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['paths'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_diff_reference',
                description: hasReference
                    ? 'Structural diff of the current live preset against the selected reference preset. Returns changed paths plus a prompt-layout outline for both sides. Optionally narrow to specific lodash-style paths.'
                    : 'Reference diff is unavailable — no reference preset is selected.',
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_simulate',
                description: 'Simulate prompt assembly for the current preset. Prefer `text` to append one user message to the current chat; use `messages` only when the user already supplied a structured message array.',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                        messages: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    role: { type: 'string' },
                                    content: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_clone_to_new',
                description: 'Clone the current live preset under a new name and switch the popup target to the clone. Use before destructive edits when the user wants to keep the original intact. Fails if new_name already exists.',
                parameters: {
                    type: 'object',
                    properties: {
                        new_name: { type: 'string', description: 'Name for the cloned preset. Must be unique.' },
                        reason: { type: 'string', description: 'Why deriving instead of editing in place.' },
                    },
                    required: ['new_name'],
                    additionalProperties: false,
                },
            },
        },
    );

    if (hasReference) {
        tools.push({
            type: 'function',
            function: {
                name: 'preset_read_reference_fields',
                description: 'Read exact values from the selected reference preset by lodash-style paths (read-only).',
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['paths'],
                },
            },
        });
    }

    // Control tools — these steer the multi-round auto-continue loop. They
    // never normalize to edits (filtered out via CONTROL_TOOL_NAME_SET in the
    // popup) and are passed to the runner's `isControlCall` predicate so the
    // runner routes them to `onControlCall` for popup-state mutation rather
    // than the assistant message body.
    tools.push({
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.continue,
            description: 'Request one automatic follow-up round after the current tools have run. Use only when more iteration is genuinely needed; otherwise call luker_cpa_finalize_iteration.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    });
    tools.push({
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.finalize,
            description: 'Finalize this iteration turn with a concise summary. The popup stops auto-continuing after this call.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'Short user-facing summary of what changed.' },
                },
                additionalProperties: false,
            },
        },
    });

    return tools;
}

export function classifyToolCall(call) {
    return EDITABLE_TOOL_NAMES.has(call?.function?.name) ? 'editable' : 'control';
}

/**
 * Execute one read tool synchronously and return its result. The studio
 * loop runs this inline per read call so the next round's taskMessages
 * carry the tool_result (mirroring CEA editor + Orchestrator iter popups).
 *
 * Resolves `{ ok: true, result: <payload> }` on success and `{ ok: false,
 * error: string }` on a known failure (no reference selected, missing
 * paths, etc.). The studio wraps unknown throws into `{ ok: false }` too.
 *
 * ctx shape:
 *   - live              the current live preset body (state.live)
 *   - reference         the loaded reference preset body, or null
 *   - referenceName     name of the reference preset, or ''
 *   - presetName        name of the live preset (state.targetName)
 *   - context           SillyTavern context (used by preset_simulate)
 *   - getContext        optional callable that returns the SillyTavern context
 */
export async function runCpaReadTool(call, ctx = {}) {
    const name = String(call?.name || '');
    const args = (call?.args && typeof call.args === 'object') ? call.args : {};

    if (name === 'preset_read_live_fields') {
        const paths = normalizeReadPaths(args);
        if (paths.length === 0) {
            return { ok: false, error: 'preset_read_live_fields requires at least one path.' };
        }
        const live = isPlainObject(ctx?.live) ? ctx.live : {};
        return {
            ok: true,
            result: {
                presetName: String(ctx?.presetName || '').trim(),
                source: 'live',
                values: buildPresetFieldReadResult(live, paths),
            },
        };
    }

    if (name === 'preset_read_reference_fields') {
        const reference = isPlainObject(ctx?.reference) ? ctx.reference : null;
        if (!reference) {
            return { ok: false, error: 'No reference preset is selected.' };
        }
        const paths = normalizeReadPaths(args);
        if (paths.length === 0) {
            return { ok: false, error: 'preset_read_reference_fields requires at least one path.' };
        }
        return {
            ok: true,
            result: {
                presetName: String(ctx?.referenceName || '').trim(),
                source: 'reference',
                values: buildPresetFieldReadResult(reference, paths),
            },
        };
    }

    if (name === 'preset_diff_reference') {
        const reference = isPlainObject(ctx?.reference) ? ctx.reference : null;
        if (!reference) {
            return { ok: false, error: 'No reference preset is selected.' };
        }
        const live = isPlainObject(ctx?.live) ? ctx.live : {};
        const narrowPaths = normalizeReadPaths(args);
        const differing_paths = computeDifferingPaths(live, reference, narrowPaths);
        return {
            ok: true,
            result: {
                livePresetName: String(ctx?.presetName || '').trim(),
                referencePresetName: String(ctx?.referenceName || '').trim(),
                differing_paths,
                live_outline: buildPromptLayoutOutline(live),
                reference_outline: buildPromptLayoutOutline(reference),
            },
        };
    }

    if (name === 'preset_simulate') {
        const stContext = ctx?.context || (typeof ctx?.getContext === 'function' ? ctx.getContext() : null);
        if (!stContext || typeof stContext.buildPresetAwarePromptMessages !== 'function') {
            return { ok: false, error: 'Prompt preset simulator is unavailable in this environment.' };
        }
        const text = String(args.text || '').trim();
        const messages = Array.isArray(args.messages) ? args.messages : null;
        const source = buildSimulateSourceMessages(stContext, { text, messages });
        if (!source || source.messages.length === 0) {
            return { ok: false, error: 'preset_simulate requires either text or messages.' };
        }
        try {
            const runtimeWorldInfo = typeof stContext.resolveWorldInfoForMessages === 'function'
                ? await stContext.resolveWorldInfoForMessages(source.messages, {
                    type: 'quiet',
                    fallbackToCurrentChat: false,
                })
                : {};
            const promptMessages = stContext.buildPresetAwarePromptMessages({
                messages: source.messages,
                envelopeOptions: { includeCharacterCard: true, api: 'openai' },
                runtimeWorldInfo,
            });
            const assembled_length = Array.isArray(promptMessages)
                ? promptMessages.reduce((sum, m) => sum + String(m?.content || '').length, 0)
                : 0;
            return {
                ok: true,
                result: {
                    mode: source.mode,
                    sourceMessages: source.messages,
                    promptMessages,
                    assembled_length,
                },
            };
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'simulate failed') };
        }
    }

    if (name === 'preset_clone_to_new') {
        const newName = String(args?.new_name || '').trim();
        if (!newName) return { ok: false, error: 'preset_clone_to_new requires a non-empty new_name.' };
        if (typeof ctx?.cloneAndSwitchTarget !== 'function') {
            return { ok: false, error: 'preset_clone_to_new is not wired in this popup (deps.cloneAndSwitchTarget missing).' };
        }
        try {
            const out = await ctx.cloneAndSwitchTarget(newName);
            if (out?.ok) return { ok: true, result: { new_name: newName, cloned: true } };
            return { ok: false, error: String(out?.error || 'clone failed') };
        } catch (err) {
            return { ok: false, error: String(err?.message || err || 'clone failed') };
        }
    }

    return { ok: false, error: `Unknown read tool: ${name}` };
}

function normalizeReadPaths(args) {
    const list = Array.isArray(args?.paths) ? args.paths : [];
    const seen = new Set();
    for (const item of list) {
        const trimmed = String(item || '').trim();
        if (trimmed) seen.add(trimmed);
    }
    return [...seen];
}

function buildPresetFieldReadResult(body, paths) {
    return paths.map((path) => ({
        path,
        exists: lodash.has(body, path),
        value: cloneJsonish(lodash.get(body, path)),
    }));
}

function cloneJsonish(value) {
    if (value === undefined) return null;
    try {
        return structuredClone(value);
    } catch {
        try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
    }
}

function computeDifferingPaths(live, reference, narrowPaths) {
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const out = [];
    function walk(prefix, a, b) {
        if (a === b) return;
        const aIsObj = isObj(a);
        const bIsObj = isObj(b);
        if (!aIsObj || !bIsObj) {
            // Leaf or container-shape change.
            if (JSON.stringify(a) !== JSON.stringify(b)) {
                out.push(prefix || '(root)');
            }
            return;
        }
        const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
        for (const k of keys) {
            walk(prefix ? `${prefix}.${k}` : k, a?.[k], b?.[k]);
        }
    }
    if (narrowPaths.length > 0) {
        for (const p of narrowPaths) {
            const aSub = lodash.get(live, p);
            const bSub = lodash.get(reference, p);
            walk(p, aSub, bSub);
        }
    } else {
        walk('', live, reference);
    }
    return out;
}

function buildPromptLayoutOutline(body) {
    const prompts = Array.isArray(body?.prompts) ? body.prompts : [];
    const promptIndex = new Map();
    for (const p of prompts) {
        const id = normalizePromptIdentifier(p?.identifier, p?.id);
        if (!id) continue;
        promptIndex.set(id, {
            identifier: id,
            role: String(p?.role || 'system'),
            name: String(p?.name || ''),
            content_length: String(p?.content || '').length,
        });
    }
    const groups = Array.isArray(body?.prompt_order) ? body.prompt_order : [];
    return groups.map((group) => ({
        character_id: group?.character_id ?? null,
        order: (Array.isArray(group?.order) ? group.order : []).map((item) => {
            const id = normalizePromptIdentifier(item?.identifier);
            const meta = promptIndex.get(id);
            return {
                identifier: id,
                enabled: item?.enabled !== false,
                role: meta?.role || 'system',
                name: meta?.name || '',
                content_length: meta?.content_length || 0,
            };
        }),
    }));
}

function buildSimulateSourceMessages(context, { text, messages }) {
    if (messages && messages.length > 0) {
        return { mode: 'messages', messages };
    }
    if (text) {
        const existingChat = Array.isArray(context?.chat) ? context.chat : [];
        const carry = existingChat
            .filter((m) => m && typeof m === 'object')
            .map((m) => ({
                role: m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'),
                content: String(m.mes || ''),
            }));
        return {
            mode: 'text',
            messages: [...carry, { role: 'user', content: text }],
        };
    }
    return { mode: 'empty', messages: [] };
}

export async function normalizeToolCallToEdit(call, ctx) {
    const name = call?.function?.name;
    const args = parseArgs(call);
    if (args === null) return null;
    const live = isPlainObject(ctx?.live) ? ctx.live : {};

    if (name === 'preset_set_field') {
        const value = (() => {
            if (Object.hasOwn(args, 'value')) return args.value;
            if (typeof args.value_json === 'string') {
                try { return JSON.parse(args.value_json); }
                catch { throw new Error(`Invalid JSON for ${args.path}: ${args.value_json}`); }
            }
            return undefined;
        })();
        return [{
            op: 'set',
            path: args.path,
            oldValue: lodash.get(live, args.path),
            newValue: value,
        }];
    }
    if (name === 'preset_str_replace') {
        return [{
            op: 'str_replace',
            path: args.path,
            find: args.find,
            replace: args.replace,
            expected_count: args.expected_count,
        }];
    }
    if (name === 'preset_str_insert') {
        assertStrOpUniqueness({
            path: args.path,
            value: lodash.get(live, args.path),
            needle: args.after_text,
            expected_count: args.expected_count,
            opLabel: 'preset_str_insert',
        });
        return [{
            op: 'str_insert',
            path: args.path,
            after_text: args.after_text,
            insert_text: args.insert_text,
        }];
    }
    if (name === 'preset_str_delete') {
        assertStrOpUniqueness({
            path: args.path,
            value: lodash.get(live, args.path),
            needle: args.find,
            expected_count: args.expected_count,
            opLabel: 'preset_str_delete',
        });
        return [{
            op: 'str_delete',
            path: args.path,
            find: args.find,
        }];
    }
    if (name === 'preset_list_insert') {
        return [{
            op: 'list_insert',
            path: args.path,
            anchor: args.anchor,
            value: args.value,
        }];
    }
    if (name === 'preset_list_remove') {
        const list = lodash.get(live, args.path) || [];
        return [{
            op: 'list_remove',
            path: args.path,
            index: args.index,
            expected_value: args.expected_value ?? list[args.index],
        }];
    }
    if (name === 'preset_list_move') {
        const list = lodash.get(live, args.path) || [];
        return [{
            op: 'list_move',
            path: args.path,
            from_index: args.from_index,
            to_index: args.to_index,
            expected_value: args.expected_value ?? list[args.from_index],
        }];
    }

    // Prompt-aware tools: apply to a sandbox clone of live, emit
    // coarse `set` edits on the two arrays that may have changed
    // (prompts and/or prompt_order). Two coarse sets are still
    // strictly less than a `set` on the entire live body, and they
    // keep the conflict-resolution UI scoped to the affected
    // collections instead of the whole preset.
    if (name === 'preset_upsert_prompt_entry') {
        const sandbox = structuredClone(live);
        upsertPromptEntryInBody(sandbox, args);
        return buildPromptAwareEdits(live, sandbox);
    }
    if (name === 'preset_remove_prompt_entry') {
        const sandbox = structuredClone(live);
        removePromptEntryFromBody(sandbox, args.identifier);
        return buildPromptAwareEdits(live, sandbox);
    }
    if (name === 'preset_upsert_prompt_order_item') {
        const sandbox = structuredClone(live);
        upsertPromptOrderItemInBody(sandbox, args);
        return buildPromptAwareEdits(live, sandbox);
    }
    if (name === 'preset_remove_prompt_order_item') {
        const sandbox = structuredClone(live);
        removePromptOrderItemFromBody(sandbox, args.character_id, args.identifier);
        return buildPromptAwareEdits(live, sandbox);
    }

    if (name === 'preset_copy_from_reference') {
        const refName = ctx?.session?.surfaceState?.referencePresetName;
        if (!refName) throw new Error('No reference preset selected.');
        if (typeof ctx?.getReferencePresetBody !== 'function') {
            throw new Error('getReferencePresetBody is required to copy from reference.');
        }
        const refBody = await ctx.getReferencePresetBody(refName);
        const fromPath = String(args.from_path || args.path || '').trim();
        const toPath = String(args.path || '').trim();
        if (!fromPath || !toPath) return [];
        const sourceValue = lodash.get(refBody, fromPath);
        if (sourceValue === undefined) {
            throw new Error(`Reference path not found: ${fromPath}`);
        }
        return [{
            op: 'set',
            path: toPath,
            oldValue: lodash.get(live, toPath),
            newValue: structuredClone(sourceValue),
        }];
    }

    return [];
}
