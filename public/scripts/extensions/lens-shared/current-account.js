// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which account this page is signed in to. Browser only: imports Luker's user module.

import { currentUser } from '../../user.js';
import { accountScopedStorage } from './account-storage.js';

/**
 * The signed-in handle, or null when it is unknown. Without accounts Luker
 * never loads a user and hides the logout button; everyone is the default user.
 */
export function currentAccountHandle() {
    if (currentUser?.handle) return String(currentUser.handle);
    return globalThis.document?.getElementById('logout_button')?.style.display === 'none' ? 'default-user' : null;
}

/** This browser's localStorage, limited to the signed-in account. */
export const accountLocalStorage = () => accountScopedStorage(globalThis.localStorage, currentAccountHandle);
