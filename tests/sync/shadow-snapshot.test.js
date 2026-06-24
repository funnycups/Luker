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

    test('default liveRoot equals directories.root (signature default preserves fs-mode behavior)', async () => {
        // Locks the new signature's default: omitting liveRoot must walk and
        // produce the same desired-set as before its introduction. Sanity-pin
        // for callers (sync.js endpoint, orchestrator runPullBody) that omit
        // the parameter and rely on the default.
        fs.writeFileSync(path.join(liveRoot, 'characters', 'a.png'), 'A');
        fs.mkdirSync(path.join(liveRoot, 'chats', 'c1'), { recursive: true });
        fs.writeFileSync(path.join(liveRoot, 'chats', 'c1', 'log.jsonl'), '{}');

        const result = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters', 'chats'],
            // liveRoot intentionally omitted
        });

        expect(result.committed).toBe(true);
        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const files = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(files.sort()).toEqual(['characters/a.png', 'chats/c1/log.jsonl']);
    });

    test('liveRoot can be set to an arbitrary directory (rel-path basis follows liveRoot)', async () => {
        // Prove rel-path computation pivots on liveRoot, not directories.root.
        // staging/ contains the files at the same relative layout the
        // categories resolve to; directories.root points to an unrelated tree
        // with different contents at those same paths. Pointing the resolvers
        // at staging while keeping directories.root unrelated would normally
        // produce wrong-rooted rel paths (../staging/...) and corrupt the
        // workdir layout — passing liveRoot: staging is what makes the walker
        // anchor rel paths at staging so they land cleanly under workdir.
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-sync-snap-staging-'));
        try {
            for (const sub of ['characters', 'chats', 'worlds', 'groups', 'group chats']) {
                fs.mkdirSync(path.join(staging, sub), { recursive: true });
            }
            // Distinct file contents in each tree so we can detect which one
            // the walker actually copied.
            fs.writeFileSync(path.join(liveRoot, 'characters', 'shared.png'), 'live-bytes');
            fs.writeFileSync(path.join(staging, 'characters', 'shared.png'), 'staging-bytes');
            fs.writeFileSync(path.join(staging, 'characters', 'only-in-staging.png'), 'only');

            // directories.root → liveRoot (unrelated tree), but resolvers
            // (characters/chats/…) point at staging so the walker reads from
            // staging. liveRoot: staging anchors rel paths at staging too.
            const dirs = fakeDirsAt(staging);
            dirs.root = liveRoot;

            await snapshotLiveToShadow({
                userRoot, peerId: 'p',
                directories: dirs,
                enabledCategoryIds: ['characters'],
                liveRoot: staging,
            });

            const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
            // Workdir entries must come from staging, not the unrelated live tree.
            expect(fs.readFileSync(path.join(paths.workdir, 'characters/shared.png'), 'utf8')).toBe('staging-bytes');
            expect(fs.existsSync(path.join(paths.workdir, 'characters/only-in-staging.png'))).toBe(true);
            const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
            const tracked = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
            expect(tracked.sort()).toEqual(['characters/only-in-staging.png', 'characters/shared.png']);
        } finally {
            fs.rmSync(staging, { recursive: true, force: true });
        }
    });

    test('liveRoot === workdir is a no-op copy for already-staged files (Task 4 SQL-mode flow)', async () => {
        // SQL-mode flow: the materializer writes user data INTO the shadow
        // workdir, then snapshotLiveToShadow is called with liveRoot=workdir.
        // For files already at <workdir>/<rel>, src and dst are the same
        // path and the same-path guard in syncWorkdirToDesired must skip the
        // copyFile — observable by inode/mtime stability across the call.
        // The git commit step still runs as normal so the index/HEAD advance.
        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        // Pre-place files directly inside the workdir at the layout a
        // SQL-mode materialize step would produce.
        fs.mkdirSync(path.join(paths.workdir, 'characters'), { recursive: true });
        fs.writeFileSync(path.join(paths.workdir, 'characters', 'char_a.png'), 'pre-staged');
        fs.mkdirSync(path.join(paths.workdir, 'chats', 'char_a'), { recursive: true });
        fs.writeFileSync(path.join(paths.workdir, 'chats', 'char_a', 'log.jsonl'), '{}');

        const beforeStat = fs.statSync(path.join(paths.workdir, 'characters', 'char_a.png'));

        const dirs = fakeDirsAt(paths.workdir);
        const result = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: dirs,
            enabledCategoryIds: ['characters', 'chats'],
            liveRoot: paths.workdir,
        });

        // Inode preserved → no copy happened. (On platforms where copyFile
        // preserves inode, this is still a fair signal because mtime/birth
        // would still change; copyFile generally overwrites the destination.)
        const afterStat = fs.statSync(path.join(paths.workdir, 'characters', 'char_a.png'));
        expect(afterStat.ino).toBe(beforeStat.ino);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
        expect(afterStat.size).toBe(beforeStat.size);
        expect(fs.readFileSync(path.join(paths.workdir, 'characters', 'char_a.png'), 'utf8')).toBe('pre-staged');

        // Commit step still produces a real commit (first commit on this shadow).
        expect(result.committed).toBe(true);
        expect(typeof result.oid).toBe('string');
        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const tracked = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(tracked.sort()).toEqual(['characters/char_a.png', 'chats/char_a/log.jsonl']);
    });

    test('unknown category ids in enabledCategoryIds are silently ignored', async () => {
        // After Task 5 the `database` category is gone — but the snapshot
        // walker has always filtered enabled ids against SYNC_CATEGORIES,
        // so unknown ids just drop out of the iteration. This pins that
        // contract: passing a stale id alongside a real one still produces
        // a clean snapshot of the real one, with no commit-time crash and
        // no surprise tracked entries for the stale id's would-be paths.
        fs.writeFileSync(path.join(liveRoot, 'characters', 'char.png'), 'x');
        // Place a file at the path the now-removed `database` category used
        // to resolve to. It must NOT be picked up — categories aren't
        // implicitly inferred from filenames.
        fs.writeFileSync(path.join(liveRoot, 'luker-storage.sqlite'), 'live-db-bytes');

        const result = await snapshotLiveToShadow({
            userRoot, peerId: 'p',
            directories: fakeDirsAt(liveRoot),
            enabledCategoryIds: ['characters', 'database', 'does-not-exist'],
        });

        expect(result.committed).toBe(true);
        const paths = await ensureShadowRepo({ userRoot, peerId: 'p' });
        const headOid = await git.resolveRef({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: 'HEAD' });
        const tracked = await git.listFiles({ fs, dir: paths.workdir, gitdir: paths.gitDir, ref: headOid });
        expect(tracked).toEqual(['characters/char.png']);
        expect(fs.existsSync(path.join(paths.workdir, 'luker-storage.sqlite'))).toBe(false);
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
