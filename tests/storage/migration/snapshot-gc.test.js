// Per spec §4.4 finally clause: "if success and !keepSnapshot: removeSnapshot(snapshot)".
//
// Today's `MigrationRunner.migrateUser` leaves the snapshot dir on disk forever
// (the Task 1 design intentionally deferred GC: keep the snapshot around so a
// failed migration is forensically inspectable). For routine successful
// migrations the snapshot is dead weight — admins want it gone.
//
// Contract:
//   - successful migrateUser, default opts:   snapshot is removed, stats.backupPath cleared.
//   - failed migrateUser (any post-snapshot error): snapshot is PRESERVED for forensics.
//   - successful migrateUser, keepSnapshot=true: snapshot is preserved.
//
// Modelled on tests/storage/migration/auto-rollback.test.js (same fs harness,
// same fault-injection style) — kept in this suite rather than folded into
// auto-rollback.test.js because the gc concern is orthogonal and a separate
// file is easier to grep for when the feature is referenced from the spec.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MigrationRunner } from '../../../src/storage/migration/runner.js';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../../src/storage/repositories/stats-repo.js';
import { setReadOnly } from '../../../src/storage/read-only-mode.js';

// Same USER_DIRS / buildHarness shape as auto-rollback.test.js. Kept local to
// avoid coupling unrelated tests through a shared helper module.
const USER_DIRS = Object.freeze({
    root: '',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

function buildDirs(userDir) {
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(userDir, rel);
    }
    return dirs;
}

function buildHarness(dataRoot, handle = 'u') {
    const userDir = path.join(dataRoot, handle);
    const dirs = buildDirs(userDir);
    fs.mkdirSync(dirs.root, { recursive: true });
    for (const d of [dirs.chats, dirs.characters, dirs.worlds, dirs.groups, dirs.groupChats,
                     dirs.themes, dirs.movingUI, dirs.quickreplies,
                     dirs.openAI_Settings, dirs.novelAI_Settings, dirs.koboldAI_Settings,
                     dirs.textGen_Settings, dirs.instruct, dirs.context, dirs.sysprompt,
                     dirs.reasoning]) {
        fs.mkdirSync(d, { recursive: true });
    }
    const directoriesByHandle = (h) => {
        if (h !== handle) throw new Error(`unknown handle ${h}`);
        return dirs;
    };
    const engine = new FsEngine({ directoriesByHandle });
    return {
        handle, userDir, dirs, engine,
        repos: {
            chat: new ChatRepo({ engine }),
            settings: new SettingsRepo({ engine }),
            preset: new PresetRepo({ engine }),
            worldInfo: new WorldInfoRepo({ engine }),
            namedDoc: new NamedDocRepo({ engine }),
            group: new GroupRepo({ engine }),
            stats: new StatsRepo({ engine }),
        },
        cleanup() {
            if (typeof engine.close === 'function') engine.close();
        },
    };
}

describe('MigrationRunner: snapshot GC on successful migration', () => {
    let tmpRoot, src, dst;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-runner-gc-'));
        src = buildHarness(path.join(tmpRoot, 'src'));
        dst = buildHarness(path.join(tmpRoot, 'dst'));
    });

    afterEach(() => {
        setReadOnly(false);
        src.cleanup();
        dst.cleanup();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('REGRESSION: successful migrateUser removes snapshot by default', async () => {
        // Seed source with a representative mix so there's something to copy.
        await src.repos.settings.save(src.handle, { user_avatar: 'a.png', flag: true });
        await src.repos.preset.save(src.handle, 'openai', 'GPT', { temperature: 0.7 });
        await src.repos.worldInfo.save(src.handle, 'MyWorld', { entries: { '0': { content: 'hi' } } });
        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat1',
            { chat_metadata: { foo: 'bar' }, user_name: 'U' },
            [{ name: 'U', mes: 'hi', is_user: true }],
            null,
        );

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: () => src.userDir,
            },
        });

        const stats = await runner.migrateUser(src.handle);

        // Migration itself must have succeeded — guard against a green test
        // that simply happened to throw before the snapshot was taken.
        expect(stats.errors).toEqual([]);
        expect(stats.verified).toBe(true);
        // The snapshot's path must be cleared on the stats object so callers
        // (admin endpoint, CLI) don't keep referencing a dir that no longer
        // exists.
        expect(stats.backupPath).toBeNull();
        // The backupRoot is created by snapshotUser via mkdirSync({recursive
        // true}) and removeSnapshot only deletes the per-handle child dir,
        // so the root itself remains — but it must be empty of per-handle
        // snapshots after a successful GC pass.
        expect(fs.existsSync(backupRoot)).toBe(true);
        expect(fs.readdirSync(backupRoot)).toEqual([]);
    });

    test('REGRESSION: failed migrateUser keeps snapshot for forensics', async () => {
        // Seed source then fault-inject a copy failure (matches the
        // auto-rollback.test.js fault-injection pattern: monkey-patch one
        // dst.repos method to throw mid-copy). After the failure the
        // snapshot MUST still be on disk so an operator can inspect what
        // the source looked like at the moment migration began.
        await src.repos.settings.save(src.handle, { user_avatar: 'a.png', flag: true });
        await src.repos.preset.save(src.handle, 'openai', 'GPT', { temperature: 0.7 });
        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat1',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'hi' }],
            null,
        );

        dst.repos.settings.save = async () => {
            throw new Error('Synthetic copy failure for GC test');
        };

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: () => src.userDir,
            },
        });

        await expect(runner.migrateUser(src.handle)).rejects.toThrow(/Synthetic copy failure/);

        // Snapshot dir must survive. We can't read stats.backupPath here
        // because the throw bypasses the return value, so look on disk.
        expect(fs.existsSync(backupRoot)).toBe(true);
        const backupEntries = fs.readdirSync(backupRoot);
        expect(backupEntries.length).toBeGreaterThan(0);
        // Sanity: the snapshot actually contains the seeded source state
        // (proves we're keeping the right thing, not just an empty dir).
        const backupPath = path.join(backupRoot, backupEntries[0]);
        expect(fs.existsSync(path.join(backupPath, 'settings.json'))).toBe(true);
    });

    test('REGRESSION: keepSnapshot=true preserves successful snapshots', async () => {
        await src.repos.settings.save(src.handle, { user_avatar: 'a.png' });
        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat1',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'hi' }],
            null,
        );

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: () => src.userDir,
            },
            keepSnapshot: true,
        });

        const stats = await runner.migrateUser(src.handle);

        expect(stats.errors).toEqual([]);
        expect(stats.verified).toBe(true);
        // With keepSnapshot=true the path stays set AND the dir stays on disk
        // — admin/CLI consumers can advertise the backup location to operators
        // who want to keep a pre-migration restore point around.
        expect(stats.backupPath).not.toBeNull();
        expect(typeof stats.backupPath).toBe('string');
        expect(fs.existsSync(stats.backupPath)).toBe(true);
        expect(fs.existsSync(path.join(stats.backupPath, 'settings.json'))).toBe(true);
    });
});
