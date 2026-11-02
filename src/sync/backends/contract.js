/**
 * The interface every sync backend implements. The pipeline talks only to
 * this contract.
 *
 * @typedef {object} RemoteBackend
 * @property {string} id
 * @property {'lan'|'s3'} kind
 * @property {() => Promise<{oid: string, etag: string} | null>} readHead
 * @property {(want: string[] , have: string[]) => Promise<void>} fetchInto   // objects/packs into the local shadow repo
 * @property {(localHead: string, remoteHead: string|null) => Promise<void>} pushObjects
 * @property {(expectedEtag: string|null, oid: string) => Promise<{ok: true} | {ok: false, reason: 'conflict'}>} casHead
 * @property {() => Promise<void>} [notifyPeer]   // LAN only
 */

/** Kinds the registry may persist. */
export const REMOTE_BACKEND_KINDS = Object.freeze(['lan', 's3']);

const OID_PATTERN = /^[a-f0-9]{40}$/;
const REQUIRED_METHODS = ['readHead', 'fetchInto', 'pushObjects', 'casHead'];

/**
 * @param {unknown} backend
 * @returns {RemoteBackend}
 */
export function assertRemoteBackend(backend) {
    if (!backend || typeof backend !== 'object') throw new TypeError('Invalid RemoteBackend: not an object');
    const problems = [];
    if (typeof backend.id !== 'string' || !backend.id) problems.push('id must be a non-empty string');
    if (typeof backend.kind !== 'string' || !backend.kind) problems.push('kind must be a non-empty string');
    for (const method of REQUIRED_METHODS) {
        if (typeof backend[method] !== 'function') problems.push(`${method} must be a function`);
    }
    if (backend.notifyPeer !== undefined && typeof backend.notifyPeer !== 'function') {
        problems.push('notifyPeer must be a function when present');
    }
    if (problems.length > 0) throw new TypeError(`Invalid RemoteBackend: ${problems.join('; ')}`);
    return /** @type {RemoteBackend} */ (backend);
}

/**
 * @param {unknown} head
 * @returns {{ oid: string, etag: string } | null}
 */
export function assertRemoteHead(head) {
    if (head === null) return null;
    if (!head || typeof head !== 'object' || !OID_PATTERN.test(String(head.oid)) || typeof head.etag !== 'string' || !head.etag) {
        throw new TypeError(`RemoteBackend.readHead returned an invalid head: ${JSON.stringify(head)}`);
    }
    return { oid: head.oid, etag: head.etag };
}

/**
 * @param {unknown} result
 * @returns {{ ok: true } | { ok: false, reason: 'conflict' }}
 */
export function assertCasResult(result) {
    if (result && result.ok === true) return { ok: true };
    if (result && result.ok === false && result.reason === 'conflict') return { ok: false, reason: 'conflict' };
    throw new TypeError(`RemoteBackend.casHead returned an invalid result: ${JSON.stringify(result)}`);
}
