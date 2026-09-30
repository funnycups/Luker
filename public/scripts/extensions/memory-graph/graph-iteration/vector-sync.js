// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Incremental vector-index maintenance for graph-iteration approvals.
 *
 * The manual graph editor never syncs the vector index (node edits leave
 * stale embeddings until a rebuild). The graph-iteration studio must not
 * inherit that defect: every approved mutation that touches the node set or
 * node text runs one incremental sync. Edge-only changes never trigger it
 * (edges do not participate in embeddings).
 *
 * Pure orchestrator: the embedding profile, the sync implementation and the
 * meta persistence are injected, so this module is jest-importable without
 * the browser embedding stack.
 */

import { validateVectorConfig } from '../vector-index-core.js';

export function resolveGraphVectorProfile(settings, getProfileById) {
    const id = String(settings?.embeddingProfileId || '').trim();
    if (!id) return null;
    const profile = typeof getProfileById === 'function' ? getProfileById(id) : null;
    return validateVectorConfig(profile).valid ? profile : null;
}

export async function syncGraphVectorsAfterMutation({
    store,
    chatKey,
    settings,
    profile,
    schema,
    syncFn,
    persistFn,
} = {}) {
    if (!store || typeof store !== 'object') return { skipped: true, reason: 'no store' };
    if (!profile) return { skipped: true, reason: 'no embedding profile' };
    if (typeof syncFn !== 'function' || typeof persistFn !== 'function') {
        throw new Error('syncGraphVectorsAfterMutation: syncFn and persistFn are required.');
    }
    await syncFn(store, profile, String(chatKey || ''), { schema: schema || null, tolerateErrors: true });
    // syncVectorIndex mutates store.vectorIndexState in place; that field is
    // persisted through the meta sidecar, so flush meta-only afterwards.
    await persistFn(store);
    return { skipped: false };
}
