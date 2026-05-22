// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph Schema — plugin-owned tool catalog + tool-call normalizer.
 *
 * Ported verbatim from schema-adapter.js (the shell-driven adapter that the
 * Stage 4 popup redo retires). This module exposes only the static, side-
 * effect-free pieces:
 *
 *   - TOOL_DEFS:                OpenAI-style function definitions for the
 *                               three MG schema editing tools (set / remove /
 *                               reorder).
 *   - TOOL_DISPLAY:             friendly UI labels keyed by tool name. The
 *                               labels are raw English strings; callers that
 *                               want i18n must wrap them at the call site
 *                               (this module is pure and has no i18n binding).
 *   - CONTROL_TOOL_NAMES:       names of the runner-side control tools the
 *                               adapter registered for continue/finalize.
 *   - SESSIONS_BUCKET_KEY:      the extension_settings.memory_graph subkey
 *                               under which iteration sessions live. Exposed
 *                               so the session-store wrapper can derive the
 *                               bucket location from a single source.
 *   - applyToolCallToSandbox:   mutates `sandboxSession.workingProfile.schema`
 *                               per the legacy v1 logic. Returns true if the
 *                               list was changed, false otherwise.
 *   - normalizeToolCallToEdit:  async; runs the call through the sandbox and
 *                               emits a single coarse `set('', newSchema)`
 *                               edits-lib op (matches the Task 17 sandbox-diff
 *                               pattern).
 *
 * `normalizeNodeTypeSchema` is the in-extension normalizer that lives in
 * primitives.js. It used to be captured from the adapter's deps closure;
 * after extraction it flows in via the per-call `ctx` argument so this
 * module stays pure and decoupled from main.js.
 */

export const SESSIONS_BUCKET_KEY = 'iterStudioV2Schema';

const TOOL_SET_NODE_TYPE = 'mg_schema_set_node_type';
const TOOL_REMOVE_NODE_TYPE = 'mg_schema_remove_node_type';
const TOOL_REORDER_NODE_TYPES = 'mg_schema_reorder_node_types';

export const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_mg_schema_continue_iteration',
    finalize: 'luker_mg_schema_finalize_iteration',
});

export const TOOL_DISPLAY = Object.freeze({
    [TOOL_SET_NODE_TYPE]: 'set node type',
    [TOOL_REMOVE_NODE_TYPE]: 'remove node type',
    [TOOL_REORDER_NODE_TYPES]: 'reorder node types',
});

function compressionParams() {
    return {
        type: 'object',
        description: 'Hierarchical/flat compression rules. Omit to use defaults.',
        properties: {
            mode: { type: 'string', enum: ['none', 'hierarchical', 'flat'], description: 'none = no compression; hierarchical = fold older entries into summary layers; flat = summarize across depths in a single pass.' },
            threshold: { type: 'integer', minimum: 1, description: 'Compress when N or more entries accumulate at the same level.' },
            fanIn: { type: 'integer', minimum: 2, description: 'How many leaf entries fold into one summary.' },
            maxDepth: { type: 'integer', minimum: 1, description: 'Max compression depth.' },
            keepRecentLeaves: { type: 'integer', minimum: 0, description: 'Always keep N recent leaf entries even when compressing.' },
            summarizeInstruction: { type: 'string', description: 'Optional prompt the compressor uses when generating the summary.' },
        },
        additionalProperties: false,
    };
}

function nodeTypeSchemaParams() {
    return {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Stable snake_case identifier, unique within the schema.' },
            label: { type: 'string', description: 'Human-readable display name.' },
            tableName: { type: 'string', description: 'Optional override for the storage table name.' },
            tableColumns: { type: 'array', items: { type: 'string' }, description: 'Columns this node type stores.' },
            embeddingColumns: { type: 'array', items: { type: 'string' }, description: 'Subset of tableColumns used for vector embedding. Empty = embed all columns.' },
            columnHints: { type: 'object', additionalProperties: { type: 'string' }, description: 'Per-column extraction hints handed to the extraction LLM.' },
            requiredColumns: { type: 'array', items: { type: 'string' }, description: 'Columns the extractor must always fill.' },
            primaryKeyColumns: { type: 'array', items: { type: 'string' }, description: 'Columns that form the natural identity for upsert.' },
            forceUpdate: { type: 'object', additionalProperties: { type: 'boolean' }, description: 'Columns that should overwrite on update rather than merge.' },
            editable: { type: 'boolean', description: 'Whether end-users may edit entries in the graph viewer.' },
            level: { type: 'integer', minimum: 0, description: 'Storage tier (0 = leaf, higher = summary).' },
            extractHint: { type: 'string', description: 'Overall hint for the extraction LLM about when to emit this node type.' },
            extractionInstructions: { type: 'string', description: 'Per-type detailed instructions appended to the extraction system prompt when this type is active this round. Use for type-specific rules (e.g. "at most one event per batch"). Empty = no type-specific appendix.' },
            extractEveryN: { type: 'integer', minimum: 1, description: 'Cadence: this type is extracted only when latestSeq % extractEveryN === 0. 1 (default) = every extraction pass. Larger N for slow-changing tables (e.g. location_state) saves LLM calls.' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Recall keywords; presence in the chat increases retrieval weight.' },
            alwaysInject: { type: 'boolean', description: 'If true, entries are always injected into the prompt (skip recall). Use sparingly — high-volume types will blow the context budget.' },
            latestOnly: { type: 'boolean', description: 'If true, only the most recent entry is retained for this type — good for state-like data.' },
            compression: compressionParams(),
        },
        required: ['id'],
        additionalProperties: false,
    };
}

export const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: TOOL_SET_NODE_TYPE,
            description: 'Upsert a single node type into the schema by id. All provided fields replace the existing entry; omitted fields are not preserved unless they would default to a reasonable value via normalization.',
            parameters: {
                type: 'object',
                properties: { node_type: nodeTypeSchemaParams() },
                required: ['node_type'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_REMOVE_NODE_TYPE,
            description: 'Remove a node type by id. Refuses if it would leave the schema empty.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'id of the node type to remove.' } },
                required: ['id'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_REORDER_NODE_TYPES,
            description: 'Reorder node types by full list of ids in the new order. All current ids must appear exactly once.',
            parameters: {
                type: 'object',
                properties: {
                    ids: { type: 'array', items: { type: 'string' }, description: 'Full list of node-type ids in the new order.' },
                },
                required: ['ids'],
                additionalProperties: false,
            },
        },
    },
];

/**
 * Sandbox-side executor: mutates the provided `sandboxSession.workingProfile.schema`
 * per the legacy v1 logic. Returns true if the list was changed, false otherwise.
 *
 * `ctx.normalizeNodeTypeSchema` is the in-extension normalizer (primitives.js).
 * Both the upsert/remove/reorder branches normalize the new list before
 * stashing it back onto the sandbox session.
 *
 * Throws nothing; malformed input is treated as a no-op.
 *
 * @param {object} call           tool call object
 * @param {object} sandboxSession session-shaped object with workingProfile.schema (mutated)
 * @param {{ normalizeNodeTypeSchema: (schema: any) => any[] }} ctx
 * @returns {boolean}             true if the schema changed
 */
export function applyToolCallToSandbox(call, sandboxSession, ctx) {
    const normalizeNodeTypeSchema = ctx?.normalizeNodeTypeSchema;
    if (typeof normalizeNodeTypeSchema !== 'function') {
        throw new TypeError('applyToolCallToSandbox: ctx.normalizeNodeTypeSchema must be a function');
    }
    const name = String(call?.function?.name || call?.name || '').trim();
    let args = {};
    const rawArgs = call?.function?.arguments ?? call?.args;
    if (rawArgs && typeof rawArgs === 'object') {
        args = rawArgs;
    } else if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs) || {}; } catch { args = {}; }
    }
    const list = Array.isArray(sandboxSession.workingProfile?.schema)
        ? sandboxSession.workingProfile.schema
        : [];

    if (name === TOOL_SET_NODE_TYPE) {
        const nodeType = args?.node_type && typeof args.node_type === 'object' ? args.node_type : null;
        if (!nodeType || !String(nodeType.id || '').trim()) return false;
        const id = String(nodeType.id).trim();
        const existingIndex = list.findIndex(entry => String(entry?.id || '').trim() === id);
        const next = [...list];
        if (existingIndex >= 0) {
            next[existingIndex] = { ...list[existingIndex], ...nodeType, id };
        } else {
            next.push({ ...nodeType, id });
        }
        sandboxSession.workingProfile.schema = normalizeNodeTypeSchema(next);
        return true;
    }

    if (name === TOOL_REMOVE_NODE_TYPE) {
        const id = String(args?.id || '').trim();
        if (!id) return false;
        if (list.length <= 1) return false;
        const next = list.filter(entry => String(entry?.id || '').trim() !== id);
        if (next.length === list.length) return false;
        sandboxSession.workingProfile.schema = normalizeNodeTypeSchema(next);
        return true;
    }

    if (name === TOOL_REORDER_NODE_TYPES) {
        const ids = Array.isArray(args?.ids)
            ? args.ids.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) return false;
        const currentIds = list.map(entry => String(entry?.id || '').trim());
        const sameSet = ids.length === currentIds.length
            && ids.every(id => currentIds.includes(id))
            && currentIds.every(id => ids.includes(id));
        if (!sameSet) return false;
        const byId = new Map(list.map(entry => [String(entry?.id || '').trim(), entry]));
        const next = ids.map(id => byId.get(id)).filter(Boolean);
        sandboxSession.workingProfile.schema = normalizeNodeTypeSchema(next);
        return true;
    }

    // Unknown tool name → no-op in sandbox.
    return false;
}

/**
 * Translate a tool call into an edits-lib op array suitable for the runner.
 *
 * Uses the sandbox-diff pattern: clone live → run the legacy executor against
 * a fake `{ workingProfile: { schema } }` session → emit one coarse
 * `set('', newSchema)` edit. Returns:
 *   - `null` on executor failure (caller treats this distinctly from "no edits")
 *   - `[]`   on no-op (unchanged list, unknown tool, or same-set reorder)
 *   - `[edit]` otherwise
 *
 * @param {object} call tool call object
 * @param {{ live: any, normalizeNodeTypeSchema: (schema: any) => any[] }} ctx
 * @returns {Promise<Array<object>|null>}
 */
export async function normalizeToolCallToEdit(call, ctx) {
    const before = ctx?.live;
    if (!Array.isArray(before)) return [];
    const beforeClone = structuredClone(before);
    const sandboxSession = { workingProfile: { schema: structuredClone(before) } };
    let changed = false;
    try {
        changed = applyToolCallToSandbox(call, sandboxSession, ctx);
    } catch (error) {
        console.warn('[mg-schema-iteration/tools] sandbox executor failed', error);
        return null;
    }
    if (!changed) return [];
    const after = Array.isArray(sandboxSession.workingProfile?.schema)
        ? sandboxSession.workingProfile.schema
        : [];
    try {
        if (JSON.stringify(after) === JSON.stringify(beforeClone)) return [];
    } catch {
        /* fall through and emit edit */
    }
    return [{
        op: 'set',
        path: '',
        oldValue: beforeClone,
        newValue: after,
    }];
}
