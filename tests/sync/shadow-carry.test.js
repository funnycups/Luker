import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';

import { atomicFs } from '../../src/sync/pipeline/atomic-fs.js';
import { ensureShadowRepo, snapshotLiveToShadow } from '../../src/sync/shadow.js';
import { readCommitFiles, blobOidOf } from '../../src/sync/pipeline/git-tree.js';
import { commitFiles, commitTree, writeBlob, writeRawTree } from './_lib/commits.js';
import { makeUserDirs } from './_lib/user-dirs.js';

describe('snapshot keeps HEAD paths outside enabled categories', () => {
    let root;
    let dirs;
    let shadow;
    const snapshot = categories => snapshotLiveToShadow({ userRoot: root, peerId: 'p', directories: dirs, enabledCategoryIds: categories });
    const tree = async oid => Object.fromEntries([...(await readCommitFiles({ gitdir: shadow.gitDir, commitOid: oid }))].map(([p, f]) => [p, f.oid]));

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-carry-'));
        dirs = makeUserDirs(root);
        shadow = await ensureShadowRepo({ userRoot: root, peerId: 'p' });
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('sync metadata and disabled categories survive a snapshot of live data', async () => {
        fs.writeFileSync(path.join(dirs.characters, 'a.png'), 'A');
        const first = await snapshot(['characters']);
        const withExtra = await commitFiles(shadow.gitDir, {
            'characters/a.png': 'A',
            '.luker-sync/conflicts.json': '{"entries":{}}',
            'worlds/remote.json': '{}',
        }, [first.oid]);
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: withExtra, force: true });

        const unchanged = await snapshot(['characters']);
        expect(unchanged).toEqual({ committed: false, oid: withExtra });

        fs.writeFileSync(path.join(dirs.characters, 'b.png'), 'B');
        const next = await snapshot(['characters']);
        expect(next.committed).toBe(true);
        expect(await tree(next.oid)).toEqual({
            'characters/a.png': blobOidOf(Buffer.from('A')),
            'characters/b.png': blobOidOf(Buffer.from('B')),
            '.luker-sync/conflicts.json': blobOidOf(Buffer.from('{"entries":{}}')),
            'worlds/remote.json': blobOidOf(Buffer.from('{}')),
        });
        expect(fs.existsSync(path.join(root, '.luker-sync'))).toBe(false);
        expect(fs.existsSync(path.join(dirs.worlds, 'remote.json'))).toBe(false);
    });

    test('a kept path removed from HEAD is pruned from the workdir', async () => {
        fs.writeFileSync(path.join(dirs.characters, 'a.png'), 'A');
        const first = await snapshot(['characters']);
        const withExtra = await commitFiles(shadow.gitDir, { 'characters/a.png': 'A', 'worlds/remote.json': '{}' }, [first.oid]);
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: withExtra, force: true });
        await snapshot(['characters']);
        expect(fs.existsSync(path.join(shadow.workdir, 'worlds/remote.json'))).toBe(true);
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: first.oid, force: true });
        const result = await snapshot(['characters']);
        expect(result).toEqual({ committed: false, oid: first.oid });
        expect(fs.existsSync(path.join(shadow.workdir, 'worlds/remote.json'))).toBe(false);
    });

    test('symlink and submodule HEAD entries are not restored into the workdir', async () => {
        fs.writeFileSync(path.join(dirs.characters, 'a.png'), 'A');
        const first = await snapshot(['characters']);
        const linkBlob = await writeBlob(shadow.gitDir, '../../../settings.json');
        const worlds = await writeRawTree(shadow.gitDir, [
            { mode: '120000', name: 'link.json', oid: linkBlob },
            { mode: '160000', name: 'module', oid: first.oid },
        ]);
        const aBlob = await writeBlob(shadow.gitDir, 'A');
        const characters = await writeRawTree(shadow.gitDir, [{ mode: '100644', name: 'a.png', oid: aBlob }]);
        const rootTree = await writeRawTree(shadow.gitDir, [{ mode: '40000', name: 'characters', oid: characters }, { mode: '40000', name: 'worlds', oid: worlds }]);
        const withRefused = await commitTree(shadow.gitDir, rootTree, [first.oid]);
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: withRefused, force: true });
        await snapshot(['characters']);
        expect(fs.existsSync(path.join(shadow.workdir, 'worlds'))).toBe(false);
    });

    test('a symlinked directory in the workdir is never written through', async () => {
        fs.writeFileSync(path.join(dirs.characters, 'a.png'), 'A');
        const first = await snapshot(['characters']);
        const withExtra = await commitFiles(shadow.gitDir, { 'characters/a.png': 'A', 'worlds/remote.json': '{}' }, [first.oid]);
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: withExtra, force: true });
        const outsideWorlds = path.join(root, 'outside-worlds');
        const outsideCharacters = path.join(root, 'outside-characters');
        fs.mkdirSync(outsideWorlds);
        fs.mkdirSync(outsideCharacters);
        fs.rmSync(path.join(shadow.workdir, 'characters'), { recursive: true, force: true });
        fs.symlinkSync(outsideWorlds, path.join(shadow.workdir, 'worlds'), 'dir');
        fs.symlinkSync(outsideCharacters, path.join(shadow.workdir, 'characters'), 'dir');

        const result = await snapshot(['characters']);

        expect(fs.readdirSync(outsideWorlds)).toEqual([]);
        expect(fs.readdirSync(outsideCharacters)).toEqual([]);
        expect(fs.lstatSync(path.join(shadow.workdir, 'worlds')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(shadow.workdir, 'characters')).isSymbolicLink()).toBe(false);
        expect(result).toEqual({ committed: false, oid: withExtra });
    });

    test('unsafe HEAD paths are never written into the workdir or the user root', async () => {
        fs.writeFileSync(path.join(dirs.characters, 'a.png'), 'A');
        const first = await snapshot(['characters']);
        const blob = await writeBlob(shadow.gitDir, '{"stolen":true}');
        let tree = await writeRawTree(shadow.gitDir, [{ mode: '100644', name: 'settings.json', oid: blob }]);
        for (let depth = 0; depth < 3; depth++) tree = await writeRawTree(shadow.gitDir, [{ mode: '40000', name: '..', oid: tree }]);
        const aBlob = await writeBlob(shadow.gitDir, 'A');
        const characters = await writeRawTree(shadow.gitDir, [{ mode: '100644', name: 'a.png', oid: aBlob }]);
        const rootTree = await writeRawTree(shadow.gitDir, [{ mode: '40000', name: '..', oid: tree }, { mode: '40000', name: 'characters', oid: characters }]);
        const hostile = await commitTree(shadow.gitDir, rootTree, [first.oid]);
        await git.writeRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: 'refs/heads/main', value: hostile, force: true });
        await snapshot(['characters']);
        expect(fs.existsSync(path.join(root, 'settings.json'))).toBe(false);
        expect(fs.existsSync(path.join(shadow.peerDir, 'settings.json'))).toBe(false);
        expect(fs.existsSync(path.join(root, '.sync', 'settings.json'))).toBe(false);
    });
});
