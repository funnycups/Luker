import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { ensureShadowRepo, snapshotLiveToShadow } from '../../src/sync/shadow.js';

function fakeDirsAt(root) {
    return {
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'group chats'),
        worlds: path.join(root, 'worlds'),
        cardApps: path.join(root, 'card-apps'),
    };
}

async function headBlobText(paths, filepath) {
    const oid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
    const { blob } = await git.readBlob({ fs, dir: paths.workdir, gitdir: paths.gitDir, oid, filepath });
    return Buffer.from(blob).toString('utf8');
}

describe('snapshotLiveToShadow same-size edits', () => {
    let userRoot, liveRoot;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-samesize-shadow-'));
        liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-samesize-live-'));
        fs.mkdirSync(path.join(liveRoot, 'worlds'), { recursive: true });
    });
    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
        fs.rmSync(liveRoot, { recursive: true, force: true });
    });

    test('commits a same-size live rewrite made immediately after a snapshot', async () => {
        const live = path.join(liveRoot, 'worlds', 'w.json');
        fs.writeFileSync(live, '{"v":"A"}');
        const args = { userRoot, peerId: 'p', directories: fakeDirsAt(liveRoot), enabledCategoryIds: ['worlds'] };
        const first = await snapshotLiveToShadow(args);
        expect(first.committed).toBe(true);

        fs.writeFileSync(live, '{"v":"B"}');
        const second = await snapshotLiveToShadow(args);

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        expect(second.committed).toBe(true);
        expect(await headBlobText(paths, 'worlds/w.json')).toBe('{"v":"B"}');
    });

    test('commits a same-size live rewrite whose mtime and size match the previous version', async () => {
        const live = path.join(liveRoot, 'worlds', 'w.json');
        fs.writeFileSync(live, '{"v":"A"}');
        const fixed = new Date('2026-01-01T00:00:00Z');
        fs.utimesSync(live, fixed, fixed);
        const args = { userRoot, peerId: 'p', directories: fakeDirsAt(liveRoot), enabledCategoryIds: ['worlds'] };
        await snapshotLiveToShadow(args);

        fs.writeFileSync(live, '{"v":"B"}');
        fs.utimesSync(live, fixed, fixed);
        const second = await snapshotLiveToShadow(args);

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        expect(second.committed).toBe(true);
        expect(await headBlobText(paths, 'worlds/w.json')).toBe('{"v":"B"}');
    });

    test('commits a same-size rewrite written directly into the workdir with liveRoot set to the workdir', async () => {
        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        const dirs = fakeDirsAt(paths.workdir);
        fs.mkdirSync(dirs.worlds, { recursive: true });
        const staged = path.join(dirs.worlds, 'w.json');
        const args = { userRoot, peerId: 'p', directories: dirs, liveRoot: paths.workdir, enabledCategoryIds: ['worlds'] };

        fs.writeFileSync(staged, '{"v":"A"}');
        await snapshotLiveToShadow(args);
        fs.writeFileSync(staged, '{"v":"B"}');
        const second = await snapshotLiveToShadow(args);

        expect(second.committed).toBe(true);
        expect(await headBlobText(paths, 'worlds/w.json')).toBe('{"v":"B"}');
    });
});
