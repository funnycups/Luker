// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Layer 1 — Character-bound chat completion presets (multi-binding).
 * Thin browser entry wiring `getContext` onto `createCharacterPresetsApi`.
 */

import { getContext } from '/scripts/st-context.js';
import { createCharacterPresetsApi, readCharacterBoundStateRaw } from './presets-core.js';

const api = createCharacterPresetsApi({ getContext });

export { createCharacterPresetsApi, readCharacterBoundStateRaw };
export const {
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
} = api;
