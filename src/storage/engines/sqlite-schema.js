export const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_V1 = [
    `CREATE TABLE IF NOT EXISTS chats (
        handle TEXT NOT NULL,
        char_dir TEXT NOT NULL,
        name TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        group_id TEXT NOT NULL DEFAULT '',
        doc TEXT NOT NULL,
        integrity TEXT GENERATED ALWAYS AS (json_extract(doc, '$.header.chat_metadata.integrity')) STORED,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (handle, char_dir, name, is_group, group_id)
    )`,
    `CREATE INDEX IF NOT EXISTS chats_updated ON chats(handle, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS chat_states (
        handle TEXT NOT NULL,
        char_dir TEXT NOT NULL,
        name TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        group_id TEXT NOT NULL DEFAULT '',
        namespace TEXT NOT NULL,
        doc TEXT NOT NULL,
        PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace),
        FOREIGN KEY (handle, char_dir, name, is_group, group_id)
            REFERENCES chats(handle, char_dir, name, is_group, group_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
        handle TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS presets (
        handle TEXT NOT NULL,
        dir_key TEXT NOT NULL,
        name TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (handle, dir_key, name)
    )`,
    // No FK to presets — legacy preset state behavior is permissive about orphan
    // sidecars; an FK would enforce parent-exists and break that contract.
    `CREATE TABLE IF NOT EXISTS preset_states (
        handle TEXT NOT NULL,
        dir_key TEXT NOT NULL,
        name TEXT NOT NULL,
        namespace TEXT NOT NULL,
        doc TEXT NOT NULL,
        PRIMARY KEY (handle, dir_key, name, namespace)
    )`,
    `CREATE TABLE IF NOT EXISTS worlds (
        handle TEXT NOT NULL,
        name TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (handle, name)
    )`,
    `CREATE TABLE IF NOT EXISTS named_docs (
        handle TEXT NOT NULL,
        bucket TEXT NOT NULL,
        name TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (handle, bucket, name)
    )`,
    // `groups` is a reserved word in SQL (window functions); avoid it.
    `CREATE TABLE IF NOT EXISTS groups_table (
        handle TEXT NOT NULL,
        id TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (handle, id)
    )`,
    `CREATE TABLE IF NOT EXISTS stats (
        handle TEXT PRIMARY KEY,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
];

export function initSchema(db) {
    const current = db.pragma('user_version', { simple: true });
    if (current === 0) {
        db.exec('BEGIN');
        try {
            for (const stmt of SCHEMA_V1) db.exec(stmt);
            db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    } else if (current > CURRENT_SCHEMA_VERSION) {
        throw new Error(`SqliteEngine: db schema version ${current} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
    }
}
