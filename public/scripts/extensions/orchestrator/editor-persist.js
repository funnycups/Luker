/**
 * Editor persistence for the orchestrator extension.
 *
 * Owns the side-effecting "write the editor's current state to settings
 * or to the character card" path. Two persistence backends are involved:
 *
 *   1. Global profiles live in `extension_settings.orchestrator` under
 *      the per-mode preset library shape (`presetLibraries.<mode>`)
 *      and are flushed via `saveSettings()`. The global persistors
 *      (`persistGlobalEditorFrom`, `persistGlobalAgendaEditorFrom`,
 *      `persistGlobalLoopEditorFrom`, `persistGlobalDirectorEditorFrom`)
 *      write into the active preset slot via `writeActivePreset`.
 *
 *   2. Character overrides live on the active character card under
 *      `data.extensions.orchestrator` and are persisted via
 *      `context.writeExtensionField` (which scopes the write to this
 *      plugin's key only). Handled by `persistCharacterEditor` (spec
 *      mode), `persistCharacterAgendaEditor` (agenda mode),
 *      `persistCharacterLoopEditor` (loop mode), and
 *      `persistCharacterDirectorEditor` (director mode). Each writes
 *      into the active slot of the card-scoped `presetLibraries.<mode>`
 *      and atomically strips any legacy `override.<mode>` payload from
 *      the same write so on-card data migrates to the new shape on next
 *      save. All character writes delegate to
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

const __ctx = SillyTavern.getContext();
const saveSettings = __ctx.saveSettings;
const UNSET_VALUE = __ctx.constants.unset;
import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SPEC,
    sanitizeDirectorProfile,
} from './defaults.js';
import {
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
import { ensureDirectorEditorIntegrity, ensureEditorIntegrity } from './editor-state.js';
import { writeActivePreset } from './preset-library.js';

const MODULE_NAME = 'orchestrator';

export async function persistGlobalEditorFrom(settings, editor) {
    ensureEditorIntegrity(editor);
    writeActivePreset(settings, ORCH_EXECUTION_MODE_SPEC, 'global', {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    });
    await saveSettings();
}

export async function persistGlobalAgendaEditorFrom(settings, editor) {
    ensureAgendaEditorIntegrity(editor);
    writeActivePreset(settings, ORCH_EXECUTION_MODE_AGENDA, 'global', {
        planner: createAgendaPlannerDraft(editor.planner),
        agents: sanitizePresetMap(editor.agents),
        finalAgentId: sanitizeIdentifierToken(editor.finalAgentId, 'finalizer'),
        limits: {
            plannerMaxRounds: Math.max(1, Math.min(20, Math.floor(Number(editor?.limits?.plannerMaxRounds) || 6))),
            maxConcurrentAgents: Math.max(1, Math.min(12, Math.floor(Number(editor?.limits?.maxConcurrentAgents) || 3))),
            maxTotalRuns: Math.max(1, Math.min(200, Math.floor(Number(editor?.limits?.maxTotalRuns) || 24))),
        },
    });
    await saveSettings();
}

/**
 * Persist a loop-mode editor draft to global settings. Funnels through
 * `sanitizeLoopProfile` so the on-disk shape always matches the V3
 * schema (mode literal, finalize forced true, numeric clamps applied)
 * regardless of how the editor mutated the draft.
 */
export async function persistGlobalLoopEditorFrom(settings, editor) {
    const sanitized = sanitizeLoopProfile(editor);
    writeActivePreset(settings, ORCH_EXECUTION_MODE_LOOP, 'global', sanitized);
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
    const sanitized = sanitizeDirectorProfile(editor);
    writeActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, 'global', sanitized);
    await saveSettings();
}

export async function persistCharacterEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
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
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const enabledFlag = forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled);

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousLibraries = previous?.presetLibraries && typeof previous.presetLibraries === 'object'
        ? structuredClone(previous.presetLibraries)
        : { spec: {}, agenda: {}, loop: {}, director: {} };
    const previousActiveIds = previous?.activePresetIds && typeof previous.activePresetIds === 'object'
        ? structuredClone(previous.activePresetIds)
        : { spec: '', agenda: '', loop: '', director: '' };

    const sanitizedPayload = {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    };
    if (!previousLibraries.spec || Object.keys(previousLibraries.spec).length === 0) {
        previousLibraries.spec = { default: { name: 'Default', ...sanitizedPayload } };
        previousActiveIds.spec = 'default';
    } else {
        const activeId = previousActiveIds.spec && previousLibraries.spec[previousActiveIds.spec]
            ? previousActiveIds.spec
            : Object.keys(previousLibraries.spec)[0];
        const prev = previousLibraries.spec[activeId] || {};
        previousLibraries.spec[activeId] = { name: prev.name || 'Default', ...sanitizedPayload };
        previousActiveIds.spec = activeId;
    }

    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    previousOverride.mode = ORCH_EXECUTION_MODE_SPEC;
    previousOverride.enabled = enabledFlag;
    delete previousOverride.spec;
    delete previousOverride.presets;
    delete previousOverride.presetPatch;

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(previousOverride),
        presetLibraries: previousLibraries,
        activePresetIds: previousActiveIds,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

export async function persistCharacterAgendaEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
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
    const enabledFlag = forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled);

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousLibraries = previous?.presetLibraries && typeof previous.presetLibraries === 'object'
        ? structuredClone(previous.presetLibraries)
        : { spec: {}, agenda: {}, loop: {}, director: {} };
    const previousActiveIds = previous?.activePresetIds && typeof previous.activePresetIds === 'object'
        ? structuredClone(previous.activePresetIds)
        : { spec: '', agenda: '', loop: '', director: '' };

    const sanitizedPayload = {
        planner: createAgendaPlannerDraft(editor.planner),
        agents: sanitizePresetMap(editor.agents),
        finalAgentId: sanitizeIdentifierToken(editor.finalAgentId, 'finalizer'),
        limits: {
            plannerMaxRounds: Math.max(1, Math.min(20, Math.floor(Number(editor?.limits?.plannerMaxRounds) || 6))),
            maxConcurrentAgents: Math.max(1, Math.min(12, Math.floor(Number(editor?.limits?.maxConcurrentAgents) || 3))),
            maxTotalRuns: Math.max(1, Math.min(200, Math.floor(Number(editor?.limits?.maxTotalRuns) || 24))),
        },
    };
    if (!previousLibraries.agenda || Object.keys(previousLibraries.agenda).length === 0) {
        previousLibraries.agenda = { default: { name: 'Default', ...sanitizedPayload } };
        previousActiveIds.agenda = 'default';
    } else {
        const activeId = previousActiveIds.agenda && previousLibraries.agenda[previousActiveIds.agenda]
            ? previousActiveIds.agenda
            : Object.keys(previousLibraries.agenda)[0];
        const prev = previousLibraries.agenda[activeId] || {};
        previousLibraries.agenda[activeId] = { name: prev.name || 'Default', ...sanitizedPayload };
        previousActiveIds.agenda = activeId;
    }

    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    previousOverride.mode = ORCH_EXECUTION_MODE_AGENDA;
    previousOverride.enabled = enabledFlag;
    delete previousOverride.agenda;

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(previousOverride),
        presetLibraries: previousLibraries,
        activePresetIds: previousActiveIds,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Persist a loop-mode editor draft as a character override. Writes into
 * the active slot of `presetLibraries.loop` on the character card,
 * strips any legacy `override.loop` payload from the same write (atomic
 * migration to the new shape), normalizes the active mode, and routes
 * through `persistOrchestratorCharacterExtension` for the network
 * write.
 *
 * The loop payload runs through `sanitizeLoopProfile` so the on-card
 * shape matches the V3 schema regardless of how the editor mutated the
 * draft. The preset entry's `name` is preserved across the rewrite; if
 * the card has no library yet, a `default` slot is synthesized.
 */
export async function persistCharacterLoopEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
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
    const enabledFlag = forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled);

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousLibraries = previous?.presetLibraries && typeof previous.presetLibraries === 'object'
        ? structuredClone(previous.presetLibraries)
        : { spec: {}, agenda: {}, loop: {}, director: {} };
    const previousActiveIds = previous?.activePresetIds && typeof previous.activePresetIds === 'object'
        ? structuredClone(previous.activePresetIds)
        : { spec: '', agenda: '', loop: '', director: '' };

    const sanitizedProfile = sanitizeLoopProfile(editor);
    if (!previousLibraries.loop || Object.keys(previousLibraries.loop).length === 0) {
        previousLibraries.loop = { default: { name: 'Default', ...sanitizedProfile } };
        previousActiveIds.loop = 'default';
    } else {
        const activeId = previousActiveIds.loop && previousLibraries.loop[previousActiveIds.loop]
            ? previousActiveIds.loop
            : Object.keys(previousLibraries.loop)[0];
        const prev = previousLibraries.loop[activeId] || {};
        previousLibraries.loop[activeId] = { name: prev.name || 'Default', ...sanitizedProfile };
        previousActiveIds.loop = activeId;
    }

    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    previousOverride.mode = ORCH_EXECUTION_MODE_LOOP;
    previousOverride.enabled = enabledFlag;
    delete previousOverride.loop;

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(previousOverride),
        presetLibraries: previousLibraries,
        activePresetIds: previousActiveIds,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Persist a director-mode editor draft as a character override. Writes
 * into the active slot of `presetLibraries.director` on the character
 * card, strips any legacy `override.director` payload from the same
 * write (atomic migration to the new shape), normalizes the active
 * mode, and routes through `persistOrchestratorCharacterExtension`
 * for the network write.
 *
 * The director payload runs through `sanitizeDirectorProfile` so the
 * on-card shape matches the canonical schema regardless of how the
 * editor mutated the draft. Only the canonical profile fields are
 * persisted (no editor passthrough like avatar / mode), and the preset
 * entry's `name` is preserved across the rewrite.
 */
export async function persistCharacterDirectorEditor(context, settings, avatar, {
    editor,
    forceEnabled = null,
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
    const enabledFlag = forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled);

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousLibraries = previous?.presetLibraries && typeof previous.presetLibraries === 'object'
        ? structuredClone(previous.presetLibraries)
        : { spec: {}, agenda: {}, loop: {}, director: {} };
    const previousActiveIds = previous?.activePresetIds && typeof previous.activePresetIds === 'object'
        ? structuredClone(previous.activePresetIds)
        : { spec: '', agenda: '', loop: '', director: '' };

    const sanitizedProfile = sanitizeDirectorProfile(editor);
    // Explicitly list the director payload fields so the on-card shape
    // never accidentally carries editor passthrough (avatar / mode etc.).
    const sanitizedPayload = {
        mainAgent: sanitizedProfile.mainAgent,
        subAgents: sanitizedProfile.subAgents,
        maxRounds: sanitizedProfile.maxRounds,
        maxConcurrentSubagents: sanitizedProfile.maxConcurrentSubagents,
        maxTotalSubagentRuns: sanitizedProfile.maxTotalSubagentRuns,
        tools: sanitizedProfile.tools,
        discardOnAbort: sanitizedProfile.discardOnAbort,
    };
    if (!previousLibraries.director || Object.keys(previousLibraries.director).length === 0) {
        previousLibraries.director = { default: { name: 'Default', ...sanitizedPayload } };
        previousActiveIds.director = 'default';
    } else {
        const activeId = previousActiveIds.director && previousLibraries.director[previousActiveIds.director]
            ? previousActiveIds.director
            : Object.keys(previousLibraries.director)[0];
        const prev = previousLibraries.director[activeId] || {};
        previousLibraries.director[activeId] = { name: prev.name || 'Default', ...sanitizedPayload };
        previousActiveIds.director = activeId;
    }

    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? structuredClone(previous.override)
        : {};
    previousOverride.mode = ORCH_EXECUTION_MODE_DIRECTOR;
    previousOverride.enabled = enabledFlag;
    delete previousOverride.director;

    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(previousOverride),
        presetLibraries: previousLibraries,
        activePresetIds: previousActiveIds,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Flip the per-character "override enabled" flag for one execution mode
 * without disturbing the rest of the override payload.
 *
 * Runtime resolution (`getEffectiveProfile`) already falls back to the
 * global profile when `<override>?.enabled` is false, so these helpers
 * are the minimum surface needed to let the panel offer a switch
 * alongside the "configured, currently disabled" status label: the
 * stored spec / agenda / loop / director payload is preserved as-is
 * for re-enabling later.
 *
 *   - Spec mode stores `enabled` at the override root
 *     (`override.enabled`); the other three modes store it on their
 *     sub-object (`override.agenda.enabled`, `override.loop.enabled`,
 *     `override.director.enabled`).
 *   - Returns `false` and writes nothing when the matching payload is
 *     absent, so a stray click on a hidden control cannot synthesize
 *     an empty record.
 *   - Touches `updatedAt` on the affected layer only.
 */
async function setCharacterOverrideEnabledForMode(context, avatar, nextEnabled, {
    hasPayload,
    apply,
}) {
    const target = String(avatar || '');
    if (!target) return false;
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) return false;
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? previous.override
        : null;
    if (!previousOverride || !hasPayload(previousOverride)) return false;
    const nextOverride = structuredClone(previousOverride);
    apply(nextOverride, Boolean(nextEnabled));
    const nextPayload = {
        ...previous,
        override: normalizeCharacterOverrideMode(nextOverride),
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

export async function setCharacterSpecOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterOverrideEnabledForMode(context, avatar, nextEnabled, {
        hasPayload: (override) =>
            (override.spec && typeof override.spec === 'object')
            || (override.presets && typeof override.presets === 'object')
            || (override.presetPatch && typeof override.presetPatch === 'object'),
        apply(override, value) {
            override.enabled = value;
            override.updatedAt = Date.now();
        },
    });
}

export async function setCharacterAgendaOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterOverrideEnabledForMode(context, avatar, nextEnabled, {
        hasPayload: (override) => override.agenda && typeof override.agenda === 'object',
        apply(override, value) {
            override.agenda.enabled = value;
            override.agenda.updatedAt = Date.now();
        },
    });
}

export async function setCharacterLoopOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterOverrideEnabledForMode(context, avatar, nextEnabled, {
        hasPayload: (override) => override.loop && typeof override.loop === 'object',
        apply(override, value) {
            override.loop.enabled = value;
            override.loop.updatedAt = Date.now();
        },
    });
}

export async function setCharacterDirectorOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterOverrideEnabledForMode(context, avatar, nextEnabled, {
        hasPayload: (override) => override.director && typeof override.director === 'object',
        apply(override, value) {
            override.director.enabled = value;
            override.director.updatedAt = Date.now();
        },
    });
}

export async function persistOrchestratorCharacterExtension(context, characterIndex, modulePayload) {
    const id = Number(characterIndex);
    const character = Number.isInteger(id) ? context?.characters?.[id] : null;
    if (!character) return false;
    try {
        const value = (modulePayload && typeof modulePayload === 'object')
            ? modulePayload
            : UNSET_VALUE;
        await context.writeExtensionField(id, MODULE_NAME, value);
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

/**
 * Serialize a director editor draft into the portable wire shape:
 * `{ mode, director: { mainAgent, subAgents, limits, tools, discardOnAbort } }`.
 * Sanitizer is idempotent so this round-trips: parseImportedProfilePayload →
 * sanitize again on the receiving side keeps imports tolerant of mildly
 * malformed files (extra keys, missing limits, etc.).
 */
export function createPortableDirectorProfileFromEditor(editor) {
    ensureDirectorEditorIntegrity(editor);
    return sanitizeDirectorProfile(editor);
}

/**
 * Serialize a loop editor draft into the portable wire shape. The loop
 * "editor" already mirrors the on-disk loop profile shape, so the
 * builder just hands it through `sanitizeLoopProfile` (idempotent) — same
 * pattern the persist helpers use.
 */
export function createPortableLoopProfileFromEditor(editor) {
    return sanitizeLoopProfile(editor);
}
