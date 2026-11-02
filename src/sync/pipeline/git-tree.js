import crypto from 'node:crypto';
import path from 'node:path';
import git from 'isomorphic-git';

import { atomicFs } from './atomic-fs.js';

/** @typedef {{ oid: string, mode: string }} TreeFile */

/** Tree paths under this directory carry sync metadata, not user data. */
export const SYNC_METADATA_DIR = '.luker-sync';

/**
 * Git blob oid of `bytes`: sha1 over `blob <length>\0<bytes>`.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {string}
 */
export function blobOidOf(bytes) {
    return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * A tree path is unsafe when any segment is empty, `.`, `..` or a
 * case-insensitive `.git`. isomorphic-git's tree parser only rejects `/`
 * and `\` inside entry names, and tree contents come from other devices,
 * so these paths must never be turned into filesystem paths.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isUnsafeTreePath(relPath) {
    return relPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git');
}

const SYMLINK_MODE = '120000';

/**
 * Every regular blob in a commit's tree, keyed by POSIX path, plus the
 * entries that were refused: unsafe paths (see `isUnsafeTreePath`),
 * symlinks and submodules. A tree entry with an unsafe name is not
 * descended into, so everything below it is covered by its rejection.
 *
 * @param {{ gitdir: string, commitOid: string | null }} args
 * @returns {Promise<{ files: Map<string, TreeFile>, rejected: Map<string, TreeFile> }>}
 */
export async function readCommitEntries({ gitdir, commitOid }) {
    /** @type {Map<string, TreeFile>} */
    const files = new Map();
    /** @type {Map<string, TreeFile>} */
    const rejected = new Map();
    if (!commitOid) return { files, rejected };
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: commitOid });
    const collect = async (treeOid, prefix) => {
        const { tree } = await git.readTree({ fs: atomicFs, gitdir, oid: treeOid });
        for (const entry of tree) {
            const relPath = prefix ? `${prefix}/${entry.path}` : entry.path;
            if (entry.type === 'tree' && !isUnsafeTreePath(relPath)) await collect(entry.oid, relPath);
            else if (entry.type === 'blob' && entry.mode !== SYMLINK_MODE && !isUnsafeTreePath(relPath)) files.set(relPath, { oid: entry.oid, mode: entry.mode });
            else rejected.set(relPath, { oid: entry.oid, mode: entry.mode });
        }
    };
    await collect(commit.tree, '');
    return { files, rejected };
}

/**
 * True when `relPath` or one of its parent paths is a rejected entry.
 *
 * @param {Map<string, TreeFile>} rejected
 * @param {string} relPath
 * @returns {boolean}
 */
export function isRejectedPath(rejected, relPath) {
    if (rejected.size === 0) return false;
    const parts = relPath.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
        if (rejected.has(parts.slice(0, depth).join('/'))) return true;
    }
    return false;
}

/**
 * The regular files of `readCommitEntries`; when `unsafe` is given the
 * rejected paths are appended to it so callers can report them.
 *
 * @param {{ gitdir: string, commitOid: string | null, unsafe?: string[] }} args
 * @returns {Promise<Map<string, TreeFile>>}
 */
export async function readCommitFiles({ gitdir, commitOid, unsafe }) {
    const { files, rejected } = await readCommitEntries({ gitdir, commitOid });
    if (unsafe) unsafe.push(...rejected.keys());
    return files;
}

/**
 * Resolve a safe tree path under `root` and refuse anything that would
 * land outside it.
 *
 * @param {string} root
 * @param {string} relPath
 * @returns {string}
 */
export function resolveTreePathUnder(root, relPath) {
    if (isUnsafeTreePath(relPath)) throw new Error(`unsafe tree path ${JSON.stringify(relPath)}`);
    const resolvedRoot = path.resolve(root);
    const absPath = path.resolve(resolvedRoot, ...relPath.split('/'));
    if (!absPath.startsWith(resolvedRoot + path.sep)) throw new Error(`tree path ${JSON.stringify(relPath)} escapes ${resolvedRoot}`);
    return absPath;
}

/**
 * Write nested tree objects for a flat path map and return the root oid.
 * isomorphic-git sorts entries into git order when it serializes a tree.
 *
 * @param {{ gitdir: string, files: Map<string, TreeFile> }} args
 * @returns {Promise<string>}
 */
export async function writeTreeFromFiles({ gitdir, files }) {
    const root = { files: new Map(), dirs: new Map() };
    for (const [relPath, file] of files) {
        const parts = relPath.split('/');
        let node = root;
        for (const part of parts.slice(0, -1)) {
            if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
            node = node.dirs.get(part);
        }
        node.files.set(parts[parts.length - 1], file);
    }
    const write = async (node) => {
        const tree = [];
        for (const [name, child] of node.dirs) tree.push({ mode: '040000', path: name, oid: await write(child), type: 'tree' });
        for (const [name, file] of node.files) tree.push({ mode: file.mode, path: name, oid: file.oid, type: 'blob' });
        return git.writeTree({ fs: atomicFs, gitdir, tree });
    };
    return write(root);
}

/**
 * @param {{ gitdir: string, oid: string }} args
 * @returns {Promise<Buffer>}
 */
export async function readBlobBytes({ gitdir, oid }) {
    const { blob } = await git.readBlob({ fs: atomicFs, gitdir, oid });
    return Buffer.from(blob);
}
