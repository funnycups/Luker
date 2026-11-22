// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph configuration — plugin-owned tool catalog + tool-call
 * normalizer.
 *
 * Static, side-effect-free pieces:
 *
 *   - TOOL_DEFS:                OpenAI-style function definitions for the
 *                               memory-graph workbench tools. Three schema
 *                               structure tools (set / remove / reorder),
 *                               one discovery tool, one read tool, and three
 *                               configuration write tools.
 *   - TOOL_DISPLAY:             friendly UI labels keyed by tool name. The
 *                               labels are raw English strings; callers that
 *                               want i18n must wrap them at the call site
 *                               (this module is pure and has no i18n binding).
 *   - CONTROL_TOOL_NAMES:       names of the runner-side control tools used
 *                               for schema resets.
 *   - SESSIONS_BUCKET_KEY:      the legacy schema session bucket under
 *                               `extension_settings.memory_graph`. Exposed so
 *                               the session-store migrator can derive the old
 *                               bucket location from a single source.
 *   - applyToolCallToSandbox:   mutates `sandboxSession.workingProfile`
 *                               (`{ schema, settings }`) per the executor
 *                               logic. Returns true if the document changed,
 *                               false otherwise.
 *   - normalizeToolCallToEdit:  async; runs the call through the sandbox and
 *                               emits a single coarse `set('', after)`
 *                               edits-lib op (sandbox-diff pattern: builds a
 *                               coarse {op:'set', path:''} edit from before /
 *                               after snapshots).
 *
 * `normalizeNodeTypeSchema` is the in-extension normalizer that lives in
 * primitives.js. It flows in via the per-call `ctx` argument so this module
 * stays pure and decoupled from main.js. `ctx.resolveUnsetBaseline(path)`
 * returns the value an `unset` restores for the current scope; a missing
 * baseline is a hard error, never a silent empty write.
 *
 * Executor failures surface as `<tool>: <code> — <detail>` so the runner's
 * catch arm hands the AI a real error reply instead of collapsing onto the
 * misleading "already matches" noop. Codes: invalid_args, not_found,
 * multiple_matches, not_allowed, unknown_tool.
 */

import { applyStringPatch } from '../../../iteration-library/system-prompt-patch.js';
import { diagnoseAnchorMiss } from '../../../iteration-library/anchor-diagnostic.js';
import { getFieldDef, validateFieldValue } from './fields.js';

export const SESSIONS_BUCKET_KEY = 'iterStudioV2Schema';

const TOOL_SET_NODE_TYPE = 'mg_schema_set_node_type';
const TOOL_REMOVE_NODE_TYPE = 'mg_schema_remove_node_type';
const TOOL_REORDER_NODE_TYPES = 'mg_schema_reorder_node_types';
const TOOL_CONFIG_LIST_FIELDS = 'mg_config_list_fields';
const TOOL_CONFIG_READ_FIELDS = 'mg_config_read_fields';
const TOOL_CONFIG_PATCH_PROMPT = 'mg_config_patch_prompt';
const TOOL_CONFIG_SET_FIELDS = 'mg_config_set_fields';
const TOOL_SCHEMA_PATCH_TEXT = 'mg_schema_patch_text';

export const CONTROL_TOOL_NAMES = Object.freeze({
    resetToBlank: 'luker_mg_schema_reset_live_to_blank',
    resetToGlobal: 'luker_mg_schema_reset_live_to_global',
});
const CONTROL_TOOL_NAME_SET = new Set([
    CONTROL_TOOL_NAMES.resetToBlank,
    CONTROL_TOOL_NAMES.resetToGlobal,
]);

/** Node-type text fields `mg_schema_patch_text` accepts. */
const PATCHABLE_SCHEMA_TEXT_FIELDS = Object.freeze([
    'extractionInstructions',
    'extractHint',
    'columnHints',
    'compression.summarizeInstruction',
]);

/**
 * Predicate the runner uses (via `isControlCall`) to route a tool call to
 * `onControlCall` instead of `onToolCall`. Mirrors the CPA / Orchestrator
 * pattern; keeps the shared runner plugin-agnostic.
 */
export function isMgSchemaControlCall(toolCall) {
    return CONTROL_TOOL_NAME_SET.has(String(toolCall?.name || ''));
}

/**
 * Names of the two read tools the studio dispatches inline (never through
 * the sandbox executor). Exported so the studio's read loop classifies
 * calls by the same constants the catalog is built from.
 */
export const READ_TOOL_NAMES = Object.freeze({
    listFields: TOOL_CONFIG_LIST_FIELDS,
    readFields: TOOL_CONFIG_READ_FIELDS,
});

const READ_TOOL_NAME_SET = new Set([
    READ_TOOL_NAMES.listFields,
    READ_TOOL_NAMES.readFields,
]);

/**
 * Predicate the studio's read loop uses to split read calls (executed
 * inline, result persisted as an `ok` tool_result) from edit calls
 * (normalized into pending proposals).
 */
export function isMgConfigReadTool(toolCall) {
    return READ_TOOL_NAME_SET.has(String(toolCall?.name || ''));
}

export const TOOL_DISPLAY = Object.freeze({
    [TOOL_CONFIG_LIST_FIELDS]: 'list config fields',
    [TOOL_CONFIG_READ_FIELDS]: 'read config fields',
    [TOOL_CONFIG_PATCH_PROMPT]: 'patch settings text',
    [TOOL_CONFIG_SET_FIELDS]: 'set config fields',
    [TOOL_SCHEMA_PATCH_TEXT]: 'patch node type text',
    [TOOL_SET_NODE_TYPE]: 'set node type',
    [TOOL_REMOVE_NODE_TYPE]: 'remove node type',
    [TOOL_REORDER_NODE_TYPES]: 'reorder node types',
    [CONTROL_TOOL_NAMES.resetToBlank]: '♻ Reset schema to blank',
    [CONTROL_TOOL_NAMES.resetToGlobal]: '⬇ Reset schema to global',
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
            forceUpdate: { type: 'boolean', description: 'If true, this node type must be emitted every extraction round; a round that omits it is treated as a failure. The per-type cadence does not apply to it. Default false.' },
            editable: { type: 'boolean', description: 'If true, exposes edit and delete tools to the extraction LLM so existing nodes of this type can be updated across turns (required for stateful types like characters, locations, and threads; false for append-only types like events).' },
            level: { type: 'string', enum: ['semantic'], description: 'Storage tier identifier. Currently only "semantic" is supported; omit to use the default.' },
            extractHint: { type: 'string', description: 'Overall hint for the extraction LLM about when to emit this node type.' },
            extractionInstructions: { type: 'string', description: 'Per-type detailed instructions added to the extraction request when this type is active this round. Use for type-specific rules (e.g. "at most one event per batch"). Empty = no type-specific appendix.' },
            extractEveryN: { type: 'integer', minimum: 1, description: 'Cadence: this type is extracted only when latestSeq % extractEveryN === 0. 1 (default) = every extraction pass. Larger N for slow-changing tables (e.g. location_state) saves LLM calls. Ignored by force-update types, which extract every round.' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Recall keywords; presence in the chat increases retrieval weight.' },
            alwaysInject: { type: 'boolean', description: 'If true, entries are always injected into the prompt (skip recall). Use sparingly — high-volume types will blow the context budget.' },
            latestOnly: { type: 'boolean', description: 'If true, only the most recent entry is retained for this type — good for state-like data.' },
            compression: compressionParams(),
        },
        required: ['id'],
        additionalProperties: false,
    };
}

/**
 * Project a node-type value onto the writable surface defined by
 * `nodeTypeSchemaParams()`. The read tool must never surface a field the
 * set tool's JSON schema would reject, so reads run the live schema through
 * this projection before reading.
 *
 * Schema-driven: each nested object with a fixed `properties` shape is
 * projected recursively, so any normalizer-only field is dropped
 * automatically (today: `compression.rule`, `ragPerTypeK`,
 * `recordsFloorRange`). This makes read ⊆ write by construction — the
 * asymmetry that let the extractor read a field the setter rejected can no
 * longer recur when the normalizer grows a new field.
 */
function projectValueThroughSchema(value, schema) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
    }
    const properties = schema?.properties && typeof schema.properties === 'object'
        ? schema.properties
        : null;
    if (!properties) {
        // No fixed shape (e.g. columnHints uses additionalProperties) →
        // fully writable, pass through untouched.
        return value;
    }
    const out = {};
    for (const key of Object.keys(properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            out[key] = projectValueThroughSchema(value[key], properties[key]);
        }
    }
    return out;
}

export function projectNodeTypeForRead(nodeType) {
    return projectValueThroughSchema(nodeType, nodeTypeSchemaParams());
}

export const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: TOOL_CONFIG_LIST_FIELDS,
            description: 'List the configuration fields with their path, group, kind, bounds or enum values, and what each one controls. Call this first when you need to discover a key; then read the values you intend to change with mg_config_read_fields.',
            parameters: {
                type: 'object',
                properties: {
                    group: { type: 'string', description: 'Optional group id to narrow the listing.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_CONFIG_READ_FIELDS,
            description: 'Read exact values from the working, global, or default configuration by lodash-style path. The document root is {schema, settings}; common paths are "schema[0].extractionInstructions" and "settings.extractTemplate". Read only the fields you are about to change.',
            parameters: {
                type: 'object',
                properties: {
                    source: { type: 'string', enum: ['working', 'global', 'default'], description: 'Which layer to read. Defaults to working, the effective configuration for the current scope.' },
                    paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Lodash-style paths into the {schema, settings} document.',
                    },
                },
                required: ['paths'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_CONFIG_PATCH_PROMPT,
            description: 'Patch one settings text value by exact anchor. Only settings text fields are accepted. Read the field first so oldString matches byte-for-byte. Use mg_config_set_fields when the field is empty or the whole value changes.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Full settings path, e.g. "settings.extractTemplate".' },
                    oldString: { type: 'string', description: 'Exact substring to replace. Must occur exactly once unless replaceAll is true.' },
                    newString: { type: 'string', description: 'Replacement text. Use "" to delete the matched substring.' },
                    replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldString. Default false.' },
                },
                required: ['path', 'oldString', 'newString'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_CONFIG_SET_FIELDS,
            description: 'Set whole values for settings keys, or restore inherited values by unsetting paths. Values are complete replacements, not increments. unset restores the global or default value for the current scope. The whole batch is validated before anything is applied.',
            parameters: {
                type: 'object',
                properties: {
                    set: {
                        type: 'object',
                        description: 'Map of settings path to the complete new value.',
                        additionalProperties: true,
                    },
                    unset: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Settings paths to restore from the inherited baseline.',
                    },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_SCHEMA_PATCH_TEXT,
            description: 'Patch one node-type text field by stable id. field selects extractionInstructions, extractHint, columnHints, or compression.summarizeInstruction; columnHints also needs column. Use mg_schema_set_node_type to create a missing field or rewrite a whole node type.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Stable id of the node type to patch.' },
                    field: {
                        type: 'string',
                        enum: [...PATCHABLE_SCHEMA_TEXT_FIELDS],
                        description: 'Text field to patch.',
                    },
                    column: { type: 'string', description: 'Column name. Required when field is columnHints.' },
                    oldString: { type: 'string', description: 'Exact substring to replace. Must occur exactly once unless replaceAll is true.' },
                    newString: { type: 'string', description: 'Replacement text. Use "" to delete the matched substring.' },
                    replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldString. Default false.' },
                },
                required: ['id', 'field', 'oldString', 'newString'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_SET_NODE_TYPE,
            description: 'Upsert a single node type into the schema by id. Only the top-level fields you provide are changed; omitted top-level fields keep their current values. Nested objects (columnHints, compression) are replaced wholesale when provided, so send their full contents. Read the type first, then send the fields you are changing.',
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
 * OpenAI-style function definitions for the schema-reset control tools.
 * Kept separate from `TOOL_DEFS` so call sites that import `TOOL_DEFS`
 * directly stay unaffected; the popup imports `buildToolCatalog` instead,
 * which merges both lists.
 */
const CONTROL_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.resetToBlank,
            description: 'Replace the working schema with a minimal blank shell, discarding the schema copy seeded in. Use ONLY when the user wants to design a brand-new node-type schema for this character from scratch (not when adjusting the existing one). The popup only injects this affordance when scope is character — both the fork-from-global case (no override yet) and the discard-override case offer this path; ignore it otherwise.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: CONTROL_TOOL_NAMES.resetToGlobal,
            description: 'Replace the working schema with a fresh clone of the current GLOBAL schema, discarding the existing character-override copy seeded in. Use ONLY when the user wants to wipe their character override and restart from the current global schema. The popup only injects this affordance when scope is character AND a character override already exists — ignore it otherwise.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional rationale visible to the user.' },
                },
                additionalProperties: false,
            },
        },
    },
];

/**
 * Returns the full tool catalog the popup advertises to the LLM: the eight
 * workbench tools plus the two schema-reset control tools. The popup's outer
 * loop is program-driven by tool-call presence (any tool call → next round,
 * none → stop), so there is no continue / finalize control tool. Pure
 * function; no side effects.
 */
export function buildToolCatalog() {
    return [...TOOL_DEFS, ...CONTROL_TOOL_DEFS];
}

function fail(name, code, detail) {
    throw new Error(`${name}: ${code} — ${detail}`);
}

function parseToolArgs(call) {
    const rawArgs = call?.function?.arguments ?? call?.args;
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
        return rawArgs;
    }
    if (typeof rawArgs === 'string') {
        try {
            return JSON.parse(rawArgs) || {};
        } catch {
            return {};
        }
    }
    return {};
}

function requireWorkingSettings(sandboxSession) {
    const settings = sandboxSession?.workingProfile?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new TypeError('applyToolCallToSandbox: workingProfile.settings must be an object');
    }
    return settings;
}

/**
 * Resolve a settings path to its registry definition. Rejects schema paths
 * with not_allowed, unregistered settings keys with not_found, and malformed
 * paths with invalid_args.
 */
function resolveSettingsDef(name, rawPath) {
    const path = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!path) {
        fail(name, 'invalid_args', 'path must be a non-empty settings path such as "settings.recallMaxIterations".');
    }
    if (!path.startsWith('settings.')) {
        fail(name, 'not_allowed', `"${path}" is not a settings path. Use a schema tool for node-type fields.`);
    }
    const def = getFieldDef(path);
    if (!def) {
        fail(name, 'not_found', `"${path}" is not a registered settings field. Call mg_config_list_fields to see the available paths.`);
    }
    return { path, def };
}

function patchFailure(name, patch, currentText, oldString, label) {
    if (patch.error === 'not_found') {
        const diagnosis = diagnoseAnchorMiss(currentText, oldString);
        fail(name, 'not_found', `oldString not present in ${label}. match_diagnosis=${JSON.stringify(diagnosis)}`);
    }
    fail(name, patch.error, patch.detail);
}

function applyNodeTypeTextPatch(name, args, sandboxSession) {
    const id = typeof args?.id === 'string' ? args.id.trim() : '';
    if (!id) {
        fail(name, 'invalid_args', 'id must be a non-empty node-type id.');
    }
    const field = typeof args?.field === 'string' ? args.field.trim() : '';
    if (!PATCHABLE_SCHEMA_TEXT_FIELDS.includes(field)) {
        fail(name, 'invalid_args', `field must be one of: ${PATCHABLE_SCHEMA_TEXT_FIELDS.join(', ')}.`);
    }
    const column = typeof args?.column === 'string' ? args.column.trim() : '';
    if (field === 'columnHints' && !column) {
        fail(name, 'invalid_args', 'column is required when field is columnHints.');
    }

    const list = Array.isArray(sandboxSession?.workingProfile?.schema)
        ? sandboxSession.workingProfile.schema
        : [];
    const matches = list.filter(entry => String(entry?.id || '').trim() === id);
    if (matches.length === 0) {
        fail(name, 'not_found', `no node type with id "${id}" in the working schema. Read the schema index before retrying.`);
    }
    if (matches.length > 1) {
        fail(name, 'multiple_matches', `${matches.length} node types share the id "${id}". Fix the duplicate ids before patching text.`);
    }
    const target = matches[0];

    let current;
    let label;
    if (field === 'columnHints') {
        label = `${id}.columnHints.${column}`;
        const hints = target?.columnHints;
        if (!hints || typeof hints !== 'object' || hints[column] === undefined) {
            fail(name, 'not_found', `no column hint "${column}" on node type "${id}".`);
        }
        current = hints[column];
    } else if (field === 'compression.summarizeInstruction') {
        label = `${id}.compression.summarizeInstruction`;
        const compression = target?.compression;
        if (!compression || typeof compression !== 'object' || compression.summarizeInstruction === undefined) {
            fail(name, 'not_found', `node type "${id}" has no compression.summarizeInstruction.`);
        }
        current = compression.summarizeInstruction;
    } else {
        label = `${id}.${field}`;
        if (target?.[field] === undefined) {
            fail(name, 'not_found', `node type "${id}" has no "${field}".`);
        }
        current = target[field];
    }

    if (typeof current !== 'string') {
        fail(name, 'invalid_args', `${label} is not a string. Use mg_schema_set_node_type to rewrite it.`);
    }
    const oldString = args?.oldString;
    if (current === '' && oldString === '') {
        fail(name, 'not_found', `${label} is empty; an empty anchor cannot patch it. Use mg_schema_set_node_type to set the text.`);
    }

    const patch = applyStringPatch(current, {
        oldString,
        newString: args?.newString,
        replaceAll: args?.replaceAll,
    });
    if (!patch.ok) {
        patchFailure(name, patch, current, oldString, label);
    }
    const nextText = patch.nextText.trim();
    if (nextText === current) {
        return false;
    }
    if (field === 'columnHints') {
        target.columnHints = { ...target.columnHints, [column]: nextText };
    } else if (field === 'compression.summarizeInstruction') {
        target.compression = { ...target.compression, summarizeInstruction: nextText };
    } else {
        target[field] = nextText;
    }
    return true;
}

function applySettingsTextPatch(name, args, sandboxSession) {
    const { path, def } = resolveSettingsDef(name, args?.path);
    if (def.kind !== 'text') {
        fail(name, 'invalid_args', `"${path}" is a ${def.kind} field. Use mg_config_set_fields for typed values.`);
    }
    const settings = requireWorkingSettings(sandboxSession);
    const current = settings[def.key];
    if (typeof current !== 'string') {
        fail(name, 'invalid_args', `"${path}" does not currently hold text. Use mg_config_set_fields.`);
    }
    const patch = applyStringPatch(current, {
        oldString: args?.oldString,
        newString: args?.newString,
        replaceAll: args?.replaceAll,
    });
    if (!patch.ok) {
        patchFailure(name, patch, current, args?.oldString, path);
    }
    const nextText = patch.nextText.trim();
    const validation = validateFieldValue(def, nextText);
    if (!validation.ok) {
        fail(name, validation.error, validation.detail);
    }
    if (nextText === current) {
        return false;
    }
    settings[def.key] = nextText;
    return true;
}

function applySettingsSetFields(name, args, sandboxSession, ctx) {
    const settings = requireWorkingSettings(sandboxSession);
    const rawSet = args?.set;
    const rawUnset = args?.unset;
    if (rawSet !== undefined && (rawSet === null || typeof rawSet !== 'object' || Array.isArray(rawSet))) {
        fail(name, 'invalid_args', 'set must be an object keyed by settings path.');
    }
    if (rawUnset !== undefined && !Array.isArray(rawUnset)) {
        fail(name, 'invalid_args', 'unset must be an array of settings paths.');
    }

    const setEntries = Object.entries(rawSet || {}).map(([path, value]) => [path.trim(), value]);
    const unsetPaths = [];
    for (const rawPath of rawUnset || []) {
        if (typeof rawPath !== 'string' || rawPath.trim() === '') {
            fail(name, 'invalid_args', 'unset entries must be non-empty settings path strings.');
        }
        unsetPaths.push(rawPath.trim());
    }
    if (setEntries.length === 0 && unsetPaths.length === 0) {
        fail(name, 'invalid_args', 'provide at least one entry in set or unset.');
    }

    const overlap = setEntries.find(([path]) => unsetPaths.includes(path));
    if (overlap) {
        fail(name, 'invalid_args', `"${overlap[0]}" appears in both set and unset.`);
    }

    // Validate the whole batch first. Nothing reaches the sandbox until every
    // entry has passed, so a bad trailing entry cannot leave a half-applied
    // settings object behind.
    const operations = [];
    for (const [path, rawValue] of setEntries) {
        const { def } = resolveSettingsDef(name, path);
        const value = def.kind === 'text' && typeof rawValue === 'string'
            ? rawValue.trim()
            : rawValue;
        const validation = validateFieldValue(def, value);
        if (!validation.ok) {
            fail(name, validation.error, validation.detail);
        }
        operations.push({ key: def.key, value: validation.value });
    }
    if (unsetPaths.length > 0 && typeof ctx?.resolveUnsetBaseline !== 'function') {
        throw new TypeError('applyToolCallToSandbox: ctx.resolveUnsetBaseline must be a function');
    }
    for (const path of unsetPaths) {
        const { def } = resolveSettingsDef(name, path);
        const baseline = ctx.resolveUnsetBaseline(path);
        if (baseline === undefined) {
            fail(name, 'invalid_args', `no inherited baseline for "${path}".`);
        }
        operations.push({ key: def.key, value: baseline });
    }

    const nextSettings = { ...settings };
    for (const operation of operations) {
        nextSettings[operation.key] = operation.value;
    }
    if (JSON.stringify(nextSettings) === JSON.stringify(settings)) {
        return false;
    }
    sandboxSession.workingProfile.settings = nextSettings;
    return true;
}

/**
 * Sandbox-side executor: mutates the provided `sandboxSession.workingProfile`
 * (`{ schema, settings }`) per the executor logic. Returns true if the
 * document was changed, false otherwise.
 *
 * `ctx.normalizeNodeTypeSchema` is the in-extension normalizer
 * (primitives.js). The schema structure branches normalize the new list
 * before stashing it back onto the sandbox session.
 * `ctx.resolveUnsetBaseline(path)` supplies the value an unset restores for
 * the current scope.
 *
 * Throws `<tool>: <code> — <detail>` on malformed input or invalid writes;
 * never silently returns false for a failed call.
 *
 * @param {object} call           tool call object
 * @param {object} sandboxSession session-shaped object with
 *                                `workingProfile: { schema, settings }`
 *                                (mutated)
 * @param {{ normalizeNodeTypeSchema: (schema: any) => any[],
 *           resolveUnsetBaseline: (path: string) => any }} ctx
 * @returns {boolean}             true if the document changed
 */
export function applyToolCallToSandbox(call, sandboxSession, ctx) {
    const normalizeNodeTypeSchema = ctx?.normalizeNodeTypeSchema;
    if (typeof normalizeNodeTypeSchema !== 'function') {
        throw new TypeError('applyToolCallToSandbox: ctx.normalizeNodeTypeSchema must be a function');
    }
    const name = String(call?.function?.name || call?.name || '').trim();
    const args = parseToolArgs(call);
    const list = Array.isArray(sandboxSession.workingProfile?.schema)
        ? sandboxSession.workingProfile.schema
        : [];

    if (name === TOOL_CONFIG_LIST_FIELDS || name === TOOL_CONFIG_READ_FIELDS) {
        // Read tools execute in the studio read loop, never through the
        // sandbox executor. Reach here only if a caller misroutes them.
        fail(name, 'not_allowed', 'read tools must be executed by the studio read dispatcher, not the sandbox executor.');
    }

    if (name === TOOL_CONFIG_PATCH_PROMPT) {
        return applySettingsTextPatch(name, args, sandboxSession);
    }

    if (name === TOOL_CONFIG_SET_FIELDS) {
        return applySettingsSetFields(name, args, sandboxSession, ctx);
    }

    if (name === TOOL_SCHEMA_PATCH_TEXT) {
        return applyNodeTypeTextPatch(name, args, sandboxSession);
    }

    if (name === TOOL_SET_NODE_TYPE) {
        const nodeType = args?.node_type && typeof args.node_type === 'object' ? args.node_type : null;
        if (!nodeType) {
            fail(name, 'invalid_args', 'node_type must be an object describing the node type to set.');
        }
        const id = String(nodeType.id || '').trim();
        if (!id) {
            fail(name, 'invalid_args', 'node_type.id is required and must be a non-empty string.');
        }
        const existingIndex = list.findIndex(entry => String(entry?.id || '').trim() === id);
        const next = [...list];
        if (existingIndex >= 0) {
            const merged = { ...list[existingIndex], ...nodeType, id };
            // `compression.rule` is a runtime field outside the iter-studio
            // surface (absent from nodeTypeSchemaParams), so the read tool
            // never exposes it. A caller editing other compression fields
            // would otherwise wipe it via the wholesale replace. Merge the
            // compression sub-object to preserve non-writable sub-fields.
            // columnHints stays replace-on-write: the AI must be able to
            // drop a hint when it drops a column.
            const existingCompression = list[existingIndex]?.compression;
            if (nodeType.compression && typeof nodeType.compression === 'object'
                && existingCompression && typeof existingCompression === 'object') {
                merged.compression = { ...existingCompression, ...nodeType.compression };
            }
            next[existingIndex] = merged;
        } else {
            next.push({ ...nodeType, id });
        }
        sandboxSession.workingProfile.schema = normalizeNodeTypeSchema(next);
        return true;
    }

    if (name === TOOL_REMOVE_NODE_TYPE) {
        const id = String(args?.id || '').trim();
        if (!id) {
            fail(name, 'invalid_args', 'id is required and must be a non-empty string.');
        }
        if (list.length <= 1) {
            fail(name, 'not_allowed', `the schema must keep at least one node type; refusing to remove "${id}" when only ${list.length} type(s) remain.`);
        }
        const next = list.filter(entry => String(entry?.id || '').trim() !== id);
        if (next.length === list.length) {
            fail(name, 'not_found', `no node type with id "${id}" in the current schema. Use the schema-read tool to confirm available ids before retrying.`);
        }
        sandboxSession.workingProfile.schema = normalizeNodeTypeSchema(next);
        return true;
    }

    if (name === TOOL_REORDER_NODE_TYPES) {
        const ids = Array.isArray(args?.ids)
            ? args.ids.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) {
            fail(name, 'invalid_args', 'ids must be a non-empty array of node-type identifiers.');
        }
        const currentIds = list.map(entry => String(entry?.id || '').trim());
        const sameSet = ids.length === currentIds.length
            && ids.every(id => currentIds.includes(id))
            && currentIds.every(id => ids.includes(id));
        if (!sameSet) {
            fail(name, 'invalid_args', `ids must contain every existing node-type id exactly once. Current ids: [${currentIds.join(', ')}]; received: [${ids.join(', ')}].`);
        }
        const byId = new Map(list.map(entry => [String(entry?.id || '').trim(), entry]));
        const next = ids.map(id => byId.get(id)).filter(Boolean);
        sandboxSession.workingProfile.schema = normalizeNodeTypeSchema(next);
        return true;
    }

    // Unknown tool name — surface explicitly so the AI gets a real error
    // tool reply instead of a misleading "already matches" hint.
    fail(name, 'unknown_tool', `"${name}" is not a recognized memory-graph workbench tool.`);
}

/**
 * Translate a tool call into an edits-lib op array suitable for the runner.
 *
 * Uses the sandbox-diff pattern: clone live → run the executor against
 * a fake `{ workingProfile: { schema, settings } }` session → emit one
 * coarse `set('', newDocument)` edit. Returns:
 *   - `[]`   on no-op (live state and post-call state are identical —
 *            e.g. set_node_type called with values that already match)
 *   - `[edit]` otherwise
 *
 * Executor failures (invalid_args / not_found / multiple_matches /
 * not_allowed / unknown_tool) are propagated as thrown Errors so the
 * iter-studio's catch arm surfaces them as real `{error: "..."}` tool
 * replies. Previously each silent `return false` was collapsed onto the
 * misleading "likely already matches" iter-studio noop and the AI thought
 * broken calls had succeeded.
 *
 * @param {object} call tool call object
 * @param {{ live: { schema: any[], settings: object },
 *           normalizeNodeTypeSchema: (schema: any) => any[],
 *           resolveUnsetBaseline: (path: string) => any }} ctx
 * @returns {Promise<Array<object>>}
 */
export async function normalizeToolCallToEdit(call, ctx) {
    const before = ctx?.live;
    if (!before || typeof before !== 'object' || Array.isArray(before)) return [];
    const beforeClone = structuredClone(before);
    const sandboxSession = { workingProfile: structuredClone(before) };
    const changed = applyToolCallToSandbox(call, sandboxSession, ctx);
    if (!changed) return [];
    const after = sandboxSession.workingProfile;
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
