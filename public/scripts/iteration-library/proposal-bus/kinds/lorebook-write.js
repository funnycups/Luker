// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { LOREBOOK_ENTRY_TARGET_TYPE } from '../targets/lorebook-entry.js';

// Descriptor only. Proposals address one world-book entry; the shared
// entry target (`targets/lorebook-entry.js`) owns read/write.
export const lorebookWrite = {
    kind: 'lorebook-write',
    targetType: LOREBOOK_ENTRY_TARGET_TYPE,
};

export function createLorebookWriteHandler(_opts = {}) {
    return lorebookWrite;
}
