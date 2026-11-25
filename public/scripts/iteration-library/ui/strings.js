// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * English keys for new patch-conflict UI strings introduced alongside
 * the patch-based session storage. Each iteration-library popup uses
 * these keys via its own translator, with shared fallback translations
 * in the core locale files.
 */

import { CONFLICT_CODES } from '../../lib/state-errors.js';
import { LOREBOOK_ENTRY_TARGET_TYPE } from '../proposal-bus/targets/lorebook-entry.js';

export const STR = {
    rollbackFail_preset: 'Cannot undo this change: the preset has been modified elsewhere.',
    rollbackFail_schema: 'Cannot undo this change: the memory graph schema has been modified elsewhere.',
    rollbackFail_character: 'Cannot undo this change: the character card has been modified elsewhere.',
    rollbackFail_lorebook: 'Cannot undo this change: the world book has been modified elsewhere.',
    rollbackFail_profile: 'Cannot undo this change: the profile has been modified elsewhere.',
    rollbackFail_skills: 'Cannot undo this change: the skills have been modified elsewhere.',

    previewFail_generic: 'Cannot show details for this change: related content has been modified.',
    notRestorable_generic: 'This change was saved by an older version and cannot be applied after a reload. Discard this step and request the change again.',
    chainBroken_generic: 'Cannot continue editing in this session: the underlying content has changed. Please start a new session.',
};

export function conflictSummaryKey(conflictError, targetType) {
    if (conflictError && conflictError.code === CONFLICT_CODES.NOT_RESTORABLE) {
        return STR.notRestorable_generic;
    }
    return rollbackFailKeyForTargetType(targetType) || STR.previewFail_generic;
}

export function rollbackFailKeyForTargetType(targetType) {
    switch (String(targetType || '')) {
        case 'preset':         return STR.rollbackFail_preset;
        case 'schema':         return STR.rollbackFail_schema;
        case 'character':      return STR.rollbackFail_character;
        case 'lorebook':       return STR.rollbackFail_lorebook;
        case LOREBOOK_ENTRY_TARGET_TYPE: return STR.rollbackFail_lorebook;
        case 'profile':        return STR.rollbackFail_profile;
        case 'skill-registry': return STR.rollbackFail_skills;
        default:               return STR.previewFail_generic;
    }
}
