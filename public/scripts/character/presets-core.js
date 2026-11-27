// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Pure core factory for character-bound chat completion presets (multi-binding).
 *
 * Stores an array of `{ name, preset }` on
 * `character.data.extensions.luker.chat_completion_preset` plus an optional
 * `defaultPresetName`. Strips API connection fields on every write and read
 * using the canonical `stripOpenAIConnectionFieldsFromPreset` helper.
 */

import { stripOpenAIConnectionFieldsFromPreset } from '../lib/openai-preset-fields.js';

const NAMESPACE = 'luker';
const FIELD = 'chat_completion_preset';

/** @typedef {{ name: string, preset: object }} BoundPreset */
/** @typedef {{ presets: BoundPreset[], defaultPresetName: string | null, _migrated?: boolean }} BoundState */

const legacyStrippedPresetCache = new WeakMap();

/**
 * Pure read of normalized bound-preset state without side effects.
 * Used by both public reads and persistence updaters.
 * @param {object} character
 * @returns {BoundState}
 */
export function readCharacterBoundStateRaw(character) {
    const raw = character?.data?.extensions?.[NAMESPACE]?.[FIELD];
    if (raw == null) return { presets: [], defaultPresetName: null };

    // Legacy bare string: name only, no body. resolveByName falls back to global.
    if (typeof raw === 'string') {
        const legacyName = raw.trim();
        return { presets: [], defaultPresetName: legacyName || null, _migrated: true };
    }

    // Legacy single-binding {name, preset}
    if (raw && typeof raw === 'object' && raw.name && raw.preset && !Array.isArray(raw.presets)) {
        let strippedPreset;
        if (typeof raw.preset === 'object') {
            strippedPreset = legacyStrippedPresetCache.get(raw.preset);
            if (!strippedPreset) {
                strippedPreset = stripOpenAIConnectionFieldsFromPreset(raw.preset);
                legacyStrippedPresetCache.set(raw.preset, strippedPreset);
            }
        } else {
            strippedPreset = stripOpenAIConnectionFieldsFromPreset(raw.preset);
        }
        return {
            presets: [{ name: String(raw.name), preset: strippedPreset }],
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
 * @param {{ getContext: () => object }} deps
 */
export function createCharacterPresetsApi({ getContext }) {
    const pendingMigrationFlush = new Map();
    const MIGRATION_ALREADY_DONE = Symbol('migrationAlreadyDone');

    function scheduleMigrationFlush(character) {
        const avatar = character?.avatar;
        if (!avatar || pendingMigrationFlush.has(avatar)) return;
        pendingMigrationFlush.set(avatar, true);
        queueMicrotask(async () => {
            pendingMigrationFlush.delete(avatar);
            try {
                const context = getContext();
                const id = context.characters.indexOf(character);
                if (id < 0) return;
                const ok = await context.writeExtensionField(id, NAMESPACE, current => {
                    const state = readCharacterBoundStateRaw({ data: { extensions: { [NAMESPACE]: current } } });
                    if (!state._migrated) throw MIGRATION_ALREADY_DONE;
                    const normalizedDefault = typeof state.defaultPresetName === 'string' && state.defaultPresetName.trim()
                        ? state.defaultPresetName.trim()
                        : null;
                    return { ...current, [FIELD]: { presets: state.presets, defaultPresetName: normalizedDefault } };
                });
                if (ok === false) {
                    console.error(`character preset binding migration failed for ${avatar}: save returned false`);
                }
            } catch (err) {
                if (err === MIGRATION_ALREADY_DONE) return;
                console.error(`character preset binding migration failed for ${avatar}:`, err);
            }
        });
    }

    function readCharacterBoundState(character) {
        const state = readCharacterBoundStateRaw(character);
        if (state._migrated) scheduleMigrationFlush(character);
        return state;
    }

    async function mutateCharacterBoundState(character, mutate) {
        const context = getContext();
        const id = context.characters.indexOf(character);
        if (id < 0) throw new Error('Character preset target is no longer available');
        const ok = await context.writeExtensionField(id, NAMESPACE, previous => {
            const cur = readCharacterBoundStateRaw({ data: { extensions: { [NAMESPACE]: previous } } });
            const state = mutate(cur);
            const normalizedDefault = typeof state?.defaultPresetName === 'string' && state.defaultPresetName.trim()
                ? state.defaultPresetName.trim()
                : null;
            const value = state.presets.length === 0 && !normalizedDefault ? null : { presets: state.presets, defaultPresetName: normalizedDefault };
            return { ...previous, [FIELD]: value };
        });
        if (ok === false) throw new Error('Failed to save character-bound presets');
    }

    async function writeCharacterBoundStateById(characterId, state) {
        const context = getContext();
        const character = context.characters?.[characterId];
        if (!character) {
            throw new Error(`writeCharacterBoundStateById: character not found at index ${characterId}`);
        }
        const rawDefault = typeof state?.defaultPresetName === 'string' ? state.defaultPresetName.trim() : '';
        const snapshotPresets = Array.isArray(state?.presets) ? structuredClone(state.presets) : [];
        await mutateCharacterBoundState(character, () => ({
            presets: snapshotPresets,
            defaultPresetName: rawDefault || null,
        }));
    }

    function listCharacterBoundPresets(character) {
        const state = readCharacterBoundState(character);
        return state.presets.map(p => ({
            name: p.name,
            preset: stripOpenAIConnectionFieldsFromPreset(p.preset),
            isDefault: p.name === state.defaultPresetName,
        }));
    }

    function getCharacterBoundPreset(character, name) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return null;
        const state = readCharacterBoundState(character);
        const hit = state.presets.find(p => p.name === trimmed);
        return hit ? { name: hit.name, preset: stripOpenAIConnectionFieldsFromPreset(hit.preset) } : null;
    }

    async function addCharacterBoundPreset(character, name, presetBody) {
        const trimmed = String(name || '').trim();
        if (!trimmed) throw new Error('addCharacterBoundPreset: name required');
        const stripped = stripOpenAIConnectionFieldsFromPreset(structuredClone(presetBody));
        return mutateCharacterBoundState(character, cur => {
            if (cur.presets.some(p => p.name === trimmed)) {
                throw new Error(`addCharacterBoundPreset: preset already exists: ${trimmed}`);
            }
            return {
                presets: [...cur.presets, { name: trimmed, preset: stripped }],
                defaultPresetName: cur.presets.length === 0 ? trimmed : cur.defaultPresetName,
            };
        });
    }

    async function updateCharacterBoundPreset(character, name, presetBody) {
        const trimmed = String(name || '').trim();
        if (!trimmed) throw new Error('updateCharacterBoundPreset: name required');
        const stripped = stripOpenAIConnectionFieldsFromPreset(structuredClone(presetBody));
        return mutateCharacterBoundState(character, cur => {
            const idx = cur.presets.findIndex(p => p.name === trimmed);
            if (idx < 0) throw new Error(`updateCharacterBoundPreset: not found: ${trimmed}`);
            const nextPresets = cur.presets.slice();
            nextPresets[idx] = { name: trimmed, preset: stripped };
            return { presets: nextPresets, defaultPresetName: cur.defaultPresetName };
        });
    }

    async function removeCharacterBoundPreset(character, name) {
        const trimmed = String(name || '').trim();
        return mutateCharacterBoundState(character, cur => {
            if (!cur.presets.some(p => p.name === trimmed)) {
                throw new Error(`removeCharacterBoundPreset: not found: ${trimmed}`);
            }
            const nextPresets = cur.presets.filter(p => p.name !== trimmed);
            const nextDefault = cur.defaultPresetName === trimmed ? null : cur.defaultPresetName;
            return { presets: nextPresets, defaultPresetName: nextDefault };
        });
    }

    async function setCharacterBoundDefault(character, name) {
        return mutateCharacterBoundState(character, cur => {
            if (name === null || name === undefined || name === '') {
                return { presets: cur.presets, defaultPresetName: null };
            }
            const trimmed = String(name).trim();
            if (!cur.presets.some(p => p.name === trimmed)) {
                throw new Error(`setCharacterBoundDefault: name must be in presets[]: ${trimmed}`);
            }
            return { presets: cur.presets, defaultPresetName: trimmed };
        });
    }

    function resolveCharacterBoundPresetByName(character, name) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return null;
        const cardHit = getCharacterBoundPreset(character, trimmed);
        if (cardHit) return { name: cardHit.name, preset: cardHit.preset, origin: 'card' };
        const global = getContext().getPresetManager?.('openai')?.getCompletionPresetByName?.(trimmed);
        if (global) return { name: trimmed, preset: stripOpenAIConnectionFieldsFromPreset(global), origin: 'global' };
        return null;
    }

    async function renameCharacterBoundPreset(character, oldName, newName) {
        const oldTrim = String(oldName || '').trim();
        const newTrim = String(newName || '').trim();
        if (!oldTrim || !newTrim) throw new Error('renameCharacterBoundPreset: oldName and newName required');
        if (oldTrim === newTrim) return;
        return mutateCharacterBoundState(character, cur => {
            const idx = cur.presets.findIndex(p => p.name === oldTrim);
            if (idx < 0) throw new Error(`renameCharacterBoundPreset: not found: ${oldTrim}`);
            if (cur.presets.some(p => p.name === newTrim)) {
                throw new Error(`renameCharacterBoundPreset: name already exists: ${newTrim}`);
            }
            const nextPresets = cur.presets.slice();
            nextPresets[idx] = { name: newTrim, preset: nextPresets[idx].preset };
            const nextDefault = cur.defaultPresetName === oldTrim ? newTrim : cur.defaultPresetName;
            return { presets: nextPresets, defaultPresetName: nextDefault };
        });
    }

    async function clearAllCharacterBoundPresets(character) {
        await mutateCharacterBoundState(character, () => ({ presets: [], defaultPresetName: null }));
    }

    return {
        readCharacterBoundStateRaw,
        readCharacterBoundState,
        writeCharacterBoundStateById,
        scheduleMigrationFlush,
        listCharacterBoundPresets,
        getCharacterBoundPreset,
        addCharacterBoundPreset,
        updateCharacterBoundPreset,
        removeCharacterBoundPreset,
        setCharacterBoundDefault,
        resolveCharacterBoundPresetByName,
        renameCharacterBoundPreset,
        clearAllCharacterBoundPresets,
    };
}
