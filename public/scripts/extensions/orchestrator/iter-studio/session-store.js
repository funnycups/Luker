// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator — plugin-owned session store, sidecar-backed.
 *
 * Per-character iter-studio sessions live in a character sidecar file
 * (`<char>.state.orchestrator_iter_studio_history.json` on disk) via the
 * SillyTavern `getCharacterState` / `setCharacterState` API. Global-scope
 * sessions stay in `extension_settings.orchestrator.iter_studio_global_sessions[mode]`
 * — matching pre-V2 orch behaviour where only character-bound history ever
 * touched the character card and global history rode along with settings.
 *
 * `mode` is preserved as a per-session field; the sidecar stores ALL modes
 * for a given character in one file (the user only ever opens one mode at
 * a time, so cross-mode contention is impossible). `list()` filters by the
 * factory's `mode` so each popup sees only its own bucket.
 *
 * Pure ESM. No DOM, no jQuery, no globals.
 */

import { migrateToV3, MigrationFailedError } from '/scripts/iteration-library/storage/migrate-v3.js';
import { notifyMigrationFailed } from '/scripts/iteration-library/storage/migration-toast.js';

export const ORCH_SIDECAR_NAMESPACE = 'orchestrator_iter_studio_history';
export const ORCH_GLOBAL_BUCKET_KEY = 'iter_studio_global_sessions';

const LEGACY_GLOBAL_HISTORY_KEY = 'global_iteration_history';
const SIDECAR_SCHEMA_VERSION = 1;

export function makeMessageId() {
    return `orch_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMessageShape(m, fallbackAt = Date.now()) {
    if (!m || typeof m !== 'object') return m;
    const out = {
        id: typeof m.id === 'string' && m.id ? m.id : makeMessageId(),
        role: String(m.role || 'user'),
        content: String(m.content ?? ''),
        at: typeof m.at === 'number' ? m.at : Number(fallbackAt) || Date.now(),
    };
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) out.toolCalls = m.toolCalls;
    if (Array.isArray(m.toolResults) && m.toolResults.length > 0) out.toolResults = m.toolResults;
    if (Array.isArray(m.edits) && m.edits.length > 0) out.edits = m.edits;
    if (typeof m.appliedAt === 'number') out.appliedAt = m.appliedAt;
    if (m.appliedTarget) out.appliedTarget = String(m.appliedTarget);
    if (typeof m.rolledBackAt === 'number') out.rolledBackAt = m.rolledBackAt;
    if (m.auto) out.auto = true;
    return out;
}

function extractAvatarFromScope(scope) {
    if (typeof scope !== 'string') return null;
    if (!scope.startsWith('character_')) return null;
    const avatar = scope.slice('character_'.length).trim();
    return avatar || null;
}

async function readSidecar(ctx, avatar) {
    const result = await ctx.getCharacterState(avatar, ORCH_SIDECAR_NAMESPACE);
    if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[orchestrator iter-studio] sidecar read failed for ${avatar} (reason=${result.reason}, hint=${result.hint})`);
        return { version: SIDECAR_SCHEMA_VERSION, sessions: {} };
    }
    const raw = result.state;
    if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
        return raw;
    }
    return { version: SIDECAR_SCHEMA_VERSION, sessions: {} };
}

function buildNextSidecar(current, mutate) {
    const base = (current && typeof current === 'object' && current.sessions && typeof current.sessions === 'object')
        ? { version: SIDECAR_SCHEMA_VERSION, sessions: { ...current.sessions } }
        : { version: SIDECAR_SCHEMA_VERSION, sessions: {} };
    mutate(base.sessions);
    return base;
}

function getGlobalBucket(settingsRoot, mode) {
    if (!settingsRoot[ORCH_GLOBAL_BUCKET_KEY] || typeof settingsRoot[ORCH_GLOBAL_BUCKET_KEY] !== 'object') {
        settingsRoot[ORCH_GLOBAL_BUCKET_KEY] = {};
    }
    const root = settingsRoot[ORCH_GLOBAL_BUCKET_KEY];
    if (!root[mode] || typeof root[mode] !== 'object') {
        root[mode] = {};
    }
    return root[mode];
}

export function createOrchestratorIterationSessionStore({
    mode,
    getOrchestratorSettingsRoot,
    persistSettings,
    persistSettingsImmediate,
    computeScope,
    ctx,
}) {
    if (!mode) throw new TypeError('createOrchestratorIterationSessionStore: mode is required');
    if (typeof getOrchestratorSettingsRoot !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: getOrchestratorSettingsRoot must be a function');
    }
    if (typeof persistSettings !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: persistSettings must be a function');
    }
    if (typeof computeScope !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: computeScope must be a function');
    }
    if (!ctx || typeof ctx.getCharacterState !== 'function' || typeof ctx.updateCharacterState !== 'function') {
        throw new TypeError('createOrchestratorIterationSessionStore: ctx with getCharacterState + updateCharacterState is required');
    }

    function metaOf(s) {
        return { id: String(s.id), title: String(s.title || s.id), updatedAt: Number(s.updatedAt || 0) };
    }

    async function list() {
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        if (avatar) {
            const payload = await readSidecar(ctx, avatar);
            return Object.values(payload.sessions)
                .filter(s => s && typeof s === 'object' && s.id && (s.mode === mode || !s.mode))
                .map(metaOf)
                .sort((a, b) => b.updatedAt - a.updatedAt);
        }
        const bucket = getGlobalBucket(getOrchestratorSettingsRoot() || {}, mode);
        return Object.values(bucket)
            .filter(s => s && typeof s === 'object' && s.id)
            .map(metaOf)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function load(id) {
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        if (avatar) {
            const payload = await readSidecar(ctx, avatar);
            const stored = payload.sessions[String(id)];
            if (!stored || (stored.mode && stored.mode !== mode)) return null;
            const cloned = structuredClone(stored);
            if (cloned.version === 3) return cloned;
            let migrated;
            try {
                migrated = migrateToV3(cloned, {
                    defaultTargetForKind: (kind) => kind === 'lorebook-write'
                        ? null
                        : { type: 'profile', mode: cloned.mode || mode },
                });
            } catch (err) {
                if (err instanceof MigrationFailedError) {
                    notifyMigrationFailed(ctx, stored?.title || id);
                    // eslint-disable-next-line no-console
                    console.error(`[orch-session-store] migration failed for ${id}:`, err.message);
                    return null;
                }
                throw err;
            }
            const writeResult = await ctx.updateCharacterState(avatar, ORCH_SIDECAR_NAMESPACE, (current) =>
                buildNextSidecar(current, (sessions) => {
                    sessions[String(id)] = structuredClone(migrated);
                }),
            );
            if (!writeResult.ok) {
                // eslint-disable-next-line no-console
                console.warn(`[orchestrator iter-studio] migration save failed (reason=${writeResult.reason}, hint=${writeResult.hint})`);
            }
            return migrated;
        }
        const bucket = getGlobalBucket(getOrchestratorSettingsRoot() || {}, mode);
        const stored = bucket[String(id)];
        if (!stored) return null;
        const cloned = structuredClone(stored);
        if (cloned.version === 3) return cloned;
        try {
            const migrated = migrateToV3(cloned, {
                defaultTargetForKind: (kind) => kind === 'lorebook-write'
                    ? null
                    : { type: 'profile', mode: cloned.mode || mode },
            });
            bucket[String(id)] = structuredClone(migrated);
            persistSettings();
            return migrated;
        } catch (err) {
            if (err instanceof MigrationFailedError) {
                notifyMigrationFailed(ctx, stored?.title || id);
                // eslint-disable-next-line no-console
                console.error(`[orch-session-store] migration failed for ${id}:`, err.message);
                return null;
            }
            throw err;
        }
    }

    async function save(session) {
        if (!session?.id) return;
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        const sessionClone = structuredClone(session);
        sessionClone.version = 3;
        if (avatar) {
            const result = await ctx.updateCharacterState(avatar, ORCH_SIDECAR_NAMESPACE, (current) =>
                buildNextSidecar(current, (sessions) => {
                    sessions[String(session.id)] = sessionClone;
                }),
            );
            if (!result.ok) {
                throw new Error(`[orchestrator iter-studio] save failed (${result.reason}): ${result.hint}`);
            }
            return;
        }
        const bucket = getGlobalBucket(getOrchestratorSettingsRoot() || {}, mode);
        bucket[String(session.id)] = sessionClone;
        persistSettings();
    }

    async function saveFlush(session) {
        if (!session?.id) return;
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        const sessionClone = structuredClone(session);
        sessionClone.version = 3;
        if (avatar) {
            const result = await ctx.updateCharacterState(avatar, ORCH_SIDECAR_NAMESPACE, (current) =>
                buildNextSidecar(current, (sessions) => {
                    sessions[String(session.id)] = sessionClone;
                }),
            );
            if (!result.ok) {
                throw new Error(`[orchestrator iter-studio] saveFlush failed (${result.reason}): ${result.hint}`);
            }
            return;
        }
        const bucket = getGlobalBucket(getOrchestratorSettingsRoot() || {}, mode);
        bucket[String(session.id)] = sessionClone;
        if (typeof persistSettingsImmediate === 'function') {
            await persistSettingsImmediate();
        } else {
            persistSettings();
        }
    }

    async function deleteFn(id) {
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        if (avatar) {
            const result = await ctx.updateCharacterState(avatar, ORCH_SIDECAR_NAMESPACE, (current) =>
                buildNextSidecar(current, (sessions) => {
                    delete sessions[String(id)];
                }),
            );
            if (!result.ok) {
                throw new Error(`[orchestrator iter-studio] delete failed (${result.reason}): ${result.hint}`);
            }
            return;
        }
        const bucket = getGlobalBucket(getOrchestratorSettingsRoot() || {}, mode);
        delete bucket[String(id)];
        persistSettings();
    }

    async function clearObsolete() {
        const root = getOrchestratorSettingsRoot();
        if (root && Object.hasOwn(root, LEGACY_GLOBAL_HISTORY_KEY)) {
            delete root[LEGACY_GLOBAL_HISTORY_KEY];
            persistSettings();
        }
    }

    return {
        list,
        load,
        save,
        saveFlush,
        delete: deleteFn,
        clearObsolete,
    };
}
