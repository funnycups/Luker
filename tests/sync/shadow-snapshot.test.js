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

describe('snapshotLiveToShadow', () => {
    let userRoot, liveRoot;

    beforeEach(() => {
        userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-snap-shadow-'));
        liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-snap-live-'));
        for (const sub of ['characters', 'chats', 'worlds', 'groups', 'group chats']) {
            fs.mkdirSync(path.join(liveRoot, sub), { recursive: true });
        }
    });
    afterEach(() => {
        fs.rmSync(userRoot, { recursive: true, force: true });
        fs.rmSync(liveRoot, { recursive: true, force: true });
    });

    test('copies enabled categories into the workdir and produces a commit', async () => {
        fs.writeFileSync(path.join(liveRoot, 'characters', 'char_001.png'), Buffer.from('\x89PNGfake'));
        fs.mkdirSync(path.join(liveRoot, 'chats', 'char_001'), { recursive: true });
        fs.writeFileSync(path.join(liveRoot, 'chats', 'char_001', 'chat_0.jsonl'), '{"name":"u","mes":"hi"}');

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        const result = await snapshotLiveToShadow({
            userRoot,
            peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters', 'chats'],
        });

        expect(result.committed).toBe(true);
        expect(fs.existsSync(path.join(paths.workdir, 'characters/char_001.png'))).toBe(true);
        expect(fs.existsSync(path.join(paths.workdir, 'chats/char_001/chat_0.jsonl'))).toBe(true);

        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const files = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(files.sort()).toEqual(['characters/char_001.png', 'chats/char_001/chat_0.jsonl']);
    });

    test('omits files in non-enabled categories', async () => {
        fs.writeFileSync(path.join(liveRoot, 'characters', 'char.png'), 'x');
        fs.writeFileSync(path.join(liveRoot, 'worlds', 'lore.json'), '{}');

        await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters'],
        });

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        expect(fs.existsSync(path.join(paths.workdir, 'characters/char.png'))).toBe(true);
        expect(fs.existsSync(path.join(paths.workdir, 'worlds/lore.json'))).toBe(false);
    });

    test('deletes shadow files that disappeared from live', async () => {
        fs.writeFileSync(path.join(liveRoot, 'characters', 'will_delete.png'), 'a');
        await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters'],
        });

        fs.unlinkSync(path.join(liveRoot, 'characters', 'will_delete.png'));
        const second = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters'],
        });

        expect(second.committed).toBe(true);
        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        expect(fs.existsSync(path.join(paths.workdir, 'characters/will_delete.png'))).toBe(false);
    });

    test('returns committed:false when nothing changed (idempotent snapshot)', async () => {
        fs.writeFileSync(path.join(liveRoot, 'characters', 'char.png'), 'static');
        await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters'],
        });
        const second = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters'],
        });
        expect(second.committed).toBe(false);
    });

    test('survives unicode filenames and deeply nested chats', async () => {
        const charDir = path.join(liveRoot, 'chats', '双子');
        fs.mkdirSync(charDir, { recursive: true });
        fs.writeFileSync(path.join(charDir, '对话_1.jsonl'), '{}');

        const result = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['chats'],
        });
        expect(result.committed).toBe(true);

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const files = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(files).toContain('chats/双子/对话_1.jsonl');
    });

    test('ignores nested .git directories in card-apps (spec §6.4)', async () => {
        // card-apps has its own git repos per character; snapshot must not recurse into them.
        fs.mkdirSync(path.join(liveRoot, 'card-apps', 'demo', '.git'), { recursive: true });
        fs.writeFileSync(path.join(liveRoot, 'card-apps', 'demo', '.git', 'HEAD'), 'ref: refs/heads/main');
        fs.writeFileSync(path.join(liveRoot, 'card-apps', 'demo', 'index.js'), '// app');

        await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['card-apps'],
        });

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        expect(fs.existsSync(path.join(paths.workdir, 'card-apps/demo/index.js'))).toBe(true);
        expect(fs.existsSync(path.join(paths.workdir, 'card-apps/demo/.git'))).toBe(false);
    });

    test('handles file-kind category paths (settings.json at root)', async () => {
        // The 'settings' category resolves a file-kind SyncPath (rootFile('settings.json'))
        // rather than a directory-kind one — exercised here so the file branch of
        // snapshotLiveToShadow's category loop is covered end-to-end.
        fs.writeFileSync(path.join(liveRoot, 'settings.json'), '{"theme":"dark"}');

        const result = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['settings'],
        });
        expect(result.committed).toBe(true);

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        expect(fs.existsSync(path.join(paths.workdir, 'settings.json'))).toBe(true);
        expect(fs.readFileSync(path.join(paths.workdir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');

        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const files = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(files).toContain('settings.json');
    });

    test('skips symlinks in the live tree (spec §4.3)', async () => {
        // Spec §4.3: symlinks are not part of supported user data. The walker
        // warns and skips them; both the staged index AND the workdir must be
        // free of any symlink to avoid index↔workdir drift on later snapshots.
        fs.writeFileSync(path.join(liveRoot, 'characters', 'real.png'), 'realbytes');

        let symlinkCreated = false;
        try {
            fs.symlinkSync(
                path.join(liveRoot, 'characters', 'real.png'),
                path.join(liveRoot, 'characters', 'alias.png'),
            );
            symlinkCreated = true;
        } catch (err) {
            // Windows without developer mode (and a few hardened sandboxes) reject
            // symlink creation with EPERM/EACCES — the rest of the assertion
            // would be vacuous there, so degrade gracefully.
            if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
                expect(true).toBe(true);
                return;
            }
            throw err;
        }
        expect(symlinkCreated).toBe(true);

        const result = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters'],
        });
        expect(result.committed).toBe(true);

        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        // Workdir must contain the real file but not the alias (lstat-aware).
        expect(fs.existsSync(path.join(paths.workdir, 'characters/real.png'))).toBe(true);
        const workdirAliasLstat = (() => {
            try { return fs.lstatSync(path.join(paths.workdir, 'characters/alias.png')); }
            catch { return null; }
        })();
        expect(workdirAliasLstat).toBeNull();

        // Committed tree must not list the alias as a tracked entry.
        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const files = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(files).toEqual(['characters/real.png']);
    });
});
