import git from 'isomorphic-git';

import { commitLocalEdit, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { readCommitFiles, writeTreeFromFiles } from '../../../src/sync/pipeline/git-tree.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';

/** Outside every category, so it never reaches live data. */
const SALT_PATH = 'extra/merge-role-salt';

/**
 * Snapshot live data of `ctx` into its main and, when needed, move main to
 * a child commit that only adds a salt file, until main orders before
 * `otherHead` (`localFirst`) or after it. The side with the smaller head
 * is ours in a merge, so this fixes which side the next merge of the two
 * heads keeps provisionally. Each salt commit flips the order with even
 * odds; the salt changes no live data, so main may move without a
 * reconcile.
 *
 * @param {object} ctx cycle context of the device
 * @param {string} otherHead head the next merge meets
 * @param {boolean} localFirst
 * @returns {Promise<string>} the local main
 */
export async function orderLocalHead(ctx, otherHead, localFirst) {
    const local = { ...ctx };
    delete local.backend;
    const { head: snapshot } = await commitLocalEdit(local, async () => null);
    const { gitDir: gitdir } = getShadowPaths({ userRoot: ctx.userRoot, peerId: ctx.backendId });
    const files = await readCommitFiles({ gitdir, commitOid: snapshot });
    let head = snapshot;
    for (let salt = 0; (head < otherHead) !== localFirst; salt += 1) {
        files.set(SALT_PATH, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(String(salt)) }), mode: '100644' });
        const tree = await writeTreeFromFiles({ gitdir, files });
        head = await git.commit({ fs: atomicFs, gitdir, message: 'merge role salt', author: { name: 't', email: 't@t' }, tree, parent: [snapshot], noUpdateBranch: true });
    }
    await git.writeRef({ fs: atomicFs, gitdir, ref: MAIN_REF, value: head, force: true });
    return head;
}

/**
 * Whether the local side was ours in the merge commit `mergeOid` of the
 * local head and `remoteHead`.
 *
 * @param {string} gitdir
 * @param {string} mergeOid
 * @param {string} remoteHead
 * @returns {Promise<boolean>}
 */
export async function localWasOurs(gitdir, mergeOid, remoteHead) {
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: mergeOid });
    return commit.parent.find(parent => parent !== remoteHead) < remoteHead;
}
