/**
 * Editor persistence for the orchestrator extension.
 *
 * Owns the side-effecting "write the editor's current state to settings
 * or to the character card" path. Two persistence backends are involved:
 *
 *   1. Global profiles live in `extension_settings.orchestrator` and are
 *      flushed via `saveSettings()`. Handled by
 *      `persistGlobalEditorFrom` (spec mode) and
 *      `persistGlobalAgendaEditorFrom` (agenda mode).
 *
 *   2. Character overrides live on the active character card under
 *      `data.extensions.orchestrator` and are POSTed to
 *      `/api/characters/edit-attribute`. Handled by
 *      `persistCharacterEditor` (spec mode) and
 *      `persistCharacterAgendaEditor` (agenda mode), both of which
 *      delegate the actual character-card write to
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

import { getRequestHeaders, saveSettings } from '../../../script.js';
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_SPEC,
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
import { cloneJsonCompatible } from './spec-schema.js';
import { ensureEditorIntegrity } from './editor-state.js';

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

    character.data = character.data || {};
    character.data.extensions = nextExtensions;

    if (Number(context?.characterId) === id && character.json_data) {
        try {
            const jsonData = JSON.parse(character.json_data);
            jsonData.data = jsonData.data || {};
            jsonData.data.extensions = nextExtensions;
            character.json_data = JSON.stringify(jsonData);
            jQuery('#character_json_data').val(character.json_data);
        } catch {
            // Ignore malformed json_data snapshots.
        }
    }

    const response = await fetch('/api/characters/edit-attribute', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: String(character.name || '').trim() || 'character',
            avatar_url: character.avatar,
            field: 'extensions',
            value: nextExtensions,
        }),
    });

    if (!response.ok) {
        console.error('Failed to persist orchestrator extension data to character card', response.statusText);
    }
    return response.ok;
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
