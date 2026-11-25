import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import archiver from 'archiver';
import request from 'supertest';
import { Readable } from 'node:stream';
import { initSchema, CURRENT_SCHEMA_VERSION } from '../../../src/storage/engines/sqlite-schema.js';
import { SqliteEngine, assertValidSqliteFile } from '../../../src/storage/engines/sqlite-engine.js';
import { RestoreDumpInvalidError } from '../../../src/storage/errors.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY } from '../../../src/storage/engine-backup-entries.js';
import { router as usersPrivateRouter } from '../../../src/endpoints/users-private.js';
import { getSettingsRepo, getWorldInfoRepo } from '../../../src/storage/index.js';
import { currentScopeForResources } from '../../harness/storage-scope.js';
import { makeEndpointHarness, uploadArchiveToSession } from '../harness/endpoint-harness.js';

const V1_SQL = fs.readFileSync(
    new URL('../../../src/storage/engines/migrations/sqlite/0001-initial.sql', import.meta.url),
    'utf8',
);

const ALL_SELECTION = {
    settings: true,
    secrets: true,
    characters: true,
    chats: true,
    lorebooks: true,
    presets: true,
    assets: true,
    extensions: true,
    globalExtensions: false,
    vectors: true,
};

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function managedDir(label) {
    const scope = currentScopeForResources();
    return (await scope.directory(label)).path;
}

function buildValidDb(filePath, { version = CURRENT_SCHEMA_VERSION, mutate = null } = {}) {
    const db = new Database(filePath);
    try {
        if (version === 0 || version === 1) {
            db.exec(V1_SQL);
            db.pragma(`user_version = ${version}`);
        } else {
            initSchema(db);
        }
        mutate?.(db);
    } finally {
        db.close();
    }
    return filePath;
}

function seedLegacyOrCurrentRows(db, sourceHandle = 'source-user') {
    const chatDoc = JSON.stringify({
        header: { user_name: 'tester', character_name: 'Alice', chat_metadata: { integrity: 'keep-int-1' } },
        body: [{ name: 'Alice', is_user: false, mes: 'lantern lit' }],
    });
    db.prepare('INSERT INTO chats (handle, char_dir, name, is_group, group_id, doc, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sourceHandle, 'Alice', 'c1', 0, '', chatDoc, 1000, 900);
    db.prepare('INSERT INTO chat_states (handle, char_dir, name, is_group, group_id, namespace, doc) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sourceHandle, 'Alice', 'c1', 0, '', 'ns', JSON.stringify({ state: 1 }));
    db.prepare('INSERT INTO settings (handle, doc, updated_at) VALUES (?, ?, ?)')
        .run(sourceHandle, JSON.stringify({ user_name: 'restored-user' }), 1000);
    db.prepare('INSERT INTO presets (handle, dir_key, name, doc, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(sourceHandle, 'openai', 'p1', JSON.stringify({ temperature: 0.7 }), 1000);
    db.prepare('INSERT INTO preset_states (handle, dir_key, name, namespace, doc) VALUES (?, ?, ?, ?, ?)')
        .run(sourceHandle, 'openai', 'orphan-preset', 'ns', JSON.stringify({ orphan: true }));
    const hasRevision = db.pragma('table_xinfo(worlds)').some(c => c.name === 'revision');
    if (hasRevision) {
        db.prepare('INSERT INTO worlds (handle, name, doc, updated_at, revision) VALUES (?, ?, ?, ?, ?)')
            .run(sourceHandle, 'w1', JSON.stringify({ entries: { '1': { content: 'lore' } } }), 1000, 'stale-rev');
    } else {
        db.prepare('INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)')
            .run(sourceHandle, 'w1', JSON.stringify({ entries: { '1': { content: 'lore' } } }), 1000);
    }
    db.prepare('INSERT INTO named_docs (handle, bucket, name, doc, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(sourceHandle, 'themes', 't1', JSON.stringify({ accent: '#123' }), 1000);
    db.prepare('INSERT INTO groups_table (handle, id, doc, updated_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sourceHandle, 'g1', JSON.stringify({ id: 'g1', name: 'Watch', chats: [] }), 1000, 900);
    db.prepare('INSERT INTO stats (handle, doc, updated_at) VALUES (?, ?, ?)')
        .run(sourceHandle, JSON.stringify({ totalChats: 3 }), 1000);
}

async function buildArchiveBuffer(entries) {
    const dir = await managedDir('sqlite-restore-zip');
    const zipPath = path.join(dir, 'payload.zip');
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        for (const entry of entries) {
            arc.append(entry.content, { name: entry.name });
        }
        arc.finalize();
    });
    return fs.readFileSync(zipPath);
}

describe('assertValidSqliteFile and SqliteEngine.restoreUser', () => {
    test.each([0, 1, CURRENT_SCHEMA_VERSION])('accepts real schema version %i, migrates cleanly, clears world revisions, and keeps all tables writable', async (version) => {
        const dir = await managedDir(`sqlite-valid-v${version}`);
        const engine = new SqliteEngine({ directoriesByHandle: () => ({ root: path.join(dir, 'u') }) });
        try {
            await engine.withTransaction('u', tx => tx.putResource({ kind: 'settings', handle: 'u' }, { doc: { before: true } }));
            const dumpFile = buildValidDb(path.join(dir, `v${version}.sqlite`), {
                version,
                mutate: db => seedLegacyOrCurrentRows(db, 'other-handle'),
            });

            await assertValidSqliteFile(dumpFile);
            await engine.restoreUser('u', Readable.from(fs.readFileSync(dumpFile)));

            const probed = await engine.withTransaction('u', async (tx) => ({
                chat: await tx.getResource({ kind: 'chat', handle: 'u', charDir: 'Alice', name: 'c1' }),
                chatState: await tx.getChatState({ kind: 'chat', handle: 'u', charDir: 'Alice', name: 'c1' }, 'ns'),
                settings: await tx.getResource({ kind: 'settings', handle: 'u' }),
                preset: await tx.getResource({ kind: 'preset', handle: 'u', dirKey: 'openai', name: 'p1' }),
                orphanPresetState: await tx.getPresetState({ kind: 'preset', handle: 'u', dirKey: 'openai', name: 'orphan-preset' }, 'ns'),
                world: await tx.getResource({ kind: 'world', handle: 'u', name: 'w1' }),
                worldRev: tx.getWorldInfoVersion({ kind: 'world', handle: 'u', name: 'w1' }),
                namedDoc: await tx.getResource({ kind: 'named-doc', handle: 'u', bucket: 'themes', name: 't1' }),
                group: await tx.getResource({ kind: 'group', handle: 'u', id: 'g1' }),
                stats: await tx.getResource({ kind: 'stats', handle: 'u' }),
            }));

            expect(probed.chat?.integrity).toBe('keep-int-1');
            expect(probed.chatState).toEqual({ state: 1 });
            expect(probed.settings).toEqual({ user_name: 'restored-user' });
            expect(probed.preset).toEqual({ temperature: 0.7 });
            expect(probed.orphanPresetState).toEqual({ orphan: true });
            expect(probed.world).toEqual({ entries: { '1': { content: 'lore' } } });
            expect(probed.worldRev).toBeNull();
            expect(probed.namedDoc).toEqual({ accent: '#123' });
            expect(probed.group).toEqual({ id: 'g1', name: 'Watch', chats: [] });
            expect(probed.stats).toEqual({ totalChats: 3 });

            // Subsequent operations (world save with revision rotation + chat FK cascade delete) still work.
            const rev = await engine.withTransaction('u', async (tx) => {
                const r = await tx.putResource({ kind: 'world', handle: 'u', name: 'w1' }, { doc: { entries: { '2': { content: 'after' } } } });
                await tx.deleteResource({ kind: 'chat', handle: 'u', charDir: 'Alice', name: 'c1' });
                return r;
            });
            expect(typeof rev).toBe('string');
            expect(await engine.withTransaction('u', tx => tx.getChatState({ kind: 'chat', handle: 'u', charDir: 'Alice', name: 'c1' }, 'ns'))).toBeNull();
        } finally {
            engine.close();
        }
    });

    test('accepts harmless equivalent SQLite declaration variations without demanding byte-identical DDL', async () => {
        const dir = await managedDir('sqlite-equivalent-ddl');
        const engine = new SqliteEngine({ directoriesByHandle: () => ({ root: path.join(dir, 'u') }) });
        try {
            const file = path.join(dir, 'equivalent.sqlite');
            const db = new Database(file);
            try {
                db.exec(`
                    CREATE TABLE chats (
                        handle VARCHAR(128) NOT NULL,
                        char_dir VARCHAR(255) NOT NULL,
                        name VARCHAR(255) NOT NULL,
                        is_group INT NOT NULL DEFAULT (0),
                        group_id VARCHAR(255) NOT NULL DEFAULT (''),
                        doc CLOB NOT NULL,
                        integrity VARCHAR(128) GENERATED ALWAYS AS (json_extract(doc, '$.header.chat_metadata.integrity')) VIRTUAL,
                        updated_at BIGINT NOT NULL,
                        created_at BIGINT NOT NULL,
                        PRIMARY KEY (group_id, is_group, name, char_dir, handle)
                    );
                    CREATE TABLE chat_states (
                        handle VARCHAR(128) NOT NULL,
                        char_dir VARCHAR(255) NOT NULL,
                        name VARCHAR(255) NOT NULL,
                        is_group INT NOT NULL DEFAULT (0),
                        group_id VARCHAR(255) NOT NULL DEFAULT (''),
                        namespace VARCHAR(128) NOT NULL,
                        doc CLOB NOT NULL,
                        PRIMARY KEY (namespace, group_id, is_group, name, char_dir, handle),
                        FOREIGN KEY (group_id, is_group, name, char_dir, handle)
                            REFERENCES chats(group_id, is_group, name, char_dir, handle) ON DELETE CASCADE
                    );
                    CREATE TABLE settings (
                        handle VARCHAR(128) NOT NULL PRIMARY KEY,
                        doc CLOB NOT NULL,
                        updated_at BIGINT NOT NULL,
                        extra_note TEXT
                    );
                    CREATE TABLE presets (
                        handle TEXT NOT NULL,
                        dir_key TEXT NOT NULL,
                        name TEXT NOT NULL,
                        doc TEXT NOT NULL,
                        updated_at INT NOT NULL,
                        PRIMARY KEY (name, dir_key, handle)
                    );
                    CREATE TABLE preset_states (
                        handle TEXT NOT NULL,
                        dir_key TEXT NOT NULL,
                        name TEXT NOT NULL,
                        namespace TEXT NOT NULL,
                        doc TEXT NOT NULL,
                        PRIMARY KEY (namespace, name, dir_key, handle)
                    );
                    CREATE TABLE worlds (
                        handle TEXT NOT NULL,
                        name TEXT NOT NULL,
                        doc TEXT NOT NULL,
                        updated_at BIGINT NOT NULL,
                        revision VARCHAR(64),
                        PRIMARY KEY (name, handle)
                    );
                    CREATE TABLE named_docs (
                        handle TEXT NOT NULL,
                        bucket TEXT NOT NULL,
                        name TEXT NOT NULL,
                        doc TEXT NOT NULL,
                        updated_at INT NOT NULL,
                        PRIMARY KEY (name, bucket, handle)
                    );
                    CREATE TABLE groups_table (
                        handle TEXT NOT NULL,
                        id TEXT NOT NULL,
                        doc TEXT NOT NULL,
                        updated_at INT NOT NULL,
                        created_at INT NOT NULL,
                        PRIMARY KEY (id, handle)
                    );
                    CREATE TABLE stats (
                        handle VARCHAR(128) NOT NULL PRIMARY KEY,
                        doc TEXT NOT NULL,
                        updated_at BIGINT NOT NULL
                    );
                `);
                db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
                seedLegacyOrCurrentRows(db, 'other-handle');
            } finally {
                db.close();
            }

            await assertValidSqliteFile(file);
            await engine.restoreUser('u', Readable.from(fs.readFileSync(file)));
            const settings = await engine.withTransaction('u', tx => tx.getResource({ kind: 'settings', handle: 'u' }));
            expect(settings).toEqual({ user_name: 'restored-user' });
        } finally {
            engine.close();
        }
    });

    const INVALID_SCHEMA_AND_DATA_CASES = [
        ['missing-column', (db) => {
            db.exec('DROP TABLE chat_states; DROP TABLE chats; CREATE TABLE chats (handle TEXT); CREATE TABLE chat_states (handle TEXT)');
        }],
        ['trigger', (db) => {
            db.exec('CREATE TRIGGER unexpected AFTER INSERT ON settings BEGIN DELETE FROM stats; END');
        }],
        ['view', (db) => {
            db.exec('CREATE VIEW unexpected_view AS SELECT 1 AS x');
        }],
        ['virtual-table', (db) => {
            db.exec('CREATE VIRTUAL TABLE extra_fts USING fts5(content)');
        }],
        ['negative-user-version', (db) => {
            db.pragma('user_version = -1');
        }],
        ['future-user-version', (db) => {
            db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
        }],
        ['v1-with-preexisting-revision-column', (db) => {
            db.pragma('user_version = 1');
        }],
        ['orphan-chat-state-row', (db) => {
            db.pragma('foreign_keys = OFF');
            db.prepare('INSERT INTO chat_states (handle, char_dir, name, is_group, group_id, namespace, doc) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run('u', 'Ghost', 'missing-chat', 0, '', 'ns', '{}');
        }],
        ['missing-generated-integrity', (db) => {
            db.pragma('foreign_keys = OFF');
            db.exec(`DROP TABLE chats; CREATE TABLE chats (
                handle TEXT NOT NULL, char_dir TEXT NOT NULL, name TEXT NOT NULL,
                is_group INTEGER NOT NULL DEFAULT 0, group_id TEXT NOT NULL DEFAULT '',
                doc TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (handle, char_dir, name, is_group, group_id)
            )`);
        }],
    ];

    test.each(INVALID_SCHEMA_AND_DATA_CASES)('rejects %s before replacing live data and keeps connection usable', async (defect, mutate) => {
        const dir = await managedDir(`sqlite-invalid-${defect}`);
        const root = path.join(dir, 'u');
        const engine = new SqliteEngine({ directoriesByHandle: () => ({ root }) });
        try {
            await engine.withTransaction('u', tx => tx.putResource({ kind: 'settings', handle: 'u' }, { doc: { protected: true } }));
            const file = buildValidDb(path.join(dir, 'bad.sqlite'), { mutate });

            await expect(engine.restoreUser('u', Readable.from(fs.readFileSync(file))))
                .rejects.toBeInstanceOf(RestoreDumpInvalidError);

            // Live data and cached connection remain completely intact and writable.
            expect(await engine.withTransaction('u', tx => tx.getResource({ kind: 'settings', handle: 'u' })))
                .toEqual({ protected: true });
            await engine.withTransaction('u', tx => tx.putResource({ kind: 'settings', handle: 'u' }, { doc: { protected: true, afterRejectWrite: true } }));
            expect(await engine.withTransaction('u', tx => tx.getResource({ kind: 'settings', handle: 'u' })))
                .toEqual({ protected: true, afterRejectWrite: true });
            expect(fs.readdirSync(root).filter(name => name.includes('restore-'))).toEqual([]);
        } finally {
            engine.close();
        }
    });

    test('distinguishes operational filesystem errors from RestoreDumpInvalidError', async () => {
        const dir = await managedDir('sqlite-operational-err');
        const missing = path.join(dir, 'does-not-exist.sqlite');
        const err = await assertValidSqliteFile(missing).then(() => null, e => e);
        expect(err).not.toBeNull();
        expect(err).not.toBeInstanceOf(RestoreDumpInvalidError);
        expect(err.code).toBe('ENOENT');
    });

    test('stages incoming restore bytes beside the destination and cleans interrupted streams', async () => {
        const dir = await managedDir('sqlite-stage');
        const root = path.join(dir, 'u');
        const engine = new SqliteEngine({ directoriesByHandle: () => ({ root }) });
        try {
            await engine.withTransaction('u', tx => tx.putResource({ kind: 'settings', handle: 'u' }, { doc: { protected: true } }));
            const incoming = new Readable({ read() {} });
            const result = engine.restoreUser('u', incoming).then(() => null, error => error);
            incoming.push(Buffer.from('SQLite format 3\0'));
            const { setImmediate } = await import('node:timers/promises');
            let staged = [];
            for (let attempt = 0; attempt < 100 && staged.length === 0; attempt++) {
                staged = fs.readdirSync(root).filter(name => name.includes('restore-'));
                await setImmediate();
            }
            incoming.destroy(new Error('interrupted'));
            expect(await result).toMatchObject({ message: 'interrupted' });
            expect(staged).toHaveLength(1);
            expect(fs.readdirSync(root).filter(name => name.includes('restore-'))).toEqual([]);
            expect(await engine.withTransaction('u', tx => tx.getResource({ kind: 'settings', handle: 'u' }))).toEqual({ protected: true });
        } finally {
            engine.close();
        }
    });

    test('leaves no -wal or -shm files next to a validated WAL database', async () => {
        const dir = await managedDir('sqlite-wal-clean');
        const engine = new SqliteEngine({ directoriesByHandle: () => ({ root: path.join(dir, 'u') }) });
        try {
            await engine.withTransaction('u', async (tx) => {
                await tx.putResource({ kind: 'settings', handle: 'u' }, { doc: { user_name: 'wal' } });
            });
            const dump = await streamToBuffer(await engine.dumpUser('u'));
            engine.close();
            const filePath = path.join(dir, 'dump.sqlite');
            fs.writeFileSync(filePath, dump);

            await assertValidSqliteFile(filePath);

            expect(fs.readdirSync(dir).sort()).toEqual(['dump.sqlite', 'u']);
        } finally {
            engine.close();
        }
    });

    test.each(['sqlite', 'fs'])('HTTP /api/users/restore-backup on %s rejects structurally invalid SQLite dump with 400 before mutating account files', async (serverMode) => {
        const harness = await makeEndpointHarness({
            mode: serverMode,
            mount: (app) => app.use('/api/users', usersPrivateRouter),
        });
        globalThis.DATA_ROOT = harness.dataRoot;
        await getSettingsRepo().save(harness.handle, { user_name: 'original-live' });
        await getWorldInfoRepo().save(harness.handle, 'live-book', { entries: { '0': { content: 'keep' } } });
        const secretsPath = path.join(harness.dirs.root, 'secrets.json');
        fs.writeFileSync(secretsPath, JSON.stringify({ api_key_custom: 'keep-secret' }));

        const scratch = await managedDir(`sqlite-http-bad-${serverMode}`);
        const badSqlite = buildValidDb(path.join(scratch, 'bad-integrity.sqlite'), {
            mutate: (db) => {
                db.pragma('foreign_keys = OFF');
                db.exec(`DROP TABLE chats; CREATE TABLE chats (
                    handle TEXT NOT NULL, char_dir TEXT NOT NULL, name TEXT NOT NULL,
                    is_group INTEGER NOT NULL DEFAULT 0, group_id TEXT NOT NULL DEFAULT '',
                    doc TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
                    PRIMARY KEY (handle, char_dir, name, is_group, group_id)
                )`);
            },
        });

        // Deliberately place secrets.json BEFORE _engine_dump.bin in the archive to verify
        // invalid dump rejection happens before mutating account files even in merge mode.
        const zipBytes = await buildArchiveBuffer([
            { name: 'manifest.json', content: JSON.stringify({ schemaVersion: 1, handle: harness.handle }) },
            { name: ENGINE_META_ENTRY, content: JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle: harness.handle }) },
            { name: 'secrets.json', content: JSON.stringify({ api_key_custom: 'overwritten-secret' }) },
            { name: ENGINE_DUMP_ENTRY, content: fs.readFileSync(badSqlite) },
        ]);

        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const res = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });

        expect(res.status).toBe(400);
        expect(JSON.parse(fs.readFileSync(secretsPath, 'utf8'))).toEqual({ api_key_custom: 'keep-secret' });
        expect(await getSettingsRepo().get(harness.handle)).toEqual({ user_name: 'original-live' });
        expect(await getWorldInfoRepo().get(harness.handle, 'live-book')).toEqual({ entries: { '0': { content: 'keep' } } });
    });

    test('HTTP /api/users/restore-backup on sqlite rejects backup with _engine_meta.json missing _engine_dump.bin with 400', async () => {
        const harness = await makeEndpointHarness({
            mode: 'sqlite',
            mount: (app) => app.use('/api/users', usersPrivateRouter),
        });
        globalThis.DATA_ROOT = harness.dataRoot;
        await getSettingsRepo().save(harness.handle, { user_name: 'original-live' });

        const zipBytes = await buildArchiveBuffer([
            { name: 'manifest.json', content: JSON.stringify({ schemaVersion: 1, handle: harness.handle }) },
            { name: ENGINE_META_ENTRY, content: JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle: harness.handle }) },
        ]);
        const uploadId = await uploadArchiveToSession(harness.server, zipBytes, { handle: harness.handle });
        const res = await request(harness.server)
            .post('/api/users/restore-backup')
            .send({ uploadId, handle: harness.handle, mode: 'merge', selection: ALL_SELECTION });

        expect(res.status).toBe(400);
        expect(await getSettingsRepo().get(harness.handle)).toEqual({ user_name: 'original-live' });
    });
});
