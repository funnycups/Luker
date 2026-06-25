// Per spec §4.4: snapshotUser in mysql/postgres modes must also capture an
// engine dump alongside the fs tree, and restoreFromSnapshot must replay it.
// This exercises the round-trip across all 4 engines via CONTRACT_HARNESSES:
//
//   fs        -> no engine dump (engine.dumpUser returns null); snapshot is
//                just the fs tree, exactly as Tasks 1+2 of Stage 4 already did.
//   sqlite    -> engine.dumpUser returns a binary stream of the .sqlite file
//                (and the .sqlite file ALSO lives under the user dir, so the
//                cpSync already covers it — but capturing the dump separately
//                is consistent with the cross-engine contract and lets
//                restoreFromSnapshot reuse the engine.restoreUser code path).
//   mysql/pg  -> engine.dumpUser returns a newline-JSON text stream of the
//                user's rows. Without the dump file, restoreFromSnapshot can
//                only rewind the fs tree (secrets, characters, etc.) and the
//                db rows stay mutated — which is precisely the bug this task
//                closes.
//
// Modelled after tests/storage/engines/dump-restore.parity.test.js: same
// "seed → snapshot → mutate → restore → assert ORIGINAL" structure, but
// driving through the snapshotUser/restoreFromSnapshot pair rather than
// engine.dumpUser/restoreUser directly.

import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { snapshotUser, restoreFromSnapshot } from '../../../src/storage/migration/backup.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const ORIGINAL_BODY = [{ name: 'User', is_user: true, mes: 'hi' }];
const MUTATED_BODY = [{ name: 'User', is_user: true, mes: 'MUTATED' }];

describe.each(CONTRACT_HARNESSES)('snapshotUser engine dump on $name', ({ make }) => {
    let h;

    beforeEach(async () => {
        h = await make();
        if (typeof h.engine.ping === 'function') await h.engine.ping(h.handle);
        // The mysql/pg harnesses give back a stub dirs map under a fresh temp
        // root but DON'T pre-create dirs.root (the fs/sqlite harnesses do).
        // snapshotUser is a real cpSync of userRoot, so ensure the dir exists
        // on every engine — for db engines this dir is otherwise empty (their
        // user state lives in db rows, not on disk).
        fs.mkdirSync(h.dirs.root, { recursive: true });
        // Seed a chat through the engine so there's something to dump/restore.
        // For fs the chat lands as a .jsonl file inside the user dir, which the
        // cpSync will cover; for db engines it lands in db rows that only
        // engine.dumpUser captures.
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(
                { kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: ORIGINAL_BODY },
            );
        });
    });

    afterEach(async () => {
        if (h) await h.cleanup();
    });

    test('snapshot includes engine dump + meta in db modes; fs gets only the tree', async () => {
        const backupRoot = path.join(h.dataRoot, '_storage-migrations');
        const backupPath = await snapshotUser({
            handle: h.handle,
            userRoot: h.dirs.root,
            backupRoot,
            engine: h.engine,
        });
        expect(fs.existsSync(backupPath)).toBe(true);
        if (h.kind === 'fs') {
            // FS engine: dumpUser returns null, so no _engine_dump.bin should
            // be written. The fs tree alone IS the snapshot — same shape as
            // pre-Task-3 behaviour, just routed through the async signature.
            expect(fs.existsSync(path.join(backupPath, '_engine_dump.bin'))).toBe(false);
            expect(fs.existsSync(path.join(backupPath, '_engine_meta.json'))).toBe(false);
        } else {
            expect(fs.existsSync(path.join(backupPath, '_engine_dump.bin'))).toBe(true);
            expect(fs.existsSync(path.join(backupPath, '_engine_meta.json'))).toBe(true);
            const dumpSize = fs.statSync(path.join(backupPath, '_engine_dump.bin')).size;
            expect(dumpSize).toBeGreaterThan(0);
            const meta = JSON.parse(fs.readFileSync(path.join(backupPath, '_engine_meta.json'), 'utf8'));
            expect(meta.engineKind).toBe(h.kind);
            expect(meta.handle).toBe(h.handle);
            expect(meta.schemaVersion).toBe(1);
            expect(typeof meta.createdAt).toBe('string');
        }
    });

    test('snapshot works when engine arg is omitted (back-compat: fs-tree only)', async () => {
        // Tasks 1+2 callers (auto-rollback test, runner.test.js) pass no engine
        // — that path must keep working: just cpSync, no engine dump even on
        // sqlite/mysql/pg. The engine-dump capture is strictly opt-in via the
        // new `engine` argument.
        const backupRoot = path.join(h.dataRoot, '_storage-migrations-no-engine');
        const backupPath = await snapshotUser({
            handle: h.handle,
            userRoot: h.dirs.root,
            backupRoot,
        });
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(fs.existsSync(path.join(backupPath, '_engine_dump.bin'))).toBe(false);
        expect(fs.existsSync(path.join(backupPath, '_engine_meta.json'))).toBe(false);
    });

    test('restoreFromSnapshot replays engine rows in db modes', async () => {
        const backupRoot = path.join(h.dataRoot, '_storage-migrations');
        const backupPath = await snapshotUser({
            handle: h.handle,
            userRoot: h.dirs.root,
            backupRoot,
            engine: h.engine,
        });

        // Mutate the engine state AFTER snapshotting. Mutation-then-restore is
        // a strictly stronger probe than wipe-then-restore: a no-op restore
        // would leave the mutation visible and the assertion below would fail.
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(
                { kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MUTATED_BODY },
            );
        });
        const mid = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
        expect(mid.body).toEqual(MUTATED_BODY);  // sanity: mutation landed

        await restoreFromSnapshot({
            handle: h.handle,
            userRoot: h.dirs.root,
            backupPath,
            engine: h.engine,
        });

        // After restore, the chat body must be back to ORIGINAL_BODY for every
        // engine. fs/sqlite get there via cpSync (the .jsonl / .sqlite file is
        // inside the user dir); mysql/pg only get there via the engine dump
        // replay — this is the new behaviour Stage 4 Task 3 introduces.
        const after = await h.engine.withTransaction(h.handle, (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
        expect(after).not.toBeNull();
        expect(after.body).toEqual(ORIGINAL_BODY);

        // The engine-side artifacts are snapshot-internal: they must NOT leak
        // into the restored userRoot. Without the cpSync filter, rollback in
        // db modes would leave _engine_dump.bin / _engine_meta.json sitting
        // alongside the user's real files, bloating the next snapshot and
        // confusing anyone inspecting the data dir. The fs branch never
        // produces these files in the first place, so the assertion is
        // universal across engines.
        expect(fs.existsSync(path.join(h.dirs.root, '_engine_dump.bin'))).toBe(false);
        expect(fs.existsSync(path.join(h.dirs.root, '_engine_meta.json'))).toBe(false);
    });

    test('restoreFromSnapshot rejects an engineKind mismatch', async () => {
        // The meta file pins the engine kind it was dumped from; restoring
        // into a different engine would silently overwrite incompatible data
        // (or worse, produce a partial restore). The check fires only for db
        // modes — fs snapshots have no meta file.
        if (h.kind === 'fs') return;
        const backupRoot = path.join(h.dataRoot, '_storage-migrations');
        const backupPath = await snapshotUser({
            handle: h.handle,
            userRoot: h.dirs.root,
            backupRoot,
            engine: h.engine,
        });
        // Tamper the meta to claim a different engine kind.
        const metaPath = path.join(backupPath, '_engine_meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.engineKind = meta.engineKind === 'sqlite' ? 'mysql' : 'sqlite';
        fs.writeFileSync(metaPath, JSON.stringify(meta));

        await expect(restoreFromSnapshot({
            handle: h.handle,
            userRoot: h.dirs.root,
            backupPath,
            engine: h.engine,
        })).rejects.toThrow(/engineKind mismatch/);
    });
});
