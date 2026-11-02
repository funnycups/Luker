import git from 'isomorphic-git';

import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { writeTreeFromFiles } from '../../../src/sync/pipeline/git-tree.js';

/**
 * Write a commit whose tree is exactly `files`, without moving any ref.
 *
 * @param {string} gitdir
 * @param {Record<string, string | Buffer>} files
 * @param {string[]} [parents]
 * @param {{ name: string, email: string }} [author]
 * @returns {Promise<string>}
 */
export async function commitFiles(gitdir, files, parents = [], author) {
    const map = new Map();
    for (const [relPath, content] of Object.entries(files)) {
        const oid = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(content) });
        map.set(relPath, { oid, mode: '100644' });
    }
    const tree = await writeTreeFromFiles({ gitdir, files: map });
    return commitTree(gitdir, tree, parents, author);
}

/**
 * Commit an existing tree oid without moving any ref.
 *
 * @param {string} gitdir
 * @param {string} tree
 * @param {string[]} [parents]
 * @param {{ name: string, email: string }} [author]
 * @returns {Promise<string>}
 */
export function commitTree(gitdir, tree, parents = [], author = { name: 't', email: 't@t' }) {
    return git.commit({ fs: atomicFs, gitdir, message: 'test commit', author, tree, parent: parents, noUpdateBranch: true });
}

/**
 * Write a tree object byte for byte, so tests can build trees with entry
 * names a hostile peer could send (`..`, `.GIT`, …) that the normal tree
 * writer would not produce.
 *
 * @param {string} gitdir
 * @param {Array<{ mode: string, name: string, oid: string }>} entries mode `100644` for blobs, `40000` for trees
 * @returns {Promise<string>}
 */
export function writeRawTree(gitdir, entries) {
    const object = Buffer.concat(entries.flatMap(entry => [Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex')]));
    return git.writeObject({ fs: atomicFs, gitdir, type: 'tree', object, format: 'content' });
}

/**
 * @param {string} gitdir
 * @param {string | Buffer} content
 * @returns {Promise<string>}
 */
export function writeBlob(gitdir, content) {
    return git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(content) });
}
