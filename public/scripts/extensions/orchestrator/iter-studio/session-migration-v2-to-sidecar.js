// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * One-shot migrator: drains
 *   extension_settings.orchestrator.iterStudioV2[mode][scope]
 * into per-character sidecars (when scope === 'character_<avatar>')
 * and into
 *   extension_settings.orchestrator.iter_studio_global_sessions[mode]
 * (when scope === 'global').
 *
 * Idempotent via `MIGRATION_FLAG_KEY` on the settings root. Skips
 * entries whose avatar is no longer in the character list (no destructive
 * write); skips entries whose sidecar write throws (no data loss); leaves
 * the V2 bucket entry in place in both skip paths so a future run can
 * retry. On full success, deletes the entire `iterStudioV2` key so the
 * next save() under any mode lazy-creates a fresh global bucket.
 */

import { ORCH_SIDECAR_NAMESPACE, ORCH_GLOBAL_BUCKET_KEY } from './session-store.js';

const V2_BUCKET_KEY = 'iterStudioV2';
export const MIGRATION_FLAG_KEY = '__iterStudioV2ToSidecarMigratedAt';
const SIDECAR_SCHEMA_VERSION = 1;

function isKnownAvatar(ctx, avatar) {
    const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
    return list.some(c => String(c?.avatar || '') === avatar);
}

async function mergeSessionsIntoSidecar(ctx, avatar, newSessions) {
    const result = await ctx.updateCharacterState(avatar, ORCH_SIDECAR_NAMESPACE, (current) => {
        const base = (current && typeof current === 'object' && current.sessions && typeof current.sessions === 'object')
            ? { ...current.sessions }
            : {};
        for (const [sid, session] of Object.entries(newSessions)) {
            base[sid] = session;
        }
        return { version: SIDECAR_SCHEMA_VERSION, sessions: base };
    });
    if (!result.ok) {
        throw new Error(`sidecar write failed (${result.reason}): ${result.hint}`);
    }
}

export async function migrateOrchSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings }) {
    if (!settingsRoot || typeof settingsRoot !== 'object') {
        return { migrated: 0, skipped: 0, globalMoved: 0 };
    }
    if (settingsRoot[MIGRATION_FLAG_KEY]) {
        return { migrated: 0, skipped: 0, globalMoved: 0 };
    }
    const v2 = settingsRoot[V2_BUCKET_KEY];
    if (!v2 || typeof v2 !== 'object') {
        settingsRoot[MIGRATION_FLAG_KEY] = true;
        if (typeof persistSettings === 'function') persistSettings();
        return { migrated: 0, skipped: 0, globalMoved: 0 };
    }
    let migrated = 0;
    let skipped = 0;
    let globalMoved = 0;
    const sidecarFailures = new Set();

    for (const [mode, scopeMap] of Object.entries(v2)) {
        if (!scopeMap || typeof scopeMap !== 'object') continue;
        for (const [scope, sessionMap] of Object.entries(scopeMap)) {
            if (!sessionMap || typeof sessionMap !== 'object') continue;
            if (scope === 'global') {
                if (!settingsRoot[ORCH_GLOBAL_BUCKET_KEY] || typeof settingsRoot[ORCH_GLOBAL_BUCKET_KEY] !== 'object') {
                    settingsRoot[ORCH_GLOBAL_BUCKET_KEY] = {};
                }
                if (!settingsRoot[ORCH_GLOBAL_BUCKET_KEY][mode] || typeof settingsRoot[ORCH_GLOBAL_BUCKET_KEY][mode] !== 'object') {
                    settingsRoot[ORCH_GLOBAL_BUCKET_KEY][mode] = {};
                }
                for (const [sid, session] of Object.entries(sessionMap)) {
                    settingsRoot[ORCH_GLOBAL_BUCKET_KEY][mode][sid] = session;
                    globalMoved += 1;
                }
                continue;
            }
            // Empty bucket has nothing to migrate or lose; drop it cleanly
            // without classifying it as a failure (otherwise an orphan from
            // a deleted character keeps the migration flag from ever setting).
            if (Object.keys(sessionMap).length === 0) {
                delete scopeMap[scope];
                continue;
            }
            if (!scope.startsWith('character_')) {
                skipped += Object.keys(sessionMap).length;
                continue;
            }
            const avatar = scope.slice('character_'.length).trim();
            if (!avatar) {
                skipped += Object.keys(sessionMap).length;
                continue;
            }
            if (!isKnownAvatar(ctx, avatar)) {
                console.warn(`[orchestrator iter-studio migration] avatar not found in character list, skipping: ${avatar}`);
                skipped += Object.keys(sessionMap).length;
                sidecarFailures.add(`${mode}:${scope}`);
                continue;
            }
            try {
                await mergeSessionsIntoSidecar(ctx, avatar, sessionMap);
                migrated += Object.keys(sessionMap).length;
            } catch (err) {
                console.warn(`[orchestrator iter-studio migration] sidecar write failed for ${avatar}:`, err?.message || err);
                skipped += Object.keys(sessionMap).length;
                sidecarFailures.add(`${mode}:${scope}`);
            }
        }
    }

    if (sidecarFailures.size === 0) {
        delete settingsRoot[V2_BUCKET_KEY];
        settingsRoot[MIGRATION_FLAG_KEY] = true;
    } else {
        // Partial success: keep V2 bucket entries that failed; remove the rest
        for (const [mode, scopeMap] of Object.entries(v2)) {
            for (const scope of Object.keys(scopeMap)) {
                if (!sidecarFailures.has(`${mode}:${scope}`) && scope !== 'global') {
                    delete scopeMap[scope];
                }
                if (scope === 'global') {
                    delete scopeMap[scope];
                }
            }
            if (Object.keys(scopeMap).length === 0) {
                delete v2[mode];
            }
        }
        if (Object.keys(v2).length === 0) {
            delete settingsRoot[V2_BUCKET_KEY];
            settingsRoot[MIGRATION_FLAG_KEY] = true;
        }
    }

    if (typeof persistSettings === 'function') persistSettings();
    return { migrated, skipped, globalMoved };
}
