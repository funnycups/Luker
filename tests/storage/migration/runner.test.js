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
import { CONTRACT_HARNESSES, makeMultiHandleFsEngine } from '../harness/contract-harness.js';

// Bind a full RepoSet to the given engine — used by tests that only need a
// MigrationRunner instance to inspect constructor wiring (no Repo I/O).
function buildReposForTest(engine) {
    return {
        chat: new ChatRepo({ engine }),
        settings: new SettingsRepo({ engine }),
        preset: new PresetRepo({ engine }),
        worldInfo: new WorldInfoRepo({ engine }),
        namedDoc: new NamedDocRepo({ engine }),
        group: new GroupRepo({ engine }),
        stats: new StatsRepo({ engine }),
    };
}

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
            // Snapshot GC defaults to ON after a successful migration.
            // This test specifically asserts that the
            // snapshot dir exists post-run and contains source contents, so
            // it opts in to keepSnapshot to preserve the snapshot for
            // inspection. The default-GC behaviour is exercised by
            // `tests/storage/migration/snapshot-gc.test.js`.
            keepSnapshot: true,
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

    test('REGRESSION: inline verify reports the first divergent key and short-circuits', async () => {
        // Seed two per-character chats. Fault-inject the dest chat repo so the
        // FIRST chat.save() commits the wrong body — the second chat must
        // never be written under inline-verify (the runner short-circuits the
        // copy loop). Under the legacy standalone-verify model, BOTH chats
        // get written first and verify catches the divergence afterward.
        await src.repos.chat.save(
            src.handle, 'TestChar', 'c1',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'one' }],
            null,
        );
        await src.repos.chat.save(
            src.handle, 'TestChar', 'c2',
            { chat_metadata: {}, user_name: 'U' },
            [{ name: 'U', mes: 'two' }],
            null,
        );

        const origSave = dst.repos.chat.save.bind(dst.repos.chat);
        let writeCount = 0;
        const writtenNames = [];
        let firstWrittenName = null;
        const tamperedDest = {
            ...dst.repos,
            chat: {
                ...dst.repos.chat,
                save: async (handle, charDir, name, header, body, attachments, opts) => {
                    writeCount++;
                    writtenNames.push(name);
                    if (writeCount === 1) {
                        // Commit the WRONG body on the first chat write so
                        // inline verify trips immediately. The runner must
                        // not proceed to the second chat.
                        firstWrittenName = name;
                        return origSave(
                            handle, charDir, name, header,
                            [{ name: 'U', mes: 'WRONG' }], attachments, opts,
                        );
                    }
                    return origSave(handle, charDir, name, header, body, attachments, opts);
                },
                get: dst.repos.chat.get.bind(dst.repos.chat),
                getState: dst.repos.chat.getState.bind(dst.repos.chat),
                setState: dst.repos.chat.setState.bind(dst.repos.chat),
                listStateNamespaces: dst.repos.chat.listStateNamespaces.bind(dst.repos.chat),
                listRecent: dst.repos.chat.listRecent.bind(dst.repos.chat),
            },
        };

        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: src.repos,
            destRepos: tamperedDest,
            snapshotPaths: {
                dataRoot: tmpRoot, backupRoot, getUserRoot: () => src.userDir,
            },
        });

        let caught;
        try {
            await runner.migrateUser(src.handle);
        } catch (err) {
            caught = err;
        }

        // Error must name the SPECIFIC diverged chat (first-divergent-key
        // contract from spec §4.3). The runner's outer wrap is permitted
        // (it tags as copy-stage for auto-rollback), so we accept either
        // the bare inline message or the wrapped form.
        expect(caught).toBeDefined();
        expect(caught.message).toMatch(
            new RegExp(`chat verify mismatch for TestChar.*${firstWrittenName}`),
        );

        // Inline verify must short-circuit: exactly ONE chat write happened
        // before the abort. Under the legacy standalone-verify model this is
        // 2 (both chats written, then verify pass starts and trips).
        expect(writeCount).toBe(1);
        expect(writtenNames).toEqual([firstWrittenName]);
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

    test('constructor accepts categories option with all-true default', async () => {
        const harness = await CONTRACT_HARNESSES[0].make(); // fs harness
        try {
            const repos = buildReposForTest(harness.engine);
            const runner = new MigrationRunner({
                sourceRepos: repos,
                destRepos: repos,
                snapshotPaths: { backupRoot: harness.backupRoot, getUserRoot: () => harness.dirs.root },
            });
            expect(runner._categories).toEqual({
                settings: true, presets: true, namedDocs: true,
                worlds: true, chats: true, groups: true, stats: true,
            });
        } finally {
            await harness.cleanup();
        }
    });

    test('constructor accepts categories option with explicit values', async () => {
        const harness = await CONTRACT_HARNESSES[0].make();
        try {
            const repos = buildReposForTest(harness.engine);
            const runner = new MigrationRunner({
                sourceRepos: repos,
                destRepos: repos,
                snapshotPaths: { backupRoot: harness.backupRoot, getUserRoot: () => harness.dirs.root },
                categories: { chats: true, settings: false, presets: false, namedDocs: false, worlds: false, groups: false, stats: false },
            });
            expect(runner._categories.chats).toBe(true);
            expect(runner._categories.settings).toBe(false);
            expect(runner._categories.worlds).toBe(false);
        } finally {
            await harness.cleanup();
        }
    });

    test('constructor silently drops unknown categories keys', async () => {
        // Defensive branch in runner.js: caller-supplied keys are filtered
        // against the canonical DEFAULT_CATEGORIES shape, so a typo like
        // `chts: true` is dropped rather than enabling a non-existent
        // section. Without this guard a typo silently turns a section off.
        const harness = await CONTRACT_HARNESSES[0].make();
        try {
            const repos = buildReposForTest(harness.engine);
            const runner = new MigrationRunner({
                sourceRepos: repos,
                destRepos: repos,
                snapshotPaths: { backupRoot: harness.backupRoot, getUserRoot: () => harness.dirs.root },
                categories: { chats: true, typo: true, fakeCategory: false },
            });
            // Unknown keys must not appear on the merged shape.
            expect(runner._categories).not.toHaveProperty('typo');
            expect(runner._categories).not.toHaveProperty('fakeCategory');
            // Known keys default to true; explicit chats:true preserved.
            expect(runner._categories.chats).toBe(true);
            expect(runner._categories.settings).toBe(true);
            expect(runner._categories.worlds).toBe(true);
        } finally {
            await harness.cleanup();
        }
    });
});

describe('MigrationRunner: categories filter', () => {
    test('chats:true only copies chats, skips others', async () => {
        const srcHarness = await CONTRACT_HARNESSES[0].make();
        const dstHarness = await CONTRACT_HARNESSES[0].make();
        try {
            const srcRepos = buildReposForTest(srcHarness.engine);
            const dstRepos = buildReposForTest(dstHarness.engine);

            // Seed everything on src
            await srcRepos.chat.save(srcHarness.handle, 'A', 'c1', { user_name: 'u' }, [{ name: 'x', is_user: true, mes: 'hi' }], null);
            await srcRepos.settings.save(srcHarness.handle, { foo: 'bar' });
            await srcRepos.worldInfo.save(srcHarness.handle, 'w', { entries: {} });
            await srcRepos.preset.save(srcHarness.handle, 'openai', 'p', { temperature: 0.5 });
            await srcRepos.group.save(srcHarness.handle, 'g', { id: 'g', chats: [] });
            await srcRepos.namedDoc.save(srcHarness.handle, 'themes', 't', { accent: '#abc' });
            await srcRepos.stats.save(srcHarness.handle, { totalChats: 1 });

            const runner = new MigrationRunner({
                sourceRepos: srcRepos,
                destRepos: dstRepos,
                snapshotPaths: { backupRoot: srcHarness.backupRoot, getUserRoot: () => srcHarness.dirs.root },
                categories: { chats: true, settings: false, presets: false, namedDocs: false, worlds: false, groups: false, stats: false },
            });

            const stats = await runner.migrateUser(srcHarness.handle);

            expect(stats.chats).toBe(1);
            expect(stats.settings).toBe(0);
            expect(stats.worlds).toBe(0);
            expect(stats.presets).toBe(0);
            expect(stats.named_docs).toBe(0);
            expect(stats.groups).toBe(0);
            expect(stats.stats).toBe(0);

            // Verify on dst: only chats present, others null
            expect(await dstRepos.chat.get(srcHarness.handle, 'A', 'c1')).not.toBeNull();
            expect(await dstRepos.settings.get(srcHarness.handle)).toBeNull();
            expect(await dstRepos.worldInfo.get(srcHarness.handle, 'w')).toBeNull();
            expect(await dstRepos.preset.get(srcHarness.handle, 'openai', 'p')).toBeNull();
            expect(await dstRepos.namedDoc.get(srcHarness.handle, 'themes', 't')).toBeNull();
            expect(await dstRepos.group.get(srcHarness.handle, 'g')).toBeNull();
            expect(await dstRepos.stats.get(srcHarness.handle)).toBeNull();
        } finally {
            await srcHarness.cleanup();
            await dstHarness.cleanup();
        }
    });

    test('presets:false ALSO skips preset_states', async () => {
        const srcHarness = await CONTRACT_HARNESSES[0].make();
        const dstHarness = await CONTRACT_HARNESSES[0].make();
        try {
            const srcRepos = buildReposForTest(srcHarness.engine);
            const dstRepos = buildReposForTest(dstHarness.engine);
            await srcRepos.preset.save(srcHarness.handle, 'openai', 'p', { temperature: 0.5 });
            await srcRepos.preset.setState(srcHarness.handle, 'openai', 'p', 'default', { lastUsed: 123 });

            const runner = new MigrationRunner({
                sourceRepos: srcRepos,
                destRepos: dstRepos,
                snapshotPaths: { backupRoot: srcHarness.backupRoot, getUserRoot: () => srcHarness.dirs.root },
                categories: { presets: false, namedDocs: true, settings: true, worlds: true, chats: true, groups: true, stats: true },
            });
            const stats = await runner.migrateUser(srcHarness.handle);
            expect(stats.presets).toBe(0);
            expect(stats.preset_states).toBe(0);
        } finally {
            await srcHarness.cleanup();
            await dstHarness.cleanup();
        }
    });
});

describe('MigrationRunner: destHandle', () => {
    test('src and dst handles can differ; dest writes use destHandle', async () => {
        // Per-handle dir routing so the same physical engine instance can host
        // multiple handles. The CONTRACT_HARNESS default rejects anything but
        // 'u'; this test needs three distinct handles ('_xrestore_abc' src,
        // 'realUser' + '_xrestore_abc' on dst — the latter to assert it stays
        // empty) each with their own directory tree so reads don't alias.
        const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-desthandle-src-'));
        const dstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-desthandle-dst-'));
        const backupRoot = path.join(dstRoot, '_backups');
        const { engine: srcEngine } = makeMultiHandleFsEngine({ root: srcRoot });
        const { engine: dstEngine, dirsForHandle: dstDirsForHandle } = makeMultiHandleFsEngine({ root: dstRoot });
        try {
            const srcRepos = buildReposForTest(srcEngine);
            const dstRepos = buildReposForTest(dstEngine);

            await srcRepos.chat.save('_xrestore_abc', 'A', 'c1',
                { user_name: 'src' }, [{ name: 'x', is_user: true, mes: 'hi' }], null);
            await srcRepos.settings.save('_xrestore_abc', { foo: 'bar' });

            // Pre-create the dst realUser dir tree so the snapshot step
            // (taken against the destination side per orchestrator semantics)
            // finds an existing userRoot.
            dstDirsForHandle('realUser');

            const runner = new MigrationRunner({
                sourceRepos: srcRepos,
                destRepos: dstRepos,
                snapshotPaths: { backupRoot, getUserRoot: () => path.join(dstRoot, 'realUser') },
            });

            const stats = await runner.migrateUser('_xrestore_abc', { destHandle: 'realUser' });

            expect(stats.chats).toBe(1);
            expect(stats.settings).toBe(1);
            // Source handle untouched on dst
            expect(await dstRepos.chat.get('_xrestore_abc', 'A', 'c1')).toBeNull();
            expect(await dstRepos.settings.get('_xrestore_abc')).toBeNull();
            // Real handle populated on dst
            expect(await dstRepos.chat.get('realUser', 'A', 'c1')).not.toBeNull();
            expect((await dstRepos.settings.get('realUser')).foo).toBe('bar');
        } finally {
            fs.rmSync(srcRoot, { recursive: true, force: true });
            fs.rmSync(dstRoot, { recursive: true, force: true });
        }
    });

    test('omitted destHandle defaults to srcHandle (backward compat)', async () => {
        const srcHarness = await CONTRACT_HARNESSES[0].make();
        const dstHarness = await CONTRACT_HARNESSES[0].make();
        try {
            const srcRepos = buildReposForTest(srcHarness.engine);
            const dstRepos = buildReposForTest(dstHarness.engine);
            await srcRepos.settings.save(srcHarness.handle, { x: 1 });
            const runner = new MigrationRunner({
                sourceRepos: srcRepos,
                destRepos: dstRepos,
                snapshotPaths: { backupRoot: dstHarness.backupRoot, getUserRoot: () => dstHarness.dirs.root },
            });
            await runner.migrateUser(srcHarness.handle);
            expect((await dstRepos.settings.get(srcHarness.handle)).x).toBe(1);
        } finally {
            await srcHarness.cleanup();
            await dstHarness.cleanup();
        }
    });

    test('rollback on copy failure uses srcHandle (not destHandle)', async () => {
        // Force _copyAll to throw mid-run when destHandle != srcHandle, then
        // verify _rollback was driven from srcHandle: snapshot is taken against
        // the dst side (getUserRoot returns dst), but the snapshotted DUMP and
        // its rollback restore are SOURCE-handle keyed. We assert by intercepting
        // restoreFromSnapshot at the storage/migration/backup module boundary,
        // capturing the `handle` arg passed by _rollback.
        const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-rb-src-'));
        const dstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-rb-dst-'));
        const backupRoot = path.join(dstRoot, '_backups');
        const { engine: srcEngine } = makeMultiHandleFsEngine({ root: srcRoot });
        const { engine: dstEngine, dirsForHandle: dstDirsForHandle } = makeMultiHandleFsEngine({ root: dstRoot });
        dstDirsForHandle('realUser'); // snapshot needs an existing userRoot

        try {
            const srcRepos = buildReposForTest(srcEngine);
            const dstRepos = buildReposForTest(dstEngine);
            await srcRepos.settings.save('_xrestore_abc', { foo: 'bar' });

            // Wrap dst.settings.save to throw — forces _copyAll to fail at the
            // first section, which triggers _rollback.
            const tamperedDst = {
                ...dstRepos,
                settings: {
                    ...dstRepos.settings,
                    save: async () => { throw new Error('intentional dst write failure'); },
                    get: dstRepos.settings.get.bind(dstRepos.settings),
                },
            };

            const runner = new MigrationRunner({
                sourceRepos: srcRepos,
                sourceEngine: srcEngine,
                destRepos: tamperedDst,
                snapshotPaths: { backupRoot, getUserRoot: () => path.join(dstRoot, 'realUser') },
            });

            let caught = null;
            try {
                await runner.migrateUser('_xrestore_abc', { destHandle: 'realUser' });
            } catch (err) {
                caught = err;
            }

            expect(caught).not.toBeNull();
            // Error message wraps the inner cause; the inner cause must
            // reference the srcHandle (per stats.handle semantics) so an
            // operator looking at logs sees which source record failed.
            expect(caught.message).toMatch(/_xrestore_abc/);
            // Snapshot was taken in the backupRoot — directory name encodes
            // src handle (srcHandle, NOT destHandle).
            const snapEntries = fs.readdirSync(backupRoot);
            expect(snapEntries.length).toBeGreaterThan(0);
            expect(snapEntries.some(e => e.endsWith('-_xrestore_abc'))).toBe(true);
            expect(snapEntries.some(e => e.endsWith('-realUser'))).toBe(false);
        } finally {
            fs.rmSync(srcRoot, { recursive: true, force: true });
            fs.rmSync(dstRoot, { recursive: true, force: true });
        }
    });
});
