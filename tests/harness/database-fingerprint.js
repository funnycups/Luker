import { failureGroup } from './resources/errors.js';
import { withMysql, withPostgres } from './database-service.js';

export async function mysqlFingerprint(connection, namespace) {
    const [columns] = await connection.query(
        'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME, COLLATION_NAME, EXTRA, GENERATION_EXPRESSION ' +
        'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION', [namespace]);
    const [indexes] = await connection.query(
        'SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE ' +
        'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', [namespace]);
    const [tables] = await connection.query(
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [namespace]);
    const [foreignKeys] = await connection.query(
        'SELECT TABLE_NAME, CONSTRAINT_NAME, UNIQUE_CONSTRAINT_NAME, MATCH_OPTION, UPDATE_RULE, DELETE_RULE ' +
        'FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME', [namespace]);
    const [foreignKeyColumns] = await connection.query(
        'SELECT TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME ' +
        'FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ' +
        'ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION', [namespace]);
    const [triggers] = await connection.query(
        'SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_ORDER, ACTION_STATEMENT, ACTION_TIMING ' +
        'FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME', [namespace]);
    const meta = tables.some(table => table.TABLE_NAME === '_storage_meta') ? (await connection.query('SELECT `key`, value FROM _storage_meta ORDER BY `key`'))[0] : null;
    return JSON.stringify({ columns, indexes, tables, foreignKeys, foreignKeyColumns, triggers, meta });
}

export async function emptyMysql(connection, namespace) {
    const [tables] = await connection.query(
        'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> \'_storage_meta\'', [namespace]);
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.beginTransaction();
    try {
        for (const { name } of tables) await connection.query(`DELETE FROM \`${name}\``);
        await connection.commit();
    } catch (primary) {
        try { await connection.rollback(); }
        catch (cleanup) { throw failureGroup([primary, cleanup], `Database ${namespace} emptying and rollback failed`); }
        throw primary;
    }
}

/** Stable schema fingerprint used to prove migration reuse and detect drift. */
export async function fingerprintDatabase(lease) {
    if (lease.backend === 'mysql') return withMysql(lease.url, connection => mysqlFingerprint(connection, lease.namespace));
    if (lease.backend === 'postgres') return withPostgres(lease.url, async client => {
        const columns = await client.query('SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position', [lease.namespace]);
        const indexes = await client.query('SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY tablename, indexname', [lease.namespace]);
        const constraints = await client.query('SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = $1::regnamespace ORDER BY table_name, conname', [lease.namespace]);
        return JSON.stringify({ columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows });
    });
    throw new TypeError(`Unknown database backend: ${lease.backend}`);
}
