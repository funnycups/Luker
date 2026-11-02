import git from 'isomorphic-git';

import { atomicFs } from '../../pipeline/atomic-fs.js';
import { getShadowPaths } from '../../shadow.js';

/**
 * Ref in the backend's shadow repository that records the newest commit a
 * LAN peer pushed to this device.
 *
 * @param {string} backendId
 * @returns {string}
 */
export function incomingRefFor(backendId) {
    return 'refs/incoming/' + backendId;
}

/**
 * RemoteBackend over the commits a LAN peer pushed to this device. The
 * peer's objects arrive through `/session/object` and `/session/ref`
 * verifies their closure before it moves the incoming ref, so reading the
 * head needs no network, fetching and pushing have nothing to do, and the
 * head swap always succeeds.
 */
export class IncomingRefBackend {
    /**
     * @param {{ id: string, userRoot: string }} args
     */
    constructor({ id, userRoot }) {
        this.id = id;
        this.kind = 'lan';
        this.isLocal = true;
        this.local = getShadowPaths({ userRoot, peerId: id });
    }

    async readHead() {
        try {
            const oid = await git.resolveRef({ fs: atomicFs, gitdir: this.local.gitDir, ref: incomingRefFor(this.id) });
            return { oid, etag: oid };
        } catch (error) {
            if (error.code === 'NotFoundError') return null;
            throw error;
        }
    }

    async fetchInto(_want, _have) {}

    async pushObjects(_localHead, _remoteHead) {}

    async casHead(_expectedEtag, _oid) {
        return { ok: true };
    }
}
