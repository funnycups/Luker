// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data source backed by the memory-graph extension.

import { LOREBOOK_READ_TOOL_DEFS, isLorebookReadTool, runLorebookReadTool } from '../../../iteration-library/tools/lorebook-reads.js';
import { readFieldsByPaths } from '../../../iteration-library/read-fields-helper.js';
import { requestToolCallsWithRetry } from '../../../iteration-library/runner.js';
import { getChatCompletionConnectionProfiles } from '../../connection-manager/profile-resolver.js';
import { listEmbeddingProfiles, listRerankProfiles } from '../../connection-manager/embed-rerank.js';
import { getEffectiveSettings } from '../character-overrides.js';
import { LEGACY_SCHEMA_ITER_SYSTEM_PROMPT } from '../config-iteration/prompt-migration.js';
import { CONTROL_TOOL_NAMES, buildToolCatalog, normalizeToolCallToEdit, projectNodeTypeForRead } from '../config-iteration/tools.js';
import { buildSchemaExportPayload, getSchemaExportFileName, parseSchemaImportPayload } from '../import-export.js';
import {
    addMemoryStatusListener,
    applyRawGraphJson,
    clearMemoryAdvancedOverride,
    commitGraphUiMutation,
    createNode,
    ensureMemoryStoreLoaded,
    ensureStoreSyncedWithChat,
    exportMemoryGraph,
    getChatKey,
    getDefaultNodeTypeSchema,
    getMemoryGraphStats,
    getMemorySettingsView,
    getMemoryStatus,
    getRawGraphJson,
    getRebuildableLatestSeq,
    getSettings,
    importMemoryGraphFile,
    normalizeNodeTypeSchema,
    openMemoryConfigStudio,
    openMemoryGraphStudio,
    resetMemoryGraphForChat,
    runFillGraph,
    runManualCompression,
    runRebuildGraph,
    runRebuildRecent,
    runRecallDebug,
    runVectorRecomputeForChat,
    saveMemoryAdvancedSettings,
    setMemorySetting,
    stopMemoryExtraction,
    syncGraphVectorsAfterMutation,
} from '../main.js';
import { normalizeStoreForRuntime } from '../persistence.js';
import { getMemoryGraphReadApi } from '../read-api.js';
import { getMemoryGraphWriteApi } from '../write-api.js';
import { commitSkipMessage } from './edit/edit-model.js';
import { createMutator, patchNode, addExactEdge, removeExactEdge, replaceExactEdge } from './edit/graph-edit.js';
import { i18n } from './i18n.js';
import { readFilterSettings, writeFilterSettings, previewFloor, filterStatus } from './filter/filter-runtime.js';
import { SUBMIT_FILTER, diagnoseSystemPrompt, diagnoseUserPrompt, readDiagnosis } from './filter/filter-ai.js';
import { countTokens, readEntries, clearEntries, TOKENS_EVENT, META_KEY as TOKENS_META_KEY } from './token-stats.js';
import { buildTaskMessages as aiTaskMessages, rewriteSystemPrompt, rewriteUserPrompt, suggestSystemPrompt, suggestUserPrompt } from './ai/ai-model.js';

const CHAT_EVENTS = ['CHAT_CHANGED', 'CHAT_DELETED'];
const MESSAGE_EVENTS = ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED'];

export class SourceError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const getContext = () => Luker.getContext();

function chatLabelOf(ctx) {
    try {
        if (ctx.groupId) {
            const group = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId));
            return group?.name || '';
        }
        return ctx.name2 || '';
    } catch {
        return '';
    }
}

export function createLukerSource() {
    let api = null;
    let tokenCache = { at: 0, core: 0, focus: 0 };

    const resolveApi = () => {
        const ctx = getContext();
        api = ctx.getExtensionApi('memory-graph');
        return { ctx, api };
    };

    return {
        async load() {
            const { ctx, api: mg } = resolveApi();
            const chatId = typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
            if (!chatId) throw new SourceError('no-chat');
            const store = (await ensureStoreSyncedWithChat(ctx)) || (await ensureMemoryStoreLoaded(ctx));
            if (!store) throw new SourceError('no-chat');
            const read = getMemoryGraphReadApi(store, ctx);
            const nodes = read.listNodes({ activeOnly: false });
            const edges = read.listEdges({});
            // Full schema (labels + column hints) for display names; the
            // read-api view omits those. Fall back to the read-api view.
            let schema = null;
            try {
                const info = mg.getSchemaScopeInfo(ctx, getSettings());
                if (Array.isArray(info?.schema)) schema = { types: structuredClone(info.schema) };
            } catch { schema = null; }
            if (!schema) {
                try { schema = read.getSchema(); } catch { schema = null; }
            }
            let columnLabels = {};
            try { columnLabels = structuredClone(ctx.extensionSettings?.[LABEL_KEY]?.columnLabels || {}); } catch { columnLabels = {}; }
            let injection = null;
            try { injection = mg.getCurrentInjection(ctx) || read.getInjectionState?.(); } catch { injection = null; }
            let lastRecall = null;
            try { lastRecall = await mg.getLastRecallProjection(ctx); } catch { lastRecall = null; }
            let tokens = null;
            try {
                const at = Number(lastRecall?.at || 0);
                if (at && tokenCache.at !== at) {
                    const [core, focus] = await Promise.all([countTokens(ctx, lastRecall.blocks?.corePacket), countTokens(ctx, lastRecall.blocks?.focusPacket)]);
                    tokenCache = { at, core, focus };
                }
                tokens = { current: at ? { ...tokenCache } : null, entries: structuredClone(readEntries(ctx)) };
            } catch { tokens = null; }
            return {
                chatKey: getChatKey(ctx),
                chatLabel: chatLabelOf(ctx),
                loadedAt: Date.now(),
                nodes,
                edges,
                schema,
                columnLabels,
                injection,
                lastRecall,
                tokens,
            };
        },

        /** Clears this chat's token log; returns the old entries for undo. */
        clearTokens() {
            const ctx = getContext();
            const previous = structuredClone(readEntries(ctx));
            clearEntries(ctx);
            return previous;
        },

        restoreTokens(entries) {
            const ctx = getContext();
            if (!ctx.chatMetadata) return;
            ctx.chatMetadata[TOKENS_META_KEY] = { v: 1, entries: structuredClone(entries || []) };
            ctx.saveMetadataDebounced?.();
        },

        /**
         * @param {(reason: string) => void} onChange
         * @returns {() => void} unsubscribe
         */
        subscribe(onChange) {
            const offs = [];
            try {
                const { ctx, api: mg } = resolveApi();
                const offCommit = mg.onStoreCommit(() => onChange('commit'));
                if (typeof offCommit === 'function') offs.push(offCommit);
                const offInjection = mg.onInjectionChanged(() => onChange('injection'));
                if (typeof offInjection === 'function') offs.push(offInjection);
                const events = ctx.eventSource;
                const types = ctx.eventTypes || ctx.event_types || {};
                const bind = (names, reason) => {
                    for (const name of names) {
                        const type = types[name];
                        if (!type || !events?.on) continue;
                        const handler = () => onChange(reason);
                        events.on(type, handler);
                        offs.push(() => events.removeListener?.(type, handler));
                    }
                };
                const onTokens = () => onChange('tokens');
                globalThis.addEventListener?.(TOKENS_EVENT, onTokens);
                offs.push(() => globalThis.removeEventListener?.(TOKENS_EVENT, onTokens));
                bind(CHAT_EVENTS, 'chat');
                bind(MESSAGE_EVENTS, 'message');
            } catch {
                // Subscribing is best effort; load() surfaces real errors.
            }
            return () => {
                for (const off of offs.splice(0)) {
                    try { off(); } catch { /* ignore */ }
                }
            };
        },

        schema: createSchemaAccess(resolveApi),
        ai: createAiAccess(resolveApi),
        edit: { forChat: key => createEditAccess(resolveApi, key) },
        filter: createFilterAccess(),
        settings: createSettingsAccess(),
        ops: createOperationsAccess(),
    };
}

// ---------------------------------------------------------------------------
// Tag filter: settings + sample replies (the scripts live in filter-runtime.js)
// ---------------------------------------------------------------------------

function createFilterAccess() {
    return {
        read: () => readFilterSettings(getContext()),
        write: (settings) => writeFilterSettings(getContext(), settings),
        /** Latest AI replies, newest first: { floor, text }. */
        recentReplies(limit = 8) {
            const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
            const out = [];
            for (let i = chat.length - 1; i >= 0 && out.length < limit; i--) {
                const m = chat[i];
                if (!m || m.is_user || m.is_system || !String(m.mes || '').trim()) continue;
                out.push({ floor: i, text: String(m.mes) });
            }
            return out;
        },
        /** What memory-graph reads for that floor: before / after `plan`. */
        preview: (floor, plan) => previewFloor(getContext(), floor, plan),
        status: () => filterStatus(),
    };
}

// ---------------------------------------------------------------------------
// Editing stored memories
// ---------------------------------------------------------------------------
//
// Every edit runs on a copy of the live store and lands through
// commitGraphUiMutation (persists + fires onStoreCommit), then re-syncs
// vectors. The result carries the before/after snapshot used for undo.

function createEditAccess(resolveApi, expectedChat) {
    const context = () => resolveApi().ctx;
    function checkTarget() {
        const ctx = context();
        if (!expectedChat || expectedChat === 'invalid_target' || getChatKey(ctx) !== expectedChat) {
            throw new SourceError('chat-changed', i18n('The active chat has changed.'));
        }
        return ctx;
    }
    const mutator = createMutator({
        normalize: normalizeStoreForRuntime,
        getLive: () => ensureStoreSyncedWithChat(checkTarget()),
        async commit(beforeStore, afterStore) {
            const ctx = checkTarget();
            const chatKey = String(getChatKey(ctx) || '').trim();
            if (!chatKey) throw new SourceError('no-chat');
            const skipped = commitSkipMessage(await commitGraphUiMutation(ctx, chatKey, { beforeStore, afterStore, replaceGraph: false, seq: null }));
            if (skipped) throw new SourceError('write-skipped', skipped);
            try { await syncGraphVectorsAfterMutation(ctx, chatKey, afterStore); } catch (err) { console.warn('[memory-graph/lens] vector sync after edit failed', err); }
        },
    });
    const writeApi = (working) => getMemoryGraphWriteApi(working, context(), { onCommit: null, useInFlightAnchor: false, preserveSeqOnEdit: true });
    const check = (result) => {
        if (result && result.ok === false) throw new SourceError('write-failed', result.error?.message || result.error?.code || 'edit failed');
        return result;
    };
    return {
        /** @param {{ fields?: object, title?: string, type?: string, level?: string, seqTo?: number|null, archived?: boolean, parentId?: string }} patch */
        updateNode: (node, patch) => mutator.mutate(working => patchNode(working, node.id, patch)),
        createNode: (spec) => mutator.mutate(working => createNode(working, spec).id),
        removeNode: (id) => mutator.mutate(async working => check(await writeApi(working).deleteNode({ id }))),
        addEdge: (edge) => mutator.mutate(working => addExactEdge(working, edge)),
        updateEdge: (edge, next) => mutator.mutate(working => replaceExactEdge(working, edge, next)),
        removeEdge: (edge) => mutator.mutate(working => removeExactEdge(working, edge)),
        restore: (snapshot) => mutator.restore(snapshot),
    };
}

// ---------------------------------------------------------------------------
// Settings page and graph operations
// ---------------------------------------------------------------------------

function createSettingsAccess() {
    return {
        read() {
            const view = getMemorySettingsView(getContext());
            const brief = ({ id, name }) => ({ id, name });
            view.options.embeddingProfiles = listEmbeddingProfiles().map(brief);
            view.options.rerankProfiles = listRerankProfiles().map(brief);
            return view;
        },
        set: (key, value) => setMemorySetting(key, value),
        saveAdvanced: (values, scope, avatar) => saveMemoryAdvancedSettings(getContext(), values, scope, avatar),
        clearAdvanced: avatar => clearMemoryAdvancedOverride(getContext(), avatar),
    };
}

function createOperationsAccess() {
    const ctx = getContext;
    return {
        status: getMemoryStatus,
        onStatus: addMemoryStatusListener,
        stats: () => getMemoryGraphStats(ctx()),
        latestSeq: () => getRebuildableLatestSeq(ctx()),
        stop: stopMemoryExtraction,
        fill: () => runFillGraph(ctx()),
        rebuild: () => runRebuildGraph(ctx()),
        rebuildRecent: (turns) => runRebuildRecent(ctx(), turns),
        compress: (values) => runManualCompression(ctx(), getEffectiveSettings(ctx(), getSettings()), values),
        reset: () => resetMemoryGraphForChat(ctx()),
        vectors: (mode) => runVectorRecomputeForChat(ctx(), mode),
        exportGraph: () => exportMemoryGraph(ctx()),
        async importGraph() {
            const file = await pickFile('.json,application/json');
            if (file) await importMemoryGraphFile(ctx(), file);
        },
        recallDebug: (query) => runRecallDebug(ctx(), query),
        async rawJson() {
            await ensureMemoryStoreLoaded(ctx());
            return getRawGraphJson(ctx());
        },
        async readRawEdit() {
            const chatKey = getChatKey(ctx());
            await ensureStoreSyncedWithChat(ctx());
            if (getChatKey(ctx()) !== chatKey || chatKey === 'invalid_target') throw new SourceError('chat-changed', i18n('The active chat has changed.'));
            return { chatKey, text: getRawGraphJson(ctx()) };
        },
        applyRawJson: (text, base) => applyRawGraphJson(ctx(), text, base),
        openConfigStudio: () => openMemoryConfigStudio(ctx()),
        openGraphStudio: () => openMemoryGraphStudio(ctx()),
    };
}

// ---------------------------------------------------------------------------
// AI schema assistant
// ---------------------------------------------------------------------------
//
// Reuses memory-graph's exported pieces: the tool catalog + sandbox
// (config-iteration/tools.js), the retired schema-only system prompt and
// Luker's tool-calling runner. Only the schema half of the configuration
// workbench is offered. Edits land in the structure editor as unsaved drafts;
// nothing is written until the user saves there. Sessions live in our own
// settings key.

const SCHEMA_READ_TOOL = {
    type: 'function',
    function: {
        name: 'mg_schema_read_fields',
        description: 'Read exact values from the current working MG node-type schema by lodash-style paths. Read-only. The root is the schema array; common paths: "[N].id", "[N].label", "[N].tableColumns", "[N].columnHints", "[N].extractionInstructions", "[N].compression.mode", "length". Prefer specific indexed paths.',
        parameters: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Lodash-style paths into the schema array.' } },
            required: ['paths'],
            additionalProperties: false,
        },
    },
};
const LANGUAGE_NOTE = [
    '',
    '# Working mode',
    'Your edits go into a working draft that the user reviews in a visual editor and saves themselves; do not ask them to confirm each step.',
    i18n('Always reply to the user in English, in short plain sentences. Avoid technical field names (tableColumns, primaryKeyColumns…) in replies; describe changes by their display names.'),
    i18n('Write label and columnHints values in English unless the user asks otherwise. Keep existing column keys unchanged; new column keys must be snake_case ASCII.'),
].join('\n');

function createAiAccess(resolveApi) {
    const bucket = (ctx) => {
        const all = ctx.extensionSettings || {};
        all[LABEL_KEY] ||= {};
        all[LABEL_KEY].aiSessions ||= {};
        return all[LABEL_KEY].aiSessions;
    };
    const scopeKey = (ctx, mg) => {
        const info = mg.getSchemaScopeInfo(ctx, getSettings());
        return info?.hasAvatar ? `character_${info.avatar}` : 'global';
    };

    // ----- Which model each AI uses ------------------------------------------
    // Stored in our own settings; '' = follow memory-graph's request presets.
    // The 'tools' group (AI polish / improve type) may also say 'same' = the assistant's.
    const aiSettings = (ctx) => {
        const all = ctx.extensionSettings || {};
        all[LABEL_KEY] ||= {};
        all[LABEL_KEY].ai ||= {};
        const ai = all[LABEL_KEY].ai;
        ai.assistant ||= { api: '', preset: '' };
        ai.tools ||= { same: true, api: '', preset: '' };
        if (ai.tools.builtinPrompt === undefined) ai.tools.builtinPrompt = true;
        return ai;
    };
    const presetsFor = (ctx, settings, role) => {
        const ai = aiSettings(ctx);
        const group = role === 'tools' && !ai.tools.same ? ai.tools : ai.assistant;
        return {
            apiPresetName: String(group.api || settings?.requestApiPresetName || '').trim(),
            llmPresetName: String(group.preset || settings?.requestLlmPresetName || '').trim(),
        };
    };
    const runnerSettings = (settings) => ({ toolCallRetryMax: settings?.toolCallRetryMax, rpmLimit: settings?.rpmLimit });

    const SUBMIT_TEXT = {
        type: 'function',
        function: {
            name: 'submit_text',
            description: 'Submit the rewritten text. Call exactly once.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        },
    };

    const useBuiltin = () => {
        try { return aiSettings(resolveApi().ctx).tools.builtinPrompt !== false; } catch { return true; }
    };

    async function oneShot(role, { system, user, tools, allowedNames, signal = null }) {
        const { ctx } = resolveApi();
        const settings = getSettings();
        return requestToolCallsWithRetry(ctx, runnerSettings(settings), {
            taskMessages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            runtimeWorldInfo: null,
            ...presetsFor(ctx, settings, role),
            tools,
            allowedNames,
            abortSignal: signal,
            includeAssistantText: true,
            allowNoToolCalls: true,
        });
    }

    return {
        /** Connection profiles / generation presets the user can pick, plus current choices. */
        async settings() {
            const { ctx } = resolveApi();
            const settings = getSettings();
            const connections = (getChatCompletionConnectionProfiles() || []).map(p => p.name).filter(Boolean);
            let presets = [];
            try {
                const names = ctx.getPresetManager('openai')?.getAllPresets();
                presets = Array.isArray(names) ? [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))] : [];
            } catch { presets = []; }
            return {
                connections,
                presets,
                memory: { api: String(settings?.requestApiPresetName || ''), preset: String(settings?.requestLlmPresetName || '') },
                ai: structuredClone(aiSettings(ctx)),
            };
        },

        async saveSettings(next) {
            const { ctx } = resolveApi();
            const ai = aiSettings(ctx);
            ai.assistant = { api: String(next?.assistant?.api || ''), preset: String(next?.assistant?.preset || '') };
            ai.tools = { same: next?.tools?.same !== false, api: String(next?.tools?.api || ''), preset: String(next?.tools?.preset || ''), builtinPrompt: next?.tools?.builtinPrompt !== false };
            ctx.saveSettingsDebounced();
        },

        /** Sends a tiny request with the given role's model. */
        async test(role) {
            const result = await oneShot(role, {
                system: 'Connectivity check. Call submit_text with the text "OK".',
                user: 'ping',
                tools: [SUBMIT_TEXT],
                allowedNames: ['submit_text'],
            });
            const ok = (result?.toolCalls || []).some(c => c?.name === 'submit_text') || Boolean(String(result?.assistantText || '').trim());
            if (!ok) throw new SourceError('ai-empty', i18n('The AI returned nothing'));
            return true;
        },

        /** Tag filter AI diagnosis: proposes a black / white list for one reply. */
        async diagnoseFilter(sample) {
            const result = await oneShot('tools', {
                system: diagnoseSystemPrompt(),
                user: diagnoseUserPrompt(sample),
                tools: [SUBMIT_FILTER],
                allowedNames: ['submit_filter'],
            });
            const call = (result?.toolCalls || []).find(c => c?.name === 'submit_filter');
            if (!call) throw new SourceError('ai-empty', i18n('The AI gave no plan'));
            return readDiagnosis(call.args, sample);
        },

        /** AI polish for one schema text (item hint / type intro). */
        async rewrite(request) {
            const result = await oneShot('tools', {
                system: rewriteSystemPrompt(request.kind, { builtin: useBuiltin() }),
                user: rewriteUserPrompt(request),
                tools: [SUBMIT_TEXT],
                allowedNames: ['submit_text'],
            });
            const call = (result?.toolCalls || []).find(c => c?.name === 'submit_text');
            const text = String(call?.args?.text ?? result?.assistantText ?? '').trim();
            if (!text) throw new SourceError('ai-empty', i18n('The AI returned nothing'));
            return text;
        },

        /**
         * Improve this type: the AI calls memory-graph's own set_node_type
         * once; we run it in the sandbox and return the full proposed schema.
         * @returns {{ live: object[], note: string }}
         */
        async suggestType({ live, typeId, request = '', signal = null }) {
            const setTool = buildToolCatalog().find(def => def?.function?.name === 'mg_schema_set_node_type');
            const spec = live.find(t => String(t.id) === String(typeId));
            const result = await oneShot('tools', {
                system: suggestSystemPrompt({ builtin: useBuiltin() }),
                user: suggestUserPrompt({ spec, others: live.filter(t => t !== spec), request }),
                tools: [setTool],
                allowedNames: ['mg_schema_set_node_type'],
                signal,
            });
            const call = (result?.toolCalls || []).find(c => c?.name === 'mg_schema_set_node_type');
            if (!call) throw new SourceError('ai-empty', String(result?.assistantText || '').trim() || i18n('The AI gave no suggestion'));
            const nodeType = { ...(call.args?.node_type || {}), id: String(typeId) };
            const edits = await normalizeToolCallToEdit(
                { function: { name: 'mg_schema_set_node_type', arguments: JSON.stringify({ node_type: nodeType }) } },
                { live: { schema: live, settings: {} }, normalizeNodeTypeSchema },
            );
            const next = edits?.length ? edits[edits.length - 1].newValue.schema : live;
            return { live: next, note: String(result?.assistantText || '').trim() };
        },

        async listSessions() {
            const { ctx, api: mg } = resolveApi();
            return structuredClone(bucket(ctx)[scopeKey(ctx, mg)] || []);
        },

        async saveSessions(list) {
            const { ctx, api: mg } = resolveApi();
            bucket(ctx)[scopeKey(ctx, mg)] = structuredClone(list);
            ctx.saveSettingsDebounced();
        },

        /**
         * One model round. Read tools run against `live`; edit tools run in
         * memory-graph's sandbox and chain onto `live`.
         */
        async round({ messages, live, signal }) {
            const { ctx, api: mg } = resolveApi();
            const settings = getSettings();
            const effective = getEffectiveSettings(ctx, settings) || settings;
            // The configuration workbench prompt documents settings tools this
            // assistant does not offer, so keep using the schema-only prompt.
            const basePrompt = String(effective?.schemaIterSystemPrompt || '').trim() || LEGACY_SCHEMA_ITER_SYSTEM_PROMPT;
            const control = new Set(Object.values(CONTROL_TOOL_NAMES));
            const info = mg.getSchemaScopeInfo(ctx, settings);
            const avatarForReads = info?.hasAvatar ? String(info.avatar || '') : '';
            const schemaTools = buildToolCatalog().filter(def => String(def?.function?.name || '').startsWith('mg_schema_') && !control.has(def.function.name));
            const catalog = [...schemaTools, SCHEMA_READ_TOOL, ...LOREBOOK_READ_TOOL_DEFS];
            const result = await requestToolCallsWithRetry(ctx, runnerSettings(settings), {
                taskMessages: aiTaskMessages(`${basePrompt}${LANGUAGE_NOTE}`, messages),
                runtimeWorldInfo: null,
                ...presetsFor(ctx, settings, 'assistant'),
                tools: catalog,
                abortSignal: signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
            });
            let current = live;
            const calls = [];
            for (const raw of Array.isArray(result?.toolCalls) ? result.toolCalls : []) {
                const name = String(raw?.name || '');
                if (control.has(name)) continue;
                const args = raw?.args && typeof raw.args === 'object' ? raw.args : {};
                const id = String(raw?.id || '') || `ml_call_${Date.now().toString(36)}_${calls.length}`;
                let content;
                let ok = true;
                try {
                    if (name === SCHEMA_READ_TOOL.function.name) {
                        content = readFieldsByPaths(current.map(projectNodeTypeForRead), args?.paths);
                    } else if (isLorebookReadTool(name)) {
                        const res = await runLorebookReadTool({ id, name, args }, { context: ctx, avatar: avatarForReads });
                        if (res?.ok === false) { ok = false; content = { error: res.error || 'lorebook read failed' }; } else content = res?.result ?? res;
                    } else {
                        const edits = await normalizeToolCallToEdit(
                            { function: { name, arguments: JSON.stringify(args) } },
                            { live: { schema: current, settings: {} }, normalizeNodeTypeSchema },
                        );
                        if (edits?.length) {
                            current = edits[edits.length - 1].newValue.schema;
                            content = { status: 'applied', message: 'Applied to the working draft. The user reviews and saves it.' };
                        } else {
                            ok = false;
                            content = { status: 'noop', message: 'No change produced; the schema already matches. Re-read before retrying.' };
                        }
                    }
                } catch (err) {
                    ok = false;
                    content = { error: String(err?.message || err || 'failed') };
                }
                calls.push({ id, name, args, result: content, ok });
            }
            return {
                assistantText: String(result?.assistantText || ''),
                reasoning: String(result?.reasoning || ''),
                reasoningBlocks: result?.reasoningBlocks || null,
                reasoningDetails: result?.reasoningDetails || null,
                calls,
                live: current,
            };
        },
    };
}

// ---------------------------------------------------------------------------
// Memory structure (node-type schema) read / write
// ---------------------------------------------------------------------------
//
// Mirrors memory-graph's own schema editor: global = settings.nodeTypeSchema
// + saveSettings(); per character = the registered persistCharacterSchemaOverride.
// Everything goes through memory-graph's normalizeNodeTypeSchema first, so the
// stored shape is exactly what the native editor would have written.

const LABEL_KEY = 'memory_lens';

function createSchemaAccess(resolveApi) {
    const labelStore = (ctx) => {
        const all = ctx.extensionSettings || {};
        all[LABEL_KEY] ||= {};
        all[LABEL_KEY].columnLabels ||= {};
        return all[LABEL_KEY].columnLabels;
    };

    return {
        async read() {
            const { ctx, api: mg } = resolveApi();
            const settings = getSettings();
            const info = mg.getSchemaScopeInfo(ctx, settings);
            return {
                scope: info.hasOverride ? 'character' : 'global',
                hasCharacter: Boolean(info.hasAvatar),
                characterName: info.characterName || '',
                types: structuredClone(normalizeNodeTypeSchema(info.schema)),
                defaults: structuredClone(normalizeNodeTypeSchema(getDefaultNodeTypeSchema() || null)),
                labels: structuredClone(labelStore(ctx)),
            };
        },

        /**
         * @param {object[]} types full type list
         * @param {{ scope: 'global'|'character', labels?: object }} options
         * @returns the previous stored state, for undo
         */
        async write(types, { scope, labels = null }) {
            const { ctx, api: mg } = resolveApi();
            const settings = getSettings();
            const normalized = normalizeNodeTypeSchema(types);
            const info = mg.getSchemaScopeInfo(ctx, settings);
            const previous = {
                scope: info.hasOverride ? 'character' : 'global',
                globalTypes: structuredClone(settings.nodeTypeSchema ?? null),
                characterTypes: info.hasOverride ? structuredClone(info.schema) : null,
                labels: structuredClone(labelStore(ctx)),
            };
            if (scope === 'character') {
                if (!info.hasAvatar) throw new SourceError('no-character');
                const ok = await mg.persistCharacterSchemaOverride(ctx, info.avatar, normalized);
                if (!ok) throw new SourceError('write-failed');
            } else {
                settings.nodeTypeSchema = normalized;
                if (info.hasOverride) {
                    // Saving "for everyone" while a character override exists
                    // would otherwise be shadowed by that override.
                    await mg.removeCharacterSchemaOverride(ctx, info.avatar);
                }
            }
            if (labels) {
                const store = labelStore(ctx);
                for (const key of Object.keys(store)) delete store[key];
                Object.assign(store, labels);
            }
            await ctx.saveSettings();
            return previous;
        },

        /** Restores a snapshot returned by write(). */
        async restore(previous) {
            const { ctx, api: mg } = resolveApi();
            const settings = getSettings();
            const info = mg.getSchemaScopeInfo(ctx, settings);
            settings.nodeTypeSchema = previous.globalTypes ?? settings.nodeTypeSchema;
            if (previous.characterTypes && info.hasAvatar) {
                await mg.persistCharacterSchemaOverride(ctx, info.avatar, previous.characterTypes);
            } else if (!previous.characterTypes && info.hasOverride) {
                await mg.removeCharacterSchemaOverride(ctx, info.avatar);
            }
            const store = labelStore(ctx);
            for (const key of Object.keys(store)) delete store[key];
            Object.assign(store, previous.labels || {});
            await ctx.saveSettings();
        },

        async clearCharacter() {
            const { ctx, api: mg } = resolveApi();
            const info = mg.getSchemaScopeInfo(ctx, getSettings());
            if (!info.hasAvatar) return false;
            return Boolean(await mg.removeCharacterSchemaOverride(ctx, info.avatar));
        },

        labels() {
            try {
                const { ctx } = resolveApi();
                return structuredClone(labelStore(ctx));
            } catch {
                return {};
            }
        },

        /**
         * Downloads `types` as a memory-graph schema file (the same format and
         * file name as the native export). Our column names ride along in an
         * extra field the native importer ignores.
         */
        async exportFile(types, labels = {}) {
            const { ctx, api: mg } = resolveApi();
            const info = mg.getSchemaScopeInfo(ctx, getSettings());
            const payload = buildSchemaExportPayload(types, info, normalizeNodeTypeSchema);
            if (labels && Object.keys(labels).length) payload.memoryLensLabels = structuredClone(labels);
            const fileName = getSchemaExportFileName(info);
            ctx.download(JSON.stringify(payload, null, 2), fileName, 'application/json');
            return fileName;
        },

        /**
         * Lets the user pick a schema file and parses it with memory-graph's
         * own validator. Resolves null if no file was picked.
         * @returns {Promise<{ types: object[], labels: object }|null>}
         */
        async importFile() {
            const { ctx } = resolveApi();
            const file = await pickFile('.json,application/json');
            if (!file) return null;
            const text = await ctx.getFileText(file);
            let parsed;
            try { parsed = JSON.parse(text); } catch { throw new SourceError('bad-file', i18n('The file is not valid JSON')); }
            let types;
            try { types = parseSchemaImportPayload(parsed, normalizeNodeTypeSchema); } catch { throw new SourceError('bad-file', i18n('This is not a memory structure file')); }
            const labels = parsed && typeof parsed.memoryLensLabels === 'object' && !Array.isArray(parsed.memoryLensLabels) ? parsed.memoryLensLabels : {};
            return { types: structuredClone(types), labels: structuredClone(labels) };
        },
    };
}

/** Opens the system file picker; resolves the chosen file or null. */
function pickFile(accept) {
    return new Promise((resolve) => {
        // Detached input, same as memory-graph's own importer.
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        let done = false;
        const finish = (file) => { if (!done) { done = true; resolve(file || null); } };
        input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
        input.addEventListener('cancel', () => finish(null), { once: true });
        input.click();
    });
}
