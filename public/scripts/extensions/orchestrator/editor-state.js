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
 * UI-session fields (`aiGoal`, `aiIterationSession`,
 * `orchEditorPopupContentId`) — the popups share a single state object
 * so the orchestrator UI can be rebuilt with one snapshot. Editor-only
 * consumers read the four `*Editor` fields and the two `*DisplayedScope`
 * fields; non-editor consumers manage their own slots on the same
 * object.
 *
 * Read-only display helpers (label formatting, scope-from-element)
 * live in `editor-display.js`. Persist + portable-profile creation
 * lives in `editor-persist.js`.
 */

import { extension_settings } from '../../extensions.js';
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_NODE_TYPE_WORKER,
    defaultSpec,
} from './defaults.js';
import {
    applyCharacterExecutionModeForAvatar,
    getCharacterAgendaOverrideByAvatar,
    getCharacterOverrideByAvatar,
    hasCharacterAgendaOverride,
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
import { getCurrentAvatar } from './snapshot-cache.js';

const MODULE_NAME = 'orchestrator';

function getSettings() {
    return extension_settings[MODULE_NAME];
}

export const uiState = {
    selectedAvatar: '',
    aiGoal: '',
    globalEditor: null,
    characterEditor: null,
    globalAgendaEditor: null,
    characterAgendaEditor: null,
    specDisplayedScope: 'global',
    agendaDisplayedScope: 'global',
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
    const presets = useOverride
        ? toEditablePresetMap(resolveOverridePresetMap(override, settings.presets))
        : toEditablePresetMap(settings.presets);
    const spec = toEditableSpec(useOverride ? override?.spec : settings.orchestrationSpec, presets);
    return {
        avatar: safeAvatar,
        enabled: useOverride ? Boolean(override?.enabled) : false,
        notes: useOverride ? String(override?.notes || '') : '',
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
    const profile = agendaOverride
        ? sanitizeAgendaWorkingProfile(agendaOverride)
        : cloneAgendaWorkingProfileFromSettings(settings);
    return {
        avatar: safeAvatar,
        enabled: Boolean(agendaOverride?.enabled),
        notes: String(agendaOverride?.notes || ''),
        planner: profile.planner,
        agents: profile.agents,
        finalAgentId: profile.finalAgentId,
        limits: profile.limits,
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
    ensureEditorIntegrity(uiState.globalEditor);
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.globalAgendaEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
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
    ensureEditorIntegrity(uiState.characterEditor);
    ensureAgendaEditorIntegrity(uiState.characterAgendaEditor);
    syncDisplayedScopesFromStoredState(context, getSettings());
}

export function getScopePreferenceStateKey(mode = ORCH_EXECUTION_MODE_SPEC) {
    return normalizeExecutionMode(mode) === ORCH_EXECUTION_MODE_AGENDA
        ? 'agendaDisplayedScope'
        : 'specDisplayedScope';
}

export function getStoredDisplayedScopeForMode(context, settings, mode = ORCH_EXECUTION_MODE_SPEC) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (normalizeExecutionMode(mode) === ORCH_EXECUTION_MODE_AGENDA) {
        return hasCharacterAgendaOverride(context, activeAvatar) ? 'character' : 'global';
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
}
