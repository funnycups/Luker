/**
 * Editor persistence for the orchestrator extension.
 *
 * Owns the side-effecting "write the editor's current state to settings
 * or to the character card" path. Two persistence backends are involved:
 *
 *   1. Global profiles live in `extension_settings.orchestrator` and are
 *      flushed via `saveSettings()`. Handled by
 *      `persistGlobalEditorFrom` (spec mode),
 *      `persistGlobalAgendaEditorFrom` (agenda mode), and
 *      `persistGlobalLoopEditorFrom` (loop mode).
 *
 *   2. Character overrides live on the active character card under
 *      `data.extensions.orchestrator` and are persisted via
 *      `updateCharacterData`. Handled by
 *      `persistCharacterEditor` (spec mode),
 *      `persistCharacterAgendaEditor` (agenda mode), and
 *      `persistCharacterLoopEditor` (loop mode); all delegate the
 *      actual character-card write to
 *      `persistOrchestratorCharacterExtension`.
 *
 * `createPortableProfileFromEditor` and
 * `createPortableAgendaProfileFromEditor` turn an editor draft into a
 * JSON-serializable payload for the import/export flow.
 *
 * Callers must pass the editor draft explicitly. These functions never
 * read `uiState` — the orchestrator UI in `main.js` owns the binding
 * between scope ("global" vs "character") and which editor draft to
 * persist.
 */

import { saveSettings, updateCharacterData } from '../../../script.js';
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SPEC,
    sanitizeDirectorProfile,
} from './defaults.js';
import {
    getCharacterDisplayNameByAvatar,
    getCharacterExtensionDataByAvatar,
    getCharacterIndexByAvatar,
    normalizeCharacterOverrideMode,
} from './character-overrides.js';
import {
    createAgendaPlannerDraft,
    sanitizeIdentifierToken,
    sanitizePresetMap,
    serializeEditorPresetMap,
    serializeEditorSpec,
} from './editable-spec.js';
import {
    ensureAgendaEditorIntegrity,
    sanitizeAgendaWorkingProfile,
} from './agenda-profile.js';
import { sanitizeLoopProfile } from './persistence.js';
import { cloneJsonCompatible } from './spec-schema.js';
import { ensureDirectorEditorIntegrity, ensureEditorIntegrity } from './editor-state.js';

const MODULE_NAME = 'orchestrator';

export async function persistGlobalEditorFrom(settings, editor) {
    ensureEditorIntegrity(editor);
    settings.orchestrationSpec = serializeEditorSpec(editor.spec);
    settings.presets = serializeEditorPresetMap(editor.presets);
    await saveSettings();
}

export async function persistGlobalAgendaEditorFrom(settings, editor) {
    ensureAgendaEditorIntegrity(editor);
    settings.agendaPlanner = createAgendaPlannerDraft(editor.planner);
    delete settings.agendaPlannerPrompt;
    settings.agendaAgents = sanitizePresetMap(editor.agents);
    settings.agendaFinalAgentId = sanitizeIdentifierToken(editor.finalAgentId, 'finalizer');
    settings.agendaPlannerMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(editor?.limits?.plannerMaxRounds) || 6)));
    settings.agendaMaxConcurrentAgents = Math.max(1, Math.min(12, Math.floor(Number(editor?.limits?.maxConcurrentAgents) || 3)));
    settings.agendaMaxTotalRuns = Math.max(1, Math.min(200, Math.floor(Number(editor?.limits?.maxTotalRuns) || 24)));
    if (!settings.agendaAgents[settings.agendaFinalAgentId]) {
        settings.agendaFinalAgentId = Object.keys(settings.agendaAgents)[0] || 'finalizer';
    }
    await saveSettings();
}

/**
 * Persist a loop-mode editor draft to global settings. Funnels through
 * `sanitizeLoopProfile` so the on-disk shape always matches the V3
 * schema (mode literal, finalize forced true, numeric clamps applied)
 * regardless of how the editor mutated the draft.
 */
export async function persistGlobalLoopEditorFrom(settings, editor) {
    settings.loopProfile = sanitizeLoopProfile(editor);
    await saveSettings();
}

/**
 * Persist a director-mode editor draft to global settings. Funnels
 * through `sanitizeDirectorProfile` so the on-disk shape always
 * matches the canonical director schema (mainAgent / subAgents /
 * limits / tools, with `tools.finalize` forced false) regardless of
 * how the editor mutated the draft.
 */
export async function persistGlobalDirectorEditorFrom(settings, editor) {
    settings.directorProfile = sanitizeDirectorProfile(editor);
    await saveSettings();
}

export async function persistCharacterEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
    notes = null,
} = {}) {
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureEditorIntegrity(editor);
    const characterPresets = serializeEditorPresetMap(editor.presets);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    const overridePayload = {
        ...previousOverride,
        mode: ORCH_EXECUTION_MODE_SPEC,
        enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
        spec: serializeEditorSpec(editor.spec),
        presets: characterPresets,
        updatedAt: Date.now(),
        name: getCharacterDisplayNameByAvatar(context, target),
        notes: sourceNotes,
    };
    delete overridePayload.presetPatch;

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(overridePayload),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

export async function persistCharacterAgendaEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
    notes = null,
} = {}) {
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureAgendaEditorIntegrity(editor);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    const overridePayload = {
        ...previousOverride,
        mode: ORCH_EXECUTION_MODE_AGENDA,
        agenda: {
            enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
            planner: createAgendaPlannerDraft(editor.planner),
            agents: sanitizePresetMap(editor.agents),
            finalAgentId: sanitizeIdentifierToken(editor.finalAgentId, 'finalizer'),
            limits: {
                plannerMaxRounds: Math.max(1, Math.min(20, Math.floor(Number(editor?.limits?.plannerMaxRounds) || 6))),
                maxConcurrentAgents: Math.max(1, Math.min(12, Math.floor(Number(editor?.limits?.maxConcurrentAgents) || 3))),
                maxTotalRuns: Math.max(1, Math.min(200, Math.floor(Number(editor?.limits?.maxTotalRuns) || 24))),
            },
            updatedAt: Date.now(),
            name: getCharacterDisplayNameByAvatar(context, target),
            notes: sourceNotes,
        },
    };

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(overridePayload),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Persist a loop-mode editor draft as a character override. Mirrors
 * `persistCharacterAgendaEditor`: writes to `override.loop` on the
 * character card, normalizes the active mode, and routes through
 * `persistOrchestratorCharacterExtension` for the network write.
 *
 * The loop sub-payload runs through `sanitizeLoopProfile` so the on-card
 * shape matches the V3 schema regardless of how the editor mutated the
 * draft, then carries the editor's `enabled`, `notes`, and `name` fields
 * alongside the V3 profile fields.
 */
export async function persistCharacterLoopEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
    notes = null,
} = {}) {
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    const sanitizedProfile = sanitizeLoopProfile(editor);
    const overridePayload = {
        ...previousOverride,
        mode: ORCH_EXECUTION_MODE_LOOP,
        loop: {
            ...sanitizedProfile,
            enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
            updatedAt: Date.now(),
            name: getCharacterDisplayNameByAvatar(context, target),
            notes: sourceNotes,
        },
    };

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(overridePayload),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Persist a director-mode editor draft as a character override.
 * Mirrors `persistCharacterLoopEditor`: writes to `override.director`
 * on the character card, normalizes the active mode, and routes
 * through `persistOrchestratorCharacterExtension` for the network
 * write.
 *
 * The director sub-payload runs through `sanitizeDirectorProfile` so
 * the on-card shape matches the canonical schema regardless of how the
 * editor mutated the draft, then carries the editor's `enabled`,
 * `notes`, and `name` fields alongside the profile fields.
 */
export async function persistCharacterDirectorEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
    notes = null,
} = {}) {
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    const sanitizedProfile = sanitizeDirectorProfile(editor);
    const overridePayload = {
        ...previousOverride,
        mode: ORCH_EXECUTION_MODE_DIRECTOR,
        director: {
            // sanitizeDirectorProfile returns { mode, director: {...} }
            // — we want the inner director object as the sub-payload
            // (the outer mode is set explicitly above on the override
            // wrapper). Spread the inner shape, then attach the
            // character-override metadata.
            ...sanitizedProfile.director,
            enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
            updatedAt: Date.now(),
            name: getCharacterDisplayNameByAvatar(context, target),
            notes: sourceNotes,
        },
    };

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(overridePayload),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

export async function persistOrchestratorCharacterExtension(context, characterIndex, modulePayload) {
    const id = Number(characterIndex);
    const character = Number.isInteger(id) ? context?.characters?.[id] : null;
    if (!character) {
        return false;
    }

    const nextExtensions = cloneJsonCompatible(character?.data?.extensions ?? {});
    if (modulePayload && typeof modulePayload === 'object') {
        nextExtensions[MODULE_NAME] = modulePayload;
    } else {
        delete nextExtensions[MODULE_NAME];
    }

    try {
        await updateCharacterData(id, { 'extensions': nextExtensions }, { immediate: true });
        return true;
    } catch (error) {
        console.error('Failed to persist orchestrator extension data to character card', error);
        return false;
    }
}

export function createPortableProfileFromEditor(editor) {
    ensureEditorIntegrity(editor);
    return {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    };
}

export function createPortableAgendaProfileFromEditor(editor) {
    ensureAgendaEditorIntegrity(editor);
    return sanitizeAgendaWorkingProfile(editor);
}
