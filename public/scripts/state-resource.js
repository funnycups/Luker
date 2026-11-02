import { invalidateResourceReads, invalidateResourceReadsByPrefix, loadResourceBootstrap, readResourceJson } from './resource-read.js';

export function normalizeStateNamespace(namespace) {
    return String(namespace || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 96);
}

function stateResourceUrl(path, params, account) {
    const { namespace, ...target } = params;
    const query = new URLSearchParams({ account });
    for (const key of Object.keys(target).sort()) {
        const value = target[key];
        if (value === undefined || value === null || value === '') {
            continue;
        }
        query.set(key, String(value));
    }
    if (namespace !== undefined) {
        query.set('namespace', normalizeStateNamespace(namespace));
    }
    return `${path}?${query}`;
}

/**
 * Reads one account-scoped state resource through the browser HTTP cache.
 * The returned value is the legacy state envelope for the requested target.
 */
export async function readStateEnvelope(path, params = {}, { signal } = {}) {
    const { account } = await loadResourceBootstrap({ signal });
    const { value } = await readResourceJson(stateResourceUrl(path, params, account), { signal });
    return value;
}

/** Invalidates matching pending reads; omitted namespaces select the whole target. */
export async function invalidateStateResources(path, targetParams, namespaces) {
    if (namespaces?.length === 0) {
        return;
    }
    const { account } = await loadResourceBootstrap();
    if (namespaces === undefined) {
        invalidateResourceReadsByPrefix(`${stateResourceUrl(path, targetParams, account)}&namespace=`);
    } else {
        invalidateResourceReads(namespaces.map(namespace => stateResourceUrl(path, { ...targetParams, namespace }, account)));
    }
}
