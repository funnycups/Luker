// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// Tests for scripts/storage-migrate.js. Two layers:
//
//   1. Argument-parser / help-output tests — spawn the script as a child node
//      process with no real config or data root. Cover the help/usage/
//      validation paths only. Run quickly because all arg validation precedes
//      bootstrap (config.yaml read, node-persist init, engine construction).
//
//   2. Read-only enforcement smoke test — import `runMigration` directly and
//      drive a real MigrationRunner across a 2-user fs↔fs tree. Asserts that
//      `setReadOnly(true)` was active for the duration of the batch (spec
//      §C item 5: the CLI must go through `migrateAllUsers`, not the per-user
//      loop, so concurrent HTTP writes to the source are blocked while the
//      copy runs). The previous CLI used a `for (handle of handles)` loop
//      calling `runner.migrateUser`, which skipped the read-only flip
//      entirely — this test pins us to the corrected path.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMigration } from '../../scripts/storage-migrate.js';
import { MigrationRunner } from '../../src/storage/migration/runner.js';
import { FsEngine } from '../../src/storage/engines/fs-engine.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { isReadOnly, setReadOnly } from '../../src/storage/read-only-mode.js';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../scripts/storage-migrate.js',
);

function runScript(args) {
    return new Promise((resolve) => {
        const child = spawn('node', [SCRIPT, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

describe('scripts/storage-migrate.js', () => {
    test('--help exits 0 with usage', async () => {
        const r = await runScript(['--help']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('storage-migrate');
        expect(r.stdout).toContain('--from');
        expect(r.stdout).toContain('--to');
    });

    test('-h short flag also prints help', async () => {
        const r = await runScript(['-h']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Usage:');
    });

    test('missing args exit non-zero with hint', async () => {
        const r = await runScript([]);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('required');
    });

    test('matching --from and --to exits non-zero', async () => {
        const r = await runScript(['--from', 'fs', '--to', 'fs']);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('must differ');
    });

    test('invalid mode value exits non-zero', async () => {
        const r = await runScript(['--from', 'invalid', '--to', 'sqlite']);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('must be one of');
    });

    test('--mysql-url and --postgres-url appear in help', async () => {
        const r = await runScript(['--help']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('--mysql-url');
        expect(r.stdout).toContain('--postgres-url');
    });

    test('unknown argument exits non-zero', async () => {
        const r = await runScript(['--unknown']);
        expect(r.code).not.toBe(0);
        expect(r.stderr).toContain('Unknown argument');
    });
});

// ---------------------------------------------------------------------------
// Read-only enforcement smoke test
// ---------------------------------------------------------------------------
//
// Mirrors the per-user directory template from src/constants.js
// USER_DIRECTORY_TEMPLATE so the FS engine + every Repo finds the dirs it
// expects. Kept in lockstep with tests/storage/migration/runner.test.js (the
// migration runner's own suite uses the identical shape).
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

function buildUserTree(dataRoot, handle) {
    const userDir = path.join(dataRoot, handle);
    const dirs = {};
    for (const [k, rel] of Object.entries(USER_DIRS)) dirs[k] = path.join(userDir, rel);
    fs.mkdirSync(dirs.root, { recursive: true });
    for (const d of [dirs.chats, dirs.characters, dirs.worlds, dirs.groups, dirs.groupChats,
                     dirs.themes, dirs.movingUI, dirs.quickreplies,
                     dirs.openAI_Settings, dirs.novelAI_Settings, dirs.koboldAI_Settings,
                     dirs.textGen_Settings, dirs.instruct, dirs.context, dirs.sysprompt,
                     dirs.reasoning]) {
        fs.mkdirSync(d, { recursive: true });
    }
    return { handle, userDir, dirs };
}

function buildRepos(engine) {
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

describe('scripts/storage-migrate.js — runMigration goes through migrateAllUsers', () => {
    let tmpRoot;
    let srcRoot;
    let dstRoot;
    let srcUsers;
    let dstUsers;
    let sourceEngine;
    let destEngine;

    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-cli-migrate-'));
        srcRoot = path.join(tmpRoot, 'src');
        dstRoot = path.join(tmpRoot, 'dst');
        srcUsers = {
            alice: buildUserTree(srcRoot, 'alice'),
            bob: buildUserTree(srcRoot, 'bob'),
        };
        dstUsers = {
            alice: buildUserTree(dstRoot, 'alice'),
            bob: buildUserTree(dstRoot, 'bob'),
        };
        const srcDirByHandle = (h) => srcUsers[h]?.dirs ?? (() => { throw new Error(`unknown handle ${h}`); })();
        const dstDirByHandle = (h) => dstUsers[h]?.dirs ?? (() => { throw new Error(`unknown handle ${h}`); })();
        sourceEngine = new FsEngine({ directoriesByHandle: srcDirByHandle });
        destEngine = new FsEngine({ directoriesByHandle: dstDirByHandle });

        // Seed each source user with at least one record per Repo touched in
        // the migration: settings (so `settings-copied` fires with stats=1),
        // a chat (so `chats-copied` runs through a non-empty list).
        const srcRepos = buildRepos(sourceEngine);
        for (const h of ['alice', 'bob']) {
            await srcRepos.settings.save(h, { user_avatar: `${h}.png`, power_user: { theme: 'dark' } });
            await srcRepos.chat.save(
                h, 'Hero', 'first',
                { chat_metadata: { foo: h }, user_name: h },
                [{ name: h, mes: `hi from ${h}`, is_user: true }],
                null,
            );
        }
    });

    afterEach(() => {
        // Belt-and-braces: migrateAllUsers's `finally` already clears the flag,
        // but if the test errored mid-batch we don't want to leak state into
        // sibling tests.
        setReadOnly(false);
        if (typeof sourceEngine?.close === 'function') sourceEngine.close();
        if (typeof destEngine?.close === 'function') destEngine.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('flips setReadOnly(true) for the duration of the batch and restores it after', async () => {
        const handles = ['alice', 'bob'];
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: buildRepos(sourceEngine),
            destRepos: buildRepos(destEngine),
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: (h) => srcUsers[h].userDir,
            },
        });

        // Wrap the runner's batch entry point so we can prove the CLI went
        // through migrateAllUsers (and not the legacy per-user loop) AND so we
        // can probe `isReadOnly()` from inside the same `onProgress` channel
        // the runner emits during the copy. The wrapper records every call's
        // (handles, onProgressType) and threads our probe alongside the
        // CLI-provided onProgress so we observe the real flag state without
        // suppressing the CLI's per-handle logging.
        const callLog = [];
        let readOnlyDuringMigration = null;
        let earliestProbeStage = null;
        const originalAllUsers = runner.migrateAllUsers.bind(runner);
        runner.migrateAllUsers = (hs, opts = {}) => {
            callLog.push({ handles: hs, hasOnProgress: typeof opts.onProgress === 'function' });
            const userOnProgress = opts.onProgress;
            return originalAllUsers(hs, {
                onProgress: (evt) => {
                    if (readOnlyDuringMigration === null) {
                        readOnlyDuringMigration = isReadOnly();
                        earliestProbeStage = evt.stage;
                    }
                    if (typeof userOnProgress === 'function') userOnProgress(evt);
                },
            });
        };

        const captured = { logs: [], errors: [] };
        const logger = {
            log: (...a) => { captured.logs.push(a.join(' ')); },
            error: (...a) => { captured.errors.push(a.join(' ')); },
        };

        const result = await runMigration({ runner, handles, logger });

        // 1. The CLI used migrateAllUsers — not the per-user migrateUser loop.
        //    The old CLI would have called migrateUser per handle and never
        //    touched migrateAllUsers; the new CLI hits migrateAllUsers exactly
        //    once with the full handles array.
        expect(callLog).toHaveLength(1);
        expect(callLog[0].handles).toEqual(handles);
        expect(callLog[0].hasOnProgress).toBe(true);

        // 2. setReadOnly(true) was active when the very first progress event
        //    fired (proving the flag was flipped BEFORE any per-user work
        //    started).
        expect(readOnlyDuringMigration).toBe(true);
        expect(earliestProbeStage).toBeDefined();
        // And it was restored to false after migrateAllUsers returned.
        expect(isReadOnly()).toBe(false);

        // 3. Both users actually migrated end-to-end (success — no thin
        //    error envelope on either handle).
        expect(result.okCount).toBe(2);
        expect(result.failCount).toBe(0);
        for (const h of handles) {
            expect(result.results[h]).toBeDefined();
            expect(result.results[h].error).toBeUndefined();
            expect(result.results[h].verified).toBe(true);
            expect(result.results[h].settings).toBe(1);
            expect(result.results[h].chats).toBe(1);
        }

        // 4. Destination was actually written (settings + chat round-tripped).
        const dstRepos = buildRepos(destEngine);
        expect(await dstRepos.settings.get('alice')).toEqual({
            user_avatar: 'alice.png', power_user: { theme: 'dark' },
        });
        expect((await dstRepos.chat.get('bob', 'Hero', 'first')).body).toEqual([
            { name: 'bob', mes: 'hi from bob', is_user: true },
        ]);

        // 5. CLI rendered the per-handle header lines via the supplied logger
        //    — confirms runMigration's logging contract didn't regress.
        const headerLines = captured.logs.filter(l => l.startsWith('[') && l.includes('migrating'));
        expect(headerLines).toEqual([
            '[1/2] migrating alice...',
            '[2/2] migrating bob...',
        ]);
    });
});
