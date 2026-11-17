// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data source backed by the memory-graph extension.

import { requestToolCallsWithRetry } from '../../../iteration-library/runner.js';
import { getChatCompletionConnectionProfiles } from '../../connection-manager/profile-resolver.js';
import { listEmbeddingProfiles, listRerankProfiles } from '../../connection-manager/embed-rerank.js';
import { getEffectiveNodeTypeSchema, getEffectiveSettings } from '../character-overrides.js';
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
    invalidateLatestRecallSnapshot,
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
import { i18n, i18nFormat } from './i18n.js';
import { sanitizeMemoryLensLabels } from './schema/schema-model.js';
import { readFilterSettings, writeFilterSettings, previewFloor, filterStatus } from './filter/filter-runtime.js';
import { SUBMIT_FILTER, diagnoseSystemPrompt, diagnoseUserPrompt, readDiagnosis } from './filter/filter-ai.js';
import { countTokens, readEntries, clearEntries, TOKENS_EVENT, META_KEY as TOKENS_META_KEY } from './token-stats.js';

const CHAT_EVENTS = ['CHAT_CHANGED', 'CHAT_DELETED'];
const MESSAGE_EVENTS = ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED'];
const SETTINGS_EVENTS = [
    'CONNECTION_PROFILE_CREATED',
    'CONNECTION_PROFILE_UPDATED',
    'CONNECTION_PROFILE_DELETED',
    'CONNECTION_PROFILE_LOADED',
    'PRESET_CHANGED',
    'PRESET_DELETED',
    'OAI_PRESET_CHANGED_AFTER',
    'CHARACTER_EDITED',
    'SETTINGS_UPDATED',
];
const LABEL_KEY = 'memory_lens';

export class SourceError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const getContext = () => Luker.getContext();

function chatLabelOf(ctx) {
    if (ctx.groupId) {
        const group = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId));
        return group?.name || '';
    }
    return ctx.name2 || '';
}

export function createLukerSource({ onError = null } = {}) {
    let api = null;
    let tokenCache = { at: 0, core: 0, focus: 0 };

    const resolveApi = () => {
        const ctx = getContext();
        api = ctx.getExtensionApi('memory-graph');
        return { ctx, api };
    };

    const reportError = (message) => {
        if (typeof onError === 'function') {
            onError(message);
        } else {
            globalThis.toastr?.error?.(message, i18n('Memory Lens'));
        }
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

            let schema = null;
            if (typeof mg?.getSchemaScopeInfo === 'function') {
                const info = mg.getSchemaScopeInfo(ctx, getSettings());
                if (Array.isArray(info?.schema)) schema = { types: structuredClone(info.schema) };
            }
            if (!schema) {
                schema = { types: structuredClone(getEffectiveNodeTypeSchema(ctx, getSettings())) };
            }

            const rawLabels = ctx.extensionSettings?.[LABEL_KEY]?.columnLabels;
            const columnLabels = sanitizeMemoryLensLabels(rawLabels);
            const injection = mg?.getCurrentInjection?.(ctx) || read.getInjectionState?.() || null;
            const lastRecall = mg?.getLastRecallProjection ? await mg.getLastRecallProjection(ctx) : null;

            const at = Number(lastRecall?.at || 0);
            if (at && tokenCache.at !== at) {
                const [core, focus] = await Promise.all([
                    countTokens(ctx, lastRecall.blocks?.corePacket),
                    countTokens(ctx, lastRecall.blocks?.focusPacket),
                ]);
                tokenCache = { at, core, focus };
            }
            const tokens = {
                current: at ? { ...tokenCache } : null,
                entries: structuredClone(readEntries(ctx)),
            };

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
            const { ctx, api: mg } = resolveApi();
            if (typeof mg?.onStoreCommit === 'function') {
                const offCommit = mg.onStoreCommit(() => onChange('commit'));
                if (typeof offCommit === 'function') offs.push(offCommit);
            }
            if (typeof mg?.onInjectionChanged === 'function') {
                const offInjection = mg.onInjectionChanged(() => onChange('injection'));
                if (typeof offInjection === 'function') offs.push(offInjection);
            }
            const events = ctx?.eventSource;
            const types = ctx?.eventTypes || ctx?.event_types || {};
            const bind = (names, reason) => {
                for (const name of names) {
                    const type = types[name];
                    if (!type || !events?.on) continue;
                    const handler = () => onChange(reason);
                    events.on(type, handler);
                    offs.push(() => (events.removeListener?.(type, handler) ?? events.off?.(type, handler)));
                }
            };
            const onTokens = () => onChange('tokens');
            globalThis.addEventListener?.(TOKENS_EVENT, onTokens);
            offs.push(() => globalThis.removeEventListener?.(TOKENS_EVENT, onTokens));
            bind(CHAT_EVENTS, 'chat');
            bind(MESSAGE_EVENTS, 'message');
            return () => {
                for (const off of offs.splice(0)) off();
            };
        },

        schema: createSchemaAccess(resolveApi),
        ai: createFilterAiAccess(resolveApi),
        edit: { forChat: key => createEditAccess(resolveApi, key, reportError) },
        filter: createFilterAccess(),
        settings: createSettingsAccess(resolveApi),
        ops: createOperationsAccess(),
    };
}

// ---------------------------------------------------------------------------
// Tag filter: settings + sample replies + AI diagnosis
// ---------------------------------------------------------------------------

function createFilterAiAccess(resolveApi) {
    return {
        async diagnoseFilter(sample) {
            const { ctx } = resolveApi();
            const settings = getSettings();
            const wbAi = ctx.extensionSettings?.workbench?.ai;
            const apiPresetName = String(wbAi?.memory?.connection || settings?.requestApiPresetName || wbAi?.default?.connection || '').trim();
            const llmPresetName = String(wbAi?.memory?.preset || settings?.requestLlmPresetName || wbAi?.default?.preset || '').trim();
            const result = await requestToolCallsWithRetry(ctx, { toolCallRetryMax: settings?.toolCallRetryMax, rpmLimit: settings?.rpmLimit }, {
                taskMessages: [{ role: 'system', content: diagnoseSystemPrompt() }, { role: 'user', content: diagnoseUserPrompt(sample) }],
                runtimeWorldInfo: null,
                apiPresetName,
                llmPresetName,
                tools: [SUBMIT_FILTER],
                allowedNames: ['submit_filter'],
                includeAssistantText: true,
                allowNoToolCalls: true,
            });
            const call = (result?.toolCalls || []).find(c => c?.name === 'submit_filter');
            if (!call) throw new SourceError('ai-empty', i18n('The AI gave no plan'));
            return readDiagnosis(call.args, sample);
        },
    };
}

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

function createEditAccess(resolveApi, expectedChat, reportError) {
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
            try {
                await syncGraphVectorsAfterMutation(ctx, chatKey, afterStore);
            } catch (err) {
                console.error('[memory-graph/lens] vector sync after edit failed', err);
                reportError(i18nFormat('Vector recompute failed: ${0}', String(err?.message || err)));
            }
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

function createSettingsAccess(resolveApi) {
    return {
        read() {
            const view = getMemorySettingsView(getContext());
            const brief = ({ id, name }) => ({ id, name });
            view.options.embeddingProfiles = listEmbeddingProfiles().map(brief);
            view.options.rerankProfiles = listRerankProfiles().map(brief);
            view.options.connections = (getChatCompletionConnectionProfiles() || []).map(p => p.name).filter(Boolean);
            return view;
        },
        set: (key, value) => setMemorySetting(key, value),
        saveAdvanced: (values, scope, avatar) => saveMemoryAdvancedSettings(getContext(), values, scope, avatar),
        clearAdvanced: avatar => clearMemoryAdvancedOverride(getContext(), avatar),
        subscribe(onChange) {
            const { ctx } = resolveApi();
            const events = ctx?.eventSource;
            const types = ctx?.eventTypes || ctx?.event_types || {};
            const offs = [];
            for (const name of SETTINGS_EVENTS) {
                const type = types[name];
                if (!type || !events?.on) continue;
                const handler = () => onChange(name);
                events.on(type, handler);
                offs.push(() => (events.removeListener?.(type, handler) ?? events.off?.(type, handler)));
            }
            return () => {
                for (const off of offs.splice(0)) off();
            };
        },
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
// Memory structure (node-type schema) read / write
// ---------------------------------------------------------------------------

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
                avatar: String(info.avatar || ''),
                hasCharacter: Boolean(info.hasAvatar),
                characterName: info.characterName || '',
                types: structuredClone(normalizeNodeTypeSchema(info.schema)),
                defaults: structuredClone(normalizeNodeTypeSchema(getDefaultNodeTypeSchema() || null)),
                labels: sanitizeMemoryLensLabels(labelStore(ctx)),
            };
        },

        /**
         * @param {object[]} types full type list
         * @param {{ scope: 'global'|'character', labels?: object, expectedAvatar?: string }} options
         * @returns the previous stored state, for undo
         */
        async write(types, { scope, labels = null, expectedAvatar = undefined }) {
            const { ctx, api: mg } = resolveApi();
            const settings = getSettings();
            const normalized = normalizeNodeTypeSchema(types);
            const info = mg.getSchemaScopeInfo(ctx, settings);
            if (expectedAvatar !== undefined && String(info.avatar || '') !== String(expectedAvatar || '')) {
                throw new SourceError('character-changed', i18n('The active character has changed.'));
            }
            if (scope === 'character' && !info.hasAvatar) {
                throw new SourceError('no-character');
            }
            const previous = {
                scope: info.hasOverride ? 'character' : 'global',
                avatar: String(info.avatar || ''),
                expectedAvatar: expectedAvatar !== undefined ? String(expectedAvatar || '') : String(info.avatar || ''),
                globalTypes: structuredClone(settings.nodeTypeSchema ?? null),
                characterTypes: info.hasOverride ? structuredClone(info.schema) : null,
                labels: sanitizeMemoryLensLabels(labelStore(ctx)),
            };
            if (scope === 'character') {
                const ok = await mg.persistCharacterSchemaOverride(ctx, info.avatar, normalized);
                if (!ok) throw new SourceError('write-failed');
            } else {
                settings.nodeTypeSchema = normalized;
                if (info.hasOverride) {
                    await mg.removeCharacterSchemaOverride(ctx, info.avatar);
                }
            }
            if (labels) {
                const cleanLabels = sanitizeMemoryLensLabels(labels);
                const store = labelStore(ctx);
                for (const key of Object.keys(store)) delete store[key];
                Object.assign(store, cleanLabels);
            }
            invalidateLatestRecallSnapshot();
            await ctx.saveSettings();
            return previous;
        },

        /** Restores a snapshot returned by write(). */
        async restore(previous) {
            const { ctx, api: mg } = resolveApi();
            const settings = getSettings();
            const info = mg.getSchemaScopeInfo(ctx, settings);
            const expectedAvatar = previous?.expectedAvatar !== undefined ? previous.expectedAvatar : previous?.avatar;
            if (expectedAvatar !== undefined && String(info.avatar || '') !== String(expectedAvatar || '')) {
                throw new SourceError('character-changed', i18n('The active character has changed.'));
            }
            settings.nodeTypeSchema = previous.globalTypes ?? settings.nodeTypeSchema;
            if (previous.characterTypes && info.hasAvatar) {
                await mg.persistCharacterSchemaOverride(ctx, info.avatar, previous.characterTypes);
            } else if (!previous.characterTypes && info.hasOverride) {
                await mg.removeCharacterSchemaOverride(ctx, info.avatar);
            }
            const store = labelStore(ctx);
            for (const key of Object.keys(store)) delete store[key];
            Object.assign(store, sanitizeMemoryLensLabels(previous.labels || {}));
            invalidateLatestRecallSnapshot();
            await ctx.saveSettings();
        },

        async clearCharacter() {
            const { ctx, api: mg } = resolveApi();
            const info = mg.getSchemaScopeInfo(ctx, getSettings());
            if (!info.hasAvatar) return false;
            const removed = Boolean(await mg.removeCharacterSchemaOverride(ctx, info.avatar));
            if (removed) invalidateLatestRecallSnapshot();
            return removed;
        },

        labels() {
            const { ctx } = resolveApi();
            return sanitizeMemoryLensLabels(labelStore(ctx));
        },

        async exportFile(types, labels = {}) {
            const { ctx, api: mg } = resolveApi();
            const info = mg.getSchemaScopeInfo(ctx, getSettings());
            const payload = buildSchemaExportPayload(types, info, normalizeNodeTypeSchema);
            const cleanLabels = sanitizeMemoryLensLabels(labels);
            if (Object.keys(cleanLabels).length) payload.memoryLensLabels = cleanLabels;
            const fileName = getSchemaExportFileName(info);
            ctx.download(JSON.stringify(payload, null, 2), fileName, 'application/json');
            return fileName;
        },

        async importFile() {
            const { ctx } = resolveApi();
            const file = await pickFile('.json,application/json');
            if (!file) return null;
            const text = await ctx.getFileText(file);
            let parsed;
            try { parsed = JSON.parse(text); } catch { throw new SourceError('bad-file', i18n('The file is not valid JSON')); }
            let types;
            try { types = parseSchemaImportPayload(parsed, normalizeNodeTypeSchema); } catch { throw new SourceError('bad-file', i18n('This is not a memory structure file')); }
            const labels = sanitizeMemoryLensLabels(parsed?.memoryLensLabels);
            return { types: structuredClone(types), labels };
        },
    };
}

/** Opens the system file picker; resolves the chosen file or null. */
function pickFile(accept) {
    return new Promise((resolve) => {
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
