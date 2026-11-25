// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator iteration studio — agenda-mode agent edit tools.
 *
 * Executes the agent / final-agent / agent-tools edit tools against an
 * agenda-mode iteration session's `workingProfile`.
 * `executeAgendaIterationToolCalls` in main.js routes these tool names
 * here and owns the shared `actions` / tool-result accumulators.
 *
 * Agent keys are stored verbatim, so a requested `agent_id` is resolved
 * with `resolveStoredIdToken`: an exact key first, then a unique
 * trimmed-equal key; several trimmed-equal keys are reported as
 * `multiple_matches`.
 */

import { sanitizeConnectionProfileName, sanitizePromptPresetName } from '../agent-resolution.js';
import { sanitizeAgendaWorkingProfile } from '../agenda-profile.js';
import { createPresetDraft, resolveStoredIdToken } from '../editable-spec.js';
import { readIterationStringArg } from '../iter-arg-validator.js';
import { sanitizeAgentToolFlags } from '../persistence.js';
import { applyStringPatch } from '../../../iteration-library/system-prompt-patch.js';
import { ambiguousIdFailure, buildPatchFailureEnvelope } from './tool-failures.js';

export const AGENDA_AGENT_TOOL_NAMES = new Set([
    'luker_orch_set_agenda_agent',
    'luker_orch_patch_agenda_agent_system_prompt',
    'luker_orch_remove_agenda_agent',
    'luker_orch_set_agenda_final_agent',
    'luker_orch_set_agenda_agent_tools',
    'luker_orch_clear_agenda_agent_tools',
]);

function resolveAgendaAgentId(session, value) {
    return resolveStoredIdToken(Object.keys(session?.workingProfile?.agents || {}), value);
}

/**
 * @param {object} session agenda-mode iteration session
 * @param {string} name tool name, one of `AGENDA_AGENT_TOOL_NAMES`
 * @param {object} args tool arguments
 * @param {{ actions: string[], pushToolResult: (payload: object) => void }} sinks shared with the caller
 * @returns {boolean} whether the working profile changed
 */
export function executeAgendaAgentTool(session, name, args, { actions, pushToolResult }) {
    if (name === 'luker_orch_set_agenda_agent') {
        const resolved = resolveAgendaAgentId(session, args.agent_id);
        if (resolved.status === 'empty') {
            const actionText = 'Skipped agenda agent update: missing agent_id.';
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
            return false;
        }
        const agentId = resolved.id;
        if (resolved.status === 'ambiguous') {
            const failure = ambiguousIdFailure('agenda agent update', 'agent', agentId, resolved.matches);
            actions.push(failure.action);
            pushToolResult({ ...failure, agent_id: agentId });
            return false;
        }
        const beforeAgent = session.workingProfile.agents[agentId] || null;
        // Strict optional-string fields — only overwrite when the
        // AI passed a string, otherwise inherit existing.
        // The pre-fix code unconditionally overwrote systemPrompt
        // and userPromptTemplate with `String(args.X || '').trim()`,
        // which meant an `apiPresetName`-only patch wiped both
        // prompt fields to '' — a real destructive bug, not merely
        // a silent-noop one. Wrong-type args also throw so the
        // executor reports `{ok:false, error:'invalid_args'}`.
        let nextSystemPrompt, nextUserPromptTemplate;
        try {
            nextSystemPrompt = readIterationStringArg(args, 'systemPrompt', name);
            nextUserPromptTemplate = readIterationStringArg(args, 'userPromptTemplate', name);
        } catch (err) {
            const detail = String(err?.message || err || 'invalid_args');
            actions.push(`Skipped agenda agent "${agentId}" patch: ${detail}`);
            pushToolResult({ ok: false, error: 'invalid_args', detail, action: `Skipped agenda agent "${agentId}" patch: ${detail}` });
            return false;
        }
        session.workingProfile.agents[agentId] = createPresetDraft({
            ...(beforeAgent || {}),
            ...(nextSystemPrompt !== undefined ? { systemPrompt: nextSystemPrompt.trim() } : {}),
            ...(nextUserPromptTemplate !== undefined ? { userPromptTemplate: nextUserPromptTemplate.trim() } : {}),
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
        return true;
    }
    if (name === 'luker_orch_patch_agenda_agent_system_prompt') {
        const resolved = resolveAgendaAgentId(session, args.agent_id);
        if (resolved.status === 'empty') {
            const actionText = 'Skipped agenda agent system-prompt patch: missing agent_id.';
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
            return false;
        }
        const agentId = resolved.id;
        if (resolved.status === 'ambiguous') {
            const failure = ambiguousIdFailure('agenda agent system-prompt patch', 'agent', agentId, resolved.matches);
            actions.push(failure.action);
            pushToolResult({ ...failure, agent_id: agentId });
            return false;
        }
        const beforeAgent = resolved.status === 'found' ? session.workingProfile.agents[agentId] : null;
        if (!beforeAgent) {
            const actionText = `Skipped agenda agent system-prompt patch: "${agentId}" not found.`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText, agent_id: agentId });
            return false;
        }
        const currentPrompt = String(beforeAgent.systemPrompt || '');
        const result = applyStringPatch(currentPrompt, args);
        if (!result.ok) {
            const actionText = `Agenda agent "${agentId}" system-prompt patch failed: ${result.error}.`;
            actions.push(actionText);
            pushToolResult(buildPatchFailureEnvelope({
                mode: 'agenda',
                targetPath: `agents.${agentId}.systemPrompt`,
                actionText,
                currentText: currentPrompt,
                oldString: String(args?.oldString || ''),
                error: result.error,
                detail: result.detail,
            }));
            return false;
        }
        const profileChanged = result.nextText !== currentPrompt;
        session.workingProfile.agents[agentId] = createPresetDraft({
            ...beforeAgent,
            systemPrompt: result.nextText,
        });
        const actionText = profileChanged
            ? `Agenda agent "${agentId}" system prompt patched.`
            : `Agenda agent "${agentId}" system-prompt patch produced no changes.`;
        actions.push(actionText);
        pushToolResult({ ok: true, changed: profileChanged, action: actionText, agent_id: agentId, systemPrompt: result.nextText });
        return profileChanged;
    }
    if (name === 'luker_orch_remove_agenda_agent') {
        const resolved = resolveAgendaAgentId(session, args.agent_id);
        if (resolved.status === 'empty') {
            const actionText = 'Skipped agenda agent removal: missing agent_id.';
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
            return false;
        }
        const agentId = resolved.id;
        if (resolved.status === 'ambiguous') {
            const failure = ambiguousIdFailure('agenda agent removal', 'agent', agentId, resolved.matches);
            actions.push(failure.action);
            pushToolResult({ ...failure, agent_id: agentId });
            return false;
        }
        if (resolved.status !== 'found') {
            const actionText = `Skipped agenda agent removal: "${agentId}" not found.`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText, agent_id: agentId });
            return false;
        }
        delete session.workingProfile.agents[agentId];
        session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
        const actionText = `Agenda agent "${agentId}" removed.`;
        actions.push(actionText);
        pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
        return true;
    }
    if (name === 'luker_orch_set_agenda_final_agent') {
        const resolved = resolveAgendaAgentId(session, args.agent_id);
        if (resolved.status === 'empty') {
            const actionText = 'Skipped agenda final agent update: missing agent_id.';
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
            return false;
        }
        const agentId = resolved.id;
        if (resolved.status === 'ambiguous') {
            const failure = ambiguousIdFailure('agenda final agent update', 'agent', agentId, resolved.matches);
            actions.push(failure.action);
            pushToolResult({ ...failure, agent_id: agentId });
            return false;
        }
        session.workingProfile.finalAgentId = agentId;
        session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
        if (String(session.workingProfile.finalAgentId || '') !== agentId) {
            const actionText = `Skipped agenda final agent update: "${agentId}" is not available.`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText, agent_id: agentId });
            return false;
        }
        const actionText = `Agenda final agent set to "${agentId}".`;
        actions.push(actionText);
        pushToolResult({ ok: true, changed: true, action: actionText, agent_id: agentId });
        return true;
    }
    if (name === 'luker_orch_set_agenda_agent_tools') {
        const resolved = resolveAgendaAgentId(session, args.agent_id);
        if (resolved.status === 'empty') {
            const actionText = 'Skipped agenda agent tools update: missing agent_id.';
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
            return false;
        }
        const agentId = resolved.id;
        if (resolved.status === 'ambiguous') {
            const failure = ambiguousIdFailure('agenda agent tools update', 'agent', agentId, resolved.matches);
            actions.push(failure.action);
            pushToolResult({ ...failure, agent_id: agentId });
            return false;
        }
        const agents = session.workingProfile.agents || {};
        const preset = resolved.status === 'found' ? agents[agentId] : null;
        if (!preset || typeof preset !== 'object') {
            const actionText = `Skipped agenda agent tools update: agent_id "${agentId}" not found.`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText });
            return false;
        }
        if (!preset.tools || typeof preset.tools !== 'object') {
            preset.tools = session.workingProfile.defaultTools && typeof session.workingProfile.defaultTools === 'object'
                ? JSON.parse(JSON.stringify(session.workingProfile.defaultTools))
                : sanitizeAgentToolFlags({});
        }
        const before = JSON.stringify(preset.tools);
        const incoming = args.tools && typeof args.tools === 'object' ? args.tools : {};
        for (const [ns, verbs] of Object.entries(incoming)) {
            if (!verbs || typeof verbs !== 'object') continue;
            if (!preset.tools[ns] || typeof preset.tools[ns] !== 'object') {
                preset.tools[ns] = {};
            }
            for (const [verb, value] of Object.entries(verbs)) {
                preset.tools[ns][verb] = Boolean(value);
            }
        }
        session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
        const after = JSON.stringify(session.workingProfile.agents?.[agentId]?.tools || {});
        const profileChanged = before !== after;
        const actionText = profileChanged ? `Agenda agent "${agentId}" tools override updated.` : `Agenda agent "${agentId}" tools patch produced no changes.`;
        actions.push(actionText);
        pushToolResult({ ok: true, changed: profileChanged, action: actionText, tools: session.workingProfile.agents?.[agentId]?.tools });
        return profileChanged;
    }
    if (name === 'luker_orch_clear_agenda_agent_tools') {
        const resolved = resolveAgendaAgentId(session, args.agent_id);
        if (resolved.status === 'empty') {
            const actionText = 'Skipped agenda agent tools clear: missing agent_id.';
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
            return false;
        }
        const agentId = resolved.id;
        if (resolved.status === 'ambiguous') {
            const failure = ambiguousIdFailure('agenda agent tools clear', 'agent', agentId, resolved.matches);
            actions.push(failure.action);
            pushToolResult({ ...failure, agent_id: agentId });
            return false;
        }
        const preset = resolved.status === 'found' ? session.workingProfile.agents?.[agentId] : null;
        if (!preset || typeof preset !== 'object') {
            const actionText = `Skipped agenda agent tools clear: agent_id "${agentId}" not found.`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText });
            return false;
        }
        const hadOverride = preset.tools && typeof preset.tools === 'object';
        preset.tools = null;
        session.workingProfile = sanitizeAgendaWorkingProfile(session.workingProfile);
        const actionText = hadOverride
            ? `Agenda agent "${agentId}" tools cleared (now inherits default).`
            : `Agenda agent "${agentId}" tools already inheriting default.`;
        actions.push(actionText);
        pushToolResult({ ok: true, changed: hadOverride, action: actionText });
        return Boolean(hadOverride);
    }
    throw new Error(`agenda agent tools: unknown_tool — ${name}`);
}
