// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator — IterationStudio adapter (v2, IDE-style).
 *
 * Migrated from the v1 contract. The orchestrator's pre-existing
 * `executeAiIterationToolCalls` is mode-aware and mutates a session's
 * `workingProfile` in place; this adapter wraps that executor with the
 * sandbox-diff strategy so the shell can drive its own edit pipeline:
 *
 *   normalizeToolCallToEdit(call, { live }) →
 *     1. clone `live` into a sandbox profile
 *     2. invoke orchestrator's executor against the sandbox
 *     3. emit ONE coarse `set` edit at path '' carrying the new root
 *
 * Coarse profile-level edits mean conflict detection is profile-level —
 * any concurrent external change collides with the entire batch. That's
 * acceptable for SP-1; a future sub-project can swap in per-field op
 * tools when the orchestrator side ships its own normalizer.
 *
 * `live()` and `commit()` route through the existing editor + apply
 * helpers passed in via deps. The session bucket is held under the
 * orchestrator settings namespace `iterStudioV2.<mode>.<scope>`.
 */

import { defineAdapter } from '../../iteration-studio/index.js';

const CONTROL_TOOL_NAMES = Object.freeze({
    continue: 'luker_orch_continue_iteration',
    finalize: 'luker_orch_finalize_iteration',
});
const CONTROL_TOOL_NAME_SET = new Set([CONTROL_TOOL_NAMES.continue, CONTROL_TOOL_NAMES.finalize]);

const SESSIONS_BUCKET_KEY = 'iterStudioV2';
const LEGACY_GLOBAL_HISTORY_KEY = 'global_iteration_history';

function escapeHtmlString(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
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

function getSillyTavernContext() {
    if (typeof globalThis === 'undefined') return null;
    const st = globalThis.SillyTavern;
    if (st && typeof st.getContext === 'function') {
        try { return st.getContext(); } catch { /* ignore */ }
    }
    return null;
}

function getOrchestratorSettingsRoot(moduleName) {
    const ctx = getSillyTavernContext();
    const all = ctx?.extensionSettings;
    if (!all || typeof all !== 'object') return null;
    if (!all[moduleName] || typeof all[moduleName] !== 'object') {
        all[moduleName] = {};
    }
    return all[moduleName];
}

export function createOrchestratorIterationAdapter(mode, deps) {
    const {
        i18n,
        i18nFormat,
        getIterationDefaultScope,
        getEditorByScope,
        getAgendaEditorByScope,
        getLoopEditorByScope,
        getDirectorEditorByScope,
        syncCharacterEditorWithActiveAvatar,
        cloneWorkingProfileFromEditor,
        cloneAgendaWorkingProfileFromEditor,
        cloneDirectorWorkingProfileFromEditor,
        sanitizeLoopProfile,
        sanitizeAgendaWorkingProfile,
        sanitizeDirectorProfile,
        buildAiIterationToolSet,
        buildAiIterationSystemPrompt,
        buildAiIterationUserPrompt,
        buildAiIterationAutoContinuePrompt,
        executeAiIterationToolCalls,
        renderAiIterationWorkingProfile,
        resolveOrchestrationRuntimeWorldInfo,
        applyAiIterationSessionToGlobal,
        applyAiIterationSessionToCharacter,
        ORCH_EXECUTION_MODES,
        MODULE_NAME,
    } = deps;

    const isLoop = mode === ORCH_EXECUTION_MODES.LOOP;
    const isAgenda = mode === ORCH_EXECUTION_MODES.AGENDA;
    const isDirector = mode === ORCH_EXECUTION_MODES.DIRECTOR;

    function readLiveProfile() {
        const ctx = getSillyTavernContext();
        if (ctx) {
            try { syncCharacterEditorWithActiveAvatar(ctx); } catch { /* ignore */ }
        }
        const scope = getIterationDefaultScope(ctx);
        if (isLoop) return sanitizeLoopProfile(getLoopEditorByScope(scope));
        if (isAgenda) return cloneAgendaWorkingProfileFromEditor(getAgendaEditorByScope(scope));
        if (isDirector) return cloneDirectorWorkingProfileFromEditor(getDirectorEditorByScope(scope));
        return cloneWorkingProfileFromEditor(getEditorByScope(scope));
    }

    function sessionScopeKey() {
        const ctx = getSillyTavernContext();
        const baseScope = getIterationDefaultScope(ctx);
        if (baseScope !== 'character') return 'global';
        const avatar = String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
        return avatar ? `character_${avatar}` : 'global';
    }

    function getSessionsBucket(scope) {
        const root = getOrchestratorSettingsRoot(MODULE_NAME);
        if (!root) return {};
        if (!root[SESSIONS_BUCKET_KEY] || typeof root[SESSIONS_BUCKET_KEY] !== 'object') {
            root[SESSIONS_BUCKET_KEY] = {};
        }
        const byMode = root[SESSIONS_BUCKET_KEY];
        if (!byMode[mode] || typeof byMode[mode] !== 'object') {
            byMode[mode] = {};
        }
        const byScope = byMode[mode];
        if (!byScope[scope] || typeof byScope[scope] !== 'object') {
            byScope[scope] = {};
        }
        return byScope[scope];
    }

    function persistSettings() {
        // Mutations to extension_settings.* require an explicit save trigger.
        // We use the same global debounced save the rest of orchestrator uses.
        try {
            if (typeof globalThis !== 'undefined' && typeof globalThis.saveSettingsDebounced === 'function') {
                globalThis.saveSettingsDebounced();
                return;
            }
        } catch { /* ignore */ }
        // No-op fallback; sessions live in memory until the next debounced save
        // triggered by any other interaction.
    }

    function sanitizeForMode(profile) {
        if (isLoop) return sanitizeLoopProfile(profile);
        if (isAgenda) return sanitizeAgendaWorkingProfile(profile);
        if (isDirector) return sanitizeDirectorProfile(profile);
        return profile;
    }

    return defineAdapter({
        id: `orch_${mode}`,
        title: i18n('AI Iteration Studio'),
        mode,
        layout: 'split',
        popupClassName: 'luker_orch_iter_popup',
        i18n,
        i18nFormat,

        live: () => readLiveProfile(),

        commit: async (newLive) => {
            // SP-1 minimum: commit always writes the working profile back to
            // the GLOBAL editor + settings via orchestrator's existing apply
            // helper. Per-character overrides are opt-in via the explicit
            // "Apply to Character" button (see handleAction below). The
            // synthesized fake session carries just enough shape for the
            // helper to route to the right per-mode branch.
            const ctx = getSillyTavernContext();
            const settings = getOrchestratorSettingsRoot(MODULE_NAME) || {};
            const fakeSession = {
                workingProfile: sanitizeForMode(newLive),
                mode,
            };
            await applyAiIterationSessionToGlobal(ctx, settings, fakeSession, null);
        },

        sessionScope: () => sessionScopeKey(),

        listSessions: async (scope) => {
            const bucket = getSessionsBucket(scope);
            return Object.values(bucket)
                .filter(s => s && typeof s === 'object' && s.id)
                .map(s => ({
                    id: String(s.id),
                    title: String(s.title || s.id),
                    updatedAt: Number(s.updatedAt || 0),
                }))
                .sort((a, b) => b.updatedAt - a.updatedAt);
        },
        loadSession: async (scope, id) => {
            const bucket = getSessionsBucket(scope);
            const stored = bucket[String(id)];
            return stored ? structuredClone(stored) : null;
        },
        saveSession: async (scope, session) => {
            if (!session?.id) return;
            const bucket = getSessionsBucket(scope);
            bucket[String(session.id)] = structuredClone(session);
            persistSettings();
        },
        deleteSession: async (scope, id) => {
            const bucket = getSessionsBucket(scope);
            delete bucket[String(id)];
            persistSettings();
        },
        clearObsoleteSessions: async () => {
            // One-shot wipe of the v1 storage key. The new v2 bucket lives
            // under SESSIONS_BUCKET_KEY and is unaffected.
            const root = getOrchestratorSettingsRoot(MODULE_NAME);
            if (root && LEGACY_GLOBAL_HISTORY_KEY in root) {
                delete root[LEGACY_GLOBAL_HISTORY_KEY];
                persistSettings();
            }
        },

        controlToolNames: CONTROL_TOOL_NAMES,

        buildToolCatalog: (session) => {
            const all = buildAiIterationToolSet(session) || [];
            // Shell injects continue/finalize control tools separately. Strip
            // orchestrator's copies so the LLM sees one canonical definition.
            return all.filter(t => !CONTROL_TOOL_NAME_SET.has(String(t?.function?.name || '')));
        },

        // Sandbox-diff: clone live, let orchestrator's mode-aware executor
        // mutate the sandbox, emit one coarse `set` edit at root path.
        // Returns Promise<Edit[]|null> — runner.js awaits this.
        normalizeToolCallToEdit: async (call, ctx) => {
            const before = ctx?.live;
            if (before === undefined || before === null) return [];
            const sandbox = structuredClone(before);
            const fakeSession = {
                workingProfile: sandbox,
                mode,
            };
            try {
                await executeAiIterationToolCalls(null, fakeSession, [call], null);
            } catch (error) {
                console.warn(`[orch-adapter:${mode}] sandbox executor failed`, error);
                return null;
            }
            // Cheap structural diff. If nothing changed, signal no-op so the
            // shell records a tool_result without staging an edit.
            try {
                if (JSON.stringify(sandbox) === JSON.stringify(before)) {
                    return [];
                }
            } catch {
                // If profiles contain unstringifiable values, fall through and
                // emit the edit regardless.
            }
            return [{
                op: 'set',
                path: '',
                oldValue: before,
                newValue: sandbox,
            }];
        },

        buildSystemPrompt: (session) => {
            const settings = getOrchestratorSettingsRoot(MODULE_NAME) || {};
            return buildAiIterationSystemPrompt(settings, session);
        },
        buildUserPrompt: (session, userText, opts) => {
            const settings = getOrchestratorSettingsRoot(MODULE_NAME) || {};
            return buildAiIterationUserPrompt(settings, session, userText, opts || {});
        },
        buildAutoContinuePrompt: (executionResult) => {
            return buildAiIterationAutoContinuePrompt(executionResult);
        },

        getRequestPresetOptions: (settings) => {
            const s = settings || getOrchestratorSettingsRoot(MODULE_NAME) || {};
            return {
                apiPresetName: String(s?.aiSuggestApiPresetName || '').trim(),
                llmPresetName: String(s?.aiSuggestPresetName || '').trim(),
            };
        },
        resolveRuntimeWorldInfo: async (session, signal) => {
            const ctx = getSillyTavernContext();
            const settings = getOrchestratorSettingsRoot(MODULE_NAME) || {};
            return await resolveOrchestrationRuntimeWorldInfo(ctx, settings, {
                worldInfoMessages: Array.isArray(session?.messages) ? session.messages : [],
                runtimeWorldInfo: null,
                forceWorldInfoResimulate: false,
                worldInfoType: 'quiet',
                abortSignal: signal,
            });
        },

        renderMessageCard: (message) => {
            const auto = message?.auto ? ' luker-iter-auto' : '';
            const role = String(message?.role || 'assistant');
            const text = escapeHtmlString(message?.content || '');
            const edits = Array.isArray(message?.appliedEdits) ? message.appliedEdits.length : 0;
            const rolledBack = message?.rolledBack
                ? ` <span class="luker-iter-rolledback">[${escapeHtmlString(i18n('rolled back'))}]</span>`
                : '';
            const editsLine = edits > 0
                ? `<div class="luker-iter-msg-edits">${escapeHtmlString(i18n('Edits applied:'))} ${edits}${rolledBack}</div>`
                : '';
            const rollbackBtn = (role === 'assistant' && edits > 0 && !message?.rolledBack)
                ? `<div class="menu_button menu_button_small" data-iter-action="rollback-to-message" data-iter-message-id="${escapeHtmlString(message?.id || '')}">${escapeHtmlString(i18n('Rollback'))}</div>`
                : '';
            return `
<div class="luker-iter-msg luker-iter-msg-${escapeHtmlString(role)}${auto}">
    <div class="luker-iter-msg-body">${text}</div>
    ${editsLine}
    ${rollbackBtn}
</div>`;
        },

        renderHistoryItem: (meta) => `
<div class="luker-iter-history-item">
    <div class="menu_button menu_button_small" data-iter-action="load-session" data-iter-session-id="${escapeHtmlString(meta?.id || '')}">${escapeHtmlString(meta?.title || meta?.id || '')}</div>
    <span class="luker-iter-history-time">${escapeHtmlString(formatTimestamp(meta?.updatedAt))}</span>
    <div class="menu_button menu_button_small fa-solid fa-trash" data-iter-action="delete-session" data-iter-session-id="${escapeHtmlString(meta?.id || '')}" title="${escapeHtmlString(i18n('Delete'))}"></div>
</div>`,

        renderPreviewPane: (state) => {
            const title = escapeHtmlString(i18n('Working profile'));
            const fakeSession = {
                ...(state?.session || {}),
                workingProfile: state?.live,
            };
            const body = renderAiIterationWorkingProfile(fakeSession, { workingProfile: state?.live });
            const hasAvatar = Boolean(state?.session?.sourceAvatar);
            const actions = `
<div class="luker-studio-composer-buttons">
    <div class="menu_button" data-iter-custom-action="apply-global">${escapeHtmlString(i18n('Apply to Global'))}</div>
    ${hasAvatar ? `<div class="menu_button" data-iter-custom-action="apply-character">${escapeHtmlString(i18n('Apply to Character'))}</div>` : ''}
</div>`;
            return `<div class="luker-studio-panel-title">${title}</div>${body}${actions}`;
        },

        handleAction: async (actionId, { session, root }) => {
            const ctx = getSillyTavernContext();
            const settings = getOrchestratorSettingsRoot(MODULE_NAME) || {};
            if (actionId === 'apply-global') {
                await applyAiIterationSessionToGlobal(ctx, settings, session, root);
                return;
            }
            if (actionId === 'apply-character') {
                await applyAiIterationSessionToCharacter(ctx, settings, session, root);
            }
        },
    });
}
