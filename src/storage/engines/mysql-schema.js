import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './schema-runner.js';

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
//
// Statements live in ./migrations/mysql/0001-initial.sql; this module is now
// a thin wrapper that bootstraps `_storage_meta` (using the existing `key`/
// `value` column shape — DO NOT rename, operators on schema_version=1 already
// have rows keyed by these names) and delegates to the shared migration runner.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const META_TABLE = `CREATE TABLE IF NOT EXISTS _storage_meta (
    \`key\` VARCHAR(128) NOT NULL,
    value VARCHAR(128) NOT NULL,
    PRIMARY KEY (\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;

export async function initSchema(pool) {
    // Bootstrap meta table first so we can read the current version even on a
    // fresh database. Idempotent via IF NOT EXISTS; column names match the
    // pre-runner schema exactly so existing schema_version=1 rows are reused.
    await pool.query(META_TABLE);

    await runMigrations({
        kind: 'mysql',
        executor: async (sql) => {
            // Migration files are author-controlled, no string literals containing
            // semicolons; naive split on `;\n` is sufficient. Each resulting
            // statement runs independently because MySQL 8 has no `CREATE INDEX
            // IF NOT EXISTS` and we must tolerate ER_DUP_KEYNAME on re-runs of
            // CREATE INDEX statements (the rest stay idempotent via
            // CREATE TABLE IF NOT EXISTS).
            const stmts = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
            for (const stmt of stmts) {
                try {
                    await pool.query(stmt);
                } catch (err) {
                    if (err && err.code === 'ER_DUP_KEYNAME') continue;
                    throw err;
                }
            }
        },
        migrationsDir: MIGRATIONS_DIR,
        readVersion: async () => {
            // `_storage_meta` exists (we just bootstrapped it), but it may
            // be empty on a virgin database — return 0 in that case so the
            // runner applies 0001-initial.sql.
            const [rows] = await pool.query(
                "SELECT value FROM _storage_meta WHERE `key` = 'schema_version'",
            );
            return rows.length === 0 ? 0 : Number(rows[0].value);
        },
        writeVersion: async (n) => {
            await pool.query(
                'INSERT INTO _storage_meta (`key`, value) VALUES (?, ?) ' +
                'ON DUPLICATE KEY UPDATE value = VALUES(value)',
                ['schema_version', String(n)],
            );
        },
    });
}
