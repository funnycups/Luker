import { createHash } from 'node:crypto';
import git from 'isomorphic-git';

import { commitLocalEdit, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { getShadowPaths } from '../../../src/sync/shadow.js';

const SALT_AUTHOR = Object.freeze({ name: 't', email: 't@t', timestamp: 1700000000, timezoneOffset: 0 });

/**
 * Snapshot live data of `ctx` into its main and, when needed, move main to
 * a child commit with the identical tree whose SHA-1 orders before `otherHead`
 * (`localFirst`) or after it. The side with the smaller head is ours in a
 * merge, so this fixes which side the next merge keeps provisionally without
 * mutating live data. The matching commit message is found in memory before
 * writing a single git object, avoiding disk I/O timeouts when `otherHead`
 * sits near `00...` or `ff...`.
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
    if ((snapshot < otherHead) === localFirst) {
        return snapshot;
    }
    const { gitDir: gitdir } = getShadowPaths({ userRoot: ctx.userRoot, peerId: ctx.backendId });
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: snapshot });
    const prefix = `tree ${commit.tree}\nparent ${snapshot}\nauthor t <t@t> ${SALT_AUTHOR.timestamp} +0000\ncommitter t <t@t> ${SALT_AUTHOR.timestamp} +0000\n\n`;
    let message = '';
    let expectedOid = '';
    for (let salt = 0; ; salt += 1) {
        message = `merge role salt ${salt}\n`;
        const body = `${prefix}${message}`;
        expectedOid = createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
        if ((expectedOid < otherHead) === localFirst) break;
    }
    const head = await git.commit({
        fs: atomicFs,
        gitdir,
        message,
        author: SALT_AUTHOR,
        committer: SALT_AUTHOR,
        tree: commit.tree,
        parent: [snapshot],
        noUpdateBranch: true,
    });
    if (head !== expectedOid) {
        throw new Error(`orderLocalHead commit hash mismatch: expected ${expectedOid}, got ${head}`);
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
