import { makeTempMysqlEngineHarness } from '../harness/mysql-harness.js';
import { CURRENT_SCHEMA_VERSION, initSchema } from '../../../src/storage/engines/mysql-schema.js';

describe('MysqlEngine schema bootstrap', () => {
    let harness;
    beforeEach(async () => {
        harness = await makeTempMysqlEngineHarness();
        // ping triggers _ensureSchema -> initSchema once
        await harness.engine.ping(harness.handle);
    });
    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('CURRENT_SCHEMA_VERSION is 1', () => {
        expect(CURRENT_SCHEMA_VERSION).toBe(1);
    });

    test('all expected tables exist (9 storage + _storage_meta)', async () => {
        const [rows] = await harness.engine._pool.query(
            "SELECT TABLE_NAME FROM information_schema.TABLES " +
            "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
        );
        const names = rows.map(r => r.TABLE_NAME);
        expect(names).toEqual(expect.arrayContaining([
            '_storage_meta',
            'chats', 'chat_states', 'settings', 'presets', 'preset_states',
            'worlds', 'named_docs', 'groups_table', 'stats',
        ]));
        // Storage tables (9: chats, chat_states, settings, presets,
        // preset_states, worlds, named_docs, groups_table, stats) + meta = 10.
        expect(names.length).toBe(10);
    });

    test('chats.integrity is a STORED GENERATED column on JSON_UNQUOTE(JSON_EXTRACT(...))', async () => {
        const [rows] = await harness.engine._pool.query(
            "SELECT COLUMN_NAME, GENERATION_EXPRESSION, EXTRA, DATA_TYPE " +
            "FROM information_schema.COLUMNS " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chats' AND COLUMN_NAME = 'integrity'",
        );
        expect(rows.length).toBe(1);
        const col = rows[0];
        // EXTRA contains "STORED GENERATED" for STORED generated columns.
        expect(String(col.EXTRA).toUpperCase()).toContain('STORED GENERATED');
        // Generation expression must extract from the chat_metadata.integrity
        // JSON path AND unquote it (otherwise the column returns a JSON
        // string with surrounding quotes).
        const expr = String(col.GENERATION_EXPRESSION).toLowerCase();
        expect(expr).toContain('json_unquote');
        expect(expr).toContain('json_extract');
        expect(expr).toContain('integrity');
    });

    test('integrity column actually unquotes the value on insert', async () => {
        await harness.engine._pool.query(
            `INSERT INTO chats (handle, char_dir, name, is_group, group_id, doc, updated_at, created_at)
             VALUES (?, ?, ?, 0, '', ?, ?, ?)`,
            [harness.handle, 'TestChar', 'chat1',
                JSON.stringify({ header: { chat_metadata: { integrity: 'abc-123' } }, body: [] }),
                100, 100],
        );
        const [rows] = await harness.engine._pool.query(
            'SELECT integrity FROM chats WHERE handle=? AND char_dir=? AND name=?',
            [harness.handle, 'TestChar', 'chat1'],
        );
        expect(rows.length).toBe(1);
        expect(rows[0].integrity).toBe('abc-123');
    });

    test('_storage_meta.schema_version reads "1" after initSchema', async () => {
        const [rows] = await harness.engine._pool.query(
            "SELECT value FROM _storage_meta WHERE `key` = 'schema_version'",
        );
        expect(rows.length).toBe(1);
        expect(rows[0].value).toBe('1');
    });

    test('initSchema is idempotent — second call is a no-op', async () => {
        // First call already ran via ping. Second direct call must not throw.
        await expect(initSchema(harness.engine._pool)).resolves.toBeUndefined();
        // And the version row stays at 1 (not duplicated, not bumped).
        const [rows] = await harness.engine._pool.query(
            "SELECT value FROM _storage_meta WHERE `key` = 'schema_version'",
        );
        expect(rows.length).toBe(1);
        expect(rows[0].value).toBe('1');
    });
});
