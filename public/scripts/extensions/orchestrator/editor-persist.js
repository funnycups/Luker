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
 *      and pins the saved execution mode via `override.mode`. All
 *      character writes delegate to `persistOrchestratorCharacterExtension`.
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
    applyCharacterExecutionModeForAvatar,
    getCharacterIndexByAvatar,
    getCharacterPresetLibrary,
    getCharacterSavedExecutionModeByAvatar,
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
import { makeModeMap } from './preset-modes.js';
import { acknowledgeCharacterDraftSource, acknowledgeGlobalWriteDrafts, captureGlobalWriteDrafts, ensureDirectorEditorIntegrity, ensureEditorIntegrity, getCharacterDraftForMode, getCharacterDraftSourceFingerprint, refreshCharacterDraftIfSourceChanged, syncActivePresetIdsFromSettings, uiState } from './editor-state.js';
import { canonicalStringify } from './canonical-stringify.js';
import { getActivePresetId, getPreset, writeActivePreset } from './preset-library.js';

const MODULE_NAME = 'orchestrator';

export async function persistGlobalPresetWrite(settings, mode, write, { context = null, replaceGlobal = false, sourceEditor = null, saveGlobal = saveSettings } = {}) {
    const captured = captureGlobalWriteDrafts(mode);
    const priorActiveId = settings.activePresetIds?.[mode];
    const priorLibrary = settings.presetLibraries?.[mode];
    const previous = priorActiveId ? priorLibrary?.[priorActiveId] : undefined;
    const result = write();
    if (!result.ok) return false;
    const activeId = settings.activePresetIds?.[mode];
    const library = settings.presetLibraries?.[mode];
    const id = result.presetId || activeId;
    const written = library?.[id];
    if (saveGlobal !== saveSettings) {
        let saved = false;
        try {
            const customOutcome = await saveGlobal();
            saved = customOutcome !== false && customOutcome?.ok !== false;
            if (!saved) return false;
        } finally {
            if (!saved && library && id === priorActiveId && library[id] === written) {
                if (previous === undefined) delete library[id];
                else library[id] = previous;
            }
        }
        if (context) acknowledgeGlobalWriteDrafts(context, mode, captured, { replaceGlobal, sourceEditor });
        return true;
    }
    const intended = canonicalStringify(written);
    const outcome = await saveSettings();
    const acknowledged = outcome?.ok && canonicalStringify(outcome.payload?.extension_settings?.orchestrator?.presetLibraries?.[mode]?.[id]) === intended;
    // Settings remain the desired editable state on failure/defer. A later
    // explicit or debounced save may persist them. No rollback can safely
    // reconstruct a baseline shared with other queued settings consumers.
    if (!acknowledged) return false;
    if (settings.activePresetIds?.[mode] !== activeId || settings.presetLibraries?.[mode] !== library || library?.[id] !== written || canonicalStringify(written) !== intended) return false;
    if (replaceGlobal && (uiState[captured.key] !== captured.draft || canonicalStringify(uiState[captured.key]) !== captured.content)) return false;
    if (sourceEditor === captured.characterDraft && (uiState.selectedAvatar !== captured.avatar || getCharacterDraftForMode(mode) !== sourceEditor || canonicalStringify(sourceEditor) !== captured.characterContent)) return false;
    if (context) acknowledgeGlobalWriteDrafts(context, mode, captured, { replaceGlobal, sourceEditor });
    return true;
}

async function persistCharacterPresetMutation(context, avatar, mode, presetId, mutate) {
    const index = getCharacterIndexByAvatar(context, avatar);
    if (index < 0) return false;
    const draft = getCharacterDraftForMode(mode);
    let source;
    const ok = await persistOrchestratorCharacterExtension(context, index, current => {
        const previous = current?.presetLibraries?.[mode]?.[presetId];
        if (!previous) throw new Error('Character preset no longer exists');
        const next = {
            ...current,
            presetLibraries: { ...current.presetLibraries, [mode]: { ...current.presetLibraries[mode], [presetId]: mutate(previous) } },
        };
        source = getCharacterDraftSourceFingerprint(context, avatar, mode, next);
        return next;
    });
    if (ok && source) acknowledgeCharacterDraftSource(context, avatar, mode, draft, source);
    return ok;
}

export async function persistGlobalEditorFrom(settings, editor, context = null) {
    ensureEditorIntegrity(editor);
    return persistGlobalPresetWrite(settings, ORCH_EXECUTION_MODE_SPEC, () => writeActivePreset(settings, ORCH_EXECUTION_MODE_SPEC, 'global', {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    }), { context, replaceGlobal: true, sourceEditor: editor });
}

export async function persistGlobalAgendaEditorFrom(settings, editor, context = null) {
    ensureAgendaEditorIntegrity(editor);
    // Funnel the whole editor draft through the canonical sanitizer (same
    // pattern as loop/director). Listing payload fields by hand here used
    // to silently drop tools/customTools/skills on every save.
    return persistGlobalPresetWrite(settings, ORCH_EXECUTION_MODE_AGENDA, () => writeActivePreset(settings, ORCH_EXECUTION_MODE_AGENDA, 'global',
        sanitizeAgendaWorkingProfile(editor)), { context, replaceGlobal: true, sourceEditor: editor });
}

/**
 * Persist a loop-mode editor draft to global settings. Funnels through
 * `sanitizeLoopProfile` so the on-disk shape always matches the V3
 * schema (mode literal, finalize forced true, numeric clamps applied)
 * regardless of how the editor mutated the draft.
 */
export async function persistGlobalLoopEditorFrom(settings, editor, context = null) {
    const sanitized = sanitizeLoopProfile(editor);
    return persistGlobalPresetWrite(settings, ORCH_EXECUTION_MODE_LOOP, () => writeActivePreset(settings, ORCH_EXECUTION_MODE_LOOP, 'global', sanitized), { context, replaceGlobal: true, sourceEditor: editor });
}

/**
 * Persist a director-mode editor draft to global settings. Funnels
 * through `sanitizeDirectorProfile` so the on-disk shape always
 * matches the canonical director schema (mainAgent / subAgents /
 * limits / tools, with `tools.finalize` forced false) regardless of
 * how the editor mutated the draft.
 */
export async function persistGlobalDirectorEditorFrom(settings, editor, context = null) {
    const sanitized = sanitizeDirectorProfile(editor);
    return persistGlobalPresetWrite(settings, ORCH_EXECUTION_MODE_DIRECTOR, () => writeActivePreset(settings, ORCH_EXECUTION_MODE_DIRECTOR, 'global', sanitized), { context, replaceGlobal: true, sourceEditor: editor });
}

function clonePreviousLibrariesAndIds(previous) {
    const libraries = previous?.presetLibraries && typeof previous.presetLibraries === 'object'
        ? structuredClone(previous.presetLibraries)
        : makeModeMap(() => ({}));
    const activeIds = previous?.activePresetIds && typeof previous.activePresetIds === 'object'
        ? structuredClone(previous.activePresetIds)
        : makeModeMap(() => '');
    return { libraries, activeIds };
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

async function persistCharacterModeEditor(context, avatar, mode, sanitizedPayload) {
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    return await persistOrchestratorCharacterExtension(context, characterIndex, (current) => {
        const previous = current && typeof current === 'object' ? current : {};
        const { libraries, activeIds } = clonePreviousLibrariesAndIds(previous);
        writeModeLibrarySlot(libraries, activeIds, mode, sanitizedPayload);
        return {
            ...previous,
            override: nextOverridePin(previous, mode),
            presetLibraries: libraries,
            activePresetIds: activeIds,
        };
    });
}

export async function persistCharacterEditor(context, settings, avatar, { editor } = {}) {
    void settings;
    if (!String(avatar || '') || getCharacterIndexByAvatar(context, String(avatar || '')) < 0) {
        return false;
    }
    ensureEditorIntegrity(editor);
    return await persistCharacterModeEditor(context, avatar, ORCH_EXECUTION_MODE_SPEC, {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    });
}

export async function persistCharacterAgendaEditor(context, settings, avatar, { editor } = {}) {
    void settings;
    if (!String(avatar || '') || getCharacterIndexByAvatar(context, String(avatar || '')) < 0) {
        return false;
    }
    ensureAgendaEditorIntegrity(editor);
    return await persistCharacterModeEditor(context, avatar, ORCH_EXECUTION_MODE_AGENDA, sanitizeAgendaWorkingProfile(editor));
}

/**
 * Persist a loop-mode editor draft as a character override. Writes into
 * the active slot of `presetLibraries.loop` on the character card, pins
 * the saved execution mode, and routes through
 * `persistOrchestratorCharacterExtension` for the network write.
 *
 * The loop payload runs through `sanitizeLoopProfile` so the on-card
 * shape matches the V3 schema regardless of how the editor mutated the
 * draft. The preset entry's `name` is preserved across the rewrite; if
 * the card has no library yet, a `default` slot is synthesized.
 */
export async function persistCharacterLoopEditor(context, settings, avatar, { editor } = {}) {
    void settings;
    return await persistCharacterModeEditor(context, avatar, ORCH_EXECUTION_MODE_LOOP, sanitizeLoopProfile(editor));
}

/**
 * Persist a director-mode editor draft as a character override. Writes
 * into the active slot of `presetLibraries.director` on the character
 * card, pins the saved execution mode, and routes through
 * `persistOrchestratorCharacterExtension` for the network write.
 *
 * The director payload runs through `sanitizeDirectorProfile` so the
 * on-card shape matches the canonical schema regardless of how the
 * editor mutated the draft. Only the canonical profile fields are
 * persisted (no editor passthrough like avatar / mode), and the preset
 * entry's `name` is preserved across the rewrite.
 */
export async function persistCharacterDirectorEditor(context, settings, avatar, { editor } = {}) {
    void settings;
    const sanitizedProfile = sanitizeDirectorProfile(editor);
    // Explicitly list the director payload fields so the on-card shape
    // never accidentally carries editor passthrough (avatar / mode etc.).
    return await persistCharacterModeEditor(context, avatar, ORCH_EXECUTION_MODE_DIRECTOR, {
        mainAgent: sanitizedProfile.mainAgent,
        subAgents: sanitizedProfile.subAgents,
        maxRounds: sanitizedProfile.maxRounds,
        maxConcurrentSubagents: sanitizedProfile.maxConcurrentSubagents,
        maxTotalSubagentRuns: sanitizedProfile.maxTotalSubagentRuns,
        tools: sanitizedProfile.tools,
        discardOnAbort: sanitizedProfile.discardOnAbort,
        lorebookFilter: sanitizedProfile.lorebookFilter,
    });
}

export async function persistOrchestratorCharacterExtension(context, characterIndex, modulePayload) {
    const id = Number(characterIndex);
    const character = Number.isInteger(id) ? context?.characters?.[id] : null;
    if (!character) return false;
    const unsetValue = context?.constants?.unset ?? UNSET_VALUE;
    const normalizePayload = (payload) => ((payload && typeof payload === 'object') ? payload : unsetValue);
    try {
        const value = typeof modulePayload === 'function'
            ? (current) => {
                const next = modulePayload(current);
                return (next && typeof next.then === 'function')
                    ? next.then(normalizePayload)
                    : normalizePayload(next);
            }
            : normalizePayload(modulePayload);
        const result = await context.writeExtensionField(id, MODULE_NAME, value);
        return result !== false;
    } catch (error) {
        console.error('Failed to persist orchestrator extension data to character card', error);
        return false;
    }
}

/**
 * Switch which card preset runs for the card's saved execution mode.
 * `presetId` is an id from the card library of that mode, or `''` to run
 * the global active preset while keeping the card library. Persists the
 * card, then realigns `settings.executionMode` to the card's saved mode.
 * A failed card write restores the in-memory slot.
 *
 * @param {object} context SillyTavern context (characters + writeExtensionField)
 * @param {object} settings `extension_settings.orchestrator`
 * @param {string} avatar
 * @param {string} presetId
 * @returns {Promise<{ok: true, mode: string} | {ok: false, mode: string, reason: 'character_not_found'|'no_saved_mode'|'preset_not_found'|'set_failed'|'persist_failed'}>}
 */
export async function setCharacterActivePresetForSavedMode(context, settings, avatar, presetId) {
    const safeAvatar = String(avatar || '').trim();
    const characterIndex = getCharacterIndexByAvatar(context, safeAvatar);
    if (characterIndex < 0) return { ok: false, mode: '', reason: 'character_not_found' };
    const mode = getCharacterSavedExecutionModeByAvatar(context, safeAvatar);
    if (!mode) return { ok: false, mode: '', reason: 'no_saved_mode' };
    const id = String(presetId ?? '');
    if (id !== '' && !Object.prototype.hasOwnProperty.call(getCharacterPresetLibrary(context, safeAvatar, mode), id)) {
        return { ok: false, mode, reason: 'preset_not_found' };
    }
    const persisted = await persistOrchestratorCharacterExtension(context, characterIndex, current => ({
        ...current, activePresetIds: { ...current?.activePresetIds, [mode]: id },
    }));
    if (!persisted) {
        return { ok: false, mode, reason: 'persist_failed' };
    }
    applyCharacterExecutionModeForAvatar(context, settings, safeAvatar);
    if (uiState.selectedAvatar === safeAvatar) {
        refreshCharacterDraftIfSourceChanged(context, mode);
        syncActivePresetIdsFromSettings(context);
    }
    return { ok: true, mode };
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
export async function persistRuntimeLimitsPatch(context, settings, mode, scope, limitsPatch, { avatar, saveGlobal = saveSettings } = {}) {
    if (!limitsPatch || typeof limitsPatch !== 'object') return false;
    if (mode !== ORCH_EXECUTION_MODE_LOOP
        && mode !== ORCH_EXECUTION_MODE_DIRECTOR
        && mode !== ORCH_EXECUTION_MODE_AGENDA) {
        return false;
    }

    const activePresetId = getActivePresetId(settings, mode, { scope, context, avatar });
    if (!activePresetId) return false;

    if (scope === 'character') {
        return persistCharacterPresetMutation(context, avatar, mode, activePresetId, current => mode === ORCH_EXECUTION_MODE_AGENDA
            ? { ...current, limits: { ...current.limits, ...limitsPatch } }
            : { ...current, ...limitsPatch });
    }

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

    return persistGlobalPresetWrite(settings, mode, () => writeActivePreset(settings, mode, scope, merged, { context, avatar }), { context, saveGlobal });
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
export async function persistCustomToolsPatch(context, settings, mode, scope, customTools, { avatar, saveGlobal = saveSettings } = {}) {
    if (!Array.isArray(customTools)) return false;
    if (mode !== ORCH_EXECUTION_MODE_LOOP
        && mode !== ORCH_EXECUTION_MODE_DIRECTOR
        && mode !== ORCH_EXECUTION_MODE_AGENDA
        && mode !== ORCH_EXECUTION_MODE_SPEC) {
        return false;
    }

    const activePresetId = getActivePresetId(settings, mode, { scope, context, avatar });
    if (!activePresetId) return false;

    if (scope === 'character') {
        const tools = JSON.parse(JSON.stringify(customTools));
        return persistCharacterPresetMutation(context, avatar, mode, activePresetId, current => mode === ORCH_EXECUTION_MODE_SPEC
            ? { ...current, spec: { ...current.spec, customTools: tools } }
            : { ...current, customTools: tools });
    }

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

    return persistGlobalPresetWrite(settings, mode, () => writeActivePreset(settings, mode, scope, merged, { context, avatar }), { context, saveGlobal });
}

// Auto-saves acknowledge only their captured source. Unchanged inherited
// character drafts follow a global write. Edited drafts remain intact.
export async function persistRuntimeLimitsKeepingDrafts(context, settings, mode, scope, limitsPatch, opts) {
    const ok = await persistRuntimeLimitsPatch(context, settings, mode, scope, limitsPatch, opts);
    return ok;
}

export async function persistCustomToolsKeepingDrafts(context, settings, mode, scope, customTools, opts) {
    const ok = await persistCustomToolsPatch(context, settings, mode, scope, customTools, opts);
    return ok;
}
