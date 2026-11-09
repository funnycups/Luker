// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Luker-side writes and model access for the editing / AI features.
//
// Saving agent fields: re-read the stored profile for the same target
// (mode + scope + preset id), put only the changed fields on top (so the
// rest, including edits made in the native editor meanwhile, survives) and
// write it the way the orchestrator's own editor does. Afterwards the
// editor's cached drafts are reloaded (editor-state.js initializeUiState),
// otherwise a later save would overwrite ours.
//
// AI calls go through `iteration-library/runner.js` requestToolCallsWithRetry
// (the helper the orchestrator's own AI iteration studio uses), so the user's
// connection profile and generation preset (including any jailbreak) wrap our
// prompt untouched. The default model is the orchestrator's iteration AI
// presets; the lens can pick its own.

import { i18n, i18nFormat } from './i18n.js';
import { requestToolCallsWithRetry } from '../../../iteration-library/runner.js';
import { getChatCompletionConnectionProfiles } from '../../connection-manager/profile-resolver.js';
import { DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT, DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE } from '../defaults.js';
import {
    initializeUiState,
    loadGlobalAgendaEditorState,
    loadGlobalDirectorEditorState,
    loadGlobalEditorState,
    loadGlobalLoopEditorState,
} from '../editor-state.js';
import {
    createPreset,
    deletePreset,
    duplicatePreset,
    getActivePreset,
    getActivePresetId,
    getPreset,
    listPresets,
    renamePreset,
    sanitizePresetEntry,
    setActivePresetId,
    writeActivePreset,
} from '../preset-library.js';
import {
    applyCharacterExecutionModeForAvatar,
    clearCharacterExtensionForMode,
    getCharacterActivePresetId,
    getCharacterExtensionDataByAvatar,
    getCharacterIndexByAvatar,
    getCharacterPresetLibrary,
} from '../character-overrides.js';
import {
    persistCharacterAgendaEditor,
    persistCharacterDirectorEditor,
    persistCharacterEditor,
    persistCharacterLoopEditor,
    persistCustomToolsPatch,
    persistOrchestratorCharacterExtension,
    persistRuntimeLimitsPatch,
} from '../editor-persist.js';
import {
    copyOrchPresetSkills,
    emitOrchPresetDeleted,
    emitOrchPresetExportReady,
    emitOrchPresetImportReady,
    renameOrchPresetSkills,
} from '../preset-lifecycle-hooks.js';
import {
    buildPortablePayloadForMode,
    copyAgendaAgentsIntoSpecEditor,
    copySpecPresetsIntoAgendaEditor,
    extractImportedProfileForMode,
    parseImportedProfilePayload,
} from '../preset-io.js';
import { sanitizeAgentToolFlags } from '../persistence.js';
import { sanitizeConnectionProfileName } from '../agent-resolution.js';
import { normalizeCapsuleInjectPosition } from '../capsule-injection.js';
import { sanitizeIdentifierToken } from '../editable-spec.js';
import { buildDirectorDefaultSystemPrompt } from '../director-default-prompt.js';
import { promptEmbedUnembeddedPresetsForCharacterApply } from '../prompt-embed-unembedded.js';
import { mergeChanges, validateStructure } from './model/edit.js';

const LENS_KEY = 'orchestra_lens';
const SESSIONS_KEY = 'orchestraLens.ai.v1';
const MODES = ['spec', 'single', 'agenda', 'loop', 'director'];

export class WriteError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/** The stored profile for a target, in the same shape the lens reads. */
function readTarget(ctx, settings, target) {
    const { mode, scope, presetId } = target;
    if (mode === 'single') {
        return {
            spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] },
            presets: {
                single_agent: {
                    systemPrompt: String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT),
                    userPromptTemplate: String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE),
                },
            },
        };
    }
    if (scope === 'chat') {
        const agenda = settings.chatOverrides?.[target.chatKey]?.agenda;
        if (!agenda?.enabled) throw new WriteError('target-gone', i18n('The dispatch profile dedicated to this chat has been turned off'));
        return clone(agenda);
    }
    if (scope === 'factory' || !presetId) throw new WriteError('no-preset', i18n('The profile to edit was deleted'));
    const entry = getPreset(settings, mode, scope, presetId, { context: ctx, avatar: target.avatar });
    if (!entry) throw new WriteError('target-gone', i18n('The profile to edit was deleted or renamed'));
    return clone(entry);
}

async function writeTarget(ctx, settings, target, profile) {
    const { mode, scope, presetId } = target;
    if (mode === 'single') {
        const single = profile?.presets?.single_agent || {};
        settings.singleAgentSystemPrompt = String(single.systemPrompt || '');
        settings.singleAgentUserPromptTemplate = String(single.userPromptTemplate || '');
        await ctx.saveSettings();
        return;
    }
    if (scope === 'chat') {
        settings.chatOverrides[target.chatKey].agenda = { ...profile, enabled: true };
        await ctx.saveSettings();
        return;
    }
    if (scope === 'global') {
        const library = settings.presetLibraries?.[mode];
        if (!library?.[presetId]) throw new WriteError('target-gone', i18n('The profile to edit was deleted'));
        library[presetId] = sanitizePresetEntry(mode, { ...profile, name: library[presetId].name });
        await ctx.saveSettings();
        return;
    }
    // Character card: write the whole orchestrator block back through the
    // orchestrator's own persist helper (scoped to its extension key).
    const index = (ctx.characters || []).findIndex(c => String(c?.avatar || '') === String(target.avatar || ''));
    const ext = clone(index >= 0 ? ctx.characters[index]?.data?.extensions?.orchestrator : null);
    const library = ext?.presetLibraries?.[mode];
    if (!library?.[presetId]) throw new WriteError('target-gone', i18n('The profile on the character card was deleted'));
    library[presetId] = sanitizePresetEntry(mode, { ...profile, name: library[presetId].name });
    const ok = await ctx.getExtensionApi('orchestrator').persistOrchestratorCharacterExtension(ctx, index, ext);
    if (!ok) throw new WriteError('write', i18n('Failed to write to the character card'));
}

/** Makes the shared editor state drop its cached drafts. */
function refreshEditors(ctx) {
    initializeUiState(ctx);
    ctx.getExtensionApi('orchestrator')?.refreshLegacyPanel?.();
}

/**
 * @param {() => { ctx: object, settings: object }} host
 */
export function createProfileAccess(host) {
    return {
        /**
         * @param {object} target  snapshot.target { mode, scope, presetId, avatar, chatKey }
         * @param {object[]} changes  [{agentId, field, before, after}]
         * @param {{ force?: boolean }} opts  write even if some fields changed elsewhere
         * @returns {Promise<{ saved: boolean, conflicts: object[], missing: object[] }>}
         */
        async save(target, changes, { force = false } = {}) {
            const { ctx, settings } = host();
            const fresh = readTarget(ctx, settings, target);
            const { profile, conflicts, missing } = mergeChanges(target.mode, fresh, changes);
            if (conflicts.length && !force) return { saved: false, conflicts, missing };
            const problems = validateStructure(target.mode, profile);
            if (problems.length) throw new WriteError('invalid', problems.join('\n'));
            await writeTarget(ctx, settings, target, profile);
            refreshEditors(ctx);
            return { saved: true, conflicts, missing };
        },

        /** Connection profiles and generation presets to pick from. */
        async options() {
            const { ctx } = host();
            const connections = (getChatCompletionConnectionProfiles() || []).map(p => String(p?.name || '')).filter(Boolean);
            const names = ctx.getPresetManager('openai')?.getAllPresets();
            const presets = Array.isArray(names) ? [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))] : [];
            return { connections, presets };
        },

        /** Every tool flag on or off. Director keeps `finalize` off in its defaults. */
        allTools(mode, enabled) {
            const flags = sanitizeAgentToolFlags({}, { defaultAllOn: enabled, forceFinalize: false });
            if (mode === 'director') flags.finalize = false;
            return flags;
        },
        baseTools: () => sanitizeAgentToolFlags({}),
        defaultMainPrompt: (subAgents) => buildDirectorDefaultSystemPrompt({ subAgents }),

        /** The other mode's active preset converted for a spec <-> agenda copy, or null. */
        convertFrom(target, profile) {
            const { ctx, settings } = host();
            const scope = target.scope === 'character' ? 'character' : 'global';
            const from = target.mode === 'agenda' ? 'spec' : 'agenda';
            const source = getActivePreset(settings, from, { scope, context: ctx, avatar: target.avatar }).state;
            if (!source) return null;
            const next = clone(profile);
            if (target.mode === 'agenda') {
                copySpecPresetsIntoAgendaEditor(clone(source), next);
            } else {
                copyAgendaAgentsIntoSpecEditor(clone(source), next);
            }
            return next;
        },
    };
}

const scopeOf = (target) => (target?.scope === 'character' ? 'character' : 'global');

function persistScope(ctx, scope, avatar) {
    if (scope !== 'character') return ctx.saveSettings();
    const index = getCharacterIndexByAvatar(ctx, avatar);
    if (index < 0) return false;
    return persistOrchestratorCharacterExtension(ctx, index, { ...(getCharacterExtensionDataByAvatar(ctx, avatar) || {}) });
}

function downloadJson(fileName, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Preset library actions, mirroring the orchestrator's own selector bar. */
export function createPresetAccess(host) {
    const refreshed = (ctx) => refreshEditors(ctx);
    const opts = (ctx, avatar) => ({ context: ctx, avatar });
    const nameOf = (ctx, settings, mode, scope, avatar, id) => {
        const library = scope === 'character' ? getCharacterPresetLibrary(ctx, avatar, mode) : (settings.presetLibraries?.[mode] || {});
        return String(library?.[id]?.name || '').trim();
    };
    return {
        list(target) {
            const { ctx, settings } = host();
            const { mode, avatar } = target;
            const library = avatar ? getCharacterPresetLibrary(ctx, avatar, mode) || {} : {};
            return {
                global: listPresets(settings, mode, { scope: 'global', context: ctx }),
                character: Object.keys(library).map(id => ({ id, name: String(library[id]?.name || '') })),
            };
        },

        /** Picking a global preset also clears the card's own active slot. */
        async select(target, scope, presetId) {
            const { ctx, settings } = host();
            const { mode, avatar } = target;
            const hadCardSlot = Boolean(avatar) && Boolean(getCharacterActivePresetId(ctx, avatar, mode));
            if (scope === 'global' && hadCardSlot) setActivePresetId(settings, mode, 'character', '', opts(ctx, avatar));
            if (!setActivePresetId(settings, mode, scope, presetId, opts(ctx, avatar))) throw new WriteError('target-gone', i18n('Preset no longer exists — refreshing the list.'));
            if (hadCardSlot || (scope === 'character' && avatar)) {
                const index = getCharacterIndexByAvatar(ctx, avatar);
                const ext = getCharacterExtensionDataByAvatar(ctx, avatar);
                if (index >= 0 && ext && Object.keys(ext).length) await persistOrchestratorCharacterExtension(ctx, index, { ...ext });
            }
            if (scope === 'global') await ctx.saveSettings();
            refreshed(ctx);
        },

        async create(target, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const id = createPreset(settings, target.mode, scope, { name }, opts(ctx, target.avatar));
            setActivePresetId(settings, target.mode, scope, id, opts(ctx, target.avatar));
            await persistScope(ctx, scope, target.avatar);
            refreshed(ctx);
        },

        async duplicate(target, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const oldName = nameOf(ctx, settings, target.mode, scope, target.avatar, target.presetId);
            const id = duplicatePreset(settings, target.mode, scope, target.presetId, { name }, opts(ctx, target.avatar));
            setActivePresetId(settings, target.mode, scope, id, opts(ctx, target.avatar));
            await copyOrchPresetSkills(ctx, { mode: target.mode, oldName, newName: name });
            await persistScope(ctx, scope, target.avatar);
            refreshed(ctx);
        },

        async rename(target, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const oldName = nameOf(ctx, settings, target.mode, scope, target.avatar, target.presetId);
            renamePreset(settings, target.mode, scope, target.presetId, { name }, opts(ctx, target.avatar));
            await renameOrchPresetSkills(ctx, { mode: target.mode, oldName, newName: name });
            await persistScope(ctx, scope, target.avatar);
            refreshed(ctx);
        },

        async remove(target) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const name = nameOf(ctx, settings, target.mode, scope, target.avatar, target.presetId);
            deletePreset(settings, target.mode, scope, target.presetId, opts(ctx, target.avatar));
            await emitOrchPresetDeleted(ctx, { mode: target.mode, name });
            await persistScope(ctx, scope, target.avatar);
            refreshed(ctx);
        },

        async exportActive(target) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const active = getActivePreset(settings, target.mode, { scope, ...opts(ctx, target.avatar) }).state;
            if (!active) throw new WriteError('no-preset', i18n('No active preset to export.'));
            const payload = buildPortablePayloadForMode(target.mode, active);
            await emitOrchPresetExportReady(ctx, payload);
            downloadJson(`luker-orchestrator-${target.mode}-${scope}-${sanitizeIdentifierToken(active.name || 'preset', 'preset')}.json`, payload);
        },

        /** Reads a preset file; the caller asks for the name, then calls `importParsed`. */
        parseImport(target, fileText) {
            const imported = parseImportedProfilePayload(fileText);
            if (imported.mode !== target.mode) throw new WriteError('mode', i18n('Imported file does not match the current mode.'));
            return { imported, fileText, defaultName: String(extractImportedProfileForMode(imported)?.name || '').trim() };
        },

        async importParsed(target, { imported, fileText }, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const { mode, avatar } = target;
            const id = createPreset(settings, mode, scope, { name }, opts(ctx, avatar));
            if (!id) throw new WriteError('write', i18n('No active preset to export.'));
            setActivePresetId(settings, mode, scope, id, opts(ctx, avatar));
            const profile = extractImportedProfileForMode(imported);
            const result = writeActivePreset(settings, mode, scope, profile, opts(ctx, avatar));
            if (!result.ok) throw new WriteError('write', result.hint || result.reason);
            await persistScope(ctx, scope, avatar);
            const data = { ...profile };
            const envelope = JSON.parse(fileText);
            if (envelope?.extensions) data.extensions = envelope.extensions;
            await emitOrchPresetImportReady(ctx, { data, mode, name });
            refreshed(ctx);
        },

        /** Copies the profile on screen over the global active preset. */
        async saveToGlobal(target) {
            const { ctx, settings } = host();
            const current = getPreset(settings, target.mode, scopeOf(target), target.presetId, opts(ctx, target.avatar));
            if (!current) throw new WriteError('target-gone', i18n('The profile to edit was deleted'));
            const { name: _name, ...body } = current;
            getActivePreset(settings, target.mode, { scope: 'global', context: ctx });
            const result = writeActivePreset(settings, target.mode, 'global', body, { context: ctx });
            if (!result.ok) throw new WriteError('write', result.hint || result.reason);
            await ctx.saveSettings();
            refreshed(ctx);
        },

        /** Copies the global active preset onto the current character card. */
        async saveToCharacter(target) {
            const { ctx, settings } = host();
            const { mode, avatar } = target;
            if (!avatar) throw new WriteError('no-character', i18n('No character selected.'));
            const load = { loop: loadGlobalLoopEditorState, agenda: loadGlobalAgendaEditorState, director: loadGlobalDirectorEditorState, spec: loadGlobalEditorState }[mode];
            const persist = { loop: persistCharacterLoopEditor, agenda: persistCharacterAgendaEditor, director: persistCharacterDirectorEditor, spec: persistCharacterEditor }[mode];
            const editor = load();
            const preflight = await promptEmbedUnembeddedPresetsForCharacterApply({
                context: ctx,
                activeCharacter: ctx.characters?.find(c => c?.avatar === avatar) || null,
                profile: { ...editor, mode },
                i18n,
                i18nFormat,
                notifyError: (text) => toastr.error(String(text)),
                escapeHtml: (text) => $('<div>').text(String(text ?? '')).html(),
            });
            if (!preflight.proceed) return false;
            if (!await persist(ctx, settings, avatar, { editor })) throw new WriteError('write', i18n('Failed to persist character override.'));
            refreshed(ctx);
            return true;
        },

        async clearCharacter(target) {
            const { ctx, settings } = host();
            const index = getCharacterIndexByAvatar(ctx, target.avatar);
            if (index < 0) throw new WriteError('no-character', i18n('No character selected.'));
            const next = clearCharacterExtensionForMode(getCharacterExtensionDataByAvatar(ctx, target.avatar), target.mode);
            if (!await persistOrchestratorCharacterExtension(ctx, index, next)) throw new WriteError('write', i18n('Failed to persist character override.'));
            applyCharacterExecutionModeForAvatar(ctx, settings, target.avatar);
            refreshed(ctx);
        },

        /** Pins the mode this card runs in ('' removes the pin). */
        async pinMode(target, mode) {
            const { ctx, settings } = host();
            const index = getCharacterIndexByAvatar(ctx, target.avatar);
            if (index < 0) throw new WriteError('no-character', i18n('No character selected.'));
            const ext = clone(getCharacterExtensionDataByAvatar(ctx, target.avatar) || {});
            ext.override = { ...(ext.override || {}) };
            if (mode) ext.override.mode = mode; else delete ext.override.mode;
            if (!await persistOrchestratorCharacterExtension(ctx, index, ext)) throw new WriteError('write', i18n('Failed to persist character override.'));
            if (mode) applyCharacterExecutionModeForAvatar(ctx, settings, target.avatar);
            refreshed(ctx);
        },

        async resetSingle() {
            const { ctx, settings } = host();
            settings.singleAgentSystemPrompt = DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT;
            settings.singleAgentUserPromptTemplate = DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE;
            await ctx.saveSettings();
            refreshed(ctx);
        },

        async saveCustomTools(target, tools) {
            const { ctx, settings } = host();
            await persistCustomToolsPatch(ctx, settings, target.mode, scopeOf(target), tools, { avatar: target.avatar });
            refreshed(ctx);
        },
    };
}

const intAtLeast = (min, fallback) => (value) => Math.max(min, Math.floor(Number(value) || fallback));
const text = (value) => String(value || '');
const ROLES = [0, 1, 2]; // extension_prompt_roles: system, user, assistant
const SETTING_RULES = {
    llmNodeApiPresetName: sanitizeConnectionProfileName,
    llmNodePresetName: value => text(value).trim(),
    includeWorldInfoWithPreset: Boolean,
    nodeIterationMaxRounds: intAtLeast(1, 40),
    reviewRerunMaxRounds: intAtLeast(0, 0),
    maxRecentMessages: intAtLeast(1, 14),
    toolCallRetryMax: intAtLeast(0, 0),
    rpmLimit: intAtLeast(0, 0),
    capsuleInjectPosition: normalizeCapsuleInjectPosition,
    capsuleInjectDepth: intAtLeast(0, 0),
    capsuleInjectRole: value => (ROLES.includes(Number(value)) ? Number(value) : 0),
    capsuleCustomInstruction: value => text(value).trim(),
    requestApiPresetName: sanitizeConnectionProfileName,
    requestLlmPresetName: value => text(value).trim(),
    requestSystemPrompt: text,
    iterModePromptSpec: text,
    iterModePromptLoop: text,
    iterModePromptDirector: text,
    iterModePromptAgenda: text,
};
const CAPSULE_KEYS = ['capsuleInjectPosition', 'capsuleInjectDepth', 'capsuleInjectRole', 'capsuleCustomInstruction'];

/** Settings shared by every profile, plus the limits stored per preset. */
export function createSettingsAccess(host) {
    const api = (ctx) => ctx.getExtensionApi('orchestrator');
    return {
        values() {
            const { settings } = host();
            return Object.fromEntries(Object.keys(SETTING_RULES).map(key => [key, settings[key]]));
        },
        set(key, value) {
            const { ctx, settings } = host();
            if (!SETTING_RULES[key]) return;
            settings[key] = SETTING_RULES[key](value);
            if (CAPSULE_KEYS.includes(key)) api(ctx)?.reapplyCapsule?.();
            ctx.saveSettingsDebounced();
            api(ctx)?.refreshLegacyPanel?.();
        },
        promptDefaults() {
            const { ctx } = host();
            return api(ctx)?.getIterationPromptDefaults?.() || {};
        },
        /** Limits live inside the active preset of agenda / loop / director. */
        async setLimit(target, patch) {
            const { ctx, settings } = host();
            await persistRuntimeLimitsPatch(ctx, settings, target.mode, scopeOf(target), patch, { avatar: target.avatar });
            refreshEditors(ctx);
        },
    };
}

export function createAiAccess(host) {
    const lensSettings = (ctx) => {
        const all = ctx.extensionSettings;
        all[LENS_KEY] ||= {};
        all[LENS_KEY].ai ||= { api: '', preset: '' };
        return all[LENS_KEY].ai;
    };
    const readSessions = () => {
        try { return JSON.parse(globalThis.localStorage?.getItem(SESSIONS_KEY) || '{}') || {}; } catch { return {}; }
    };

    return {
        /** { api, preset } chosen for the lens ('' follows the orchestrator's iteration AI) plus what that resolves to. */
        settings() {
            const { ctx, settings } = host();
            const own = lensSettings(ctx);
            return { api: String(own.api || ''), preset: String(own.preset || ''), orchApi: String(settings.requestApiPresetName || ''), orchPreset: String(settings.requestLlmPresetName || '') };
        },

        saveSettings({ api = '', preset = '' } = {}) {
            const { ctx } = host();
            Object.assign(lensSettings(ctx), { api: String(api), preset: String(preset) });
            ctx.saveSettingsDebounced();
        },

        /** One model call → { assistantText, reasoning, toolCalls: [{id,name,args}] }. */
        async request({ messages, tools, signal = null }) {
            const { ctx, settings } = host();
            const own = lensSettings(ctx);
            const result = await requestToolCallsWithRetry(ctx, { toolCallRetryMax: settings.toolCallRetryMax, rpmLimit: settings.rpmLimit }, {
                taskMessages: messages,
                runtimeWorldInfo: null,
                apiPresetName: String(own.api || settings.requestApiPresetName || '').trim(),
                llmPresetName: String(own.preset || settings.requestLlmPresetName || '').trim(),
                tools,
                abortSignal: signal,
                includeAssistantText: true,
                allowNoToolCalls: true,
            });
            return {
                assistantText: String(result?.assistantText || ''),
                reasoning: String(result?.reasoning || ''),
                toolCalls: (Array.isArray(result?.toolCalls) ? result.toolCalls : []).map(call => ({
                    id: String(call?.id || ''),
                    name: String(call?.name || ''),
                    args: call?.args && typeof call.args === 'object' ? call.args : {},
                })),
            };
        },

        listSessions(scopeKey) {
            return clone(readSessions()[scopeKey] || []);
        },

        saveSessions(scopeKey, list) {
            const all = readSessions();
            all[scopeKey] = list;
            try {
                globalThis.localStorage?.setItem(SESSIONS_KEY, JSON.stringify(all));
            } catch {
                all[scopeKey] = list.slice(0, 3);
                try { globalThis.localStorage?.setItem(SESSIONS_KEY, JSON.stringify(all)); } catch { /* give up quietly */ }
            }
        },

        /** The reply the main model wrote right after a run's floor (same chat only). */
        replyFor(run) {
            try {
                const { ctx } = host();
                if (!run || Number(run.floor) < 0 || String(ctx.chatId || '') !== String(run.chatId || '')) return '';
                const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
                for (let i = Number(run.floor) + 1; i < chat.length; i++) {
                    if (chat[i]?.is_user) return '';
                    if (!chat[i]?.is_system && chat[i]?.mes) return String(chat[i].mes);
                }
            } catch { /* host gone */ }
            return '';
        },
    };
}
