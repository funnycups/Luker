// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Public factory for the per-popup ProposalBus. See bus.js + sibling
 * modules for the full surface; index.js stitches the pieces together
 * so popups import one symbol and get the complete bus.
 *
 * Additional re-exports for popup-defined custom kinds:
 *   - sha256OfJson / canonicalJson / sha256OfString from `fingerprint.js`
 *     so popups can reuse the same hash function the built-in kinds use
 *     (and stay drift-compatible across kinds).
 *   - createProfileEditHandler / createLorebookWriteHandler /
 *     createSkillAuthorHandler / createPresetCloneHandler so consumers
 *     reaching the bus through the iteration-library public surface
 *     (Layer 2/3 via `getContext().iterationLibrary.proposalBus`) can
 *     build kinds without poking into internal kind file paths. This
 *     mirrors how `tools/index.js` re-exports its named tool catalogs.
 */

import { createBus } from './bus.js';

export { sha256OfJson, sha256OfString, canonicalJson } from './fingerprint.js';
export { createProfileEditHandler } from './kinds/profile-edit.js';
export { createLorebookWriteHandler } from './kinds/lorebook-write.js';
export { createSkillAuthorHandler } from './kinds/skill-author.js';
export { createPresetCloneHandler } from './kinds/preset-clone.js';

export function createProposalBus(opts) {
    return createBus(opts);
}
