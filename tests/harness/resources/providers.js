import { processProvider } from './process-owner.js';

/** @typedef {import('./run.js').DirectoryAcquisition} DirectoryAcquisition */
/** @typedef {import('./run.js').DirectoryRelease} DirectoryRelease */

const providers = new Map();

/** Registration grants a concrete provider capability, not a per-call allocation callback. */
export function registerProvider(provider) {
    if (!provider || typeof provider.kind !== 'string' || !provider.kind || typeof provider.allocate !== 'function' || typeof provider.dispose !== 'function') {
        throw new TypeError('A registered provider requires kind, allocate and dispose');
    }
    if (provider.recover !== undefined && typeof provider.recover !== 'function') throw new TypeError('A registered recovery capability must be a function');
    if (providers.has(provider.kind)) throw new Error(`Resource provider is already registered: ${provider.kind}`);
    providers.set(provider.kind, Object.freeze({ ...provider }));
}

export function requireProvider({ kind, allocate, dispose }) {
    const registered = providers.get(kind);
    if (!registered || registered.allocate !== allocate || registered.dispose !== dispose) {
        throw new Error(`Allocation must use the registered resource provider: ${kind}`);
    }
    return registered;
}

/** Recovery uses only a capability registered by the current command. */
export function requireRecoveryProvider(kind) {
    const provider = providers.get(kind);
    if (!provider || typeof provider.recover !== 'function') throw new Error(`Unsupported recovery provider: ${kind}`);
    return provider;
}

export const directoryProvider = Object.freeze({
    kind: 'directory',
    /** @param {DirectoryAcquisition} handle */
    async allocate(handle) {
        const identity = handle.createDirectory();
        await handle.publish(identity);
        return Object.freeze({ path: handle.directoryPath, resourceId: handle.resourceId, ownership: 'owned', dev: identity.dev, ino: identity.ino });
    },
    /** @param {DirectoryRelease} record */
    async dispose(record) {
        record.removeDirectory();
    },
});

registerProvider(directoryProvider);
registerProvider(processProvider);
