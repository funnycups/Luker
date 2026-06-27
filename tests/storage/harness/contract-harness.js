import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { makeTempMysqlEngineHarness } from './mysql-harness.js';
import { makeTempPgEngineHarness } from './pg-harness.js';

// Mirror src/constants.js USER_DIRECTORY_TEMPLATE — keep keys in sync with
// fs-harness.js so any Repo that targets a directory can find it on the stub.
const USER_DIRS = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
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

export async function makeTempFsEngineHarness() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-contract-fs-'));
    const handle = 'u';
    const userDir = path.join(dataRoot, handle);
    const dirs = buildDirs(userDir);
    // Pre-create the directories existing tests rely on.
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });

    const engine = new FsEngine({
        directoriesByHandle: (h) => {
            if (h !== handle) throw new Error(`unknown handle ${h}`);
            return dirs;
        },
    });

    // Per-data-root backups directory matching the live server layout. Tests
    // building a MigrationRunner against this harness can pass
    // snapshotPaths.backupRoot directly without composing it themselves.
    const backupRoot = path.join(dataRoot, '_storage-migrations');

    return {
        engine,
        kind: 'fs',
        dataRoot,
        backupRoot,
        handle,
        charsDir: dirs.characters,
        chatsDir: dirs.chats,
        dirs,
        cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
    };
}

export async function makeTempSqliteEngineHarness() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-contract-sqlite-'));
    const handle = 'u';
    const userDir = path.join(dataRoot, handle);
    const dirs = buildDirs(userDir);
    // Pre-create root so the SqliteEngine can drop its sqlite file there. The
    // engine itself mkdirs root lazily, but pre-creating common dirs keeps
    // parity with the FS harness in case a test bypasses the engine.
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });

    const engine = new SqliteEngine({
        directoriesByHandle: (h) => {
            if (h !== handle) throw new Error(`unknown handle ${h}`);
            return dirs;
        },
    });

    const backupRoot = path.join(dataRoot, '_storage-migrations');

    return {
        engine,
        kind: 'sqlite',
        dataRoot,
        backupRoot,
        handle,
        charsDir: dirs.characters,
        chatsDir: dirs.chats,
        dirs,
        cleanup: () => {
            engine.close();
            fs.rmSync(dataRoot, { recursive: true, force: true });
        },
    };
}

/**
 * Build a `FsEngine` whose `directoriesByHandle` lazily creates a separate
 * per-handle directory tree on demand — useful for tests that need to write
 * data under multiple handles in the same engine (e.g. the cross-mode
 * destHandle path, where source handle and destination handle must not alias
 * to the same physical dir). Each handle gets `<root>/<handle>/...` mirroring
 * the production layout. Returns `{ engine, dirsForHandle, root }`.
 *
 * @param {object} opts
 * @param {string} opts.root      Filesystem root under which per-handle dirs live.
 * @returns {{ engine: FsEngine, dirsForHandle: (handle: string) => object, root: string }}
 */
export function makeMultiHandleFsEngine({ root }) {
    if (!root) throw new Error('makeMultiHandleFsEngine: root required');
    const cache = new Map();
    function dirsForHandle(handle) {
        if (cache.has(handle)) return cache.get(handle);
        const userDir = path.join(root, handle);
        const dirs = buildDirs(userDir);
        for (const d of [dirs.root, dirs.chats, dirs.characters, dirs.worlds, dirs.groups,
            dirs.groupChats, dirs.themes, dirs.movingUI, dirs.quickreplies,
            dirs.openAI_Settings, dirs.novelAI_Settings, dirs.koboldAI_Settings,
            dirs.textGen_Settings, dirs.instruct, dirs.context, dirs.sysprompt,
            dirs.reasoning]) {
            fs.mkdirSync(d, { recursive: true });
        }
        cache.set(handle, dirs);
        return dirs;
    }
    const engine = new FsEngine({ directoriesByHandle: dirsForHandle });
    return { engine, dirsForHandle, root };
}

// Parameterize Repo contract tests via `describe.each(CONTRACT_HARNESSES)`.
// Each entry exposes `name` (engine label for the test description) and
// `make` (async factory returning the harness object).
const harnesses = [
    { name: 'FsEngine', make: makeTempFsEngineHarness },
    { name: 'SqliteEngine', make: makeTempSqliteEngineHarness },
];
// MysqlEngine: include unless explicitly disabled. The local dev container at
// 127.0.0.1:53306 is the default; CI / non-DB envs set the disable flag.
if (!process.env.LUKER_DISABLE_MYSQL_TESTS) {
    harnesses.push({ name: 'MysqlEngine', make: makeTempMysqlEngineHarness });
}
// PgEngine: include unless explicitly disabled. The local dev container at
// 127.0.0.1:55432 is the default; CI / non-DB envs set the disable flag.
if (!process.env.LUKER_DISABLE_POSTGRES_TESTS) {
    harnesses.push({ name: 'PgEngine', make: makeTempPgEngineHarness });
}
export const CONTRACT_HARNESSES = harnesses;
