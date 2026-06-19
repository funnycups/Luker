// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph Schema — plugin-owned session store, scope-aware.
 *
 * Restores the per-character vs global session dimension MG had at the
 * schema layer all along (the `getSchemaScopeInfo` view) but that V2
 * collapsed into a single global bucket. Now session storage routes the
 * same way the schema itself does:
 *   - character scope → sidecar under MG_SIDECAR_NAMESPACE on the avatar
 *   - global scope    → extension_settings.memory_graph.schema_iter_global_sessions
 */

export const MG_SIDECAR_NAMESPACE = 'memory_graph_schema_iter_history';
export const MG_GLOBAL_BUCKET_KEY = 'schema_iter_global_sessions';

const SIDECAR_SCHEMA_VERSION = 1;

export function makeMessageId() {
    return `mg_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
    try {
        const raw = await ctx.getCharacterState(avatar, MG_SIDECAR_NAMESPACE);
        if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
            return raw;
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[memory-graph schema-iteration] sidecar read failed for ${avatar}, treating as empty:`, err?.message || err);
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

function getGlobalBucket(settingsRoot) {
    if (!settingsRoot[MG_GLOBAL_BUCKET_KEY] || typeof settingsRoot[MG_GLOBAL_BUCKET_KEY] !== 'object') {
        settingsRoot[MG_GLOBAL_BUCKET_KEY] = {};
    }
    return settingsRoot[MG_GLOBAL_BUCKET_KEY];
}

export function createMgSchemaSessionStore({ getMgSettingsRoot, persistSettings, computeScope, ctx }) {
    if (typeof getMgSettingsRoot !== 'function') {
        throw new TypeError('createMgSchemaSessionStore: getMgSettingsRoot must be a function');
    }
    if (typeof persistSettings !== 'function') {
        throw new TypeError('createMgSchemaSessionStore: persistSettings must be a function');
    }
    if (typeof computeScope !== 'function') {
        throw new TypeError('createMgSchemaSessionStore: computeScope must be a function');
    }
    if (!ctx || typeof ctx.getCharacterState !== 'function' || typeof ctx.updateCharacterState !== 'function') {
        throw new TypeError('createMgSchemaSessionStore: ctx with getCharacterState + updateCharacterState is required');
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
                .filter(s => s && typeof s === 'object' && s.id)
                .map(metaOf)
                .sort((a, b) => b.updatedAt - a.updatedAt);
        }
        const bucket = getGlobalBucket(getMgSettingsRoot() || {});
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
            return stored ? structuredClone(stored) : null;
        }
        const bucket = getGlobalBucket(getMgSettingsRoot() || {});
        const stored = bucket[String(id)];
        return stored ? structuredClone(stored) : null;
    }

    async function save(session) {
        if (!session?.id) return;
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        if (avatar) {
            await ctx.updateCharacterState(avatar, MG_SIDECAR_NAMESPACE, (current) =>
                buildNextSidecar(current, (sessions) => {
                    sessions[String(session.id)] = structuredClone(session);
                }),
            );
            return;
        }
        const bucket = getGlobalBucket(getMgSettingsRoot() || {});
        bucket[String(session.id)] = structuredClone(session);
        persistSettings();
    }

    async function deleteFn(id) {
        const scope = computeScope() || 'global';
        const avatar = extractAvatarFromScope(scope);
        if (avatar) {
            await ctx.updateCharacterState(avatar, MG_SIDECAR_NAMESPACE, (current) =>
                buildNextSidecar(current, (sessions) => {
                    delete sessions[String(id)];
                }),
            );
            return;
        }
        const bucket = getGlobalBucket(getMgSettingsRoot() || {});
        delete bucket[String(id)];
        persistSettings();
    }

    return {
        list,
        load,
        save,
        delete: deleteFn,
        clearObsolete: async () => { /* no-op for MG */ },
    };
}
