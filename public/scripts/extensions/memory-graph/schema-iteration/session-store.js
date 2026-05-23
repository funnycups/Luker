// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Memory Graph Schema — plugin-owned session store.
 *
 * Thin wrapper around Stage 1's createExtensionSettingsSessionStorage scoped
 * to the global MG bucket at
 *
 *     extension_settings.luker_rpg_memory[SESSIONS_BUCKET_KEY]
 *
 * (The module key on extensionSettings is `memory_graph` in the live UI, but
 * we depend on the caller to hand us the right root via getMgSettingsRoot —
 * the wrapper stays agnostic to where the root actually lives.)
 *
 * Preserves the legacy bucket path so existing sessions survive the popup
 * migration with no schema change. `clearObsolete` is a no-op (MG has no
 * pre-v2 legacy keys to wipe under the new popup; the legacy key cleanup that
 * the shell-driven adapter used to do for `schemaIterationHistory` is no
 * longer the popup's job).
 *
 * Pure ESM. No DOM, no jQuery, no globals.
 */

import { createExtensionSettingsSessionStorage } from '../../../iteration-library/storage.js';
import { SESSIONS_BUCKET_KEY } from './tools.js';

/**
 * Generate a stable per-message id. The studio renders messages keyed by
 * id (so React-style diff updates work), and persisted messages keep
 * their id across reloads. The shape — `mg_msg_<timestamp36>_<rand>` —
 * mirrors the session id format and is recognized as MG-origin by
 * downstream consumers (mirrors the CPA `cpa_msg_*` convention).
 */
export function makeMessageId() {
    return `mg_msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize a message read from disk into the shape rendered today.
 * Legacy sessions persisted only `{role, content}`; the upgraded schema
 * adds `id`, `at`, optional `toolCalls`, `edits`, `appliedAt`,
 * `appliedTarget`, `rolledBackAt`, and an `auto` flag for synthetic
 * auto-continue user messages.
 *
 * Tolerance: missing `id` regenerates one, missing `at` falls back to
 * the session's updatedAt, missing arrays stay undefined (renderer
 * uses Array.isArray as the visibility gate).
 */
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

/**
 * @param {object} args
 * @param {() => object} args.getMgSettingsRoot
 *        Returns the mutable Memory Graph extension settings root. The
 *        wrapper lazy-creates `[SESSIONS_BUCKET_KEY]` on this root on first
 *        access; the caller does not need to pre-seed it.
 * @param {() => void} args.persistSettings
 *        Called after every mutating op (save / delete) so the host can
 *        flush extension_settings (e.g. via saveSettingsDebounced).
 * @returns {{
 *   list: () => Promise<Array<{ id: string, title: string, updatedAt: number }>>,
 *   load: (id: string) => Promise<object|null>,
 *   save: (session: object) => Promise<void>,
 *   delete: (id: string) => Promise<void>,
 *   clearObsolete: () => Promise<void>,
 * }}
 */
export function createMgSchemaSessionStore({ getMgSettingsRoot, persistSettings }) {
    if (typeof getMgSettingsRoot !== 'function') {
        throw new TypeError('createMgSchemaSessionStore: getMgSettingsRoot must be a function');
    }
    if (typeof persistSettings !== 'function') {
        throw new TypeError('createMgSchemaSessionStore: persistSettings must be a function');
    }

    const scope = 'global';

    const inner = createExtensionSettingsSessionStorage({
        getBucket: () => {
            const root = getMgSettingsRoot() || {};
            if (!root[SESSIONS_BUCKET_KEY] || typeof root[SESSIONS_BUCKET_KEY] !== 'object') {
                root[SESSIONS_BUCKET_KEY] = {};
            }
            return root[SESSIONS_BUCKET_KEY];
        },
        persistSettings,
    });

    return {
        list: () => inner.listSessions(scope),
        load: (id) => inner.loadSession(scope, id),
        save: (session) => inner.saveSession(scope, session),
        delete: (id) => inner.deleteSession(scope, id),
        clearObsolete: async () => { /* no-op for MG; nothing legacy to wipe */ },
    };
}
