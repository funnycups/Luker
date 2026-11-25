import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { pipeline } from 'node:stream/promises';
import { SqliteTransaction } from './sqlite-engine-transaction.js';
import { initSchema, CURRENT_SCHEMA_VERSION } from './sqlite-schema.js';
import { RestoreDumpInvalidError } from '../errors.js';
import { TransactionOutcomeUnknownError } from '../transaction-outcome.js';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

const SQLITE_PAYLOAD_ERROR_PREFIXES = Object.freeze([
    'SQLITE_NOTADB',
    'SQLITE_CORRUPT',
    'SQLITE_FORMAT',
    'SQLITE_CONSTRAINT',
    'SQLITE_MISMATCH',
    'SQLITE_ERROR',
    'SQLITE_RANGE',
    'SQLITE_SCHEMA',
]);

import { USER_TABLES as SQLITE_USER_TABLES } from './user-tables.js';
export { SQLITE_USER_TABLES };

function isSqlitePayloadError(err) {
    if (err instanceof RestoreDumpInvalidError) return true;
    const code = String(err?.code || '');
    return SQLITE_PAYLOAD_ERROR_PREFIXES.some(prefix => code === prefix || code.startsWith(`${prefix}_`));
}

function quoteSqliteIdent(ident) {
    return `"${String(ident).replace(/"/g, '""')}"`;
}

/**
 * SQLite's documented 5-rule type affinity determination so equivalent type
 * aliases (e.g. VARCHAR/CLOB -> TEXT, INT/BIGINT -> INTEGER) match while
 * incompatible affinities are rejected.
 * @param {string} rawType
 * @returns {'INTEGER'|'TEXT'|'BLOB'|'REAL'|'NUMERIC'}
 */
function sqliteTypeAffinity(rawType) {
    const upper = String(rawType || '').toUpperCase();
    if (upper.includes('INT')) return 'INTEGER';
    if (upper.includes('CHAR') || upper.includes('CLOB') || upper.includes('TEXT')) return 'TEXT';
    if (upper === '' || upper.includes('BLOB')) return 'BLOB';
    if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'REAL';
    return 'NUMERIC';
}

function normalizeSqliteDefault(rawDefault) {
    if (rawDefault === null || rawDefault === undefined) return null;
    let value = String(rawDefault).trim();
    while (value.startsWith('(') && value.endsWith(')')) {
        let depth = 0;
        let wrapsAll = true;
        for (let i = 0; i < value.length - 1; i += 1) {
            if (value[i] === '(') depth += 1;
            else if (value[i] === ')') depth -= 1;
            if (depth === 0) {
                wrapsAll = false;
                break;
            }
        }
        if (!wrapsAll) break;
        value = value.slice(1, -1).trim();
    }
    if (value.toUpperCase() === 'NULL') return 'NULL';
    return value;
}

function normalizedForeignKeys(db, table) {
    const rows = db.pragma(`foreign_key_list(${quoteSqliteIdent(table)})`);
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.id)) groups.set(row.id, []);
        groups.get(row.id).push(row);
    }
    return [...groups.values()].map(group => JSON.stringify({
        table: String(group[0].table || '').toLowerCase(),
        on_delete: String(group[0].on_delete || 'NO ACTION').toUpperCase(),
        on_update: String(group[0].on_update || 'NO ACTION').toUpperCase(),
        pairs: group.map(r => `${r.from}->${r.to}`).sort(),
    })).sort();
}

function normalizedUniqueIndexes(db, table) {
    const indexes = db.pragma(`index_list(${quoteSqliteIdent(table)})`).filter(ix => ix.unique === 1);
    return indexes.map((ix) => {
        const info = db.pragma(`index_info(${quoteSqliteIdent(ix.name)})`);
        return {
            name: ix.name,
            partial: ix.partial,
            hasExpression: info.some(c => c.name === null),
            cols: info.map(c => c.name).filter(Boolean).sort(),
        };
    });
}

function validateTableSchema(db, expectedDb, table, { version, pendingAddedCols }) {
    const expectedCols = expectedDb.pragma(`table_xinfo(${quoteSqliteIdent(table)})`);
    const actualCols = db.pragma(`table_xinfo(${quoteSqliteIdent(table)})`);
    const actualByName = new Map(actualCols.map(c => [c.name, c]));
    const expectedByName = new Map(expectedCols.map(c => [c.name, c]));

    const missingColumns = expectedCols.filter(c => !actualByName.has(c.name));
    if (missingColumns.length > 0) {
        throw new RestoreDumpInvalidError(`not a Luker SQLite database: missing columns in ${table}: ${missingColumns.map(c => c.name).join(', ')}`);
    }

    for (const exp of expectedCols) {
        const act = actualByName.get(exp.name);
        const expGenerated = exp.hidden === 2 || exp.hidden === 3;
        const actGenerated = act.hidden === 2 || act.hidden === 3;
        if (expGenerated !== actGenerated) {
            throw new RestoreDumpInvalidError(`incompatible SQLite column kind in ${table}.${exp.name}`);
        }
        if (sqliteTypeAffinity(act.type) !== sqliteTypeAffinity(exp.type)) {
            throw new RestoreDumpInvalidError(`incompatible SQLite column type in ${table}.${exp.name}: ${act.type || '(empty)'}`);
        }
        if (exp.notnull === 1 && act.notnull !== 1) {
            throw new RestoreDumpInvalidError(`incompatible SQLite nullability in ${table}.${exp.name}: NOT NULL required`);
        }
        if (exp.notnull === 0 && exp.pk === 0 && act.notnull !== 0) {
            throw new RestoreDumpInvalidError(`incompatible SQLite nullability in ${table}.${exp.name}: column must allow NULL`);
        }
        if (exp.dflt_value !== null) {
            const expectedDefault = normalizeSqliteDefault(exp.dflt_value);
            const actualDefault = normalizeSqliteDefault(act.dflt_value);
            if (actualDefault !== expectedDefault) {
                throw new RestoreDumpInvalidError(`incompatible SQLite default in ${table}.${exp.name}`);
            }
        }
    }

    const pendingCols = pendingAddedCols.get(table);
    for (const act of actualCols) {
        if (expectedByName.has(act.name)) continue;
        if (version < CURRENT_SCHEMA_VERSION && pendingCols?.has(act.name)) {
            throw new RestoreDumpInvalidError(`SQLite schema version ${version} already contains migrated column ${table}.${act.name}`);
        }
        if (act.hidden === 0 && act.notnull === 1 && act.dflt_value === null) {
            throw new RestoreDumpInvalidError(`incompatible extra NOT NULL column without default in ${table}.${act.name}`);
        }
    }

    const expectedPkCols = expectedCols.filter(c => c.pk > 0).map(c => c.name).sort();
    const actualPkCols = actualCols.filter(c => c.pk > 0).map(c => c.name).sort();
    if (JSON.stringify(actualPkCols) !== JSON.stringify(expectedPkCols)) {
        throw new RestoreDumpInvalidError(`incompatible primary key on ${table}`);
    }

    const expectedUniqueKeys = new Set(
        normalizedUniqueIndexes(expectedDb, table)
            .filter(ix => ix.partial === 0 && !ix.hasExpression)
            .map(ix => JSON.stringify(ix.cols)),
    );
    const actualUniqueIndexes = normalizedUniqueIndexes(db, table);
    const pkKey = JSON.stringify(expectedPkCols);
    const hasMatchingPkUnique = actualUniqueIndexes.some(
        ix => ix.partial === 0 && !ix.hasExpression && JSON.stringify(ix.cols) === pkKey,
    );
    if (!hasMatchingPkUnique) {
        throw new RestoreDumpInvalidError(`missing unique primary-key index on ${table}`);
    }
    for (const ix of actualUniqueIndexes) {
        const key = JSON.stringify(ix.cols);
        if (ix.partial !== 0 || ix.hasExpression || !expectedUniqueKeys.has(key)) {
            throw new RestoreDumpInvalidError(`unexpected unique constraint on ${table} (${ix.name})`);
        }
    }

    const expectedFks = normalizedForeignKeys(expectedDb, table);
    const actualFks = normalizedForeignKeys(db, table);
    if (JSON.stringify(actualFks) !== JSON.stringify(expectedFks)) {
        throw new RestoreDumpInvalidError(`incompatible foreign key definition on ${table}`);
    }
}

function validateTableRowValues(db, expectedDb, table) {
    const expectedCols = expectedDb.pragma(`table_xinfo(${quoteSqliteIdent(table)})`);
    const predicates = [];
    for (const exp of expectedCols) {
        if (exp.hidden !== 0) continue;
        const qCol = quoteSqliteIdent(exp.name);
        if (exp.notnull === 1 || exp.pk > 0) {
            predicates.push(`${qCol} IS NULL`);
        }
        const affinity = sqliteTypeAffinity(exp.type);
        if (affinity === 'TEXT') {
            predicates.push(`(${qCol} IS NOT NULL AND typeof(${qCol}) != 'text')`);
        } else if (affinity === 'INTEGER') {
            predicates.push(`(${qCol} IS NOT NULL AND typeof(${qCol}) != 'integer')`);
        }
        if (exp.name === 'doc') {
            predicates.push(`(${qCol} IS NOT NULL AND json_valid(${qCol}) != 1)`);
        }
    }
    if (predicates.length > 0) {
        const badRow = db.prepare(`SELECT 1 FROM ${quoteSqliteIdent(table)} WHERE ${predicates.join(' OR ')} LIMIT 1`).get();
        if (badRow) {
            throw new RestoreDumpInvalidError(`invalid row value or constraint violation in ${table}`);
        }
    }
    if (table === 'chats') {
        const badIntegrity = db.prepare(
            'SELECT 1 FROM chats WHERE integrity IS NOT json_extract(doc, \'$.header.chat_metadata.integrity\') LIMIT 1',
        ).get();
        if (badIntegrity) {
            throw new RestoreDumpInvalidError('chats.integrity values do not match stored chat documents');
        }
    }
}

async function runOperationalSchemaProbe(sourceDb, version) {
    const probeDb = new Database(':memory:');
    try {
        probeDb.pragma('foreign_keys = OFF');
        const userTableSet = new Set(SQLITE_USER_TABLES);
        const tableRows = sourceDb.prepare(
            'SELECT name, sql FROM sqlite_master WHERE type = \'table\' AND sql IS NOT NULL',
        ).all().filter(r => userTableSet.has(r.name));
        for (const row of tableRows) {
            probeDb.prepare(row.sql).run();
        }
        const indexRows = sourceDb.prepare(
            'SELECT name, tbl_name, sql FROM sqlite_master WHERE type = \'index\' AND sql IS NOT NULL',
        ).all().filter(r => userTableSet.has(r.tbl_name));
        for (const row of indexRows) {
            probeDb.prepare(row.sql).run();
        }
        probeDb.pragma(`user_version = ${version}`);
        initSchema(probeDb);
        probeDb.pragma('foreign_keys = ON');

        const handle = '__probe__';
        const tx = new SqliteTransaction({ db: probeDb, handle, directoriesByHandle: () => ({ root: '' }) });
        const chatKey = { kind: 'chat', handle, charDir: 'ProbeChar', name: 'probe-chat' };
        await tx.putResource(chatKey, {
            header: { user_name: 'u', character_name: 'ProbeChar', chat_metadata: {} },
            body: [],
            integrity: 'probe-integrity-1',
        });
        const firstChat = await tx.getResource(chatKey);
        if (firstChat?.integrity !== 'probe-integrity-1') {
            throw new RestoreDumpInvalidError('chats.integrity generated column does not extract chat integrity');
        }
        await tx.putResource(chatKey, {
            header: { user_name: 'u', character_name: 'ProbeChar', chat_metadata: {} },
            body: [],
        });
        const secondChat = await tx.getResource(chatKey);
        if (secondChat?.integrity !== '') {
            throw new RestoreDumpInvalidError('chats.integrity generated column does not clear on missing integrity');
        }
        tx.putChatState(chatKey, 'probe-ns', { ok: true });
        await tx.deleteResource(chatKey);
        if (tx.getChatState(chatKey, 'probe-ns') !== null) {
            throw new RestoreDumpInvalidError('chat_states foreign key did not cascade delete on parent chat removal');
        }

        await tx.putResource({ kind: 'settings', handle }, { doc: { probe: 1 } });
        await tx.putResource({ kind: 'settings', handle }, { doc: { probe: 2 } });
        await tx.putResource({ kind: 'preset', handle, dirKey: 'openai', name: 'p' }, { doc: { temperature: 1 } });
        await tx.putResource({ kind: 'preset', handle, dirKey: 'openai', name: 'p' }, { doc: { temperature: 0.5 } });
        tx.putPresetState({ kind: 'preset', handle, dirKey: 'openai', name: 'orphan' }, 'ns', { ok: true });
        await tx.putResource({ kind: 'world', handle, name: 'w' }, { doc: { entries: {} } });
        await tx.putResource({ kind: 'world', handle, name: 'w' }, { doc: { entries: { '0': { content: 'x' } } } });
        probeDb.prepare('UPDATE worlds SET revision = NULL').run();
        await tx.putResource({ kind: 'named-doc', handle, bucket: 'themes', name: 't' }, { doc: { accent: '#000' } });
        await tx.putResource({ kind: 'named-doc', handle, bucket: 'themes', name: 't' }, { doc: { accent: '#fff' } });
        await tx.putResource({ kind: 'group', handle, id: 'g' }, { doc: { id: 'g', name: 'G', chats: [] } });
        await tx.putResource({ kind: 'group', handle, id: 'g' }, { doc: { id: 'g', name: 'G2', chats: [] } });
        await tx.putResource({ kind: 'stats', handle }, { doc: { totalChats: 1 } });
        await tx.putResource({ kind: 'stats', handle }, { doc: { totalChats: 2 } });

        const fkViolations = probeDb.pragma('foreign_key_check');
        if (fkViolations.length > 0) {
            throw new RestoreDumpInvalidError('SQLite schema failed foreign key operational check');
        }
    } finally {
        probeDb.close();
    }
}

/**
 * Rejects a restore payload that is not a readable, schema-compatible Luker
 * SQLite database: checks the file header, opens read-only, runs
 * `PRAGMA integrity_check`, rejects unsupported schema versions/triggers/views/
 * virtual tables, validates required columns/types/nullability/defaults/PKs/
 * unique indexes/FKs against the bootstrapped schema, verifies row data and
 * `PRAGMA foreign_key_check`, and runs an in-memory operational probe.
 *
 * An engine dump is a `db.backup` copy and stays in WAL mode, so the
 * read-only open creates `-wal`/`-shm` files it cannot remove on close; the
 * ones this check created are removed afterwards.
 * @param {string} filePath
 */
export async function assertValidSqliteFile(filePath) {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const fh = await fsPromises.open(filePath, 'r');
    let bytesRead;
    try {
        ({ bytesRead } = await fh.read(header, 0, header.length, 0));
    } finally {
        await fh.close();
    }
    if (bytesRead !== header.length || !header.equals(SQLITE_HEADER)) {
        throw new RestoreDumpInvalidError('not a SQLite database file');
    }
    const sidecars = [`${filePath}-wal`, `${filePath}-shm`].filter((p) => !fs.existsSync(p));
    let db;
    let cleanupError = null;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
        const rows = db.pragma('integrity_check');
        const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
        if (!ok) {
            throw new RestoreDumpInvalidError(`SQLite integrity check failed: ${rows.map(r => r.integrity_check).join('; ')}`);
        }
        const version = db.pragma('user_version', { simple: true });
        if (!Number.isInteger(version) || version < 0 || version > CURRENT_SCHEMA_VERSION) {
            throw new RestoreDumpInvalidError(`unsupported SQLite schema version ${version}`);
        }
        if (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').get('trigger')) {
            throw new RestoreDumpInvalidError('SQLite restore payload contains unsupported triggers');
        }
        if (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').get('view')) {
            throw new RestoreDumpInvalidError('SQLite restore payload contains unsupported views');
        }
        const tableObjects = db.prepare('SELECT name, sql FROM sqlite_master WHERE type = \'table\'').all();
        for (const tbl of tableObjects) {
            if (/^CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(tbl.sql || ''))) {
                throw new RestoreDumpInvalidError(`SQLite restore payload contains unsupported virtual table ${tbl.name}`);
            }
        }
        const present = new Set(tableObjects.map((r) => r.name));
        const missing = SQLITE_USER_TABLES.filter((t) => !present.has(t));
        if (missing.length > 0) {
            throw new RestoreDumpInvalidError(`not a Luker SQLite database: missing tables ${missing.join(', ')}`);
        }

        // Bootstrap the real schema in memory; do not duplicate its column or
        // constraint definitions in restore validation. Version 0 backups use
        // the initial user tables and are migrated when rewritten/opened.
        const expectedDb = new Database(':memory:');
        let expectedLatestDb = null;
        try {
            const targetVersion = Math.max(1, version);
            initSchema(expectedDb, { targetVersion });
            const pendingAddedCols = new Map();
            if (version < CURRENT_SCHEMA_VERSION) {
                expectedLatestDb = new Database(':memory:');
                initSchema(expectedLatestDb);
                for (const table of SQLITE_USER_TABLES) {
                    const baseNames = new Set(expectedDb.pragma(`table_xinfo(${quoteSqliteIdent(table)})`).map(c => c.name));
                    const added = new Set(
                        expectedLatestDb.pragma(`table_xinfo(${quoteSqliteIdent(table)})`)
                            .map(c => c.name)
                            .filter(name => !baseNames.has(name)),
                    );
                    if (added.size > 0) pendingAddedCols.set(table, added);
                }
            }
            for (const table of SQLITE_USER_TABLES) {
                validateTableSchema(db, expectedDb, table, { version, pendingAddedCols });
            }
            const fkViolations = db.pragma('foreign_key_check');
            if (fkViolations.length > 0) {
                throw new RestoreDumpInvalidError(`SQLite foreign key integrity check failed (${fkViolations.length} violation(s))`);
            }
            for (const table of SQLITE_USER_TABLES) {
                validateTableRowValues(db, expectedDb, table);
            }
        } finally {
            expectedLatestDb?.close();
            expectedDb.close();
        }

        await runOperationalSchemaProbe(db, version);
    } catch (err) {
        throw isSqlitePayloadError(err)
            ? (err instanceof RestoreDumpInvalidError ? err : new RestoreDumpInvalidError(err.message))
            : err;
    } finally {
        db?.close();
        for (const sidecar of sidecars) {
            try {
                await fsPromises.rm(sidecar, { force: true });
            } catch (err) {
                cleanupError ??= err;
            }
        }
    }
    if (cleanupError) {
        throw cleanupError;
    }
}

/**
 * Sets the `handle` column of every user-data row in a restore payload to
 * `handle`: an engine dump is a copy of the source account's database, so its
 * rows still carry the source account's handle. Switches the file to
 * rollback-journal mode first so closing it leaves no `-wal`/`-shm` files;
 * the engine turns WAL back on when it opens the file. Foreign keys are off
 * during the rewrite because `chat_states` references `chats` by handle and
 * both are rewritten together, then verified with `PRAGMA foreign_key_check`.
 * @param {string} filePath
 * @param {string} handle
 */
export function rewriteSqliteHandle(filePath, handle) {
    const db = new Database(filePath, { fileMustExist: true });
    try {
        db.pragma('journal_mode = DELETE');
        db.pragma('foreign_keys = OFF');
        initSchema(db);
        db.transaction(() => {
            for (const table of SQLITE_USER_TABLES) {
                db.prepare(`UPDATE ${table} SET handle = ?`).run(handle);
            }
            // Restoring data does not restore an earlier cleanup's ownership.
            db.prepare('UPDATE worlds SET revision = NULL').run();
        })();
        db.pragma('foreign_keys = ON');
        const fkViolations = db.pragma('foreign_key_check');
        if (fkViolations.length > 0) {
            throw new RestoreDumpInvalidError(`SQLite foreign key check failed after handle rewrite (${fkViolations.length} violation(s))`);
        }
    } catch (err) {
        // A payload holding rows of several accounts collides on the primary
        // key once they share one handle. Operational errors propagate as-is.
        if (err instanceof RestoreDumpInvalidError) throw err;
        if (isSqlitePayloadError(err)) {
            throw new RestoreDumpInvalidError(err.message);
        }
        throw err;
    } finally {
        db.close();
    }
}

export class SqliteEngine {
    constructor({ directoriesByHandle }) {
        if (typeof directoriesByHandle !== 'function') {
            throw new TypeError('SqliteEngine requires { directoriesByHandle: (handle) => dirs }');
        }
        this.kind = 'sqlite';
        this._directoriesByHandle = directoriesByHandle;
        this._dbs = new Map();
        // Per-handle async tail. `withTransaction` chains onto the previous
        // promise for the same handle, so two parallel HTTP requests on the
        // same user's DB don't both run `BEGIN IMMEDIATE` and trip
        // "cannot start a transaction within a transaction". better-sqlite3
        // is synchronous per-call but `withTransaction` accepts async work,
        // which the language alone can't serialize.
        this._txTail = new Map();
    }

    _dbFor(handle) {
        if (this._dbs.has(handle)) return this._dbs.get(handle);
        const root = this._directoriesByHandle(handle).root;
        fs.mkdirSync(root, { recursive: true });
        const dbPath = path.join(root, 'luker-storage.sqlite');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        initSchema(db);
        this._dbs.set(handle, db);
        return db;
    }

    async ping(handle) {
        // Sqlite is per-handle: each user has their own DB file, opened lazily.
        // A transport-level ping with no handle (e.g. the public
        // /api/storage/health probe) has no global DB to query, so treat
        // it as a no-op — the SqliteEngine instance existing is itself the
        // "engine is loaded" signal. Per-handle pings still verify SELECT 1.
        if (handle === undefined || handle === null) return;
        const db = this._dbFor(handle);
        db.prepare('SELECT 1').get();
    }

    /**
     * No-op for "engine row removal" per design spec §4.1 / §5.3 — every byte
     * of a sqlite user's data lives in `dirs.root/luker-storage.sqlite`, and
     * the admin `/delete` handler's `purge=true` branch is the single,
     * explicit owner of removing the user dir (which sweeps the .sqlite file
     * with it). `deleteUser` runs unconditionally and must therefore preserve
     * the file when the admin chose `purge=false`.
     *
     * We DO still close + evict the cached `Database` handle here so a
     * subsequent `purge=true` `fs.rm(dirs.root)` doesn't race an open file
     * descriptor (Windows refuses to delete in-use files; *nix would leave a
     * dangling unlinked inode). Idempotent — missing handle is a no-op.
     * @param {string} handle
     */
    async deleteUser(handle) {
        const existing = this._dbs.get(handle);
        if (existing) {
            try { existing.close(); } catch { /* db may already be closed */ }
            this._dbs.delete(handle);
            this._txTail.delete(handle);
        }
    }

    /**
     * sqlite returns a binary stream of the per-user .sqlite
     * file. Uses better-sqlite3's online backup API for crash-consistency
     * under concurrent writes (`db.backup(tmpPath)` is preferable to a raw
     * `fs.createReadStream` on the live file, which could capture a half-baked
     * page mid-write). The backup is written to `os.tmpdir()` first, then
     * streamed; the temp file is unlinked when the stream closes (success or
     * error).
     * @param {string} handle
     * @returns {Promise<import('node:stream').Readable>}
     */
    async dumpUser(handle) {
        const db = this._dbFor(handle);
        const tmpPath = path.join(os.tmpdir(), `luker-dump-${randomBytes(8).toString('hex')}.sqlite`);
        await db.backup(tmpPath);
        const stream = fs.createReadStream(tmpPath);
        const cleanup = () => {
            fsPromises.rm(tmpPath, { force: true }).catch(() => { /* best-effort */ });
        };
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        return stream;
    }

    /**
     * sqlite restore writes the incoming bytes into
     * `dirs.root/luker-storage.sqlite`. Writes to a temp file first,
     * validates it with `assertValidSqliteFile`, moves its rows onto `handle`
     * with `rewriteSqliteHandle`, then `fs.rename`s it
     * atomically over the final path — a partial write, a crash mid-stream or
     * an invalid payload leaves the previous DB intact. The cached
     * `Database` handle is closed + evicted only after validation, right
     * before the rename (Windows refuses to replace open files; *nix would
     * leave readers on a dangling inode). The next `_dbFor(handle)` call
     * re-opens the new file and runs `initSchema` to bring any older dump
     * schema forward.
     * @param {string} handle
     * @param {import('node:stream').Readable} stream
     */
    async restoreUser(handle, stream) {
        const dirs = this._directoriesByHandle(handle);
        const finalPath = path.join(dirs.root, 'luker-storage.sqlite');
        // Rename must stay on the destination volume for atomic replacement.
        const tmpPath = path.join(dirs.root, `luker-restore-${randomBytes(8).toString('hex')}.sqlite`);
        // Serialize the restore synchronously on _txTail so in-flight transactions
        // finish before we touch the DB, and transactions queued after restoreUser()
        // cannot sneak in ahead of the swap and lose committed writes.
        const prev = this._txTail.get(handle) || Promise.resolve();
        const run = prev.then(async () => {
            try {
                // Ensure the parent dir exists — restore can run before any other
                // write has materialized the per-user directory.
                await fsPromises.mkdir(dirs.root, { recursive: true });
                await pipeline(stream, fs.createWriteStream(tmpPath, { flags: 'wx' }));
                await assertValidSqliteFile(tmpPath);
                rewriteSqliteHandle(tmpPath, handle);
                const existing = this._dbs.get(handle);
                if (existing) {
                    try {
                        if (existing.open !== false) existing.close();
                    } catch (closeErr) {
                        throw new Error(
                            `Failed to close existing SQLite database for handle "${handle}" before restore: ${closeErr?.message || closeErr}`,
                            { cause: closeErr },
                        );
                    }
                    this._dbs.delete(handle);
                }
                // Drop any leftover WAL/SHM sidecars from the replaced DB before
                // swapping the main file so stale frames never replay onto the
                // restored database.
                await Promise.all([
                    fsPromises.rm(`${finalPath}-wal`, { force: true }),
                    fsPromises.rm(`${finalPath}-shm`, { force: true }),
                ]);
                await fsPromises.rename(tmpPath, finalPath);
            } catch (err) {
                try {
                    await fsPromises.rm(tmpPath, { force: true });
                } catch (cleanupErr) {
                    console.error('Failed to remove temporary sqlite restore file:', tmpPath, cleanupErr);
                }
                throw err;
            }
        });
        const tail = run.catch(() => {});
        this._txTail.set(handle, tail);
        try {
            await run;
        } finally {
            if (this._txTail.get(handle) === tail) {
                this._txTail.delete(handle);
            }
        }
    }

    async withTransaction(handle, fn) {
        // Serialize transactions per-handle: chain onto the previous tail
        // and replace it with our own. Open the DB handle INSIDE the chained
        // continuation so a transaction queued behind `restoreUser` or a
        // wedged-handle eviction acquires the freshly reopened database.
        const prev = this._txTail.get(handle) || Promise.resolve();
        const run = prev.then(async () => {
            const db = this._dbFor(handle);
            const tx = new SqliteTransaction({ db, handle, directoriesByHandle: this._directoriesByHandle });
            // better-sqlite3 `db.transaction()` only wraps sync functions; we need to
            // await an async closure, so drive BEGIN/COMMIT/ROLLBACK manually.
            db.exec('BEGIN IMMEDIATE');
            try {
                const result = await fn(tx);
                db.exec('COMMIT');
                return result;
            } catch (err) {
                if (db.inTransaction !== false) {
                    try {
                        db.exec('ROLLBACK');
                    } catch (rollbackErr) {
                        // Connection may remain wedged in an open transaction; evict and
                        // close it so subsequent transactions open a fresh handle.
                        if (this._dbs.get(handle) === db) {
                            this._dbs.delete(handle);
                        }
                        try {
                            if (db.open !== false) db.close();
                        } catch (closeErr) {
                            console.error(`Failed to close wedged SQLite database for handle "${handle}" after ROLLBACK failure:`, closeErr);
                        }
                        throw new TransactionOutcomeUnknownError('ROLLBACK', err, rollbackErr);
                    }
                    if (db.inTransaction === true) {
                        if (this._dbs.get(handle) === db) {
                            this._dbs.delete(handle);
                        }
                        try {
                            if (db.open !== false) db.close();
                        } catch (closeErr) {
                            console.error(`Failed to close SQLite database still in transaction for handle "${handle}":`, closeErr);
                        }
                    }
                }
                throw err;
            }
        });
        // Swallow rejection on the tail so a failed tx doesn't poison the
        // next caller's promise chain, and prune idle tails once settled.
        const tail = run.catch(() => {});
        this._txTail.set(handle, tail);
        tail.finally(() => {
            if (this._txTail.get(handle) === tail) {
                this._txTail.delete(handle);
            }
        });
        return run;
    }

    close() {
        for (const db of this._dbs.values()) {
            db.close();
        }
        this._dbs.clear();
        this._txTail.clear();
    }

    /**
     * Drop the cached connection for a single handle. Subsequent storage
     * calls for that handle go through `_dbFor`, which lazily reopens
     * against whatever DB file is on disk at that time.
     *
     * After a caller swaps in a fresh `luker-storage.sqlite` by rename,
     * better-sqlite3's cached handle pins the OLD (now unlinked)
     * inode and silently returns stale data, so the caller MUST drop it before
     * the next read or write. Per-handle (rather than `close()`)
     * preserves any other user's connection in the same process.
     *
     * Concurrency: a caller that swaps the DB file must hold
     * the sync write gate's writer side across the swap and this call.
     * Every endpoint that writes synced data waits for a reader slot while
     * the writer is held, so no app write reaches the cached connection
     * between the swap and `closeHandle` and lands on the old inode.
     *
     * Idempotent: a handle with no cached connection is a no-op. Safe to
     * call multiple times in sequence.
     *
     * @param {string} handle
     */
    closeHandle(handle) {
        const db = this._dbs.get(handle);
        if (db) {
            db.close();
            this._dbs.delete(handle);
        }
        // Drop the per-handle tx tail too; any in-flight transaction
        // should already be drained by the caller's serialization, and a
        // dangling tail would keep the chained promise pinned in memory.
        this._txTail.delete(handle);
    }
}
