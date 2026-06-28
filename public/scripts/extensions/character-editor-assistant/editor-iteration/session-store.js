// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * CEA unified editor — per-character sidecar session store.
 *
 * Sessions persist via `getCharacterState` / `setCharacterState` under
 * the `character_editor_assistant_iter_sessions` namespace. This restores
 * the pre-V2 per-character storage discipline (the V2 collapse put every
 * character's sessions into `extension_settings.character_editor_assistant`,
 * bloating settings.json with iteration history that has no global scope).
 *
 * Each character's sidecar holds one `{ version: 1, sessions: { [id]: session } }`
 * payload. The unified editor is per-character — there is no global scope —
 * so the factory takes `avatar` and binds to one sidecar for its lifetime.
 */

import { migrateToV3, MigrationFailedError } from '/scripts/iteration-library/storage/migrate-v3.js';
import { notifyMigrationFailed } from '/scripts/iteration-library/storage/migration-toast.js';

export const CEA_SIDECAR_NAMESPACE = 'character_editor_assistant_iter_sessions';

const SIDECAR_SCHEMA_VERSION = 1;

export function makeMessageId() {
    return `cea_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

async function readSidecar(ctx, avatar) {
    const result = await ctx.getCharacterState(avatar, CEA_SIDECAR_NAMESPACE);
    if (!result.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[character-editor-assistant] sidecar read failed for ${avatar} (reason=${result.reason}, hint=${result.hint})`);
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

export function createUnifiedCeaEditorSessionStore(opts = {}) {
    const avatar = opts && opts.avatar;
    if (!avatar) {
        throw new TypeError('createUnifiedCeaEditorSessionStore: avatar is required');
    }
    const ctx = opts.context;
    if (!ctx || typeof ctx.getCharacterState !== 'function' || typeof ctx.updateCharacterState !== 'function') {
        throw new TypeError('createUnifiedCeaEditorSessionStore: opts.context with getCharacterState + updateCharacterState is required');
    }

    function metaOf(s) {
        return { id: String(s.id), title: String(s.title || s.id), updatedAt: Number(s.updatedAt || 0) };
    }

    async function list() {
        const payload = await readSidecar(ctx, avatar);
        return Object.values(payload.sessions)
            .filter(s => s && typeof s === 'object' && s.id)
            .map(metaOf)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async function load(id) {
        const payload = await readSidecar(ctx, avatar);
        const stored = payload.sessions[String(id)];
        if (!stored) return null;
        const cloned = structuredClone(stored);
        if (cloned.version === 3) return cloned;
        let migrated;
        try {
            migrated = migrateToV3(cloned, {
                defaultTargetForKind: (kind) => kind === 'cea-lorebook-edits'
                    ? null
                    : { type: 'character' },
            });
        } catch (err) {
            if (err instanceof MigrationFailedError) {
                notifyMigrationFailed(ctx, stored?.title || id);
                // eslint-disable-next-line no-console
                console.error(`[cea-session-store] migration failed for ${id}:`, err.message);
                return null;
            }
            throw err;
        }
        const writeResult = await ctx.updateCharacterState(avatar, CEA_SIDECAR_NAMESPACE, (current) =>
            buildNextSidecar(current, (sessions) => {
                sessions[String(id)] = structuredClone(migrated);
            }),
        );
        if (!writeResult.ok) {
            // eslint-disable-next-line no-console
            console.warn(`[character-editor-assistant] migration save failed (reason=${writeResult.reason}, hint=${writeResult.hint})`);
        }
        return migrated;
    }

    async function save(session) {
        if (!session?.id) return;
        const sessionClone = structuredClone(session);
        sessionClone.version = 3;
        const result = await ctx.updateCharacterState(avatar, CEA_SIDECAR_NAMESPACE, (current) =>
            buildNextSidecar(current, (sessions) => {
                sessions[String(session.id)] = sessionClone;
            }),
        );
        if (!result.ok) {
            throw new Error(`[character-editor-assistant] save failed (${result.reason}): ${result.hint}`);
        }
    }

    async function deleteFn(id) {
        const result = await ctx.updateCharacterState(avatar, CEA_SIDECAR_NAMESPACE, (current) =>
            buildNextSidecar(current, (sessions) => {
                delete sessions[String(id)];
            }),
        );
        if (!result.ok) {
            throw new Error(`[character-editor-assistant] delete failed (${result.reason}): ${result.hint}`);
        }
    }

    return {
        list,
        load,
        save,
        delete: deleteFn,
        remove: deleteFn,
    };
}
