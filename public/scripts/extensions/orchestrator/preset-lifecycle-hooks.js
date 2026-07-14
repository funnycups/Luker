/**
 * Preset lifecycle hooks for the orchestrator plugin.
 *
 * Small async helpers that bridge orchestrator preset CRUD (in main.js)
 * to two cross-subsystem contracts:
 *   1. `context.skills.{copyScope, renameScope}` for orch-preset-scope
 *      skill directory ops (Task 3 client).
 *   2. `context.eventSource.emit(ORCH_PRESET_*, payload)` for the skills
 *      embed-lifecycle subscriber (Task 7).
 *
 * Every helper is best-effort: guards on the target API being present,
 * wraps the call in try/catch, and either swallows expected errors
 * (like 404 = no source skills) or logs unexpected ones. Never throws
 * back to the caller — orchestrator preset CRUD proceeds regardless
 * of skill subsystem state.
 */

import { getExecutionMode } from './character-overrides.js';
import { getDisplayedScope } from './editor-display.js';
import { getCurrentAvatar } from './snapshot-cache.js';
import { getActivePresetId } from './preset-library.js';

const MODULE_NAME = 'orchestrator';

/**
 * Best-effort copy of orch-preset skill directory when a preset is
 * duplicated. Source having no skills (404) is not an error — the new
 * preset just starts with no skills, same as any freshly-created preset.
 *
 * @param {object} context — SillyTavern context
 * @param {object} args
 * @param {'spec'|'agenda'|'loop'|'director'} args.mode
 * @param {string} args.oldName — source preset name
 * @param {string} args.newName — destination preset name
 */
export async function copyOrchPresetSkills(context, { mode, oldName, newName } = {}) {
    if (!context?.skills?.copyScope) return;
    if (!oldName || !newName || oldName === newName) return;
    try {
        await context.skills.copyScope(
            { kind: 'orch-preset', mode, name: oldName },
            { kind: 'orch-preset', mode, name: newName },
        );
    } catch (e) {
        if (e?.status !== 404) {
            console.warn(`[${MODULE_NAME}] duplicate preset skills copy failed:`, e?.message || e);
        }
    }
}

/**
 * Best-effort rename of orch-preset skill directory when a preset is
 * renamed. `newName` for orch-preset kind is the object `{mode, name}`
 * — the server distinguishes by scope kind (Task 3).
 *
 * @param {object} context
 * @param {object} args
 * @param {'spec'|'agenda'|'loop'|'director'} args.mode
 * @param {string} args.oldName
 * @param {string} args.newName
 */
export async function renameOrchPresetSkills(context, { mode, oldName, newName } = {}) {
    if (!context?.skills?.renameScope) return;
    if (!oldName || !newName || oldName === newName) return;
    try {
        await context.skills.renameScope(
            { kind: 'orch-preset', mode, name: oldName },
            { mode, name: newName },
        );
    } catch (e) {
        if (e?.status !== 404) {
            console.warn(`[${MODULE_NAME}] rename preset skills scope failed:`, e?.message || e);
        }
    }
}

/**
 * Emit ORCH_PRESET_DELETED so the skills subsystem can cascade-delete
 * any orch-preset-scope skills bound to (mode, name). Task 7 subscriber
 * is `onOrchPresetDeletedCascade` in `embed-lifecycle.js`.
 *
 * @param {object} context
 * @param {object} args
 * @param {string} args.mode
 * @param {string} args.name
 */
export async function emitOrchPresetDeleted(context, { mode, name } = {}) {
    if (!name) return;
    const eventName = context?.eventTypes?.ORCH_PRESET_DELETED;
    if (!eventName) return;
    try {
        await context.eventSource.emit(eventName, { mode, name });
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ORCH_PRESET_DELETED emit failed:`, e?.message || e);
    }
}

/**
 * Emit ORCH_PRESET_EXPORT_READY before download so the skills subsystem
 * can mutate `payload` in place to attach embedded skill content under
 * `payload.extensions.luker.embedded_skills_source`. Sole positional
 * argument matches OAI_PRESET_EXPORT_READY convention.
 *
 * @param {object} context
 * @param {object} payload — the outgoing preset JSON payload
 */
export async function emitOrchPresetExportReady(context, payload) {
    if (!payload) return;
    const eventName = context?.eventTypes?.ORCH_PRESET_EXPORT_READY;
    if (!eventName) return;
    try {
        await context.eventSource.emit(eventName, payload);
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ORCH_PRESET_EXPORT_READY emit failed:`, e?.message || e);
    }
}

/**
 * Emit ORCH_PRESET_IMPORT_READY after preset persistence so the skills
 * subsystem can look for `data.extensions.luker.embedded_skills_source`
 * and prompt the extract-embed dialog. Payload shape `{data, mode, name}`
 * mirrors OAI_PRESET_IMPORT_READY's `{data, presetName}` with `mode`
 * extension for orch-preset's (mode, name) key shape.
 *
 * @param {object} context
 * @param {object} args
 * @param {object} args.data — the imported preset body
 * @param {string} args.mode
 * @param {string} args.name — the persisted preset name
 */
export async function emitOrchPresetImportReady(context, { data, mode, name } = {}) {
    if (!data || !mode || !name) return;
    const eventName = context?.eventTypes?.ORCH_PRESET_IMPORT_READY;
    if (!eventName) return;
    try {
        await context.eventSource.emit(eventName, { data, mode, name });
    } catch (e) {
        console.warn(`[${MODULE_NAME}] ORCH_PRESET_IMPORT_READY emit failed:`, e?.message || e);
    }
}

/**
 * Resolve the currently-active orchestrator preset (mode, name) for the
 * user's current UI context. Used by the manage-skills entry point to
 * pre-select the correct orch-preset scope in the skill manager panel.
 *
 * Reads `settings.executionMode` for the active mode, uses
 * `getDisplayedScope` to pick between global-scope and character-scope
 * (matching what the editor currently displays), then reads the raw
 * library entry's name directly (not through `getActivePreset`, which
 * seeds factory defaults on empty libraries and folds empty names to
 * DEFAULT_PRESET_NAME — both would mask "nothing meaningfully active"
 * as if a Default preset were selected). Returns null on any
 * resolution gap (no active id, empty name, no library, missing
 * character extension data for character scope).
 *
 * @param {object} context — SillyTavern context
 * @param {object} settings — extensionSettings.orchestrator
 * @returns {{kind: 'orch-preset', mode: string, name: string} | null}
 */
export function computeActiveOrchPresetScope(context, settings) {
    if (!settings || typeof settings !== 'object') return null;
    const mode = String(getExecutionMode(settings) || '').trim();
    if (!mode) return null;
    const scope = getDisplayedScope(context, settings) || 'global';
    const avatar = String(getCurrentAvatar(context) || '').trim();
    let id;
    try {
        id = String(getActivePresetId(settings, mode, { scope, context, avatar }) || '').trim();
    } catch (_) {
        return null;
    }
    if (!id) return null;
    let library;
    if (scope === 'character') {
        if (!avatar) return null;
        const character = (context?.characters || []).find(
            c => String(c?.avatar || '') === avatar,
        );
        library = character?.data?.extensions?.[MODULE_NAME]?.presetLibraries?.[mode];
    } else {
        library = settings?.presetLibraries?.[mode];
    }
    const name = String(library?.[id]?.name || '').trim();
    if (!name) return null;
    return { kind: 'orch-preset', mode, name };
}

/**
 * Walk a `presetLibraries` container (either global-scope or
 * card-embedded — the shape is identical) and clear every
 * `promptPresetName` field that matches the just-deleted preset name.
 *
 * Fields cleared per mode (from `orchestrator/defaults.js`,
 * `director-defaults.js`, `agenda-profile.js`, `editable-spec.js`):
 *
 *   loop[id]                       .promptPresetName
 *   agenda[id].planner             .promptPresetName
 *   agenda[id].agents[*]           .promptPresetName
 *   director[id].mainAgent         .promptPresetName
 *   director[id].subAgents[*]      .promptPresetName
 *   spec[id].presets[*]            .promptPresetName
 *
 * Returns true if any field was cleared, so the caller can gate a
 * persist call.
 *
 * @param {object|undefined} presetLibraries
 * @param {string} deletedName
 * @returns {boolean}
 */
export function purgePromptPresetNameInLibrary(presetLibraries, deletedName) {
    if (!presetLibraries || typeof presetLibraries !== 'object' || !deletedName) return false;
    let mutated = false;
    const clearIfMatch = (host, field) => {
        if (host && typeof host === 'object' && String(host[field] || '') === deletedName) {
            host[field] = '';
            mutated = true;
        }
    };

    const loop = presetLibraries.loop;
    if (loop && typeof loop === 'object') {
        for (const entry of Object.values(loop)) clearIfMatch(entry, 'promptPresetName');
    }
    const agenda = presetLibraries.agenda;
    if (agenda && typeof agenda === 'object') {
        for (const entry of Object.values(agenda)) {
            clearIfMatch(entry?.planner, 'promptPresetName');
            const agents = entry?.agents;
            if (agents && typeof agents === 'object') {
                for (const agent of Object.values(agents)) clearIfMatch(agent, 'promptPresetName');
            }
        }
    }
    const director = presetLibraries.director;
    if (director && typeof director === 'object') {
        for (const entry of Object.values(director)) {
            clearIfMatch(entry?.mainAgent, 'promptPresetName');
            const subs = entry?.subAgents;
            if (Array.isArray(subs)) {
                for (const sub of subs) clearIfMatch(sub, 'promptPresetName');
            }
        }
    }
    const spec = presetLibraries.spec;
    if (spec && typeof spec === 'object') {
        for (const entry of Object.values(spec)) {
            const presets = entry?.presets;
            if (presets && typeof presets === 'object') {
                for (const preset of Object.values(presets)) clearIfMatch(preset, 'promptPresetName');
            }
        }
    }
    return mutated;
}

