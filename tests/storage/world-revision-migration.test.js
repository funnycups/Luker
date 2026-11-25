import fs from 'node:fs';
import { makeTempMysqlEngineHarness } from './harness/mysql-harness.js';
import { makeTempPgEngineHarness } from './harness/pg-harness.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';

describe.each([
    { kind: 'mysql', make: () => makeTempMysqlEngineHarness({ fresh: true }) },
    { kind: 'postgres', make: makeTempPgEngineHarness },
])('existing world documents through $kind revision migration', ({ kind, make }) => {
    let h;
    const book = { entries: { '7': { uid: 7, content: 'Preserved legacy document', retained: ['entry sibling'] } }, extensions: { sibling: { enabled: false } } };

    beforeEach(async () => {
        h = await make();
        const pool = h.engine._pool;
        const sql = fs.readFileSync(new URL(`../../src/storage/engines/migrations/${kind}/0001-initial.sql`, import.meta.url), 'utf8');
        for (const statement of sql.split(/;\s*\n/).map(text => text.trim()).filter(Boolean)) await pool.query(statement);
        await pool.query(kind === 'mysql' ? 'CREATE TABLE _storage_meta (`key` VARCHAR(128) PRIMARY KEY, value VARCHAR(128))' : 'CREATE TABLE _storage_meta ("key" VARCHAR(128) PRIMARY KEY, value VARCHAR(128))');
        await pool.query(kind === 'mysql' ? 'INSERT INTO _storage_meta (`key`, value) VALUES (\'schema_version\', \'1\')' : 'INSERT INTO _storage_meta ("key", value) VALUES (\'schema_version\', \'1\')');
        await pool.query(kind === 'mysql' ? 'INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)' : 'INSERT INTO worlds (handle, name, doc, updated_at) VALUES ($1, $2, $3::jsonb, $4)', [h.handle, 'Owned', JSON.stringify(book), 100]);
    });
    afterEach(async () => { await h.cleanup(); });

    test('legacy rows survive schema upgrade and restored dumps do not revive old receipts', async () => {
        await h.engine.ping(h.handle);
        const worlds = new WorldInfoRepo({ engine: h.engine });
        const settings = new SettingsRepo({ engine: h.engine });
        expect(await worlds.get(h.handle, 'Owned')).toEqual(book);
        expect(await worlds.getVersion(h.handle, 'Owned')).toBeNull();
        const originalVersion = await worlds.save(h.handle, 'Owned', book);
        expect(typeof originalVersion).toBe('string');
        const doc = { world_info_settings: { world_info: { charLore: [] } }, sibling: ['settings'] };
        await settings.save(h.handle, doc);
        const dump = await h.engine.dumpUser(h.handle);
        await h.engine.restoreUser(h.handle, dump);
        expect(await worlds.get(h.handle, 'Owned')).toEqual(book);
        expect(await settings.get(h.handle)).toEqual(doc);
        expect(await worlds.getVersion(h.handle, 'Owned')).toBeNull();
        await expect(worlds.delete(h.handle, 'Owned', { expectedVersion: originalVersion })).rejects.toMatchObject({ code: 'world_changed' });
        const restoredVersion = await worlds.save(h.handle, 'Owned', book);
        expect(restoredVersion).not.toBe(originalVersion);
        expect(await worlds.delete(h.handle, 'Owned', { expectedVersion: restoredVersion })).toBe(true);
        expect(await worlds.get(h.handle, 'Owned')).toBeNull();
    });

    test('migration 0002 is idempotent when worlds.revision already exists while schema_version is still 1', async () => {
        const pool = h.engine._pool;
        // Simulate a crash after the 0002 DDL added worlds.revision and before
        // _storage_meta.schema_version was bumped from '1' to '2'.
        if (kind === 'mysql') {
            await pool.query('ALTER TABLE worlds ADD COLUMN revision VARCHAR(36) NULL');
            await pool.query('UPDATE worlds SET revision = ? WHERE handle = ? AND name = ?', ['pre-crash-rev', h.handle, 'Owned']);
        } else {
            await pool.query('ALTER TABLE worlds ADD COLUMN revision VARCHAR(36)');
            await pool.query('UPDATE worlds SET revision = $1 WHERE handle = $2 AND name = $3', ['pre-crash-rev', h.handle, 'Owned']);
        }

        await expect(h.engine.ping(h.handle)).resolves.toBeUndefined();

        const worlds = new WorldInfoRepo({ engine: h.engine });
        expect(await worlds.get(h.handle, 'Owned')).toEqual(book);
        expect(await worlds.getVersion(h.handle, 'Owned')).toBe('pre-crash-rev');
        const versionRows = kind === 'mysql'
            ? (await pool.query('SELECT value FROM _storage_meta WHERE `key` = \'schema_version\''))[0]
            : (await pool.query('SELECT value FROM _storage_meta WHERE "key" = \'schema_version\'')).rows;
        expect(versionRows[0].value).toBe('2');
    });
});
