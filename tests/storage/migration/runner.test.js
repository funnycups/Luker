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
import { isReadOnly, setReadOnly } from '../../../src/storage/read-only-mode.js';

// Mirror src/constants.js USER_DIRECTORY_TEMPLATE so any Repo that targets a
// directory can find it. Kept in lockstep with tests/storage/harness/contract-harness.js.
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
    // Pre-create dirs the engines / repos rely on.
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

describe('MigrationRunner: FS to SQLite', () => {
    let tmpRoot, src, dst;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-runner-fs2sq-'));
        src = buildHarness('fs', path.join(tmpRoot, 'src'));
        dst = buildHarness('sqlite', path.join(tmpRoot, 'dst'));
    });

    afterEach(() => {
        setReadOnly(false);
        src.cleanup();
        dst.cleanup();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('migrates a populated user end-to-end with verification', async () => {
        // ---- populate source ----
        await src.repos.settings.save(src.handle, { user_avatar: 'a.png', power_user: { theme: 'dark' } });

        // Two preset apiIds sharing a dirKey (kobold + koboldhorde → koboldAI_Settings)
        await src.repos.preset.save(src.handle, 'openai', 'GPT', { temperature: 0.7 });
        await src.repos.preset.save(src.handle, 'openai', 'Precise', { temperature: 0.1 });
        await src.repos.preset.save(src.handle, 'kobold', 'KoboldDefault', { something: 'k' });
        await src.repos.preset.setState(src.handle, 'openai', 'GPT', 'iter_lib', { nodes: ['a', 'b'] });
        await src.repos.preset.setState(src.handle, 'openai', 'GPT', 'agenda', { steps: [1, 2] });

        await src.repos.worldInfo.save(src.handle, 'MyWorld', { entries: { '0': { content: 'hi', key: ['x'] } } });
        await src.repos.worldInfo.save(src.handle, 'OtherWorld', { entries: { '0': { content: 'other' } } });

        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat1',
            { chat_metadata: { foo: 'bar' }, user_name: 'U' },
            [{ name: 'U', mes: 'hi', is_user: true }, { name: 'TestChar', mes: 'hello', is_user: false }],
            null,
        );
        await src.repos.chat.setState(src.handle, 'TestChar', 'chat1', 'memory-graph', { nodes: ['root'] });
        await src.repos.chat.setState(src.handle, 'TestChar', 'chat1', 'floor-state', { current: 1 });
        await src.repos.chat.save(
            src.handle, 'TestChar', 'chat2',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'two' }],
            null,
        );
        // A group + group chat
        await src.repos.group.save(src.handle, 'grp-1', {
            id: 'grp-1', name: 'My Group', members: ['a.png', 'b.png'], chats: ['gc-1'],
        });
        await src.repos.chat.save(
            src.handle, null, 'gc-1',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'g1' }],
            null,
            { isGroup: true, groupId: 'gc-1' },
        );

        await src.repos.stats.save(src.handle, {
            'TestChar.png': { user_msg_count: 1 },
            timestamp: 1700000000,
        });

        await src.repos.namedDoc.save(src.handle, 'themes', 'Dark', { bg: '#000' });
        await src.repos.namedDoc.save(src.handle, 'movingUI', 'Big', { panel: 'wide' });
        await src.repos.namedDoc.save(src.handle, 'quickReplies', 'Greet', { text: 'hi' });

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

        const result = await runner.migrateUser(src.handle);

        expect(result.verified).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.settings).toBe(1);
        expect(result.presets).toBe(3);  // 2 openai + 1 kobold
        expect(result.preset_states).toBe(2);  // both on the GPT preset
        expect(result.worlds).toBe(2);
        expect(result.chats).toBe(3);  // chat1 + chat2 + gc-1
        expect(result.chat_states).toBe(2);  // memory-graph + floor-state on chat1
        expect(result.groups).toBe(1);
        expect(result.stats).toBe(1);
        expect(result.named_docs).toBe(3);
        expect(result.backupPath).toMatch(/_storage-migrations/);

        // Backup contains source contents (sanity)
        expect(fs.existsSync(path.join(result.backupPath, 'settings.json'))).toBe(true);
        expect(fs.existsSync(path.join(result.backupPath, 'chats', 'TestChar', 'chat1.jsonl'))).toBe(true);

        // Spot-check destination reads
        expect(await dst.repos.settings.get(dst.handle)).toEqual({
            user_avatar: 'a.png', power_user: { theme: 'dark' },
        });
        expect(await dst.repos.preset.get(dst.handle, 'openai', 'GPT')).toEqual({ temperature: 0.7 });
        const dstChat1 = await dst.repos.chat.get(dst.handle, 'TestChar', 'chat1');
        expect(dstChat1.body).toEqual([
            { name: 'U', mes: 'hi', is_user: true },
            { name: 'TestChar', mes: 'hello', is_user: false },
        ]);
        expect(await dst.repos.chat.getState(dst.handle, 'TestChar', 'chat1', 'memory-graph'))
            .toEqual({ nodes: ['root'] });
        expect(await dst.repos.namedDoc.get(dst.handle, 'themes', 'Dark')).toEqual({ bg: '#000' });
    });

    test('migrates an empty user without error', async () => {
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });
        const result = await runner.migrateUser(src.handle);
        expect(result.verified).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.settings).toBe(0);
        expect(result.presets).toBe(0);
        expect(result.chats).toBe(0);
    });

    test('dry-run writes nothing to dest and skips snapshot', async () => {
        await src.repos.settings.save(src.handle, { x: 1 });
        await src.repos.chat.save(src.handle, 'C', 'c1', { chat_metadata: {} }, [{ mes: 'hi' }], null);

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
            dryRun: true,
        });
        const result = await runner.migrateUser(src.handle);

        // Stats reflect what WOULD be migrated.
        expect(result.settings).toBe(1);
        expect(result.chats).toBe(1);
        // But nothing was actually written.
        expect(result.backupPath).toBeNull();
        expect(result.verified).toBe(false);  // verification skipped on dry-run
        expect(await dst.repos.settings.get(dst.handle)).toBeNull();
        expect(await dst.repos.chat.get(dst.handle, 'C', 'c1')).toBeNull();
        // And no backup dir was created.
        expect(fs.existsSync(backupRoot)).toBe(false);
    });

    test('reports progress callbacks across each stage', async () => {
        await src.repos.settings.save(src.handle, { x: 1 });
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });
        const stages = [];
        await runner.migrateUser(src.handle, { onProgress: ({ stage }) => stages.push(stage) });
        for (const expected of [
            'snapshotted',
            'settings-copied',
            'presets-copied',
            'worlds-copied',
            'chats-copied',
            'named-docs-copied',
            'groups-copied',
            'stats-copied',
            'verifying',
            'verified',
            'done',
        ]) {
            expect(stages).toContain(expected);
        }
    });

    test('preset apiId sharing: presets under shared dirKey are only migrated once', async () => {
        // kobold and koboldhorde share koboldAI_Settings. Save via one apiId; the
        // runner must NOT count it twice (presets stat = 1, not 2).
        await src.repos.preset.save(src.handle, 'kobold', 'SharedPreset', { foo: 'bar' });
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });
        const result = await runner.migrateUser(src.handle);
        expect(result.verified).toBe(true);
        expect(result.presets).toBe(1);
    });

    test('migrateAllUsers flips READ_ONLY during migration and restores it after', async () => {
        await src.repos.settings.save(src.handle, { x: 1 });
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });

        // Capture flag state during migration via a progress hook.
        let flagDuringCopy = null;
        const results = await runner.migrateAllUsers([src.handle], {
            onProgress: ({ stage }) => {
                if (stage === 'settings-copied' && flagDuringCopy === null) {
                    flagDuringCopy = isReadOnly();
                }
            },
        });

        expect(flagDuringCopy).toBe(true);
        expect(isReadOnly()).toBe(false);
        expect(results[src.handle].verified).toBe(true);
    });

    test('migrateAllUsers per-user failure does not abort batch and is captured', async () => {
        await src.repos.settings.save(src.handle, { x: 1 });
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        let firstCall = true;
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: (h) => {
                    // Fail snapshot for handle 'badone', succeed for src.handle.
                    if (h === 'badone') return path.join(tmpRoot, 'nonexistent');
                    if (h !== src.handle) throw new Error(`unknown handle ${h}`);
                    return src.userDir;
                },
            },
        });
        const results = await runner.migrateAllUsers(['badone', src.handle]);
        expect(results.badone.error).toMatch(/does not exist|snapshot/);
        expect(results.badone.verified).toBe(false);
        expect(results[src.handle].verified).toBe(true);
        expect(isReadOnly()).toBe(false);
    });

    test('verify catches a tampered destination', async () => {
        await src.repos.settings.save(src.handle, { x: 1 });
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        // Wrap the dest settings repo so its save() writes a wrong value.
        const tamperedDest = {
            ...dst.repos,
            settings: {
                save: async (handle, _doc) => dst.repos.settings.save(handle, { x: 999 }),
                get: dst.repos.settings.get.bind(dst.repos.settings),
            },
        };
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: tamperedDest,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });
        await expect(runner.migrateUser(src.handle))
            .rejects.toThrow(/settings verify mismatch|verification failed/);
    });
});

describe('MigrationRunner: SQLite to FS (reverse direction)', () => {
    let tmpRoot, src, dst;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-runner-sq2fs-'));
        src = buildHarness('sqlite', path.join(tmpRoot, 'src'));
        dst = buildHarness('fs', path.join(tmpRoot, 'dst'));
    });

    afterEach(() => {
        setReadOnly(false);
        src.cleanup();
        dst.cleanup();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('round-trips a populated user through reverse migration', async () => {
        await src.repos.settings.save(src.handle, { x: 1, nested: { v: [1, 2, 3] } });
        await src.repos.chat.save(
            src.handle, 'Char', 'c1',
            { chat_metadata: { foo: 'bar' } },
            [{ mes: 'hi' }, { mes: 'bye' }],
            null,
        );
        await src.repos.chat.setState(src.handle, 'Char', 'c1', 'state-ns', { v: 42 });
        await src.repos.worldInfo.save(src.handle, 'W', { entries: { '0': { content: 'x' } } });

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: dst.repos,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });
        const result = await runner.migrateUser(src.handle);
        expect(result.verified).toBe(true);
        expect(result.errors).toEqual([]);
    });
});

describe('MigrationRunner: constructor validation', () => {
    test('throws when sourceRepos missing', () => {
        expect(() => new MigrationRunner({
            destRepos: {},
            snapshotPaths: { backupRoot: '/tmp', getUserRoot: () => '/tmp' },
        })).toThrow(/sourceRepos/);
    });
    test('throws when destRepos missing', () => {
        expect(() => new MigrationRunner({
            sourceRepos: {},
            snapshotPaths: { backupRoot: '/tmp', getUserRoot: () => '/tmp' },
        })).toThrow(/destRepos/);
    });
    test('throws when snapshotPaths.getUserRoot missing', () => {
        expect(() => new MigrationRunner({
            sourceRepos: {}, destRepos: {},
            snapshotPaths: { backupRoot: '/tmp' },
        })).toThrow(/getUserRoot/);
    });
    test('throws when snapshotPaths.backupRoot missing', () => {
        expect(() => new MigrationRunner({
            sourceRepos: {}, destRepos: {},
            snapshotPaths: { getUserRoot: () => '/tmp' },
        })).toThrow(/backupRoot/);
    });
});
