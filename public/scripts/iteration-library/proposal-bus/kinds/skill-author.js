// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Descriptor only. Skill author/edit ops are modelled as patches on the
// skill-registry projection; the target-registry handler for
// type='skill-registry' (`ensureSkillRegistryTarget`) replays the captured
// op against the skills API. Proposals carry `before === after`, and a
// replayed op is not an undo, so the kind opts out of rollback.
export const skillAuthor = {
    kind: 'skill-author',
    targetType: 'skill-registry',
    inverseAvailable: false,
};

export function createSkillAuthorHandler(_opts = {}) {
    return skillAuthor;
}
