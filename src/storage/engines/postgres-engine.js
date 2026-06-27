import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import pg from 'pg';
import { PgTransaction } from './postgres-engine-transaction.js';
import { initSchema } from './postgres-schema.js';
import { withRetry } from '../retry.js';
import { logEngineError } from '../engine-logger.js';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = { transient: 3 };

// User-data tables, listed in INSERT order (parent before child) so a
// `restoreUser` stream that consumes this dump in order satisfies the FK
// constraints declared in migrations/postgres/0001-initial.sql:
//   - chat_states references chats (handle, char_dir, name, is_group, group_id)
//     via `chat_states_fk_chats` ON DELETE CASCADE → chats must precede.
//   - preset_states has NO FK on presets (the schema's missing FK matches
//     the PERMISSIVE put-without-parent policy), but we still order them
//     parents-first for symmetry and so a future FK retrofit is safe.
// `chats` excludes `integrity` because it is a GENERATED STORED column
// (doc #>> '{header,chat_metadata,integrity}') — Postgres rejects explicit
// writes to it with `cannot insert into column "integrity"`.
const DUMP_TABLES = Object.freeze([
    { name: 'settings', cols: ['handle', 'doc', 'updated_at'] },
    { name: 'stats', cols: ['handle', 'doc', 'updated_at'] },
    { name: 'groups_table', cols: ['handle', 'id', 'doc', 'updated_at', 'created_at'] },
    { name: 'named_docs', cols: ['handle', 'bucket', 'name', 'doc', 'updated_at'] },
    { name: 'worlds', cols: ['handle', 'name', 'doc', 'updated_at'] },
    { name: 'presets', cols: ['handle', 'dir_key', 'name', 'doc', 'updated_at'] },
    { name: 'preset_states', cols: ['handle', 'dir_key', 'name', 'namespace', 'doc'] },
    { name: 'chats', cols: ['handle', 'char_dir', 'name', 'is_group', 'group_id', 'doc', 'updated_at', 'created_at'] },
    { name: 'chat_states', cols: ['handle', 'char_dir', 'name', 'is_group', 'group_id', 'namespace', 'doc'] },
]);

// pg parses JSONB into JS objects by default; mysql2 parses JSON the same way.
// Normalize to JSON.stringify so `restoreUser` re-inserts a value the driver
// will round-trip correctly into JSONB (passing a raw JS object goes through
// pg's text protocol as `[object Object]`). Buffers and Dates pass through
// untouched — BIGINT timestamps are already JS numbers thanks to the
// process-global type-parser registered at the top of this module.
function normalizeDumpValue(v) {
    if (v != null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)) {
        return JSON.stringify(v);
    }
    return v;
}

// Postgres returns BIGINT (OID 20) as a JavaScript string by default because
// BIGINT can exceed JS Number.MAX_SAFE_INTEGER. All BIGINT columns in our
// schema hold millisecond timestamps (~1.7e12 today, far below 2^53), so it
// is safe to coerce them to Number for parity with mysql2's behavior and
// better-sqlite3's behavior (both return integers as JS numbers). Done at
// module load so it applies to every connection created by every engine
// instance. This is process-global by design — pg.types is a singleton
// shared by every pg.Pool / pg.Client in the process, mirroring how
// mysql2/sqlite handlers all see Number-typed timestamps.
pg.types.setTypeParser(20, (val) => (val === null ? null : Number(val)));

export class PgEngine {
    constructor({
        url,
        poolSize = 10,
        acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
        retries = DEFAULT_RETRIES,
    } = {}) {
        if (typeof url !== 'string' || !url) {
            throw new TypeError('PgEngine requires { url: "postgresql://user:pass@host:port/db" }');
        }
        this.kind = 'postgres';
        this._retries = retries;
        // pg.Pool keyed on connection-string + max. Max caps concurrent
        // leases so withTransaction queues past the limit instead of opening
        // unbounded sockets. The harness encodes a per-test schema into the
        // URL's `options=-csearch_path=...` parameter, so every connection
        // pulled from this pool already targets the right namespace — no
        // per-connection `SET search_path` needed. connectionTimeoutMillis
        // bounds both the initial TCP connect AND the wait time when the
        // pool is exhausted (pg-pool releases queued waiters with a
        // 'timeout exceeded when trying to connect' error).
        this._pool = new pg.Pool({
            connectionString: url,
            max: poolSize,
            connectionTimeoutMillis: acquireTimeoutMs,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10_000,
        });
        // Lazy schema bootstrap: first ping / withTransaction triggers
        // initSchema once and caches the promise so concurrent first calls
        // share the work. Mirrors MysqlEngine / SqliteEngine bootstrap.
        this._schemaReady = null;
    }

    async _ensureSchema() {
        if (!this._schemaReady) {
            this._schemaReady = initSchema(this._pool).catch((err) => {
                // Reset so a transient failure doesn't permanently block
                // future bootstraps; subsequent calls retry.
                this._schemaReady = null;
                logEngineError(this.kind, 'schema-bootstrap', null, err);
                throw err;
            });
        }
        return this._schemaReady;
    }

    async ping(handle) { // eslint-disable-line no-unused-vars
        await this._ensureSchema();
        try {
            await withRetry(async () => {
                const client = await this._pool.connect();
                try {
                    await client.query('SELECT 1');
                } finally {
                    client.release();
                }
            }, { retries: this._retries.transient });
        } catch (err) {
            logEngineError(this.kind, 'ping', handle ?? null, err);
            throw err;
        }
    }

    async withTransaction(handle, fn) {
        await this._ensureSchema();
        try {
            return await withRetry(async () => {
                const client = await this._pool.connect();
                try {
                    await client.query('BEGIN');
                    const tx = new PgTransaction({ client, handle });
                    try {
                        const result = await fn(tx);
                        await client.query('COMMIT');
                        return result;
                    } catch (err) {
                        try { await client.query('ROLLBACK'); } catch { /* engine may already have rolled back */ }
                        throw err;
                    }
                } finally {
                    client.release();
                }
            }, { retries: this._retries.transient });
        } catch (err) {
            logEngineError(this.kind, 'tx', handle, err);
            throw err;
        }
    }

    /**
     * Postgres parallel of MysqlEngine.deleteUser. Same retry-and-log shell,
     * same table order, same idempotent contract. Uses parameterized queries
     * with `$1` binding (pg convention) instead of `?`. The `_storage_meta`
     * table is schema-version data, NOT user data, and is left untouched.
     * @param {string} handle
     */
    async deleteUser(handle) {
        await this._ensureSchema();
        try {
            await withRetry(async () => {
                const client = await this._pool.connect();
                try {
                    await client.query('BEGIN');
                    try {
                        for (const table of [
                            'chat_states', 'preset_states',
                            'chats', 'presets', 'worlds',
                            'named_docs', 'groups_table',
                            'settings', 'stats',
                        ]) {
                            await client.query(`DELETE FROM ${table} WHERE handle = $1`, [handle]);
                        }
                        await client.query('COMMIT');
                    } catch (err) {
                        try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
                        throw err;
                    }
                } finally {
                    client.release();
                }
            }, { retries: this._retries.transient });
        } catch (err) {
            logEngineError(this.kind, 'delete-user', handle, err);
            throw err;
        }
    }

    async close() {
        await this._pool.end();
    }

    /**
     * postgres dumps to a text stream of newline-separated
     * JSON-encoded `{sql, params}` records — one INSERT per row. The dump
     * is dialect-specific (postgres uses `$1, $2, ...` placeholders); the
     * matching engine kind is recorded in `_engine_meta.json` outside this
     * stream so a cross-dialect restore is caught at the orchestrator
     * layer instead of blowing up here with an opaque SQL error.
     *
     * Tables are emitted in PARENT-FIRST order (DUMP_TABLES) so a streaming
     * restore can INSERT in receive order without buffering: `chats` before
     * `chat_states` (FK CASCADE), `presets` before `preset_states` (no FK
     * today, future-proofed). The `integrity` column on `chats` is omitted
     * because it is GENERATED STORED — Postgres rejects explicit writes.
     *
     * Uses `Readable.from(asyncGenerator)` so backpressure flows naturally
     * to the consumer (HTTP response, file write, etc.) without holding the
     * whole dump in memory. The pool client is acquired once at stream
     * start and released in the generator's `finally`, so an aborted
     * consumer still frees the slot.
     * @param {string} handle
     * @returns {Promise<import('node:stream').Readable>}
     */
    async dumpUser(handle) {
        await this._ensureSchema();
        const self = this;

        async function* generate() {
            const client = await self._pool.connect();
            try {
                for (const t of DUMP_TABLES) {
                    const colsCsv = t.cols.join(', ');
                    const placeholders = t.cols.map((_, i) => `$${i + 1}`).join(', ');
                    const sqlText = `INSERT INTO ${t.name} (${colsCsv}) VALUES (${placeholders})`;
                    const { rows } = await client.query(
                        `SELECT ${colsCsv} FROM ${t.name} WHERE handle = $1`,
                        [handle],
                    );
                    for (const row of rows) {
                        const params = t.cols.map((c) => normalizeDumpValue(row[c]));
                        yield JSON.stringify({ sql: sqlText, params }) + '\n';
                    }
                }
            } finally {
                client.release();
            }
        }

        return Readable.from(generate());
    }

    /**
     * postgres restore wipes the handle (idempotent — calls
     * `deleteUser` which is itself retry-wrapped) then replays the incoming
     * `{sql, params}` lines inside ONE transaction. A failed line rolls back
     * the whole restore so the user's slot is either fully restored or
     * unchanged — never half-applied.
     *
     * The wipe runs in its own transaction BEFORE the restore transaction
     * begins; if the restore later fails, the user is left wiped (not
     * mid-restored). The restore is idempotent: re-
     * issuing the same restore from a good dump converges.
     *
     * Stream parsing buffers across chunk boundaries — `for await` chunks
     * arrive at arbitrary byte boundaries so a record split across two
     * chunks would JSON.parse-fail without the buffer. Critically, the
     * chunk boundary may also fall MID multi-byte UTF-8 sequence (CJK
     * chars are 3 bytes, emoji 4), and `chunk.toString('utf8')` on a
     * partial sequence emits U+FFFD replacement chars in both this chunk
     * and the next — silent mojibake in restored chat content. We use
     * `StringDecoder` to buffer incomplete sequences internally so the
     * decoded text round-trips byte-for-byte regardless of where yauzl
     * splits the dump. The retry wrapper is for transient pool/connection
     * failures during the COMMIT itself; a malformed dump line throws
     * synchronously inside the retry body and surfaces immediately.
     * @param {string} handle
     * @param {import('node:stream').Readable} stream
     */
    async restoreUser(handle, stream) {
        await this._ensureSchema();
        await this.deleteUser(handle);

        try {
            await withRetry(async () => {
                const client = await this._pool.connect();
                try {
                    await client.query('BEGIN');
                    try {
                        const decoder = new StringDecoder('utf8');
                        let buf = '';
                        for await (const chunk of stream) {
                            buf += decoder.write(chunk);
                            let nl;
                            while ((nl = buf.indexOf('\n')) >= 0) {
                                const line = buf.slice(0, nl).trim();
                                buf = buf.slice(nl + 1);
                                if (!line) continue;
                                const { sql, params } = JSON.parse(line);
                                await client.query(sql, params);
                            }
                        }
                        buf += decoder.end();
                        const tail = buf.trim();
                        if (tail) {
                            const { sql, params } = JSON.parse(tail);
                            await client.query(sql, params);
                        }
                        await client.query('COMMIT');
                    } catch (err) {
                        try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
                        throw err;
                    }
                } finally {
                    client.release();
                }
            }, { retries: this._retries.transient });
        } catch (err) {
            logEngineError(this.kind, 'restore-user', handle, err);
            throw err;
        }
    }
}
