import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MigrationRunner } from '../../../src/storage/migration/runner.js';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../../src/storage/repositories/stats-repo.js';
import { setReadOnly } from '../../../src/storage/read-only-mode.js';

// Same USER_DIRS / buildHarness shape as runner.test.js. Kept local instead of
// imported to avoid coupling unrelated tests through a shared helper module.
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

function buildHarness(kind, dataRoot, handle = 'u') {
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
    const engine = kind === 'fs'
        ? new FsEngine({ directoriesByHandle })
        : new SqliteEngine({ directoriesByHandle });
    return {
        kind, handle, userDir, dirs, engine,
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

// Walk a directory and return a sorted list of [relPath, kind, contentSha] so
// two trees can be compared structurally + by content without depending on
// file mtime / inode order. Used to prove rollback restored the source byte-
// for-byte, not just "directory listing matches".
function snapshotTree(root) {
    const entries = [];
    function walk(currentAbs, currentRel) {
        const items = fs.readdirSync(currentAbs, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const item of items) {
            const abs = path.join(currentAbs, item.name);
            const rel = currentRel ? `${currentRel}/${item.name}` : item.name;
            if (item.isDirectory()) {
                entries.push([rel, 'dir', '']);
                walk(abs, rel);
            } else if (item.isFile()) {
                const data = fs.readFileSync(abs);
                entries.push([rel, 'file', data.toString('base64')]);
            }
        }
    }
    walk(root, '');
    return entries;
}

describe('MigrationRunner: auto-rollback on copy failure', () => {
    let tmpRoot, src, dst;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-runner-rollback-'));
        src = buildHarness('fs', path.join(tmpRoot, 'src'));
        dst = buildHarness('fs', path.join(tmpRoot, 'dst'));
    });

    afterEach(() => {
        setReadOnly(false);
        src.cleanup();
        dst.cleanup();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('REGRESSION: auto-rollback restores user dir after copy failure', async () => {
        // ---- seed source with a representative mix ----
        await src.repos.settings.save(src.handle, { user_avatar: 'a.png', flag: true });
        await src.repos.preset.save(src.handle, 'openai', 'GPT', { temperature: 0.7 });
        await src.repos.worldInfo.save(src.handle, 'MyWorld', { entries: { '0': { content: 'hi' } } });
        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat1',
            { chat_metadata: { foo: 'bar' }, user_name: 'U' },
            [{ name: 'U', mes: 'hi', is_user: true }],
            null,
        );

        // Capture the source user-dir as it stands right before migration.
        // After rollback this tree (content + structure) must match exactly.
        const preState = snapshotTree(src.dirs.root);
        expect(preState.length).toBeGreaterThan(0);  // sanity: we did seed something

        // Fault-injection: after one successful destination chat write, the
        // SECOND chat write throws — and as a side effect mutates the SOURCE
        // user dir to simulate the in-place upgrade case the rollback exists
        // for. Without restoreFromSnapshot, the source tree stays mutated and
        // the post-failure tree comparison diverges from preState.
        //
        // NOTE: the migration runner writes chats via saveRaw() (not save())
        // so source integrity/createdAt/updatedAt round-trip. Fault-injecting
        // on save() would never fire during migration.
        const origSaveRaw = dst.repos.chat.saveRaw.bind(dst.repos.chat);
        let saveCount = 0;
        dst.repos.chat.saveRaw = async (...args) => {
            saveCount++;
            if (saveCount === 1) return origSaveRaw(...args);  // let one succeed first
            // Wreck the source dir before throwing, to model a partial in-place
            // migration that needs rollback to recover.
            fs.writeFileSync(path.join(src.dirs.root, 'settings.json'), '{"corrupted":true}');
            fs.rmSync(path.join(src.dirs.chats, 'TestChar'), { recursive: true, force: true });
            throw new Error('Synthetic copy failure');
        };

        // Seed a second chat so the runner makes >1 chat.save() call.
        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat2',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'two' }],
            null,
        );
        // Re-baseline preState now that chat2 is on disk (it was missing above).
        const preStateAfterSeed = snapshotTree(src.dirs.root);

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

        // 1. The snapshot itself must exist on disk for forensic inspection.
        expect(fs.existsSync(backupRoot)).toBe(true);
        const backupEntries = fs.readdirSync(backupRoot);
        expect(backupEntries.length).toBeGreaterThan(0);
        const backupPath = path.join(backupRoot, backupEntries[0]);
        expect(fs.existsSync(path.join(backupPath, 'settings.json'))).toBe(true);

        // 2. The source user dir was restored from the snapshot byte-for-byte.
        //    Without rollback this assertion fails because the fault-injection
        //    wrote {"corrupted":true} and rm-rf'd chats/TestChar.
        const postState = snapshotTree(src.dirs.root);
        expect(postState).toEqual(preStateAfterSeed);

        // 3. Reading back through the repo confirms the data round-trips.
        const restoredSettings = await src.repos.settings.get(src.handle);
        expect(restoredSettings).toEqual({ user_avatar: 'a.png', flag: true });
        const restoredChat = await src.repos.chat.get(src.handle, 'TestChar', 'chat1');
        expect(restoredChat).not.toBeNull();
        expect(restoredChat.body).toEqual([{ name: 'U', mes: 'hi', is_user: true }]);
    });

    test('rollback re-creates userRoot even if the failure already removed it', async () => {
        // Edge case: a partial in-place migration could rm-rf the user dir as
        // part of switching engines, then fail before the new dir is built.
        // restoreFromSnapshot must handle a missing userRoot by re-creating
        // it from the backup — by contract this path is idempotent.
        await src.repos.settings.save(src.handle, { user_avatar: 'a.png' });
        const preState = snapshotTree(src.dirs.root);

        const origSave = dst.repos.settings.save.bind(dst.repos.settings);
        dst.repos.settings.save = async (...args) => {
            await origSave(...args);
            // After the dest write, nuke the source dir entirely. Then throw
            // a synthetic verify-style failure.
            fs.rmSync(src.dirs.root, { recursive: true, force: true });
            throw new Error('Synthetic post-write failure');
        };

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });

        await expect(runner.migrateUser(src.handle)).rejects.toThrow(/Synthetic post-write failure/);

        // Source dir was deleted by the fault, then rebuilt by rollback.
        expect(fs.existsSync(src.dirs.root)).toBe(true);
        const postState = snapshotTree(src.dirs.root);
        expect(postState).toEqual(preState);
    });
});
