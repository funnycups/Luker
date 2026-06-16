import { makeTempPgEngineHarness } from '../harness/pg-harness.js';
import { CURRENT_SCHEMA_VERSION, initSchema } from '../../../src/storage/engines/postgres-schema.js';

describe('PgEngine schema bootstrap', () => {
    let harness;
    beforeEach(async () => {
        harness = await makeTempPgEngineHarness();
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
        const r = await harness.engine._pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = current_schema() ORDER BY table_name`,
        );
        const names = r.rows.map((row) => row.table_name);
        expect(names).toEqual(expect.arrayContaining([
            '_storage_meta',
            'chats', 'chat_states', 'settings', 'presets', 'preset_states',
            'worlds', 'named_docs', 'groups_table', 'stats',
        ]));
        // Storage tables (9: chats, chat_states, settings, presets,
        // preset_states, worlds, named_docs, groups_table, stats) + meta = 10.
        expect(names.length).toBe(10);
    });

    test('chats.integrity is a STORED GENERATED column on doc #>> path', async () => {
        const r = await harness.engine._pool.query(
            `SELECT column_name, generation_expression, is_generated, data_type
             FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'chats' AND column_name = 'integrity'`,
        );
        expect(r.rows.length).toBe(1);
        const col = r.rows[0];
        // is_generated is 'ALWAYS' for STORED generated columns in Postgres.
        expect(String(col.is_generated).toUpperCase()).toBe('ALWAYS');
        // The generation expression must extract from the chat_metadata.integrity
        // JSON path via #>> (returns text). Postgres normalises the stored
        // expression so we assert on the presence of the path segments and
        // the #>> operator rather than the exact byte sequence.
        const expr = String(col.generation_expression).toLowerCase();
        expect(expr).toContain('#>>');
        expect(expr).toContain('integrity');
        expect(expr).toContain('chat_metadata');
        expect(expr).toContain('header');
        // integrity column is TEXT (the operator chosen returns text).
        expect(String(col.data_type).toLowerCase()).toBe('text');
    });

    test('integrity column actually extracts the value on insert', async () => {
        await harness.engine._pool.query(
            `INSERT INTO chats (handle, char_dir, name, is_group, group_id, doc, updated_at, created_at)
             VALUES ($1, $2, $3, 0, '', $4::jsonb, $5, $6)`,
            [harness.handle, 'TestChar', 'chat1',
                JSON.stringify({ header: { chat_metadata: { integrity: 'abc-123' } }, body: [] }),
                100, 100],
        );
        const r = await harness.engine._pool.query(
            'SELECT integrity FROM chats WHERE handle=$1 AND char_dir=$2 AND name=$3',
            [harness.handle, 'TestChar', 'chat1'],
        );
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].integrity).toBe('abc-123');
    });

    test('_storage_meta.schema_version reads "1" after initSchema', async () => {
        const r = await harness.engine._pool.query(
            `SELECT value FROM _storage_meta WHERE "key" = 'schema_version'`,
        );
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].value).toBe('1');
    });

    test('initSchema is idempotent — second call is a no-op', async () => {
        // First call already ran via ping. Second direct call must not throw.
        await expect(initSchema(harness.engine._pool)).resolves.toBeUndefined();
        // And the version row stays at 1 (not duplicated, not bumped).
        const r = await harness.engine._pool.query(
            `SELECT value FROM _storage_meta WHERE "key" = 'schema_version'`,
        );
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].value).toBe('1');
    });
});
