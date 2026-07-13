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
 *      into the active slot of the card-scoped `presetLibraries.<mode>`,
 *      records the per-mode `overrideEnabled.<mode>` flag, and pins the
 *      saved execution mode via `override.mode`. All character writes
 *      delegate to `persistOrchestratorCharacterExtension`.
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

const __ctx = Luker.getContext();
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
} from './character-overrides.js';
import {
    serializeEditorPresetMap,
    serializeEditorSpec,
} from './editable-spec.js';
import {
    ensureAgendaEditorIntegrity,
    sanitizeAgendaWorkingProfile,
} from './agenda-profile.js';
import { sanitizeLoopProfile } from './persistence.js';
import { ensureDirectorEditorIntegrity, ensureEditorIntegrity } from './editor-state.js';
import { getActivePresetId, getPreset, writeActivePreset } from './preset-library.js';

const MODULE_NAME = 'orchestrator';

export async function persistGlobalEditorFrom(settings, editor) {
    ensureEditorIntegrity(editor);
    const writeResult = writeActivePreset(settings, ORCH_EXECUTION_MODE_SPEC, 'global', {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    });
    if (!writeResult.ok) {
        // Silent persisters: surface via console so the failure is
        // observable in dev. UI-level callers (Apply, Reset) check the
        // envelope themselves and notify the user.
        console.warn('[orchestrator] persistGlobalEditorFrom: writeActivePreset failed',
            writeResult.reason, writeResult.hint);
    }
    await saveSettings();
}

export async function persistGlobalAgendaEditorFrom(settings, editor) {
    ensureAgendaEditorIntegrity(editor);
    // Funnel the whole editor draft through the canonical sanitizer (same
    // pattern as loop/director). Listing payload fields by hand here used
    // to silently drop tools/customTools/skills on every save.
    const writeResult = writeActivePreset(settings, ORCH_EXECUTION_MODE_AGENDA, 'global',
        sanitizeAgendaWorkingProfile(editor));
    if (!writeResult.ok) {
        console.warn('[orchestrator] persistGlobalAgendaEditorFrom: writeActivePreset failed',
            writeResult.reason, writeResult.hint);
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
    const sanitized = sanitizeLoopProfile(editor);
    const writeResult = writeActivePreset(settings, ORCH_EXECUTION_MODE_LOOP, 'global', sanitized);
    if (!writeResult.ok) {
        console.warn('[orchestrator] persistGlobalLoopEditorFrom: writeActivePreset failed',
            writeResult.reason, writeResult.hint);
    }
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
    const writeResult = writeActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, 'global', sanitized);
    if (!writeResult.ok) {
        console.warn('[orchestrator] persistGlobalDirectorEditorFrom: writeActivePreset failed',
            writeResult.reason, writeResult.hint);
    }
    await saveSettings();
}

function clonePreviousLibrariesAndIds(previous) {
    const libraries = previous?.presetLibraries && typeof previous.presetLibraries === 'object'
        ? structuredClone(previous.presetLibraries)
        : { spec: {}, agenda: {}, loop: {}, director: {} };
    const activeIds = previous?.activePresetIds && typeof previous.activePresetIds === 'object'
        ? structuredClone(previous.activePresetIds)
        : { spec: '', agenda: '', loop: '', director: '' };
    return { libraries, activeIds };
}

function clonePreviousEnabledFlags(previous) {
    return previous?.overrideEnabled && typeof previous.overrideEnabled === 'object'
        ? structuredClone(previous.overrideEnabled)
        : {};
}

function writeModeLibrarySlot(libraries, activeIds, mode, sanitizedPayload) {
    if (!libraries[mode] || Object.keys(libraries[mode]).length === 0) {
        libraries[mode] = { default: { name: 'Default', ...sanitizedPayload } };
        activeIds[mode] = 'default';
        return;
    }
    const activeId = activeIds[mode] && libraries[mode][activeIds[mode]]
        ? activeIds[mode]
        : Object.keys(libraries[mode])[0];
    const prev = libraries[mode][activeId] || {};
    libraries[mode][activeId] = { name: prev.name || 'Default', ...sanitizedPayload };
    activeIds[mode] = activeId;
}

function nextOverridePin(previous, mode) {
    const previousOverride = previous?.override && typeof previous.override === 'object'
        ? { ...previous.override }
        : {};
    previousOverride.mode = mode;
    // Strip any stale legacy payload fields that older builds may have
    // left on this envelope. The new shape only carries `mode` here.
    delete previousOverride.enabled;
    delete previousOverride.spec;
    delete previousOverride.presets;
    delete previousOverride.presetPatch;
    delete previousOverride.agenda;
    delete previousOverride.loop;
    delete previousOverride.director;
    delete previousOverride.updatedAt;
    delete previousOverride.name;
    delete previousOverride.notes;
    return previousOverride;
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
    const { libraries, activeIds } = clonePreviousLibrariesAndIds(previous);
    const overrideEnabled = clonePreviousEnabledFlags(previous);

    writeModeLibrarySlot(libraries, activeIds, ORCH_EXECUTION_MODE_SPEC, {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    });
    overrideEnabled[ORCH_EXECUTION_MODE_SPEC] = enabledFlag;

    const nextPayload = {
        ...previous,
        override: nextOverridePin(previous, ORCH_EXECUTION_MODE_SPEC),
        presetLibraries: libraries,
        activePresetIds: activeIds,
        overrideEnabled,
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
    const { libraries, activeIds } = clonePreviousLibrariesAndIds(previous);
    const overrideEnabled = clonePreviousEnabledFlags(previous);

    writeModeLibrarySlot(libraries, activeIds, ORCH_EXECUTION_MODE_AGENDA,
        sanitizeAgendaWorkingProfile(editor));
    overrideEnabled[ORCH_EXECUTION_MODE_AGENDA] = enabledFlag;

    const nextPayload = {
        ...previous,
        override: nextOverridePin(previous, ORCH_EXECUTION_MODE_AGENDA),
        presetLibraries: libraries,
        activePresetIds: activeIds,
        overrideEnabled,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Persist a loop-mode editor draft as a character override. Writes into
 * the active slot of `presetLibraries.loop` on the character card,
 * records `overrideEnabled.loop`, pins the saved execution mode, and
 * routes through `persistOrchestratorCharacterExtension` for the
 * network write.
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
    const { libraries, activeIds } = clonePreviousLibrariesAndIds(previous);
    const overrideEnabled = clonePreviousEnabledFlags(previous);

    writeModeLibrarySlot(libraries, activeIds, ORCH_EXECUTION_MODE_LOOP, sanitizeLoopProfile(editor));
    overrideEnabled[ORCH_EXECUTION_MODE_LOOP] = enabledFlag;

    const nextPayload = {
        ...previous,
        override: nextOverridePin(previous, ORCH_EXECUTION_MODE_LOOP),
        presetLibraries: libraries,
        activePresetIds: activeIds,
        overrideEnabled,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Persist a director-mode editor draft as a character override. Writes
 * into the active slot of `presetLibraries.director` on the character
 * card, records `overrideEnabled.director`, pins the saved execution
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
    const { libraries, activeIds } = clonePreviousLibrariesAndIds(previous);
    const overrideEnabled = clonePreviousEnabledFlags(previous);

    const sanitizedProfile = sanitizeDirectorProfile(editor);
    // Explicitly list the director payload fields so the on-card shape
    // never accidentally carries editor passthrough (avatar / mode etc.).
    writeModeLibrarySlot(libraries, activeIds, ORCH_EXECUTION_MODE_DIRECTOR, {
        mainAgent: sanitizedProfile.mainAgent,
        subAgents: sanitizedProfile.subAgents,
        maxRounds: sanitizedProfile.maxRounds,
        maxConcurrentSubagents: sanitizedProfile.maxConcurrentSubagents,
        maxTotalSubagentRuns: sanitizedProfile.maxTotalSubagentRuns,
        tools: sanitizedProfile.tools,
        discardOnAbort: sanitizedProfile.discardOnAbort,
        lorebookFilter: sanitizedProfile.lorebookFilter,
    });
    overrideEnabled[ORCH_EXECUTION_MODE_DIRECTOR] = enabledFlag;

    const nextPayload = {
        ...previous,
        override: nextOverridePin(previous, ORCH_EXECUTION_MODE_DIRECTOR),
        presetLibraries: libraries,
        activePresetIds: activeIds,
        overrideEnabled,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

/**
 * Flip the per-character "override enabled" flag for one execution mode
 * without disturbing the stored preset payload. The runtime
 * (`getEffectiveProfile`) already falls back to the global profile when
 * `overrideEnabled[mode]` is false, so this single setter lets the
 * panel offer a switch alongside the "configured, currently disabled"
 * status label: the card's preset library is preserved as-is for
 * re-enabling later.
 *
 * Refuses to write when the card has no preset library for the mode, so
 * a stray click on a hidden control cannot synthesize a phantom override.
 */
async function setCharacterPresetOverrideEnabled(context, avatar, mode, nextEnabled) {
    const target = String(avatar || '');
    if (!target) return false;
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) return false;
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const lib = previous?.presetLibraries?.[mode];
    const hasLib = Boolean(lib && typeof lib === 'object' && Object.keys(lib).length > 0);
    if (!hasLib) return false;
    const overrideEnabled = clonePreviousEnabledFlags(previous);
    overrideEnabled[mode] = Boolean(nextEnabled);
    const nextPayload = {
        ...previous,
        overrideEnabled,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

export async function setCharacterSpecOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterPresetOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_SPEC, nextEnabled);
}

export async function setCharacterAgendaOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterPresetOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_AGENDA, nextEnabled);
}

export async function setCharacterLoopOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterPresetOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_LOOP, nextEnabled);
}

export async function setCharacterDirectorOverrideEnabled(context, avatar, nextEnabled) {
    return setCharacterPresetOverrideEnabled(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR, nextEnabled);
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

/**
 * Narrowly persist a Runtime-limits patch to the active preset for `mode`.
 * Reads the currently persisted preset, overlays only the fields present
 * in `limitsPatch`, and writes back. NEVER uses the editor draft — the
 * write is grounded in what's on disk, so unsaved mainAgent / subAgents /
 * tool-flag / skill-chip edits in the editor stay untouched and can only
 * be flushed by the explicit "Save To Global / Save To Character" button.
 *
 * Shape by mode:
 *   loop     — merge top-level fields (max_rounds, wall_clock_budget_ms)
 *   director — merge top-level fields (maxRounds, maxConcurrentSubagents,
 *                                      maxTotalSubagentRuns, discardOnAbort)
 *   agenda   — merge under `.limits` (plannerMaxRounds, maxConcurrentAgents,
 *                                     maxTotalRuns)
 * Spec is NOT supported here — spec's node_iterations / review_reruns are
 * top-level `settings` fields, not per-preset, and auto-save via
 * `saveSettingsDebounced()` directly from their change handlers.
 *
 * @param {object} context — SillyTavern context; may be null for scope='global'
 * @param {object} settings — extensionSettings.orchestrator
 * @param {'loop'|'director'|'agenda'} mode
 * @param {'global'|'character'} scope
 * @param {object} limitsPatch — subset of the mode's canonical limits fields
 * @param {object} [opts]
 * @param {string} [opts.avatar] — required when scope='character'
 * @returns {Promise<boolean>} true when the patch landed, false on failure
 */
export async function persistRuntimeLimitsPatch(context, settings, mode, scope, limitsPatch, { avatar } = {}) {
    if (!limitsPatch || typeof limitsPatch !== 'object') return false;
    if (mode !== ORCH_EXECUTION_MODE_LOOP
        && mode !== ORCH_EXECUTION_MODE_DIRECTOR
        && mode !== ORCH_EXECUTION_MODE_AGENDA) {
        return false;
    }

    const activePresetId = getActivePresetId(settings, mode, { scope, context, avatar });
    if (!activePresetId) return false;

    const current = getPreset(settings, mode, scope, activePresetId, { context, avatar });
    if (!current) return false;
    const { name: _ignoredName, ...currentFields } = current;

    let merged;
    if (mode === ORCH_EXECUTION_MODE_AGENDA) {
        const currentLimits = (currentFields.limits && typeof currentFields.limits === 'object')
            ? currentFields.limits
            : {};
        merged = { ...currentFields, limits: { ...currentLimits, ...limitsPatch } };
    } else {
        merged = { ...currentFields, ...limitsPatch };
    }

    const writeResult = writeActivePreset(settings, mode, scope, merged, { context, avatar });
    if (!writeResult.ok) {
        console.warn('[orchestrator] persistRuntimeLimitsPatch: writeActivePreset failed',
            writeResult.reason, writeResult.hint);
        return false;
    }

    if (scope === 'global') {
        await saveSettings();
        return true;
    }
    // scope === 'character' — writeActivePreset mutated character.data.extensions.orchestrator
    // in place; now flush the whole ext to the card on disk.
    const characterIndex = getCharacterIndexByAvatar(context, String(avatar || ''));
    if (characterIndex < 0) return false;
    const ext = getCharacterExtensionDataByAvatar(context, String(avatar || ''));
    if (!ext || typeof ext !== 'object') return false;
    return await persistOrchestratorCharacterExtension(context, characterIndex, ext);
}

/**
 * Narrowly persist customTools[] into the active preset for `mode`.
 * Reads the persisted preset, replaces ONLY the customTools slot,
 * writes back through `writeActivePreset`, then flushes to disk.
 * NEVER uses the editor draft — so unsaved mainAgent / subAgents /
 * agents / planner / tool-flag / skill-chip edits are preserved intact.
 *
 * Shape by mode:
 *   loop / director / agenda — top-level `customTools`
 *   spec                     — `spec.customTools`
 *
 * @param {object} context — SillyTavern context; may be null for scope='global'
 * @param {object} settings — extensionSettings.orchestrator
 * @param {'loop'|'director'|'agenda'|'spec'} mode
 * @param {'global'|'character'} scope
 * @param {Array<object>} customTools — the full replacement array
 * @param {object} [opts]
 * @param {string} [opts.avatar] — required when scope='character'
 * @returns {Promise<boolean>}
 */
export async function persistCustomToolsPatch(context, settings, mode, scope, customTools, { avatar } = {}) {
    if (!Array.isArray(customTools)) return false;
    if (mode !== ORCH_EXECUTION_MODE_LOOP
        && mode !== ORCH_EXECUTION_MODE_DIRECTOR
        && mode !== ORCH_EXECUTION_MODE_AGENDA
        && mode !== ORCH_EXECUTION_MODE_SPEC) {
        return false;
    }

    const activePresetId = getActivePresetId(settings, mode, { scope, context, avatar });
    if (!activePresetId) return false;

    const current = getPreset(settings, mode, scope, activePresetId, { context, avatar });
    if (!current) return false;
    const { name: _ignoredName, ...currentFields } = current;

    // Deep-clone the customTools array so downstream mutations to the
    // editor's array don't retroactively mutate the persisted slot.
    const clonedTools = customTools.map(t => (t && typeof t === 'object') ? { ...t } : t);

    let merged;
    if (mode === ORCH_EXECUTION_MODE_SPEC) {
        const currentSpec = (currentFields.spec && typeof currentFields.spec === 'object')
            ? currentFields.spec
            : {};
        merged = { ...currentFields, spec: { ...currentSpec, customTools: clonedTools } };
    } else {
        merged = { ...currentFields, customTools: clonedTools };
    }

    const writeResult = writeActivePreset(settings, mode, scope, merged, { context, avatar });
    if (!writeResult.ok) {
        console.warn('[orchestrator] persistCustomToolsPatch: writeActivePreset failed',
            writeResult.reason, writeResult.hint);
        return false;
    }

    if (scope === 'global') {
        await saveSettings();
        return true;
    }
    const characterIndex = getCharacterIndexByAvatar(context, String(avatar || ''));
    if (characterIndex < 0) return false;
    const ext = getCharacterExtensionDataByAvatar(context, String(avatar || ''));
    if (!ext || typeof ext !== 'object') return false;
    return await persistOrchestratorCharacterExtension(context, characterIndex, ext);
}
