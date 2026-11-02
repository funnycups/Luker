import git from 'isomorphic-git';

import { syncError } from '../../errors.js';
import { fetchMissingObjects, listObjectsChildrenFirst, readObjectForWire } from '../../objects.js';
import { atomicFs } from '../../pipeline/atomic-fs.js';
import { PEER_SECRET_HEADER } from '../../session.js';
import { getShadowPaths } from '../../shadow.js';
import { assertSafeBackendId, setLanPeerDeviceLabel } from '../../state.js';
import { LAN_PROTOCOL } from './callback.js';
import { incomingRefFor } from './incoming.js';
import { guardedLanFetch } from '../../net-guard.js';

/** Etag of a peer head read while the peer holds no incoming ref for us. */
const NO_INCOMING = 'none';
const ZERO_OID = '0'.repeat(40);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Short label for a failed outbound fetch. `fetch` wraps the socket error
 * in `error.cause`; for a hostname resolving to several addresses it is
 * an AggregateError whose `.errors` carry the per-address codes. The code
 * tells a wrong address or port (`ECONNREFUSED`) apart from a firewall or
 * route problem (`ETIMEDOUT`, `ENETUNREACH`), which `fetch failed` does
 * not.
 *
 * @param {unknown} error Error thrown by `fetch`
 * @returns {string}
 */
export function describeFetchFailure(error) {
    const cause = /** @type {{ code?: string, message?: string, errors?: Array<{ code?: string }> }} */ (/** @type {any} */ (error)?.cause);
    const code = cause?.code || /** @type {any} */ (error)?.code
        || (Array.isArray(cause?.errors) ? cause.errors.map(entry => entry?.code).find(Boolean) : '');
    if (code) return String(code);
    if (cause?.message) return String(cause.message);
    return String(/** @type {any} */ (error)?.message || error || 'fetch failed');
}

/**
 * Sync failure code for a non-OK answer of the other device.
 *
 * @param {number} status
 * @param {any} body
 * @returns {string}
 */
export function peerErrorCode(status, body) {
    if (status === 401) return 'PEER_AUTH_FAILED';
    if (status === 404 && body?.code === 'PEER_FORGOTTEN') return 'PEER_FORGOTTEN';
    if (status === 412) return body?.code || 'HANDLE_MISMATCH';
    if (status === 426) return 'PEER_PROTOCOL_OUTDATED';
    return typeof body?.code === 'string' && body.code ? body.code : 'PEER_ERROR';
}

/**
 * Body of a successful sync response. A device that answers with
 * anything but JSON does not speak this protocol.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readJson(response) {
    try {
        return await response.json();
    } catch {
        throw syncError('PEER_PROTOCOL_OUTDATED', 'The other device did not answer as a Luker sync peer');
    }
}

function assertProtocol(body) {
    if (!(Number(body?.protocol) >= LAN_PROTOCOL)) throw syncError('PEER_PROTOCOL_OUTDATED', 'The Luker version of the other device is too old');
}

/**
 * Every object reachable from `oids` that is present in `gitdir`. Null
 * oids and objects missing locally are skipped.
 *
 * @param {string} gitdir
 * @param {Array<string | null | undefined>} oids
 * @returns {Promise<Set<string>>}
 */
async function collectReachable(gitdir, oids) {
    const seen = new Set();
    const queue = oids.filter(Boolean);
    while (queue.length > 0) {
        const oid = queue.pop();
        if (seen.has(oid)) continue;
        seen.add(oid);
        try {
            const obj = await git.readObject({ fs: atomicFs, gitdir, oid, format: 'parsed' });
            if (obj.type === 'commit') {
                queue.push(obj.object.tree, ...(obj.object.parent ?? []));
            } else if (obj.type === 'tree') {
                for (const entry of obj.object) queue.push(entry.oid);
            }
        } catch (error) {
            if (error.code === 'NotFoundError') continue;
            throw error;
        }
    }
    return seen;
}

/**
 * RemoteBackend over a paired LAN device. The head it reads is the peer's
 * `main`; what it writes is the peer's `refs/incoming/<id>`, which the
 * peer merges into its own `main` when notified. The etag is the
 * incoming ref seen with the head, so a compare-and-swap fails when
 * another push of ours reached the peer in between.
 */
export class LanBackend {
    /**
     * @param {{
     *   id: string,
     *   userRoot: string,
     *   entry: { lan: { peerBaseUrl?: string, peerAuth?: { username?: string, password?: string } | null, syncSecret?: string | null } },
     *   deviceLabel: string,
     *   callback: import('./callback.js').SyncCallback | null,
     *   owner: import('../../pipeline/sync-hooks.js').SyncOwner,
     *   network?: import('../../net-guard.js').NetworkFixtureOptions,
     *   fetchImpl?: typeof globalThis.fetch,
     * }} args
     */
    constructor({ id, owner, userRoot, entry, deviceLabel, callback, network, fetchImpl }) {
        assertSafeBackendId(id);
        this.id = id;
        this.kind = 'lan';
        this.entry = entry;
        this.deviceLabel = deviceLabel;
        this.callback = callback;
        this.fetchImpl = fetchImpl ?? guardedLanFetch(owner, network);
        this.userRoot = userRoot;
        this.local = getShadowPaths({ userRoot, peerId: id });
        this.token = null;
        /** @type {string | null | undefined} undefined until a manifest was read */
        this.observedIncoming = undefined;
        this.casUnchanged = false;
    }

    url(route) {
        return `${this.entry.lan.peerBaseUrl.replace(/\/+$/, '')}/api/sync/v1${route}`;
    }

    basicAuth() {
        const auth = this.entry.lan.peerAuth;
        return auth?.username && auth?.password
            ? { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}` }
            : {};
    }

    bearer(extra = {}) {
        return { Authorization: `Bearer ${this.token}`, ...extra };
    }

    async request(route, { allowStatus = [], ...init } = {}) {
        let response;
        try {
            response = await this.fetchImpl(this.url(route), init);
        } catch (error) {
            if (error?.code?.startsWith('SYNC_') || error?.code === 'INVALID_SYNC_URL') throw error;
            throw syncError('PEER_UNREACHABLE', describeFetchFailure(error));
        }
        if (response.ok || allowStatus.includes(response.status)) return response;
        const body = await response.json().catch(() => ({}));
        throw syncError(peerErrorCode(response.status, body), String(body?.error || `HTTP ${response.status}`));
    }

    async openSession() {
        if (this.token) return;
        if (!this.entry.lan.peerBaseUrl) throw syncError('NO_BASE_URL', 'The other device has not reported its address yet');
        assertProtocol(await readJson(await this.request('/health', { headers: this.basicAuth() })));
        const response = await this.request('/session/offer', {
            method: 'POST',
            headers: { ...this.basicAuth(), 'Content-Type': 'application/json', [PEER_SECRET_HEADER]: this.entry.lan.syncSecret },
            body: JSON.stringify({ peerId: this.id, label: this.deviceLabel, protocol: LAN_PROTOCOL, callback: this.callback }),
        });
        const body = await readJson(response);
        assertProtocol(body);
        if (!TOKEN_PATTERN.test(String(body?.token))) throw syncError('PEER_ERROR', 'The other device returned no session token');
        this.token = body.token;
        const storeLabel = () => setLanPeerDeviceLabel({ userRoot: this.userRoot, backendId: this.id, peerDeviceLabel: body.deviceLabel });
        if (this.lease) await this.lease.withLocal(storeLabel);
        else await storeLabel();
    }

    async readHead() {
        await this.openSession();
        const body = await readJson(await this.request('/session/manifest', { headers: this.bearer() }));
        if (!body || typeof body !== 'object' || !('headOid' in body) || !('incomingOid' in body)) throw syncError('PEER_PROTOCOL_OUTDATED', 'The other device returned an old manifest');
        this.observedIncoming = body.incomingOid ?? null;
        return body.headOid ? { oid: body.headOid, etag: body.incomingOid ?? NO_INCOMING } : null;
    }

    async fetchInto(want) {
        for (const headOid of want) {
            await fetchMissingObjects({
                dir: this.local.workdir, gitdir: this.local.gitDir, headOid,
                withLocal: this.lease ? fn => this.lease.withLocal(fn) : undefined,
                fetchObject: async oid => {
                    const response = await this.request(`/session/object/${oid}`, { headers: this.bearer() });
                    const type = String(response.headers.get('X-Object-Type') || '').toLowerCase();
                    if (!type) throw syncError('PEER_ERROR', `object ${oid} came without a type`);
                    return { oid, type, body: Buffer.from(await response.arrayBuffer()) };
                },
            });
        }
    }

    async pushObjects(localHead, remoteHead) {
        // The peer holds the closure of its main and of our last accepted
        // push; objects missing locally are simply not skipped.
        const skip = await collectReachable(this.local.gitDir, [remoteHead, this.observedIncoming]);
        for (const oid of await listObjectsChildrenFirst({ dir: this.local.workdir, gitdir: this.local.gitDir, headOid: localHead, skip })) {
            const object = await readObjectForWire({ dir: this.local.workdir, gitdir: this.local.gitDir, oid });
            await this.request('/session/object', {
                method: 'POST',
                headers: this.bearer({ 'Content-Type': 'application/octet-stream', 'X-Object-Oid': oid, 'X-Object-Type': object.type }),
                body: object.body,
            });
        }
    }

    async casHead(expectedEtag, oid) {
        // A null etag means readHead saw no peer main; the incoming ref seen
        // in the same read is still what the peer holds for us.
        const expected = expectedEtag ?? this.observedIncoming ?? NO_INCOMING;
        this.casUnchanged = expected === oid;
        if (this.casUnchanged) return { ok: true };
        const response = await this.request('/session/ref', {
            method: 'POST',
            allowStatus: [409],
            headers: this.bearer({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ ref: incomingRefFor(this.id), expectedOid: expected === NO_INCOMING ? ZERO_OID : expected, newOid: oid }),
        });
        if (response.status === 409) return { ok: false, reason: 'conflict' };
        this.observedIncoming = oid;
        return { ok: true };
    }

    async notifyPeer() {
        if (this.casUnchanged) return;
        await this.request('/session/notify', { method: 'POST', headers: this.bearer() });
    }

    async close() {
        if (!this.token) return;
        await this.request('/session/close', { method: 'POST', headers: this.bearer() }).catch(() => undefined);
        this.token = null;
    }
}
