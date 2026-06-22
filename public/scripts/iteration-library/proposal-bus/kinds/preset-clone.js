// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

// Descriptor only. Clone-and-switch is non-rollbackable: even though
// `compare(before, after)` produces a non-empty inverse for the
// preset-shape delta, the user-visible operation is "fork into a new
// preset and switch to it", which has no auto-applicable undo. Setting
// `inverseAvailable: false` keeps the proposal-card chrome from
// surfacing a Rollback button that would only mislead. The
// target-registry handler for type='preset' models the read/write
// boundary; if anyone bypasses the UI and calls bus.rollback directly,
// the target handler is still the place to refuse the write.
export const presetClone = {
    kind: 'preset-clone',
    targetType: 'preset',
    inverseAvailable: false,
};

export function createPresetCloneHandler(_opts = {}) {
    return presetClone;
}
