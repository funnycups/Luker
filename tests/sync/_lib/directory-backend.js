import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { fetchMissingObjects, hasObjectLocally, readObjectForWire } from '../../../src/sync/objects.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';

const REMOTE_REF = 'refs/heads/main';
const CAS_TAILS = new Map();

/**
 * @param {string} remoteDir
 */
export async function initDirectoryRemote(remoteDir) {
    await fs.promises.mkdir(remoteDir, { recursive: true });
    if (!fs.existsSync(path.join(remoteDir, 'HEAD'))) {
        await git.init({ fs: atomicFs, dir: remoteDir, gitdir: remoteDir, bare: true, defaultBranch: 'main' });
    }
}

async function remoteMainOrNull(remoteDir) {
    try {
        return await git.resolveRef({ fs: atomicFs, gitdir: remoteDir, ref: REMOTE_REF });
    } catch (error) {
        if (error.code === 'NotFoundError') return null;
        throw error;
    }
}

function serialize(key, fn) {
    const prior = CAS_TAILS.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    CAS_TAILS.set(key, run.catch(() => undefined));
    return run;
}

/**
 * RemoteBackend whose remote is a bare git repository on local disk.
 * The etag of the head is the head oid itself.
 */
export class DirectoryBackend {
    constructor({ id, remoteDir, userRoot, hooks = {} }) {
        this.id = id;
        this.kind = 'directory';
        this.remoteDir = remoteDir;
        this.local = getShadowPaths({ userRoot, peerId: id });
        this.hooks = { ...hooks };
    }

    async runHook(name) {
        const hook = this.hooks[name];
        if (!hook) return;
        this.hooks[name] = null;
        await hook();
    }

    async readHead() {
        const oid = await remoteMainOrNull(this.remoteDir);
        await this.runHook('afterReadHead');
        return oid ? { oid, etag: oid } : null;
    }

    async fetchInto(want, _have) {
        for (const headOid of want) {
            await fetchMissingObjects({
                dir: this.local.workdir,
                gitdir: this.local.gitDir,
                headOid,
                fetchObject: oid => readObjectForWire({ dir: this.remoteDir, gitdir: this.remoteDir, oid }),
            });
        }
    }

    async pushObjects(localHead, _remoteHead) {
        await this.runHook('beforePushObjects');
        await fetchMissingObjects({
            dir: this.remoteDir,
            gitdir: this.remoteDir,
            headOid: localHead,
            fetchObject: oid => readObjectForWire({ dir: this.local.workdir, gitdir: this.local.gitDir, oid }),
        });
    }

    async casHead(expectedEtag, oid) {
        await this.runHook('beforeCasHead');
        return serialize(this.remoteDir, async () => {
            const current = await remoteMainOrNull(this.remoteDir);
            if (current !== (expectedEtag ?? null)) return { ok: false, reason: 'conflict' };
            if (!await hasObjectLocally({ dir: this.remoteDir, gitdir: this.remoteDir, oid })) {
                throw new Error(`casHead: ${oid} is not in the remote`);
            }
            await git.writeRef({ fs: atomicFs, gitdir: this.remoteDir, ref: REMOTE_REF, value: oid, force: true });
            return { ok: true };
        });
    }
}
