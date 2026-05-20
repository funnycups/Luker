// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph schema — IterationStudio adapter (v2, IDE-style).
 *
 * Migrated from the v1 contract. The schema is an array of node-type
 * definitions; the AI edits it via three tools (set / remove / reorder).
 *
 * `live()` returns the EFFECTIVE node-type schema (respecting per-character
 * override when available). `commit()` writes the new schema back to the
 * current default scope: global by default; per-character when a character
 * is active. The "Apply to Global" / "Apply to Character" buttons in the
 * preview pane let the user pick scope explicitly.
 *
 * `normalizeToolCallToEdit` uses the sandbox-diff pattern that Task 17
 * established for the orchestrator: clone live → run the legacy tool
 * executor against a fake `{ workingProfile: { schema } }` session →
 * emit one coarse `set('', newSchema)` edit.
 *
 * Memory-graph schema editing is global-only in terms of session bucket
 * partitioning: a single session list lives under
 * `extension_settings.memory_graph.iterStudioV2Schema`. Per-character
 * persistence is opt-in via the action button, not via scope routing.
 *
 * Factory takes deps explicitly to avoid a circular import with main.js.
 */

import { defineAdapter } from '../../iteration-studio/index.js';
import { escapeHtml } from '../../utils.js';

const MG_SCHEMA_MODULE_NAME = 'memory_graph';
const SESSIONS_BUCKET_KEY = 'iterStudioV2Schema';
const LEGACY_GLOBAL_HISTORY_KEY = 'schemaIterationHistory';

const TOOL_SET_NODE_TYPE = 'mg_schema_set_node_type';
const TOOL_REMOVE_NODE_TYPE = 'mg_schema_remove_node_type';
const TOOL_REORDER_NODE_TYPES = 'mg_schema_reorder_node_types';

const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_mg_schema_continue_iteration',
    finalize: 'luker_mg_schema_finalize_iteration',
});

function getSillyTavernContext() {
    if (typeof globalThis === 'undefined') return null;
    const st = globalThis.SillyTavern;
    if (st && typeof st.getContext === 'function') {
        try { return st.getContext(); } catch { /* ignore */ }
    }
    return null;
}

function getMgSettingsRoot() {
    const ctx = getSillyTavernContext();
    const all = ctx?.extensionSettings;
    if (!all || typeof all !== 'object') return null;
    if (!all[MG_SCHEMA_MODULE_NAME] || typeof all[MG_SCHEMA_MODULE_NAME] !== 'object') {
        all[MG_SCHEMA_MODULE_NAME] = {};
    }
    return all[MG_SCHEMA_MODULE_NAME];
}

function persistSettings() {
    try {
        if (typeof globalThis !== 'undefined' && typeof globalThis.saveSettingsDebounced === 'function') {
            globalThis.saveSettingsDebounced();
        }
    } catch { /* ignore */ }
}

function formatTimestamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
        return new Date(n).toLocaleString();
    } catch {
        return String(value);
    }
}

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

function renderSchemaSummaryHtml(schema, opts) {
    const list = Array.isArray(schema) ? schema : [];
    if (list.length === 0) {
        return `<div class="luker-iteration-studio-empty">${escapeHtml(opts.i18n('No node types defined.'))}</div>`;
    }
    const rows = list.map((entry, index) => {
        const id = String(entry?.id || `entry_${index}`);
        const label = String(entry?.label || '');
        const cols = Array.isArray(entry?.tableColumns) ? entry.tableColumns.join(', ') : '';
        const flags = [
            entry?.alwaysInject ? opts.i18n('alwaysInject') : '',
            entry?.latestOnly ? opts.i18n('latestOnly') : '',
            entry?.compression?.mode && entry.compression.mode !== 'none' ? opts.i18nFormat('compress=${0}', entry.compression.mode) : '',
        ].filter(Boolean).join(' · ');
        return `
<div class="luker-iteration-studio-card">
    <div class="luker-iteration-studio-card-title">
        <span class="luker-iteration-studio-card-id">${escapeHtml(id)}</span>
        ${label ? `<span class="luker-iteration-studio-card-label">${escapeHtml(label)}</span>` : ''}
    </div>
    ${cols ? `<div class="luker-iteration-studio-card-cols">${escapeHtml(opts.i18nFormat('columns: ${0}', cols))}</div>` : ''}
    ${flags ? `<div class="luker-iteration-studio-card-flags">${escapeHtml(flags)}</div>` : ''}
</div>`;
    }).join('');
    return `<div class="luker-iteration-studio-schema">${rows}</div>`;
}

function stringifyForPrompt(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/**
 * @param {{
 *   normalizeNodeTypeSchema: (schema: any) => any[],
 *   getEffectiveNodeTypeSchema: (context: any, settings: any) => any[],
 *   persistCharacterSchemaOverride: (context: any, avatar: string, schema: any) => Promise<boolean>,
 *   saveSettings: () => Promise<void>,
 *   i18n: (key: string) => string,
 *   i18nFormat: (key: string, ...args: any[]) => string,
 *   refreshRootUi?: (root: any) => void,
 * }} deps
 */
export function createSchemaIterationAdapter(deps) {
    const {
        normalizeNodeTypeSchema,
        getEffectiveNodeTypeSchema,
        persistCharacterSchemaOverride,
        saveSettings,
        i18n,
        i18nFormat,
        refreshRootUi = () => {},
    } = deps;

    function readLiveSchema() {
        const ctx = getSillyTavernContext();
        const settings = getMgSettingsRoot() || {};
        const effective = getEffectiveNodeTypeSchema(ctx, settings);
        return normalizeNodeTypeSchema(effective);
    }

    async function commitLiveSchema(newSchema) {
        const ctx = getSillyTavernContext();
        const settings = getMgSettingsRoot() || {};
        const normalized = normalizeNodeTypeSchema(newSchema);
        const avatar = String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
        if (avatar) {
            // Per-character override path — matches the v1 default scope rule:
            // when a character is active, write to character override; else global.
            const ok = await persistCharacterSchemaOverride(ctx, avatar, normalized);
            if (ok) return;
            // Fall through to global if the override write was rejected.
        }
        settings.nodeTypeSchema = normalized;
        await saveSettings();
    }

    function sessionsBucket() {
        const root = getMgSettingsRoot();
        if (!root) return {};
        if (!root[SESSIONS_BUCKET_KEY] || typeof root[SESSIONS_BUCKET_KEY] !== 'object') {
            root[SESSIONS_BUCKET_KEY] = {};
        }
        return root[SESSIONS_BUCKET_KEY];
    }

    // Sandbox-side executor: mutates the provided `list` array per the
    // legacy v1 logic. Returns true if the list was changed, false otherwise.
    // Throws on malformed input.
    function applyToolCallToSandbox(call, sandboxSession) {
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

    return defineAdapter({
        id: 'mg_schema',
        title: i18n('Memory Graph Schema Studio'),
        mode: 'mg_schema',
        layout: 'split',
        popupClassName: 'luker_mg_schema_iter_popup',
        i18n,
        i18nFormat,

        live: () => readLiveSchema(),
        commit: async (newLive) => { await commitLiveSchema(newLive); },
        sessionScope: () => 'global',

        listSessions: async () => {
            const bucket = sessionsBucket();
            return Object.values(bucket)
                .filter(s => s && typeof s === 'object' && s.id)
                .map(s => ({
                    id: String(s.id),
                    title: String(s.title || s.id),
                    updatedAt: Number(s.updatedAt || 0),
                }))
                .sort((a, b) => b.updatedAt - a.updatedAt);
        },
        loadSession: async (_scope, id) => {
            const bucket = sessionsBucket();
            const stored = bucket[String(id)];
            return stored ? structuredClone(stored) : null;
        },
        saveSession: async (_scope, session) => {
            if (!session?.id) return;
            const bucket = sessionsBucket();
            bucket[String(session.id)] = structuredClone(session);
            persistSettings();
        },
        deleteSession: async (_scope, id) => {
            const bucket = sessionsBucket();
            delete bucket[String(id)];
            persistSettings();
        },
        clearObsoleteSessions: async () => {
            const root = getMgSettingsRoot();
            if (root && LEGACY_GLOBAL_HISTORY_KEY in root) {
                delete root[LEGACY_GLOBAL_HISTORY_KEY];
                persistSettings();
            }
        },

        controlToolNames: CONTROL_TOOL_NAMES,

        buildToolCatalog: () => [
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
        ],

        describeTool: (name) => {
            switch (name) {
                case TOOL_SET_NODE_TYPE: return i18n('set node type');
                case TOOL_REMOVE_NODE_TYPE: return i18n('remove node type');
                case TOOL_REORDER_NODE_TYPES: return i18n('reorder node types');
                default: return name;
            }
        },

        normalizeToolCallToEdit: async (call, ctx) => {
            const before = ctx?.live;
            if (!Array.isArray(before)) return [];
            const beforeClone = structuredClone(before);
            const sandboxSession = { workingProfile: { schema: structuredClone(before) } };
            let changed = false;
            try {
                changed = applyToolCallToSandbox(call, sandboxSession);
            } catch (error) {
                console.warn('[mg-schema-adapter] sandbox executor failed', error);
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
        },

        buildSystemPrompt: () => [
            'You are editing the Memory Graph node-type schema for a SillyTavern chat.',
            '',
            'The schema is an array of node-type definitions. Each entry describes a kind of fact the memory graph stores about the chat — characters, locations, events, relationships, etc. The runtime extracts these from the conversation and feeds them back to the writing model when relevant.',
            '',
            'Key fields per entry:',
            '- id (snake_case): stable identifier, unique. Renaming an id loses prior data, so prefer leaving existing ids alone.',
            '- label: human display name.',
            '- tableColumns: the data columns stored (e.g. ["name", "personality", "current_location"]).',
            '- embeddingColumns: subset of tableColumns used for semantic recall. Empty = embed all columns.',
            '- columnHints: per-column hints the extraction LLM uses when filling that column.',
            '- requiredColumns: must be populated when the type is emitted.',
            '- primaryKeyColumns: identity columns for upsert (e.g. ["name"] for a character_sheet).',
            '- editable: end-user may edit entries in the graph viewer.',
            '- level: 0 = raw leaves, higher = summary tiers.',
            '- extractHint: top-level guidance for the extractor about when to emit this type.',
            '- extractionInstructions: per-type instructions appended to the extraction system prompt when this type is active this round. Move type-specific rules (e.g. "at most one event per batch") here instead of the base prompt so they only apply when the type is gated on.',
            '- extractEveryN: per-type cadence. 1 (default) = every extraction pass. Use 2/3/5 for slow-changing tables so they update less frequently and save LLM calls. Always-fresh tables (event) should stay at 1.',
            '- keywords: recall hints (presence in chat boosts retrieval).',
            '- alwaysInject (BOOL): bypass recall and always inject into the prompt. Use sparingly — only for very low-volume, must-always-be-known types.',
            '- latestOnly (BOOL): only the most recent entry is retained — appropriate for state-like data (e.g. current_emotional_state).',
            '- compression: hierarchical/flat fold-up rules (mode, threshold, fanIn, maxDepth, keepRecentLeaves, summarizeInstruction).',
            '',
            'Tools you can call:',
            `- ${TOOL_SET_NODE_TYPE}: upsert a single node type by id. Pass ALL fields you want set; existing values for the same id are replaced.`,
            `- ${TOOL_REMOVE_NODE_TYPE}: remove a node type by id. Refuses to remove the last remaining type.`,
            `- ${TOOL_REORDER_NODE_TYPES}: reorder by full list of ids in new order. All current ids must appear.`,
            '',
            'Editing principles:',
            '- Prefer adding a new node type over overloading an existing one.',
            '- Keep tableColumns small and orthogonal. Each column should be answerable from the chat surface.',
            '- alwaysInject is for foundational rare data only (e.g. world_constants), never event-level data.',
            '- latestOnly is for replaceable state, not append-only events.',
            '- Use compression: hierarchical for event-like types that accumulate; threshold of 8–12 leaves is a reasonable default.',
            '',
            'When the user asks for a change, call the appropriate tools to enact it. If multiple changes apply, you may emit multiple tool calls in one turn. After editing, call the finalize tool with a short summary; if more rounds are needed, call the continue tool.',
        ].join('\n'),

        buildUserPrompt: (session, userText, opts) => {
            const ctx = getSillyTavernContext();
            const settings = getMgSettingsRoot() || {};
            const sourceScope = opts?.sourceScope || (ctx?.characters?.[ctx?.characterId]?.avatar ? 'character' : 'global');
            const sourceName = opts?.sourceName || '';
            const liveSchema = readLiveSchema();
            const currentSchema = stringifyForPrompt(liveSchema);
            const baselineSchema = stringifyForPrompt(normalizeNodeTypeSchema(settings?.nodeTypeSchema || []));
            const lines = [
                `[Iteration scope] ${sourceScope}${sourceName ? ` — ${sourceName}` : ''}`,
                '',
                '[Current working schema]',
                currentSchema,
            ];
            if (baselineSchema && baselineSchema !== currentSchema) {
                lines.push('', '[Global baseline schema for reference]', baselineSchema);
            }
            lines.push('', '[User request]', userText);
            return lines.join('\n');
        },

        getRequestPresetOptions: (settings) => {
            const s = settings || getMgSettingsRoot() || {};
            return {
                apiPresetName: String(s?.schemaIterationApiPresetName || '').trim(),
                llmPresetName: String(s?.schemaIterationPresetName || '').trim(),
            };
        },

        renderMessageCard: (message) => {
            const auto = message?.auto ? ' luker-iter-auto' : '';
            const role = String(message?.role || 'assistant');
            const text = escapeHtml(message?.content || '');
            const edits = Array.isArray(message?.appliedEdits) ? message.appliedEdits.length : 0;
            const rolledBack = message?.rolledBack
                ? ` <span class="luker-iter-rolledback">[${escapeHtml(i18n('rolled back'))}]</span>`
                : '';
            const editsLine = edits > 0
                ? `<div class="luker-iter-msg-edits">${escapeHtml(i18n('Edits applied:'))} ${edits}${rolledBack}</div>`
                : '';
            const rollbackBtn = (role === 'assistant' && edits > 0 && !message?.rolledBack)
                ? `<div class="menu_button menu_button_small" data-iter-action="rollback-to-message" data-iter-message-id="${escapeHtml(message?.id || '')}">${escapeHtml(i18n('Rollback'))}</div>`
                : '';
            return `
<div class="luker-iter-msg luker-iter-msg-${escapeHtml(role)}${auto}">
    <div class="luker-iter-msg-body">${text}</div>
    ${editsLine}
    ${rollbackBtn}
</div>`;
        },

        renderHistoryItem: (meta) => `
<div class="luker-iter-history-item">
    <div class="menu_button menu_button_small" data-iter-action="load-session" data-iter-session-id="${escapeHtml(meta?.id || '')}">${escapeHtml(meta?.title || meta?.id || '')}</div>
    <span class="luker-iter-history-time">${escapeHtml(formatTimestamp(meta?.updatedAt))}</span>
    <div class="menu_button menu_button_small fa-solid fa-trash" data-iter-action="delete-session" data-iter-session-id="${escapeHtml(meta?.id || '')}" title="${escapeHtml(i18n('Delete'))}"></div>
</div>`,

        renderPreviewPane: (state) => {
            const title = escapeHtml(i18n('Memory Graph Schema'));
            const liveSchema = Array.isArray(state?.live) ? state.live : [];
            const summary = renderSchemaSummaryHtml(liveSchema, { i18n, i18nFormat });
            const ctx = getSillyTavernContext();
            const hasAvatar = Boolean(String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim());
            const actions = `
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply-global">${escapeHtml(i18n('Apply to Global'))}</div>
    ${hasAvatar ? `<div class="menu_button" data-iter-custom-action="apply-character">${escapeHtml(i18n('Apply to Character'))}</div>` : ''}
</div>`;
            return `<div class="luker-studio-panel-title">${title}</div>${summary}${actions}`;
        },

        handleAction: async (actionId, { root }) => {
            const ctx = getSillyTavernContext();
            const settings = getMgSettingsRoot() || {};
            const live = readLiveSchema();
            const normalized = normalizeNodeTypeSchema(live);
            if (actionId === 'apply-global') {
                settings.nodeTypeSchema = normalized;
                await saveSettings();
                refreshRootUi(root);
                return;
            }
            if (actionId === 'apply-character') {
                const avatar = String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
                if (!avatar) {
                    throw new Error(i18n('No active character selected.'));
                }
                const ok = await persistCharacterSchemaOverride(ctx, avatar, normalized);
                if (!ok) {
                    throw new Error(i18n('Failed to persist character schema override.'));
                }
                refreshRootUi(root);
            }
        },
    });
}
