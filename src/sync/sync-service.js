import storage from 'node-persist';

import { getStorageEngine } from '../storage/index.js';
import { getAllUserHandles, getUserDirectories, toKey } from '../users.js';
import { LanBackend } from './backends/lan/client.js';
import { S3Backend } from './backends/s3/backend.js';
import { IncomingRefBackend } from './backends/lan/incoming.js';
import { selfCallback } from './backends/lan/callback.js';
import { syncError } from './errors.js';
import { createScheduler } from './pipeline/scheduler.js';
import { resolveDeviceLabel } from './state.js';

/** @typedef {import('./pipeline/sync-hooks.js').SyncOwner} SyncOwner */

/**
 * Users of this server as the sync router and scheduler see them.
 */
export const defaultUserStore = {
    listHandles: () => getAllUserHandles(),
    getDirectories: handle => getUserDirectories(handle),
    getProfile: handle => storage.getItem(toKey(handle)),
    getEngine: () => getStorageEngine(),
    selfCallback: () => selfCallback(globalThis.COMMAND_LINE_ARGS),
};

/**
 * @param {{ profile: { handle: string, name?: string }, directories: Record<string, string> }} user
 * @param {typeof defaultUserStore} [userStore]
 * @returns {SyncOwner}
 */
export function ownerFromUser(user, userStore = defaultUserStore) {
    return {
        handle: user.profile.handle,
        displayName: user.profile.name || user.profile.handle,
        userRoot: user.directories.root,
        directories: user.directories,
        engine: userStore.getEngine(),
        selfCallback: () => userStore.selfCallback(),
        getCurrentProfile: async () => (await userStore.getProfile(user.profile.handle)) ?? null,
    };
}

/**
 * @returns {Promise<SyncOwner[]>}
 */
async function listOwners() {
    const owners = [];
    for (const handle of await defaultUserStore.listHandles()) {
        const profile = await defaultUserStore.getProfile(handle);
        if (!profile?.enabled) continue;
        owners.push(ownerFromUser({ profile, directories: defaultUserStore.getDirectories(handle) }));
    }
    return owners;
}

/**
 * @param {SyncOwner} owner
 * @param {string} id
 * @param {{ kind: string, lan?: object, s3?: object }} entry
 * @param {object} registry
 * @param {{lease?: import('./pipeline/scheduler.js').OperationLease}} [options]
 */
export function makeBackend(owner, id, entry, registry, { lease } = {}) {
    if (entry.kind === 's3') return new S3Backend({ id, owner, entry, lease });
    if (entry.kind === 'lan') {
        return new LanBackend({ id, owner, userRoot: owner.userRoot, entry, deviceLabel: resolveDeviceLabel(registry, owner), callback: owner.selfCallback?.() ?? null });
    }
    throw syncError('BACKEND_UNAVAILABLE', 'This sync backend is not available');
}

export const syncService = createScheduler({
    makeBackend,
    makeIncomingBackend: (owner, id, entry) => entry.kind === 'lan' ? new IncomingRefBackend({ id, userRoot: owner.userRoot }) : null,
    listOwners,
    getEngine: getStorageEngine,
});

export function startSyncService() {
    return syncService.start();
}
