/**
 * Preset ↔ Lorebook embed helpers (Luker symmetry with character cards).
 *
 * The preset binding mechanism stores a full lorebook payload inside the
 * preset body at `extensions.preset_lorebook`, shape:
 *
 *   { version: 1, name: '<world-name>', data: { entries: { ... } } }
 *
 * That payload is already round-tripped by the standard preset save/load
 * pipeline (the preset's `extensions` field is preserved verbatim by
 * `getChatCompletionPreset`, `saveOpenAIPresetBody`, and the
 * `/api/presets/save` endpoint). What this module adds is the *programmatic*
 * surface so that:
 *   1. Tests + extensions can bind/unbind a lorebook to a preset without
 *      driving the popup-based `managePresetLinkedLorebook` UI flow.
 *   2. The embedded payload can be materialized into a real world-info file
 *      on import without going through `checkPresetLinkedLorebookOnPresetChange`'s
 *      confirm dialog (which never resolves in headless / e2e contexts).
 *   3. Extensions outside `world-info.js` get a clean read API for "what
 *      lorebook is this preset bound to?".
 *
 * Parity with the skills embed pipeline (`public/scripts/skills/embed-export-helper.js`):
 *   - skills:  packSkillsForExport / attachEmbeddedSkillsSource / packAndAttachSkillsForExport
 *   - lorebook: there is no "pack" step (the binding payload IS the embed),
 *               so the export surface is just `extractEmbeddedLorebookPayload`
 *               (and the binding helpers below).
 *   - skills:  runEmbedImportFlow (dialog-driven materialize on import)
 *   - lorebook: applyEmbeddedLorebookFromPreset (programmatic materialize,
 *               no dialog — the existing PRESET_CHANGED hook still handles
 *               the interactive UX path for end users)
 *
 * The on-disk preset JSON shape is unchanged: `extensions.preset_lorebook`
 * with the existing v1 envelope. Old presets without the embed block load
 * fine (every helper returns null/false on missing payloads).
 */

import {
    PRESET_LINKED_LOREBOOK_KEY,
    createPresetLinkedLorebookPayload,
    getPresetLinkedLorebookFromExtensions,
    loadWorldInfo,
    saveWorldInfo,
    updateWorldInfoList,
    world_names,
    selected_world_info,
} from './world-info.js';

/**
 * Pluck the embedded preset-lorebook payload from a preset body.
 * Mirrors `getEmbeddedSkillsSource` (`public/scripts/skills/embed-import-dialog.js`).
 *
 * @param {object} presetBody - the preset JSON (the `extensions` field is read)
 * @returns {{version:number, name:string, data:object}|null} normalized payload, or null
 */
export function extractEmbeddedLorebookPayload(presetBody) {
    if (!presetBody || typeof presetBody !== 'object') return null;
    return getPresetLinkedLorebookFromExtensions(presetBody.extensions);
}

/**
 * Bind a lorebook (by world-info file name) to a preset. Reads the WI from
 * disk and embeds the full payload at `extensions.preset_lorebook`.
 *
 * @param {object} opts
 * @param {string} opts.apiId           preset API id, typically 'openai'
 * @param {string} opts.presetName      preset to bind into
 * @param {string} opts.worldName       existing world-info file name to embed
 * @returns {Promise<boolean>} true on success, false if any input was invalid
 *                             or the WI could not be loaded
 */
export async function bindLorebookToPreset({ apiId, presetName, worldName } = {}) {
    const api = String(apiId || '').trim();
    const name = String(presetName || '').trim();
    const world = String(worldName || '').trim();
    if (!api || !name || !world) return false;

    const data = await loadWorldInfo(world);
    if (!data || typeof data !== 'object') return false;

    const { getPresetManager } = await import('./preset-manager.js');
    const manager = getPresetManager(api);
    if (!manager) return false;

    const payload = createPresetLinkedLorebookPayload(world, data);
    await manager.writePresetExtensionField({
        name,
        path: PRESET_LINKED_LOREBOOK_KEY,
        value: payload,
    });
    return true;
}

/**
 * Remove the lorebook embed from a preset. No-op when nothing is bound.
 *
 * @param {object} opts
 * @param {string} opts.apiId
 * @param {string} opts.presetName
 * @returns {Promise<boolean>} true if the field was present and got removed
 */
export async function unbindLorebookFromPreset({ apiId, presetName } = {}) {
    const api = String(apiId || '').trim();
    const name = String(presetName || '').trim();
    if (!api || !name) return false;

    const { getPresetManager } = await import('./preset-manager.js');
    const manager = getPresetManager(api);
    if (!manager) return false;

    const existing = manager.readPresetExtensionField({ name, path: PRESET_LINKED_LOREBOOK_KEY });
    if (!existing) return false;

    // Re-read the full extensions blob, drop the key, write the rest back.
    // (writePresetExtensionField has no delete-key affordance, so we round-trip
    // the parent object.)
    const allExtensions = manager.readPresetExtensionField({ name, path: '' }) || {};
    const next = { ...allExtensions };
    delete next[PRESET_LINKED_LOREBOOK_KEY];
    await manager.writePresetExtensionField({ name, path: '', value: next });
    return true;
}

/**
 * Materialize the embedded lorebook payload of a preset body into a real
 * world-info file on disk. No dialog — the caller decides the overwrite
 * policy. Returns details on what was done.
 *
 * Mirrors `executeExtractEmbed` from the skills pipeline (programmatic,
 * no UI), so tests + extensions can drive the import path the same way
 * they drive skill embeds.
 *
 * @param {object} opts
 * @param {object} opts.presetBody          preset JSON to read the embed from
 * @param {'skip'|'replace'} [opts.onConflict='replace']
 *      - 'replace' overwrites an existing world-info file of the same name
 *      - 'skip'    leaves the existing file alone and reports `conflict:'skip'`
 *        (still returns the resolved worldName so the caller can re-activate it)
 * @param {boolean} [opts.activate=true]   add the materialized world to the
 *      active selection (mirrors what `importPresetLinkedLorebookPayload` does)
 * @returns {Promise<{materialized: boolean, worldName: string, conflict: 'none'|'skip'|'replace'}|null>}
 *      null when there is no embedded payload to materialize.
 */
export async function applyEmbeddedLorebookFromPreset({
    presetBody, onConflict = 'replace', activate = true,
} = {}) {
    const payload = extractEmbeddedLorebookPayload(presetBody);
    if (!payload) return null;

    const worldName = payload.name;
    const exists = Array.isArray(world_names) && world_names.includes(worldName);
    let conflict = 'none';
    if (exists) {
        conflict = onConflict === 'skip' ? 'skip' : 'replace';
    }

    let materialized = false;
    if (!exists || conflict === 'replace') {
        await saveWorldInfo(worldName, payload.data, true);
        await updateWorldInfoList();
        materialized = true;
    }

    if (activate && Array.isArray(selected_world_info) && !selected_world_info.includes(worldName)) {
        selected_world_info.push(worldName);
    }

    return { materialized, worldName, conflict };
}
