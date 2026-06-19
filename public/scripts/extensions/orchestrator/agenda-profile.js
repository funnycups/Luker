/**
 * Agenda working-profile model + budget helpers for the orchestrator.
 *
 * The "agenda" execution mode runs a planner that produces a TODO list,
 * dispatches each TODO to one or more agents, and converges via a final
 * agent. The runtime profile (`{ planner, agents, finalAgentId, limits }`)
 * is the canonical shape that runtime, editor, and AI iteration all
 * agree on.
 *
 * This module owns:
 *
 *   1. The runtime budget readers (`getAgendaPlannerMaxRounds`,
 *      `getAgendaMaxConcurrentAgents`, `getAgendaMaxTotalRuns`) that
 *      pin global defaults at runtime; bounds match the limits the
 *      sanitizer enforces.
 *   2. The available-agents prompt block builder
 *      (`buildAgendaAvailableAgentsText`) used by the planner prompt.
 *   3. `sanitizeAgendaWorkingProfile` — the canonical normalizer. Coerces
 *      planner / agents / finalAgentId / limits into the runtime shape,
 *      clones over `defaultAgendaAgents.finalizer` when no agents are
 *      defined, and clamps each limit to the same bounds the budget
 *      readers enforce.
 *   4. `cloneAgendaWorkingProfileFromSettings` / `cloneAgendaWorkingProfileFromEditor`
 *      — the two factories that bridge persistence-shape and editor-shape
 *      respectively into a runtime profile.
 *   5. `buildAgendaProfileForRuntime` — wraps a sanitized profile in the
 *      runtime envelope (`{ source: 'agenda', mode: ORCH_EXECUTION_MODE_AGENDA, … }`)
 *      that runtime callers expect alongside spec-mode profiles.
 *   6. `ensureAgendaEditorIntegrity` — in-place mutator that re-applies
 *      `sanitizeAgendaWorkingProfile` to an editor draft and preserves
 *      the editor-only fields (`avatar`, `enabled`).
 */

const extension_settings = Luker.getContext().extensionSettings;
import {
    ORCH_EXECUTION_MODE_AGENDA,
    defaultAgendaAgents,
} from './defaults.js';
import {
    createAgendaPlannerDraft,
    sanitizeIdentifierToken,
    sanitizePresetMap,
} from './editable-spec.js';
import { sanitizeAgentToolFlags, seedDefaultLayer2Customs } from './persistence.js';
import { toReadableYamlText } from './output-formatting.js';
import { sanitizeCustomTools } from './custom-tools-sanitize.js';

const MODULE_NAME = 'orchestrator';

export function getAgendaPlannerMaxRounds(source = extension_settings[MODULE_NAME]) {
    return Math.max(1, Math.floor(Number(source?.agendaPlannerMaxRounds) || 6));
}

export function getAgendaMaxConcurrentAgents(source = extension_settings[MODULE_NAME]) {
    return Math.max(1, Math.floor(Number(source?.agendaMaxConcurrentAgents) || 3));
}

export function getAgendaMaxTotalRuns(source = extension_settings[MODULE_NAME]) {
    return Math.max(1, Math.floor(Number(source?.agendaMaxTotalRuns) || 24));
}

export function buildAgendaAvailableAgentsText(profile = {}) {
    const agents = profile?.agents && typeof profile.agents === 'object' ? profile.agents : {};
    const catalog = Object.entries(agents)
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([agentId, preset]) => ({
            agent: String(agentId || ''),
            system_prompt: String(preset?.systemPrompt || ''),
            user_prompt_template: String(preset?.userPromptTemplate || ''),
        }));
    return [
        '## available_agents',
        '```yaml',
        toReadableYamlText({
            final_agent_id: String(profile?.finalAgentId || ''),
            agents: catalog,
        }, '{}'),
        '```',
    ].join('\n');
}

export function sanitizeAgendaWorkingProfile(workingProfile = null) {
    const source = workingProfile && typeof workingProfile === 'object' ? workingProfile : {};
    const limitsSource = source?.limits && typeof source.limits === 'object' ? source.limits : source;
    const planner = createAgendaPlannerDraft(
        source?.planner && typeof source.planner === 'object'
            ? source.planner
            : {
                systemPrompt: source?.plannerSystemPrompt,
                userPromptTemplate: source?.plannerPrompt,
                apiPresetName: source?.plannerApiPresetName,
                promptPresetName: source?.plannerPromptPresetName,
            },
    );
    const agents = sanitizePresetMap(source?.agents);
    if (Object.keys(agents).length === 0) {
        agents.finalizer = structuredClone(defaultAgendaAgents.finalizer);
    }
    const finalAgentId = sanitizeIdentifierToken(
        source?.finalAgentId,
        agents.finalizer ? 'finalizer' : (Object.keys(agents)[0] || 'finalizer'),
    );
    return {
        planner,
        agents,
        finalAgentId: agents[finalAgentId]
            ? finalAgentId
            : (agents.finalizer ? 'finalizer' : (Object.keys(agents)[0] || 'finalizer')),
        limits: {
            plannerMaxRounds: Math.max(1, Math.floor(Number(limitsSource?.plannerMaxRounds) || 6)),
            maxConcurrentAgents: Math.max(1, Math.floor(Number(limitsSource?.maxConcurrentAgents) || 3)),
            maxTotalRuns: Math.max(1, Math.floor(Number(limitsSource?.maxTotalRuns) || 24)),
        },
        // null = no profile-level default (every agent inherits the
        // mode's all-off built-in unless they set their own `tools`).
        // An object = "use these flags as the fallback for any agent
        // that doesn't override". Per-agent `tools` lives on
        // `agents[id].tools` and takes precedence.
        //
        // Fresh profile (defaultTools key missing from source) gets the
        // Layer-2 customs seed so memory + search ship enabled out of
        // the box. Explicit null is preserved as-is so callers that
        // really want a no-tools default keep that option.
        defaultTools: sanitizeAgendaProfileDefaultTools(source),
        customTools: sanitizeCustomTools(source?.customTools),
        // Mode-level skills. Defaults to wildcard so all installed skills
        // are visible to every agent until the user narrows. Inline shape
        // normalizer; see director-defaults.js for rationale on not
        // importing skill-resolution.js here.
        skills: source?.skills && typeof source.skills === 'object'
            ? {
                visible: Array.isArray(source.skills.visible) ? source.skills.visible.slice() : ['*'],
                deny: Array.isArray(source.skills.deny) ? source.skills.deny.slice() : [],
            }
            : { visible: ['*'], deny: [] },
    };
}

function sanitizeAgendaProfileDefaultTools(source) {
    const hasKey = source && Object.prototype.hasOwnProperty.call(source, 'defaultTools');
    if (!hasKey) {
        // Fresh profile — seed the Layer-2 customs default-on so
        // memory + search are available to every agent unless overridden.
        const seeded = seedDefaultLayer2Customs({});
        return sanitizeAgentToolFlags(seeded);
    }
    const raw = source.defaultTools;
    if (raw === null) {
        // Explicit caller-chosen null — preserve.
        return null;
    }
    if (raw === undefined) {
        // Explicit undefined behaves like missing.
        const seeded = seedDefaultLayer2Customs({});
        return sanitizeAgentToolFlags(seeded);
    }
    // Object form: merge customs seed in (caller's explicit keys win).
    const seeded = seedDefaultLayer2Customs(raw);
    return sanitizeAgentToolFlags(seeded);
}

export function ensureAgendaEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    const normalized = sanitizeAgendaWorkingProfile(editor);
    editor.planner = normalized.planner;
    editor.agents = normalized.agents;
    editor.finalAgentId = normalized.finalAgentId;
    editor.limits = normalized.limits;
    editor.defaultTools = normalized.defaultTools;
    editor.customTools = normalized.customTools;
    editor.skills = normalized.skills;
    if ('avatar' in editor) {
        editor.avatar = String(editor.avatar || '');
    }
    if ('enabled' in editor) {
        editor.enabled = Boolean(editor.enabled);
    }
}

export function cloneAgendaWorkingProfileFromSettings(settings) {
    return sanitizeAgendaWorkingProfile({
        planner: settings?.agendaPlanner || {
            userPromptTemplate: settings?.agendaPlannerPrompt,
        },
        agents: sanitizePresetMap(settings?.agendaAgents),
        finalAgentId: sanitizeIdentifierToken(settings?.agendaFinalAgentId, 'finalizer'),
        limits: {
            plannerMaxRounds: Number(settings?.agendaPlannerMaxRounds || 6),
            maxConcurrentAgents: Number(settings?.agendaMaxConcurrentAgents || 3),
            maxTotalRuns: Number(settings?.agendaMaxTotalRuns || 24),
        },
    });
}

export function cloneAgendaWorkingProfileFromEditor(editor) {
    ensureAgendaEditorIntegrity(editor);
    return sanitizeAgendaWorkingProfile(editor);
}

export function buildAgendaProfileForRuntime(workingProfile = null) {
    const profile = sanitizeAgendaWorkingProfile(workingProfile);
    return {
        source: 'agenda',
        key: 'agenda_iteration',
        mode: ORCH_EXECUTION_MODE_AGENDA,
        planner: profile.planner,
        agents: profile.agents,
        finalAgentId: profile.finalAgentId,
        limits: {
            plannerMaxRounds: profile.limits.plannerMaxRounds,
            maxConcurrentAgents: profile.limits.maxConcurrentAgents,
            maxTotalRuns: profile.limits.maxTotalRuns,
        },
        defaultTools: profile.defaultTools,
        skills: profile.skills,
    };
}
