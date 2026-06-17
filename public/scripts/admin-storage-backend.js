/**
 * Pure helpers for the admin Storage Backend tab. Kept module-scoped (no
 * jQuery / DOM globals) so they can be unit-tested without a real browser
 * environment. user.js wires them up to the actual <input> elements.
 */

/**
 * Pull URL / poolSize from raw string values (as read from <input>) and
 * build the request-body shape the migrate endpoint expects.
 *
 * Returns `{}` for fs / sqlite (no creds applicable) and for mysql/postgres
 * when the operator left every input empty — the endpoint will then fall
 * back to config.yaml.
 *
 * @param {string} targetMode  One of 'fs' | 'sqlite' | 'mysql' | 'postgres'.
 * @param {object} rawInputs   Values read straight from the DOM (strings, may be empty).
 * @param {string} [rawInputs.mysqlUrl]
 * @param {string} [rawInputs.mysqlPoolSize]
 * @param {string} [rawInputs.postgresUrl]
 * @param {string} [rawInputs.postgresPoolSize]
 * @returns {{ mysql?: { url?: string, poolSize?: number }, postgres?: { url?: string, poolSize?: number } }}
 */
export function buildStorageBackendCreds(targetMode, rawInputs = {}) {
    if (targetMode === 'mysql') {
        const fields = collectFields(rawInputs.mysqlUrl, rawInputs.mysqlPoolSize);
        return fields ? { mysql: fields } : {};
    }
    if (targetMode === 'postgres') {
        const fields = collectFields(rawInputs.postgresUrl, rawInputs.postgresPoolSize);
        return fields ? { postgres: fields } : {};
    }
    return {};
}

function collectFields(rawUrl, rawPoolSize) {
    const url = String(rawUrl ?? '').trim();
    const poolSizeStr = String(rawPoolSize ?? '').trim();
    const fields = {};
    if (url) fields.url = url;
    if (poolSizeStr) {
        const n = Number(poolSizeStr);
        if (Number.isFinite(n) && n > 0) fields.poolSize = n;
    }
    return Object.keys(fields).length > 0 ? fields : null;
}
