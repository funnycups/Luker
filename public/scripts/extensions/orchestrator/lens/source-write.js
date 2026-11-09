// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Luker-side writes and model access for the editing / AI features.
//
// Saving agent fields: re-read the stored profile for the same target
// (mode + scope + preset id), put only the changed fields on top (so the
// rest, including edits made in the native editor meanwhile, survives) and
// write it the way the orchestrator's own editor does. Afterwards the native
// editor's cached drafts are reloaded (editor-state.js initializeUiState),
// otherwise its next save would overwrite ours.
//
// AI calls go through `iteration-library/runner.js` requestToolCallsWithRetry
// (the helper the orchestrator's own AI iteration studio uses), so the user's
// connection profile and generation preset (including any jailbreak) wrap our
// prompt untouched. The default model is the orchestrator's iteration AI
// presets; the lens can pick its own.

import { i18n } from './i18n.js';
import { requestToolCallsWithRetry } from '../../../iteration-library/runner.js';
import { getChatCompletionConnectionProfiles } from '../../connection-manager/profile-resolver.js';
import { DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT, DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE } from '../defaults.js';
import { initializeUiState } from '../editor-state.js';
import { getPreset } from '../preset-library.js';
import { mergeChanges } from './model/edit.js';

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
    if (scope === 'factory' || !presetId) throw new WriteError('no-preset', i18n('No profile has been saved yet. Save one in the native panel first, then come back to edit.'));
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
        library[presetId] = { ...profile, name: library[presetId].name };
        await ctx.saveSettings();
        return;
    }
    // Character card: write the whole orchestrator block back through the
    // orchestrator's own persist helper (scoped to its extension key).
    const index = (ctx.characters || []).findIndex(c => String(c?.avatar || '') === String(target.avatar || ''));
    const ext = clone(index >= 0 ? ctx.characters[index]?.data?.extensions?.orchestrator : null);
    const library = ext?.presetLibraries?.[mode];
    if (!library?.[presetId]) throw new WriteError('target-gone', i18n('The profile on the character card was deleted'));
    library[presetId] = { ...profile, name: library[presetId].name };
    const ok = await ctx.getExtensionApi('orchestrator').persistOrchestratorCharacterExtension(ctx, index, ext);
    if (!ok) throw new WriteError('write', i18n('Failed to write to the character card'));
}

/** Makes the native editor drop its cached drafts and redraw. */
function refreshNativeEditor(ctx, settings) {
    initializeUiState(ctx);
    $('#luker_orch_single_agent_system_prompt').val(String(settings.singleAgentSystemPrompt || ''));
    $('#luker_orch_single_agent_user_prompt').val(String(settings.singleAgentUserPromptTemplate || ''));
    // Its change handler re-renders the agent panels (same mode → no switch).
    const select = $('#luker_orch_execution_mode');
    const mode = MODES.includes(String(settings.executionMode)) ? String(settings.executionMode) : 'spec';
    if (select.length) select.val(mode).trigger('change');
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
            await writeTarget(ctx, settings, target, profile);
            refreshNativeEditor(ctx, settings);
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
