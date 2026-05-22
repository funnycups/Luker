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
