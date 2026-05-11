// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator — IterationStudio adapter factory.
 *
 * Builds one ProfileAdapter for each orchestration mode (spec / agenda / loop)
 * by wrapping orchestrator's existing functions. The three adapters share the
 * same storage bucket (orchestrator's pre-existing global iteration history
 * key + character-state namespace) and filter sessions by `mode` so users
 * don't have to migrate prior history.
 *
 * All orchestrator-side functions are received as `deps` rather than imported
 * directly to avoid a circular import with main.js. Mode-specific dispatch
 * inside the adapter methods uses the orchestrator constants passed through
 * `deps.ORCH_EXECUTION_MODES`.
 *
 * Control tools (continue/finalize) keep their orchestrator-specific names
 * (`luker_orch_continue_iteration`, `luker_orch_finalize_iteration`) via the
 * `controlToolNames` override so the existing system prompt language and any
 * user-saved sessions reading those tool names keep working.
 */

import { defineAdapter, createSettingsBackedHistoryStore } from '../../iteration-studio/index.js';

const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_orch_continue_iteration',
    finalize: 'luker_orch_finalize_iteration',
});
const CONTROL_TOOL_NAME_SET = new Set([CONTROL_TOOL_NAMES.continue, CONTROL_TOOL_NAMES.finalize]);

export function createOrchestratorIterationAdapter(mode, deps) {
    const {
        i18n,
        i18nFormat,
        // editor + scope helpers
        getIterationDefaultScope,
        getEditorByScope,
        getAgendaEditorByScope,
        getLoopEditorByScope,
        syncCharacterEditorWithActiveAvatar,
        // profile shape helpers
        cloneWorkingProfileFromEditor,
        cloneAgendaWorkingProfileFromEditor,
        sanitizeLoopProfile,
        sanitizeSpec,
        sanitizePresetMap,
        sanitizeAgendaWorkingProfile,
        cloneAiIterationWorkingProfile,
        // LLM round-trip helpers
        buildAiIterationToolSet,
        buildAiIterationSystemPrompt,
        buildAiIterationUserPrompt,
        buildAiIterationAutoContinuePrompt,
        executeAiIterationToolCalls,
        renderAiIterationWorkingProfile,
        resolveOrchestrationRuntimeWorldInfo,
        // apply helpers
        applyAiIterationSessionToGlobal,
        applyAiIterationSessionToCharacter,
        // constants
        ORCH_EXECUTION_MODES,
        MODULE_NAME,
        ORCH_GLOBAL_ITERATION_HISTORY_KEY,
        ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE,
        ORCH_CHARACTER_ITERATION_HISTORY_LIMIT,
    } = deps;

    const isLoop = mode === ORCH_EXECUTION_MODES.LOOP;
    const isAgenda = mode === ORCH_EXECUTION_MODES.AGENDA;

    return defineAdapter({
        id: `orch_${mode}`,
        title: i18n('AI Iteration Studio'),
        mode,
        popupClassName: 'luker_orch_iter_popup',
        i18n,
        i18nFormat,

        getInitialProfile(ctx) {
            syncCharacterEditorWithActiveAvatar(ctx);
            const scope = getIterationDefaultScope(ctx);
            if (isLoop) {
                return sanitizeLoopProfile(getLoopEditorByScope(scope));
            }
            if (isAgenda) {
                return cloneAgendaWorkingProfileFromEditor(getAgendaEditorByScope(scope));
            }
            return cloneWorkingProfileFromEditor(getEditorByScope(scope));
        },

        cloneWorkingProfile(profile) {
            return cloneAiIterationWorkingProfile(mode, profile);
        },

        getGlobalBaselineProfile(settings) {
            if (isLoop) {
                return sanitizeLoopProfile(settings?.loopProfile || {});
            }
            if (isAgenda) {
                return sanitizeAgendaWorkingProfile({
                    planner: settings?.agendaPlanner || {},
                    agents: settings?.agendaAgents || {},
                    finalAgentId: settings?.agendaFinalAgentId || '',
                    limits: {
                        plannerMaxRounds: settings?.agendaPlannerMaxRounds || 0,
                        maxConcurrentAgents: settings?.agendaMaxConcurrentAgents || 0,
                        maxTotalRuns: settings?.agendaMaxTotalRuns || 0,
                    },
                });
            }
            return {
                spec: sanitizeSpec(settings?.orchestrationSpec || { stages: [] }),
                presets: sanitizePresetMap(settings?.presets || {}),
            };
        },

        getDefaultScope: getIterationDefaultScope,

        ...createSettingsBackedHistoryStore({
            moduleName: MODULE_NAME,
            globalSettingsKey: ORCH_GLOBAL_ITERATION_HISTORY_KEY,
            characterStateNamespace: ORCH_CHARACTER_ITERATION_HISTORY_NAMESPACE,
            historyLimit: ORCH_CHARACTER_ITERATION_HISTORY_LIMIT,
            modeFilter: mode,
        }),

        buildSystemPrompt(settings, session) {
            return buildAiIterationSystemPrompt(settings, session);
        },

        buildUserPrompt(settings, session, userText, opts) {
            return buildAiIterationUserPrompt(settings, session, userText, opts);
        },

        buildAutoContinuePrompt(executionResult) {
            return buildAiIterationAutoContinuePrompt(executionResult);
        },

        controlToolNames: CONTROL_TOOL_NAMES,

        buildEditableToolSet(session) {
            const all = buildAiIterationToolSet(session) || [];
            // Shell injects continue/finalize separately. Strip them from the
            // adapter-contributed list so the LLM sees one canonical definition.
            return all.filter(t => !CONTROL_TOOL_NAME_SET.has(String(t?.function?.name || '')));
        },

        async executeEditableToolCall(ctx, session, call, signal) {
            // Orchestrator's executeAiIterationToolCalls is mode-aware and
            // iterates over a call list; calling it with a single editable
            // call yields the right shape for the shell to consume.
            const result = await executeAiIterationToolCalls(ctx, session, [call], signal);
            const callId = String(call?.id || '');
            const toolResult = (result?.toolResults || []).find(item => String(item?.tool_call_id || '') === callId);
            const actions = Array.isArray(result?.actions) ? result.actions.filter(Boolean) : [];
            return {
                content: toolResult?.content || JSON.stringify({ ok: true }),
                action: actions.join('; '),
                changed: Boolean(result?.changed),
            };
        },

        renderWorkingProfile(session, opts) {
            // Shell no longer prepends a panel title — adapters own the
            // upper-half chrome so each studio can label its workingProfile
            // domain (orchestration vs schema vs ...) without i18n key
            // collisions across plugins.
            const title = i18n('Working profile');
            const body = renderAiIterationWorkingProfile(session, opts);
            const hasAvatar = Boolean(session?.sourceAvatar);
            // Adapter renders its own action buttons. Shell delegates
            // clicks on [data-iter-custom-action] to handleAction below.
            const actions = `
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply-global">${escapeHtmlString(i18n('Apply to Global'))}</div>
    ${hasAvatar ? `<div class="menu_button" data-iter-custom-action="apply-character">${escapeHtmlString(i18n('Apply to Character'))}</div>` : ''}
</div>`;
            return `<div class="luker-studio-panel-title">${escapeHtmlString(title)}</div>${body}${actions}`;
        },

        async handleAction(actionId, ctx) {
            const { session, context: c, settings, root } = ctx;
            if (actionId === 'apply-global') {
                await applyAiIterationSessionToGlobal(c, settings, session, root);
                return;
            }
            if (actionId === 'apply-character') {
                await applyAiIterationSessionToCharacter(c, settings, session, root);
            }
        },

        getRequestPresetOptions(settings) {
            return {
                apiPresetName: String(settings?.aiSuggestApiPresetName || '').trim(),
                llmPresetName: String(settings?.aiSuggestPresetName || '').trim(),
            };
        },

        async resolveRuntimeWorldInfo(ctx, settings, session, signal) {
            return await resolveOrchestrationRuntimeWorldInfo(ctx, settings, {
                worldInfoMessages: Array.isArray(session?.messages) ? session.messages : [],
                runtimeWorldInfo: null,
                forceWorldInfoResimulate: false,
                worldInfoType: 'quiet',
                abortSignal: signal,
            });
        },
    });
}

function escapeHtmlString(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}
