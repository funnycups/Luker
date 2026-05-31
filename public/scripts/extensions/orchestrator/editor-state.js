/**
 * Editor state holder for the orchestrator extension.
 *
 * Owns the shared `uiState` object that the editor panel, the
 * AI-iteration popup, and the runtime callbacks all read from and
 * mutate. Also owns the loaders that materialize
 * `uiState.{global,character}{,Agenda}Editor` from settings + character
 * overrides, plus the "displayed scope" preference that switches the
 * editor between global and character views.
 *
 * `uiState` intentionally bundles editor fields with non-editor
 * UI-session fields (`aiIterationSession`, `orchEditorPopupContentId`) —
 * the popups share a single state object so the orchestrator UI can be
 * rebuilt with one snapshot. Editor-only consumers read the four
 * `*Editor` fields and the two `*DisplayedScope` fields; non-editor
 * consumers manage their own slots on the same object.
 *
 * Read-only display helpers (label formatting, scope-from-element)
 * live in `editor-display.js`. Persist + portable-profile creation
 * lives in `editor-persist.js`.
 */

import { extension_settings } from '../../extensions.js';
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_NODE_TYPE_WORKER,
    createDefaultDirectorProfile,
    defaultLoopProfile,
    defaultSpec,
    sanitizeDirectorProfile,
} from './defaults.js';
import {
    applyCharacterExecutionModeForAvatar,
    getCharacterAgendaOverrideByAvatar,
    getCharacterDirectorOverrideByAvatar,
    getCharacterLoopOverrideByAvatar,
    getCharacterOverrideByAvatar,
    hasCharacterAgendaOverride,
    hasCharacterDirectorOverride,
    hasCharacterLoopOverride,
    hasCharacterSpecOverride,
    normalizeExecutionMode,
} from './character-overrides.js';
import {
    createPresetDraft,
    resolveOverridePresetMap,
    toEditablePresetMap,
    toEditableSpec,
} from './editable-spec.js';
import {
    cloneAgendaWorkingProfileFromSettings,
    ensureAgendaEditorIntegrity,
    sanitizeAgendaWorkingProfile,
} from './agenda-profile.js';
import { sanitizeLoopProfile } from './persistence.js';
import { getCurrentAvatar } from './snapshot-cache.js';

const MODULE_NAME = 'orchestrator';

function getSettings() {
    return extension_settings[MODULE_NAME];
}

export const uiState = {
    selectedAvatar: '',
    globalEditor: null,
    characterEditor: null,
    globalAgendaEditor: null,
    characterAgendaEditor: null,
    globalLoopEditor: null,
    characterLoopEditor: null,
    globalDirectorEditor: null,
    characterDirectorEditor: null,
    specDisplayedScope: 'global',
    agendaDisplayedScope: 'global',
    loopDisplayedScope: 'global',
    directorDisplayedScope: 'global',
    aiIterationSession: null,
    orchEditorPopupContentId: '',
};

export function ensureEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    if (!editor.presets || typeof editor.presets !== 'object' || Object.keys(editor.presets).length === 0) {
        editor.presets = {};
    }
    editor.spec = toEditableSpec(editor.spec || defaultSpec, editor.presets);
    editor.presets = toEditablePresetMap(editor.presets);
}

export function pickDefaultPreset(editor) {
    const keys = Object.keys(editor?.presets || {});
    if (keys.length === 0) {
        const presetId = 'distiller';
        editor.presets = {
            [presetId]: createPresetDraft(),
        };
        return presetId;
    }
    return keys[0];
}

export function createNewStage(editor) {
    const defaultPreset = pickDefaultPreset(editor);
    const index = (editor.spec?.stages?.length || 0) + 1;
    return {
        id: `stage_${index}`,
        mode: 'serial',
        nodes: [{
            id: defaultPreset,
            preset: defaultPreset,
            type: ORCH_NODE_TYPE_WORKER,
            userPromptTemplate: '',
        }],
    };
}

export function loadGlobalEditorState() {
    const settings = getSettings();
    const presets = toEditablePresetMap(settings.presets);
    const spec = toEditableSpec(settings.orchestrationSpec, presets);
    return { spec, presets };
}

export function loadCharacterEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const override = getCharacterOverrideByAvatar(context, safeAvatar);
    const useOverride = hasCharacterSpecOverride(context, safeAvatar);
    // Always merge override on top of the global base so partial overrides
    // inherit missing fields instead of getting filled with empty defaults
    // by the sanitizers. resolveOverridePresetMap already merges presets;
    // here we also fall back the top-level spec object key-by-key.
    const presets = useOverride
        ? toEditablePresetMap(resolveOverridePresetMap(override, settings.presets))
        : toEditablePresetMap(settings.presets);
    const globalSpecSource = settings.orchestrationSpec || defaultSpec;
    const overrideSpec = useOverride && override?.spec && typeof override.spec === 'object'
        ? override.spec
        : null;
    const specSource = overrideSpec
        ? { ...globalSpecSource, ...overrideSpec }
        : globalSpecSource;
    const spec = toEditableSpec(specSource, presets);
    return {
        avatar: safeAvatar,
        enabled: useOverride ? Boolean(override?.enabled) : false,
        spec,
        presets,
    };
}

export function loadGlobalAgendaEditorState() {
    return cloneAgendaWorkingProfileFromSettings(getSettings());
}

export function loadCharacterAgendaEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const agendaOverride = getCharacterAgendaOverrideByAvatar(context, safeAvatar);
    // Override merged on top of global base — fields the override doesn't
    // specify inherit from the global profile. Without this, a partial
    // override (e.g. only `{ enabled: true, planner: { systemPrompt } }`)
    // would replace the global agents with the sanitizer's default
    // single-finalizer fallback instead of keeping the global agent set.
    const globalBase = cloneAgendaWorkingProfileFromSettings(settings);
    const profile = agendaOverride
        ? sanitizeAgendaWorkingProfile({ ...globalBase, ...agendaOverride })
        : globalBase;
    return {
        avatar: safeAvatar,
        enabled: Boolean(agendaOverride?.enabled),
        planner: profile.planner,
        agents: profile.agents,
        finalAgentId: profile.finalAgentId,
        limits: profile.limits,
    };
}

/**
 * Ensure a loop-mode editor draft has the canonical V3 shape. Called
 * before render and after every input mutation so renderers can index
 * into `tools.note.open` etc. without optional-chain fallback noise.
 */
export function ensureLoopEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    const normalized = sanitizeLoopProfile(editor);
    editor.mode = normalized.mode;
    editor.apiPresetName = normalized.apiPresetName;
    editor.promptPresetName = normalized.promptPresetName;
    editor.system_prompt = normalized.system_prompt;
    editor.tools = normalized.tools;
    editor.max_rounds = normalized.max_rounds;
    editor.wall_clock_budget_ms = normalized.wall_clock_budget_ms;
    editor.capsule_inject = normalized.capsule_inject;
    editor.customTools = normalized.customTools;
}

/**
 * Load the global loop editor draft from settings. Falls back to
 * `defaultLoopProfile` when settings has no loopProfile key (fresh
 * install) so the editor always renders with reasonable defaults.
 */
export function loadGlobalLoopEditorState() {
    const settings = getSettings();
    const source = settings?.loopProfile && typeof settings.loopProfile === 'object'
        ? settings.loopProfile
        : defaultLoopProfile;
    return sanitizeLoopProfile(source);
}

/**
 * Load the per-character loop editor draft. When the character has a
 * persisted loop override, use it; otherwise seed from the global loop
 * profile so the editor has a sensible starting point. The returned
 * draft carries `enabled` like the spec/agenda character editors, so
 * save / clear flows can roundtrip that field.
 */
export function loadCharacterLoopEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const loopOverride = getCharacterLoopOverrideByAvatar(context, safeAvatar);
    // Override merged on top of global base — fields the override doesn't
    // specify (system_prompt, tools, max_rounds, etc.) inherit from the
    // global loop profile instead of falling back to LOOP_PROFILE_DEFAULTS.
    const globalBase = sanitizeLoopProfile(settings?.loopProfile || defaultLoopProfile);
    const baseProfile = loopOverride
        ? sanitizeLoopProfile({ ...globalBase, ...loopOverride })
        : globalBase;
    return {
        ...baseProfile,
        avatar: safeAvatar,
        enabled: Boolean(loopOverride?.enabled),
    };
}

/**
 * Ensure a director-mode editor draft has the canonical flat shape
 * (mainAgent / subAgents / limits / tools at top level). Called before
 * render and after every input mutation so renderers can index into
 * `editor.mainAgent.systemPrompt` etc. without optional-chain fallback
 * noise. The sanitizer is the single source of truth for the shape —
 * we mutate the editor object in place to match the sanitizer output,
 * preserving any non-director fields (avatar / enabled) that ride
 * along on character-scope editors.
 */
export function ensureDirectorEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    const normalized = sanitizeDirectorProfile(editor);
    editor.mode = normalized.mode;
    editor.mainAgent = normalized.mainAgent;
    editor.subAgents = normalized.subAgents;
    editor.maxRounds = normalized.maxRounds;
    editor.maxConcurrentSubagents = normalized.maxConcurrentSubagents;
    editor.maxTotalSubagentRuns = normalized.maxTotalSubagentRuns;
    editor.tools = normalized.tools;
    editor.discardOnAbort = normalized.discardOnAbort;
    editor.customTools = normalized.customTools;
    // Stale wrapper from any pre-flatten editor object — strip so the
    // editor draft is exclusively the new flat shape.
    delete editor.director;
}

/**
 * Load the global director editor draft from settings. Falls back to
 * `createDefaultDirectorProfile()` when settings has no directorProfile
 * key (fresh install) so the editor always renders with the canonical
 * default sub-agents.
 */
export function loadGlobalDirectorEditorState() {
    const settings = getSettings();
    const source = settings?.directorProfile && typeof settings.directorProfile === 'object'
        ? settings.directorProfile
        : createDefaultDirectorProfile();
    return sanitizeDirectorProfile(source);
}

/**
 * Load the per-character director editor draft. When the character has
 * a persisted director override, use it; otherwise seed from the global
 * director profile so the editor has a sensible starting point. The
 * returned draft carries `enabled` like the spec/agenda/loop character
 * editors, so save / clear flows can roundtrip that field.
 */
export function loadCharacterDirectorEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const directorOverride = getCharacterDirectorOverrideByAvatar(context, safeAvatar);
    // Override merged on top of global base. Without this, a partial
    // override (e.g. only `{ enabled: true, mainAgent: {} }`) would land
    // with an empty mainAgent.systemPrompt and zero sub-agents because
    // sanitizeDirectorProfile fills missing slots with empty defaults
    // rather than inheriting from the global director profile.
    const globalSource = settings?.directorProfile && typeof settings.directorProfile === 'object'
        ? settings.directorProfile
        : createDefaultDirectorProfile();
    const globalBase = sanitizeDirectorProfile(globalSource);
    if (!directorOverride) {
        return {
            ...globalBase,
            avatar: safeAvatar,
            enabled: false,
        };
    }
    // `directorOverride` is the bare flat sub-object stored on the card
    // (`override.director`) — `mainAgent` / `subAgents` / `maxRounds` /
    // etc. at top level. The sanitizer auto-detects the input shape and
    // lifts to flat output regardless, so we pass it straight through.
    const sanitizedOverride = sanitizeDirectorProfile(directorOverride);
    const merged = {
        ...globalBase,
        ...sanitizedOverride,
        mainAgent: {
            ...globalBase.mainAgent,
            ...sanitizedOverride.mainAgent,
            // Empty mainAgent.systemPrompt → fall back to global. The user
            // never wants a blank prompt out of a partial override; if they
            // truly want to disable the main agent they'd unbind the
            // override (Reset Character) rather than write `''` explicitly.
            systemPrompt: String(sanitizedOverride.mainAgent.systemPrompt || '').trim()
                ? sanitizedOverride.mainAgent.systemPrompt
                : globalBase.mainAgent.systemPrompt,
        },
        // Empty subAgents (override cleared or contained only invalid
        // entries) → fall back to global so the inherited sub-agent set
        // survives partial overrides.
        subAgents: Array.isArray(sanitizedOverride.subAgents) && sanitizedOverride.subAgents.length > 0
            ? sanitizedOverride.subAgents
            : globalBase.subAgents,
    };
    return {
        ...merged,
        avatar: safeAvatar,
        enabled: Boolean(directorOverride.enabled),
    };
}

export function initializeUiState(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar !== uiState.selectedAvatar) {
        applyCharacterExecutionModeForAvatar(context, getSettings(), activeAvatar);
    }
    uiState.selectedAvatar = activeAvatar;
    uiState.globalEditor = loadGlobalEditorState();
    uiState.characterEditor = loadCharacterEditorState(context, uiState.selectedAvatar);
    uiState.globalAgendaEditor = loadGlobalAgendaEditorState();
    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, uiState.selectedAvatar);
    uiState.globalLoopEditor = loadGlobalLoopEditorState();
    uiState.characterLoopEditor = loadCharacterLoopEditorState(context, uiState.selectedAvatar);
    uiState.globalDirectorEditor = loadGlobalDirectorEditorState();
    uiState.characterDirectorEditor = loadCharacterDirectorEditorState(context, uiState.selectedAvatar);
    ensureEditorIntegrity(uiState.globalEditor);
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
    ensureLoopEditorIntegrity(uiState.globalLoopEditor);
    ensureLoopEditorIntegrity(uiState.characterLoopEditor);
    ensureDirectorEditorIntegrity(uiState.globalDirectorEditor);
    ensureDirectorEditorIntegrity(uiState.characterDirectorEditor);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

export function syncCharacterEditorWithActiveAvatar(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar === uiState.selectedAvatar) {
        return;
    }
    applyCharacterExecutionModeForAvatar(context, getSettings(), activeAvatar);
    uiState.selectedAvatar = activeAvatar;
    uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
    uiState.characterAgendaEditor = loadCharacterAgendaEditorState(context, activeAvatar);
    uiState.characterLoopEditor = loadCharacterLoopEditorState(context, activeAvatar);
    uiState.characterDirectorEditor = loadCharacterDirectorEditorState(context, activeAvatar);
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
    ensureLoopEditorIntegrity(uiState.characterLoopEditor);
    ensureDirectorEditorIntegrity(uiState.characterDirectorEditor);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

export function getScopePreferenceStateKey(mode = ORCH_EXECUTION_MODE_SPEC) {
    const normalized = normalizeExecutionMode(mode);
    if (normalized === ORCH_EXECUTION_MODE_AGENDA) return 'agendaDisplayedScope';
    if (normalized === ORCH_EXECUTION_MODE_LOOP) return 'loopDisplayedScope';
    if (normalized === ORCH_EXECUTION_MODE_DIRECTOR) return 'directorDisplayedScope';
    return 'specDisplayedScope';
}

export function getStoredDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const normalized = normalizeExecutionMode(mode);
    if (normalized === ORCH_EXECUTION_MODE_AGENDA) {
        return hasCharacterAgendaOverride(context, activeAvatar) ? 'character' : 'global';
    }
    if (normalized === ORCH_EXECUTION_MODE_LOOP) {
        return hasCharacterLoopOverride(context, activeAvatar) ? 'character' : 'global';
    }
    if (normalized === ORCH_EXECUTION_MODE_DIRECTOR) {
        return hasCharacterDirectorOverride(context, activeAvatar) ? 'character' : 'global';
    }
    return hasCharacterSpecOverride(context, activeAvatar) ? 'character' : 'global';
}

export function setDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC, scope = '') {
    const key = getScopePreferenceStateKey(mode);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (scope === 'character' && activeAvatar) {
        uiState[key] = 'character';
        return uiState[key];
    }
    if (scope === 'global') {
        uiState[key] = 'global';
        return uiState[key];
    }
    uiState[key] = getStoredDisplayedScopeForMode(context, settings, mode);
    return uiState[key];
}

export function syncDisplayedScopesFromStoredState(context, settings) {
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_SPEC);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_AGENDA);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_LOOP);
    setDisplayedScopeForMode(context, settings, ORCH_EXECUTION_MODE_DIRECTOR);
}
