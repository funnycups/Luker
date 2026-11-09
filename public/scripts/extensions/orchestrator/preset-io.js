// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DOM-free preset import / export and spec <-> agenda conversion, shared by
// the orchestrator and Orchestra Lens.

import { i18n } from './i18n.js';
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_NODE_TYPE_REVIEW,
    PORTABLE_PROFILE_FORMAT_V1,
    PORTABLE_PROFILE_FORMAT_V2,
    PORTABLE_PROFILE_FORMAT_V3,
    PORTABLE_PROFILE_FORMAT_V4,
    defaultAgendaAgents,
    sanitizeDirectorProfile,
} from './defaults.js';
import { sanitizeSpec } from './spec-schema.js';
import { normalizeExecutionMode } from './character-overrides.js';
import { sanitizeIdentifierToken, sanitizePresetMap } from './editable-spec.js';
import { ensureAgendaEditorIntegrity, sanitizeAgendaWorkingProfile } from './agenda-profile.js';
import { sanitizeLoopProfile } from './persistence.js';
import { ensureEditorIntegrity } from './editor-state.js';
import {
    createPortableAgendaProfileFromEditor,
    createPortableDirectorProfileFromEditor,
    createPortableLoopProfileFromEditor,
    createPortableProfileFromEditor,
} from './editor-persist.js';

export function buildBestEffortSpecFromAgendaAgents(agents, finalAgentId) {
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

export function copySpecPresetsIntoAgendaEditor(sourceEditor, agendaEditor) {
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

export function copyAgendaAgentsIntoSpecEditor(agendaEditor, specEditor) {
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

export function buildPortablePayloadForMode(mode, entry) {
    const exportedAt = new Date().toISOString();
    const name = String(entry?.name || '').trim();
    if (mode === ORCH_EXECUTION_MODE_AGENDA) {
        return {
            format: PORTABLE_PROFILE_FORMAT_V2,
            mode: ORCH_EXECUTION_MODE_AGENDA,
            name,
            exportedAt,
            profile: createPortableAgendaProfileFromEditor(entry),
        };
    }
    if (mode === ORCH_EXECUTION_MODE_DIRECTOR) {
        return {
            format: PORTABLE_PROFILE_FORMAT_V3,
            mode: ORCH_EXECUTION_MODE_DIRECTOR,
            name,
            exportedAt,
            profile: createPortableDirectorProfileFromEditor(entry),
        };
    }
    if (mode === ORCH_EXECUTION_MODE_LOOP) {
        return {
            format: PORTABLE_PROFILE_FORMAT_V4,
            mode: ORCH_EXECUTION_MODE_LOOP,
            name,
            exportedAt,
            profile: createPortableLoopProfileFromEditor(entry),
        };
    }
    // spec: editor shape mirrors the on-disk shape, so we can hand the
    // entry straight to createPortableProfileFromEditor (which serializes
    // `spec` + `presets`).
    return {
        format: PORTABLE_PROFILE_FORMAT_V1,
        mode: ORCH_EXECUTION_MODE_SPEC,
        name,
        exportedAt,
        profile: createPortableProfileFromEditor(entry),
    };
}

export function extractImportedProfileForMode(imported) {
    if (imported.mode === ORCH_EXECUTION_MODE_DIRECTOR) return imported.director;
    if (imported.mode === ORCH_EXECUTION_MODE_AGENDA) return imported.agenda;
    if (imported.mode === ORCH_EXECUTION_MODE_LOOP) return imported.loop;
    return { spec: imported.spec, presets: imported.presets };
}

export function parseImportedProfilePayload(rawText) {
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

    // Director payloads: V3 format OR a profile envelope whose mode is
    // 'director' (some old exports may omit the format key but still set
    // mode). Recognized before spec/agenda so the dispatcher does not
    // misroute a director profile into the spec branch on heuristic alone.
    const isDirectorPayload = mode === ORCH_EXECUTION_MODE_DIRECTOR
        || String(parsed?.format || '') === PORTABLE_PROFILE_FORMAT_V3;
    if (isDirectorPayload) {
        if (!profile || typeof profile !== 'object') {
            throw new Error(i18n('Invalid profile file format.'));
        }
        // sanitizeDirectorProfile auto-detects legacy wrapped ({director:{...}})
        // and new flat ({mainAgent, subAgents, ...}) shapes and returns flat,
        // so old V3 exports keep importing cleanly after the flatten.
        return {
            mode: ORCH_EXECUTION_MODE_DIRECTOR,
            director: sanitizeDirectorProfile(profile),
        };
    }

    // Loop payloads: V4 format OR an envelope whose mode is 'loop'.
    // sanitizeLoopProfile is idempotent and tolerates the editor / on-disk
    // shape interchangeably, so we hand the profile straight through.
    const isLoopPayload = mode === ORCH_EXECUTION_MODE_LOOP
        || String(parsed?.format || '') === PORTABLE_PROFILE_FORMAT_V4;
    if (isLoopPayload) {
        if (!profile || typeof profile !== 'object') {
            throw new Error(i18n('Invalid profile file format.'));
        }
        return {
            mode: ORCH_EXECUTION_MODE_LOOP,
            loop: sanitizeLoopProfile(profile),
        };
    }

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
