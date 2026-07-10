// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Layer 1 — Character-bound chat completion presets (multi-binding).
 *
 * Stores an array of {name, preset} on
 *   character.data.extensions.luker.chat_completion_preset
 * plus an optional `defaultPresetName`. Preserves the four-strip API safety model:
 * every write calls `stripOpenAIConnectionFieldsFromPreset` and every read
 * re-strips as defense in depth.
 *
 * Migration: legacy shapes ({name, preset} single-binding; bare string name)
 * are detected on read and lifted into the new shape via a microtask-coalesced
 * flush hook, mirroring orchestrator/preset-library.js legacy-override migration.
 *
 * Writes go through `context.writeExtensionField(id, 'luker', value)`, which
 * has replace semantics — see the JSDoc at public/scripts/extensions.js above
 * `writeExtensionField`. Callers must read the current `data.extensions.luker`
 * object, spread it, and overlay the target field before calling; otherwise
 * sibling subkeys under the same namespace (e.g. `embedded_skills_source`) are
 * wiped. Clearing the field is done by writing an explicit `null` value; the
 * key itself remains present (use `UNSET_VALUE` for a real delete).
 */

import { stripOpenAIConnectionFieldsFromPreset } from '/scripts/openai.js';
import { getContext } from '/scripts/st-context.js';

const NAMESPACE = 'luker';
const FIELD = 'chat_completion_preset';

/** @typedef {{ name: string, preset: object }} BoundPreset */
/** @typedef {{ presets: BoundPreset[], defaultPresetName: string | null, _migrated?: boolean }} BoundState */

/**
 * Pure read: normalize the raw `chat_completion_preset` value into
 * `BoundState`. Detects legacy shapes and marks `_migrated: true`, but
 * DOES NOT schedule the migration flush — that side effect belongs to
 * the public `readCharacterBoundState` entry point. The flush's internal
 * microtask also uses this helper so it can inspect the raw state
 * without re-scheduling itself (which would infinite-loop when the
 * character is not in `ctx.characters` and the persist keeps throwing).
 * @param {object} character
 * @returns {BoundState}
 */
function readCharacterBoundStateRaw(character) {
    const raw = character?.data?.extensions?.[NAMESPACE]?.[FIELD];
    if (raw == null) return { presets: [], defaultPresetName: null };

    // Legacy bare string: name only, no body. resolveByName falls back to global.
    if (typeof raw === 'string') {
        const legacyName = raw.trim();
        return { presets: [], defaultPresetName: legacyName || null, _migrated: true };
    }

    // Legacy single-binding {name, preset}
    if (raw && typeof raw === 'object' && raw.name && raw.preset && !Array.isArray(raw.presets)) {
        return {
            presets: [{ name: String(raw.name), preset: stripOpenAIConnectionFieldsFromPreset(raw.preset) }],
            defaultPresetName: String(raw.name),
            _migrated: true,
        };
    }

    // New shape
    return {
        presets: Array.isArray(raw?.presets) ? raw.presets : [],
        defaultPresetName: typeof raw?.defaultPresetName === 'string' ? raw.defaultPresetName : null,
    };
}

/**
 * Read normalized bound-preset state from a character. Detects legacy shapes
 * and marks `_migrated: true` so the persistence side can flush the upgrade.
 *
 * When a legacy shape is detected, this also SCHEDULES the migration flush
 * as a side effect. This mirrors `listCharacterBoundPresets` /
 * `getCharacterBoundPreset`, which both schedule the flush after they call
 * `readCharacterBoundState`. Without the schedule here, a card that is only
 * ever *read* through this raw entry point (e.g. `openai.js` /
 * `maybeApplyCharacterBoundPreset`) never migrates — the legacy shape
 * survives on disk forever until the user happens to bind / save through the
 * higher-level APIs. Doing the schedule here keeps the three sibling reads
 * symmetric.
 *
 * `scheduleMigrationFlush` is microtask-coalesced and keyed by avatar, so
 * multiple reads in the same tick still produce at most one write.
 * @param {object} character
 * @returns {BoundState}
 */
export function readCharacterBoundState(character) {
    const state = readCharacterBoundStateRaw(character);
    if (state._migrated) scheduleMigrationFlush(character);
    return state;
}

async function persistCharacterBoundState(character, state) {
    const context = getContext();
    const id = context.characters.indexOf(character);
    if (id < 0) throw new Error('persistCharacterBoundState: character not found in context.characters');
    const value = (state.presets.length === 0 && !state.defaultPresetName)
        ? null                                                                      // clear entirely
        : { presets: state.presets, defaultPresetName: state.defaultPresetName };
    // writeExtensionField has replace semantics: the whole `luker` object is
    // overwritten. Read-spread-overlay preserves siblings like `embedded_skills_source`.
    const currentLuker = (character?.data?.extensions?.[NAMESPACE] && typeof character.data.extensions[NAMESPACE] === 'object' && !Array.isArray(character.data.extensions[NAMESPACE]))
        ? character.data.extensions[NAMESPACE]
        : {};
    await context.writeExtensionField(id, NAMESPACE, { ...currentLuker, [FIELD]: value });
}

/** microtask-coalesced migration flush; keyed by avatar. */
const pendingMigrationFlush = new Map();

export function scheduleMigrationFlush(character) {
    const avatar = character?.avatar;
    if (!avatar || pendingMigrationFlush.has(avatar)) return;
    pendingMigrationFlush.set(avatar, true);
    queueMicrotask(async () => {
        // Cleared before the persist runs so a follow-on read after this microtask
        // can re-schedule if the persist throws.
        pendingMigrationFlush.delete(avatar);
        // Use the pure raw reader here to avoid recursively re-scheduling
        // ourselves — the public `readCharacterBoundState` schedules on
        // legacy detection, which would infinite-loop when persist throws
        // (e.g. character not in ctx.characters) since raw stays legacy.
        const state = readCharacterBoundStateRaw(character);
        if (!state._migrated) return;
        delete state._migrated;
        try {
            await persistCharacterBoundState(character, state);
        } catch (err) {
            throw new Error(`character preset binding migration failed for ${avatar}: ${err?.message || err}`);
        }
    });
}

export function listCharacterBoundPresets(character) {
    const state = readCharacterBoundState(character);
    if (state._migrated) scheduleMigrationFlush(character);
    return state.presets.map(p => ({
        name: p.name,
        preset: stripOpenAIConnectionFieldsFromPreset(p.preset),
        isDefault: p.name === state.defaultPresetName,
    }));
}

export function getCharacterBoundPreset(character, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const state = readCharacterBoundState(character);
    if (state._migrated) scheduleMigrationFlush(character);
    const hit = state.presets.find(p => p.name === trimmed);
    return hit ? { name: hit.name, preset: stripOpenAIConnectionFieldsFromPreset(hit.preset) } : null;
}

export async function addCharacterBoundPreset(character, name, presetBody) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('addCharacterBoundPreset: name required');
    const stripped = stripOpenAIConnectionFieldsFromPreset(presetBody);
    const cur = readCharacterBoundState(character);
    if (cur.presets.some(p => p.name === trimmed)) {
        throw new Error(`addCharacterBoundPreset: preset already exists: ${trimmed}`);
    }
    await persistCharacterBoundState(character, {
        presets: [...cur.presets, { name: trimmed, preset: stripped }],
        // Only bootstrap default on first-add of an empty set; respect explicit setDefault(null).
        defaultPresetName: cur.presets.length === 0 ? trimmed : cur.defaultPresetName,
    });
}

export async function updateCharacterBoundPreset(character, name, presetBody) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('updateCharacterBoundPreset: name required');
    const cur = readCharacterBoundState(character);
    const idx = cur.presets.findIndex(p => p.name === trimmed);
    if (idx < 0) throw new Error(`updateCharacterBoundPreset: not found: ${trimmed}`);
    const stripped = stripOpenAIConnectionFieldsFromPreset(presetBody);
    const nextPresets = cur.presets.slice();
    nextPresets[idx] = { name: trimmed, preset: stripped };
    await persistCharacterBoundState(character, { presets: nextPresets, defaultPresetName: cur.defaultPresetName });
}

export async function removeCharacterBoundPreset(character, name) {
    const trimmed = String(name || '').trim();
    const cur = readCharacterBoundState(character);
    if (!cur.presets.some(p => p.name === trimmed)) {
        throw new Error(`removeCharacterBoundPreset: not found: ${trimmed}`);
    }
    const nextPresets = cur.presets.filter(p => p.name !== trimmed);
    const nextDefault = cur.defaultPresetName === trimmed ? null : cur.defaultPresetName;
    await persistCharacterBoundState(character, { presets: nextPresets, defaultPresetName: nextDefault });
}

export async function setCharacterBoundDefault(character, name) {
    if (name === null || name === undefined || name === '') {
        const cur = readCharacterBoundState(character);
        await persistCharacterBoundState(character, { presets: cur.presets, defaultPresetName: null });
        return;
    }
    const trimmed = String(name).trim();
    const cur = readCharacterBoundState(character);
    if (!cur.presets.some(p => p.name === trimmed)) {
        throw new Error(`setCharacterBoundDefault: name must be in presets[]: ${trimmed}`);
    }
    await persistCharacterBoundState(character, { presets: cur.presets, defaultPresetName: trimmed });
}

export function resolveCharacterBoundPresetByName(character, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return null;
    const cardHit = getCharacterBoundPreset(character, trimmed);
    if (cardHit) return { name: cardHit.name, preset: cardHit.preset, origin: 'card' };
    const global = getContext().getPresetManager?.('openai')?.getCompletionPresetByName?.(trimmed);
    if (global) return { name: trimmed, preset: stripOpenAIConnectionFieldsFromPreset(global), origin: 'global' };
    return null;
}

/**
 * Wipe the character-bound chat_completion_preset field entirely.
 * Layer 1's persist path writes an explicit `null` when presets is empty
 * AND defaultPresetName is null, which is exactly the field-cleared state.
 * Read-spread-overlay preserves sibling luker.* keys (embedded_skills_source
 * etc.). Idempotent — calling on an already-empty state is a no-op that
 * still writes `null` (harmless).
 * @param {object} character
 * @returns {Promise<void>}
 */
export async function clearAllCharacterBoundPresets(character) {
    await persistCharacterBoundState(character, { presets: [], defaultPresetName: null });
}
