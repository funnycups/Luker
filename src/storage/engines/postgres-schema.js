export const CURRENT_SCHEMA_VERSION = 1;

// Postgres 16 schema mirroring sqlite-schema.js / mysql-schema.js. Key dialect
// choices:
//   - Identifier quoting uses double-quotes (Postgres standard), not backticks.
//     We only quote `"_storage_meta"` and the `"key"` reserved word; bare table
//     names are fine unquoted because they don't collide with Postgres
//     reserved words (GROUPS is reserved in SQL window functions, hence the
//     same groups_table rename SQLite/MySQL use).
//   - VARCHAR(128) on PK string columns. Postgres has no InnoDB-style 3072-byte
//     composite key limit (the btree row limit is ~8KB), but VARCHAR(128) is
//     plenty for chat / world / preset names we observe in practice and keeps
//     parity with the MySQL schema.
//   - JSONB for `doc`: binary-stored, indexable, returns parsed JS objects from
//     the `pg` driver by default. Choose JSONB over JSON for that reason.
//   - integrity is GENERATED ALWAYS AS ... STORED via `doc #>> '{path}'`.
//     Postgres's `#>>` returns text (the trailing `>` chooses text vs json),
//     which is exactly what we want — equivalent to MySQL's
//     JSON_UNQUOTE(JSON_EXTRACT(...)).
//   - is_group is SMALLINT (not BOOLEAN) so handlers stay byte-for-byte parallel
//     with the MySQL handlers that bind 0/1.
//   - chat_states has FK with ON DELETE CASCADE (strict parent contract);
//     preset_states deliberately has no FK (permissive sidecar policy,
//     mirrors sqlite-schema.js / mysql-schema.js).
//   - No table-options clause (ENGINE=InnoDB etc. don't exist in Postgres).
//   - CREATE INDEX IF NOT EXISTS is supported in Postgres (since 9.5), so
//     unlike MySQL we don't need the ER_DUP_KEYNAME swallow.

const SCHEMA_V1 = [
    `CREATE TABLE IF NOT EXISTS chats (
        handle VARCHAR(128) NOT NULL,
        char_dir VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        is_group SMALLINT NOT NULL DEFAULT 0,
        group_id VARCHAR(128) NOT NULL DEFAULT '',
        doc JSONB NOT NULL,
        integrity TEXT GENERATED ALWAYS AS (doc #>> '{header,chat_metadata,integrity}') STORED,
        updated_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (handle, char_dir, name, is_group, group_id)
    )`,
    `CREATE INDEX IF NOT EXISTS chats_updated ON chats(handle, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS chat_states (
        handle VARCHAR(128) NOT NULL,
        char_dir VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        is_group SMALLINT NOT NULL DEFAULT 0,
        group_id VARCHAR(128) NOT NULL DEFAULT '',
        namespace VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace),
        CONSTRAINT chat_states_fk_chats
            FOREIGN KEY (handle, char_dir, name, is_group, group_id)
            REFERENCES chats(handle, char_dir, name, is_group, group_id)
            ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
        handle VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle)
    )`,
    `CREATE TABLE IF NOT EXISTS presets (
        handle VARCHAR(128) NOT NULL,
        dir_key VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle, dir_key, name)
    )`,
    // No FK to presets — legacy preset state behavior is permissive about
    // orphan sidecars; an FK would enforce parent-exists and break that
    // contract (see sqlite-schema.js / mysql-schema.js for the same rationale).
    `CREATE TABLE IF NOT EXISTS preset_states (
        handle VARCHAR(128) NOT NULL,
        dir_key VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        namespace VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        PRIMARY KEY (handle, dir_key, name, namespace)
    )`,
    `CREATE TABLE IF NOT EXISTS worlds (
        handle VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle, name)
    )`,
    `CREATE TABLE IF NOT EXISTS named_docs (
        handle VARCHAR(128) NOT NULL,
        bucket VARCHAR(128) NOT NULL,
        name VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle, bucket, name)
    )`,
    // `groups` is a reserved word in SQL (window functions); use groups_table.
    `CREATE TABLE IF NOT EXISTS groups_table (
        handle VARCHAR(128) NOT NULL,
        id VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (handle, id)
    )`,
    `CREATE TABLE IF NOT EXISTS stats (
        handle VARCHAR(128) NOT NULL,
        doc JSONB NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (handle)
    )`,
];

// "key" is a reserved word in standard SQL — double-quote it everywhere we
// reference it. The table name itself does not collide.
const META_TABLE = `CREATE TABLE IF NOT EXISTS _storage_meta (
    "key" VARCHAR(128) NOT NULL,
    value VARCHAR(128) NOT NULL,
    PRIMARY KEY ("key")
)`;

async function readSchemaVersion(pool) {
    // Detect _storage_meta presence first so we don't blow up on the very
    // first init (table doesn't exist yet). information_schema honours the
    // pool connection's search_path automatically when we filter on
    // current_schema(); but to stay defensive against multi-schema search
    // paths we also restrict by current_schema().
    const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = '_storage_meta'`,
    );
    if (!tables.rows.length) return null;
    const rows = await pool.query(
        `SELECT value FROM _storage_meta WHERE "key" = 'schema_version'`,
    );
    if (!rows.rows.length) return null;
    return Number(rows.rows[0].value);
}

export async function initSchema(pool) {
    const current = await readSchemaVersion(pool);
    if (current === CURRENT_SCHEMA_VERSION) return;
    if (current !== null && current > CURRENT_SCHEMA_VERSION) {
        throw new Error(`PgEngine: db schema version ${current} is newer than supported ${CURRENT_SCHEMA_VERSION}`);
    }
    await pool.query(META_TABLE);
    // CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS make every
    // statement idempotent in Postgres, so unlike MySQL we don't need to
    // swallow duplicate-index errors.
    for (const stmt of SCHEMA_V1) {
        await pool.query(stmt);
    }
    await pool.query(
        `INSERT INTO _storage_meta ("key", value) VALUES ('schema_version', $1)
         ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value`,
        [String(CURRENT_SCHEMA_VERSION)],
    );
}
