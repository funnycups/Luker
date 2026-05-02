/**
 * Agent / preset / connection-profile resolution for the orchestrator.
 *
 * The orchestrator decides at runtime which connection profile (Chat
 * Completion API config) and which prompt preset to use for each
 * planner / worker / review node. This module owns the pure helpers for
 * that resolution layer:
 *
 *   - Connection-profile listing + sanitization (`getConnectionProfiles`,
 *     `sanitizeConnectionProfileName`, `sanitizeConnectionProfilesForAiPrompt`)
 *   - OpenAI preset listing (`getOpenAIPresetNames`, `sanitizeOpenAIPresetNamesForAiPrompt`)
 *   - Per-preset name extractors (`getPresetApiPresetName`,
 *     `getPresetPromptPresetName`, plus the matching string sanitizers)
 *   - Resolution entry points (`resolveOrchestrationAgentProfileResolution`,
 *     `resolveOrchestrationAgentPromptPresetName`) that fall back to
 *     `settings.llmNodeApiPresetName` / `settings.llmNodePresetName` when
 *     the per-preset values are empty
 *   - AI-build routing prompt builders (`buildAgentApiRoutingPromptData`,
 *     `buildAgentPromptPresetRoutingPromptData`) that surface the available
 *     profiles + global defaults to the AI builder so it can pick a route
 *   - `<select>` option renderers (`renderConnectionProfileOptions`,
 *     `renderOpenAIPresetOptions`) and the `refreshOpenAIPresetSelectors`
 *     DOM helper used by the editor popup to repopulate selects when
 *     settings change
 *
 * The async `buildPresetAwareMessages` lives here too — it is the single
 * call site that constructs the chat-completion message list under a
 * specific preset envelope, optionally resolving runtime world-info on
 * the fly. It is separate from the per-call resolution helpers because
 * it requires `context.buildPresetAwarePromptMessages` and the
 * world-info stack from `world-info.js`.
 *
 * `escapeHtml` is duplicated as a private helper to keep this module
 * portable. main.js owns the canonical copy; both will collapse into a
 * shared `html-utils.js` helper if/when more modules want it.
 */

import { extension_settings } from '../../extensions.js';
import {
    getChatCompletionConnectionProfiles,
    resolveChatCompletionRequestProfile,
} from '../connection-manager/profile-resolver.js';
import { throwIfAborted } from './abort-utils.js';
import { i18n } from './i18n.js';
import {
    hasEffectiveRuntimeWorldInfo,
    normalizeRuntimeWorldInfo,
    normalizeWorldInfoResolverMessages,
    rewriteDepthWorldInfoToAfter,
} from './world-info.js';

const MODULE_NAME = 'orchestrator';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

export function getOpenAIPresetNames(context) {
    const manager = context?.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

export function renderOpenAIPresetOptions(context, selectedName = '', emptyLabel = i18n('(Current preset)')) {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = [`<option value="">${escapeHtml(String(emptyLabel || i18n('(Current preset)')))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

export function getConnectionProfiles() {
    return getChatCompletionConnectionProfiles();
}

export function sanitizeConnectionProfileName(value = '') {
    return String(value || '').trim();
}

export function getPresetApiPresetName(preset = null) {
    return sanitizeConnectionProfileName(
        preset?.apiPresetName
        ?? preset?.apiPreset
        ?? preset?.agentApiPresetName
        ?? '',
    );
}

export function sanitizePromptPresetName(value = '') {
    return String(value || '').trim();
}

export function getPresetPromptPresetName(preset = null) {
    return sanitizePromptPresetName(
        preset?.promptPresetName
        ?? preset?.llmPresetName
        ?? preset?.chatCompletionPresetName
        ?? preset?.openAIPresetName
        ?? preset?.agentPromptPresetName
        ?? '',
    );
}

export function sanitizeConnectionProfilesForAiPrompt(profiles = getConnectionProfiles()) {
    return (Array.isArray(profiles) ? profiles : [])
        .map((profile) => {
            const name = sanitizeConnectionProfileName(profile?.name);
            if (!name) {
                return null;
            }
            return {
                name,
                api: String(profile?.api || '').trim(),
                model: String(profile?.model || '').trim(),
            };
        })
        .filter(Boolean);
}

export function sanitizeOpenAIPresetNamesForAiPrompt(context) {
    return getOpenAIPresetNames(context);
}

export function buildAgentApiRoutingPromptData(settings = extension_settings[MODULE_NAME]) {
    return {
        global_orchestration_api_preset: sanitizeConnectionProfileName(settings?.llmNodeApiPresetName || ''),
        empty_value_behavior: 'Empty apiPresetName falls back to the global orchestration API preset. If that is also empty, runtime uses the current chat API configuration.',
        default_policy: 'Do not set planner/agent apiPresetName unless the user explicitly asks for a specific provider/model route for that planner or agent.',
        available_connection_profiles: sanitizeConnectionProfilesForAiPrompt(getConnectionProfiles()),
    };
}

export function buildAgentPromptPresetRoutingPromptData(context, settings = extension_settings[MODULE_NAME]) {
    return {
        global_orchestration_prompt_preset: sanitizePromptPresetName(settings?.llmNodePresetName || ''),
        empty_value_behavior: 'Empty promptPresetName falls back to the global orchestration chat completion preset. If that is also empty, runtime uses the current chat completion preset configuration.',
        default_policy: 'Do not set planner/agent promptPresetName unless the user explicitly asks for a specific chat completion preset route for that planner or agent.',
        available_chat_completion_presets: sanitizeOpenAIPresetNamesForAiPrompt(context),
    };
}

export function resolveOrchestrationAgentProfileResolution(context, settings, preset = null) {
    const profileName = getPresetApiPresetName(preset) || sanitizeConnectionProfileName(settings?.llmNodeApiPresetName || '');
    return resolveChatCompletionRequestProfile({
        profileName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
}

export function resolveOrchestrationAgentPromptPresetName(settings, preset = null) {
    return getPresetPromptPresetName(preset) || sanitizePromptPresetName(settings?.llmNodePresetName || '');
}

export function renderConnectionProfileOptions(selectedName = '', emptyLabel = i18n('(Current API config)')) {
    const selected = sanitizeConnectionProfileName(selectedName);
    const names = getConnectionProfiles().map(profile => profile.name);
    const options = [`<option value="">${escapeHtml(String(emptyLabel || i18n('(Current API config)')))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

export function refreshOpenAIPresetSelectors(root, context, settings) {
    const selectorValues = [
        ['#luker_orch_llm_api_preset', settings.llmNodeApiPresetName],
        ['#luker_orch_llm_preset', settings.llmNodePresetName],
        ['#luker_orch_ai_suggest_api_preset', settings.aiSuggestApiPresetName],
        ['#luker_orch_ai_suggest_preset', settings.aiSuggestPresetName],
    ];

    for (const [selector, value] of selectorValues) {
        const select = root.find(selector);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = selector.endsWith('_api_preset');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

export async function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
    historyMessages = null,
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    abortSignal = null,
} = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Return concise guidance through function-call fields.';
    const userText = String(userPrompt || '').trim() || 'Use function-call fields only. Do not put JSON strings into summary.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    let resolvedRuntimeWorldInfo = includeWorldInfoWithPreset
        ? ((!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo))
            ? normalizeRuntimeWorldInfo(runtimeWorldInfo)
            : null)
        : {};
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (includeWorldInfoWithPreset && !resolvedRuntimeWorldInfo && typeof context?.resolveWorldInfoForMessages === 'function' && resolverMessages.length > 0) {
        resolvedRuntimeWorldInfo = await context.resolveWorldInfoForMessages(resolverMessages, {
            type: String(worldInfoType || 'quiet'),
            fallbackToCurrentChat: false,
            postActivationHook: rewriteDepthWorldInfoToAfter,
        });
        throwIfAborted(abortSignal, 'Orchestration aborted.');
    }

    throwIfAborted(abortSignal, 'Orchestration aborted.');
    const normalizedHistoryMessages = Array.isArray(historyMessages)
        ? historyMessages.map(message => ({ ...message }))
        : [];
    return context.buildPresetAwarePromptMessages({
        messages: [
            ...normalizedHistoryMessages,
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        envelopeOptions: {
            includeCharacterCard: true,
            api: envelopeApi,
            promptPresetName: selectedPromptPresetName,
        },
        promptPresetName: selectedPromptPresetName,
        runtimeWorldInfo: resolvedRuntimeWorldInfo,
    });
}
