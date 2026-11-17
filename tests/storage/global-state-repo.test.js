import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeTempFsEngineHarness, makeTempSqliteEngineHarness } from './harness/contract-harness.js';
import { BUCKET_TO_DIR, NamedDocRepo } from '../../src/storage/repositories/named-doc-repo.js';
import { ChatRepo } from '../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { GroupRepo } from '../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../src/storage/repositories/stats-repo.js';
import { MigrationRunner } from '../../src/storage/migration/runner.js';
import {
    InvalidArgumentError,
    PatchMissingParentError,
    PatchTestFailedError,
    StorageReadOnlyError,
    UnsupportedPatchOpError,
} from '../../src/storage/errors.js';
import { setReadOnly } from '../../src/storage/read-only-mode.js';
import { preflightNameLengths } from '../../src/storage/migration/preflight.js';
import { enumerateCategory, enumerateRoot } from '../../src/storage/inspector.js';
import { USER_DIRECTORY_TEMPLATE } from '../../src/constants.js';
import { getUserDirectories } from '../../src/users.js';

const ENGINES = [
    { name: 'FsEngine', make: makeTempFsEngineHarness },
    { name: 'SqliteEngine', make: makeTempSqliteEngineHarness },
];

describe.each(ENGINES)('NamedDocRepo globalStates on $name', ({ make }) => {
    let h;
    let repo;

    beforeEach(async () => {
        h = await make();
        repo = new NamedDocRepo({ engine: h.engine });
    });

    afterEach(() => {
        setReadOnly(false);
        h.cleanup();
    });

    test('save, get, list, and delete round-trip under bucket = globalStates', async () => {
        await repo.save(h.handle, 'globalStates', 'workbench-z', { version: 1, items: ['a'] });
        await repo.save(h.handle, 'globalStates', 'workbench-a', { version: 2 });

        expect(await repo.get(h.handle, 'globalStates', 'workbench-z')).toEqual({ version: 1, items: ['a'] });
        expect(await repo.get(h.handle, 'globalStates', 'missing')).toBeNull();

        const entries = await repo.list(h.handle, 'globalStates');
        expect(entries.map(e => e.key.name)).toEqual(['workbench-a', 'workbench-z']);

        expect(await repo.delete(h.handle, 'globalStates', 'workbench-z')).toBe(true);
        expect(await repo.delete(h.handle, 'globalStates', 'workbench-z')).toBe(false);
        expect(await repo.get(h.handle, 'globalStates', 'workbench-z')).toBeNull();
    });

    test('patch creates from {} when absent (created: true) and updates existing (created: false)', async () => {
        const created = await repo.patch(h.handle, 'globalStates', 'sessions', [
            { op: 'add', path: '/activeId', value: 's1' },
            { op: 'add', path: '/items/s1', value: { title: 'First' } },
        ]);

        expect(created).toEqual({
            applied: 2,
            created: true,
            state: { activeId: 's1', items: { s1: { title: 'First' } } },
        });
        expect(await repo.get(h.handle, 'globalStates', 'sessions')).toEqual(created.state);

        const updated = await repo.patch(h.handle, 'globalStates', 'sessions', [
            { op: 'test', path: '/activeId', value: 's1' },
            { op: 'replace', path: '/activeId', value: 's2' },
            { op: 'add', path: '/items/s2', value: { title: 'Second' } },
        ]);

        expect(updated).toEqual({
            applied: 3,
            created: false,
            state: {
                activeId: 's2',
                items: {
                    s1: { title: 'First' },
                    s2: { title: 'Second' },
                },
            },
        });
        expect(await repo.get(h.handle, 'globalStates', 'sessions')).toEqual(updated.state);
    });

    test('patch throws PatchTestFailedError without mutating persisted doc', async () => {
        const initial = { revision: 1, data: { kept: true } };
        await repo.save(h.handle, 'globalStates', 'cas-state', initial);

        await expect(repo.patch(h.handle, 'globalStates', 'cas-state', [
            { op: 'test', path: '/revision', value: 99 },
            { op: 'replace', path: '/data/kept', value: false },
        ])).rejects.toBeInstanceOf(PatchTestFailedError);

        expect(await repo.get(h.handle, 'globalStates', 'cas-state')).toEqual(initial);
    });

    test('patch throws PatchMissingParentError / UnsupportedPatchOpError without mutating persisted doc', async () => {
        const initial = { a: 1 };
        await repo.save(h.handle, 'globalStates', 'err-state', initial);

        await expect(repo.patch(h.handle, 'globalStates', 'err-state', [
            { op: 'replace', path: '/missing/child', value: 2 },
        ])).rejects.toBeInstanceOf(PatchMissingParentError);

        await expect(repo.patch(h.handle, 'globalStates', 'err-state', [
            { op: 'move', from: '/a', path: '/b' },
        ])).rejects.toBeInstanceOf(UnsupportedPatchOpError);

        expect(await repo.get(h.handle, 'globalStates', 'err-state')).toEqual(initial);
    });

    test.each(['../escape', '', '   ', 'nested/ns', 'ns.json'])('rejects invalid name %j cleanly on save and patch', async (badName) => {
        await expect(repo.save(h.handle, 'globalStates', badName, { v: 1 })).rejects.toThrow();
        const txSpy = jest.spyOn(h.engine, 'withTransaction');
        try {
            await expect(repo.patch(h.handle, 'globalStates', badName, [
                { op: 'test', path: '/v', value: 1 },
                { op: 'replace', path: '/v', value: 2 },
            ])).rejects.toBeInstanceOf(InvalidArgumentError);
            expect(txSpy).not.toHaveBeenCalled();
        } finally {
            txSpy.mockRestore();
        }
        expect(await repo.list(h.handle, 'globalStates')).toEqual([]);
    });

    test('patch canonicalizes surrounding whitespace on name before reading and writing', async () => {
        await repo.save(h.handle, 'globalStates', 'trimmed_ns', { rev: 1 });
        const result = await repo.patch(h.handle, 'globalStates', '  trimmed_ns  ', [
            { op: 'test', path: '/rev', value: 1 },
            { op: 'replace', path: '/rev', value: 2 },
        ]);
        expect(result).toEqual({
            applied: 2,
            created: false,
            state: { rev: 2 },
        });
        expect(await repo.get(h.handle, 'globalStates', 'trimmed_ns')).toEqual({ rev: 2 });
    });

    test('patch supports root pointer replace/add/test and rejects root remove or non-object result without mutating existing doc', async () => {
        const initial = { existing: 1, nested: { keep: true } };
        await repo.save(h.handle, 'globalStates', 'root-ops', initial);

        // Root test mismatch -> PatchTestFailedError, doc intact
        await expect(repo.patch(h.handle, 'globalStates', 'root-ops', [
            { op: 'test', path: '', value: { existing: 999 } },
            { op: 'replace', path: '', value: { whole: 'doc' } },
        ])).rejects.toBeInstanceOf(PatchTestFailedError);
        expect(await repo.get(h.handle, 'globalStates', 'root-ops')).toEqual(initial);

        // Root remove -> UnsupportedPatchOpError, doc intact
        await expect(repo.patch(h.handle, 'globalStates', 'root-ops', [
            { op: 'remove', path: '' },
        ])).rejects.toBeInstanceOf(UnsupportedPatchOpError);
        expect(await repo.get(h.handle, 'globalStates', 'root-ops')).toEqual(initial);

        // Root replace with non-object -> UnsupportedPatchOpError, doc intact
        for (const badValue of [[1, 2, 3], null, 'scalar', 42]) {
            await expect(repo.patch(h.handle, 'globalStates', 'root-ops', [
                { op: 'replace', path: '', value: badValue },
            ])).rejects.toBeInstanceOf(UnsupportedPatchOpError);
            expect(await repo.get(h.handle, 'globalStates', 'root-ops')).toEqual(initial);
        }

        // Root test match + replace -> replaces whole doc
        const replaced = await repo.patch(h.handle, 'globalStates', 'root-ops', [
            { op: 'test', path: '', value: initial },
            { op: 'replace', path: '', value: { whole: 'doc' } },
        ]);
        expect(replaced).toEqual({
            applied: 2,
            created: false,
            state: { whole: 'doc' },
        });
        expect(await repo.get(h.handle, 'globalStates', 'root-ops')).toEqual({ whole: 'doc' });

        // Root add -> replaces whole doc
        const added = await repo.patch(h.handle, 'globalStates', 'root-ops', [
            { op: 'add', path: '', value: { replacedByAdd: true } },
        ]);
        expect(added).toEqual({
            applied: 1,
            created: false,
            state: { replacedByAdd: true },
        });
        expect(await repo.get(h.handle, 'globalStates', 'root-ops')).toEqual({ replacedByAdd: true });
    });

    test('patch rejects empty operations array cleanly without opening a transaction', async () => {
        const txSpy = jest.spyOn(h.engine, 'withTransaction');
        try {
            await expect(repo.patch(h.handle, 'globalStates', 'empty-ops', []))
                .rejects.toBeInstanceOf(InvalidArgumentError);
            expect(txSpy).not.toHaveBeenCalled();
        } finally {
            txSpy.mockRestore();
        }
    });

    test('assertWritable rejects save, patch, and delete when read-only mode is active', async () => {
        await repo.save(h.handle, 'globalStates', 'locked', { v: 1 });
        setReadOnly(true);

        await expect(repo.save(h.handle, 'globalStates', 'locked', { v: 2 }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
        await expect(repo.patch(h.handle, 'globalStates', 'locked', [
            { op: 'replace', path: '/v', value: 2 },
        ])).rejects.toBeInstanceOf(StorageReadOnlyError);
        await expect(repo.delete(h.handle, 'globalStates', 'locked'))
            .rejects.toBeInstanceOf(StorageReadOnlyError);

        expect(await repo.get(h.handle, 'globalStates', 'locked')).toEqual({ v: 1 });
    });
});

describe('globalStates backend layout and integration', () => {
    test('BUCKET_TO_DIR maps globalStates to states', () => {
        expect(BUCKET_TO_DIR.globalStates).toBe('states');
        expect(USER_DIRECTORY_TEMPLATE.states).toBe('states');
    });

    test('getUserDirectories(handle).states points to <userRoot>/states', () => {
        const prevRoot = globalThis.DATA_ROOT;
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-gs-dirs-'));
        try {
            globalThis.DATA_ROOT = tmpRoot;
            const handle = `gs-test-${Date.now()}`;
            const dirs = getUserDirectories(handle);
            expect(dirs.states).toBe(path.join(tmpRoot, handle, 'states'));
        } finally {
            globalThis.DATA_ROOT = prevRoot;
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    test('FS engine stores pretty-printed JSON at <root>/states/<ns>.json and deletes it', async () => {
        const h = await makeTempFsEngineHarness();
        try {
            const repo = new NamedDocRepo({ engine: h.engine });
            await repo.patch(h.handle, 'globalStates', 'my_plugin', [
                { op: 'add', path: '/count', value: 42 },
            ]);
            const filePath = path.join(h.dirs.root, 'states', 'my_plugin.json');
            expect(fs.existsSync(filePath)).toBe(true);
            const raw = fs.readFileSync(filePath, 'utf8');
            expect(raw).toBe(JSON.stringify({ count: 42 }, null, 4));

            await repo.delete(h.handle, 'globalStates', 'my_plugin');
            expect(fs.existsSync(filePath)).toBe(false);
        } finally {
            h.cleanup();
        }
    });

    test('SQLite engine persists globalStates rows in named_docs with bucket = globalStates', async () => {
        const h = await makeTempSqliteEngineHarness();
        try {
            const repo = new NamedDocRepo({ engine: h.engine });
            await repo.patch(h.handle, 'globalStates', 'my_plugin', [
                { op: 'add', path: '/count', value: 7 },
            ]);
            const db = h.engine._dbs.get(h.handle);
            const row = db.prepare('SELECT doc FROM named_docs WHERE handle=? AND bucket=? AND name=?')
                .get(h.handle, 'globalStates', 'my_plugin');
            expect(row).toBeDefined();
            expect(JSON.parse(row.doc)).toEqual({ count: 7 });
        } finally {
            h.cleanup();
        }
    });

    test('patch rejects non-array operations or non-object root replacement cleanly', async () => {
        const h = await makeTempFsEngineHarness();
        try {
            const repo = new NamedDocRepo({ engine: h.engine });
            await expect(repo.patch(h.handle, 'globalStates', 'bad-ops', 'not-an-array'))
                .rejects.toBeInstanceOf(InvalidArgumentError);
            await expect(repo.patch(h.handle, 'globalStates', 'bad-root', [
                { op: 'replace', path: '', value: [1, 2, 3] },
            ])).rejects.toBeInstanceOf(UnsupportedPatchOpError);
            await expect(repo.patch(h.handle, 'globalStates', 'bad-root-multi', [
                { op: 'replace', path: '', value: null },
                { op: 'add', path: '/x', value: 1 },
            ])).rejects.toBeInstanceOf(UnsupportedPatchOpError);
        } finally {
            h.cleanup();
        }
    });

    test('MigrationRunner round-trips globalStates across FS and SQLite', async () => {
        const fsH = await makeTempFsEngineHarness();
        const sqH = await makeTempSqliteEngineHarness();
        const fsH2 = await makeTempFsEngineHarness();
        const buildRepos = (engine) => ({
            chat: new ChatRepo({ engine }),
            settings: new SettingsRepo({ engine }),
            preset: new PresetRepo({ engine }),
            worldInfo: new WorldInfoRepo({ engine }),
            namedDoc: new NamedDocRepo({ engine }),
            group: new GroupRepo({ engine }),
            stats: new StatsRepo({ engine }),
        });
        try {
            const fsRepos = buildRepos(fsH.engine);
            const sqRepos = buildRepos(sqH.engine);
            const fsRepos2 = buildRepos(fsH2.engine);

            await fsRepos.namedDoc.patch(fsH.handle, 'globalStates', 'workbench_sessions', [
                { op: 'add', path: '/sessions', value: [{ id: 's1', messages: [{ role: 'user', text: 'hello' }] }] },
            ]);
            await fsRepos.namedDoc.save(fsH.handle, 'globalStates', 'prefs_cache', { collapsed: true });

            const forwardRunner = new MigrationRunner({
                sourceRepos: fsRepos,
                destRepos: sqRepos,
                snapshotPaths: {
                    backupRoot: fsH.backupRoot,
                    getUserRoot: () => fsH.dirs.root,
                },
            });
            const forwardRes = await forwardRunner.migrateUser(fsH.handle);
            expect(forwardRes.verified).toBe(true);
            expect(forwardRes.named_docs).toBe(2);
            expect(await sqRepos.namedDoc.get(sqH.handle, 'globalStates', 'workbench_sessions')).toEqual({
                sessions: [{ id: 's1', messages: [{ role: 'user', text: 'hello' }] }],
            });
            expect(await sqRepos.namedDoc.get(sqH.handle, 'globalStates', 'prefs_cache')).toEqual({ collapsed: true });

            const reverseRunner = new MigrationRunner({
                sourceRepos: sqRepos,
                destRepos: fsRepos2,
                snapshotPaths: {
                    backupRoot: sqH.backupRoot,
                    getUserRoot: () => sqH.dirs.root,
                },
            });
            const reverseRes = await reverseRunner.migrateUser(sqH.handle);
            expect(reverseRes.verified).toBe(true);
            expect(reverseRes.named_docs).toBe(2);
            expect(await fsRepos2.namedDoc.get(fsH2.handle, 'globalStates', 'workbench_sessions')).toEqual({
                sessions: [{ id: 's1', messages: [{ role: 'user', text: 'hello' }] }],
            });
            expect(fs.existsSync(path.join(fsH2.dirs.states, 'workbench_sessions.json'))).toBe(true);
        } finally {
            fsH.cleanup();
            sqH.cleanup();
            fsH2.cleanup();
        }
    });

    test('preflightNameLengths includes globalStates bucket by default', async () => {
        const h = await makeTempFsEngineHarness();
        try {
            const repo = new NamedDocRepo({ engine: h.engine });
            const longName = 'g'.repeat(129);
            fs.mkdirSync(h.dirs.states, { recursive: true });
            fs.writeFileSync(path.join(h.dirs.states, `${longName}.json`), '{}');

            const res = await preflightNameLengths({
                dstMode: 'mysql',
                sourceRepos: {
                    namedDoc: repo,
                    worldInfo: { listNames: async () => [] },
                    group: { list: async () => [] },
                    preset: { list: async () => [] },
                    chat: { listAll: async () => [] },
                },
                handles: [h.handle],
            });
            expect(res.ok).toBe(false);
            expect(res.offenders).toEqual([
                { handle: h.handle, bucket: 'named-doc/globalStates', name: longName, bytes: 129 },
            ]);
        } finally {
            h.cleanup();
        }
    });

    test('storage inspector tracks states/ disk usage under other without folding into settings.json', async () => {
        const h = await makeTempFsEngineHarness();
        try {
            const repo = new NamedDocRepo({ engine: h.engine });
            await repo.save(h.handle, 'globalStates', 'big_state', { payload: 'x'.repeat(2048) });

            const user = { handle: h.handle, storageQuotaBytes: -1 };
            const admin = { storage: { defaultUserQuotaBytes: -1 } };
            const rootRes = await enumerateRoot(h.dirs.root, user, admin);
            const presetsEntry = rootRes.entries.find(e => e.key === 'presets');
            const otherEntry = rootRes.entries.find(e => e.key === 'other');
            expect(presetsEntry.sizeBytes).toBe(0);
            expect(otherEntry.sizeBytes).toBeGreaterThan(2048);

            const otherDetail = await enumerateCategory(h.dirs.root, 'other');
            const statesRow = otherDetail.entries.find(e => e.key === 'states');
            expect(statesRow).toBeDefined();
            expect(statesRow.kind).toBe('directory');
            expect(statesRow.sizeBytes).toBeGreaterThan(2048);
        } finally {
            h.cleanup();
        }
    });
});
