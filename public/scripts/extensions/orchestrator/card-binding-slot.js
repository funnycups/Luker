// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Card binding preservation slot for the orchestrator's per-card override.
 *
 * The preserved container covers only the override-related keys of
 * `data.extensions.orchestrator` (presetLibraries / activePresetIds /
 * override / overrideEnabled). Legacy shapes are copied verbatim — the
 * orchestrator's own read-path migration lifts them later. Sibling keys on
 * the new card (e.g. customTools) are always preserved.
 */

import { i18n, i18nFormat } from './i18n.js';

export const ORCHESTRATOR_BINDING_SLOT_ID = 'orchestrator-override';

const MODE_KEYS = ['spec', 'agenda', 'loop', 'director'];
const LEGACY_OVERRIDE_KEYS = ['spec', 'presets', 'presetPatch', 'agenda', 'loop', 'director', 'mode'];
const OVERRIDE_CONTAINER_KEYS = ['presetLibraries', 'activePresetIds', 'override', 'overrideEnabled'];

function isNonEmptyObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

/**
 * Read the card's override container. Returns null when the card carries no
 * override-related key.
 */
export function readOrchestratorCardOverride(character) {
    const ext = character?.data?.extensions?.orchestrator;
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
        return null;
    }
    const value = {};
    for (const key of OVERRIDE_CONTAINER_KEYS) {
        if (isNonEmptyObject(ext[key])) {
            value[key] = ext[key];
        }
    }
    return Object.keys(value).length ? value : null;
}

/** True when the container describes a user-saved orchestration setup. */
export function hasOrchestratorCardOverride(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    if (value.presetLibraries && MODE_KEYS.some(mode => isNonEmptyObject(value.presetLibraries[mode]))) {
        return true;
    }
    if (value.activePresetIds && MODE_KEYS.some(mode => String(value.activePresetIds[mode] || '').trim())) {
        return true;
    }
    if (value.override) {
        for (const key of LEGACY_OVERRIDE_KEYS) {
            const raw = value.override[key];
            if (isNonEmptyObject(raw) || (typeof raw === 'string' && raw.trim())) {
                return true;
            }
        }
    }
    if (value.overrideEnabled && MODE_KEYS.some(mode => typeof value.overrideEnabled[mode] === 'boolean')) {
        return true;
    }
    return false;
}

export function summarizeOrchestratorCardOverride(value) {
    const modes = [];
    if (value?.presetLibraries) {
        for (const mode of MODE_KEYS) {
            if (isNonEmptyObject(value.presetLibraries[mode])) {
                modes.push(mode);
            }
        }
    }
    if (modes.length === 0 && value?.activePresetIds) {
        for (const mode of MODE_KEYS) {
            if (String(value.activePresetIds[mode] || '').trim()) {
                modes.push(mode);
            }
        }
    }
    if (modes.length > 0) {
        return i18nFormat('Saved mode presets: ${0}', modes.join(' · '));
    }
    return i18n('Custom orchestration settings');
}

/** Overlay the preserved container onto the new card's blob, keeping siblings. */
export function buildOrchestratorOverlay(nextExt, preserved) {
    const next = isNonEmptyObject(nextExt) ? { ...nextExt } : {};
    for (const key of OVERRIDE_CONTAINER_KEYS) {
        if (preserved?.[key] !== undefined) {
            next[key] = preserved[key];
        }
    }
    return next;
}

export function registerOrchestratorCardBindingSlot(context) {
    if (typeof context?.registerCardBindingSlot !== 'function') {
        return;
    }
    context.registerCardBindingSlot({
        id: ORCHESTRATOR_BINDING_SLOT_ID,
        label: () => i18n('Multi-agent orchestration (card settings)'),
        read: readOrchestratorCardOverride,
        isPresent: hasOrchestratorCardOverride,
        summarize: summarizeOrchestratorCardOverride,
        write: async (characterId, preserved) => {
            const character = context.characters?.[characterId];
            const nextExt = buildOrchestratorOverlay(
                character?.data?.extensions?.orchestrator,
                preserved,
            );
            await context.writeExtensionField(characterId, 'orchestrator', nextExt);
        },
    });
}
