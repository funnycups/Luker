import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';
import { DirectoryBackend, initDirectoryRemote } from './directory-backend.js';
import { makeUserDirs } from './user-dirs.js';

export const BACKEND_ID = 'remote';
export const DEFAULT_CATEGORIES = Object.freeze(['characters', 'worlds']);

export async function makeRemote() {
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-remote-'));
    await initDirectoryRemote(remoteDir);
    return { remoteDir, cleanup: () => fs.rmSync(remoteDir, { recursive: true, force: true }) };
}

/**
 * A device bound to an existing user root (used by child processes too).
 */
export function openDevice({ userRoot, remoteDir, categories = DEFAULT_CATEGORIES, hooks = {} }) {
    const directories = makeUserDirs(userRoot);
    const backend = new DirectoryBackend({ id: BACKEND_ID, remoteDir, userRoot, hooks });
    const abs = rel => path.join(userRoot, ...rel.split('/'));
    return {
        userRoot,
        remoteDir,
        directories,
        hooks: backend.hooks,
        backend,
        shadow: getShadowPaths({ userRoot, peerId: BACKEND_ID }),
        ctx: {
            userRoot,
            handle: 'u',
            directories,
            backendId: BACKEND_ID,
            categories: [...categories],
            engine: new FsEngine({ directoriesByHandle: () => directories }),
            backend,
        },
        write(rel, content) {
            fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
            fs.writeFileSync(abs(rel), content);
        },
        read(rel) {
            return fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : null;
        },
        remove(rel) {
            fs.rmSync(abs(rel));
        },
        cleanup: () => fs.rmSync(userRoot, { recursive: true, force: true }),
    };
}

export function makeDevice(options) {
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-device-'));
    return openDevice({ ...options, userRoot });
}

export async function resolveRefOrNull(gitdir, ref) {
    try {
        return await git.resolveRef({ fs: atomicFs, gitdir, ref });
    } catch (error) {
        if (error.code === 'NotFoundError') return null;
        throw error;
    }
}

export const remoteHead = remoteDir => resolveRefOrNull(remoteDir, 'refs/heads/main');

/**
 * Read every object reachable from `oid`; throws on any missing or corrupt object.
 *
 * @returns {Promise<Set<string>>} oids read
 */
export async function readAllReachable(gitdir, oid) {
    const seen = new Set();
    const queue = [oid];
    while (queue.length > 0) {
        const next = queue.pop();
        if (seen.has(next)) continue;
        seen.add(next);
        const obj = await git.readObject({ fs: atomicFs, gitdir, oid: next, format: 'parsed' });
        if (obj.type === 'commit') queue.push(obj.object.tree, ...(obj.object.parent ?? []));
        else if (obj.type === 'tree') queue.push(...obj.object.map(entry => entry.oid));
    }
    return seen;
}
