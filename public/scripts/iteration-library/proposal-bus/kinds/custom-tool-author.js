// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Descriptor for custom-tool-author ProposalBus cards. The target-registry
 * handler for type='orch-custom-tool' applies the captured op against the
 * live profile (via commitApprovedCustomToolProposal) at Apply time so
 * concurrent drift surfaces as an error rather than a stale snapshot
 * clobber.
 */
// Proposals carry `before === after` and the target replays the captured
// op, so the kind opts out of rollback.
export const customToolAuthor = {
    kind: 'custom-tool-author',
    targetType: 'orch-custom-tool',
    inverseAvailable: false,
};

export function createCustomToolAuthorHandler(_opts = {}) {
    return customToolAuthor;
}
