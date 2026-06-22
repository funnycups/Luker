// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Descriptor only. Target read/write lives in the target-registry; the
// bus encodes inverse patches at propose time and routes commit/rollback
// through that handler.
export const profileEdit = {
    kind: 'profile-edit',
    targetType: 'profile',
};

export function createProfileEditHandler(_opts = {}) {
    return profileEdit;
}
