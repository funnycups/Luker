import { loadResourceBootstrap, readResourceJson } from './resource-read.js';

/**
 * Reads one account-scoped state resource through the browser HTTP cache.
 * The returned value is the legacy state envelope for the requested target.
 */
export async function readStateEnvelope(path, params = {}, { signal } = {}) {
    const { account } = await loadResourceBootstrap({ signal });
    const query = new URLSearchParams({ account });
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        query.set(key, String(value));
    }
    const { value } = await readResourceJson(`${path}?${query}`, { signal });
    return value;
}
