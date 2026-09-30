// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Card binding preservation slot for the memory-graph per-card overrides.
 *
 * Covers only `schemaOverride` and `advancedOverride` inside
 * `data.extensions.memory_graph`. Writes go through the existing
 * `character-overrides.js` persist helpers so normalization and
 * sibling-preserving spreads stay in one place.
 */

import { i18n } from './i18n.js';
import {
    persistCharacterSchemaOverride,
    persistCharacterAdvancedOverride,
} from './character-overrides.js';

export const MEMORY_GRAPH_BINDING_SLOT_ID = 'memory-graph-override';

function isNonEmpty(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value != null;
}

export function readMemoryGraphCardOverride(character) {
    const ext = character?.data?.extensions?.memory_graph;
    if (!ext || typeof ext !== 'object' || Array.isArray(ext)) {
        return null;
    }
    const value = {};
    if (ext.schemaOverride != null) {
        value.schemaOverride = ext.schemaOverride;
    }
    if (ext.advancedOverride != null) {
        value.advancedOverride = ext.advancedOverride;
    }
    return Object.keys(value).length ? value : null;
}

export function hasMemoryGraphCardOverride(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    return isNonEmpty(value.schemaOverride) || isNonEmpty(value.advancedOverride);
}

export function summarizeMemoryGraphCardOverride(value) {
    const hasSchema = isNonEmpty(value?.schemaOverride);
    const hasAdvanced = isNonEmpty(value?.advancedOverride);
    if (hasSchema && hasAdvanced) {
        return i18n('Card schema + advanced settings');
    }
    if (hasSchema) {
        return i18n('Card schema override');
    }
    return i18n('Card advanced settings override');
}

export function registerMemoryGraphCardBindingSlot(context) {
    if (typeof context?.registerCardBindingSlot !== 'function') {
        return;
    }
    context.registerCardBindingSlot({
        id: MEMORY_GRAPH_BINDING_SLOT_ID,
        label: () => i18n('Memory graph (card customizations)'),
        read: readMemoryGraphCardOverride,
        isPresent: hasMemoryGraphCardOverride,
        summarize: summarizeMemoryGraphCardOverride,
        write: async (characterId, preserved) => {
            const avatar = context.characters?.[characterId]?.avatar;
            if (!avatar) {
                throw new Error(`${MEMORY_GRAPH_BINDING_SLOT_ID}: character not found at index ${characterId}`);
            }
            if (isNonEmpty(preserved?.schemaOverride)) {
                await persistCharacterSchemaOverride(context, avatar, preserved.schemaOverride);
            }
            if (isNonEmpty(preserved?.advancedOverride)) {
                await persistCharacterAdvancedOverride(context, avatar, preserved.advancedOverride);
            }
        },
    });
}
