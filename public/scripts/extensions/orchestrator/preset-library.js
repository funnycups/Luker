// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Per-mode preset library + active-preset resolver for the orchestrator.
 *
 * Each of the four orchestration modes (spec / agenda / loop / director)
 * owns an independent library of named presets. Two scopes exist:
 *
 *   - global    → extension_settings.orchestrator.presetLibraries.<mode>
 *   - character → character.data.extensions.orchestrator.presetLibraries.<mode>
 *
 * One preset per (mode, scope) is the "active" one; runtime + editor +
 * iter-studio all read through `getActivePreset(...)`. The active id lives
 * in `activePresetIds.<mode>` on the same parent object as the library.
 *
 * Per-mode sanitizers (defaults.js + persistence.js + agenda-profile.js)
 * stay the single source of truth for profile shape — this module wraps
 * them so the library entry is always canonical on read.
 */

import {
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_DIRECTOR,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_SPEC,
    createFactoryPresetForMode,
    sanitizeDirectorProfile,
} from './defaults.js';
import { sanitizeAgendaWorkingProfile } from './agenda-profile.js';
import { sanitizeLoopProfile } from './persistence.js';
import { sanitizeSpec } from './spec-schema.js';
import { STATE_ERROR_REASONS, makeStateError, makeStateOk } from '../../state-errors.js';
import { formatValidationTargetHint } from '../../state-errors/format.js';

const MODULE_NAME = 'orchestrator';
const DEFAULT_PRESET_ID = 'default';
const DEFAULT_PRESET_NAME = 'Default';

const ALL_MODES = Object.freeze([
    ORCH_EXECUTION_MODE_SPEC,
    ORCH_EXECUTION_MODE_AGENDA,
    ORCH_EXECUTION_MODE_LOOP,
    ORCH_EXECUTION_MODE_DIRECTOR,
]);

function makePresetId() {
    return `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Callback fired after `migrateLegacyCardOverrideForMode` mutates a
 * card's `data.extensions.orchestrator` blob into the new preset-library
 * shape. main.js wires this to a debounced write through
 * `persistOrchestratorCharacterExtension` so the migrated shape settles
 * to disk instead of being re-derived on every reload.
 *
 * Kept as an opt-in hook (rather than a direct import of the persistence
 * helper) to avoid a `preset-library → editor-persist → preset-library`
 * import cycle. Default no-op so unit tests that exercise the migration
 * in isolation don't need to stub the side effect.
 */
let migrationPersistHook = () => {};
export function setMigrationPersistHook(fn) {
    migrationPersistHook = typeof fn === 'function' ? fn : () => {};
}

/**
 * Seed a scope container with factory preset entries for a mode.
 *
 * `createFactoryPresetForMode(mode)` returns either:
 * - a single payload object (legacy single-entry modes: loop / agenda / spec)
 *   — wrapped into a single entry with id=DEFAULT_PRESET_ID.
 * - an array of `{id, name, ...payload}` entries (director) — each written to
 *   its own library slot.
 *
 * Both shapes route through here. The first entry's id becomes the active
 * preset id, so factory authors order entries by "what should be active by
 * default on a fresh install".
 */
function seedFactoryEntries(c, mode) {
    const factory = createFactoryPresetForMode(mode);
    const rawEntries = Array.isArray(factory)
        ? factory
        : [{ id: DEFAULT_PRESET_ID, ...factory }];
    for (const entry of rawEntries) {
        const id = entry.id || DEFAULT_PRESET_ID;
        const payload = { ...entry };
        delete payload.id;
        c.libraries[mode][id] = sanitizePresetEntry(mode, payload);
    }
    c.activeIds[mode] = rawEntries[0]?.id || DEFAULT_PRESET_ID;
}

function sanitizePresetEntry(mode, entry) {
    const raw = entry && typeof entry === 'object' ? entry : {};
    const name = String(raw.name || DEFAULT_PRESET_NAME).trim() || DEFAULT_PRESET_NAME;
    if (mode === ORCH_EXECUTION_MODE_LOOP) {
        return { name, ...sanitizeLoopProfile(raw) };
    }
    if (mode === ORCH_EXECUTION_MODE_DIRECTOR) {
        return { name, ...sanitizeDirectorProfile(raw) };
    }
    if (mode === ORCH_EXECUTION_MODE_AGENDA) {
        return { name, ...sanitizeAgendaWorkingProfile(raw) };
    }
    // spec
    const spec = sanitizeSpec(raw.spec || {});
    const presets = raw.presets && typeof raw.presets === 'object' ? raw.presets : {};
    return { name, spec, presets };
}

function getScopeContainer(settings, scope, { context, avatar } = {}) {
    if (scope === 'global') {
        if (!settings.presetLibraries || typeof settings.presetLibraries !== 'object') {
            settings.presetLibraries = { spec: {}, agenda: {}, loop: {}, director: {} };
        }
        if (!settings.activePresetIds || typeof settings.activePresetIds !== 'object') {
            settings.activePresetIds = { spec: '', agenda: '', loop: '', director: '' };
        }
        return { libraries: settings.presetLibraries, activeIds: settings.activePresetIds };
    }
    if (scope === 'character') {
        if (!context || !avatar) return null;
        const character = (context.characters || []).find(c => String(c?.avatar || '') === String(avatar));
        if (!character) return null;
        const ext = character.data?.extensions?.[MODULE_NAME];
        if (!ext || typeof ext !== 'object') return null;
        if (!ext.presetLibraries || typeof ext.presetLibraries !== 'object') {
            ext.presetLibraries = { spec: {}, agenda: {}, loop: {}, director: {} };
        }
        if (!ext.activePresetIds || typeof ext.activePresetIds !== 'object') {
            ext.activePresetIds = { spec: '', agenda: '', loop: '', director: '' };
        }
        return { libraries: ext.presetLibraries, activeIds: ext.activePresetIds };
    }
    return null;
}

export function listPresets(settings, mode, { scope = 'global', context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return [];
    const lib = c.libraries[mode] || {};
    return Object.keys(lib).map(id => ({ id, name: String(lib[id]?.name || '') }));
}

export function getPreset(settings, mode, scope, presetId, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return null;
    const raw = c.libraries[mode]?.[presetId];
    if (!raw) return null;
    return sanitizePresetEntry(mode, raw);
}

export function createPreset(settings, mode, scope, { name, seedFrom } = {}, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return '';
    if (!c.libraries[mode]) c.libraries[mode] = {};
    const id = makePresetId();
    const seed = seedFrom && c.libraries[mode][seedFrom]
        ? structuredClone(c.libraries[mode][seedFrom])
        : {};
    const sanitized = sanitizePresetEntry(mode, { ...seed, name: name || DEFAULT_PRESET_NAME });
    c.libraries[mode][id] = sanitized;
    return id;
}

export function getActivePresetId(settings, mode, { scope = 'global', context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return '';
    return String(c.activeIds[mode] || '');
}

export function setActivePresetId(settings, mode, scope, presetId, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return false;
    if (!presetId || !c.libraries[mode]?.[presetId]) return false;
    c.activeIds[mode] = String(presetId);
    return true;
}

/**
 * One-shot in-place migration of a card's legacy `override.<mode>` payload
 * into `presetLibraries.<mode>.default`. Runs the first time a card is
 * touched after the upgrade; subsequent reads short-circuit because the
 * library entry now exists. The legacy fields are deleted from
 * `ext.override` in the same pass, and the legacy `enabled` flag is
 * translated into the new flat `overrideEnabled.<mode>` container so the
 * card's old "on/off" state survives the upgrade.
 *
 * Returns true when something was migrated (caller can use that to
 * trigger a debounced save), false otherwise. Pure-ish: only mutates
 * the supplied character's extension blob in place.
 */
export function migrateLegacyCardOverrideForMode(context, avatar, mode) {
    if (!context || !avatar) return false;
    const character = (context.characters || []).find(c => String(c?.avatar || '') === String(avatar));
    if (!character) return false;
    const ext = character.data?.extensions?.[MODULE_NAME];
    if (!ext || typeof ext !== 'object') return false;
    const override = ext.override && typeof ext.override === 'object' ? ext.override : null;
    if (!override) return false;
    let legacyPayload = null;
    let legacyEnabled = null;
    if (mode === ORCH_EXECUTION_MODE_SPEC) {
        const hasSpecPayload = (override.spec && typeof override.spec === 'object')
            || (override.presets && typeof override.presets === 'object')
            || (override.presetPatch && typeof override.presetPatch === 'object');
        if (hasSpecPayload) {
            legacyPayload = { spec: override.spec, presets: override.presets };
            legacyEnabled = typeof override.enabled === 'boolean' ? override.enabled : null;
        }
    } else {
        const sub = override[mode];
        if (sub && typeof sub === 'object') {
            // The agenda/loop/director sub-payload carried its own
            // `enabled` and `updatedAt` fields; strip those, keep the
            // profile body.
            const { enabled, updatedAt, ...rest } = sub;
            legacyPayload = rest;
            legacyEnabled = typeof enabled === 'boolean' ? enabled : null;
        }
    }
    if (!legacyPayload) return false;
    if (!ext.presetLibraries || typeof ext.presetLibraries !== 'object') {
        ext.presetLibraries = { spec: {}, agenda: {}, loop: {}, director: {} };
    }
    if (!ext.activePresetIds || typeof ext.activePresetIds !== 'object') {
        ext.activePresetIds = { spec: '', agenda: '', loop: '', director: '' };
    }
    if (!ext.presetLibraries[mode] || typeof ext.presetLibraries[mode] !== 'object') {
        ext.presetLibraries[mode] = {};
    }
    if (Object.keys(ext.presetLibraries[mode]).length === 0) {
        ext.presetLibraries[mode][DEFAULT_PRESET_ID] = sanitizePresetEntry(mode, {
            name: DEFAULT_PRESET_NAME,
            ...legacyPayload,
        });
        ext.activePresetIds[mode] = DEFAULT_PRESET_ID;
    }
    if (legacyEnabled !== null) {
        if (!ext.overrideEnabled || typeof ext.overrideEnabled !== 'object') {
            ext.overrideEnabled = {};
        }
        if (typeof ext.overrideEnabled[mode] !== 'boolean') {
            ext.overrideEnabled[mode] = legacyEnabled;
        }
    }
    // Strip the legacy fields we just consumed so the next render does
    // not re-migrate them and the on-card blob settles into the new
    // shape on the next save.
    if (mode === ORCH_EXECUTION_MODE_SPEC) {
        delete override.spec;
        delete override.presets;
        delete override.presetPatch;
        delete override.enabled;
        delete override.updatedAt;
        delete override.name;
        delete override.notes;
    } else {
        delete override[mode];
    }
    return true;
}

/**
 * Convenience wrapper used by callers that want the migration AND its
 * persistence side effect in one call (probe paths in
 * `character-overrides.js`, the seed step in `ensureDefaultSeeded`).
 * Returns the boolean from the underlying migration so callers can fold
 * it into their own control flow if needed.
 *
 * The persist hook is best-effort: a failing hook (e.g. write error)
 * must not tank the read path that is also returning the migrated data
 * to the caller. The caller already has the right shape in memory;
 * persistence is a separate concern.
 */
export function migrateAndPersistLegacyCardOverrideForMode(context, avatar, mode) {
    const migrated = migrateLegacyCardOverrideForMode(context, avatar, mode);
    if (migrated) {
        try {
            migrationPersistHook(context, avatar, mode);
        } catch (err) {
            console.warn('[orchestrator] preset-library: migration persist hook threw:', err);
        }
    }
    return migrated;
}

function ensureDefaultSeeded(settings, mode, scope, { context, avatar } = {}) {
    if (scope === 'character' && context && avatar) {
        migrateAndPersistLegacyCardOverrideForMode(context, avatar, mode);
    }
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return null;
    if (!c.libraries[mode]) c.libraries[mode] = {};
    if (Object.keys(c.libraries[mode]).length === 0) {
        // Character scope: do NOT seed a factory default. Seeding here
        // would (a) create a phantom override for cards that have never
        // been customized — `hasCharacter*Override` reads
        // `presetLibraries.<mode>` non-empty and would flip to true after
        // the first popup render — and (b) make "Clear Character
        // Override" a no-op since the next `loadCharacterEditorState →
        // getActivePreset` would immediately re-seed the just-cleared
        // library. Return null so callers fall back to the global
        // active preset.
        if (scope === 'character') {
            return null;
        }
        seedFactoryEntries(c, mode);
    }
    if (!c.activeIds[mode] || !c.libraries[mode][c.activeIds[mode]]) {
        c.activeIds[mode] = Object.keys(c.libraries[mode])[0] || '';
    }
    return c;
}

export function getActivePreset(settings, mode, { scope = 'global', context, avatar } = {}) {
    const c = ensureDefaultSeeded(settings, mode, scope, { context, avatar });
    if (!c) return { ok: true, state: null };
    const id = c.activeIds[mode];
    const raw = c.libraries[mode]?.[id];
    if (!raw) return { ok: true, state: null };
    return { ok: true, state: sanitizePresetEntry(mode, raw) };
}

export function deletePreset(settings, mode, scope, presetId, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return false;
    if (!c.libraries[mode]?.[presetId]) return false;
    const wasActive = c.activeIds[mode] === presetId;
    delete c.libraries[mode][presetId];
    if (Object.keys(c.libraries[mode]).length === 0) {
        if (scope === 'character') {
            // Character scope deletes its last preset → leave the library
            // empty rather than re-seeding a factory default. Seeding here
            // would synthesize a phantom override (the card would read
            // `hasCharacter*Override === true` again on the next render)
            // and silently undo the user's intent to clear that mode.
            c.activeIds[mode] = '';
        } else {
            // Global scope must always have at least one preset to render
            // an editable workspace → re-seed Default and make it active.
            // For director, this seeds BOTH Full and Minimal (see B4).
            seedFactoryEntries(c, mode);
        }
    } else if (wasActive) {
        c.activeIds[mode] = Object.keys(c.libraries[mode])[0];
    }
    return true;
}

export function renamePreset(settings, mode, scope, presetId, { name }, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return false;
    const entry = c.libraries[mode]?.[presetId];
    if (!entry) return false;
    const next = String(name || '').trim();
    if (!next) return false;
    entry.name = next;
    return true;
}

export function duplicatePreset(settings, mode, scope, sourceId, { name }, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) return '';
    const source = c.libraries[mode]?.[sourceId];
    if (!source) return '';
    const id = makePresetId();
    c.libraries[mode][id] = structuredClone(source);
    c.libraries[mode][id].name = String(name || `${source.name} (copy)`).trim() || `${source.name} (copy)`;
    return id;
}

/**
 * Replace the active preset's payload in place. The new payload is run
 * through the mode's sanitizer; `name` is preserved (callers updating
 * the name should use `renamePreset`).
 */
export function writeActivePreset(settings, mode, scope, payload, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_TARGET,
            scope === 'character'
                ? formatValidationTargetHint(`no character override container for avatar=${String(avatar || '').slice(0, 40)}`)
                : formatValidationTargetHint('global preset container unavailable'));
    }
    const id = c.activeIds[mode];
    if (!id) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_COMMIT, `no active preset id for mode=${mode}`);
    }
    const prev = c.libraries[mode]?.[id];
    if (!prev) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_COMMIT, `active preset id=${id} missing from library for mode=${mode}`);
    }
    const sanitized = sanitizePresetEntry(mode, { ...payload, name: prev.name });
    c.libraries[mode][id] = sanitized;
    return makeStateOk({ state: sanitized });
}

/**
 * Save a payload into the scope's library matched by `name`. Iter-studio's
 * "save to global" path uses this so a session opened from a character
 * preset named "MyCustom" lands on the global preset also named "MyCustom"
 * instead of blindly overwriting whatever happens to sit in global's active
 * slot (which is almost always 'default'). Behavior:
 *   - Zero name matches → create a new preset entry under that name and
 *     return `{ok:true, state, presetId, created:true}`. The scope's
 *     active preset id is NOT touched — creating a same-named copy of a
 *     character preset is a save destination, not a switch of what the
 *     scope considers active.
 *   - One match → overwrite that preset (preserving `name`) and return
 *     `{ok:true, state, presetId, created:false, ambiguous:false}`.
 *   - Multiple matches → write the first, return
 *     `{ok:true, state, presetId, created:false, ambiguous:true, candidateIds}`
 *     so the caller can surface a "wrote to first match, multiple existed"
 *     warning rather than silently picking one.
 */
export function writePresetByName(settings, mode, scope, name, payload, { context, avatar } = {}) {
    const c = getScopeContainer(settings, scope, { context, avatar });
    if (!c) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_TARGET,
            scope === 'character'
                ? formatValidationTargetHint(`no character override container for avatar=${String(avatar || '').slice(0, 40)}`)
                : formatValidationTargetHint('global preset container unavailable'));
    }
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
        return makeStateError(STATE_ERROR_REASONS.VALIDATION_COMMIT, 'preset name is required for by-name write');
    }
    if (!c.libraries[mode]) c.libraries[mode] = {};
    const lib = c.libraries[mode];
    const matches = Object.keys(lib).filter(id => String(lib[id]?.name || '').trim() === trimmedName);

    if (matches.length === 0) {
        const newId = makePresetId();
        const sanitized = sanitizePresetEntry(mode, { ...payload, name: trimmedName });
        lib[newId] = sanitized;
        return { ok: true, state: sanitized, presetId: newId, created: true, ambiguous: false, candidateIds: [newId] };
    }
    const targetId = matches[0];
    const sanitized = sanitizePresetEntry(mode, { ...payload, name: trimmedName });
    lib[targetId] = sanitized;
    return {
        ok: true,
        state: sanitized,
        presetId: targetId,
        created: false,
        ambiguous: matches.length > 1,
        candidateIds: matches,
    };
}

export function allModes() {
    return [...ALL_MODES];
}

/**
 * One-shot, idempotent migration of legacy single-slot global fields into
 * the per-mode preset library shape. Caller is responsible for marking
 * `settings.presetLibrariesMigrationDone = 1` and persisting; this
 * function only mutates the in-memory `settings` object.
 *
 * Algorithm: for each mode, if a legacy field is present → move into
 * `presetLibraries.<mode>.default` (with name 'Default'); delete the
 * legacy field. If no legacy data → seed the factory default. Set
 * `activePresetIds.<mode> = 'default'`.
 *
 * Idempotent: once `default` exists for a mode, subsequent calls leave
 * it unchanged.
 */
export function migrateGlobalLegacyToLibraries(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (!settings.presetLibraries) settings.presetLibraries = { spec: {}, agenda: {}, loop: {}, director: {} };
    if (!settings.activePresetIds) settings.activePresetIds = { spec: '', agenda: '', loop: '', director: '' };
    for (const mode of ALL_MODES) {
        if (!settings.presetLibraries[mode]) settings.presetLibraries[mode] = {};
        if (settings.presetLibraries[mode][DEFAULT_PRESET_ID]) {
            if (!settings.activePresetIds[mode]) settings.activePresetIds[mode] = DEFAULT_PRESET_ID;
            continue;
        }
        const seed = readLegacyGlobalForMode(settings, mode);
        if (seed) {
            // Legacy data exists → migrate it into the single 'default' slot.
            // For director mode, do NOT auto-append the second factory entry
            // (Minimal). Legacy users keep their familiar single-entry view
            // and can opt into the second factory via Reset Global (B5) or by
            // manually duplicating.
            settings.presetLibraries[mode][DEFAULT_PRESET_ID] = sanitizePresetEntry(mode, {
                name: DEFAULT_PRESET_NAME,
                ...seed,
            });
            settings.activePresetIds[mode] = DEFAULT_PRESET_ID;
        } else {
            // No legacy data → seed factory entries. For director this seeds
            // both Full and Minimal; for other modes a single entry.
            const tempContainer = {
                libraries: settings.presetLibraries,
                activeIds: settings.activePresetIds,
            };
            seedFactoryEntries(tempContainer, mode);
        }
    }
    delete settings.loopProfile;
    delete settings.directorProfile;
    delete settings.orchestrationSpec;
    delete settings.presets;
    delete settings.agendaPlanner;
    delete settings.agendaAgents;
    delete settings.agendaFinalAgentId;
    delete settings.agendaPlannerMaxRounds;
    delete settings.agendaMaxConcurrentAgents;
    delete settings.agendaMaxTotalRuns;
}

function readLegacyGlobalForMode(settings, mode) {
    if (mode === ORCH_EXECUTION_MODE_LOOP) return settings.loopProfile || null;
    if (mode === ORCH_EXECUTION_MODE_DIRECTOR) return settings.directorProfile || null;
    if (mode === ORCH_EXECUTION_MODE_AGENDA) {
        if (!settings.agendaPlanner && !settings.agendaAgents) return null;
        return {
            planner: settings.agendaPlanner,
            agents: settings.agendaAgents,
            finalAgentId: settings.agendaFinalAgentId,
            limits: {
                plannerMaxRounds: settings.agendaPlannerMaxRounds,
                maxConcurrentAgents: settings.agendaMaxConcurrentAgents,
                maxTotalRuns: settings.agendaMaxTotalRuns,
            },
        };
    }
    if (!settings.orchestrationSpec && !settings.presets) return null;
    return { spec: settings.orchestrationSpec, presets: settings.presets };
}
