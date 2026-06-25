import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './schema-runner.js';

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
//
// Statements live in ./migrations/postgres/0001-initial.sql; this module is
// now a thin wrapper that bootstraps `_storage_meta` (using the existing
// `"key"`/`value` column shape — DO NOT rename, operators on schema_version=1
// already have rows keyed by these names) and delegates to the shared
// migration runner.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// "key" is a reserved word in standard SQL — double-quote it everywhere we
// reference it. The table name itself does not collide.
const META_TABLE = `CREATE TABLE IF NOT EXISTS _storage_meta (
    "key" VARCHAR(128) NOT NULL,
    value VARCHAR(128) NOT NULL,
    PRIMARY KEY ("key")
)`;

export async function initSchema(pool) {
    // Bootstrap meta table first so we can read the current version even on a
    // fresh database. Idempotent via IF NOT EXISTS; column names match the
    // pre-runner schema exactly so existing schema_version=1 rows are reused.
    await pool.query(META_TABLE);

    await runMigrations({
        kind: 'postgres',
        executor: async (sql) => {
            // Postgres can execute multi-statement strings via `pool.query(sql)`,
            // but we still split on `;\n` to keep error reporting localized to
            // the failing statement (the driver reports parse errors at the
            // beginning of the multi-statement payload otherwise). CREATE TABLE
            // IF NOT EXISTS and CREATE INDEX IF NOT EXISTS make every statement
            // re-runnable, so we don't need a per-statement try/catch like
            // mysql's ER_DUP_KEYNAME path.
            const stmts = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
            for (const stmt of stmts) {
                await pool.query(stmt);
            }
        },
        migrationsDir: MIGRATIONS_DIR,
        readVersion: async () => {
            const r = await pool.query(
                `SELECT value FROM _storage_meta WHERE "key" = 'schema_version'`,
            );
            return r.rows.length === 0 ? 0 : Number(r.rows[0].value);
        },
        writeVersion: async (n) => {
            await pool.query(
                `INSERT INTO _storage_meta ("key", value) VALUES ('schema_version', $1)
                 ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value`,
                [String(n)],
            );
        },
    });
}
