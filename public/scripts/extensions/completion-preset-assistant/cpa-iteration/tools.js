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

const __ctx = SillyTavern.getContext();
const lodash = __ctx.lib.lodash;
const generateQuietPrompt = __ctx.generateQuietPrompt;
import { openSimulationReview } from '../../../iteration-library/simulation-review/index.js';
import { extractWorldInfoHitsFromRuntime } from '../../../iteration-library/simulation-review/wi-hits.js';
import {
    extractSystemFromCapturedPrompt,
    extractNonSystemFromCapturedPrompt,
} from '../../../iteration-library/simulation-review/dry-run-capture.js';
import {
    SKILL_ITER_STUDIO_TOOL_DEFS,
    runSkillIterStudioTool,
} from '../../orchestrator/skill-iter-studio-tools.js';

// ────────────────────────────────────────────────────────────────────────────
// Skill toolset exposed by CPA's iteration studio. Mirrors the orchestrator
// iter-studio's catalog so the AI can convert preset-side style / format rules
// into skills as part of the same conversation. Two intentional deltas from
// the orchestrator's 17-tool catalog:
//
//   - The 3 policy-binding tools (`skill_bind_to_agent`,
//     `skill_unbind_from_agent`, `skill_set_mode_defaults`) require an
//     orchestrator working profile to mutate. CPA edits a preset body, not
//     an orchestrator profile, so they would have nothing meaningful to bind
//     against. The system prompt tells the AI to author the skill here and
//     bind it from the orchestrator iter-studio when the user wants it
//     attached to a specific agent.
//
//   - `skill_replace_in_systemprompt` walks an agent's `systemPrompt` field.
//     CPA's analogous surface is `prompts[].content` on the preset, which
//     the existing `preset_read_live_fields` + `preset_str_delete_in_prompt`
//     + `preset_str_insert_in_prompt` tools already cover. The system prompt
//     documents the splice-in-pointer workflow so the AI uses those tools
//     after `skill_create` / `skill_extract_from_text`.
//
// `skill_extract_from_text` IS exposed — it has no working-profile dependency
// (it only takes a verbatim text body and a name), and it carries the same
// "verbatim, don't paraphrase" discipline that motivates extraction in the
// first place.
// ────────────────────────────────────────────────────────────────────────────
const CPA_SKILL_TOOL_NAME_LIST = Object.freeze([
    // Inventory inspection (4)
    'skill_list_visible',
    'skill_inspect',
    'skill_read_content',
    'skill_search_content',
    // Authoring (7)
    'skill_create',
    'skill_update_content',
    'skill_edit_content',
    'skill_update_frontmatter',
    'skill_rename',
    'skill_change_scope',
    'skill_delete',
    // Verbatim extraction helper (1 of the 3 orchestrator migration helpers
    // that is profile-independent — the other two operate on agent
    // systemPrompts, which CPA does not have).
    'skill_extract_from_text',
]);

export const CPA_SKILL_TOOL_NAMES = new Set(CPA_SKILL_TOOL_NAME_LIST);

export const CPA_SKILL_TOOL_DEFS = Object.freeze(
    SKILL_ITER_STUDIO_TOOL_DEFS.filter(
        (def) => CPA_SKILL_TOOL_NAMES.has(String(def?.function?.name || '')),
    ),
);

export function isCpaSkillTool(name) {
    return CPA_SKILL_TOOL_NAMES.has(String(name || ''));
}

/**
 * Dispatch one skill tool call. CPA exposes the iter-studio's pure server-side
 * handlers (inventory + authoring + verbatim extract); none of them need a
 * working profile, so `mutationCtx.getWorkingProfile` returns null. The result
 * shape mirrors `runSkillIterStudioTool` minus the `pendingEdit` branch —
 * none of the CPA-exposed handlers mutate a profile.
 *
 * @param {{ id?: string, name: string, args: object }} call
 * @returns {Promise<{ok: true, result: *} | {ok: false, error: string}>}
 */
export async function runCpaSkillTool(call) {
    const out = await runSkillIterStudioTool(call, { getWorkingProfile: () => null });
    if (out && out.ok && 'pendingEdit' in out) {
        // Defensive: the 12 tools CPA exposes never produce pendingEdit, but
        // strip it if anything ever leaks so studio.js doesn't try to thread
        // an orchestrator-shaped edit into the preset's edit pipeline.
        return { ok: true, result: out.result };
    }
    return out;
}

export const EDITABLE_TOOL_NAMES = new Set([
    'preset_set_field',
    'preset_str_replace',
    'preset_str_insert',
    'preset_str_delete',
    'preset_str_replace_in_prompt',
    'preset_str_insert_in_prompt',
    'preset_str_delete_in_prompt',
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
    preset_str_replace_in_prompt:    '🔄 Replace text in prompt',
    preset_str_insert_in_prompt:     '➕ Insert text in prompt',
    preset_str_delete_in_prompt:     '➖ Delete text in prompt',
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
    // Skill toolset (orchestrator-optimize mode). Legacy string-shape labels
    // for the buildToolCatalog "every tool has a display label" contract;
    // the rich icon+label+summarize entries the studio actually renders live
    // in tool-display.js#CPA_TOOL_DISPLAY.
    skill_list_visible:              '📚 List skills',
    skill_inspect:                   '🔎 Inspect skill',
    skill_read_content:              '📖 Read skill file',
    skill_search_content:            '🔍 Search skill',
    skill_create:                    '🆕 Create skill',
    skill_update_content:            '✏️ Overwrite skill file',
    skill_edit_content:              '🩹 Patch skill file',
    skill_update_frontmatter:        '🏷️ Update skill frontmatter',
    skill_rename:                    '🔤 Rename skill',
    skill_change_scope:              '📦 Move skill scope',
    skill_delete:                    '🗑️ Delete skill',
    skill_extract_from_text:         '✂️ Extract skill from text',
});

/**
 * CPA has no popup-side control tools at this time. The multi-round
 * auto-continue loop is program-driven by tool-call presence (any tool
 * call → next round, none → stop), so no `continue_iteration` /
 * `finalize_iteration` control tools are exposed to the LLM. The empty
 * map + predicate stay here so the runner's `isControlCall` callback
 * keeps a stable shape across popups.
 */
export const CONTROL_TOOL_NAMES = Object.freeze({});
export const CONTROL_TOOL_NAME_SET = new Set();
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
    // NOTE: prompts[].enabled is unused by the OpenAI preset runtime — the
    // authoritative enabled flag lives on prompt_order[*].order[*]. We don't
    // write entry.enabled here; the `enabled` arg is routed to prompt_order
    // below (existing entries: flip every referencing group's item; new
    // entries: stamp the initial orderEntry). Previous versions wrote
    // next.enabled directly and silently no-op'd the user's intent for
    // existing entries.
    if (Object.hasOwn(edit, 'name'))               next.name = String(edit.name ?? '').trim();
    if (Object.hasOwn(edit, 'marker'))             next.marker = Boolean(edit.marker);
    if (Object.hasOwn(edit, 'injection_position')) next.injection_position = edit.injection_position;
    if (Object.hasOwn(edit, 'injection_depth'))    next.injection_depth = edit.injection_depth;
    if (Object.hasOwn(edit, 'injection_order'))    next.injection_order = edit.injection_order;
    // Intentionally do NOT write next.enabled here, even if `current` has
    // an `enabled` field on disk (some preset files carry it as a legacy
    // residue). The OpenAI preset runtime ignores prompts[].enabled; the
    // authoritative flag is prompt_order[*].order[*].enabled. Routing the
    // user-supplied `enabled` arg there happens below.

    if (!isCreate) {
        body.prompts[promptIndex] = next;
        // For an existing entry, route the `enabled` arg (if provided) to
        // every prompt_order group that already references this identifier.
        // Without this, AIs that intend to "disable entry X" by passing
        // enabled:false silently no-op'd — prompts[i].enabled is ignored at
        // generation time, so flipping it alone changes nothing observable.
        if (Object.hasOwn(edit, 'enabled') && Array.isArray(body.prompt_order)) {
            const wantEnabled = Boolean(edit.enabled);
            for (const group of body.prompt_order) {
                if (!group || !Array.isArray(group.order)) continue;
                for (let i = 0; i < group.order.length; i++) {
                    const item = group.order[i];
                    if (item && normalizePromptIdentifier(item.identifier) === identifier) {
                        group.order[i] = { ...item, enabled: wantEnabled };
                    }
                }
            }
        }
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
        // ---- Identifier-keyed prompt-content edits ----
        //
        // prompts[] is a JS Array — `prompts[<identifier>]` does not resolve.
        // The path-based preset_str_* tools above require the AI to compute
        // the correct numeric array index, which is fragile across rounds
        // (new entries append, the outline orders by prompt_order position
        // rather than array index). These three tools take the entry's
        // stable identifier and let the normalize layer resolve the index
        // exactly once, against the live state at apply time. PREFER these
        // over preset_str_* when targeting a prompts[] entry's content.
        {
            type: 'function',
            function: {
                name: 'preset_str_replace_in_prompt',
                description: 'Replace a unique substring inside a prompts[] entry\'s content, addressed by stable identifier (uuid). Use this instead of preset_str_replace on prompts[N].content — you do not have to compute the array index, and the index resolves at apply time so concurrent reorders cannot drift it. `find` must occur exactly expected_count times (default 1).',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string', description: 'Stable prompt identifier (the entry.identifier field, e.g. a uuid).' },
                        find: { type: 'string' },
                        replace: { type: 'string' },
                        expected_count: { type: 'integer', minimum: 1, default: 1, description: 'Number of expected matches for "find" (default 1). The op fails if matches != expected_count.' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier', 'find', 'replace'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_str_insert_in_prompt',
                description: 'Insert text immediately after a unique anchor substring inside a prompts[] entry\'s content, addressed by stable identifier. Use this instead of preset_str_insert on prompts[N].content. `after_text` must occur exactly expected_count times (default 1).',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string', description: 'Stable prompt identifier (the entry.identifier field, e.g. a uuid).' },
                        after_text: { type: 'string' },
                        insert_text: { type: 'string' },
                        expected_count: { type: 'integer', minimum: 1, default: 1, description: 'Number of expected matches for "after_text" (default 1). The op fails if matches != expected_count.' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier', 'after_text', 'insert_text'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'preset_str_delete_in_prompt',
                description: 'Remove a unique substring from a prompts[] entry\'s content, addressed by stable identifier. Use this instead of preset_str_delete on prompts[N].content. `find` must occur exactly expected_count times (default 1).',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string', description: 'Stable prompt identifier (the entry.identifier field, e.g. a uuid).' },
                        find: { type: 'string' },
                        expected_count: { type: 'integer', minimum: 1, default: 1, description: 'Number of expected matches for "find" (default 1). The op fails if matches != expected_count.' },
                        reason: { type: 'string' },
                    },
                    required: ['identifier', 'find'],
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
                description: 'Create or update one prompts[] entry by identifier. When CREATING a new entry, this also inserts {identifier, enabled} into every existing prompt_order group so the new entry is immediately active — pass `position` (1-based) to control where it lands, otherwise it appends to the end. Pass auto_add_to_order: false to skip prompt_order entirely. When UPDATING an existing entry, passing `enabled` flips every prompt_order group\'s item for this identifier (because prompts[].enabled is ignored by the runtime — the authoritative flag lives on prompt_order[*].order[*].enabled). Prefer this over raw preset_list_insert on prompts[] for adding new entries.',
                parameters: {
                    type: 'object',
                    properties: {
                        identifier: { type: 'string', description: 'Stable prompt identifier (e.g. "main", "nsfw", "jailbreak", or a uuid).' },
                        content: { type: 'string', description: 'Prompt text. Required when creating a new entry.' },
                        role: { type: 'string', description: 'Optional role: system / user / assistant.' },
                        enabled: { type: 'boolean', description: 'When CREATING: sets the initial prompt_order item.enabled (default true). When UPDATING an existing entry: routed to every prompt_order group\'s item for this identifier — this is the only way to actually toggle whether the entry takes effect at generation. prompts[].enabled is unused by the runtime.' },
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
                description: 'Simulate the current preset against the live chat, world info, and character card. Pass text=<user turn> and the simulator appends it to the active chat, runs a real (non-persisted) generation, and opens a popup for the user to review. The messages mode is currently unsupported by the generation backend; pass text instead.',
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

    // Skill toolset — always exposed so the AI can lift reusable style /
    // format rules out of preset content and into shareable skills as part
    // of the same conversation. See system-prompts.js + skill-prompt.js for
    // the discipline the AI is asked to follow.
    for (const def of CPA_SKILL_TOOL_DEFS) tools.push(def);

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
        // SillyTavern's stContext.t is the template-tag function
        // t(strings, ...values); the simulation-review module needs a
        // (key, fallback)-shaped helper. stContext.translate(text, key)
        // looks the fallback string up by key and returns the fallback
        // unchanged when no translation exists.
        const translateFn = typeof stContext?.translate === 'function'
            ? stContext.translate
            : (typeof globalThis !== 'undefined' && globalThis.__i18n && typeof globalThis.__i18n.translate === 'function'
                ? globalThis.__i18n.translate
                : null);
        const i18nFn = (k, fb) => (translateFn ? translateFn(fb || k, k) : (fb || k));
        const text = String(args.text || '').trim();
        const messages = Array.isArray(args.messages) ? args.messages : null;
        const source = buildSimulateSourceMessages(stContext, { text, messages });
        if (!source || source.messages.length === 0) {
            return { ok: false, error: 'preset_simulate requires either text or messages.' };
        }
        if (source.mode === 'messages') {
            return {
                ok: false,
                toolResultText: buildPresetSimulationErrorResult(new Error(
                    'preset_simulate does not support the messages-mode input under the current generation backend. Pass text=<single user turn> and the simulator will append it to the live chat.',
                )),
            };
        }
        try {
            const runOneCpaSimulationAttempt = async () => {
                const runtimeWorldInfo = typeof stContext.resolveWorldInfoForMessages === 'function'
                    ? await stContext.resolveWorldInfoForMessages(source.messages, {
                        type: 'quiet',
                        fallbackToCurrentChat: false,
                    })
                    : {};

                // Subscribe to CHAT_COMPLETION_PROMPT_READY during the real
                // generateQuietPrompt call so the popup's assembledPrompt
                // reflects the actual prompt array the model receives —
                // including token-budget pruning, system-message squashing,
                // and any extension-driven mutation. Register the listener
                // last so it fires after extension hooks (those typically
                // register with `on`, not `makeLast`). If capture fails, we
                // fall back to the parallel buildPresetAwarePromptMessages
                // path below so the popup still renders something.
                const src = stContext?.eventSource ?? null;
                const eventName = stContext?.eventTypes?.CHAT_COMPLETION_PROMPT_READY
                    ?? 'chat_completion_prompt_ready';
                let capturedPromptArray = null;
                const listener = (eventData) => {
                    const chat = Array.isArray(eventData) ? eventData : eventData?.chat;
                    if (!Array.isArray(chat)) return;
                    try { capturedPromptArray = structuredClone(chat); }
                    catch { capturedPromptArray = chat; }
                };
                const registerLast = src && typeof src.makeLast === 'function'
                    ? src.makeLast.bind(src)
                    : src?.on?.bind(src);
                if (registerLast) registerLast(eventName, listener);

                // Run the real (non-persisting) generation so the popup
                // shows the model's actual output, not just the assembled
                // prompt. generateQuietPrompt routes through Generate('quiet'),
                // which executes the full pipeline (WI, regex, depth, preset,
                // group routing) without writing the result to chat.
                const lastUserMsg = source.messages.slice().reverse().find(m => m.role === 'user' || m.is_user);
                const quietPrompt = String(lastUserMsg?.content || lastUserMsg?.mes || '');
                let finalOutput = '';
                try {
                    const generated = await generateQuietPrompt({
                        quietPrompt,
                        quietToLoud: false,
                        skipWIAN: false,
                        removeReasoning: false,
                    });
                    finalOutput = String(generated || '');
                } finally {
                    if (src && typeof src.removeListener === 'function') {
                        try { src.removeListener(eventName, listener); } catch (_) { /* best-effort */ }
                    }
                }

                let assembledPrompt;
                let promptMessagesForCaller;
                if (Array.isArray(capturedPromptArray) && capturedPromptArray.length > 0) {
                    assembledPrompt = {
                        systemPrompt: extractSystemFromCapturedPrompt(capturedPromptArray),
                        messages: extractNonSystemFromCapturedPrompt(capturedPromptArray),
                    };
                    promptMessagesForCaller = capturedPromptArray;
                } else {
                    const promptMessages = stContext.buildPresetAwarePromptMessages({
                        messages: source.messages,
                        envelopeOptions: { includeCharacterCard: true, api: 'openai' },
                        runtimeWorldInfo,
                    });
                    assembledPrompt = {
                        systemPrompt: extractSystemPromptForPresetSimulation(promptMessages),
                        messages: extractNonSystemMessagesForPresetSimulation(promptMessages),
                    };
                    promptMessagesForCaller = promptMessages;
                }

                const worldInfoHits = extractWorldInfoHitsForPresetSimulation(runtimeWorldInfo);
                const payload = {
                    finalOutput,
                    reasoning: '',
                    assembledPrompt,
                    worldInfoHits,
                };
                return { payload, worldInfoHits, promptMessages: promptMessagesForCaller };
            };

            const firstAttempt = await runOneCpaSimulationAttempt();
            const review = await openSimulationReview({
                kind: 'cpa',
                payload: firstAttempt.payload,
                worldInfoHits: firstAttempt.worldInfoHits,
                i18n: i18nFn,
                onRerun: async () => {
                    const next = await runOneCpaSimulationAttempt();
                    return { payload: next.payload, worldInfoHits: next.worldInfoHits };
                },
            });

            return {
                ok: review.ok,
                cancelled: review.cancelled,
                toolResultText: review.toolResultText,
                // Legacy fields kept for any caller still inspecting them.
                result: {
                    mode: source.mode,
                    sourceMessages: source.messages,
                    promptMessages: firstAttempt.promptMessages,
                    assembled_length: Array.isArray(firstAttempt.promptMessages)
                        ? firstAttempt.promptMessages.reduce((sum, m) => sum + String(m?.content || '').length, 0)
                        : 0,
                },
            };
        } catch (err) {
            return {
                ok: false,
                cancelled: false,
                toolResultText: buildPresetSimulationErrorResult(err),
                error: String(err?.message || err || 'simulate failed'),
            };
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

function extractSystemPromptForPresetSimulation(promptMessages) {
    if (!Array.isArray(promptMessages)) return '';
    const first = promptMessages.find(m => (m?.role || '').toLowerCase() === 'system');
    return String(first?.content || '');
}

function extractNonSystemMessagesForPresetSimulation(promptMessages) {
    if (!Array.isArray(promptMessages)) return [];
    return promptMessages
        .filter(m => (m?.role || '').toLowerCase() !== 'system')
        .map(m => ({ role: String(m?.role || ''), content: String(m?.content || '') }));
}

// World-info attribution for the simulation-review popup. The runtime
// returned by resolveWorldInfoForMessages now carries an activatedEntries[]
// array with per-entry book + comment names; we delegate to the shared
// extractor in iteration-library/simulation-review/wi-hits.js so CEA and
// CPA stay in sync. The shared helper falls back to walking the
// pre-formatted text buckets if activatedEntries[] is absent (legacy host).
function extractWorldInfoHitsForPresetSimulation(runtimeWorldInfo) {
    return extractWorldInfoHitsFromRuntime(runtimeWorldInfo);
}

function buildPresetSimulationErrorResult(err) {
    return `<simulation_result kind="cpa" ok="false">\n\n<error reason="simulation_failed">\n${String(err?.message || err || '')}\n</error>\n\n</simulation_result>`;
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
    // Identifier-keyed prompt-content tools. Resolve the prompt's array
    // index against the *live* state at normalize time, then delegate to
    // the same op family as the path-based tools above. If the identifier
    // doesn't match any entry, throw — the toolResults path surfaces it
    // as a failed tool reply so the AI learns the identifier is wrong
    // without having to guess at array indices.
    if (name === 'preset_str_replace_in_prompt'
        || name === 'preset_str_insert_in_prompt'
        || name === 'preset_str_delete_in_prompt') {
        const identifier = normalizePromptIdentifier(args?.identifier);
        if (!identifier) {
            throw new Error(`${name} requires a non-empty identifier.`);
        }
        const idx = findPromptEntryIndex(Array.isArray(live?.prompts) ? live.prompts : [], identifier);
        if (idx < 0) {
            throw new Error(`${name}: no prompts[] entry with identifier ${identifier}. Use preset_read_live_fields to inspect the current prompts[] catalog.`);
        }
        const path = `prompts[${idx}].content`;
        const value = lodash.get(live, path);
        if (name === 'preset_str_replace_in_prompt') {
            assertStrOpUniqueness({
                path, value, needle: args.find,
                expected_count: args.expected_count,
                opLabel: 'preset_str_replace_in_prompt',
            });
            return [{
                op: 'str_replace',
                path,
                find: args.find,
                replace: args.replace,
                expected_count: args.expected_count,
            }];
        }
        if (name === 'preset_str_insert_in_prompt') {
            assertStrOpUniqueness({
                path, value, needle: args.after_text,
                expected_count: args.expected_count,
                opLabel: 'preset_str_insert_in_prompt',
            });
            return [{
                op: 'str_insert',
                path,
                after_text: args.after_text,
                insert_text: args.insert_text,
            }];
        }
        // preset_str_delete_in_prompt
        assertStrOpUniqueness({
            path, value, needle: args.find,
            expected_count: args.expected_count,
            opLabel: 'preset_str_delete_in_prompt',
        });
        return [{
            op: 'str_delete',
            path,
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
