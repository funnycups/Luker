// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Configuration field registry for the Memory Graph configuration workbench.
 *
 * One entry per settings key the workbench may read or write. Each entry
 * describes the group, value kind, bounds / enum, code default, and — for
 * text keys — the markers a write must preserve. The registry is the single
 * source of truth shared by the catalog tool, the read dispatcher's view
 * projection, and the write validators.
 *
 * Values are addressed by full path `settings.<key>`. Node-type fields live
 * in the schema half of the working document and are not registered here.
 */

import {
    DEFAULT_CRAWL_SYSTEM_PROMPT,
    DEFAULT_EXTRACT_EDGE_RULES,
    DEFAULT_EXTRACT_TEMPLATE,
    DEFAULT_RAG_REWRITE_SYSTEM_PROMPT,
    DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
    DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
} from '../default-prompts.js';
import { DEFAULT_GRAPH_ITER_SYSTEM_PROMPT } from '../graph-iteration/system-prompt.js';
import { DEFAULT_CONFIG_ITER_SYSTEM_PROMPT } from './system-prompt.js';

const GROUPS = [
    { id: 'extraction', label: 'Extraction' },
    { id: 'recall', label: 'Recall' },
    { id: 'query_rewrite', label: 'Query rewrite' },
    { id: 'iteration', label: 'Iteration' },
    { id: 'runtime', label: 'Runtime' },
];

function field(key, group, kind, label, summary, defaultValue, extra = {}) {
    return { path: `settings.${key}`, key, group, kind, label, summary, defaultValue, ...extra };
}

function intField(key, group, label, summary, defaultValue, bounds = {}) {
    return field(key, group, 'int', label, summary, defaultValue, bounds);
}

function boolField(key, group, label, summary, defaultValue) {
    return field(key, group, 'bool', label, summary, defaultValue);
}

function textField(key, group, label, summary, defaultValue, extra = {}) {
    return field(key, group, 'text', label, summary, defaultValue, extra);
}

const REGISTRY = [
    // ---- extraction -------------------------------------------------------
    field('extractMode', 'extraction', 'enum', 'Extraction graph mode', 'Extraction input strategy: oneshot sends the full graph input in one pass, crawl shows a compact index and reads selected nodes first.', 'oneshot', { values: ['oneshot', 'crawl'] }),
    intField('updateEvery', 'extraction', 'Update every N assistant turns', 'Trigger automatic extraction after N unextracted assistant turns accumulate.', 2, { min: 1 }),
    intField('extractBatchTurns', 'extraction', 'Extract batch assistant turns', 'Number of assistant turns covered by one extraction batch.', 2, { min: 1 }),
    intField('extractContextTurns', 'extraction', 'Extract context assistant turns', 'Number of preceding assistant turns attached to each extraction batch as context.', 2, { min: 1, max: 32 }),
    intField('extractExcludeRecentTurns', 'extraction', 'Exclude latest N assistant turns from graph extraction', 'Number of newest assistant turns withheld from extraction.', 0, { min: 0 }),
    boolField('extractConcurrent', 'extraction', 'Concurrent extraction', 'Run extraction for different node types concurrently instead of sequentially.', false),
    intField('extractCrawlMaxRounds', 'extraction', 'Crawl max rounds', 'Maximum number of crawl read rounds before extraction starts.', 3, { min: 1, max: 5 }),
    intField('extractCrawlCandidateLimit', 'extraction', 'Crawl candidate limit', 'Maximum number of candidate nodes listed per crawl round. 0 means unlimited.', 40, { min: 0, max: 100 }),
    intField('extractCrawlMaxReads', 'extraction', 'Crawl read budget', 'Maximum number of node reads allowed in one crawl extraction.', 12, { min: 1, max: 30 }),
    textField('extractTemplate', 'extraction', 'Extraction Template', 'System template for the extraction request. Must keep the {{nodes}} and {{edges}} markers.', DEFAULT_EXTRACT_TEMPLATE, { markers: ['{{nodes}}', '{{edges}}'], clearWhenDefault: true }),
    textField('extractEdgeRules', 'extraction', 'Edge Rules', 'Edge rules appended to the extraction request.', DEFAULT_EXTRACT_EDGE_RULES, { clearWhenDefault: true }),
    textField('extractCrawlSystemPrompt', 'extraction', 'Extraction Crawl Prompt', 'System prompt for the crawl-stage explorer that runs before extraction.', DEFAULT_CRAWL_SYSTEM_PROMPT, { fillDefaultOnNormalize: true }),

    // ---- recall -----------------------------------------------------------
    textField('recallRouteSystemPrompt', 'recall', 'Recall Stage 1 Prompt (Route/Drill)', 'First-stage LLM recall prompt that plans and drills into candidate nodes.', DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT, { fillDefaultOnNormalize: true }),
    textField('recallFinalizeSystemPrompt', 'recall', 'Recall Stage 2 Prompt (Finalize)', 'Second-stage LLM recall prompt that picks the final node set.', DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT, { fillDefaultOnNormalize: true }),
    intField('recallMaxIterations', 'recall', 'Recall max iterations', 'Maximum number of tool rounds for LLM recall.', 3, { min: 2, max: 6 }),
    intField('recallQueryMessages', 'recall', 'Recall query recent assistant turns', 'Number of recent assistant turns used to build the recall query.', 2, { min: 0, max: 64 }),
    intField('persistentInjectionMaxSeqDistance', 'recall', 'Persistent injection recency horizon (assistant turns; 0 = no limit)', 'Recency horizon for always-injected nodes in assistant turns; 0 means no limit.', 0, { min: 0 }),
    intField('llmVisibleRecentMessages', 'recall', 'Visible recent message layers for generation (0 = disabled)', 'Number of recent message layers visible to the generation model; 0 disables hiding.', 5, { min: 0, max: 200 }),

    // ---- query rewrite ----------------------------------------------------
    textField('ragRewriteSystemPrompt', 'query_rewrite', 'Query rewrite system prompt', 'System prompt for rewriting the recall query; used only by RAG recall with query rewrite enabled.', DEFAULT_RAG_REWRITE_SYSTEM_PROMPT, { fillDefaultOnNormalize: true }),

    // ---- iteration --------------------------------------------------------
    textField('graphIterSystemPrompt', 'iteration', 'Graph Revision Prompt (graph-editor AI)', 'System prompt for the graph revision workbench.', DEFAULT_GRAPH_ITER_SYSTEM_PROMPT, { clearWhenDefault: true }),
    textField('configIterSystemPrompt', 'iteration', 'Configuration Iteration Prompt (configuration-editor AI)', 'System prompt for this configuration workbench.', DEFAULT_CONFIG_ITER_SYSTEM_PROMPT, { clearWhenDefault: true }),

    // ---- runtime ----------------------------------------------------------
    intField('toolCallRetryMax', 'runtime', 'Tool-call retries', 'Number of retries after a failed tool call.', 2, { min: 0, max: 10 }),
    intField('rpmLimit', 'runtime', 'RPM limit (0 = unlimited)', 'Requests per minute limit; 0 means unlimited.', 0, { min: 0 }),
    boolField('includeWorldInfoWithPreset', 'runtime', 'Include world info', 'Attach resolved world info to extraction and recall requests.', true),
];

/** `Record<string, FieldDef>` keyed by the full `settings.<key>` path. */
export const CONFIG_FIELDS = Object.freeze(Object.fromEntries(REGISTRY.map(def => [def.path, Object.freeze(def)])));

const SCHEMA_TEXT_FIELDS = Object.freeze([
    { field: 'extractionInstructions', kind: 'text', summary: 'Per-type detailed extraction instructions.' },
    { field: 'extractHint', kind: 'text', summary: 'Overall extraction hint for this node type.' },
    { field: 'columnHints', kind: 'text', column: true, summary: 'Per-column extraction hint; target by column name.' },
    { field: 'compression.summarizeInstruction', kind: 'text', summary: 'Compression summary instruction.' },
]);

export function getFieldDef(path) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELDS, path)) {
        return null;
    }
    return CONFIG_FIELDS[path];
}

function clampInt(value, def) {
    let numeric = Math.floor(value);
    if (Number.isFinite(def.min)) {
        numeric = Math.max(def.min, numeric);
    }
    if (Number.isFinite(def.max)) {
        numeric = Math.min(def.max, numeric);
    }
    return numeric;
}

function resolveInt(def, value) {
    if (value === null || value === undefined || value === '') {
        return clampInt(Number(def.defaultValue), def);
    }
    const numeric = Number(value);
    return clampInt(Number.isFinite(numeric) ? numeric : Number(def.defaultValue), def);
}

function resolveBool(def, value) {
    return typeof value === 'boolean' ? value : def.defaultValue;
}

function resolveEnum(def, value) {
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return def.values.includes(candidate) ? candidate : def.defaultValue;
}

function resolveText(def, value) {
    return String(value ?? '').trim() || def.defaultValue;
}

function resolveValue(def, value) {
    switch (def.kind) {
        case 'int': return resolveInt(def, value);
        case 'bool': return resolveBool(def, value);
        case 'enum': return resolveEnum(def, value);
        case 'text': return resolveText(def, value);
        default: return def.defaultValue;
    }
}

function resolveSource(source) {
    return source && typeof source === 'object' ? source : {};
}

/**
 * Project the effective settings for a read source. Every registered key is
 * returned; empty text slots resolve to their code default so callers never
 * see a blank prompt where the runtime would use a constant.
 */
export function resolveSettingsForView(source = null) {
    const input = resolveSource(source);
    const view = {};
    for (const def of Object.values(CONFIG_FIELDS)) {
        view[def.key] = resolveValue(def, input[def.key]);
    }
    return view;
}

/** The 24 code defaults, already resolved for display. */
export function getDefaultSettingsView() {
    const view = {};
    for (const def of Object.values(CONFIG_FIELDS)) {
        view[def.key] = def.defaultValue;
    }
    return view;
}

function fail(error, detail) {
    return { ok: false, error, detail };
}

/**
 * Validate a value against a field definition. Boundaries reject rather than
 * clamp: a write outside the range is an error the caller has to surface.
 */
export function validateFieldValue(def, value) {
    if (!def || typeof def !== 'object') {
        return fail('invalid_args', 'Unknown field definition.');
    }
    switch (def.kind) {
        case 'int': {
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                return fail('invalid_args', `${def.path} expects an integer.`);
            }
            if (Number.isFinite(def.min) && value < def.min) {
                return fail('invalid_args', `${def.path} minimum is ${def.min}.`);
            }
            if (Number.isFinite(def.max) && value > def.max) {
                return fail('invalid_args', `${def.path} maximum is ${def.max}.`);
            }
            return { ok: true, value };
        }
        case 'bool': {
            if (typeof value !== 'boolean') {
                return fail('invalid_args', `${def.path} expects a boolean.`);
            }
            return { ok: true, value };
        }
        case 'enum': {
            if (typeof value !== 'string') {
                return fail('invalid_args', `${def.path} expects one of: ${def.values.join(', ')}.`);
            }
            const candidate = value.trim().toLowerCase();
            if (!def.values.includes(candidate)) {
                return fail('invalid_args', `${def.path} expects one of: ${def.values.join(', ')}.`);
            }
            return { ok: true, value: candidate };
        }
        case 'text': {
            if (typeof value !== 'string') {
                return fail('invalid_args', `${def.path} expects a string.`);
            }
            const missing = (def.markers || []).filter(marker => !value.includes(marker));
            if (missing.length > 0) {
                return fail('invalid_args', `${def.path} must keep the markers: ${missing.join(', ')}.`);
            }
            return { ok: true, value };
        }
        default:
            return fail('invalid_args', `${def.path} has an unsupported kind.`);
    }
}

/**
 * Normalize the optional catalog group filter: a blank or absent value means
 * "no filter", anything but a string is an argument error the caller has to
 * surface, and a trimmed id has to match a registered group.
 */
function normalizeCatalogGroup(group) {
    if (group === undefined || group === null) {
        return null;
    }
    if (typeof group !== 'string') {
        throw new Error(`invalid_args — group must be a string; got ${typeof group}.`);
    }
    const normalized = group.trim();
    return normalized === '' ? null : normalized;
}

/**
 * Discovery catalog for the AI. Carries metadata only — never current values,
 * so listing fields costs the same whether the prompts are long or short.
 * `group` narrows the `fields` list only; the group index, schema index, and
 * schema text fields stay complete so the caller keeps the full map.
 */
export function buildConfigFieldCatalog({ schema, group } = {}) {
    const groupFilter = normalizeCatalogGroup(group);
    if (groupFilter !== null && !GROUPS.some(entry => entry.id === groupFilter)) {
        throw new Error(`invalid_args — unknown group "${groupFilter}"; available groups: ${GROUPS.map(entry => entry.id).join(', ')}.`);
    }
    const fields = Object.values(CONFIG_FIELDS)
        .filter(def => groupFilter === null || def.group === groupFilter)
        .map(def => {
            const entry = {
                path: def.path,
                key: def.key,
                group: def.group,
                kind: def.kind,
                label: def.label,
                summary: def.summary,
                text: def.kind === 'text',
            };
            if (Number.isFinite(def.min)) entry.min = def.min;
            if (Number.isFinite(def.max)) entry.max = def.max;
            if (def.values) entry.values = [...def.values];
            if (def.markers) entry.markers = [...def.markers];
            return entry;
        });
    const schema_index = (Array.isArray(schema) ? schema : []).map((item, index) => ({
        index,
        id: String(item?.id || ''),
        label: String(item?.label || item?.id || ''),
    }));
    return {
        groups: GROUPS.map(group => ({ ...group })),
        fields,
        schema_index,
        schema_text_fields: SCHEMA_TEXT_FIELDS.map(field => ({ ...field })),
    };
}
