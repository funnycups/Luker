export const CURRENT_SCHEMA_VERSION = 1;

// MySQL 8 schema mirroring sqlite-schema.js. Key dialect choices:
//   - VARCHAR(128) on PK string columns. The plan called for VARCHAR(128)
//     against the legacy 767-byte single-column index prefix limit, but MySQL
//     applies its 3072-byte limit to the WHOLE composite key. With utf8mb4
//     (4 bytes/char), the worst-case PK in this schema is chat_states with
//     five VARCHAR columns + 1 TINYINT (5*128*4 + 1 = 2561 bytes), which
//     fits; VARCHAR(128) would overflow (5*190*4 + 1 = 3801 > 3072). 128 is
//     also plenty for chat / world / preset names we observe in practice.
//   - utf8mb4_bin collation: case-sensitive comparisons mirror Linux fs
//     semantics so WorldInfo tolerant-resolver tests keep parity.
//   - JSON column for `doc`: native binary-stored JSON in MySQL 8.
//   - integrity is GENERATED ALWAYS AS ... STORED from doc; JSON_UNQUOTE is
//     required because JSON_EXTRACT returns a quoted JSON string ("abc"),
//     not the bare value.
//   - chat_states has FK with ON DELETE CASCADE (strict parent contract);
//     preset_states deliberately has no FK (permissive sidecar policy,
//     mirrors the sqlite-schema.js comment).
//   - `groups_table`, not `groups`, because GROUPS is a reserved word in
//     SQL window-function syntax and some MySQL builds reject the bare form.
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

const SCHEMA_V1 = [
    `CREATE TABLE IF NOT EXISTS chats (
        handle VARCHAR(128) NOT NULL,
        char_dir VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        is_group TINYINT NOT NULL DEFAULT 0,
        group_id VARCHAR(128) NOT NULL DEFAULT '',
        doc JSON NOT NULL,
        integrity VARCHAR(64) GENERATED ALWAYS AS
            (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.header.chat_metadata.integrity'))) STORED,
        updated_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (handle, char_dir, name, is_group, group_id)
    ) ${TABLE_OPTS}`,
    `CREATE INDEX chats_updated ON chats(handle, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS chat_states (
        handle VARCHAR(128) NOT NULL,
        char_dir VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        is_group TINYINT NOT NULL DEFAULT 0,
        group_id VARCHAR(128) NOT NULL DEFAULT '',
        namespace VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace),
        CONSTRAINT chat_states_fk_chats
            FOREIGN KEY (handle, char_dir, name, is_group, group_id)
            REFERENCES chats(handle, char_dir, name, is_group, group_id)
            ON DELETE CASCADE
    ) ${TABLE_OPTS}`,
    `CREATE TABLE IF NOT EXISTS settings (
        handle VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle)
    ) ${TABLE_OPTS}`,
    `CREATE TABLE IF NOT EXISTS presets (
        handle VARCHAR(128) NOT NULL,
        dir_key VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle, dir_key, name)
    ) ${TABLE_OPTS}`,
    // No FK to presets — legacy preset state behavior is permissive about
    // orphan sidecars; an FK would enforce parent-exists and break that
    // contract (see sqlite-schema.js for the same rationale).
    `CREATE TABLE IF NOT EXISTS preset_states (
        handle VARCHAR(128) NOT NULL,
        dir_key VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        namespace VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        PRIMARY KEY (handle, dir_key, name, namespace)
    ) ${TABLE_OPTS}`,
    `CREATE TABLE IF NOT EXISTS worlds (
        handle VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle, name)
    ) ${TABLE_OPTS}`,
    `CREATE TABLE IF NOT EXISTS named_docs (
        handle VARCHAR(128) NOT NULL,
        bucket VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle, bucket, name)
    ) ${TABLE_OPTS}`,
    // `groups` is a reserved word in SQL (window functions); use groups_table.
    `CREATE TABLE IF NOT EXISTS groups_table (
        handle VARCHAR(128) NOT NULL,
        id VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (handle, id)
    ) ${TABLE_OPTS}`,
    `CREATE TABLE IF NOT EXISTS stats (
        handle VARCHAR(128) NOT NULL,
        doc JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle)
    ) ${TABLE_OPTS}`,
];

const META_TABLE = `CREATE TABLE IF NOT EXISTS _storage_meta (
    \`key\` VARCHAR(128) NOT NULL,
    value VARCHAR(128) NOT NULL,
    PRIMARY KEY (\`key\`)
) ${TABLE_OPTS}`;

async function readSchemaVersion(pool) {
    // Detect _storage_meta presence first so we don't blow up on the very
    // first init (table doesn't exist yet).
    const [tables] = await pool.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_storage_meta'`,
    );
    if (!tables.length) return null;
    const [rows] = await pool.query(
        "SELECT value FROM _storage_meta WHERE `key` = 'schema_version'",
    );
    if (!rows.length) return null;
    return Number(rows[0].value);
}

export async function initSchema(pool) {
    const current = await readSchemaVersion(pool);
    if (current === CURRENT_SCHEMA_VERSION) return;
    if (current !== null && current > CURRENT_SCHEMA_VERSION) {
        throw new Error(`MysqlEngine: db schema version ${current} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
    }
    // CREATE TABLE IF NOT EXISTS makes each statement idempotent; the index
    // CREATE has no IF NOT EXISTS in MySQL 8, so we tolerate the duplicate
    // error individually.
    await pool.query(META_TABLE);
    for (const stmt of SCHEMA_V1) {
        try {
            await pool.query(stmt);
        } catch (err) {
            // ER_DUP_KEYNAME on the chats_updated index re-create is the only
            // expected duplicate; rethrow anything else.
            if (err && err.code === 'ER_DUP_KEYNAME') continue;
            throw err;
        }
    }
    await pool.query(
        "INSERT INTO _storage_meta (`key`, value) VALUES ('schema_version', ?) " +
        'ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [String(CURRENT_SCHEMA_VERSION)],
    );
}
