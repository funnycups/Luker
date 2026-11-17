// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which account this page is signed in to. Consumes Luker's context API
// (without importing script.js or user.js directly).

import { accountScopedStorage } from './account-storage.js';

function resolveContext(ctxOrGetter) {
    if (typeof ctxOrGetter === 'function') return ctxOrGetter();
    if (ctxOrGetter && typeof ctxOrGetter === 'object') return ctxOrGetter;
    return globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
}

/**
 * The signed-in handle, or null when it is unknown. Without accounts Luker
 * never loads a user; once settings are ready, everyone is the default user.
 * @param {Function | object | null} [ctxOrGetter]
 * @returns {string | null}
 */
export function currentAccountHandle(ctxOrGetter = null) {
    const ctx = resolveContext(ctxOrGetter);
    if (ctx?.currentUser?.handle) return String(ctx.currentUser.handle);
    return ctx?.settingsReady && !ctx?.accountsEnabled ? 'default-user' : null;
}

/**
 * This browser's localStorage, limited to the signed-in account.
 * @param {Function | object | null} [ctxOrGetter]
 * @param {Storage | null | undefined} [storage]
 */
export const accountLocalStorage = (ctxOrGetter = null, storage = globalThis.localStorage) =>
    accountScopedStorage(storage, () => currentAccountHandle(ctxOrGetter));
