// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Public factory for the per-popup ProposalBus. See bus.js + sibling
 * modules for the full surface; index.js stitches the pieces together
 * so popups import one symbol and get the complete bus.
 *
 * Re-exports for popup-defined custom kinds and target descriptors:
 *   - createProfileEditHandler / createLorebookWriteHandler /
 *     createSkillAuthorHandler / createPresetCloneHandler return the
 *     descriptor `{kind, targetType}`; popups register these on the
 *     bus and provide the matching target handler to the
 *     target-registry.
 */

import { createBus } from './bus.js';

export { createProfileEditHandler, profileEdit } from './kinds/profile-edit.js';
export { createLorebookWriteHandler, lorebookWrite } from './kinds/lorebook-write.js';
export { createSkillAuthorHandler, skillAuthor } from './kinds/skill-author.js';
export { createPresetCloneHandler, presetClone } from './kinds/preset-clone.js';

export function createProposalBus(opts) {
    return createBus(opts);
}


