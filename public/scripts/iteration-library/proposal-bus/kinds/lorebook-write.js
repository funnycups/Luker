// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Descriptor only. The actual lorebook read/write lives in the
// target-registry handler registered for type='lorebook'.
export const lorebookWrite = {
    kind: 'lorebook-write',
    targetType: 'lorebook',
};

export function createLorebookWriteHandler(_opts = {}) {
    return lorebookWrite;
}
