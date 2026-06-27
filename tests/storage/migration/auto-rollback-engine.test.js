// End-to-end auto-rollback through MigrationRunner with a non-fs sourceEngine.
//
// auto-rollback.test.js already covers the fs→fs path: it proves that when the
// destination copy throws partway through, the on-disk source tree is restored
// from the snapshot. But that test passes NO sourceEngine to the runner, so it
// can't catch the bug where mysql/pg row mutations stick around
// after rollback (the fs cpSync alone has nothing to roll back — the engine
// owns the rows).
//
// This test exercises the engine-dump capture + replay path end-to-end:
//
//   1. Build a source harness on a non-fs engine (sqlite/mysql/pg).
//   2. Seed the source engine with a row via engine.withTransaction.
//   3. Wire MigrationRunner with sourceEngine = harness.engine so snapshotUser
//      captures _engine_dump.bin alongside the fs tree.
//   4. Fault-inject the dest ChatRepo.save to mutate the SOURCE engine row,
//      then throw — modelling a partial in-place upgrade that left engine
//      rows in a corrupted half-state.
//   5. Run migrateUser, expect it to reject.
//   6. Probe the source engine: the row must be back to its pre-migration
//      value. Without the engine-dump replay (or without sourceEngine wired
//      into the constructor) the mutation persists and this assertion fails —
//      which is exactly the bug engine-dump capture closes.
//
// Why source = non-fs only:
//   - The fs engine has no engine-side state; auto-rollback.test.js already
//     covers it. Including fs here would just duplicate that coverage.
//   - The sqlite source happens to have the .sqlite file living inside
//     userRoot, so a cpSync alone would also restore it — but we still pass
//     sourceEngine through engine.restoreUser to exercise the same code path
//     the mysql/pg cases depend on. Both paths converge on the same assertion.
//
// Why dest = fs:
//   - We need a destination repo set whose ChatRepo.save we can monkey-patch
//     without dragging in a second non-fs harness lifecycle. fs is the
//     cheapest and least flaky option (mysql/pg per-test schema setup is
//     ~200ms each), and the destination's role in this scenario is purely
//     "thing that throws on the second write" — its engine kind is irrelevant
//     to what we're proving.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';
import { MigrationRunner } from '../../../src/storage/migration/runner.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../../src/storage/repositories/stats-repo.js';
import { setReadOnly } from '../../../src/storage/read-only-mode.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const ORIGINAL_BODY = [{ name: 'User', is_user: true, mes: 'original' }];
const MUTATED_BODY = [{ name: 'User', is_user: true, mes: 'CORRUPTED_BY_FAULT' }];

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

// Build a minimal fs destination harness inline. Mirrors the pattern in
// auto-rollback.test.js's buildHarness('fs', ...) but stripped to just what
// the runner needs to write into the dest.
function makeFsDest(tmpRoot, handle) {
    const userDir = path.join(tmpRoot, 'dst', handle);
    const dirs = {
        root: userDir,
        worlds: path.join(userDir, 'worlds'),
        user: path.join(userDir, 'user'),
        avatars: path.join(userDir, 'User Avatars'),
        userImages: path.join(userDir, 'user/images'),
        groups: path.join(userDir, 'groups'),
        groupChats: path.join(userDir, 'group chats'),
        chats: path.join(userDir, 'chats'),
        characters: path.join(userDir, 'characters'),
        backgrounds: path.join(userDir, 'backgrounds'),
        novelAI_Settings: path.join(userDir, 'NovelAI Settings'),
        koboldAI_Settings: path.join(userDir, 'KoboldAI Settings'),
        openAI_Settings: path.join(userDir, 'OpenAI Settings'),
        textGen_Settings: path.join(userDir, 'TextGen Settings'),
        themes: path.join(userDir, 'themes'),
        movingUI: path.join(userDir, 'movingUI'),
        extensions: path.join(userDir, 'extensions'),
        instruct: path.join(userDir, 'instruct'),
        context: path.join(userDir, 'context'),
        quickreplies: path.join(userDir, 'QuickReplies'),
        assets: path.join(userDir, 'assets'),
        comfyWorkflows: path.join(userDir, 'user/workflows'),
        files: path.join(userDir, 'user/files'),
        vectors: path.join(userDir, 'vectors'),
        backups: path.join(userDir, 'backups'),
        sysprompt: path.join(userDir, 'sysprompt'),
        reasoning: path.join(userDir, 'reasoning'),
        cardApps: path.join(userDir, 'card-apps'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    const engine = new FsEngine({
        directoriesByHandle: (h) => {
            if (h !== handle) throw new Error(`unknown dest handle ${h}`);
            return dirs;
        },
    });
    return { engine, dirs, userDir, repos: buildRepos(engine) };
}

// Filter CONTRACT_HARNESSES to engines that actually own state outside userRoot
// — that's the case spec §4.4 exists for. fs is handled by auto-rollback.test.js.
const DB_HARNESSES = CONTRACT_HARNESSES.filter(({ name }) => name !== 'FsEngine');

describe.each(DB_HARNESSES)(
    'MigrationRunner: engine-side auto-rollback on $name source',
    ({ make }) => {
        let src, dst, tmpRoot;

        beforeEach(async () => {
            src = await make();
            if (typeof src.engine.ping === 'function') await src.engine.ping(src.handle);
            // The db harnesses don't pre-create userRoot (their stubRoot is a
            // hollow scaffold). snapshotUser does a real cpSync of userRoot so
            // it must exist on disk first — mirror the parity test's beforeEach.
            fs.mkdirSync(src.dirs.root, { recursive: true });
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-engine-rollback-'));
            dst = makeFsDest(tmpRoot, src.handle);
        });

        afterEach(async () => {
            setReadOnly(false);
            try { dst.engine.close?.(); } catch { /* fs engine has no close */ }
            await src.cleanup();
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        });

        test('engine rows mutated by fault are restored from the snapshot dump', async () => {
            // Seed source via the engine so the row genuinely lives in db state
            // (mysql/pg) or the .sqlite file (sqlite). Going through repos.save
            // would also work, but withTransaction matches the parity test's
            // shape and makes the seed→mutate→assert symmetry obvious.
            await src.engine.withTransaction(src.handle, async (tx) => {
                await tx.putResource(
                    { kind: 'chat', handle: src.handle, charDir: 'Alice', name: 'c1' },
                    { header: HEADER, body: ORIGINAL_BODY },
                );
            });
            // Seed a second chat so the runner makes >1 dest chat.save() call —
            // we want the FIRST dest save to succeed (so the runner is past
            // the snapshot step) and the SECOND to throw.
            await src.engine.withTransaction(src.handle, async (tx) => {
                await tx.putResource(
                    { kind: 'chat', handle: src.handle, charDir: 'Alice', name: 'c2' },
                    { header: HEADER, body: ORIGINAL_BODY },
                );
            });

            // Sanity: the row really is in the engine at ORIGINAL_BODY.
            const seeded = await src.engine.withTransaction(src.handle, (tx) =>
                tx.getResource({ kind: 'chat', handle: src.handle, charDir: 'Alice', name: 'c1' }));
            expect(seeded.body).toEqual(ORIGINAL_BODY);

            // Fault-inject the dest's ChatRepo.save: after one successful write,
            // the second call (a) corrupts the SOURCE engine row, then (b)
            // throws. This models a partial in-place upgrade that left source
            // rows in a corrupted half-state and forces rollback to recover
            // them — the exact scenario spec §4.4 calls out.
            const origSave = dst.repos.chat.save.bind(dst.repos.chat);
            let saveCount = 0;
            dst.repos.chat.save = async (...args) => {
                saveCount++;
                if (saveCount === 1) return origSave(...args);
                // Corrupt the source engine row before throwing.
                await src.engine.withTransaction(src.handle, async (tx) => {
                    await tx.putResource(
                        { kind: 'chat', handle: src.handle, charDir: 'Alice', name: 'c1' },
                        { header: HEADER, body: MUTATED_BODY },
                    );
                });
                throw new Error('Synthetic engine-corruption failure');
            };

            const backupRoot = path.join(tmpRoot, '_storage-migrations');
            const runner = new MigrationRunner({
                sourceRepos: src.repos ?? buildRepos(src.engine),
                sourceEngine: src.engine,
                destRepos: dst.repos,
                snapshotPaths: {
                    dataRoot: tmpRoot,
                    backupRoot,
                    getUserRoot: () => src.dirs.root,
                },
            });

            await expect(runner.migrateUser(src.handle)).rejects.toThrow(
                /Synthetic engine-corruption failure/,
            );

            // Sanity check that the fault DID land: without the fault-injection
            // running, the rollback would trivially pass (nothing to restore).
            expect(saveCount).toBeGreaterThanOrEqual(2);

            // The headline assertion: probe the SOURCE engine. Rollback must
            // have replayed _engine_dump.bin through engine.restoreUser, so
            // the row is back to ORIGINAL_BODY. If sourceEngine wasn't wired
            // into the runner (Finding #1/#2's bug) the snapshot would have
            // skipped the engine-dump capture and this read returns
            // MUTATED_BODY.
            const after = await src.engine.withTransaction(src.handle, (tx) =>
                tx.getResource({ kind: 'chat', handle: src.handle, charDir: 'Alice', name: 'c1' }));
            expect(after).not.toBeNull();
            expect(after.body).toEqual(ORIGINAL_BODY);

            // Snapshot dir was created and contains the engine-dump artifacts
            // (proof that the runner did pass sourceEngine through to
            // snapshotUser, not just to its own constructor).
            expect(fs.existsSync(backupRoot)).toBe(true);
            const backupEntries = fs.readdirSync(backupRoot);
            expect(backupEntries.length).toBeGreaterThan(0);
            const backupPath = path.join(backupRoot, backupEntries[0]);
            expect(fs.existsSync(path.join(backupPath, '_engine_dump.bin'))).toBe(true);
            expect(fs.existsSync(path.join(backupPath, '_engine_meta.json'))).toBe(true);

            // Rollback's cpSync filter excludes engine artifacts from
            // userRoot — the snapshot-engine-dump test already asserts this
            // for the bare restoreFromSnapshot call; the end-to-end probe
            // here confirms it for the runner-orchestrated rollback too.
            expect(fs.existsSync(path.join(src.dirs.root, '_engine_dump.bin'))).toBe(false);
            expect(fs.existsSync(path.join(src.dirs.root, '_engine_meta.json'))).toBe(false);
        });
    },
);
