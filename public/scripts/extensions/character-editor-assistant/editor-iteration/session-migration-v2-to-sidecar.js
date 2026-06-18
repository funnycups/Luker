// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * One-shot migrator: drains
 *   extension_settings.character_editor_assistant.unified_cea_editor_sessions[char_<avatar>]
 * into per-character sidecars under CEA_SIDECAR_NAMESPACE.
 *
 * CEA never had a global scope, so every key under the V2 bucket must be
 * `char_<avatar>`. Anything else is skipped + warned. Idempotent via
 * CEA_MIGRATION_FLAG_KEY.
 */

import { CEA_SIDECAR_NAMESPACE } from './session-store.js';

const V2_BUCKET_KEY = 'unified_cea_editor_sessions';
export const CEA_MIGRATION_FLAG_KEY = '__unifiedCeaEditorV2ToSidecarMigratedAt';
const SIDECAR_SCHEMA_VERSION = 1;

function isKnownAvatar(ctx, avatar) {
    const list = Array.isArray(ctx?.characters) ? ctx.characters : [];
    return list.some(c => String(c?.avatar || '') === avatar);
}

async function readSidecar(ctx, avatar) {
    try {
        const raw = await ctx.getCharacterState(avatar, CEA_SIDECAR_NAMESPACE);
        if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
            return raw;
        }
    } catch { /* ignore */ }
    return { version: SIDECAR_SCHEMA_VERSION, sessions: {} };
}

async function writeSidecar(ctx, avatar, sessions) {
    await ctx.setCharacterState(avatar, CEA_SIDECAR_NAMESPACE, {
        version: SIDECAR_SCHEMA_VERSION,
        sessions,
    });
}

export async function migrateCeaSessionsV2ToSidecar({ settingsRoot, ctx, persistSettings }) {
    if (!settingsRoot || typeof settingsRoot !== 'object') return { migrated: 0, skipped: 0 };
    if (settingsRoot[CEA_MIGRATION_FLAG_KEY]) return { migrated: 0, skipped: 0 };
    const v2 = settingsRoot[V2_BUCKET_KEY];
    if (!v2 || typeof v2 !== 'object') {
        settingsRoot[CEA_MIGRATION_FLAG_KEY] = true;
        if (typeof persistSettings === 'function') persistSettings();
        return { migrated: 0, skipped: 0 };
    }
    let migrated = 0;
    let skipped = 0;
    const failedKeys = new Set();

    for (const [scope, sessionMap] of Object.entries(v2)) {
        if (!sessionMap || typeof sessionMap !== 'object') continue;
        // Empty bucket has nothing to migrate or lose; drop it cleanly
        // without classifying it as a failure (otherwise an orphan from
        // a deleted character keeps the migration flag from ever setting,
        // forcing the migrator to re-run on every popup mount).
        if (Object.keys(sessionMap).length === 0) {
            delete v2[scope];
            continue;
        }
        if (!scope.startsWith('char_')) {
            console.warn(`[CEA editor migration] unexpected non-char scope in V2 bucket: ${scope}`);
            skipped += Object.keys(sessionMap).length;
            failedKeys.add(scope);
            continue;
        }
        const avatar = scope.slice('char_'.length).trim();
        if (!avatar) {
            skipped += Object.keys(sessionMap).length;
            failedKeys.add(scope);
            continue;
        }
        if (!isKnownAvatar(ctx, avatar)) {
            console.warn(`[CEA editor migration] avatar not found in character list, skipping: ${avatar}`);
            skipped += Object.keys(sessionMap).length;
            failedKeys.add(scope);
            continue;
        }
        try {
            const payload = await readSidecar(ctx, avatar);
            for (const [sid, session] of Object.entries(sessionMap)) {
                payload.sessions[sid] = session;
            }
            await writeSidecar(ctx, avatar, payload.sessions);
            migrated += Object.keys(sessionMap).length;
        } catch (err) {
            console.warn(`[CEA editor migration] sidecar write failed for ${avatar}:`, err?.message || err);
            skipped += Object.keys(sessionMap).length;
            failedKeys.add(scope);
        }
    }

    if (failedKeys.size === 0) {
        delete settingsRoot[V2_BUCKET_KEY];
        settingsRoot[CEA_MIGRATION_FLAG_KEY] = true;
    } else {
        for (const scope of Object.keys(v2)) {
            if (!failedKeys.has(scope)) {
                delete v2[scope];
            }
        }
        if (Object.keys(v2).length === 0) {
            delete settingsRoot[V2_BUCKET_KEY];
            settingsRoot[CEA_MIGRATION_FLAG_KEY] = true;
        }
    }

    if (typeof persistSettings === 'function') persistSettings();
    return { migrated, skipped };
}
