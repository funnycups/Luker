// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Descriptor only. Skill author/edit ops are modelled as patches on the
// skill-registry projection; the target-registry handler for
// type='skill-registry' wraps the underlying skills API.
export const skillAuthor = {
    kind: 'skill-author',
    targetType: 'skill-registry',
};

export function createSkillAuthorHandler(_opts = {}) {
    return skillAuthor;
}
