import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { getShadowPaths, ensureShadowRepo, snapshotLiveToShadow } from '../../src/sync/shadow.js';

describe('shadow repo paths and init', () => {
    let userRoot;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-shadow-'));
    });
    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
    });

    test('getShadowPaths derives consistent, peer-scoped paths under userRoot/.sync', () => {
        const p = getShadowPaths({ userRoot, peerId: 'alice@phone' });
        expect(p.syncRoot).toBe(path.join(userRoot, '.sync'));
        expect(p.peerDir).toBe(path.join(userRoot, '.sync', 'alice@phone'));
        expect(p.gitDir).toBe(path.join(userRoot, '.sync', 'alice@phone', 'repo.git'));
        expect(p.workdir).toBe(path.join(userRoot, '.sync', 'alice@phone', 'workdir'));
        expect(p.statePath).toBe(path.join(userRoot, '.sync', 'state.json'));
    });

    test('getShadowPaths rejects peerId values that would escape the .sync dir', () => {
        expect(() => getShadowPaths({ userRoot, peerId: '..' })).toThrow();
        expect(() => getShadowPaths({ userRoot, peerId: '.' })).toThrow();
        expect(() => getShadowPaths({ userRoot, peerId: '...' })).toThrow();
        expect(() => getShadowPaths({ userRoot, peerId: 'a/b' })).toThrow();
        expect(() => getShadowPaths({ userRoot, peerId: '' })).toThrow();
        expect(() => getShadowPaths({ userRoot, peerId: null })).toThrow();
    });

    test('ensureShadowRepo creates a workable git repo on first call and is idempotent', async () => {
        const p = await ensureShadowRepo({ userRoot, peerId: 'alice@phone' });
        expect(fs.existsSync(p.gitDir)).toBe(true);
        expect(fs.existsSync(p.workdir)).toBe(true);

        // The workdir must be a usable git working tree.
        await git.statusMatrix({ fs, dir: p.workdir, gitdir: p.gitDir });

        // Mutate a config value the helper would overwrite if it re-ran git.init/setConfig.
        await git.setConfig({ fs, dir: p.workdir, gitdir: p.gitDir, path: 'user.name', value: 'SENTINEL' });

        // Second call must be a no-op for git state.
        await ensureShadowRepo({ userRoot, peerId: 'alice@phone' });

        const userName = await git.getConfig({ fs, dir: p.workdir, gitdir: p.gitDir, path: 'user.name' });
        expect(userName).toBe('SENTINEL');
    });

    test.each(['workdir', 'gitDir', '.sync'])('shadow initialization refuses a legacy %s symlink before writing', async name => {
        const outside = path.join(userRoot, 'outside');
        fs.mkdirSync(outside);
        const paths = getShadowPaths({ userRoot, peerId: 'p' });
        const target = name === '.sync' ? path.join(userRoot, '.sync') : paths[name];
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(outside, target);
        await expect(ensureShadowRepo({ userRoot, peerId: 'p' })).rejects.toMatchObject({ code: 'UNSAFE_WORKDIR_PATH' });
        await expect(snapshotLiveToShadow({ userRoot, peerId: 'p', directories: { root: userRoot }, enabledCategoryIds: [], deviceLabel: 'Must not commit' })).rejects.toMatchObject({ code: 'UNSAFE_WORKDIR_PATH' });
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(fs.existsSync(path.join(paths.gitDir, 'objects'))).toBe(false);
    });
});
