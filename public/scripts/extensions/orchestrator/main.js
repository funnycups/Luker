// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
// Implementation source: Toolify: Empower any LLM with function calling capabilities. (https://github.com/funnycups/Toolify)

import { extension_prompt_roles, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext, getCharacterState, setCharacterState } from '../../extensions.js';
import { world_info_position } from '../../world-info.js';
import { renderObjectDiffHtml } from '../object-diff-view.js';
import { DiffMatchPatch } from '../../../lib.js';
import { create as createDiffPatcher, reverse as reverseDiffDelta } from '../../vendor/diffpatch/index.js';
import {
    buildAiIterationPopupHtml,
    buildOrchestrationEditorPopupPanelHtml,
    buildOrchestratorSettingsHtml,
} from './ui-templates.js';
import {
    buildLastUserAnchor,
    compactStageOutputs,
    normalizeNodeOutputForSnapshot,
    normalizeOrchestrationSnapshot,
} from './anchors.js';
import { i18n, i18nFormat, registerLocaleData } from './i18n.js';
import { ensureStyles } from './styles.js';
import {
    CAPSULE_INJECT_POSITION_SCHEMA_VERSION,
    DEFAULT_AGENDA_PLANNER_PROMPT,
    DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
    DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT,
    DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE,
    ORCH_ALLOWED_GENERATION_TYPES,
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_SINGLE,
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_NODE_TYPE_REVIEW,
    ORCH_NODE_TYPE_WORKER,
    ORCH_REVIEW_FEEDBACK_FIELD,
    PORTABLE_PROFILE_FORMAT_V1,
    PORTABLE_PROFILE_FORMAT_V2,
    defaultAgendaAgents,
    defaultAgendaPlanner,
    defaultPresets,
    defaultSettings,
    defaultSpec,
    getCriticPromptReminderLines,
    getCriticReviewNodeContractShape,
    getDefaultAiSuggestSystemPrompt,
} from './defaults.js';
import {
    isAbortError,
    isAbortSignalLike,
    linkAbortSignals,
    throwIfAborted,
} from './abort-utils.js';
import {
    buildExecutionToolCalls,
    buildPendingToolResults,
    buildPersistentToolCallsFromRawCalls,
    buildPersistentToolHistoryMessages,
    buildRejectedToolResults,
    buildToolCallSummary,
    createPersistentToolTurnMessage,
    findAiIterationMessageById,
    makeAiIterationMessageId,
    makeRuntimeToolCallId,
    normalizePersistentToolCalls,
    normalizePersistentToolResults,
    requestToolCallsWithRetry,
    serializeToolResultContent,
} from './tool-calling.js';
import {
    normalizeTemplateForAiPrompt,
    normalizeTemplateForRuntime,
} from './template-vars.js';
import {
    toReadableYamlText,
} from './output-formatting.js';
import {
    cloneDefault,
    normalizeNodeSpec,
    normalizeNodeType,
    sanitizeSpec,
} from './spec-schema.js';
import {
    normalizeWorldInfoResolverMessages,
} from './world-info.js';
import {
    clearCapsulePrompt,
    injectCapsuleToPayload,
    migrateLegacyCapsuleInjectPosition,
    normalizeCapsuleInjectPosition,
} from './capsule-injection.js';
import {
    clearLatestOrchestrationRuntimeTrace,
    createOrchestrationRuntimeTrace,
    finalizeOrchestrationRuntimeTrace,
    getLatestOrchestrationRuntimeTrace,
    truncateOrchestrationRuntimePreview,
} from './runtime-trace.js';
import {
    formatDiffValue,
    renderIterationLineDiffHtml,
} from './line-diff.js';
import {
    renderLastOrchestrationResultHtml,
    renderOrchestrationRuntimeTraceHtml,
} from './runtime-trace-render.js';
import {
    canReuseLatestOrchestrationSnapshot,
    clearCacheForChatChange,
    getActiveSnapshot,
    getChatKey,
    getCurrentAvatar,
    getLatestOrchestrationEntry,
    getLoadedOrchestrationHistoryAnchors,
    loadOrchestratorChatState,
    persistEditedSnapshotToFloorState,
    refreshActiveSnapshotFromCache,
    refreshOrchestratorStateAfterStructuralEvent,
    setActiveSnapshot,
    storeCompletedOrchestrationSnapshot,
} from './snapshot-cache.js';
import {
    buildAgentApiRoutingPromptData,
    buildAgentPromptPresetRoutingPromptData,
    getPresetApiPresetName,
    getPresetPromptPresetName,
    refreshOpenAIPresetSelectors,
    renderConnectionProfileOptions,
    renderOpenAIPresetOptions,
    resolveOrchestrationRuntimeWorldInfo,
    sanitizeConnectionProfileName,
    sanitizePromptPresetName,
} from './agent-resolution.js';
import {
    applyCharacterExecutionModeForAvatar,
    getCharacterAgendaOverrideByAvatar,
    getCharacterCardSnapshot,
    getCharacterDisplayNameByAvatar,
    getCharacterExtensionDataByAvatar,
    getCharacterIndexByAvatar,
    getCharacterOverrideByAvatar,
    getExecutionMode,
    hasCharacterAgendaOverride,
    hasCharacterOverride,
    hasCharacterSpecOverride,
    normalizeCharacterOverrideMode,
    normalizeExecutionMode,
} from './character-overrides.js';
import {
    createAgendaPlannerDraft,
    createPresetDraft,
    mergePresetMaps,
    resolveOverridePresetMap,
    sanitizeIdentifierToken,
    sanitizePresetMap,
    serializeEditorPresetMap,
    serializeEditorSpec,
    toEditablePresetMap,
    toEditableSpec,
} from './editable-spec.js';
import {
    buildAgendaProfileForRuntime,
    cloneAgendaWorkingProfileFromEditor,
    cloneAgendaWorkingProfileFromSettings,
    ensureAgendaEditorIntegrity,
    sanitizeAgendaWorkingProfile,
} from './agenda-profile.js';
import { runAgendaOrchestration } from './agenda-runtime.js';
import { runSpecOrchestration } from './spec-runtime.js';
import {
    buildAiOrchestrationProfile,
    sanitizeProfileForAiPrompt,
} from './ai-build.js';
import {
    createNewStage,
    ensureEditorIntegrity,
    initializeUiState,
    loadCharacterAgendaEditorState,
    loadCharacterEditorState,
    loadGlobalAgendaEditorState,
    loadGlobalEditorState,
    pickDefaultPreset,
    setDisplayedScopeForMode,
    syncCharacterEditorWithActiveAvatar,
    uiState,
} from './editor-state.js';
import {
    getAgendaEditorByScope,
    getAgendaScopeFromElement,
    getCopyScopeFromElement,
    getDisplayedScope,
    getDisplayedScopeForMode,
    getDisplayedScopeLabel,
    getEditorByScope,
    getExplicitScopeFromElement,
    getIterationDefaultScope,
    getPopupEditingLabel,
    getProfileTitleForScope,
} from './editor-display.js';
import {
    createPortableAgendaProfileFromEditor,
    createPortableProfileFromEditor,
    persistCharacterAgendaEditor,
    persistCharacterEditor,
    persistGlobalAgendaEditorFrom,
    persistGlobalEditorFrom,
    persistOrchestratorCharacterExtension,
} from './editor-persist.js';

const MODULE_NAME = 'orchestrator';
const ORCH_RESULT_EVENT = 'luker.orchestrator.result';
const UI_BLOCK_ID = 'orchestrator_settings';
const ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE = 'orchestrator_iteration_history';
const ORCH_GLOBAL_ITERATION_HISTORY_KEY = 'global_iteration_history';
const ORCH_CHARACTER_ITERATION_HISTORY_VERSION = 3;
const ORCH_CHARACTER_ITERATION_HISTORY_LIMIT = 24;
const ORCH_ITERATION_DIFF_TEXT_MIN_LENGTH = 80;
let orchInFlight = false;
let activeRunInfoToast = null;
let activeAiBuildToast = null;
let activeAiIterationAbortController = null;
let activeOrchRunAbortController = null;
let activeAiBuildAbortController = null;

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = cloneDefault(value);
        }
    }
    const hadLegacySingleMode = Boolean(extension_settings[MODULE_NAME].singleAgentModeEnabled);
    extension_settings[MODULE_NAME].executionMode = normalizeExecutionMode(
        extension_settings[MODULE_NAME].executionMode || (hadLegacySingleMode ? ORCH_EXECUTION_MODE_SINGLE : ORCH_EXECUTION_MODE_SPEC),
    );
    extension_settings[MODULE_NAME].singleAgentModeEnabled = extension_settings[MODULE_NAME].executionMode === ORCH_EXECUTION_MODE_SINGLE;
    extension_settings[MODULE_NAME].singleAgentSystemPrompt = String(extension_settings[MODULE_NAME].singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT);
    extension_settings[MODULE_NAME].singleAgentUserPromptTemplate = String(extension_settings[MODULE_NAME].singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE);
    extension_settings[MODULE_NAME].agendaPlanner = createAgendaPlannerDraft(
        extension_settings[MODULE_NAME].agendaPlanner || {
            userPromptTemplate: extension_settings[MODULE_NAME].agendaPlannerPrompt,
        },
    );
    extension_settings[MODULE_NAME].agendaAgents = sanitizePresetMap(extension_settings[MODULE_NAME].agendaAgents);
    if (Object.keys(extension_settings[MODULE_NAME].agendaAgents).length === 0) {
        extension_settings[MODULE_NAME].agendaAgents = sanitizePresetMap(defaultAgendaAgents);
    }
    extension_settings[MODULE_NAME].agendaFinalAgentId = sanitizeIdentifierToken(
        extension_settings[MODULE_NAME].agendaFinalAgentId,
        Object.keys(extension_settings[MODULE_NAME].agendaAgents)[0] || 'finalizer',
    );
    if (!extension_settings[MODULE_NAME].agendaAgents[extension_settings[MODULE_NAME].agendaFinalAgentId]) {
        extension_settings[MODULE_NAME].agendaFinalAgentId = Object.keys(extension_settings[MODULE_NAME].agendaAgents)[0] || 'finalizer';
    }
    extension_settings[MODULE_NAME].agendaPlannerMaxRounds = Math.max(
        1,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].agendaPlannerMaxRounds ?? 6) || 6)),
    );
    extension_settings[MODULE_NAME].agendaMaxConcurrentAgents = Math.max(
        1,
        Math.min(12, Math.floor(Number(extension_settings[MODULE_NAME].agendaMaxConcurrentAgents ?? 3) || 3)),
    );
    extension_settings[MODULE_NAME].agendaMaxTotalRuns = Math.max(
        1,
        Math.min(200, Math.floor(Number(extension_settings[MODULE_NAME].agendaMaxTotalRuns ?? 24) || 24)),
    );
    delete extension_settings[MODULE_NAME].plainTextFunctionCallMode;
    delete extension_settings[MODULE_NAME].agendaPlannerPrompt;

    extension_settings[MODULE_NAME].orchestrationSpec = sanitizeSpec(extension_settings[MODULE_NAME].orchestrationSpec);
    extension_settings[MODULE_NAME].presets = sanitizePresetMap(extension_settings[MODULE_NAME].presets);
    extension_settings[MODULE_NAME].llmNodeApiPresetName = sanitizeConnectionProfileName(extension_settings[MODULE_NAME].llmNodeApiPresetName || '');
    if (!String(extension_settings[MODULE_NAME].llmNodePresetName || '').trim()) {
        extension_settings[MODULE_NAME].llmNodePresetName = String(extension_settings[MODULE_NAME].llmNodePromptPresetName || '').trim();
    }
    extension_settings[MODULE_NAME].includeWorldInfoWithPreset = extension_settings[MODULE_NAME].includeWorldInfoWithPreset !== false;
    extension_settings[MODULE_NAME].aiSuggestApiPresetName = sanitizeConnectionProfileName(extension_settings[MODULE_NAME].aiSuggestApiPresetName || '');
    if (!String(extension_settings[MODULE_NAME].aiSuggestPresetName || '').trim()) {
        extension_settings[MODULE_NAME].aiSuggestPresetName = String(extension_settings[MODULE_NAME].aiSuggestPromptPresetName || '').trim();
    }
    // Drop legacy API selector fields. API routing now comes from connection profile only.
    delete extension_settings[MODULE_NAME].llmNodeApi;
    delete extension_settings[MODULE_NAME].aiSuggestApi;
    delete extension_settings[MODULE_NAME].llmNodeResponseLength;
    delete extension_settings[MODULE_NAME].aiSuggestResponseLength;
    delete extension_settings[MODULE_NAME].llmNodePromptPresetName;
    delete extension_settings[MODULE_NAME].aiSuggestPromptPresetName;
    delete extension_settings[MODULE_NAME].maxCapsuleChars;
    delete extension_settings[MODULE_NAME].saveTarget;
    const hasCapsuleInjectPositionSchemaVersion = Object.prototype.hasOwnProperty.call(
        extension_settings[MODULE_NAME],
        'capsuleInjectPositionSchemaVersion',
    );
    if (!hasCapsuleInjectPositionSchemaVersion) {
        extension_settings[MODULE_NAME].capsuleInjectPosition = migrateLegacyCapsuleInjectPosition(
            extension_settings[MODULE_NAME].capsuleInjectPosition,
        );
    }
    extension_settings[MODULE_NAME].capsuleInjectPosition = normalizeCapsuleInjectPosition(
        extension_settings[MODULE_NAME].capsuleInjectPosition,
    );
    extension_settings[MODULE_NAME].capsuleInjectPositionSchemaVersion = CAPSULE_INJECT_POSITION_SCHEMA_VERSION;
    extension_settings[MODULE_NAME].capsuleInjectDepth = Math.max(
        0,
        Math.min(10000, Math.floor(Number(extension_settings[MODULE_NAME].capsuleInjectDepth) || 0)),
    );
    {
        const role = Number(extension_settings[MODULE_NAME].capsuleInjectRole);
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        extension_settings[MODULE_NAME].capsuleInjectRole = allowedRoles.includes(role)
            ? role
            : extension_prompt_roles.SYSTEM;
    }
    delete extension_settings[MODULE_NAME].capsuleRenderFormat;
    extension_settings[MODULE_NAME].capsuleCustomInstruction = String(extension_settings[MODULE_NAME].capsuleCustomInstruction || '').trim();
    extension_settings[MODULE_NAME].aiSuggestSystemPrompt = String(extension_settings[MODULE_NAME].aiSuggestSystemPrompt || '').trim() || getDefaultAiSuggestSystemPrompt();
    delete extension_settings[MODULE_NAME].capsuleIncludeRawJson;
    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    extension_settings[MODULE_NAME].rpmLimit = Math.max(
        0,
        Math.floor(Number(extension_settings[MODULE_NAME].rpmLimit) || 0),
    );
    extension_settings[MODULE_NAME].nodeIterationMaxRounds = Math.max(
        1,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].nodeIterationMaxRounds) || 0)),
    );
    extension_settings[MODULE_NAME].reviewRerunMaxRounds = Math.max(
        0,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].reviewRerunMaxRounds) || 0)),
    );
    extension_settings[MODULE_NAME].agentTimeoutSeconds = Math.max(
        0,
        Math.min(3600, Math.floor(Number(extension_settings[MODULE_NAME].agentTimeoutSeconds) || 0)),
    );
    if (!extension_settings[MODULE_NAME].chatOverrides || typeof extension_settings[MODULE_NAME].chatOverrides !== 'object') {
        extension_settings[MODULE_NAME].chatOverrides = {};
    }
}

function buildOrchestratorResultEventPayload(context, payload, status, options = {}) {
    const generationType = String(payload?.type || 'normal').trim().toLowerCase() || 'normal';
    const chatKey = String(getChatKey(context) || '');
    const includeSnapshot = Boolean(options.includeSnapshot);
    const activeSnapshot = getActiveSnapshot();
    const snapshot = includeSnapshot && activeSnapshot && typeof activeSnapshot === 'object'
        ? activeSnapshot
        : null;
    const sameChatSnapshot = snapshot && String(snapshot.chatKey || '') === chatKey
        ? snapshot
        : null;
    const entry = sameChatSnapshot ? getLatestOrchestrationEntry(context) : null;

    return {
        module: MODULE_NAME,
        event: ORCH_RESULT_EVENT,
        status: String(status || 'unknown'),
        generationType,
        chatKey,
        at: new Date().toISOString(),
        anchorPlayableFloor: Number(entry?.anchorPlayableFloor || 0),
        anchorHash: String(sameChatSnapshot?.anchorHash || ''),
        capsuleText: String(entry?.injectedText || ''),
        stageOutputs: sameChatSnapshot && Array.isArray(sameChatSnapshot.stageOutputs)
            ? structuredClone(sameChatSnapshot.stageOutputs)
            : [],
        reviewRerunCount: Number(options.reviewRerunCount || 0),
        reason: String(options.reason || ''),
        note: String(options.note || ''),
        error: String(options.error || ''),
    };
}

async function emitOrchestratorResultEvent(context, payload, status, options = {}) {
    if (!context?.eventSource || typeof context.eventSource.emit !== 'function') {
        return;
    }
    const eventPayload = buildOrchestratorResultEventPayload(context, payload, status, options);
    try {
        await context.eventSource.emit(ORCH_RESULT_EVENT, eventPayload);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to emit result event`, error);
    }
}

async function openOrchestrationRuntimeTrace(context) {
    const popupId = `luker_orch_runtime_trace_${Date.now()}`;
    const selector = `#${popupId}`;
    const namespace = `.lukerOrchRuntimeTrace_${popupId}`;
    const popupHtml = `<div id="${popupId}" class="luker_orch_runtime_popup_shell">${renderOrchestrationRuntimeTraceHtml(context)}</div>`;
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('Orchestration Runtime Trace'),
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
        },
    );

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        openOrchExpandedDiff(rootElement, this);
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="close-line-diff-zoom"], ${selector} .luker_orch_line_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`keydown${namespace}`, function (event) {
        if (event.key !== 'Escape') {
            return;
        }
        const rootElement = document.querySelector(selector);
        const overlay = rootElement?.querySelector?.('.luker_orch_line_diff_zoom_overlay');
        if (!(overlay instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`pointerdown${namespace}`, `${selector} .luker_orch_line_diff_splitter`, function (event) {
        beginOrchLineDiffResize(this, event.originalEvent || event);
    });

    try {
        await popupPromise;
    } finally {
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
        jQuery(document).off(namespace);
    }
}

async function editLastOrchestrationResult(context) {
    await loadOrchestratorChatState(context);
    const entry = getLatestOrchestrationEntry(context);
    if (!entry || typeof entry !== 'object') {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }

    const input = await context.callGenericPopup(
        i18n('Edit latest orchestration result text.'),
        context.POPUP_TYPE.INPUT,
        String(entry.injectedText || ''),
        {
            rows: 16,
            wide: true,
            wider: true,
            large: true,
            okButton: i18n('Save'),
            cancelButton: i18n('Cancel'),
        },
    );
    if (typeof input !== 'string') {
        return false;
    }

    const nextText = String(input || '').trim();
    if (!nextText) {
        notifyError(i18n('Orchestration result cannot be empty.'));
        return false;
    }

    const chatKey = getChatKey(context);
    const activeSnapshot = getActiveSnapshot();
    if (!activeSnapshot || typeof activeSnapshot !== 'object') {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }
    if (String(activeSnapshot.chatKey || '') !== String(chatKey || '')) {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }

    const updatedSnapshot = {
        ...activeSnapshot,
        capsuleText: nextText,
    };
    setActiveSnapshot(updatedSnapshot);
    clearCapsulePrompt(context);
    const persisted = await persistEditedSnapshotToFloorState(context, updatedSnapshot);
    if (!persisted) {
        notifyError(i18n('Failed to persist orchestration snapshot.'));
        return false;
    }
    ensureUi();
    notifySuccess(i18n('Saved latest orchestration result.'));
    updateUiStatus(i18n('Saved latest orchestration result.'));
    return true;
}

/**
 * Persist a user-edited or rebuilt active snapshot through the floor-state
 * binding. Re-derives the anchor's chatIndex / swipeId from the live chat
 * so the commit lands at the same (floor, swipeId) as the original
 * orchestration. Returns false when the anchored user message has been
 * deleted or replaced — the caller should treat that as a soft error.
 */

async function openLastOrchestrationResult(context) {
    await loadOrchestratorChatState(context);
    const hasEntry = Boolean(getLatestOrchestrationEntry(context));
    const editButtonResult = context?.POPUP_RESULT?.CUSTOM1 ?? 2;
    const popupResult = await context.callGenericPopup(
        renderLastOrchestrationResultHtml(getLatestOrchestrationEntry(context)),
        context.POPUP_TYPE.TEXT,
        i18n('Latest Orchestration Result'),
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
            customButtons: hasEntry
                ? [{ text: i18n('Edit Result'), result: editButtonResult, appendAtEnd: true }]
                : [],
        },
    );
    if (popupResult === editButtonResult) {
        const saved = await editLastOrchestrationResult(context);
        if (saved) {
            await openLastOrchestrationResult(context);
        }
    }
}

function shouldRunOrchestrationForPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    if (payload.dryRun === true) {
        return false;
    }
    const type = String(payload.type || '').trim().toLowerCase();
    if (!ORCH_ALLOWED_GENERATION_TYPES.has(type)) {
        return false;
    }
    return true;
}

function abortActiveOrchestratorRun() {
    if (activeOrchRunAbortController && !activeOrchRunAbortController.signal.aborted) {
        activeOrchRunAbortController.abort();
    }
    clearRunInfoToast();
}

function getEffectiveProfile(context) {
    const settings = extension_settings[MODULE_NAME];
    const executionMode = getExecutionMode(settings);
    if (executionMode === ORCH_EXECUTION_MODE_AGENDA) {
        const buildAgendaProfile = (source, key, draft) => {
            const profile = sanitizeAgendaWorkingProfile(draft);
            return {
                source: String(source || 'agenda'),
                key: String(key || 'agenda'),
                mode: ORCH_EXECUTION_MODE_AGENDA,
                planner: profile.planner,
                agents: profile.agents,
                finalAgentId: profile.finalAgentId,
                limits: {
                    plannerMaxRounds: profile.limits.plannerMaxRounds,
                    maxConcurrentAgents: profile.limits.maxConcurrentAgents,
                    maxTotalRuns: profile.limits.maxTotalRuns,
                },
            };
        };

        const chatKey = getChatKey(context);
        const chatOverride = settings.chatOverrides?.[chatKey];
        if (chatOverride?.agenda?.enabled) {
            return buildAgendaProfile('chat', chatKey, chatOverride.agenda);
        }

        const avatar = getCurrentAvatar(context);
        const characterAgendaOverride = getCharacterAgendaOverrideByAvatar(context, avatar);
        if (characterAgendaOverride?.enabled) {
            return buildAgendaProfile('character', avatar, characterAgendaOverride);
        }

        return buildAgendaProfile('global', 'agenda', {
            planner: settings.agendaPlanner,
            agents: settings.agendaAgents,
            finalAgentId: settings.agendaFinalAgentId,
            limits: {
                plannerMaxRounds: settings.agendaPlannerMaxRounds,
                maxConcurrentAgents: settings.agendaMaxConcurrentAgents,
                maxTotalRuns: settings.agendaMaxTotalRuns,
            },
        });
    }
    if (executionMode === ORCH_EXECUTION_MODE_SINGLE || settings.singleAgentModeEnabled) {
        return {
            source: 'single',
            key: 'single_agent',
            mode: ORCH_EXECUTION_MODE_SINGLE,
            spec: sanitizeSpec({
                stages: [{
                    id: 'single',
                    mode: 'serial',
                    nodes: [{
                        id: 'single_agent',
                        preset: 'single_agent',
                    }],
                }],
            }),
            presets: sanitizePresetMap({
                ...settings.presets,
                single_agent: {
                    systemPrompt: String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT),
                    userPromptTemplate: String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE),
                },
            }),
        };
    }
    const chatKey = getChatKey(context);
    const chatOverride = settings.chatOverrides?.[chatKey];
    if (chatOverride?.enabled && chatOverride?.spec) {
        const overridePresets = resolveOverridePresetMap(chatOverride, settings.presets);
        const editablePresets = toEditablePresetMap(overridePresets);
        const editableSpec = toEditableSpec(chatOverride.spec, editablePresets);
        return {
            source: 'chat',
            key: chatKey,
            mode: ORCH_EXECUTION_MODE_SPEC,
            spec: sanitizeSpec(editableSpec),
            presets: sanitizePresetMap(editablePresets),
        };
    }

    const avatar = getCurrentAvatar(context);
    const characterOverride = getCharacterOverrideByAvatar(context, avatar);
    if (characterOverride?.enabled && characterOverride?.spec) {
        const overridePresets = resolveOverridePresetMap(characterOverride, settings.presets);
        const editablePresets = toEditablePresetMap(overridePresets);
        const editableSpec = toEditableSpec(characterOverride.spec, editablePresets);
        return {
            source: 'character',
            key: avatar,
            mode: ORCH_EXECUTION_MODE_SPEC,
            spec: sanitizeSpec(editableSpec),
            presets: sanitizePresetMap(editablePresets),
        };
    }

    return {
        source: 'global',
        key: 'global',
        mode: ORCH_EXECUTION_MODE_SPEC,
        spec: sanitizeSpec(settings.orchestrationSpec),
        presets: sanitizePresetMap(settings.presets),
    };
}

async function runAiCharacterProfileBuild(context, settings, { abortSignal = null } = {}) {
    syncCharacterEditorWithActiveAvatar(context);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    const isCharacterMode = Boolean(avatar);
    const characterCard = isCharacterMode
        ? getCharacterCardSnapshot(context, avatar)
        : {
            avatar: '',
            name: 'Global Orchestration Profile',
            description: 'Build a reusable global orchestration profile that works across character cards.',
            personality: '',
            scenario: '',
            system: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
        };
    if (isCharacterMode && !characterCard.name) {
        throw new Error('Selected character card is invalid.');
    }

    updateUiStatus(i18nFormat('Generating orchestration profile for ${0}...', characterCard.name));

    const parsed = await buildAiOrchestrationProfile(context, settings, {
        characterCard,
        currentSpec: sanitizeSpec(settings.orchestrationSpec),
        currentPresets: serializeEditorPresetMap(settings.presets),
        overrideGoal: String(uiState.aiGoal || ''),
        abortSignal,
    });

    const suggestedSpec = sanitizeSpec(parsed.orchestrationSpec);
    const suggestedPatch = parsed.presetPatch && typeof parsed.presetPatch === 'object' ? parsed.presetPatch : {};
    const mergedPresets = mergePresetMaps(serializeEditorPresetMap(settings.presets), suggestedPatch);

    if (isCharacterMode) {
        uiState.characterEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
        uiState.characterEditor.presets = toEditablePresetMap(mergedPresets);
        uiState.characterEditor.enabled = true;
        const persisted = await persistCharacterEditor(context, settings, avatar, {
            editor: uiState.characterEditor,
            forceEnabled: true,
        });
        if (!persisted) {
            throw new Error(i18n('Failed to persist character override.'));
        }
        return {
            scope: 'character',
            avatar,
            name: getCharacterDisplayNameByAvatar(context, avatar) || characterCard.name,
        };
    }

    uiState.globalEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
    uiState.globalEditor.presets = toEditablePresetMap(mergedPresets);
    await persistGlobalEditorFrom(settings, uiState.globalEditor);
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    return {
        scope: 'global',
        avatar: '',
        name: i18n('Global profile'),
    };
}

async function runOrchestration(context, payload, messages, profile) {
    if (String(profile?.mode || '') === ORCH_EXECUTION_MODE_AGENDA || String(profile?.source || '') === 'agenda') {
        return runAgendaOrchestration(context, payload, messages, profile);
    }
    return runSpecOrchestration(context, payload, messages, profile);
}

function getFinalStageSnapshot(stageOutputs) {
    const compact = compactStageOutputs(stageOutputs);
    if (!Array.isArray(compact) || compact.length === 0) {
        return null;
    }
    const last = compact[compact.length - 1];
    if (!last || !Array.isArray(last.nodes)) {
        return null;
    }
    return {
        id: String(last.id || `stage_${compact.length}`),
        mode: String(last.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
        nodes: last.nodes
            .map(node => ({
                node: String(node?.node || ''),
                output: normalizeNodeOutputForSnapshot(node?.output),
            }))
            .filter(node => node.node),
    };
}

function extractNodeInjectionText(nodeOutput) {
    if (typeof nodeOutput === 'string') {
        const text = String(nodeOutput);
        return text.trim() ? text : '';
    }
    return '';
}

function buildCapsule(stageOutputs) {
    const finalStage = getFinalStageSnapshot(stageOutputs);
    const settings = extension_settings[MODULE_NAME];
    const customInstruction = String(settings?.capsuleCustomInstruction || '').trim();
    const finalTexts = Array.isArray(finalStage?.nodes)
        ? finalStage.nodes
            .map(node => extractNodeInjectionText(node?.output))
            .filter(Boolean)
        : [];
    const body = finalTexts.length <= 1
        ? (finalTexts[0] || '')
        : finalTexts.join('\n\n');
    if (!body) {
        return '';
    }
    if (!customInstruction) {
        return body;
    }
    return `${customInstruction}\n\n${body}`;
}

function reapplyLatestCapsuleInjection(context) {
    const chatKey = getChatKey(context);
    const activeSnapshot = getActiveSnapshot();
    if (!activeSnapshot || typeof activeSnapshot !== 'object') {
        return;
    }
    if (String(activeSnapshot.chatKey || '') !== String(chatKey || '')) {
        return;
    }
    const rebuiltText = buildCapsule(Array.isArray(activeSnapshot.stageOutputs) ? activeSnapshot.stageOutputs : []);
    const nextText = String(rebuiltText || activeSnapshot.capsuleText || '').trim();
    const updatedSnapshot = {
        ...activeSnapshot,
        capsuleText: nextText,
    };
    setActiveSnapshot(updatedSnapshot);
    clearCapsulePrompt(context);
    void persistEditedSnapshotToFloorState(context, updatedSnapshot);
}

async function onWorldInfoFinalized(payload) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];

    if (!settings.enabled) {
        return;
    }
    if (!shouldRunOrchestrationForPayload(payload)) {
        return;
    }
    if (orchInFlight) {
        return;
    }
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        await loadOrchestratorChatState(context);
        clearCapsulePrompt(context);
        refreshActiveSnapshotFromCache(context);
        await emitOrchestratorResultEvent(context, payload, 'cancelled', {
            reason: 'generation_aborted_before_orchestration',
            note: 'Generation was aborted before orchestration started.',
            includeSnapshot: false,
        });
        updateUiStatus(i18n('Generation aborted. Skipped orchestration.'));
        return;
    }
    orchInFlight = true;
    const pluginAbortController = new AbortController();
    activeOrchRunAbortController = pluginAbortController;
    const linkedAbort = linkAbortSignals(payload?.signal, pluginAbortController.signal);
    const orchestrationPayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? {
            ...payload,
            signal: linkedAbort.signal,
            __lukerOrchGenerationSignal: payload?.signal || null,
        }
        : payload;
    let stopRequestedByUser = false;
    let resolveStopRequest = null;
    const stopRequestPromise = new Promise((resolve) => {
        resolveStopRequest = () => {
            if (stopRequestedByUser) {
                return;
            }
            stopRequestedByUser = true;
            if (!pluginAbortController.signal.aborted) {
                pluginAbortController.abort();
            }
            resolve({ stopped: true });
        };
    });

    try {
        await loadOrchestratorChatState(context);
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        const profile = getEffectiveProfile(context);
        const messages = structuredClone(Array.isArray(payload?.coreChat) ? payload.coreChat : []);
        if (messages.length === 0) {
            clearLatestOrchestrationRuntimeTrace(context);
            clearCapsulePrompt(context);
            refreshActiveSnapshotFromCache(context);
            await emitOrchestratorResultEvent(context, payload, 'cancelled', {
                reason: 'empty_messages',
                note: 'Skipped orchestration because there are no playable messages.',
                includeSnapshot: false,
            });
            return;
        }
        const chatKey = getChatKey(context);
        const anchor = buildLastUserAnchor(context, messages);
        if (canReuseLatestOrchestrationSnapshot(chatKey, anchor)) {
            const capsuleText = String(getActiveSnapshot()?.capsuleText || '').trim();
            if (capsuleText) {
                const reuseTraceStages = String(profile?.mode || '') === ORCH_EXECUTION_MODE_AGENDA
                    ? []
                    : (sanitizeSpec(profile.spec)?.stages || []);
                const reuseTrace = createOrchestrationRuntimeTrace(context, payload, reuseTraceStages, {
                    status: 'reused',
                    note: i18n('Reused previous orchestration snapshot. No nodes executed.'),
                    capsuleText,
                });
                finalizeOrchestrationRuntimeTrace(reuseTrace, 'reused', {
                    capsuleText,
                    note: i18n('Reused previous orchestration snapshot. No nodes executed.'),
                });
                injectCapsuleToPayload(payload, capsuleText, settings);
                throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
                await emitOrchestratorResultEvent(context, payload, 'reused', {
                    includeSnapshot: true,
                    note: 'Reused previous orchestration snapshot.',
                });
                updateUiStatus(i18n('Orchestrator completed.'));
                clearRunInfoToast();
                return;
            }
        }
        updateUiStatus(i18n('Orchestrator running...'));
        showRunInfoToast(i18n('Orchestrator running...'), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                resolveStopRequest?.();
            },
        });

        const orchestrationTask = runOrchestration(context, orchestrationPayload, messages, profile);
        void orchestrationTask.catch((error) => {
            if (!stopRequestedByUser) {
                return;
            }
            if (!isAbortError(error, orchestrationPayload?.signal)) {
                console.warn(`[${MODULE_NAME}] Orchestration finished after user stop`, error);
            }
        });
        const raced = await Promise.race([
            orchestrationTask.then(finalRun => ({ stopped: false, finalRun })),
            stopRequestPromise,
        ]);
        if (raced?.stopped) {
            finalizeOrchestrationRuntimeTrace(getLatestOrchestrationRuntimeTrace(context), 'cancelled', {
                note: i18n('Orchestration cancelled by user before completion.'),
            });
            clearCapsulePrompt(context);
            await emitOrchestratorResultEvent(context, payload, 'cancelled', {
                reason: 'user_stopped',
                note: 'Orchestration cancelled by user before completion.',
                includeSnapshot: false,
            });
            updateUiStatus(i18n('Orchestrator cancelled by user.'));
            return;
        }
        const finalRun = raced?.finalRun;
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');

        const capsuleText = buildCapsule(finalRun.stageOutputs || []);
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        injectCapsuleToPayload(payload, capsuleText, settings);
        await storeCompletedOrchestrationSnapshot(context, anchor, capsuleText, finalRun.stageOutputs || []);
        finalizeOrchestrationRuntimeTrace(finalRun?.runtimeTrace || getLatestOrchestrationRuntimeTrace(context), 'completed', {
            capsuleText,
            reviewRerunCount: Number(finalRun?.reviewRerunCount || 0),
        });
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        await emitOrchestratorResultEvent(context, payload, 'completed', {
            includeSnapshot: true,
            reviewRerunCount: Number(finalRun?.reviewRerunCount || 0),
        });
        updateUiStatus(i18n('Orchestrator completed.'));
        clearRunInfoToast();
    } catch (error) {
        if (isAbortError(error, orchestrationPayload?.signal)) {
            finalizeOrchestrationRuntimeTrace(getLatestOrchestrationRuntimeTrace(context), 'cancelled', {
                note: Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted)
                    ? i18n('Generation aborted before orchestration completed.')
                    : i18n('Orchestration cancelled by user.'),
            });
            clearCapsulePrompt(context);
            const generationAborted = Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted);
            updateUiStatus(generationAborted
                ? i18n('Generation aborted. Skipped orchestration.')
                : i18n('Orchestrator cancelled by user.'));
            await emitOrchestratorResultEvent(context, payload, 'cancelled', {
                reason: generationAborted ? 'generation_aborted' : 'orchestration_cancelled',
                note: generationAborted
                    ? 'Generation aborted before orchestration completed.'
                    : 'Orchestration cancelled by user.',
                includeSnapshot: false,
            });
            clearRunInfoToast();
            return;
        }
        finalizeOrchestrationRuntimeTrace(getLatestOrchestrationRuntimeTrace(context), 'failed', {
            error: String(error?.message || error),
        });
        clearCapsulePrompt(context);
        console.warn(`[${MODULE_NAME}] Orchestration failed`, error);
        const failText = i18nFormat('Orchestrator failed: ${0}', String(error?.message || error));
        updateUiStatus(failText);
        clearRunInfoToast();
        await emitOrchestratorResultEvent(context, payload, 'failed', {
            reason: 'runtime_error',
            error: String(error?.message || error),
            includeSnapshot: false,
        });
        notifyError(failText);
    } finally {
        linkedAbort.cleanup();
        if (activeOrchRunAbortController === pluginAbortController) {
            activeOrchRunAbortController = null;
        }
        clearRunInfoToast();
        orchInFlight = false;
    }
}

async function onMessageDeleted(_chatLength, _details) {
    // Floor-state is settled by core before this listener fires (via
    // settleMessageDeleted). Tail-deletes naturally drop their snapshots
    // from the data namespace; for middle deletes — which shift every
    // higher floor's chat-array index down by one — floor-tagged commits
    // come out of sync, but the consume-time check in
    // `pickLatestValidSnapshot` filters them via anchorHash + is_user.
    // We just refresh the cache and the UI here.
    const context = getContext();
    const { activeChanged, mapChanged } = await refreshOrchestratorStateAfterStructuralEvent(context);
    if (activeChanged || mapChanged) {
        clearCapsulePrompt(context);
    }
    ensureUi();
}

async function onMessageEdited(_messageId, _mutationMeta = null) {
    // Floor-state has no MESSAGE_EDITED settle path — edits don't change
    // chat structure, only message content. The active snapshot is
    // content-bound by `anchorHash`, so a stale entry is detected at
    // consume time and naturally rejected. The data namespace is left
    // as-is; orphan entries get reaped when the owning floor is itself
    // deleted or overwritten.
    const context = getContext();
    const { activeChanged } = await refreshOrchestratorStateAfterStructuralEvent(context);
    if (activeChanged) {
        clearCapsulePrompt(context);
    }
    ensureUi();
}

function notifyInfo(message) {
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
    }
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message));
    }
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function buildBestEffortSpecFromAgendaAgents(agents, finalAgentId) {
    const normalizedAgents = sanitizePresetMap(agents);
    const agentIds = Object.keys(normalizedAgents);
    const fallbackFinalAgentId = agentIds[0] || 'finalizer';
    const resolvedFinalAgentId = normalizedAgents[finalAgentId]
        ? String(finalAgentId)
        : fallbackFinalAgentId;
    const nonFinalAgentIds = agentIds.filter(id => id !== resolvedFinalAgentId);
    const distillerId = nonFinalAgentIds.find(id => {
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId === 'distiller' || normalizedId.includes('distill');
    }) || null;
    const reviewAgentIds = nonFinalAgentIds.filter(id => {
        if (id === distillerId) {
            return false;
        }
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId === 'critic'
            || normalizedId.includes('critic')
            || normalizedId.includes('review')
            || normalizedId.includes('audit');
    });
    const remainingWorkerIds = nonFinalAgentIds.filter(id => id !== distillerId && !reviewAgentIds.includes(id));
    const groundingAgentIds = remainingWorkerIds.filter(id => {
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId.includes('lore')
            || normalizedId.includes('ground')
            || normalizedId.includes('constraint')
            || normalizedId.includes('recall')
            || normalizedId.includes('memory');
    });
    const reasoningAgentIds = remainingWorkerIds.filter(id => {
        if (groundingAgentIds.includes(id)) {
            return false;
        }
        const normalizedId = String(id || '').trim().toLowerCase();
        return normalizedId.includes('plan')
            || normalizedId.includes('scene')
            || normalizedId.includes('progress')
            || normalizedId.includes('writer')
            || normalizedId.includes('draft');
    });
    const supportAgentIds = remainingWorkerIds.filter(id => !groundingAgentIds.includes(id) && !reasoningAgentIds.includes(id));
    const stages = [];

    if (distillerId) {
        stages.push({
            id: 'distill',
            mode: 'serial',
            nodes: [distillerId],
        });
    }

    if (groundingAgentIds.length > 0) {
        stages.push({
            id: 'grounding',
            mode: groundingAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: groundingAgentIds,
        });
    }

    if (reasoningAgentIds.length > 0) {
        stages.push({
            id: 'reason',
            mode: reasoningAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: reasoningAgentIds,
        });
    }

    if (supportAgentIds.length > 0) {
        stages.push({
            id: 'workers',
            mode: supportAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: supportAgentIds,
        });
    }

    if (reviewAgentIds.length > 0) {
        stages.push({
            id: 'review',
            mode: reviewAgentIds.length > 1 ? 'parallel' : 'serial',
            nodes: reviewAgentIds.map(id => ({
                id,
                preset: id,
                type: ORCH_NODE_TYPE_REVIEW,
            })),
        });
    }

    stages.push({
        id: 'finalize',
        mode: 'serial',
        nodes: [resolvedFinalAgentId],
    });

    return sanitizeSpec({ stages });
}

function copySpecPresetsIntoAgendaEditor(sourceEditor, agendaEditor) {
    ensureEditorIntegrity(sourceEditor);
    ensureAgendaEditorIntegrity(agendaEditor);
    agendaEditor.agents = sanitizePresetMap(sourceEditor.presets);
    if (agendaEditor.agents.synthesizer) {
        agendaEditor.agents.finalizer = structuredClone(agendaEditor.agents.synthesizer);
        delete agendaEditor.agents.synthesizer;
    }
    if (Object.keys(agendaEditor.agents).length === 0) {
        agendaEditor.agents.finalizer = structuredClone(defaultAgendaAgents.finalizer);
    }
    agendaEditor.finalAgentId = agendaEditor.agents.finalizer
        ? 'finalizer'
        : (Object.keys(agendaEditor.agents)[0] || 'finalizer');
}

function copyAgendaAgentsIntoSpecEditor(agendaEditor, specEditor) {
    ensureAgendaEditorIntegrity(agendaEditor);
    ensureEditorIntegrity(specEditor);
    const copiedPresets = sanitizePresetMap(agendaEditor.agents);
    const fallbackFinalAgentId = Object.keys(copiedPresets)[0] || 'finalizer';
    const finalAgentId = copiedPresets[agendaEditor.finalAgentId]
        ? sanitizeIdentifierToken(agendaEditor.finalAgentId, fallbackFinalAgentId)
        : fallbackFinalAgentId;
    specEditor.presets = copiedPresets;
    specEditor.spec = buildBestEffortSpecFromAgendaAgents(copiedPresets, finalAgentId);
    ensureEditorIntegrity(specEditor);
}

function renderPresetOptions(presets, selectedPreset) {
    const selected = String(selectedPreset || '');
    const ids = Object.keys(presets || {});
    const options = [];

    if (selected && !presets[selected]) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }

    for (const presetId of ids) {
        options.push(`<option value="${escapeHtml(presetId)}"${presetId === selected ? ' selected' : ''}>${escapeHtml(presetId)}</option>`);
    }

    return options.join('');
}

function renderWorkflowBoard(scope, editor) {
    const stages = Array.isArray(editor?.spec?.stages) ? editor.spec.stages : [];
    if (stages.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No stages yet. Add one stage to start orchestration.'))}</div>`;
    }

    const stageBlocks = stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const isParallel = stage.mode === 'parallel';
        const modeClass = isParallel ? 'parallel' : 'serial';
        const modeIcon = isParallel ? 'fa-solid fa-arrows-split-up-and-left' : 'fa-solid fa-arrow-down-long';
        const modeLabel = isParallel ? i18n('Parallel') : i18n('Serial');
        const nodeType = (type) => normalizeNodeType(type) === ORCH_NODE_TYPE_REVIEW ? 'review' : 'worker';
        const nodeIcon = (type) => normalizeNodeType(type) === ORCH_NODE_TYPE_REVIEW ? 'fa-solid fa-magnifying-glass' : 'fa-solid fa-gear';

        const nodeCards = nodes.map((node, nodeIndex) => `
<details class="luker-studio-pipeline-node">
    <summary>
        <span class="luker-studio-pipeline-node-summary">
            <i class="luker-studio-pipeline-node-icon ${nodeIcon(node.type)}" aria-hidden="true"></i>
            <span class="luker-studio-pipeline-node-name">${escapeHtml(node.id || i18nFormat('Node ${0}', nodeIndex + 1))}</span>
            <span class="luker-studio-pipeline-node-type">${escapeHtml(nodeType(node.type))}</span>
        </span>
        <span class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="node-move-up" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" title="${escapeHtml(i18n('Up'))}"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="node-move-down" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" title="${escapeHtml(i18n('Down'))}"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="node-delete" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash" aria-hidden="true"></i></div>
        </span>
        <i class="luker-studio-pipeline-node-chevron fa-solid fa-chevron-right" aria-hidden="true"></i>
    </summary>
    <div class="luker-studio-pipeline-node-body">
        <label>${escapeHtml(i18n('Node ID'))}</label>
        <input class="text_pole" data-luker-field="node-id" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" value="${escapeHtml(node.id)}" />
        <label>${escapeHtml(i18n('Preset'))}</label>
        <select class="text_pole" data-luker-field="node-preset" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
            ${renderPresetOptions(editor.presets, node.preset)}
        </select>
        <label>${escapeHtml(i18n('Node Type'))}</label>
        <select class="text_pole" data-luker-field="node-type" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
            <option value="${ORCH_NODE_TYPE_WORKER}"${normalizeNodeType(node.type) === ORCH_NODE_TYPE_WORKER ? ' selected' : ''}>${escapeHtml(i18n('Worker'))}</option>
            <option value="${ORCH_NODE_TYPE_REVIEW}"${normalizeNodeType(node.type) === ORCH_NODE_TYPE_REVIEW ? ' selected' : ''}>${escapeHtml(i18n('Review'))}</option>
        </select>
        <label>${escapeHtml(i18n('Node Prompt Template (optional)'))}</label>
        <textarea class="text_pole textarea_compact" rows="4" data-luker-field="node-template" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" placeholder="${escapeHtml(i18n('Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result and approved review feedback are auto-injected.'))}">${escapeHtml(node.userPromptTemplate)}</textarea>
    </div>
</details>`).join('');

        return `
<div class="luker-studio-pipeline-stage" data-mode="${modeClass}">
    <div class="luker-studio-pipeline-stage-head">
        <div class="luker-studio-pipeline-stage-id">
            <input class="text_pole" data-luker-field="stage-id" data-scope="${scope}" data-stage-index="${stageIndex}" value="${escapeHtml(stage.id)}" />
        </div>
        <span class="luker-studio-pipeline-mode-pill ${modeClass}">
            <i class="${modeIcon}" aria-hidden="true"></i>
            ${escapeHtml(modeLabel)}
        </span>
        <select class="text_pole" data-luker-field="stage-mode" data-scope="${scope}" data-stage-index="${stageIndex}" style="max-width:110px">
            <option value="serial"${stage.mode === 'serial' ? ' selected' : ''}>${escapeHtml(i18n('Serial'))}</option>
            <option value="parallel"${stage.mode === 'parallel' ? ' selected' : ''}>${escapeHtml(i18n('Parallel'))}</option>
        </select>
        <span class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="stage-move-up" data-scope="${scope}" data-stage-index="${stageIndex}" title="${escapeHtml(i18n('Up'))}"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="stage-move-down" data-scope="${scope}" data-stage-index="${stageIndex}" title="${escapeHtml(i18n('Down'))}"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></div>
            <div class="menu_button menu_button_small" data-luker-action="stage-delete" data-scope="${scope}" data-stage-index="${stageIndex}" title="${escapeHtml(i18n('Delete'))}"><i class="fa-solid fa-trash" aria-hidden="true"></i></div>
        </span>
    </div>
    <div class="luker-studio-pipeline-nodes">${nodeCards || `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No nodes. Add one to define this stage.'))}</div>`}</div>
    <div class="luker-studio-pipeline-stage-footer">
        <div class="menu_button menu_button_small" data-luker-action="node-add" data-scope="${scope}" data-stage-index="${stageIndex}">${escapeHtml(i18n('Add Node'))}</div>
    </div>
</div>`;
    });

    const connectorHtml = `
<div class="luker-studio-pipeline-connector">
    <div class="luker-studio-pipeline-connector-arrow"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></div>
</div>`;

    return `<div class="luker-studio-pipeline">${stageBlocks.join(connectorHtml)}</div>`;
}

function renderPresetBoard(scope, editor) {
    const entries = Object.entries(editor?.presets || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No presets yet.'))}</div>`;
    }

    return entries.map(([presetId, preset]) => `
<div class="luker-studio-card">
    <div class="luker-studio-card-header">
        <b>${escapeHtml(presetId)}</b>
        <div class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="preset-delete" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
    <label>${escapeHtml(i18n('Agent API preset (Connection profile, empty = global orchestration API preset)'))}</label>
    <select class="text_pole" data-luker-field="preset-api-preset" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">
        ${renderConnectionProfileOptions(preset?.apiPresetName, i18n('(Global orchestration API preset)'))}
    </select>
    <label>${escapeHtml(i18n('Agent preset (params + prompt, empty = global orchestration preset)'))}</label>
    <select class="text_pole" data-luker-field="preset-prompt-preset" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">
        ${renderOpenAIPresetOptions(getContext(), preset?.promptPresetName, i18n('(Global orchestration prompt preset)'))}
    </select>
    <label>${escapeHtml(i18n('System Prompt'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="preset-system-prompt" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.systemPrompt)}</textarea>
    <label>${escapeHtml(i18n('User Prompt Template'))}</label>
    <textarea class="text_pole textarea_compact" rows="5" data-luker-field="preset-user-template" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.userPromptTemplate)}</textarea>
</div>`).join('');
}

function getOrchestratorUiTemplateDeps() {
    return {
        DEFAULT_AGENDA_PLANNER_PROMPT,
        DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_SINGLE,
        ORCH_EXECUTION_MODE_SPEC,
        UI_BLOCK_ID,
        createAgendaPlannerDraft,
        ensureAgendaEditorIntegrity,
        escapeHtml,
        extension_prompt_roles,
        getAgendaEditorByScope,
        getCharacterAgendaOverrideByAvatar,
        getCharacterDisplayNameByAvatar,
        getCharacterOverrideByAvatar,
        getContext,
        getCurrentAvatar,
        getDisplayedScope,
        getEditorByScope,
        getExecutionMode,
        getPopupEditingLabel,
        getProfileTitleForScope,
        hasCharacterAgendaOverride,
        hasCharacterSpecOverride,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
        renderPresetBoard,
        renderWorkflowBoard,
        sanitizeIdentifierToken,
        sanitizePresetMap,
        syncCharacterEditorWithActiveAvatar,
        uiState,
        world_info_position,
    };
}

function buildLatestOrchestrationStateSummary(context) {
    const entry = getLatestOrchestrationEntry(context);
    const anchorCount = getLoadedOrchestrationHistoryAnchors(context).length;
    if (entry?.anchorPlayableFloor) {
        return i18nFormat('Last run state: user turn ${0} · stored anchors ${1}', entry.anchorPlayableFloor, anchorCount);
    }
    if (anchorCount > 0) {
        return i18nFormat('Last run state: none · stored anchors ${0}', anchorCount);
    }
    return i18n('Last run state: none');
}

function renderDynamicPanels(root, context) {
    const settings = getSettings();
    const executionMode = getExecutionMode(settings);
    const singleModeEnabled = executionMode === ORCH_EXECUTION_MODE_SINGLE;
    const agendaModeEnabled = executionMode === ORCH_EXECUTION_MODE_AGENDA;
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const override = activeAvatar ? getCharacterOverrideByAvatar(context, activeAvatar) : null;
    const agendaOverride = activeAvatar ? getCharacterAgendaOverrideByAvatar(context, activeAvatar) : null;
    const specScope = getDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC);
    const agendaScope = getDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA);
    const isSpecCharacterScope = specScope === 'character';
    const isAgendaCharacterScope = agendaScope === 'character';
    const hasSpecCharacterOverride = hasCharacterSpecOverride(context, activeAvatar);
    const hasAgendaCharacterOverride = hasCharacterAgendaOverride(context, activeAvatar);
    const isOverrideEnabled = Boolean(override?.enabled);
    const isAgendaOverrideEnabled = Boolean(agendaOverride?.enabled);
    root.find('#luker_orch_profile_target').text(
        activeAvatar
            ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
            : i18n('(No character card)'),
    );
    root.find('#luker_orch_profile_mode').text(
        getDisplayedScopeLabel(isSpecCharacterScope, hasSpecCharacterOverride, isOverrideEnabled),
    );
    root.find('#luker_orch_agenda_profile_target').text(
        activeAvatar
            ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
            : i18n('(No character card)'),
    );
    root.find('#luker_orch_agenda_profile_mode').text(
        getDisplayedScopeLabel(isAgendaCharacterScope, hasAgendaCharacterOverride, isAgendaOverrideEnabled),
    );
    const hasLastRun = Boolean(getLatestOrchestrationEntry(context));
    root.find('[data-luker-action="view-last-run"]').toggleClass('luker_orch_button_disabled', !hasLastRun);
    root.find('#luker_orch_last_run_state').text(buildLatestOrchestrationStateSummary(context));
    root.find('[data-luker-ai-goal-input]').val(String(uiState.aiGoal || ''));
    root.find('#luker_orch_spec_board').toggle(!singleModeEnabled && !agendaModeEnabled);
    root.find('#luker_orch_agenda_board').toggle(agendaModeEnabled);
    root.find('#luker_orch_single_mode_runtime_tools').toggle(singleModeEnabled);
    root.find('#luker_orch_single_mode_hint').toggle(singleModeEnabled);
    root.find('#luker_orch_single_agent_fields').toggle(singleModeEnabled);
    root.find('#luker_orch_execution_mode').val(executionMode);
    refreshOrchestrationEditorPopup(context, settings);
}

function refreshOrchestrationEditorPopup(context, settings) {
    const contentId = String(uiState.orchEditorPopupContentId || '');
    if (!contentId) {
        return;
    }
    const mount = jQuery(`#${contentId}`);
    if (!mount.length) {
        uiState.orchEditorPopupContentId = '';
        return;
    }
    mount.html(buildOrchestrationEditorPopupPanelHtml(getOrchestratorUiTemplateDeps(), context, settings));
}

async function openOrchestrationEditorPopup(context, settings) {
    ensureStyles(UI_BLOCK_ID);
    const contentId = `luker_orch_editor_popup_mount_${Date.now()}`;
    uiState.orchEditorPopupContentId = contentId;
    const popupHtml = `<div id="${contentId}"></div>`;
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('Orchestrator'),
        {
            okButton: i18n('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );
    refreshOrchestrationEditorPopup(context, settings);
    await popupPromise;
    if (uiState.orchEditorPopupContentId === contentId) {
        uiState.orchEditorPopupContentId = '';
    }
}

function updateUiStatus(text) {
    jQuery('#luker_orch_status').text(String(text || ''));
}

function showRunInfoToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeRunInfoToast) {
        toastr.clear(activeRunInfoToast);
        activeRunInfoToast = null;
    }
    activeRunInfoToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeRunInfoToast && typeof onStop === 'function') {
        const toastBody = activeRunInfoToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearRunInfoToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearRunInfoToast() {
    if (typeof toastr === 'undefined' || !activeRunInfoToast) {
        return;
    }
    toastr.clear(activeRunInfoToast);
    activeRunInfoToast = null;
}

function showAiBuildToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeAiBuildToast) {
        toastr.clear(activeAiBuildToast);
        activeAiBuildToast = null;
    }
    activeAiBuildToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeAiBuildToast && typeof onStop === 'function') {
        const toastBody = activeAiBuildToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearAiBuildToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearAiBuildToast() {
    if (typeof toastr === 'undefined' || !activeAiBuildToast) {
        return;
    }
    toastr.clear(activeAiBuildToast);
    activeAiBuildToast = null;
}

async function persistCopiedProfileTarget(context, settings, mode, scope) {
    const normalizedMode = normalizeExecutionMode(mode);
    const normalizedScope = scope === 'character' ? 'character' : 'global';
    const avatar = String(getCurrentAvatar(context) || '').trim();

    if (normalizedMode === ORCH_EXECUTION_MODE_AGENDA) {
        if (normalizedScope === 'character') {
            if (!avatar) {
                notifyError(i18n('No character selected.'));
                return false;
            }
            const ok = await persistCharacterAgendaEditor(context, settings, avatar, {
                editor: uiState.characterAgendaEditor,
                forceEnabled: true,
            });
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return false;
            }
            uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
            ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
            setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
            updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            return true;
        }
        await persistGlobalAgendaEditorFrom(settings, uiState.globalAgendaEditor);
        uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
        ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
        updateUiStatus(i18n('Saved to global profile.'));
        return true;
    }

    if (normalizedScope === 'character') {
        if (!avatar) {
            notifyError(i18n('No character selected.'));
            return false;
        }
        const ok = await persistCharacterEditor(context, settings, avatar, {
            editor: uiState.characterEditor,
            forceEnabled: true,
        });
        if (!ok) {
            notifyError(i18n('Failed to persist character override.'));
            return false;
        }
        uiState.characterEditor = loadCharacterEditorState(context, avatar);
        ensureEditorIntegrity(uiState.characterEditor);
        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
        updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
        return true;
    }

    await persistGlobalEditorFrom(settings, uiState.globalEditor);
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
    updateUiStatus(i18n('Saved to global profile.'));
    return true;
}

function parseImportedProfilePayload(rawText) {
    let parsed = null;
    try {
        parsed = JSON.parse(String(rawText || ''));
    } catch {
        throw new Error(i18n('Invalid profile file format.'));
    }
    const profile = parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object'
        ? parsed.profile
        : parsed;
    const mode = normalizeExecutionMode(parsed?.mode || profile?.mode);
    const spec = sanitizeSpec(profile?.spec);
    const presets = sanitizePresetMap(profile?.presets);
    if (Array.isArray(spec?.stages) && spec.stages.length > 0 && presets && Object.keys(presets).length > 0) {
        return { mode: ORCH_EXECUTION_MODE_SPEC, spec, presets };
    }

    const agendaProfile = profile?.agenda && typeof profile.agenda === 'object'
        ? profile.agenda
        : profile;
    const agents = sanitizePresetMap(agendaProfile?.agents);
    const isAgendaPayload = mode === ORCH_EXECUTION_MODE_AGENDA
        || String(parsed?.format || '') === PORTABLE_PROFILE_FORMAT_V2
        || String(parsed?.format || '') === 'luker_orchestrator_agenda_profile_v1';
    if (isAgendaPayload && Object.keys(agents).length > 0) {
        return {
            mode: ORCH_EXECUTION_MODE_AGENDA,
            agenda: sanitizeAgendaWorkingProfile(agendaProfile),
        };
    }

    throw new Error(i18n('Invalid profile file format.'));
}

function downloadJsonFile(fileName, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = String(fileName || 'orchestration-profile.json');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function pickJsonFileText() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files?.[0] || null;
            input.remove();
            if (!file) {
                resolve(null);
                return;
            }
            try {
                const text = await file.text();
                resolve(text);
            } catch (error) {
                reject(error);
            }
        }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

function chooseProfileScopeByConfirm(context, confirmKey) {
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (avatar) {
        return window.confirm(i18n(confirmKey)) ? 'global' : 'character';
    }
    if (!window.confirm(i18n('No character selected. Use global profile?'))) {
        return null;
    }
    return 'global';
}

function isPresetUsed(editor, presetId) {
    return isPresetReferencedInSpec(editor?.spec, presetId);
}

function isPresetReferencedInSpec(spec, presetId) {
    const targetPresetId = sanitizeIdentifierToken(presetId, '');
    if (!targetPresetId) {
        return false;
    }
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    return stages.some(stage =>
        (stage?.nodes || []).some(node => {
            const normalizedNode = normalizeNodeSpec(node);
            const nodePresetId = sanitizeIdentifierToken(normalizedNode?.preset || normalizedNode?.id, '');
            return nodePresetId === targetPresetId;
        }));
}

function trimAiIterationMessages(session) {
    if (!session) {
        return;
    }
    if (!Array.isArray(session.messages)) {
        session.messages = [];
    }
}

function stringifyIterationSimulationForPrompt(simulation) {
    if (!simulation || typeof simulation !== 'object') {
        return '(none)';
    }
    try {
        return JSON.stringify({
            ok: Boolean(simulation.ok),
            summary: String(simulation.summary || ''),
            detail: simulation.detail && typeof simulation.detail === 'object' ? simulation.detail : {},
        });
    } catch {
        return String(simulation.summary || '(simulation)');
    }
}

function stringifyIterationSimulationListForPrompt(simulations) {
    const list = Array.isArray(simulations) ? simulations : [];
    if (list.length === 0) {
        return '(none)';
    }
    try {
        return JSON.stringify(list.map(item => ({
            ok: Boolean(item?.ok),
            summary: String(item?.summary || ''),
            detail: item?.detail && typeof item.detail === 'object' ? item.detail : {},
        })));
    } catch {
        return list.map(item => String(item?.summary || '(simulation)')).join('\n');
    }
}

function buildAiIterationAutoContinuePrompt(executionResult) {
    const simulationText = stringifyIterationSimulationListForPrompt(executionResult?.simulations);
    return [
        'AUTO CONTINUE',
        'Previous tool execution is complete. Review the result and continue iteration.',
        '',
        buildFriendlyIterationExecutionSummary(executionResult),
        '',
        '<simulation_results>',
        simulationText,
        '</simulation_results>',
        '',
        'If all requested work is complete, call luker_orch_finalize_iteration.',
        'Otherwise, emit the next focused tool calls.',
    ].join('\n');
}

function cloneWorkingProfileFromEditor(editor) {
    ensureEditorIntegrity(editor);
    return {
        spec: sanitizeSpec(serializeEditorSpec(editor.spec)),
        presets: sanitizePresetMap(serializeEditorPresetMap(editor.presets)),
    };
}

function createIterationEditorFromWorkingProfile(workingProfile) {
    const safeSpec = sanitizeSpec(workingProfile?.spec);
    const safePresets = sanitizePresetMap(workingProfile?.presets);
    return {
        spec: toEditableSpec(safeSpec, toEditablePresetMap(safePresets)),
        presets: toEditablePresetMap(safePresets),
    };
}

function isAgendaIterationSession(session) {
    return String(session?.mode || '') === ORCH_EXECUTION_MODE_AGENDA;
}

function cloneAiIterationWorkingProfile(mode, workingProfile) {
    if (String(mode || '') === ORCH_EXECUTION_MODE_AGENDA) {
        return sanitizeAgendaWorkingProfile(structuredClone(workingProfile || {}));
    }
    return {
        spec: sanitizeSpec(structuredClone(workingProfile?.spec || { stages: [] })),
        presets: sanitizePresetMap(structuredClone(workingProfile?.presets || {})),
    };
}

function getAiIterationDiffObjectHash(obj, index = 0) {
    if (!obj || typeof obj !== 'object') {
        return `${typeof obj}:${String(obj)}`;
    }
    const id = sanitizeIdentifierToken(obj.id, '');
    if (id) {
        return `id:${id}`;
    }
    const name = normalizeText(obj.name || '');
    if (name) {
        return `name:${name}`;
    }
    const preset = sanitizeIdentifierToken(obj.preset, '');
    if (preset) {
        return `preset:${preset}`;
    }
    const fallback = JSON.stringify(obj);
    return fallback || `index:${index}`;
}

const aiIterationDiffPatcher = createDiffPatcher({
    objectHash: getAiIterationDiffObjectHash,
    arrays: {
        detectMove: true,
        includeValueOnMove: false,
    },
    textDiff: {
        minLength: ORCH_ITERATION_DIFF_TEXT_MIN_LENGTH,
        diffMatchPatch: DiffMatchPatch,
    },
    cloneDiffValues: true,
});

function cloneAiIterationProfileDelta(delta) {
    if (!delta || typeof delta !== 'object') {
        return null;
    }
    return structuredClone(delta);
}

function buildAiIterationProfileDeltaPayload(mode, beforeProfile, afterProfile) {
    const safeBefore = cloneAiIterationWorkingProfile(mode, beforeProfile);
    const safeAfter = cloneAiIterationWorkingProfile(mode, afterProfile);
    const delta = aiIterationDiffPatcher.diff(safeBefore, safeAfter);
    const normalizedDelta = cloneAiIterationProfileDelta(delta);
    return {
        beforeProfile: safeBefore,
        afterProfile: safeAfter,
        delta: normalizedDelta,
        reverseDelta: normalizedDelta ? cloneAiIterationProfileDelta(reverseDiffDelta(normalizedDelta)) : null,
    };
}

function sanitizeAiIterationProfileDiffHtml(html) {
    return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

function renderAiIterationProfileDeltaHtml(mode, delta, beforeProfile) {
    const normalizedDelta = cloneAiIterationProfileDelta(delta);
    if (!normalizedDelta) {
        return '';
    }
    try {
        const safeBefore = cloneAiIterationWorkingProfile(mode, beforeProfile);
        const safeAfter = cloneAiIterationWorkingProfile(mode, safeBefore);
        aiIterationDiffPatcher.patch(safeAfter, cloneAiIterationProfileDelta(normalizedDelta));
        const html = renderObjectDiffHtml({
            before: safeBefore,
            after: safeAfter,
            delta: normalizedDelta,
            beforeLabel: i18n('Before'),
            afterLabel: i18n('After'),
            missingLabel: i18n('(missing)'),
            renderTextDiff: renderIterationLineDiffHtml,
        });
        return sanitizeAiIterationProfileDiffHtml(html);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to render iteration profile delta`, error);
        return '';
    }
}

function ensureAiIterationSessionBaseWorkingProfile(session) {
    if (!session || typeof session !== 'object') {
        return;
    }
    if (!session.baseWorkingProfile || typeof session.baseWorkingProfile !== 'object') {
        session.baseWorkingProfile = cloneAiIterationWorkingProfile(session.mode, session.workingProfile);
    }
}

function restoreAiIterationSessionStateFromMessages(session) {
    if (!session || typeof session !== 'object') {
        return;
    }
    ensureAiIterationSessionBaseWorkingProfile(session);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const snapshotMessage = [...messages].reverse().find(item => item?.profileSnapshotAfter && typeof item.profileSnapshotAfter === 'object');
    session.workingProfile = cloneAiIterationWorkingProfile(
        session.mode,
        snapshotMessage?.profileSnapshotAfter || session.baseWorkingProfile,
    );
    session.lastSimulation = snapshotMessage?.lastSimulationAfter
        ? structuredClone(snapshotMessage.lastSimulationAfter)
        : null;
    const pendingMessage = [...messages].reverse().find(item => String(item?.toolState || '').trim().toLowerCase() === 'pending');
    const fallbackPendingExecutionCalls = pendingMessage ? buildExecutionToolCalls(normalizePersistentToolCalls(pendingMessage)) : [];
    const fallbackPendingSplit = pendingMessage ? splitAiIterationToolCallsForApproval(fallbackPendingExecutionCalls) : { approvalCalls: [] };
    session.pendingApproval = pendingMessage
        ? {
            messageId: String(pendingMessage?.id || ''),
            assistantText: String(pendingMessage?.content || ''),
            toolCalls: Array.isArray(pendingMessage?.pendingToolCalls)
                ? structuredClone(pendingMessage.pendingToolCalls)
                : fallbackPendingSplit.approvalCalls,
            executionToolCalls: Array.isArray(pendingMessage?.executionToolCalls)
                ? structuredClone(pendingMessage.executionToolCalls)
                : fallbackPendingExecutionCalls,
            createdAt: Number(pendingMessage?.at || Date.now()),
        }
        : null;
    session.updatedAt = Date.now();
}

function normalizeAiIterationSessionMessage(mode, rawMessage) {
    const role = String(rawMessage?.role || 'assistant').trim().toLowerCase();
    const message = {
        id: String(rawMessage?.id || '').trim() || makeAiIterationMessageId(),
        role: role === 'user' ? 'user' : 'assistant',
        content: String(rawMessage?.content || ''),
        auto: Boolean(rawMessage?.auto),
        at: Number(rawMessage?.at || Date.now()),
    };

    if (message.role === 'assistant') {
        const toolCalls = normalizePersistentToolCalls(rawMessage);
        const toolResults = normalizePersistentToolResults(rawMessage, toolCalls);
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }
        if (toolResults.length > 0) {
            message.tool_results = toolResults;
        }
        if (rawMessage?.toolSummary) {
            message.toolSummary = String(rawMessage.toolSummary || '');
        }
        if (rawMessage?.toolState) {
            message.toolState = String(rawMessage.toolState || '');
        }
        if (Array.isArray(rawMessage?.pendingToolCalls)) {
            message.pendingToolCalls = buildExecutionToolCalls(rawMessage.pendingToolCalls);
        }
        if (Array.isArray(rawMessage?.executionToolCalls)) {
            message.executionToolCalls = buildExecutionToolCalls(rawMessage.executionToolCalls);
        }
        if (rawMessage?.profileSnapshotBefore && typeof rawMessage.profileSnapshotBefore === 'object') {
            message.profileSnapshotBefore = cloneAiIterationWorkingProfile(mode, rawMessage.profileSnapshotBefore);
        }
        if (rawMessage?.profileDelta && typeof rawMessage.profileDelta === 'object') {
            message.profileDelta = cloneAiIterationProfileDelta(rawMessage.profileDelta);
        }
        if (rawMessage?.reverseProfileDelta && typeof rawMessage.reverseProfileDelta === 'object') {
            message.reverseProfileDelta = cloneAiIterationProfileDelta(rawMessage.reverseProfileDelta);
        }
        if (rawMessage?.profileSnapshotAfter && typeof rawMessage.profileSnapshotAfter === 'object') {
            message.profileSnapshotAfter = cloneAiIterationWorkingProfile(mode, rawMessage.profileSnapshotAfter);
        }
        if (rawMessage?.lastSimulationAfter && typeof rawMessage.lastSimulationAfter === 'object') {
            message.lastSimulationAfter = structuredClone(rawMessage.lastSimulationAfter);
        }
    }

    return message;
}

function normalizeAiIterationStoredSession(rawSession) {
    const mode = normalizeExecutionMode(rawSession?.mode) || ORCH_EXECUTION_MODE_SPEC;
    const baseWorkingProfile = cloneAiIterationWorkingProfile(
        mode,
        rawSession?.baseWorkingProfile || rawSession?.workingProfile,
    );
    const session = {
        id: String(rawSession?.id || '').trim() || `session_${Date.now()}`,
        mode,
        chatKey: String(rawSession?.chatKey || '').trim(),
        sourceScope: String(rawSession?.sourceScope || '').trim() === 'character' ? 'character' : 'global',
        sourceAvatar: String(rawSession?.sourceAvatar || '').trim(),
        sourceName: String(rawSession?.sourceName || '').trim(),
        revision: Math.max(1, Math.floor(Number(rawSession?.revision) || 1)),
        createdAt: Number(rawSession?.createdAt || Date.now()),
        updatedAt: Number(rawSession?.updatedAt || rawSession?.createdAt || Date.now()),
        workingProfile: cloneAiIterationWorkingProfile(mode, rawSession?.workingProfile || baseWorkingProfile),
        baseWorkingProfile,
        messages: (Array.isArray(rawSession?.messages) ? rawSession.messages : [])
            .map(item => normalizeAiIterationSessionMessage(mode, item)),
        lastSimulation: rawSession?.lastSimulation && typeof rawSession.lastSimulation === 'object'
            ? structuredClone(rawSession.lastSimulation)
            : null,
        pendingApproval: null,
    };
    restoreAiIterationSessionStateFromMessages(session);
    return session;
}

function createEmptyAiIterationHistoryState() {
    return {
        version: ORCH_CHARACTER_ITERATION_HISTORY_VERSION,
        sessions: [],
    };
}

function normalizeAiIterationHistoryState(rawState) {
    if (Number(rawState?.version || 0) !== ORCH_CHARACTER_ITERATION_HISTORY_VERSION) {
        return createEmptyAiIterationHistoryState();
    }
    const sessions = (Array.isArray(rawState?.sessions) ? rawState.sessions : [])
        .map(session => normalizeAiIterationStoredSession(session))
        .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    return {
        version: ORCH_CHARACTER_ITERATION_HISTORY_VERSION,
        sessions: sessions.slice(-ORCH_CHARACTER_ITERATION_HISTORY_LIMIT),
    };
}

function replaceAiIterationSession(targetSession, sourceSession) {
    if (!targetSession || typeof targetSession !== 'object') {
        return sourceSession;
    }
    const normalized = normalizeAiIterationStoredSession(sourceSession);
    for (const key of Object.keys(targetSession)) {
        delete targetSession[key];
    }
    Object.assign(targetSession, normalized);
    return targetSession;
}

function upsertAiIterationHistorySession(historyState, session) {
    const normalizedState = normalizeAiIterationHistoryState(historyState);
    const normalizedSession = normalizeAiIterationStoredSession(session);
    const nextSessions = normalizedState.sessions.filter(item => String(item?.id || '') !== String(normalizedSession.id || ''));
    nextSessions.push(normalizedSession);
    nextSessions.sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    normalizedState.sessions = nextSessions.slice(-ORCH_CHARACTER_ITERATION_HISTORY_LIMIT);
    return normalizedState;
}

function deleteAiIterationHistorySession(historyState, sessionId) {
    const normalizedState = normalizeAiIterationHistoryState(historyState);
    const targetId = String(sessionId || '').trim();
    normalizedState.sessions = normalizedState.sessions.filter(item => String(item?.id || '') !== targetId);
    return normalizedState;
}

function findAiIterationHistorySession(historyState, sessionId) {
    const targetId = String(sessionId || '').trim();
    if (!targetId) {
        return null;
    }
    return (Array.isArray(historyState?.sessions) ? historyState.sessions : [])
        .find(item => String(item?.id || '') === targetId) || null;
}

function getAiIterationHistorySessionsByMode(historyState, mode) {
    const targetMode = normalizeExecutionMode(mode) || ORCH_EXECUTION_MODE_SPEC;
    return (Array.isArray(historyState?.sessions) ? historyState.sessions : [])
        .filter(item => (normalizeExecutionMode(item?.mode) || ORCH_EXECUTION_MODE_SPEC) === targetMode);
}

function findAiIterationHistorySessionByMode(historyState, sessionId, mode) {
    const targetId = String(sessionId || '').trim();
    if (!targetId) {
        return null;
    }
    return getAiIterationHistorySessionsByMode(historyState, mode)
        .find(item => String(item?.id || '') === targetId) || null;
}

function findLatestAiIterationHistorySessionByMode(historyState, mode) {
    const sessions = getAiIterationHistorySessionsByMode(historyState, mode);
    return sessions.length > 0 ? sessions[sessions.length - 1] : null;
}

async function loadAiIterationHistoryState(context, avatar) {
    const raw = await getCharacterState(avatar, ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE);
    return normalizeAiIterationHistoryState(raw || createEmptyAiIterationHistoryState());
}

async function persistAiIterationHistoryState(context, avatar, historyState) {
    await setCharacterState(
        avatar,
        ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE,
        normalizeAiIterationHistoryState(historyState),
    );
}

function loadGlobalAiIterationHistoryState() {
    ensureSettings();
    return normalizeAiIterationHistoryState(extension_settings?.[MODULE_NAME]?.[ORCH_GLOBAL_ITERATION_HISTORY_KEY]);
}

async function persistGlobalAiIterationHistoryState(historyState) {
    ensureSettings();
    extension_settings[MODULE_NAME][ORCH_GLOBAL_ITERATION_HISTORY_KEY] = normalizeAiIterationHistoryState(historyState);
    saveSettingsDebounced();
}

async function loadAiIterationHistoryStateForScope(context, { scope = 'global', avatar = '' } = {}) {
    if (String(scope || '').trim() === 'character' && String(avatar || '').trim()) {
        return await loadAiIterationHistoryState(context, avatar);
    }
    return loadGlobalAiIterationHistoryState();
}

async function persistAiIterationHistoryStateForScope(context, historyState, { scope = 'global', avatar = '' } = {}) {
    if (String(scope || '').trim() === 'character' && String(avatar || '').trim()) {
        await persistAiIterationHistoryState(context, avatar, historyState);
        return;
    }
    await persistGlobalAiIterationHistoryState(historyState);
}

function summarizeAiIterationHistorySession(session, fallback = '') {
    const firstUserMessage = (Array.isArray(session?.messages) ? session.messages : [])
        .find(item => String(item?.role || '').trim().toLowerCase() === 'user');
    const summary = String(firstUserMessage?.content || '').trim() || String(session?.sourceName || '').trim() || String(fallback || '').trim();
    return summary.length > 72
        ? `${summary.slice(0, 72).trim()}...`
        : summary;
}

function getAiIterationRollbackStartIndex(messages, messageIndex) {
    const index = asFiniteInteger(messageIndex, -1);
    const list = Array.isArray(messages) ? messages : [];
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
        return -1;
    }
    let removeFrom = index;
    const previous = removeFrom > 0 ? list[removeFrom - 1] : null;
    if (String(list[removeFrom]?.role || '').trim().toLowerCase() === 'assistant'
        && String(previous?.role || '').trim().toLowerCase() === 'user') {
        removeFrom -= 1;
    }
    return removeFrom;
}

function createAiIterationSession(context, settings) {
    if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
        syncCharacterEditorWithActiveAvatar(context);
        const scope = getIterationDefaultScope(context);
        const editor = getAgendaEditorByScope(scope);
        const avatar = String(getCurrentAvatar(context) || '').trim();
        const sourceName = scope === 'character'
            ? (getCharacterDisplayNameByAvatar(context, avatar) || avatar || i18n('(No character card)'))
            : i18n('Global profile');
        const workingProfile = cloneAgendaWorkingProfileFromEditor(editor);
        return {
            id: `session_${Date.now()}`,
            mode: ORCH_EXECUTION_MODE_AGENDA,
            chatKey: getChatKey(context),
            sourceScope: scope,
            sourceAvatar: avatar,
            sourceName,
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            workingProfile,
            baseWorkingProfile: cloneAiIterationWorkingProfile(ORCH_EXECUTION_MODE_AGENDA, workingProfile),
            messages: [],
            lastSimulation: null,
            pendingApproval: null,
        };
    }
    syncCharacterEditorWithActiveAvatar(context);
    const scope = getIterationDefaultScope(context);
    const editor = getEditorByScope(scope);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    const sourceName = scope === 'character'
        ? (getCharacterDisplayNameByAvatar(context, avatar) || avatar || i18n('(No character card)'))
        : i18n('Global profile');
    const workingProfile = cloneWorkingProfileFromEditor(editor);
    return {
        id: `session_${Date.now()}`,
        chatKey: getChatKey(context),
        sourceScope: scope,
        sourceAvatar: avatar,
        sourceName,
        mode: ORCH_EXECUTION_MODE_SPEC,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workingProfile,
        baseWorkingProfile: cloneAiIterationWorkingProfile(ORCH_EXECUTION_MODE_SPEC, workingProfile),
        messages: [],
        lastSimulation: null,
        pendingApproval: null,
    };
}

function ensureAiIterationSession(context, settings, { forceNew = false } = {}) {
    if (!uiState.aiIterationSession || forceNew) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    if (String(uiState.aiIterationSession.mode || ORCH_EXECUTION_MODE_SPEC) !== getExecutionMode(settings)) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    const currentChatKey = getChatKey(context);
    if (String(uiState.aiIterationSession.chatKey || '') !== String(currentChatKey || '')) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    ensureAiIterationSessionBaseWorkingProfile(uiState.aiIterationSession);
    return uiState.aiIterationSession;
}

function summarizeStageForUi(stage) {
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    const nodeSummary = nodes.map((node) => {
        const type = normalizeNodeType(node?.type);
        return `${String(node?.id || '')}→${String(node?.preset || '')}${type === ORCH_NODE_TYPE_REVIEW ? ' [review]' : ''}`;
    }).filter(Boolean).join(' | ');
    return {
        id: String(stage?.id || ''),
        mode: String(stage?.mode || 'serial') === 'parallel' ? 'parallel' : 'serial',
        nodeSummary,
    };
}

const ITERATION_MESSAGE_FOLD_CHAR_THRESHOLD = 1200;
const ITERATION_MESSAGE_FOLD_LINE_THRESHOLD = 18;

function isIterationMessageLikelySimulationContext(text) {
    const source = String(text || '');
    if (!source) {
        return false;
    }
    return source.includes('<simulation_results>')
        || source.includes('"all_stage_outputs"')
        || source.includes('"final_stage_id"')
        || source.includes('AUTO CONTINUE')
        || source.includes('Previous tool execution is complete. Review the result and continue iteration.');
}

function renderAiIterationMessageBodyHtml(content, { auto = false } = {}) {
    const text = stripIterationThoughtForDisplay(content || '');
    if (!text) {
        return escapeHtml('(empty)');
    }
    const lineCount = text.split('\n').length;
    const simulationLike = isIterationMessageLikelySimulationContext(text);
    const tooLong = text.length > ITERATION_MESSAGE_FOLD_CHAR_THRESHOLD || lineCount > ITERATION_MESSAGE_FOLD_LINE_THRESHOLD;
    const shouldFold = simulationLike || tooLong;
    if (!shouldFold) {
        return escapeHtml(text);
    }

    const summary = simulationLike && auto
        ? i18n('Auto simulation context (folded)')
        : i18nFormat('Long message (${0} chars)', text.length);
    const preview = text.slice(0, 280).trim();

    return `
<details class="luker-studio-msg-folded">
    <summary>${escapeHtml(summary)}</summary>
    ${preview ? `<div class="luker-studio-msg-preview"><b>${escapeHtml(i18n('Preview'))}:</b> ${escapeHtml(preview)}${text.length > preview.length ? ' ...' : ''}</div>` : ''}
    <div class="luker-studio-msg-full">${escapeHtml(text)}</div>
</details>`;
}

function findPreviousAiIterationUserMessageIndex(messages, startIndex) {
    const list = Array.isArray(messages) ? messages : [];
    const index = Math.min(list.length - 1, Math.max(-1, Math.floor(Number(startIndex) || -1)));
    for (let i = index - 1; i >= 0; i--) {
        if (String(list[i]?.role || '').trim().toLowerCase() === 'user') {
            return i;
        }
    }
    return -1;
}

function canRefreshAiIterationAssistantMessage(session, messageIndex) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    const index = Math.floor(Number(messageIndex));
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        return false;
    }
    const item = items[index];
    if (String(item?.role || '').trim().toLowerCase() !== 'assistant') {
        return false;
    }
    if (Boolean(item?.auto)) {
        return false;
    }
    return findPreviousAiIterationUserMessageIndex(items, index) >= 0;
}

function canRollbackAiIterationAssistantMessage(session, messageIndex) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    const index = Math.floor(Number(messageIndex));
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
        return false;
    }
    const item = items[index];
    if (String(item?.role || '').trim().toLowerCase() !== 'assistant') {
        return false;
    }
    if (String(item?.toolState || '').trim().toLowerCase() !== 'completed') {
        return false;
    }
    return Boolean(item?.profileDelta && typeof item.profileDelta === 'object')
        && Boolean(item?.profileSnapshotAfter && typeof item.profileSnapshotAfter === 'object');
}

function renderAiIterationMessageDiffHtml(session, item, messageIndex) {
    const toolState = String(item?.toolState || '').trim().toLowerCase();
    if (toolState === 'pending') {
        return '';
    }
    const profileDeltaHtml = item?.profileDelta
        ? renderAiIterationProfileDeltaHtml(session?.mode, item.profileDelta, item?.profileSnapshotBefore || session?.workingProfile)
        : '';
    if (!profileDeltaHtml) {
        return '';
    }
    const summaryLabel = toolState === 'completed'
        ? i18n('Applied changes diff')
        : (toolState === 'rejected' ? i18n('Rejected changes diff') : i18n('Pending changes diff'));
    const rollbackAction = canRollbackAiIterationAssistantMessage({ messages: [item] }, 0)
        ? `
    <div class="luker-studio-msg-actions">
        <div class="menu_button menu_button_small" data-luker-orch-action="rollback-message" data-luker-orch-message-index="${messageIndex}">${escapeHtml(i18n('Rollback round'))}</div>
    </div>`
        : '';
    return `
<details class="luker-studio-pending-diff"${toolState === 'pending' ? ' open' : ''}>
    <summary>${escapeHtml(summaryLabel)}</summary>
    <div class="luker-studio-diff">
        ${profileDeltaHtml}
    </div>
    ${rollbackAction}
</details>`;
}

function renderAiIterationSessionHistory(historyState, activeSessionId = '', modeFilter = '') {
    const sessions = getAiIterationHistorySessionsByMode(historyState, modeFilter).slice().reverse();
    if (sessions.length === 0) {
        return `<div class="luker-studio-empty">${escapeHtml(i18n('No saved sessions yet.'))}</div>`;
    }
    return `<div class="luker-studio-history-list">${sessions.map((session) => {
        const sessionId = String(session?.id || '').trim();
        const isActive = sessionId && sessionId === String(activeSessionId || '').trim();
        const modeLabel = String(session?.mode || '').trim() === ORCH_EXECUTION_MODE_AGENDA ? 'Agenda' : 'Spec';
        const summary = summarizeAiIterationHistorySession(session, session?.sourceName || '');
        const meta = [
            modeLabel,
            `${Array.isArray(session?.messages) ? session.messages.length : 0} msgs`,
            new Date(Number(session?.updatedAt || session?.createdAt || Date.now())).toLocaleString(),
        ].join(' · ');
        return `
<div class="luker-studio-history-item${isActive ? ' active' : ''}">
    <div class="luker-studio-history-item-main">
        <div class="luker-studio-history-item-summary">${escapeHtml(summary || '(session)')}</div>
        <div class="luker-studio-history-item-time">${escapeHtml(meta)}</div>
    </div>
    <div class="luker-studio-history-item-actions">
        ${isActive ? `<div class="menu_button menu_button_small disabled">${escapeHtml(i18n('Current session'))}</div>` : `<div class="menu_button menu_button_small" data-luker-orch-action="load-session" data-luker-orch-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Load session'))}</div>`}
        <div class="menu_button menu_button_small" data-luker-orch-action="delete-session" data-luker-orch-session-id="${escapeHtml(sessionId)}">${escapeHtml(i18n('Delete session'))}</div>
    </div>
</div>`;
    }).join('')}</div>`;
}

function renderAiIterationConversation(session, { loading = false, loadingText = '' } = {}) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    if (items.length === 0 && !loading) {
        return `<div class="luker-studio-empty">${escapeHtml(i18n('No messages yet. Start by telling AI what you want to optimize.'))}</div>`;
    }
    const html = items.map((item, index) => {
        const role = String(item?.role || 'assistant').toLowerCase();
        const auto = Boolean(item?.auto);
        const label = auto ? 'AUTO' : (role === 'user' ? 'You' : 'AI');
        const dataRole = role === 'user' ? 'user' : 'assistant';
        const bodyHtml = renderAiIterationMessageBodyHtml(item?.content || '', { auto });
        const toolSummary = String(item?.toolSummary || '').trim();
        const actionButtons = [];
        if (canRefreshAiIterationAssistantMessage(session, index)) {
            actionButtons.push(`<div class="menu_button menu_button_small" data-luker-orch-action="refresh-message" data-luker-orch-message-index="${index}">${escapeHtml(i18n('Regenerate'))}</div>`);
        }
        const actionsHtml = actionButtons.length > 0
            ? `<div class="luker-studio-msg-actions">${actionButtons.join('')}</div>`
            : '';
        const diffHtml = role === 'assistant'
            ? renderAiIterationMessageDiffHtml(session, item, index)
            : '';
        return `
<div class="luker-studio-msg" data-role="${dataRole}">
    <div class="luker-studio-msg-head">${escapeHtml(label)}</div>
    <div class="luker-studio-msg-body">${bodyHtml}</div>
    ${diffHtml}
    ${toolSummary ? `<div class="luker-studio-msg-meta">${escapeHtml(toolSummary)}</div>` : ''}
    ${actionsHtml}
</div>`;
    }).join('');
    if (!loading) {
        return html;
    }
    const label = String(loadingText || i18n('AI iteration is running...'));
    return `${html}
<div class="luker-studio-msg loading" data-role="assistant">
    <div class="luker-studio-msg-body"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(label)}</div>
</div>`;
}

const AI_ITERATION_EDITABLE_TOOL_NAMES = new Set([
    'luker_orch_set_stage',
    'luker_orch_remove_stage',
    'luker_orch_set_node',
    'luker_orch_remove_node',
    'luker_orch_set_preset',
    'luker_orch_remove_preset',
    'luker_orch_set_agenda_planner',
    'luker_orch_set_agenda_planner_prompt',
    'luker_orch_set_agenda_agent',
    'luker_orch_remove_agenda_agent',
    'luker_orch_set_agenda_final_agent',
    'luker_orch_set_agenda_limits',
]);

function isAiIterationEditableToolCallName(name) {
    return AI_ITERATION_EDITABLE_TOOL_NAMES.has(String(name || '').trim());
}

function splitAiIterationToolCallsForApproval(toolCalls) {
    const all = Array.isArray(toolCalls) ? toolCalls : [];
    const approvalCalls = [];
    for (const call of all) {
        const name = String(call?.name || '').trim();
        if (isAiIterationEditableToolCallName(name)) {
            approvalCalls.push(call);
            continue;
        }
    }
    return {
        allCalls: all,
        approvalCalls,
    };
}

function summarizeIterationToolCalls(toolCalls) {
    const counts = {
        stage_set: 0,
        stage_remove: 0,
        node_set: 0,
        node_remove: 0,
        preset_set: 0,
        preset_remove: 0,
        agenda_planner: 0,
        agenda_agent_set: 0,
        agenda_agent_remove: 0,
        agenda_final_agent: 0,
        agenda_limits: 0,
        other: 0,
    };
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (name === 'luker_orch_set_stage') counts.stage_set += 1;
        else if (name === 'luker_orch_remove_stage') counts.stage_remove += 1;
        else if (name === 'luker_orch_set_node') counts.node_set += 1;
        else if (name === 'luker_orch_remove_node') counts.node_remove += 1;
        else if (name === 'luker_orch_set_preset') counts.preset_set += 1;
        else if (name === 'luker_orch_remove_preset') counts.preset_remove += 1;
        else if (name === 'luker_orch_set_agenda_planner' || name === 'luker_orch_set_agenda_planner_prompt') counts.agenda_planner += 1;
        else if (name === 'luker_orch_set_agenda_agent') counts.agenda_agent_set += 1;
        else if (name === 'luker_orch_remove_agenda_agent') counts.agenda_agent_remove += 1;
        else if (name === 'luker_orch_set_agenda_final_agent') counts.agenda_final_agent += 1;
        else if (name === 'luker_orch_set_agenda_limits') counts.agenda_limits += 1;
        else counts.other += 1;
    }
    const lines = [];
    if (counts.stage_set > 0) lines.push(`更新阶段 ${counts.stage_set}`);
    if (counts.stage_remove > 0) lines.push(`删除阶段 ${counts.stage_remove}`);
    if (counts.node_set > 0) lines.push(`更新节点 ${counts.node_set}`);
    if (counts.node_remove > 0) lines.push(`删除节点 ${counts.node_remove}`);
    if (counts.preset_set > 0) lines.push(`更新预设 ${counts.preset_set}`);
    if (counts.preset_remove > 0) lines.push(`删除预设 ${counts.preset_remove}`);
    if (counts.agenda_planner > 0) lines.push(`更新 agenda planner ${counts.agenda_planner}`);
    if (counts.agenda_agent_set > 0) lines.push(`更新 agenda agents ${counts.agenda_agent_set}`);
    if (counts.agenda_agent_remove > 0) lines.push(`删除 agenda agents ${counts.agenda_agent_remove}`);
    if (counts.agenda_final_agent > 0) lines.push(`更新 agenda final agent ${counts.agenda_final_agent}`);
    if (counts.agenda_limits > 0) lines.push(`更新 agenda 限制 ${counts.agenda_limits}`);
    if (counts.other > 0) lines.push(`其他操作 ${counts.other}`);
    return lines;
}

function stripIterationThoughtForDisplay(value) {
    const text = String(value ?? '');
    if (!text) {
        return '';
    }
    const withoutBlocks = text.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '');
    const withoutTags = withoutBlocks.replace(/<\/?thought\b[^>]*>/gi, '');
    return withoutTags.replace(/\n{3,}/g, '\n\n').trim();
}

function closeOrchExpandedDiff(rootElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    if (!(root instanceof HTMLElement)) {
        return;
    }
    root.querySelectorAll('.luker_orch_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());
}

function openOrchExpandedDiff(rootElement, triggerElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    const trigger = triggerElement instanceof Element ? triggerElement : null;
    const diffRoot = trigger?.closest?.('.luker_orch_line_diff');
    const diffBody = diffRoot?.querySelector?.('.luker_orch_line_diff_pre');
    if (!(root instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
        return;
    }

    closeOrchExpandedDiff(root);

    const diffLabel = String(diffBody.getAttribute('data-luker-orch-diff-label') || i18n('Line diff'));
    const closeLabel = escapeHtml(i18n('Close expanded diff'));
    const overlay = document.createElement('div');
    overlay.className = 'luker_orch_line_diff_zoom_overlay';
    overlay.innerHTML = `
<div class="luker_orch_line_diff_zoom_backdrop" data-luker-orch-action="close-line-diff-zoom"></div>
<div class="luker_orch_line_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="luker_orch_line_diff_zoom_header">
        <div class="luker_orch_line_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_zoom_close" data-luker-orch-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="luker_orch_line_diff_zoom_body"></div>
</div>`;

    const zoomBody = overlay.querySelector('.luker_orch_line_diff_zoom_body');
    if (zoomBody instanceof HTMLElement) {
        zoomBody.append(diffBody.cloneNode(true));
    }

    root.append(overlay);
}

function beginOrchLineDiffResize(splitterElement, pointerEvent) {
    const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
    const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
    const dual = splitter?.closest?.('.luker_orch_line_diff_dual');
    if (!(splitter instanceof HTMLElement) || !(pointer instanceof PointerEvent) || !(dual instanceof HTMLElement)) {
        return;
    }

    pointer.preventDefault();
    pointer.stopPropagation();

    const bounds = dual.getBoundingClientRect();
    if (!Number.isFinite(bounds.width) || bounds.width <= 0) {
        return;
    }

    const minPercent = 15;
    const maxPercent = 85;
    const pointerId = pointer.pointerId;

    const applySplitAt = (clientX) => {
        const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
        const clampedPercent = Math.max(minPercent, Math.min(maxPercent, nextPercent));
        dual.style.setProperty('--luker-orch-split-left', `${clampedPercent}%`);
    };

    const cleanup = () => {
        splitter.classList.remove('active');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        try {
            splitter.releasePointerCapture(pointerId);
        } catch {
            // Ignore release errors when capture was not acquired.
        }
    };

    const handlePointerMove = (moveEvent) => {
        if (!(moveEvent instanceof PointerEvent) || moveEvent.pointerId !== pointerId) {
            return;
        }
        moveEvent.preventDefault();
        applySplitAt(moveEvent.clientX);
    };

    const handlePointerUp = (upEvent) => {
        if (!(upEvent instanceof PointerEvent) || upEvent.pointerId !== pointerId) {
            return;
        }
        upEvent.preventDefault();
        cleanup();
    };

    splitter.classList.add('active');
    applySplitAt(pointer.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    try {
        splitter.setPointerCapture(pointerId);
    } catch {
        // Pointer capture may fail in some browsers and is optional here.
    }
}

function buildAgendaIterationPendingDiffState(session, pending) {
    const entries = [];
    const workingProfile = sanitizeAgendaWorkingProfile(session?.workingProfile);

    for (const call of Array.isArray(pending?.toolCalls) ? pending.toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const item = {
            name,
            summary: '',
            fields: [],
            rawArgs: args,
        };

        if (name === 'luker_orch_set_agenda_planner' || name === 'luker_orch_set_agenda_planner_prompt') {
            const beforePlanner = createAgendaPlannerDraft(workingProfile.planner);
            const afterPlanner = createAgendaPlannerDraft({
                ...beforePlanner,
                ...(Object.prototype.hasOwnProperty.call(args, 'systemPrompt')
                    ? { systemPrompt: String(args.systemPrompt || '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'userPromptTemplate') || Object.prototype.hasOwnProperty.call(args, 'plannerPrompt')
                    ? { userPromptTemplate: String(args.userPromptTemplate ?? args.plannerPrompt ?? '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            item.summary = 'Agenda planner updated';
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforePlanner.systemPrompt),
                after: formatDiffValue(afterPlanner.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforePlanner.userPromptTemplate),
                after: formatDiffValue(afterPlanner.userPromptTemplate),
            });
            item.fields.push({
                label: 'apiPresetName',
                before: formatDiffValue(getPresetApiPresetName(beforePlanner)),
                after: formatDiffValue(getPresetApiPresetName(afterPlanner)),
            });
            item.fields.push({
                label: 'promptPresetName',
                before: formatDiffValue(getPresetPromptPresetName(beforePlanner)),
                after: formatDiffValue(getPresetPromptPresetName(afterPlanner)),
            });
            workingProfile.planner = afterPlanner;
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            const beforeAgent = agentId ? structuredClone(workingProfile.agents[agentId] || null) : null;
            const afterAgent = createPresetDraft({
                ...(beforeAgent || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: String(args.userPromptTemplate || '').trim(),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            if (agentId) {
                workingProfile.agents[agentId] = afterAgent;
            }
            item.summary = agentId
                ? `Agenda agent "${agentId}" ${beforeAgent ? 'updated' : 'created'}`
                : 'Agenda agent update skipped (missing agent_id)';
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforeAgent?.systemPrompt || ''),
                after: formatDiffValue(afterAgent.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforeAgent?.userPromptTemplate || ''),
                after: formatDiffValue(afterAgent.userPromptTemplate),
            });
            item.fields.push({
                label: 'apiPresetName',
                before: formatDiffValue(getPresetApiPresetName(beforeAgent)),
                after: formatDiffValue(getPresetApiPresetName(afterAgent)),
            });
            item.fields.push({
                label: 'promptPresetName',
                before: formatDiffValue(getPresetPromptPresetName(beforeAgent)),
                after: formatDiffValue(getPresetPromptPresetName(afterAgent)),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            const existed = agentId ? structuredClone(workingProfile.agents[agentId] || null) : null;
            if (agentId && workingProfile.agents[agentId]) {
                delete workingProfile.agents[agentId];
            }
            const normalized = sanitizeAgendaWorkingProfile(workingProfile);
            workingProfile.planner = normalized.planner;
            workingProfile.agents = normalized.agents;
            workingProfile.finalAgentId = normalized.finalAgentId;
            workingProfile.limits = normalized.limits;
            item.summary = agentId
                ? `Agenda agent "${agentId}" ${existed ? 'removed' : 'remove skipped'}`
                : 'Agenda agent removal skipped (missing agent_id)';
            item.fields.push({
                label: 'result',
                before: existed ? 'exists' : '',
                after: existed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_agenda_final_agent') {
            const nextAgentId = sanitizeIdentifierToken(args.agent_id, '');
            item.summary = nextAgentId
                ? 'Agenda final agent updated'
                : 'Agenda final agent update skipped (missing agent_id)';
            item.fields.push({
                label: 'finalAgentId',
                before: formatDiffValue(workingProfile.finalAgentId),
                after: formatDiffValue(nextAgentId),
            });
            if (nextAgentId) {
                workingProfile.finalAgentId = nextAgentId;
            }
            const normalized = sanitizeAgendaWorkingProfile(workingProfile);
            workingProfile.finalAgentId = normalized.finalAgentId;
            workingProfile.agents = normalized.agents;
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_agenda_limits') {
            const nextLimits = {
                plannerMaxRounds: args.planner_max_rounds ?? workingProfile.limits.plannerMaxRounds,
                maxConcurrentAgents: args.max_concurrent_agents ?? workingProfile.limits.maxConcurrentAgents,
                maxTotalRuns: args.max_total_runs ?? workingProfile.limits.maxTotalRuns,
            };
            const normalized = sanitizeAgendaWorkingProfile({
                ...workingProfile,
                limits: nextLimits,
            });
            item.summary = 'Agenda runtime limits updated';
            item.fields.push({
                label: 'plannerMaxRounds',
                before: formatDiffValue(String(workingProfile.limits.plannerMaxRounds)),
                after: formatDiffValue(String(normalized.limits.plannerMaxRounds)),
            });
            item.fields.push({
                label: 'maxConcurrentAgents',
                before: formatDiffValue(String(workingProfile.limits.maxConcurrentAgents)),
                after: formatDiffValue(String(normalized.limits.maxConcurrentAgents)),
            });
            item.fields.push({
                label: 'maxTotalRuns',
                before: formatDiffValue(String(workingProfile.limits.maxTotalRuns)),
                after: formatDiffValue(String(normalized.limits.maxTotalRuns)),
            });
            workingProfile.limits = normalized.limits;
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_simulate') {
            item.summary = 'Run simulation';
            item.fields.push({
                label: 'simulation_text',
                before: '',
                after: formatDiffValue(args.simulation_text || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_finalize_iteration') {
            item.summary = 'Finalize iteration';
            item.fields.push({
                label: 'summary',
                before: '',
                after: formatDiffValue(args.summary || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_continue_iteration') {
            item.summary = 'Continue iteration';
            item.fields.push({
                label: 'note',
                before: '',
                after: formatDiffValue(args.note || ''),
            });
            entries.push(item);
            continue;
        }
    }

    return {
        entries,
        projectedProfile: sanitizeAgendaWorkingProfile(workingProfile),
    };
}

function buildAiIterationPendingDiffState(session, pending) {
    if (isAgendaIterationSession(session)) {
        return buildAgendaIterationPendingDiffState(session, pending);
    }
    const entries = [];
    const workingProfile = structuredClone(session?.workingProfile || { spec: { stages: [] }, presets: {} });
    const stages = Array.isArray(workingProfile?.spec?.stages) ? workingProfile.spec.stages : [];
    const presets = (workingProfile?.presets && typeof workingProfile.presets === 'object') ? workingProfile.presets : {};
    const pendingPresetRemovalEntries = new Map();

    for (const call of Array.isArray(pending?.toolCalls) ? pending.toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (!isAiIterationEditableToolCallName(name)) {
            continue;
        }
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const item = {
            name,
            summary: '',
            fields: [],
            rawArgs: args,
        };

        if (name === 'luker_orch_set_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            if (!stageId) {
                item.summary = 'Stage update skipped (missing stage_id)';
                entries.push(item);
                continue;
            }
            const before = stages.find(stage => String(stage?.id || '') === stageId) || null;
            const beforeMode = before ? String(before.mode || 'serial') : '';
            const beforePosition = before ? stages.findIndex(stage => String(stage?.id || '') === stageId) : -1;

            let target = before;
            if (!target) {
                target = { id: stageId, mode, nodes: [] };
                stages.push(target);
            }
            target.mode = mode;
            const afterPositionTarget = stages.findIndex(stage => String(stage?.id || '') === stageId);
            applyIndexReorder(stages, afterPositionTarget, Number.isInteger(args.position) ? Number(args.position) : NaN);
            const afterPosition = stages.findIndex(stage => String(stage?.id || '') === stageId);

            item.summary = stageId
                ? `Stage "${stageId}" ${before ? 'updated' : 'created'}`
                : 'Stage updated';
            item.fields.push({ label: 'mode', before: formatDiffValue(beforeMode), after: formatDiffValue(mode) });
            if (beforePosition !== afterPosition && beforePosition >= 0 && afterPosition >= 0) {
                item.fields.push({ label: 'position', before: String(beforePosition), after: String(afterPosition) });
            }
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            if (!stageId) {
                item.summary = 'Stage removal skipped (missing stage_id)';
                entries.push(item);
                continue;
            }
            const index = stages.findIndex(stage => String(stage?.id || '') === stageId);
            const removed = index >= 0 ? structuredClone(stages[index]) : null;
            if (index >= 0) {
                stages.splice(index, 1);
            }
            item.summary = stageId
                ? `Stage "${stageId}" ${removed ? 'removed' : 'remove skipped'}`
                : 'Stage remove requested';
            item.fields.push({
                label: 'result',
                before: removed ? 'exists' : '',
                after: removed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                item.summary = 'Node update skipped (missing stage_id or node_id)';
                entries.push(item);
                continue;
            }
            const stage = resolveIterationStage({ workingProfile }, stageId, true);
            if (!stage) {
                item.summary = `Node "${nodeId}" update skipped (stage "${stageId}" invalid)`;
                entries.push(item);
                continue;
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            stage.nodes = nodes;
            const existingIndex = nodes.findIndex(node => String(node?.id || '') === nodeId);
            const beforeNode = existingIndex >= 0 ? structuredClone(nodes[existingIndex]) : null;
            const presetId = sanitizeIdentifierToken(args.preset, nodeId || 'distiller') || 'distiller';
            const nextNodeType = typeof args.type === 'string'
                ? normalizeNodeType(args.type)
                : normalizeNodeType(beforeNode?.type);
            const afterUserPromptTemplate = typeof args.userPromptTemplate === 'string'
                ? normalizeTemplateForRuntime(args.userPromptTemplate)
                : (beforeNode ? String(beforeNode.userPromptTemplate || '') : '');
            const nextNode = {
                id: nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: afterUserPromptTemplate,
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
            }

            item.summary = `Node "${nodeId}" in stage "${stageId}" ${beforeNode ? 'updated' : 'created'}`;
            item.fields.push({
                label: 'preset',
                before: formatDiffValue(beforeNode?.preset || ''),
                after: formatDiffValue(presetId),
            });
            item.fields.push({
                label: 'type',
                before: formatDiffValue(normalizeNodeType(beforeNode?.type)),
                after: formatDiffValue(nextNodeType),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforeNode?.userPromptTemplate || ''),
                after: formatDiffValue(afterUserPromptTemplate),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                item.summary = 'Node removal skipped (missing stage_id or node_id)';
                entries.push(item);
                continue;
            }
            const stage = resolveIterationStage({ workingProfile }, stageId, false);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const index = nodes.findIndex(node => String(node?.id || '') === nodeId);
            const removed = index >= 0 ? structuredClone(nodes[index]) : null;
            if (index >= 0) {
                nodes.splice(index, 1);
            }
            item.summary = `Node "${nodeId}" in stage "${stageId}" ${removed ? 'removed' : 'remove skipped'}`;
            item.fields.push({
                label: 'result',
                before: removed ? 'exists' : '',
                after: removed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                item.summary = 'Preset update skipped (missing preset_id)';
                entries.push(item);
                continue;
            }
            const queuedRemovalEntries = pendingPresetRemovalEntries.get(presetId) || [];
            for (const queuedItem of queuedRemovalEntries) {
                queuedItem.summary = `Preset "${presetId}" removal skipped (overridden by later preset update)`;
                queuedItem.fields = [{
                    label: 'result',
                    before: '',
                    after: 'unchanged',
                }];
            }
            pendingPresetRemovalEntries.delete(presetId);
            const beforePreset = presets[presetId] && typeof presets[presetId] === 'object'
                ? structuredClone(presets[presetId])
                : null;
            const afterPreset = createPresetDraft({
                ...(beforePreset || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            presets[presetId] = afterPreset;
            item.summary = `Preset "${presetId}" ${beforePreset ? 'updated' : 'created'}`;
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforePreset?.systemPrompt || ''),
                after: formatDiffValue(afterPreset.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforePreset?.userPromptTemplate || ''),
                after: formatDiffValue(afterPreset.userPromptTemplate),
            });
            item.fields.push({
                label: 'apiPresetName',
                before: formatDiffValue(getPresetApiPresetName(beforePreset)),
                after: formatDiffValue(getPresetApiPresetName(afterPreset)),
            });
            item.fields.push({
                label: 'promptPresetName',
                before: formatDiffValue(getPresetPromptPresetName(beforePreset)),
                after: formatDiffValue(getPresetPromptPresetName(afterPreset)),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                item.summary = 'Preset removal skipped (missing preset_id)';
                entries.push(item);
                continue;
            }
            item.summary = `Preset "${presetId}" removal requested`;
            item.fields.push({
                label: 'result',
                before: '',
                after: 'pending',
            });
            if (!pendingPresetRemovalEntries.has(presetId)) {
                pendingPresetRemovalEntries.set(presetId, []);
            }
            pendingPresetRemovalEntries.get(presetId).push(item);
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_simulate') {
            item.summary = 'Run simulation';
            item.fields.push({
                label: 'input',
                before: '',
                after: formatDiffValue(args.input || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_finalize_iteration') {
            item.summary = 'Finalize iteration';
            item.fields.push({
                label: 'summary',
                before: '',
                after: formatDiffValue(args.summary || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_continue_iteration') {
            item.summary = 'Continue iteration';
            item.fields.push({
                label: 'note',
                before: '',
                after: formatDiffValue(args.note || ''),
            });
            entries.push(item);
            continue;
        }

        item.summary = name || 'Unknown operation';
        entries.push(item);
    }

    for (const [presetId, queuedEntries] of pendingPresetRemovalEntries.entries()) {
        const presetExists = Boolean(presets[presetId] && typeof presets[presetId] === 'object');
        const inUse = isPresetReferencedInSpec(workingProfile?.spec, presetId);
        let summary = '';
        let before = '';
        let after = '';
        if (!presetExists) {
            summary = `Preset "${presetId}" remove skipped`;
            after = 'unchanged';
        } else if (inUse) {
            summary = `Preset "${presetId}" removal skipped (preset is still used by nodes)`;
            before = 'exists';
            after = 'unchanged';
        } else {
            delete presets[presetId];
            summary = `Preset "${presetId}" removed`;
            before = 'exists';
        }
        for (const queuedItem of queuedEntries) {
            queuedItem.summary = summary;
            queuedItem.fields = [{
                label: 'result',
                before,
                after,
            }];
        }
    }

    return {
        entries,
        projectedProfile: workingProfile,
    };
}

function renderAiIterationPendingApproval(session, popupId) {
    const pending = session?.pendingApproval;
    if (!pending) {
        return '';
    }
    const pendingMessage = findAiIterationMessageById(session?.messages, pending?.messageId);
    const pendingProfileDeltaHtml = pendingMessage?.profileDelta
        ? renderAiIterationProfileDeltaHtml(session?.mode, pendingMessage.profileDelta, pendingMessage?.profileSnapshotBefore || session?.workingProfile)
        : '';
    const summaryLines = summarizeIterationToolCalls(pending.toolCalls || []);
    const assistantText = stripIterationThoughtForDisplay(pending.assistantText || '');
    return `
<div class="luker-studio-pending">
    <div class="luker-studio-panel-title">${escapeHtml(i18n('Pending approval'))}</div>
    <div class="luker-studio-pending-hint">${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>
    ${assistantText ? `<div class="luker-studio-pending-text">${escapeHtml(assistantText)}</div>` : ''}
    <div class="luker-studio-pending-ops">
        ${summaryLines.length > 0 ? summaryLines.map(item => `<div class="luker-studio-pending-op">${escapeHtml(item)}</div>`).join('') : `<div class="luker-studio-pending-op">${escapeHtml(i18n('No editable operations were produced.'))}</div>`}
    </div>
    ${pendingProfileDeltaHtml ? `
    <details class="luker-studio-pending-diff" open>
        <summary>${escapeHtml(i18n('Pending changes diff'))}</summary>
        <div class="luker-studio-diff">
            ${pendingProfileDeltaHtml}
        </div>
    </details>` : ''}
    <div class="luker-studio-pending-actions">
        <div id="${popupId}_approve" class="menu_button">${escapeHtml(i18n('Approve changes'))}</div>
        <div id="${popupId}_reject" class="menu_button">${escapeHtml(i18n('Reject changes'))}</div>
    </div>
</div>`;
}

function renderAgendaIterationWorkingProfile(session, { profileOverride = null, previewPending = false } = {}) {
    const profile = sanitizeAgendaWorkingProfile(
        profileOverride && typeof profileOverride === 'object'
            ? profileOverride
            : session?.workingProfile,
    );
    const planner = createAgendaPlannerDraft(profile?.planner);
    const agentCards = Object.entries(profile?.agents || {})
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([agentId, preset]) => `
<div class="luker_orch_iter_stage">
    <div class="luker_orch_iter_stage_title">${escapeHtml(agentId)}</div>
    <div class="luker_orch_iter_stage_mode">${escapeHtml(agentId === profile.finalAgentId ? i18n('Final Agent') : i18n('Worker'))}</div>
    <div class="luker_orch_iter_preset_line"><b>API:</b> ${escapeHtml(getPresetApiPresetName(preset) || i18n('(Global orchestration API preset)'))}</div>
    <div class="luker_orch_iter_preset_line"><b>Preset:</b> ${escapeHtml(getPresetPromptPresetName(preset) || i18n('(Current preset)'))}</div>
    <div class="luker_orch_iter_stage_nodes">${escapeHtml(truncateOrchestrationRuntimePreview(preset?.systemPrompt || '', 180) || '(empty)')}</div>
</div>`).join('');
    const simulationSummary = session?.lastSimulation
        ? `${i18n('Simulation')}: ${String(session.lastSimulation.summary || '')}`
        : '';
    return `
<div class="luker_orch_iter_profile_meta">
    <div><b>${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</b></div>
    <div>${escapeHtml(`Revision #${Number(session?.revision || 1)}`)}</div>
    ${previewPending ? `<div>${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>` : ''}
    ${simulationSummary ? `<div>${escapeHtml(simulationSummary)}</div>` : ''}
</div>
<div class="luker_orch_iter_preset_line"><b>Final agent:</b> ${escapeHtml(profile.finalAgentId || '(none)')}</div>
<div class="luker_orch_iter_preset_line"><b>Planner API:</b> ${escapeHtml(getPresetApiPresetName(planner) || i18n('(Global orchestration API preset)'))}</div>
<div class="luker_orch_iter_preset_line"><b>Planner preset:</b> ${escapeHtml(getPresetPromptPresetName(planner) || i18n('(Current preset)'))}</div>
<div class="luker_orch_iter_preset_line"><b>Limits:</b> ${escapeHtml(`rounds=${profile.limits.plannerMaxRounds}, concurrent=${profile.limits.maxConcurrentAgents}, totalRuns=${profile.limits.maxTotalRuns}`)}</div>
<details class="luker_orch_iter_diff_raw" open>
    <summary>${escapeHtml(i18n('Planner system prompt'))}</summary>
    <pre>${escapeHtml(planner.systemPrompt || '')}</pre>
</details>
<details class="luker_orch_iter_diff_raw" open>
    <summary>${escapeHtml(i18n('Planner Prompt'))}</summary>
    <pre>${escapeHtml(planner.userPromptTemplate || '')}</pre>
</details>
<div class="luker_orch_iter_stage_list">${agentCards || '<div class="luker_orch_iter_empty">(no agents)</div>'}</div>`;
}

function renderAiIterationWorkingProfile(session, { profileOverride = null, previewPending = false } = {}) {
    if (isAgendaIterationSession(session)) {
        return renderAgendaIterationWorkingProfile(session, { profileOverride, previewPending });
    }
    const profile = profileOverride && typeof profileOverride === 'object'
        ? profileOverride
        : (session?.workingProfile || {});
    const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
    const stageCards = stages.map((stage) => {
        const info = summarizeStageForUi(stage);
        return `
<div class="luker_orch_iter_stage">
    <div class="luker_orch_iter_stage_title">${escapeHtml(info.id || '(stage)')}</div>
    <div class="luker_orch_iter_stage_mode">${escapeHtml(info.mode)}</div>
    <div class="luker_orch_iter_stage_nodes">${escapeHtml(info.nodeSummary || '(no nodes)')}</div>
</div>`;
    }).join('');
    const presetIds = Object.keys(profile?.presets || {}).sort();
    const presetSummary = presetIds.length > 0
        ? presetIds.map((presetId) => {
            const apiPresetName = getPresetApiPresetName(profile?.presets?.[presetId]);
            const promptPresetName = getPresetPromptPresetName(profile?.presets?.[presetId]);
            const routes = [
                apiPresetName ? `api=${apiPresetName}` : '',
                promptPresetName ? `preset=${promptPresetName}` : '',
            ].filter(Boolean);
            return routes.length > 0
                ? `${presetId} -> ${routes.join(', ')}`
                : presetId;
        }).join(', ')
        : '(none)';
    const simulationSummary = session?.lastSimulation
        ? `${i18n('Simulation')}: ${String(session.lastSimulation.summary || '')}`
        : '';
    return `
<div class="luker_orch_iter_profile_meta">
    <div><b>${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</b></div>
    <div>${escapeHtml(`Revision #${Number(session?.revision || 1)}`)}</div>
    ${previewPending ? `<div>${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>` : ''}
    ${simulationSummary ? `<div>${escapeHtml(simulationSummary)}</div>` : ''}
</div>
<div class="luker_orch_iter_stage_list">${stageCards || '<div class="luker_orch_iter_empty">(no stages)</div>'}</div>
<div class="luker_orch_iter_preset_line"><b>Presets:</b> ${escapeHtml(presetSummary)}</div>`;
}

function buildAiIterationSystemPrompt(settings, session = null) {
    const base = normalizeTemplateForAiPrompt(String(settings.aiSuggestSystemPrompt || '').trim()) || getDefaultAiSuggestSystemPrompt();
    if (isAgendaIterationSession(session)) {
        return [
            base,
            '',
            'Iteration mode contract:',
            '- You are editing an existing agenda orchestration profile incrementally.',
            '- The working profile contains a planner preset, agenda agents, finalAgentId, and runtime limits.',
            '- The planner preset and agenda agents may optionally set apiPresetName to use a specific Connection Manager profile.',
            '- Leave planner/agent apiPresetName empty unless the user explicitly asks for per-agent model/provider routing. Empty means fallback to the global orchestration API preset.',
            '- If you set planner/agent apiPresetName, use only a name from available_connection_profiles.',
            '- The planner preset and agenda agents may optionally set promptPresetName to use a specific chat completion preset.',
            '- Leave planner/agent promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing. Empty means fallback to the global orchestration chat completion preset.',
            '- If you set planner/agent promptPresetName, use only a name from available_chat_completion_presets.',
            '- Prefer targeted edits. Do not rewrite the full planner preset unless necessary.',
            '- Keep the planner preset as the main orchestration contract and keep agent prompts concrete and task-oriented.',
            '- Use luker_orch_set_agenda_planner to create or update the agenda planner preset.',
            '- Use luker_orch_set_agenda_agent to create or update one agenda agent at a time.',
            '- Use luker_orch_set_agenda_final_agent to point final output to an existing agent id.',
            '- Use luker_orch_set_agenda_limits only for real budget changes, not for stylistic edits.',
            '- If user asks to test, call luker_orch_simulate with suitable input.',
            '- If you need one more autonomous step right after current execution, call luker_orch_continue_iteration.',
            '- If you need user decision or clarification, do not call continue or finalize. Stop and wait for user.',
            '- When iteration is complete, call luker_orch_finalize_iteration.',
            '- Keep output practical and concise for real RP usage.',
        ].join('\n');
    }
    return [
        base,
        '',
        'Iteration mode contract:',
        '- You are editing an existing orchestration profile incrementally (diff-style).',
        '- Prefer targeted edits. Do not rebuild everything unless the user explicitly asks.',
        '- Think through what to change and why before issuing tool calls; output format follows the current prompt policy.',
        '- Presets may optionally set apiPresetName to use a specific Connection Manager profile.',
        '- Leave preset apiPresetName empty unless the user explicitly asks for per-agent model/provider routing. Empty means fallback to the global orchestration API preset.',
        '- If you set preset apiPresetName, use only a name from available_connection_profiles.',
        '- Presets may optionally set promptPresetName to use a specific chat completion preset.',
        '- Leave preset promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing. Empty means fallback to the global orchestration chat completion preset.',
        '- If you set preset promptPresetName, use only a name from available_chat_completion_presets.',
        `- Runtime prepends previous orchestration result and approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` before node template text; do not use placeholders for that context.`,
        '- Treat the working profile as hierarchical layers. Preserve or improve that layering when editing.',
        `- Nodes can be worker or review. Review nodes inspect only the directly adjacent previous worker layer, may rerun only specific node ids from that layer, and must emit mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\`.`,
        ...getCriticPromptReminderLines().map(line => `- ${line}`),
        `- Keep approved worker outputs as passthrough context after review; treat approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\` as supplemental refinement, not a replacement summary.`,
        '- If more than one layer needs audit, insert multiple review stages after those specific layers instead of using one late critic for everything.',
        '- Prefer dedicated serial review stages immediately after the worker stages they audit. Do not place review nodes in the final stage.',
        '- Do not create back-to-back review stages or consecutive critics with no worker layer between them.',
        `- Use luker_orch_set_node.type to set "${ORCH_NODE_TYPE_REVIEW}" when a node should behave as a reviewer.`,
        '- If user asks to test, call luker_orch_simulate with suitable input.',
        '- If you need one more autonomous step right after current execution, call luker_orch_continue_iteration.',
        '- If you need user decision or clarification, do not call continue/finalize. Stop and wait for user.',
        '- When iteration is complete, call luker_orch_finalize_iteration.',
        '- Keep output practical and concise for real RP usage.',
    ].join('\n');
}

function getGlobalIterationBaselineProfile(settings, session = null) {
    if (isAgendaIterationSession(session)) {
        return cloneAgendaWorkingProfileFromSettings(settings);
    }
    return {
        spec: sanitizeSpec(settings?.orchestrationSpec),
        presets: sanitizePresetMap(settings?.presets),
    };
}

function buildAiIterationUserPrompt(settings, session, userInputText, {
    globalProfile = null,
    sourceScope = '',
    sourceName = '',
} = {}) {
    if (isAgendaIterationSession(session)) {
        const recentConversation = (Array.isArray(session?.messages) ? session.messages : [])
            .map(item => `${String(item?.role || 'assistant').toUpperCase()}: ${String(item?.content || '')}`)
            .join('\n\n');
        const workingProfileValue = sanitizeAgendaWorkingProfile(session?.workingProfile);
        const globalProfileValue = sanitizeAgendaWorkingProfile(globalProfile);
        const latestSimulationText = stringifyIterationSimulationForPrompt(session?.lastSimulation);
        const latestSnapshotText = toReadableYamlText(normalizeOrchestrationSnapshot(getActiveSnapshot()) || {}, '{}');
        return [
            '# iteration_input',
            'You are in a multi-turn agenda orchestration iteration session.',
            'Apply focused edits through tools only. Keep edits minimal and high-impact.',
            '',
            '## source_scope',
            String(sourceScope || session?.sourceScope || 'global'),
            '',
            '## source_name',
            String(sourceName || session?.sourceName || ''),
            '',
            '## global_profile_baseline',
            '```yaml',
            toReadableYamlText(globalProfileValue, '{}'),
            '```',
            '',
            '## working_profile',
            '```yaml',
            toReadableYamlText(workingProfileValue, '{}'),
            '```',
            '',
            '## agent_api_routing',
            '```yaml',
            toReadableYamlText(buildAgentApiRoutingPromptData(settings), '{}'),
            '```',
            '',
            '## agent_prompt_preset_routing',
            '```yaml',
            toReadableYamlText(buildAgentPromptPresetRoutingPromptData(getContext(), settings), '{}'),
            '```',
            '',
            '## conversation_history',
            '```text',
            recentConversation || '(empty)',
            '```',
            '',
            '## latest_simulation',
            '```text',
            latestSimulationText,
            '```',
            '',
            '## latest_orchestration_snapshot',
            '```yaml',
            latestSnapshotText,
            '```',
            '',
            '## user_request',
            String(userInputText || '').trim(),
        ].join('\n');
    }
    const recentConversation = (Array.isArray(session?.messages) ? session.messages : [])
        .map(item => `${String(item?.role || 'assistant').toUpperCase()}: ${String(item?.content || '')}`)
        .join('\n\n');
    const workingProfileValue = {
        spec: session?.workingProfile?.spec || { stages: [] },
        presets: session?.workingProfile?.presets || {},
    };
    const globalProfileValue = {
        spec: globalProfile?.spec || { stages: [] },
        presets: globalProfile?.presets || {},
    };
    const aiVisibleWorkingProfile = sanitizeProfileForAiPrompt(workingProfileValue);
    const aiVisibleGlobalProfile = sanitizeProfileForAiPrompt(globalProfileValue);
    const latestSimulationText = stringifyIterationSimulationForPrompt(session?.lastSimulation);
    const latestSnapshotText = toReadableYamlText(normalizeOrchestrationSnapshot(getActiveSnapshot()) || {}, '{}');
    return [
        '# iteration_input',
        'You are in a multi-turn orchestration iteration session.',
        'Apply focused edits through tools only. Keep edits minimal and high-impact.',
        'If source_scope is character, treat global_profile_baseline as canonical reference and keep character edits as targeted overrides.',
        '',
        '## source_scope',
        String(sourceScope || session?.sourceScope || 'global'),
        '',
        '## source_name',
        String(sourceName || session?.sourceName || ''),
        '',
        '## global_profile_baseline',
        '```yaml',
        toReadableYamlText(aiVisibleGlobalProfile, '{}'),
        '```',
        '',
        '## working_profile',
        '```yaml',
        toReadableYamlText(aiVisibleWorkingProfile, '{}'),
        '```',
        '',
        '## agent_api_routing',
        '```yaml',
        toReadableYamlText(buildAgentApiRoutingPromptData(settings), '{}'),
        '```',
        '',
        '## agent_prompt_preset_routing',
        '```yaml',
        toReadableYamlText(buildAgentPromptPresetRoutingPromptData(getContext(), settings), '{}'),
        '```',
        '',
        '## review_node_contract',
        '```yaml',
        toReadableYamlText({
            type_field: {
                worker: ORCH_NODE_TYPE_WORKER,
                review: ORCH_NODE_TYPE_REVIEW,
            },
            runtime_behavior: `Treat review nodes as auditing only the directly adjacent previous worker layer. They request rerun only for specific node ids from that adjacent layer when needed, and must emit mandatory \`${ORCH_REVIEW_FEEDBACK_FIELD}\` on both approve and rerun decisions.`,
            downstream_behavior: `Later stages keep receiving passthrough worker outputs plus approved \`${ORCH_REVIEW_FEEDBACK_FIELD}\`; critic/review nodes do not replace them with summaries.`,
            topology_rule: 'Prefer dedicated serial review stages immediately after the workers being audited. If multiple layers need audit, add multiple review stages. Do not place review nodes in the final stage or back-to-back with another review stage.',
            ...getCriticReviewNodeContractShape(),
        }, '{}'),
        '```',
        '',
        '## conversation_history',
        '```text',
        recentConversation || '(empty)',
        '```',
        '',
        '## latest_simulation',
        '```text',
        latestSimulationText,
        '```',
        '',
        '## latest_orchestration_snapshot',
        '```yaml',
        latestSnapshotText,
        '```',
        '',
        '## user_request',
        String(userInputText || '').trim(),
    ].join('\n');
}

function buildAiIterationToolSet(session = null) {
    if (isAgendaIterationSession(session)) {
        return [
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_planner',
                    description: 'Create or update the agenda planner preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests planner-specific routing.',
                    parameters: {
                        type: 'object',
                        properties: {
                            systemPrompt: { type: 'string' },
                            userPromptTemplate: { type: 'string' },
                            apiPresetName: { type: 'string' },
                            promptPresetName: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_agent',
                    description: 'Create or update one agenda agent preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests per-agent routing.',
                    parameters: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string' },
                            systemPrompt: { type: 'string' },
                            userPromptTemplate: { type: 'string' },
                            apiPresetName: { type: 'string' },
                            promptPresetName: { type: 'string' },
                        },
                        required: ['agent_id', 'systemPrompt', 'userPromptTemplate'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_remove_agenda_agent',
                    description: 'Remove one agenda agent by id.',
                    parameters: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string' },
                        },
                        required: ['agent_id'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_final_agent',
                    description: 'Set which existing agenda agent should be used for final synthesis.',
                    parameters: {
                        type: 'object',
                        properties: {
                            agent_id: { type: 'string' },
                        },
                        required: ['agent_id'],
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_set_agenda_limits',
                    description: 'Update agenda runtime limits.',
                    parameters: {
                        type: 'object',
                        properties: {
                            planner_max_rounds: { type: 'integer' },
                            max_concurrent_agents: { type: 'integer' },
                            max_total_runs: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_simulate',
                    description: 'Run orchestration simulation against recent chat messages or a custom user message.',
                    parameters: {
                        type: 'object',
                        properties: {
                            recent_messages_n: { type: 'integer' },
                            simulation_text: { type: 'string' },
                            trigger: { type: 'string', enum: ['normal', 'regenerate', 'continue'] },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_continue_iteration',
                    description: 'Request one automatic follow-up round after current tool execution.',
                    parameters: {
                        type: 'object',
                        properties: {
                            note: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'luker_orch_finalize_iteration',
                    description: 'Finalize this iteration turn with a concise summary.',
                    parameters: {
                        type: 'object',
                        properties: {
                            summary: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                },
            },
        ];
    }
    return [
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_stage',
                description: 'Create or update one stage. Optional position can reorder it.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        mode: { type: 'string', enum: ['serial', 'parallel'] },
                        position: { type: 'integer' },
                    },
                    required: ['stage_id', 'mode'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_stage',
                description: 'Remove one stage by id.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                    },
                    required: ['stage_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_node',
                description: 'Create or update one node inside a stage. Optional position can reorder it.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        node_id: { type: 'string' },
                        preset: { type: 'string' },
                        type: { type: 'string', enum: [ORCH_NODE_TYPE_WORKER, ORCH_NODE_TYPE_REVIEW] },
                        userPromptTemplate: { type: 'string' },
                        position: { type: 'integer' },
                    },
                    required: ['stage_id', 'node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_node',
                description: 'Remove one node from a stage.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        node_id: { type: 'string' },
                    },
                    required: ['stage_id', 'node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_preset',
                description: 'Create or update one preset. Leave apiPresetName and promptPresetName empty unless the user explicitly requests per-agent routing.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                        systemPrompt: { type: 'string' },
                        userPromptTemplate: { type: 'string' },
                        apiPresetName: { type: 'string' },
                        promptPresetName: { type: 'string' },
                    },
                    required: ['preset_id', 'systemPrompt', 'userPromptTemplate'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_preset',
                description: 'Remove one preset by id. Preset in use by nodes cannot be removed.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                    },
                    required: ['preset_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_simulate',
                description: 'Run orchestration simulation against recent chat messages or a custom user message.',
                parameters: {
                    type: 'object',
                    properties: {
                        recent_messages_n: { type: 'integer' },
                        simulation_text: { type: 'string' },
                        trigger: { type: 'string', enum: ['normal', 'regenerate', 'continue'] },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_continue_iteration',
                description: 'Request one automatic follow-up round after current tool execution.',
                parameters: {
                    type: 'object',
                    properties: {
                        note: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_finalize_iteration',
                description: 'Finalize this iteration turn with a concise summary.',
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
    ];
}

function getChatMessagesForSimulation(context, recentMessagesN) {
    const all = Array.isArray(context?.chat) ? context.chat : [];
    const n = Math.max(1, Math.min(60, Math.floor(Number(recentMessagesN) || 12)));
    return normalizeWorldInfoResolverMessages(all.slice(Math.max(0, all.length - n)));
}

async function runAiIterationSimulation(context, session, args = {}, abortSignal = null) {
    await loadOrchestratorChatState(context);
    const snapshotBefore = normalizeOrchestrationSnapshot(getActiveSnapshot());
    const simulationMessages = getChatMessagesForSimulation(context, args.recent_messages_n);
    const customText = String(args.simulation_text || '').trim();
    if (customText) {
        simulationMessages.push({
            role: 'user',
            is_user: true,
            name: String(context?.name1 || 'User'),
            mes: customText,
            content: customText,
        });
    }
    if (simulationMessages.length === 0) {
        return {
            ok: false,
            summary: 'No messages available for simulation.',
            detail: {},
        };
    }
    const profile = isAgendaIterationSession(session)
        ? buildAgendaProfileForRuntime(session?.workingProfile)
        : {
            spec: sanitizeSpec(session?.workingProfile?.spec),
            presets: sanitizePresetMap(session?.workingProfile?.presets),
        };
    const payload = {
        type: String(args?.trigger || 'normal').trim().toLowerCase() || 'normal',
        coreChat: simulationMessages,
        signal: abortSignal,
        forceWorldInfoResimulate: true,
    };
    let run = null;
    try {
        run = await runOrchestration(context, payload, structuredClone(simulationMessages), profile);
    } finally {
        setActiveSnapshot(snapshotBefore ? structuredClone(snapshotBefore) : null);
    }
    if (isAgendaIterationSession(session)) {
        const agendaState = run?.agendaState && typeof run.agendaState === 'object' ? run.agendaState : {};
        return {
            ok: true,
            summary: `Simulated agenda: ${Number(agendaState?.plannerRounds || 0)} planner rounds, ${Array.isArray(agendaState?.runs) ? agendaState.runs.length : 0} runs.`,
            detail: {
                planner_rounds: Number(agendaState?.plannerRounds || 0),
                todo_count: Array.isArray(agendaState?.todos) ? agendaState.todos.length : 0,
                run_count: Array.isArray(agendaState?.runs) ? agendaState.runs.length : 0,
                final_guidance: String(agendaState?.finalGuidance || ''),
                agenda_state: agendaState,
                input: {
                    recent_messages_n: Math.max(1, Math.min(60, Math.floor(Number(args?.recent_messages_n) || 12))),
                    simulation_text_used: Boolean(customText),
                },
            },
        };
    }
    const allStageOutputs = compactStageOutputs(run?.stageOutputs || []);
    const finalStage = getFinalStageSnapshot(run?.stageOutputs || []);
    const finalNodes = Array.isArray(finalStage?.nodes) ? finalStage.nodes : [];
    return {
        ok: true,
        summary: `Simulated ${Number(run?.stageOutputs?.length || 0)} stages with ${finalNodes.length} final outputs.`,
        detail: {
            stage_count: Number(run?.stageOutputs?.length || 0),
            final_stage_id: String(finalStage?.id || ''),
            final_stage_mode: String(finalStage?.mode || 'serial'),
            all_stage_outputs: allStageOutputs,
            input: {
                recent_messages_n: Math.max(1, Math.min(60, Math.floor(Number(args?.recent_messages_n) || 12))),
                simulation_text_used: Boolean(customText),
            },
        },
    };
}

function resolveIterationStage(session, stageId, createIfMissing = false) {
    const safeId = sanitizeIdentifierToken(stageId, '');
    if (!safeId) {
        return null;
    }
    const stages = session?.workingProfile?.spec?.stages || [];
    let stage = stages.find(item => String(item?.id || '') === safeId) || null;
    if (!stage && createIfMissing) {
        stage = { id: safeId, mode: 'serial', nodes: [] };
        stages.push(stage);
    }
    return stage;
}

function applyIndexReorder(list, currentIndex, position) {
    if (!Array.isArray(list) || currentIndex < 0 || currentIndex >= list.length) {
        return;
    }
    if (!Number.isInteger(position)) {
        return;
    }
    const targetIndex = Math.max(0, Math.min(list.length - 1, position));
    if (targetIndex === currentIndex) {
        return;
    }
    const [item] = list.splice(currentIndex, 1);
    list.splice(targetIndex, 0, item);
}

function buildFriendlyIterationExecutionSummary(result) {
    const lines = [];
    const actionCount = Array.isArray(result?.actions) ? result.actions.length : 0;
    if (actionCount > 0) {
        lines.push(`已执行 ${actionCount} 项操作。`);
    }
    const simulations = Array.isArray(result?.simulations) ? result.simulations : [];
    if (simulations.length > 0) {
        for (const sim of simulations) {
            lines.push(String(sim?.summary || '模拟已执行。'));
        }
    }
    if (result?.finalizeSummary) {
        lines.push(`总结：${String(result.finalizeSummary)}`);
    }
    return lines.join('\n').trim() || '已执行。';
}

async function executeAgendaIterationToolCalls(context, session, toolCalls, abortSignal = null) {
    const actions = [];
    const simulations = [];
    const toolResults = [];
    let finalized = false;
    let finalizeSummary = '';
    let continueRequested = false;
    let changed = false;
    session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const pushToolResult = (payload) => {
            toolResults.push({
                tool_call_id: callId,
                content: serializeToolResultContent(payload),
            });
        };
        if (!name) {
            continue;
        }
        if (name === 'luker_orch_set_agenda_planner' || name === 'luker_orch_set_agenda_planner_prompt') {
            session.workingProfile.planner = createAgendaPlannerDraft({
                ...session.workingProfile.planner,
                ...(Object.prototype.hasOwnProperty.call(args, 'systemPrompt')
                    ? { systemPrompt: String(args.systemPrompt || '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'userPromptTemplate') || Object.prototype.hasOwnProperty.call(args, 'plannerPrompt')
                    ? { userPromptTemplate: String(args.userPromptTemplate ?? args.plannerPrompt ?? '').trim() }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = 'Agenda planner updated.';
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_set_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            if (!agentId) {
                const actionText = 'Skipped agenda agent update: missing agent_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const beforeAgent = session.workingProfile.agents[agentId] || null;
            session.workingProfile.agents[agentId] = createPresetDraft({
                ...(beforeAgent || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: String(args.userPromptTemplate || '').trim(),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = `Agenda agent "${agentId}" updated.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_agenda_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            if (!agentId) {
                const actionText = 'Skipped agenda agent removal: missing agent_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            if (!session.workingProfile.agents[agentId]) {
                const actionText = `Skipped agenda agent removal: "${agentId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, agent_id: agentId });
                continue;
            }
            delete session.workingProfile.agents[agentId];
            session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
            const actionText = `Agenda agent "${agentId}" removed.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_set_agenda_final_agent') {
            const agentId = sanitizeIdentifierToken(args.agent_id, '');
            if (!agentId) {
                const actionText = 'Skipped agenda final agent update: missing agent_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            session.workingProfile.finalAgentId = agentId;
            session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
            if (String(session.workingProfile.finalAgentId || '') !== agentId) {
                const actionText = `Skipped agenda final agent update: "${agentId}" is not available.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, agent_id: agentId });
                continue;
            }
            const actionText = `Agenda final agent set to "${agentId}".`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_set_agenda_limits') {
            session.workingProfile = sanitizeAgendaWorkingProfile({
                ...session.workingProfile,
                limits: {
                    plannerMaxRounds: args.planner_max_rounds ?? session.workingProfile.limits.plannerMaxRounds,
                    maxConcurrentAgents: args.max_concurrent_agents ?? session.workingProfile.limits.maxConcurrentAgents,
                    maxTotalRuns: args.max_total_runs ?? session.workingProfile.limits.maxTotalRuns,
                },
            });
            const actionText = 'Agenda runtime limits updated.';
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_simulate') {
            const simulation = await runAiIterationSimulation(context, session, args, abortSignal);
            simulations.push(simulation);
            session.lastSimulation = simulation;
            const actionText = simulation.ok
                ? `Simulation finished: ${simulation.summary}`
                : `Simulation failed: ${simulation.summary}`;
            actions.push(actionText);
            pushToolResult({
                ok: Boolean(simulation?.ok),
                action: actionText,
                simulation,
            });
            continue;
        }
        if (name === 'luker_orch_continue_iteration') {
            continueRequested = true;
            const note = String(args.note || '').trim();
            const actionText = `Continue requested.${note ? ` ${note}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                continueRequested: true,
                note,
            });
            continue;
        }
        if (name === 'luker_orch_finalize_iteration') {
            finalized = true;
            finalizeSummary = String(args.summary || '').trim();
            const actionText = `Iteration finalized.${finalizeSummary ? ` ${finalizeSummary}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                finalized: true,
                summary: finalizeSummary,
            });
            continue;
        }
        const actionText = `Ignored unknown action: ${name}`;
        actions.push(actionText);
        pushToolResult({ ok: false, ignored: true, action: actionText });
    }

    session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
    session.revision = Number(session.revision || 0) + (changed ? 1 : 0);
    session.updatedAt = Date.now();
    trimAiIterationMessages(session);

    return {
        actions,
        simulations,
        toolResults,
        finalized,
        finalizeSummary,
        continueRequested,
        changed,
    };
}

async function executeAiIterationToolCalls(context, session, toolCalls, abortSignal = null) {
    if (isAgendaIterationSession(session)) {
        return executeAgendaIterationToolCalls(context, session, toolCalls, abortSignal);
    }
    const actions = [];
    const simulations = [];
    const toolResults = [];
    let finalized = false;
    let finalizeSummary = '';
    let continueRequested = false;
    let changed = false;
    const allowedPresetFallback = Object.keys(session?.workingProfile?.presets || {})[0] || 'distiller';
    const pendingPresetRemovalActions = new Map();
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const pushToolResult = (payload) => {
            toolResults.push({
                tool_call_id: callId,
                content: serializeToolResultContent(payload),
            });
        };
        if (!name) {
            continue;
        }
        if (name === 'luker_orch_set_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            if (!stageId) {
                const actionText = 'Skipped stage update: missing stage_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            const stage = resolveIterationStage(session, stageId, true);
            stage.mode = mode;
            if (!Array.isArray(stage.nodes)) {
                stage.nodes = [];
            }
            const stages = session.workingProfile.spec.stages;
            const index = stages.findIndex(item => String(item?.id || '') === stageId);
            applyIndexReorder(stages, index, Number.isInteger(args.position) ? Number(args.position) : NaN);
            const actionText = `Stage "${stageId}" updated (${mode}).`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId, mode });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const stages = session?.workingProfile?.spec?.stages || [];
            const index = stages.findIndex(item => String(item?.id || '') === stageId);
            if (index >= 0) {
                stages.splice(index, 1);
                const actionText = `Stage "${stageId}" removed.`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId });
                changed = true;
            } else {
                const actionText = `Skipped stage removal: "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, stage_id: stageId });
            }
            continue;
        }
        if (name === 'luker_orch_set_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                const actionText = 'Skipped node update: missing stage_id or node_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const stage = resolveIterationStage(session, stageId, true);
            const presetId = sanitizeIdentifierToken(args.preset, nodeId || allowedPresetFallback) || allowedPresetFallback;
            if (!session.workingProfile.presets[presetId]) {
                session.workingProfile.presets[presetId] = createPresetDraft();
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            const existingIndex = nodes.findIndex(item => String(item?.id || '') === nodeId);
            const nextNodeType = typeof args.type === 'string'
                ? normalizeNodeType(args.type)
                : normalizeNodeType(existingIndex >= 0 ? nodes[existingIndex]?.type : ORCH_NODE_TYPE_WORKER);
            const nextNode = {
                id: nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: typeof args.userPromptTemplate === 'string'
                    ? normalizeTemplateForRuntime(args.userPromptTemplate)
                    : (existingIndex >= 0 ? String(nodes[existingIndex]?.userPromptTemplate || '') : ''),
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
                const actionText = `Node "${nodeId}" updated in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({
                    ok: true,
                    changed: true,
                    action: actionText,
                    stage_id: stageId,
                    node_id: nodeId,
                    preset_id: presetId,
                });
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
                const actionText = `Node "${nodeId}" added to stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({
                    ok: true,
                    changed: true,
                    action: actionText,
                    stage_id: stageId,
                    node_id: nodeId,
                    preset_id: presetId,
                });
            }
            stage.nodes = nodes;
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            const stage = resolveIterationStage(session, stageId, false);
            if (!stage || !Array.isArray(stage.nodes)) {
                const actionText = `Skipped node removal: stage "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, stage_id: stageId, node_id: nodeId });
                continue;
            }
            const index = stage.nodes.findIndex(item => String(item?.id || '') === nodeId);
            if (index >= 0) {
                stage.nodes.splice(index, 1);
                const actionText = `Node "${nodeId}" removed from stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId, node_id: nodeId });
                changed = true;
            } else {
                const actionText = `Skipped node removal: "${nodeId}" not found in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, stage_id: stageId, node_id: nodeId });
            }
            continue;
        }
        if (name === 'luker_orch_set_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                const actionText = 'Skipped preset update: missing preset_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText });
                continue;
            }
            const queuedRemovalActionIndexes = pendingPresetRemovalActions.get(presetId) || [];
            for (const actionIndex of queuedRemovalActionIndexes) {
                if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                    const actionText = `Skipped preset removal: "${presetId}" overridden by later preset update.`;
                    actions[actionIndex] = actionText;
                    if (toolResults[actionIndex]) {
                        toolResults[actionIndex].content = serializeToolResultContent({
                            ok: false,
                            error: actionText,
                            preset_id: presetId,
                        });
                    }
                }
            }
            pendingPresetRemovalActions.delete(presetId);
            const beforePreset = session.workingProfile.presets[presetId] || null;
            session.workingProfile.presets[presetId] = createPresetDraft({
                ...(beforePreset || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = `Preset "${presetId}" updated.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, preset_id: presetId });
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                const actionText = `Skipped preset removal: "${presetId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: actionText, preset_id: presetId });
                continue;
            }
            if (!pendingPresetRemovalActions.has(presetId)) {
                pendingPresetRemovalActions.set(presetId, []);
            }
            const actionText = `Preset "${presetId}" removal requested.`;
            actions.push(actionText);
            pendingPresetRemovalActions.get(presetId).push(actions.length - 1);
            pushToolResult({ ok: true, action: actionText, preset_id: presetId });
            continue;
        }
        if (name === 'luker_orch_simulate') {
            const simulation = await runAiIterationSimulation(context, session, args, abortSignal);
            simulations.push(simulation);
            session.lastSimulation = simulation;
            const actionText = simulation.ok
                ? `Simulation finished: ${simulation.summary}`
                : `Simulation failed: ${simulation.summary}`;
            actions.push(actionText);
            pushToolResult({
                ok: Boolean(simulation?.ok),
                action: actionText,
                simulation,
            });
            continue;
        }
        if (name === 'luker_orch_continue_iteration') {
            continueRequested = true;
            const note = String(args.note || '').trim();
            const actionText = `Continue requested.${note ? ` ${note}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                continueRequested: true,
                note,
            });
            continue;
        }
        if (name === 'luker_orch_finalize_iteration') {
            finalized = true;
            finalizeSummary = String(args.summary || '').trim();
            const actionText = `Iteration finalized.${finalizeSummary ? ` ${finalizeSummary}` : ''}`;
            actions.push(actionText);
            pushToolResult({
                ok: true,
                action: actionText,
                finalized: true,
                summary: finalizeSummary,
            });
            continue;
        }
        const actionText = `Ignored unknown action: ${name}`;
        actions.push(actionText);
        pushToolResult({ ok: false, ignored: true, action: actionText });
    }

    for (const [presetId, actionIndexes] of pendingPresetRemovalActions.entries()) {
        const presetExists = Boolean(session?.workingProfile?.presets?.[presetId]);
        const inUse = isPresetReferencedInSpec(session?.workingProfile?.spec, presetId);
        let message = '';
        if (!presetExists) {
            message = `Skipped preset removal: "${presetId}" not found.`;
        } else if (inUse) {
            message = `Skipped preset removal: "${presetId}" is still used by nodes.`;
        } else {
            delete session.workingProfile.presets[presetId];
            message = `Preset "${presetId}" removed.`;
            changed = true;
        }
        for (const actionIndex of actionIndexes) {
            if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                actions[actionIndex] = message;
                if (toolResults[actionIndex]) {
                    toolResults[actionIndex].content = serializeToolResultContent({
                        ok: !message.startsWith('Skipped'),
                        action: message,
                        ...(message.startsWith('Skipped') ? { error: message } : { changed: true }),
                        preset_id: presetId,
                    });
                }
            }
        }
    }

    session.workingProfile.spec = sanitizeSpec(session.workingProfile.spec);
    session.workingProfile.presets = sanitizePresetMap(session.workingProfile.presets);
    session.revision = Number(session.revision || 0) + (changed ? 1 : 0);
    session.updatedAt = Date.now();
    trimAiIterationMessages(session);

    return {
        actions,
        simulations,
        toolResults,
        finalized,
        finalizeSummary,
        continueRequested,
        changed,
    };
}

async function runAiIterationTurn(context, settings, session, userText, abortSignal = null, { auto = false, appendUserMessage = true } = {}) {
    const text = String(userText || '').trim();
    if (!text) {
        return { ok: false, message: 'empty_input' };
    }
    if (appendUserMessage) {
        session.messages.push({ role: 'user', content: text, auto: Boolean(auto), at: Date.now() });
        trimAiIterationMessages(session);
    }

    const apiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const llmPresetName = String(settings.aiSuggestPresetName || '').trim();
    const tools = buildAiIterationToolSet(session);
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const globalBaseline = getGlobalIterationBaselineProfile(settings, session);
    const beforeWorkingProfile = cloneAiIterationWorkingProfile(session?.mode, session?.workingProfile);

    const runtimeWorldInfo = await resolveOrchestrationRuntimeWorldInfo(context, settings, {
        worldInfoMessages: session.messages,
        runtimeWorldInfo: null,
        forceWorldInfoResimulate: false,
        worldInfoType: 'quiet',
        abortSignal,
    });
    const taskMessages = [
        { role: 'system', content: buildAiIterationSystemPrompt(settings, session) },
        ...buildPersistentToolHistoryMessages(session.messages),
        {
            role: 'user',
            content: buildAiIterationUserPrompt(settings, session, text, {
                globalProfile: globalBaseline,
                sourceScope: String(session?.sourceScope || ''),
                sourceName: String(session?.sourceName || ''),
            }),
        },
    ];
    const detailed = await requestToolCallsWithRetry(context, settings, {
        taskMessages,
        runtimeWorldInfo,
        apiPresetName,
        llmPresetName,
        tools,
        allowedNames,
        abortSignal,
        includeAssistantText: true,
        allowNoToolCalls: true,
        applyAgentTimeout: false,
    });
    const executionToolCalls = buildExecutionToolCalls(Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : []);
    const assistantText = stripIterationThoughtForDisplay(detailed?.assistantText || '');
    if (executionToolCalls.length === 0) {
        if (assistantText) {
            session.messages.push({
                role: 'assistant',
                content: assistantText,
                auto: Boolean(auto),
                at: Date.now(),
            });
            trimAiIterationMessages(session);
            session.pendingApproval = null;
            session.updatedAt = Date.now();
            return { ok: true, pending: false, textOnly: true };
        }
        throw new Error(i18n('Function output is invalid.'));
    }
    const split = splitAiIterationToolCallsForApproval(executionToolCalls);
    const persistentToolCalls = buildPersistentToolCallsFromRawCalls(split.allCalls);
    const visibleAssistantText = assistantText || buildToolCallSummary(persistentToolCalls);
    if (split.approvalCalls.length > 0) {
        const pendingSummary = i18n('AI suggested changes are waiting for approval.');
        const pendingDiffState = buildAiIterationPendingDiffState(session, {
            toolCalls: split.approvalCalls,
        });
        const pendingDiffPayload = buildAiIterationProfileDeltaPayload(
            session?.mode,
            beforeWorkingProfile,
            pendingDiffState.projectedProfile,
        );
        const assistantMessage = createPersistentToolTurnMessage({
            messageId: makeAiIterationMessageId(),
            assistantText: visibleAssistantText,
            toolCalls: persistentToolCalls,
            toolResults: buildPendingToolResults(persistentToolCalls, pendingSummary),
            toolSummary: pendingSummary,
            toolState: 'pending',
            auto: Boolean(auto),
            at: Date.now(),
            extra: {
                pendingToolCalls: structuredClone(split.approvalCalls),
                executionToolCalls: structuredClone(split.allCalls),
                profileSnapshotBefore: pendingDiffPayload.beforeProfile,
                profileDelta: pendingDiffPayload.delta,
                reverseProfileDelta: pendingDiffPayload.reverseDelta,
            },
        });
        session.messages.push(assistantMessage);
        trimAiIterationMessages(session);
        session.pendingApproval = {
            messageId: assistantMessage.id,
            assistantText: visibleAssistantText,
            toolCalls: split.approvalCalls,
            executionToolCalls: split.allCalls,
            createdAt: Date.now(),
        };
        session.updatedAt = Date.now();
        return { ok: true, pending: true };
    }

    const executionResult = await executeAiIterationToolCalls(context, session, split.allCalls, abortSignal);
    const completedDiffPayload = buildAiIterationProfileDeltaPayload(
        session?.mode,
        beforeWorkingProfile,
        session?.workingProfile,
    );
    session.messages.push(createPersistentToolTurnMessage({
        messageId: makeAiIterationMessageId(),
        assistantText: visibleAssistantText,
        toolCalls: persistentToolCalls,
        toolResults: Array.isArray(executionResult?.toolResults) ? executionResult.toolResults : [],
        toolSummary: buildFriendlyIterationExecutionSummary(executionResult),
        toolState: 'completed',
        auto: Boolean(auto),
        at: Date.now(),
        extra: {
            profileSnapshotBefore: completedDiffPayload.beforeProfile,
            profileDelta: completedDiffPayload.delta,
            reverseProfileDelta: completedDiffPayload.reverseDelta,
            profileSnapshotAfter: cloneAiIterationWorkingProfile(session?.mode, session?.workingProfile),
            lastSimulationAfter: session?.lastSimulation ? structuredClone(session.lastSimulation) : null,
        },
    }));
    trimAiIterationMessages(session);
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return {
        ok: true,
        pending: false,
        autoApplied: true,
        executionResult,
    };
}

async function applyAiIterationSessionToGlobal(context, settings, session, root) {
    if (isAgendaIterationSession(session)) {
        const profile = sanitizeAgendaWorkingProfile(session?.workingProfile);
        settings.executionMode = ORCH_EXECUTION_MODE_AGENDA;
        settings.singleAgentModeEnabled = false;
        settings.agendaPlanner = createAgendaPlannerDraft(profile.planner);
        delete settings.agendaPlannerPrompt;
        settings.agendaAgents = sanitizePresetMap(profile.agents);
        settings.agendaFinalAgentId = sanitizeIdentifierToken(profile.finalAgentId, 'finalizer');
        settings.agendaPlannerMaxRounds = profile.limits.plannerMaxRounds;
        settings.agendaMaxConcurrentAgents = profile.limits.maxConcurrentAgents;
        settings.agendaMaxTotalRuns = profile.limits.maxTotalRuns;
        await saveSettings();
        uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
        ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
        renderDynamicPanels(root, context);
        notifySuccess(i18n('Iteration session applied to global profile.'));
        updateUiStatus(i18n('Iteration session applied to global profile.'));
        return;
    }
    settings.orchestrationSpec = sanitizeSpec(session?.workingProfile?.spec);
    settings.presets = sanitizePresetMap(session?.workingProfile?.presets);
    await saveSettings();
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    renderDynamicPanels(root, context);
    notifySuccess(i18n('Iteration session applied to global profile.'));
    updateUiStatus(i18n('Iteration session applied to global profile.'));
}

async function applyAiIterationSessionToCharacter(context, settings, session, root) {
    if (isAgendaIterationSession(session)) {
        const avatar = String(getCurrentAvatar(context) || '').trim();
        if (!avatar) {
            notifyError(i18n('No character selected. Cannot apply to character override.'));
            return;
        }
        const importedEditor = {
            ...cloneAgendaWorkingProfileFromEditor(session?.workingProfile || {}),
            enabled: true,
            notes: '',
        };
        const ok = await persistCharacterAgendaEditor(context, settings, avatar, {
            editor: importedEditor,
            forceEnabled: true,
        });
        if (!ok) {
            notifyError(i18n('Failed to persist character override.'));
            return;
        }
        uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
        ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
        renderDynamicPanels(root, context);
        const name = getCharacterDisplayNameByAvatar(context, avatar) || avatar;
        notifySuccess(i18nFormat('Iteration session applied to character override: ${0}.', name));
        updateUiStatus(i18nFormat('Iteration session applied to character override: ${0}.', name));
        return;
    }
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (!avatar) {
        notifyError(i18n('No character selected. Cannot apply to character override.'));
        return;
    }
    const importedEditor = createIterationEditorFromWorkingProfile(session?.workingProfile || {});
    const ok = await persistCharacterEditor(context, settings, avatar, {
        editor: {
            ...importedEditor,
            enabled: true,
            notes: '',
        },
        forceEnabled: true,
    });
    if (!ok) {
        notifyError(i18n('Failed to persist character override.'));
        return;
    }
    uiState.characterEditor = loadCharacterEditorState(context, avatar);
    ensureEditorIntegrity(uiState.characterEditor);
    renderDynamicPanels(root, context);
    const name = getCharacterDisplayNameByAvatar(context, avatar) || avatar;
    notifySuccess(i18nFormat('Iteration session applied to character override: ${0}.', name));
    updateUiStatus(i18nFormat('Iteration session applied to character override: ${0}.', name));
}

async function openAiIterationStudio(context, settings, root) {
    ensureStyles(UI_BLOCK_ID);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const historyScope = getIterationDefaultScope(context);
    const enableSessionHistory = true;
    let historyState = createEmptyAiIterationHistoryState();
    try {
        historyState = await loadAiIterationHistoryStateForScope(context, {
            scope: historyScope,
            avatar: activeAvatar,
        });
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load AI iteration history`, error);
    }
    const session = ensureAiIterationSession(context, settings, { forceNew: false });
    const currentIterationMode = normalizeExecutionMode(session?.mode) || getExecutionMode(settings);
    const latestSession = findLatestAiIterationHistorySessionByMode(historyState, currentIterationMode);
    if (latestSession) {
        replaceAiIterationSession(session, latestSession);
    } else {
        if (historyScope === 'character') {
            session.sourceAvatar = activeAvatar;
        }
        historyState = upsertAiIterationHistorySession(historyState, session);
        try {
            await persistAiIterationHistoryStateForScope(context, historyState, {
                scope: historyScope,
                avatar: activeAvatar,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to initialize AI iteration history`, error);
        }
    }
    uiState.aiIterationSession = session;
    const popupId = `luker_orch_iter_popup_${Date.now()}`;
    const namespace = `.lukerOrchIter_${popupId}`;
    const selector = `#${popupId}`;
    const popupHtml = buildAiIterationPopupHtml({
        escapeHtml,
        i18n,
        i18nFormat,
    }, popupId, session, {
        allowCharacterApply: Boolean(activeAvatar),
        enableSessionHistory,
    });
    let isRunning = false;

    const persistSessionHistory = async () => {
        try {
            if (historyScope === 'character') {
                session.sourceAvatar = activeAvatar;
            }
            session.updatedAt = Date.now();
            historyState = upsertAiIterationHistorySession(historyState, session);
            await persistAiIterationHistoryStateForScope(context, historyState, {
                scope: historyScope,
                avatar: activeAvatar,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to persist AI iteration history`, error);
        }
    };

    const rerender = () => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find(`#${popupId}_sub`).text(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')));
        popupRoot.find(`#${popupId}_conversation`).html(renderAiIterationConversation(session, {
            loading: isRunning,
            loadingText: i18n('AI iteration is running...'),
        }));
        popupRoot.find(`#${popupId}_pending`).html(renderAiIterationPendingApproval(session, popupId));
        popupRoot.find(`#${popupId}_profile`).html(renderAiIterationWorkingProfile(session, {
            profileOverride: null,
            previewPending: Boolean(session?.pendingApproval),
        }));
        popupRoot.find(`#${popupId}_history`).html(renderAiIterationSessionHistory(historyState, session?.id, session?.mode));
    };

    const setStatus = (text) => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find(`#${popupId}_status`).text(String(text || ''));
    };

    const resetCurrentSession = async () => {
        const nextSession = createAiIterationSession(context, settings);
        if (historyScope === 'character') {
            nextSession.sourceAvatar = activeAvatar;
        }
        replaceAiIterationSession(session, nextSession);
        uiState.aiIterationSession = session;
        await persistSessionHistory();
        rerender();
    };

    const loadSessionById = async (sessionId) => {
        const currentMode = normalizeExecutionMode(session?.mode) || getExecutionMode(settings);
        const stored = findAiIterationHistorySessionByMode(historyState, sessionId, currentMode);
        if (!stored) {
            return false;
        }
        replaceAiIterationSession(session, stored);
        uiState.aiIterationSession = session;
        await persistSessionHistory();
        rerender();
        return true;
    };

    const deleteSessionById = async (sessionId) => {
        const currentMode = normalizeExecutionMode(session?.mode) || getExecutionMode(settings);
        const stored = findAiIterationHistorySessionByMode(historyState, sessionId, currentMode);
        if (!stored) {
            return false;
        }
        historyState = deleteAiIterationHistorySession(historyState, sessionId);
        try {
            await persistAiIterationHistoryStateForScope(context, historyState, {
                scope: historyScope,
                avatar: activeAvatar,
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to delete AI iteration session`, error);
        }
        if (String(session?.id || '') === String(sessionId || '').trim()) {
            const fallback = findLatestAiIterationHistorySessionByMode(historyState, currentMode)
                || createAiIterationSession(context, settings);
            if (historyScope === 'character') {
                fallback.sourceAvatar = activeAvatar;
            }
            replaceAiIterationSession(session, fallback);
            uiState.aiIterationSession = session;
            await persistSessionHistory();
        }
        rerender();
    };

    const maybeRunAutoContinue = async (executionResult, controller, source = 'approved') => {
        if (!executionResult || typeof executionResult !== 'object') {
            return false;
        }
        if (executionResult.finalized) {
            setStatus(source === 'approved'
                ? i18n('Changes approved and applied.')
                : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        if (executionResult.continueRequested || (Array.isArray(executionResult.simulations) && executionResult.simulations.length > 0)) {
            setStatus(i18n('Running auto-continue...'));
            const autoPrompt = buildAiIterationAutoContinuePrompt(executionResult);
            const followUp = await runAiIterationTurn(context, settings, session, autoPrompt, controller.signal, {
                auto: true,
                appendUserMessage: false,
            });
            await persistSessionHistory();
            setStatus(followUp?.pending ? i18n('AI suggested changes are waiting for approval.') : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        return false;
    };

    const runVisibleIterationTurn = async (text, { appendUserMessage = true, loadingText = '' } = {}) => {
        const safeText = String(text || '').trim();
        if (!safeText) {
            return false;
        }
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return false;
        }
        const popupRoot = jQuery(selector);
        const input = popupRoot.find(`#${popupId}_input`);
        const controller = new AbortController();
        activeAiIterationAbortController = controller;
        if (appendUserMessage) {
            session.messages.push({ role: 'user', content: safeText, auto: false, at: Date.now() });
            trimAiIterationMessages(session);
            input.val('');
            await persistSessionHistory();
        }
        isRunning = true;
        rerender();
        setStatus(loadingText || i18n('AI iteration is running...'));
        try {
            const result = await runAiIterationTurn(context, settings, session, safeText, controller.signal, { appendUserMessage: false });
            await persistSessionHistory();
            if (result?.pending) {
                setStatus(i18n('AI suggested changes are waiting for approval.'));
            } else if (result?.autoApplied) {
                const didHandle = await maybeRunAutoContinue(result.executionResult, controller, 'auto');
                if (!didHandle) {
                    setStatus(i18n('AI iteration updated.'));
                }
            } else {
                setStatus(i18n('AI iteration updated.'));
            }
            rerender();
            return true;
        } catch (error) {
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
            return false;
        } finally {
            if (activeAiIterationAbortController === controller) {
                activeAiIterationAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    };

    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('AI Iteration Studio'),
        {
            okButton: i18n('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );

    jQuery(document).off(namespace);
    rerender();

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_send`, async function () {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        const input = popupRoot.find(`#${popupId}_input`);
        const text = String(input.val() || '').trim();
        if (!text) {
            return;
        }
        await runVisibleIterationTurn(text, {
            appendUserMessage: true,
            loadingText: i18n('AI iteration is running...'),
        });
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_stop`, function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            activeAiIterationAbortController.abort();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_clear`, function () {
        void (async () => {
            await resetCurrentSession();
            setStatus(i18n('Iteration session reset.'));
        })();
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        openOrchExpandedDiff(rootElement, this);
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="refresh-message"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const messageIndex = asFiniteInteger(this.getAttribute('data-luker-orch-message-index'), -1);
        if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= (session?.messages?.length || 0)) {
            return;
        }
        if (!canRefreshAiIterationAssistantMessage(session, messageIndex)) {
            return;
        }
        const userIndex = findPreviousAiIterationUserMessageIndex(session.messages, messageIndex);
        if (userIndex < 0) {
            return;
        }
        const userText = String(session.messages[userIndex]?.content || '').trim();
        session.messages.splice(messageIndex);
        restoreAiIterationSessionStateFromMessages(session);
        await persistSessionHistory();
        rerender();
        setStatus(i18n('Regenerating message...'));
        await runVisibleIterationTurn(userText, {
            appendUserMessage: false,
            loadingText: i18n('Regenerating message...'),
        });
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="rollback-message"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const messageIndex = asFiniteInteger(this.getAttribute('data-luker-orch-message-index'), -1);
        if (!canRollbackAiIterationAssistantMessage(session, messageIndex)) {
            return;
        }
        const removeFrom = getAiIterationRollbackStartIndex(session.messages, messageIndex);
        if (!Number.isInteger(removeFrom) || removeFrom < 0) {
            return;
        }
        session.messages.splice(removeFrom);
        restoreAiIterationSessionStateFromMessages(session);
        await persistSessionHistory();
        rerender();
        setStatus(i18n('Rolled back to selected round.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="close-line-diff-zoom"], ${selector} .luker_orch_line_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`keydown${namespace}`, function (event) {
        if (event.key !== 'Escape') {
            return;
        }
        const rootElement = document.querySelector(selector);
        const overlay = rootElement?.querySelector?.('.luker_orch_line_diff_zoom_overlay');
        if (!(overlay instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`pointerdown${namespace}`, `${selector} .luker_orch_line_diff_splitter`, function (event) {
        beginOrchLineDiffResize(this, event.originalEvent || event);
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_approve`, async function () {
        const pending = session?.pendingApproval;
        if (!pending) {
            return;
        }
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const controller = new AbortController();
        activeAiIterationAbortController = controller;
        isRunning = true;
        rerender();
        const pendingSnapshot = {
            messageId: String(pending.messageId || ''),
            assistantText: String(pending.assistantText || ''),
            toolCalls: Array.isArray(pending.toolCalls) ? structuredClone(pending.toolCalls) : [],
            executionToolCalls: Array.isArray(pending.executionToolCalls) ? structuredClone(pending.executionToolCalls) : [],
            createdAt: Number(pending.createdAt || Date.now()),
        };
        session.pendingApproval = null;
        rerender();
        setStatus(i18n('Applying approved changes...'));
        try {
            const executionToolCalls = pendingSnapshot.executionToolCalls.length > 0
                ? pendingSnapshot.executionToolCalls
                : pendingSnapshot.toolCalls;
            const result = await executeAiIterationToolCalls(context, session, executionToolCalls, controller.signal);
            const targetMessage = findAiIterationMessageById(session.messages, pendingSnapshot.messageId);
            if (targetMessage) {
                const completedDiffPayload = buildAiIterationProfileDeltaPayload(
                    session?.mode,
                    targetMessage?.profileSnapshotBefore || session?.baseWorkingProfile || session?.workingProfile,
                    session?.workingProfile,
                );
                targetMessage.tool_results = Array.isArray(result?.toolResults) ? result.toolResults : [];
                targetMessage.toolSummary = buildFriendlyIterationExecutionSummary(result);
                targetMessage.toolState = 'completed';
                targetMessage.profileSnapshotBefore = completedDiffPayload.beforeProfile;
                targetMessage.profileDelta = completedDiffPayload.delta;
                targetMessage.reverseProfileDelta = completedDiffPayload.reverseDelta;
                targetMessage.profileSnapshotAfter = cloneAiIterationWorkingProfile(session?.mode, session?.workingProfile);
                targetMessage.lastSimulationAfter = session?.lastSimulation ? structuredClone(session.lastSimulation) : null;
            }
            trimAiIterationMessages(session);
            await persistSessionHistory();
            const didHandle = await maybeRunAutoContinue(result, controller, 'approved');
            if (!didHandle) {
                setStatus(i18n('Changes approved and applied. Waiting for your next instruction.'));
                rerender();
            }
        } catch (error) {
            if (!session.pendingApproval) {
                session.pendingApproval = pendingSnapshot;
                rerender();
            }
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
        } finally {
            if (activeAiIterationAbortController === controller) {
                activeAiIterationAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_reject`, function () {
        if (!session?.pendingApproval) {
            return;
        }
        const pending = session.pendingApproval;
        session.pendingApproval = null;
        const targetMessage = findAiIterationMessageById(session.messages, pending?.messageId);
        if (targetMessage) {
            targetMessage.tool_results = buildRejectedToolResults(pending?.executionToolCalls || pending?.toolCalls || [], i18n('Changes rejected.'));
            targetMessage.toolSummary = i18n('Changes rejected.');
            targetMessage.toolState = 'rejected';
        }
        trimAiIterationMessages(session);
        void persistSessionHistory();
        setStatus(i18n('Changes rejected.'));
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_new_session`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        await resetCurrentSession();
        setStatus(i18n('New session created.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="load-session"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const sessionId = String(this.getAttribute('data-luker-orch-session-id') || '').trim();
        if (!sessionId) {
            return;
        }
        const loaded = await loadSessionById(sessionId);
        if (loaded) {
            setStatus(i18n('Session loaded.'));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="delete-session"]`, async function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const sessionId = String(this.getAttribute('data-luker-orch-session-id') || '').trim();
        if (!sessionId) {
            return;
        }
        if (!window.confirm(i18n('Delete this saved session?'))) {
            return;
        }
        try {
            await deleteSessionById(sessionId);
            setStatus(i18n('Session deleted.'));
        } catch (error) {
            setStatus(i18nFormat('Delete session failed: ${0}', String(error?.message || error)));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_apply_global`, async function () {
        await applyAiIterationSessionToGlobal(context, settings, session, root);
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_apply_character`, async function () {
        await applyAiIterationSessionToCharacter(context, settings, session, root);
        rerender();
    });

    await popupPromise;
    jQuery(document).off(namespace);
}

function bindUi() {
    const context = getContext();
    const settings = getSettings();

    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    initializeUiState(context);
    root.find('#luker_orch_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#luker_orch_execution_mode').val(getExecutionMode(settings));
    root.find('#luker_orch_single_agent_system_prompt').val(String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT));
    root.find('#luker_orch_single_agent_user_prompt').val(String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE));
    root.find('#luker_orch_llm_api_preset').val(String(settings.llmNodeApiPresetName || ''));
    root.find('#luker_orch_llm_preset').val(String(settings.llmNodePresetName || ''));
    root.find('#luker_orch_include_world_info').prop('checked', Boolean(settings.includeWorldInfoWithPreset));
    root.find('#luker_orch_ai_suggest_api_preset').val(String(settings.aiSuggestApiPresetName || ''));
    root.find('#luker_orch_ai_suggest_preset').val(String(settings.aiSuggestPresetName || ''));
    root.find('#luker_orch_ai_suggest_system_prompt').val(String(settings.aiSuggestSystemPrompt || ''));
    root.find('#luker_orch_max_recent_messages').val(String(settings.maxRecentMessages || 14));
    root.find('#luker_orch_node_iterations').val(String(settings.nodeIterationMaxRounds || 3));
    root.find('#luker_orch_review_reruns').val(String(settings.reviewRerunMaxRounds ?? 2));
    root.find('#luker_orch_tool_retries').val(String(settings.toolCallRetryMax ?? 2));
    root.find('#luker_orch_agent_timeout').val(String(settings.agentTimeoutSeconds ?? 0));
    root.find('#luker_orch_rpm_limit').val(settings.rpmLimit || 0);
    root.find('#luker_orch_capsule_position').val(String(Number(settings.capsuleInjectPosition)));
    root.find('#luker_orch_capsule_depth').val(String(Number(settings.capsuleInjectDepth || 0)));
    root.find('#luker_orch_capsule_role').val(String(Number(settings.capsuleInjectRole)));
    root.find('#luker_orch_capsule_custom_instruction').val(String(settings.capsuleCustomInstruction || ''));
    refreshOpenAIPresetSelectors(root, context, settings);
    renderDynamicPanels(root, context);

    root.off('.lukerOrch');
    jQuery(document).off('.lukerOrchEditor');

    root.on('input.lukerOrch', '#luker_orch_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_execution_mode', function () {
        settings.executionMode = normalizeExecutionMode(jQuery(this).val());
        settings.singleAgentModeEnabled = settings.executionMode === ORCH_EXECUTION_MODE_SINGLE;
        saveSettingsDebounced();
        renderDynamicPanels(root, context);
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_system_prompt', function () {
        settings.singleAgentSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_user_prompt', function () {
        settings.singleAgentUserPromptTemplate = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_api_preset, .luker_orch_editor_popup #luker_orch_agenda_planner_api_preset`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.apiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_prompt_preset, .luker_orch_editor_popup #luker_orch_agenda_planner_prompt_preset`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.promptPresetName = sanitizePromptPresetName(jQuery(this).val());
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_system_prompt, .luker_orch_editor_popup #luker_orch_agenda_planner_system_prompt`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.systemPrompt = String(jQuery(this).val() || '');
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_prompt, .luker_orch_editor_popup #luker_orch_agenda_planner_prompt`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.planner.userPromptTemplate = String(jQuery(this).val() || '');
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_final_agent, .luker_orch_editor_popup #luker_orch_agenda_final_agent`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.finalAgentId = sanitizeIdentifierToken(jQuery(this).val(), editor.finalAgentId || 'finalizer');
        renderDynamicPanels(root, context);
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_planner_rounds, .luker_orch_editor_popup #luker_orch_agenda_planner_rounds`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.limits.plannerMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(jQuery(this).val()) || 1)));
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_max_concurrent, .luker_orch_editor_popup #luker_orch_agenda_max_concurrent`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.limits.maxConcurrentAgents = Math.max(1, Math.min(12, Math.floor(Number(jQuery(this).val()) || 1)));
    });

    jQuery(document).on('change.lukerOrchEditor', `#${UI_BLOCK_ID} #luker_orch_agenda_max_total_runs, .luker_orch_editor_popup #luker_orch_agenda_max_total_runs`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        editor.limits.maxTotalRuns = Math.max(1, Math.min(200, Math.floor(Number(jQuery(this).val()) || 1)));
    });

    root.on('change.lukerOrch', '#luker_orch_llm_api_preset', function () {
        settings.llmNodeApiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_llm_preset', function () {
        settings.llmNodePresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_include_world_info', function () {
        settings.includeWorldInfoWithPreset = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_api_preset', function () {
        settings.aiSuggestApiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_preset', function () {
        settings.aiSuggestPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_ai_suggest_system_prompt', function () {
        settings.aiSuggestSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('click.lukerOrch', '#luker_orch_reset_ai_prompt', function () {
        if (!window.confirm(i18n('Reset AI build prompt to default? This will overwrite current AI build system prompt.'))) {
            return;
        }
        settings.aiSuggestSystemPrompt = getDefaultAiSuggestSystemPrompt();
        root.find('#luker_orch_ai_suggest_system_prompt').val(settings.aiSuggestSystemPrompt);
        saveSettingsDebounced();
        notifySuccess(i18n('Reset AI build prompt'));
    });

    root.on('change.lukerOrch', '#luker_orch_max_recent_messages', function () {
        settings.maxRecentMessages = Math.max(1, Math.min(80, Number(jQuery(this).val()) || 14));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_node_iterations', function () {
        settings.nodeIterationMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(jQuery(this).val()) || 3)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_review_reruns', function () {
        settings.reviewRerunMaxRounds = Math.max(0, Math.min(20, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_tool_retries', function () {
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_agent_timeout', function () {
        settings.agentTimeoutSeconds = Math.max(0, Math.min(3600, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_rpm_limit', function () {
        settings.rpmLimit = Math.max(0, Math.floor(Number(jQuery(this).val()) || 0));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_position', function () {
        settings.capsuleInjectPosition = normalizeCapsuleInjectPosition(jQuery(this).val());
        jQuery(this).val(String(settings.capsuleInjectPosition));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_depth', function () {
        settings.capsuleInjectDepth = Math.max(0, Math.min(10000, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_role', function () {
        const value = Number(jQuery(this).val());
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        settings.capsuleInjectRole = allowedRoles.includes(value) ? value : extension_prompt_roles.SYSTEM;
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_capsule_custom_instruction', function () {
        settings.capsuleCustomInstruction = String(jQuery(this).val() || '').trim();
        reapplyLatestCapsuleInjection(getContext());
        saveSettingsDebounced();
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-ai-goal-input], .luker_orch_editor_popup [data-luker-ai-goal-input]`, function () {
        uiState.aiGoal = String(jQuery(this).val() || '');
    });

    jQuery(document).on('input.lukerOrchEditor change.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-field], .luker_orch_editor_popup [data-luker-field]`, function () {
        const field = String(jQuery(this).data('luker-field') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);

        if (field.startsWith('stage-') && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            if (field === 'stage-id') {
                editor.spec.stages[stageIndex].id = String(jQuery(this).val() || '');
            } else if (field === 'stage-mode') {
                editor.spec.stages[stageIndex].mode = String(jQuery(this).val() || 'serial') === 'parallel' ? 'parallel' : 'serial';
            }
            return;
        }

        if (field.startsWith('node-') && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            const node = stage?.nodes?.[nodeIndex];
            if (!node) {
                return;
            }
            if (field === 'node-id') {
                node.id = String(jQuery(this).val() || '');
            } else if (field === 'node-preset') {
                node.preset = sanitizeIdentifierToken(jQuery(this).val(), pickDefaultPreset(editor));
            } else if (field === 'node-type') {
                node.type = normalizeNodeType(jQuery(this).val());
            } else if (field === 'node-template') {
                node.userPromptTemplate = String(jQuery(this).val() || '');
            }
            return;
        }

        if (field.startsWith('preset-') && presetId && editor.presets[presetId]) {
            const preset = editor.presets[presetId];
            if (field === 'preset-system-prompt') {
                preset.systemPrompt = String(jQuery(this).val() || '');
            } else if (field === 'preset-user-template') {
                preset.userPromptTemplate = String(jQuery(this).val() || '');
            } else if (field === 'preset-api-preset') {
                preset.apiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
            } else if (field === 'preset-prompt-preset') {
                preset.promptPresetName = sanitizePromptPresetName(jQuery(this).val());
            }
        }
    });

    jQuery(document).on('input.lukerOrchEditor change.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-agenda-agent-field], .luker_orch_editor_popup [data-luker-agenda-agent-field]`, function () {
        const scope = getAgendaScopeFromElement(this, context, settings);
        const editor = getAgendaEditorByScope(scope);
        ensureAgendaEditorIntegrity(editor);
        const agentId = sanitizeIdentifierToken(jQuery(this).data('agent-id'), '');
        const field = String(jQuery(this).data('luker-agenda-agent-field') || '');
        if (!agentId || !editor.agents?.[agentId]) {
            return;
        }
        if (field === 'systemPrompt') {
            editor.agents[agentId].systemPrompt = String(jQuery(this).val() || '');
        } else if (field === 'userPromptTemplate') {
            editor.agents[agentId].userPromptTemplate = String(jQuery(this).val() || '');
        } else if (field === 'apiPresetName') {
            editor.agents[agentId].apiPresetName = sanitizeConnectionProfileName(jQuery(this).val());
        } else if (field === 'promptPresetName') {
            editor.agents[agentId].promptPresetName = sanitizePromptPresetName(jQuery(this).val());
        }
    });

    jQuery(document).on('click.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-action], .luker_orch_editor_popup [data-luker-action]`, async function () {
        const action = String(jQuery(this).data('luker-action') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);
        const explicitScope = getExplicitScopeFromElement(this);

        if (action === 'agenda-copy-from-spec') {
            const copyScope = getCopyScopeFromElement(this, context);
            const agendaEditor = getAgendaEditorByScope(copyScope);
            const sourceEditor = getEditorByScope(copyScope);
            copySpecPresetsIntoAgendaEditor(sourceEditor, agendaEditor);
            setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, copyScope);
            if (!explicitScope) {
                const persisted = await persistCopiedProfileTarget(context, settings, ORCH_EXECUTION_MODE_AGENDA, copyScope);
                if (!persisted) {
                    return;
                }
            }
            notifySuccess(i18n('Copied spec agents into agenda as a starting point.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'spec-copy-from-agenda') {
            const copyScope = getCopyScopeFromElement(this, context);
            const agendaEditor = getAgendaEditorByScope(copyScope);
            const targetEditor = getEditorByScope(copyScope);
            copyAgendaAgentsIntoSpecEditor(agendaEditor, targetEditor);
            setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, copyScope);
            if (!explicitScope) {
                const persisted = await persistCopiedProfileTarget(context, settings, ORCH_EXECUTION_MODE_SPEC, copyScope);
                if (!persisted) {
                    return;
                }
            }
            notifySuccess(i18n('Copied agenda agents into spec presets and rebuilt stages as a starting point.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'agenda-agent-add') {
            const agendaScope = getAgendaScopeFromElement(this, context, settings);
            const agendaEditor = getAgendaEditorByScope(agendaScope);
            ensureAgendaEditorIntegrity(agendaEditor);
            const input = jQuery(this).closest('.luker_orch_preset_add_row').find('[data-luker-agenda-new-agent]');
            const candidate = sanitizeIdentifierToken(input.val(), '');
            if (!candidate) {
                notifyError(i18n('Preset ID cannot be empty.'));
                return;
            }
            if (agendaEditor.agents?.[candidate]) {
                notifyError(i18nFormat('Preset \'${0}\' already exists.', candidate));
                return;
            }
            agendaEditor.agents[candidate] = createPresetDraft();
            input.val('');
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'agenda-agent-delete') {
            const agendaScope = getAgendaScopeFromElement(this, context, settings);
            const agendaEditor = getAgendaEditorByScope(agendaScope);
            ensureAgendaEditorIntegrity(agendaEditor);
            const agentId = sanitizeIdentifierToken(jQuery(this).data('agent-id'), '');
            if (!agentId || !agendaEditor.agents?.[agentId]) {
                return;
            }
            delete agendaEditor.agents[agentId];
            if (Object.keys(agendaEditor.agents).length === 0) {
                agendaEditor.agents.finalizer = structuredClone(defaultAgendaAgents.finalizer);
            }
            if (!agendaEditor.agents[agendaEditor.finalAgentId]) {
                agendaEditor.finalAgentId = Object.keys(agendaEditor.agents)[0] || '';
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-add') {
            editor.spec.stages.push(createNewStage(editor));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-delete' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            editor.spec.stages.splice(stageIndex, 1);
            if (editor.spec.stages.length === 0) {
                editor.spec.stages.push(createNewStage(editor));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-up' && Number.isInteger(stageIndex) && stageIndex > 0) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex - 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-down' && Number.isInteger(stageIndex) && stageIndex >= 0 && stageIndex < editor.spec.stages.length - 1) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex + 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-add' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            const defaultPreset = pickDefaultPreset(editor);
            editor.spec.stages[stageIndex].nodes.push({
                id: defaultPreset,
                preset: defaultPreset,
                type: ORCH_NODE_TYPE_WORKER,
                userPromptTemplate: '',
            });
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-delete' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            if (!stage?.nodes?.[nodeIndex]) {
                return;
            }
            stage.nodes.splice(nodeIndex, 1);
            if (stage.nodes.length === 0) {
                const defaultPreset = pickDefaultPreset(editor);
                stage.nodes.push({
                    id: defaultPreset,
                    preset: defaultPreset,
                    type: ORCH_NODE_TYPE_WORKER,
                    userPromptTemplate: '',
                });
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-up' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex) && nodeIndex > 0) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex - 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-down' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            if (nodeIndex < 0 || nodeIndex >= nodes.length - 1) {
                return;
            }
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex + 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-add') {
            const scopeRoot = jQuery(this).closest('[data-luker-scope-root]');
            const input = scopeRoot.find(`[data-luker-new-preset="${scope}"]`);
            const candidate = sanitizeIdentifierToken(input.val(), '');
            if (!candidate) {
                notifyError(i18n('Preset ID cannot be empty.'));
                return;
            }
            if (editor.presets[candidate]) {
                notifyError(i18nFormat('Preset \'${0}\' already exists.', candidate));
                return;
            }
            editor.presets[candidate] = createPresetDraft();
            input.val('');
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-delete' && presetId) {
            if (!editor.presets[presetId]) {
                return;
            }
            if (isPresetUsed(editor, presetId)) {
                notifyError(i18nFormat('Preset \'${0}\' is still used by workflow nodes.', presetId));
                return;
            }
            delete editor.presets[presetId];
            ensureEditorIntegrity(editor);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reload-current') {
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                syncCharacterEditorWithActiveAvatar(context);
                const activeAvatar = String(getCurrentAvatar(context) || '').trim();
                if (hasCharacterAgendaOverride(context, activeAvatar)) {
                    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, activeAvatar);
                    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
                    updateUiStatus(i18nFormat('Reloaded character override for ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar) || 'N/A'));
                } else {
                    uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                    ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
                    updateUiStatus(i18n('Reloaded global profile from settings.'));
                }
                renderDynamicPanels(root, context);
                return;
            }
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (hasCharacterOverride(context, activeAvatar)) {
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
                updateUiStatus(i18nFormat('Reloaded character override for ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar) || 'N/A'));
            } else {
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
                updateUiStatus(i18n('Reloaded global profile from settings.'));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reset-global') {
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                if (!window.confirm(i18n('Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.'))) {
                    return;
                }
                settings.executionMode = ORCH_EXECUTION_MODE_AGENDA;
                settings.singleAgentModeEnabled = false;
                settings.agendaPlanner = structuredClone(defaultAgendaPlanner);
                delete settings.agendaPlannerPrompt;
                settings.agendaAgents = sanitizePresetMap(defaultAgendaAgents);
                settings.agendaFinalAgentId = 'finalizer';
                settings.agendaPlannerMaxRounds = 6;
                settings.agendaMaxConcurrentAgents = 3;
                settings.agendaMaxTotalRuns = 24;
                await saveSettings();
                uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
                renderDynamicPanels(root, context);
                notifySuccess(i18n('Global orchestration profile reset to defaults.'));
                updateUiStatus(i18n('Reset global profile to defaults.'));
                return;
            }
            if (!window.confirm(i18n('Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.'))) {
                return;
            }
            settings.orchestrationSpec = structuredClone(defaultSpec);
            settings.presets = structuredClone(defaultPresets);
            await saveSettings();
            uiState.globalEditor = loadGlobalEditorState();
            ensureEditorIntegrity(uiState.globalEditor);
            notifySuccess(i18n('Global orchestration profile reset to defaults.'));
            updateUiStatus(i18n('Reset global profile to defaults.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'save-global') {
            syncCharacterEditorWithActiveAvatar(context);
            const sourceScope = getDisplayedScope(context, settings);
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                const sourceEditor = getAgendaEditorByScope(sourceScope);
                await persistGlobalAgendaEditorFrom(settings, sourceEditor);
                uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
            } else {
                const sourceEditor = getEditorByScope(sourceScope);
                await persistGlobalEditorFrom(settings, sourceEditor);
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
            }
            notifySuccess(i18n('Global orchestration profile saved.'));
            updateUiStatus(i18n('Saved to global profile.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'export-profile') {
            syncCharacterEditorWithActiveAvatar(context);
            const targetMode = getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA
                ? ORCH_EXECUTION_MODE_AGENDA
                : ORCH_EXECUTION_MODE_SPEC;
            const scope = chooseProfileScopeByConfirm(context, 'Select export source: OK = global profile, Cancel = character override.');
            if (!scope) {
                return;
            }
            const avatar = String(getCurrentAvatar(context) || '').trim();
            const safeName = sanitizeIdentifierToken(getCharacterDisplayNameByAvatar(context, avatar) || 'character', 'character');
            const payload = targetMode === ORCH_EXECUTION_MODE_AGENDA
                ? {
                    format: PORTABLE_PROFILE_FORMAT_V2,
                    mode: ORCH_EXECUTION_MODE_AGENDA,
                    scope,
                    exportedAt: new Date().toISOString(),
                    profile: createPortableAgendaProfileFromEditor(scope === 'global'
                        ? uiState.globalAgendaEditor
                        : uiState.characterAgendaEditor),
                }
                : {
                    format: PORTABLE_PROFILE_FORMAT_V1,
                    scope,
                    exportedAt: new Date().toISOString(),
                    profile: createPortableProfileFromEditor(scope === 'global'
                        ? uiState.globalEditor
                        : uiState.characterEditor),
                };
            const fileName = targetMode === ORCH_EXECUTION_MODE_AGENDA
                ? (scope === 'global'
                    ? 'luker-orchestrator-agenda-global.json'
                    : `luker-orchestrator-agenda-character-${safeName}.json`)
                : (scope === 'global'
                    ? 'luker-orchestrator-global.json'
                    : `luker-orchestrator-character-${safeName}.json`);
            downloadJsonFile(fileName, payload);
            if (scope === 'global') {
                notifySuccess(i18n('Exported global profile.'));
                updateUiStatus(i18n('Exported global profile.'));
            } else {
                notifySuccess(i18nFormat('Exported character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                updateUiStatus(i18nFormat('Exported character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            }
            return;
        }

        if (action === 'import-profile') {
            syncCharacterEditorWithActiveAvatar(context);
            try {
                const fileText = await pickJsonFileText();
                if (!fileText) {
                    return;
                }
                const imported = parseImportedProfilePayload(fileText);
                const targetMode = getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA
                    ? ORCH_EXECUTION_MODE_AGENDA
                    : ORCH_EXECUTION_MODE_SPEC;
                if (imported.mode !== targetMode) {
                    throw new Error(i18n('Imported profile does not match current execution mode.'));
                }
                const scope = chooseProfileScopeByConfirm(context, 'Select import target: OK = global profile, Cancel = character override.');
                if (!scope) {
                    return;
                }
                if (targetMode === ORCH_EXECUTION_MODE_AGENDA) {
                    if (scope === 'global') {
                        const profile = sanitizeAgendaWorkingProfile(imported.agenda);
                        settings.agendaPlanner = createAgendaPlannerDraft(profile.planner);
                        delete settings.agendaPlannerPrompt;
                        settings.agendaAgents = sanitizePresetMap(profile.agents);
                        settings.agendaFinalAgentId = sanitizeIdentifierToken(profile.finalAgentId, 'finalizer');
                        settings.agendaPlannerMaxRounds = profile.limits.plannerMaxRounds;
                        settings.agendaMaxConcurrentAgents = profile.limits.maxConcurrentAgents;
                        settings.agendaMaxTotalRuns = profile.limits.maxTotalRuns;
                        ensureSettings();
                        await saveSettings();
                        uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
                        ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
                        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
                        notifySuccess(i18n('Imported to global profile.'));
                        updateUiStatus(i18n('Imported to global profile.'));
                    } else {
                        const avatar = String(getCurrentAvatar(context) || '').trim();
                        if (!avatar) {
                            notifyError(i18n('No character selected.'));
                            return;
                        }
                        const importedEditor = {
                            planner: createAgendaPlannerDraft(imported.agenda.planner || {
                                userPromptTemplate: imported.agenda.plannerPrompt,
                            }),
                            agents: sanitizePresetMap(imported.agenda.agents),
                            finalAgentId: sanitizeIdentifierToken(imported.agenda.finalAgentId, 'finalizer'),
                            limits: {
                                plannerMaxRounds: imported.agenda.limits.plannerMaxRounds,
                                maxConcurrentAgents: imported.agenda.limits.maxConcurrentAgents,
                                maxTotalRuns: imported.agenda.limits.maxTotalRuns,
                            },
                            enabled: true,
                            notes: '',
                        };
                        const ok = await persistCharacterAgendaEditor(context, settings, avatar, {
                            editor: importedEditor,
                            forceEnabled: true,
                        });
                        if (!ok) {
                            notifyError(i18n('Failed to persist character override.'));
                            return;
                        }
                        uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
                        ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                        setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
                        notifySuccess(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                        updateUiStatus(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                    }
                } else if (scope === 'global') {
                    settings.orchestrationSpec = sanitizeSpec(imported.spec);
                    settings.presets = sanitizePresetMap(imported.presets);
                    await saveSettings();
                    uiState.globalEditor = loadGlobalEditorState();
                    ensureEditorIntegrity(uiState.globalEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
                    notifySuccess(i18n('Imported to global profile.'));
                    updateUiStatus(i18n('Imported to global profile.'));
                } else {
                    const avatar = String(getCurrentAvatar(context) || '').trim();
                    if (!avatar) {
                        notifyError(i18n('No character selected.'));
                        return;
                    }
                    const importedEditor = {
                        spec: toEditableSpec(imported.spec, toEditablePresetMap(imported.presets)),
                        presets: toEditablePresetMap(imported.presets),
                        enabled: true,
                        notes: '',
                    };
                    const ok = await persistCharacterEditor(context, settings, avatar, {
                        editor: importedEditor,
                        forceEnabled: true,
                    });
                    if (!ok) {
                        notifyError(i18n('Failed to persist character override.'));
                        return;
                    }
                    uiState.characterEditor = loadCharacterEditorState(context, avatar);
                    ensureEditorIntegrity(uiState.characterEditor);
                    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
                    notifySuccess(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                    updateUiStatus(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                }
                renderDynamicPanels(root, context);
            } catch (error) {
                notifyError(i18nFormat('Import failed: ${0}', error?.message || error));
            }
            return;
        }

        if (action === 'save-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (!activeAvatar) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const sourceScope = getDisplayedScope(context, settings);
            const ok = getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA
                ? await persistCharacterAgendaEditor(context, settings, activeAvatar, {
                    editor: getAgendaEditorByScope(sourceScope),
                    forceEnabled: sourceScope === 'character' ? null : true,
                })
                : await persistCharacterEditor(context, settings, activeAvatar, {
                    editor: getEditorByScope(sourceScope),
                    forceEnabled: sourceScope === 'character' ? null : true,
                });
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return;
            }
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, activeAvatar);
                ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'character');
            } else {
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'character');
            }
            notifySuccess(i18n('Character orchestration override saved.'));
            updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar)));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'clear-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const avatar = String(getCurrentAvatar(context) || '').trim();
            if (!avatar) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const characterIndex = getCharacterIndexByAvatar(context, avatar);
            if (characterIndex < 0) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const previous = getCharacterExtensionDataByAvatar(context, avatar);
            const nextPayload = { ...previous };
            const nextOverride = previous?.override && typeof previous.override === 'object'
                ? structuredClone(previous.override)
                : null;
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                if (nextOverride) {
                    delete nextOverride.agenda;
                }
            } else if (nextOverride) {
                delete nextOverride.spec;
                delete nextOverride.presets;
                delete nextOverride.presetPatch;
                delete nextOverride.enabled;
                delete nextOverride.updatedAt;
                delete nextOverride.name;
                delete nextOverride.notes;
            }
            normalizeCharacterOverrideMode(nextOverride);
            if (nextOverride && (
                (nextOverride.spec && typeof nextOverride.spec === 'object')
                || (nextOverride.presets && typeof nextOverride.presets === 'object')
                || (nextOverride.presetPatch && typeof nextOverride.presetPatch === 'object')
                || (nextOverride.agenda && typeof nextOverride.agenda === 'object')
            )) {
                nextPayload.override = nextOverride;
            } else {
                delete nextPayload.override;
            }
            const ok = await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return;
            }
            applyCharacterExecutionModeForAvatar(context, settings, avatar);
            if (getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
                uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, avatar);
                ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA, 'global');
            } else {
                uiState.characterEditor = loadCharacterEditorState(context, avatar);
                ensureEditorIntegrity(uiState.characterEditor);
                setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC, 'global');
            }
            renderDynamicPanels(root, context);
            notifyInfo(i18n('Character orchestration override removed.'));
            updateUiStatus(i18nFormat('Removed character override for ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            return;
        }

        if (action === 'ai-suggest-character') {
            const avatar = String(getCurrentAvatar(context) || '').trim();
            const displayName = avatar
                ? (getCharacterDisplayNameByAvatar(context, avatar) || i18n('(No character selected)'))
                : i18n('Global profile');
            const aiBuildAbortController = new AbortController();
            activeAiBuildAbortController = aiBuildAbortController;
            showAiBuildToast(i18nFormat('Generating orchestration profile for ${0}...', displayName), {
                stopLabel: i18n('Stop'),
                onStop: () => {
                    if (!aiBuildAbortController.signal.aborted) {
                        aiBuildAbortController.abort();
                    }
                },
            });
            try {
                const result = await runAiCharacterProfileBuild(context, settings, { abortSignal: aiBuildAbortController.signal });
                renderDynamicPanels(root, context);
                if (result?.scope === 'global') {
                    notifySuccess(i18n('Global orchestration profile generated by AI.'));
                    updateUiStatus(i18nFormat('AI profile generated for ${0}.', i18n('Global profile')));
                } else {
                    notifySuccess(i18n('Character orchestration profile generated by AI.'));
                    const doneName = result?.name || getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context));
                    updateUiStatus(i18nFormat('AI profile generated for ${0}.', doneName));
                }
            } catch (error) {
                if (isAbortError(error, aiBuildAbortController.signal)) {
                    updateUiStatus(i18n('AI profile generation cancelled.'));
                } else {
                    notifyError(i18nFormat('AI profile generation failed: ${0}', error?.message || error));
                    updateUiStatus(i18n('AI profile generation failed.'));
                }
            } finally {
                if (activeAiBuildAbortController === aiBuildAbortController) {
                    activeAiBuildAbortController = null;
                }
                clearAiBuildToast();
            }
            return;
        }

        if (action === 'ai-iterate-open') {
            await openAiIterationStudio(context, settings, root);
            return;
        }

        if (action === 'view-last-run') {
            await openLastOrchestrationResult(context);
            return;
        }

        if (action === 'view-runtime-trace') {
            await openOrchestrationRuntimeTrace(context);
            return;
        }

        if (action === 'open-orch-editor') {
            await openOrchestrationEditorPopup(context, settings);
            return;
        }
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    ensureStyles(UI_BLOCK_ID);

    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        return;
    }

    const html = buildOrchestratorSettingsHtml(getOrchestratorUiTemplateDeps());

    host.append(html);
    bindUi();
}

jQuery(() => {
    const context = getContext();
    registerLocaleData();
    ensureSettings();
    saveSettingsDebounced();
    clearCapsulePrompt(context);
    void loadOrchestratorChatState(context).finally(() => ensureUi());

    if (context.eventTypes.GENERATION_WORLD_INFO_FINALIZED) {
        context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, onWorldInfoFinalized);
    }
    if (context.eventTypes.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }
    if (context.eventTypes.MESSAGE_EDITED) {
        context.eventSource.on(context.eventTypes.MESSAGE_EDITED, onMessageEdited);
    }
    if (context.eventTypes.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
    }
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        const liveContext = getContext();
        abortActiveOrchestratorRun();
        clearCacheForChatChange();
        clearLatestOrchestrationRuntimeTrace();
        clearCapsulePrompt(liveContext);
        void loadOrchestratorChatState(liveContext).finally(() => ensureUi());
    });
});
