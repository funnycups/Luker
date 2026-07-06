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
