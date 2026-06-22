// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * English keys for new patch-conflict UI strings introduced alongside
 * the patch-based session storage. Each iteration-library popup uses
 * these keys via its own translator; the four extensions (CPA, CEA,
 * memory-graph, orchestrator) each register matching zh-CN + zh-TW
 * translations into their own locale tables.
 */
export const STR = {
    rollbackFail_preset:    'Cannot undo this change: the preset has been modified elsewhere.',
    rollbackFail_schema:    'Cannot undo this change: the memory graph schema has been modified elsewhere.',
    rollbackFail_character: 'Cannot undo this change: the character card has been modified elsewhere.',
    rollbackFail_lorebook:  'Cannot undo this change: the world book has been modified elsewhere.',
    rollbackFail_profile:   'Cannot undo this change: the profile has been modified elsewhere.',
    rollbackFail_skills:    'Cannot undo this change: the skills have been modified elsewhere.',

    previewFail_generic:    'Cannot show details for this change: related content has been modified.',
    chainBroken_generic:    'Cannot continue editing in this session: the underlying content has changed. Please start a new session.',

    btn_forceDiscard:       'Discard this step anyway',
    btn_exportRecord:       'Export change details',
    btn_viewRawRecord:      'View raw record',

    migrationFailed_toast:  'Session "${0}" cannot be migrated to the new format. It has been skipped and is unavailable.',
};

export function rollbackFailKeyForTargetType(targetType) {
    switch (String(targetType || '')) {
        case 'preset':         return STR.rollbackFail_preset;
        case 'schema':         return STR.rollbackFail_schema;
        case 'character':      return STR.rollbackFail_character;
        case 'lorebook':       return STR.rollbackFail_lorebook;
        case 'profile':        return STR.rollbackFail_profile;
        case 'skill-registry': return STR.rollbackFail_skills;
        default:               return STR.previewFail_generic;
    }
}
