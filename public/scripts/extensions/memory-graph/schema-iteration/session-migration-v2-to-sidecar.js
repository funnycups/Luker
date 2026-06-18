// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * One-shot migrator for MG schema-iteration sessions.
 *
 * V2 stored all schema-iteration sessions in a single FLAT map under
 *   extension_settings.memory_graph.iterStudioV2Schema
 * (V2 didn't carry a per-character dimension for MG even though the
 * schema itself had character overrides). On migration:
 *   - All V2 entries move into the new global bucket
 *     `extension_settings.memory_graph.schema_iter_global_sessions`.
 *   - The V2 key is deleted.
 *   - Flag set on the settings root so subsequent mounts skip.
 *
 * We deliberately don't try to retroactively assign sessions to per-
 * character sidecars: V2 didn't record which character (if any) a session
 * targeted. Pre-existing sessions therefore land in the global bucket;
 * NEW sessions authored after migration will route correctly per the
 * scope-aware store from Task 8.
 */

import { MG_GLOBAL_BUCKET_KEY } from './session-store.js';

const V2_BUCKET_KEY = 'iterStudioV2Schema';
export const MG_MIGRATION_FLAG_KEY = '__schemaIterV2ToSidecarMigratedAt';

export async function migrateMgSchemaSessionsV2ToSidecar({ settingsRoot, ctx: _ctx, persistSettings }) {
    if (!settingsRoot || typeof settingsRoot !== 'object') return { migrated: 0, skipped: 0, globalMoved: 0 };
    if (settingsRoot[MG_MIGRATION_FLAG_KEY]) return { migrated: 0, skipped: 0, globalMoved: 0 };
    const v2 = settingsRoot[V2_BUCKET_KEY];
    if (!v2 || typeof v2 !== 'object') {
        settingsRoot[MG_MIGRATION_FLAG_KEY] = true;
        if (typeof persistSettings === 'function') persistSettings();
        return { migrated: 0, skipped: 0, globalMoved: 0 };
    }
    if (!settingsRoot[MG_GLOBAL_BUCKET_KEY] || typeof settingsRoot[MG_GLOBAL_BUCKET_KEY] !== 'object') {
        settingsRoot[MG_GLOBAL_BUCKET_KEY] = {};
    }
    let globalMoved = 0;
    for (const [sid, session] of Object.entries(v2)) {
        if (!session || typeof session !== 'object' || !session.id) continue;
        settingsRoot[MG_GLOBAL_BUCKET_KEY][sid] = session;
        globalMoved += 1;
    }
    delete settingsRoot[V2_BUCKET_KEY];
    settingsRoot[MG_MIGRATION_FLAG_KEY] = true;
    if (typeof persistSettings === 'function') persistSettings();
    return { migrated: 0, skipped: 0, globalMoved };
}
