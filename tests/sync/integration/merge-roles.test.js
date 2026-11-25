import { expect, test } from '@jest/globals';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

import { currentScopeForResources } from '../../harness/storage-scope.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { commitLocalEdit, MAIN_REF } from '../../../src/sync/pipeline/cycle.js';
import { readCommitFiles } from '../../../src/sync/pipeline/git-tree.js';
import { openDevice } from '../_lib/devices.js';
import { initDirectoryRemote } from '../_lib/directory-backend.js';
import { orderLocalHead } from '../_lib/merge-roles.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const boundaries = [
    { label: 'lower hash boundary', prefix: '00', nonce: 0, oid: '0096d10dd083ab9a3841c443e8ae4e9eeec13155', localFirst: true },
    { label: 'upper hash boundary', prefix: 'ff', nonce: 186, oid: 'ff5347fabea29a9304fb746fb8e00a9300491551', localFirst: false },
];

function looseObjects(gitdir) {
    const root = path.join(gitdir, 'objects');
    return fs.readdirSync(root).filter(name => /^[a-f0-9]{2}$/.test(name)).flatMap(prefix =>
        fs.readdirSync(path.join(root, prefix)).filter(name => /^[a-f0-9]{38}$/.test(name)).map(name => prefix + name),
    );
}

test.each(boundaries)('$label publishes only the selected same-tree commit', async ({ prefix, nonce, oid: otherHead, localFirst }) => {
    const directory = await currentScopeForResources().directory('merge role boundary');
    const remote = path.join(directory.path, 'remote');
    await initDirectoryRemote(remote);
    expect(await git.writeTree({ fs: atomicFs, gitdir: remote, tree: [] })).toBe(EMPTY_TREE);
    const remoteObject = Buffer.from(`tree ${EMPTY_TREE}\nauthor fixture <fixture@local> 0 +0000\ncommitter fixture <fixture@local> 0 +0000\n\ncomparison boundary ${nonce}\n`);
    expect(await git.writeObject({ fs: atomicFs, gitdir: remote, type: 'commit', object: remoteObject, format: 'content' })).toBe(otherHead);
    await git.writeRef({ fs: atomicFs, gitdir: remote, ref: MAIN_REF, value: otherHead, force: true });

    const device = openDevice({ userRoot: path.join(directory.path, 'user'), remoteDir: remote });
    device.write('characters/retained.png', 'retained local content');
    const localContext = { ...device.ctx };
    delete localContext.backend;
    const { head: snapshot } = await commitLocalEdit(localContext, async () => null);
    const gitdir = device.shadow.gitDir;
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: snapshot });
    let baseline, baselineObject;
    for (let attempt = 0; ; attempt++) {
        baselineObject = Buffer.from(`tree ${commit.tree}\nparent ${snapshot}\nauthor fixture <fixture@local> 0 +0000\ncommitter fixture <fixture@local> 0 +0000\n\nlocal boundary baseline ${attempt}\n`);
        baseline = createHash('sha1').update(`commit ${baselineObject.length}\0`).update(baselineObject).digest('hex');
        if ((baseline < otherHead) !== localFirst) break;
    }
    expect(await git.writeObject({ fs: atomicFs, gitdir, type: 'commit', object: baselineObject, format: 'content' })).toBe(baseline);
    await git.writeRef({ fs: atomicFs, gitdir, ref: MAIN_REF, value: baseline, force: true });
    expect((baseline < otherHead) === localFirst).toBe(false);
    const before = await readCommitFiles({ gitdir, commitOid: baseline });
    const objects = path.join(gitdir, 'objects');
    const writable = path.join(objects, prefix);
    fs.mkdirSync(writable, { recursive: true });
    const protectedPaths = [objects, ...fs.readdirSync(objects, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== prefix).map(entry => path.join(objects, entry.name))];
    const originalModes = protectedPaths.map(file => [file, fs.statSync(file).mode & 0o777]);
    const previousObjects = new Set(looseObjects(gitdir));
    try {
        // Only a commit in the selected hash range may create an object.
        for (const [file] of originalModes) fs.chmodSync(file, 0o500);
        const head = await orderLocalHead(device.ctx, otherHead, localFirst);
        expect(head < otherHead).toBe(localFirst);
        expect(await git.resolveRef({ fs: atomicFs, gitdir, ref: MAIN_REF })).toBe(head);
        const { commit: selected } = await git.readCommit({ fs: atomicFs, gitdir, oid: head });
        expect(selected.parent).toEqual([baseline]);
        expect(selected.tree).toBe(commit.tree);
        expect(await readCommitFiles({ gitdir, commitOid: head })).toEqual(before);
        expect(device.read('characters/retained.png')).toBe('retained local content');
        expect(await git.resolveRef({ fs: atomicFs, gitdir: remote, ref: MAIN_REF })).toBe(otherHead);
        expect(looseObjects(gitdir).filter(value => !previousObjects.has(value))).toEqual([head]);
    } finally {
        for (const [file, mode] of originalModes) fs.chmodSync(file, mode);
    }
});
