import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import mysql from 'mysql2/promise';
import { MysqlTransaction } from './mysql-engine-transaction.js';
import { initSchema } from './mysql-schema.js';
import { withRetry } from '../retry.js';
import { logEngineError } from '../engine-logger.js';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = { transient: 3 };

// User-data tables, listed in INSERT order (parent before child) so a
// `restoreUser` stream that consumes this dump in order satisfies the FK
// constraints declared in migrations/mysql/0001-initial.sql:
//   - chat_states references chats (handle, char_dir, name, is_group, group_id)
//     via `chat_states_fk_chats` ON DELETE CASCADE → chats must precede.
//   - preset_states has NO FK on presets (the schema's missing FK matches
//     the PERMISSIVE put-without-parent policy), but we still order them
//     parents-first for symmetry and so a future FK retrofit is safe.
// `chats` excludes `integrity` because it is a GENERATED STORED column
// (JSON_EXTRACT of doc.header.chat_metadata.integrity) — the engine derives
// it on INSERT/UPDATE and rejects explicit writes.
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

// mysql2 parses JSON columns into JS objects by default; Postgres returns
// JSONB as JS objects too. Normalize to JSON.stringify so `restoreUser` re-
// inserts a value the driver will store correctly (mysql JSON accepts a JSON
// string literal — passing a raw object would be sent as `[object Object]`).
// Buffers and Dates pass through untouched: BIGINT timestamps land as JS
// numbers (per the pg type-parser registered in postgres-engine.js, and
// mysql2's native number coercion), and no binary blobs live in the schema
// today — but we keep the typeof-object check buffer- and date-aware so a
// future binary column doesn't get stringified into garbage.
function normalizeDumpValue(v) {
    if (v != null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)) {
        return JSON.stringify(v);
    }
    return v;
}

// mysql2's pool has no native acquire-wait timeout: `connectTimeout` only
// covers initial TCP/handshake, and once `connectionLimit` is reached the
// pool enqueues without an upper bound. Wrap `getConnection()` in a
// Promise.race so the caller fails fast on pool exhaustion. If the queued
// connection eventually arrives after the timeout, immediately release it
// back to the pool so it isn't permanently stranded.
function acquireWithTimeout(pool, timeoutMs) {
    let timerId;
    return new Promise((resolve, reject) => {
        let settled = false;
        timerId = setTimeout(() => {
            if (settled) return;
            settled = true;
            const err = new Error(`mysql pool acquire timed out after ${timeoutMs}ms`);
            err.code = 'POOL_ACQUIRE_TIMEOUT';
            reject(err);
        }, timeoutMs);
        pool.getConnection()
            .then((conn) => {
                if (settled) {
                    // Caller already timed out and moved on; hand the slot back.
                    try { conn.release(); } catch { /* pool may be closing */ }
                    return;
                }
                settled = true;
                clearTimeout(timerId);
                resolve(conn);
            })
            .catch((err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timerId);
                reject(err);
            });
    });
}

export class MysqlEngine {
    /**
     * `acquireTimeoutMs` is currently THREADED INTO TWO semantically different
     * phases:
     *   1. `mysql.createPool({ connectTimeout })` — bounds the initial TCP /
     *      handshake when a fresh socket is opened.
     *   2. `acquireWithTimeout(pool, timeoutMs)` — bounds the pool-acquire
     *      wait once `connectionLimit` is reached and callers must queue.
     * Lowering this knob for snappy contention-failure visibility will also
     * make brand-new connections to a slow-DNS DB host fail. If a future
     * operator hits this, the cleanest split is to introduce a separate
     * `connectTimeoutMs` alongside `acquireTimeoutMs`.
     */
    constructor({
        url,
        poolSize = 10,
        acquireTimeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
        retries = DEFAULT_RETRIES,
    } = {}) {
        if (typeof url !== 'string' || !url) {
            throw new TypeError('MysqlEngine requires { url: "mysql://user:pass@host:port/db" }');
        }
        this.kind = 'mysql';
        this._acquireTimeoutMs = acquireTimeoutMs;
        this._retries = retries;
        // mysql2/promise pool. charset=utf8mb4 keeps inserts consistent with
        // the schema's utf8mb4_bin collation; connectionLimit caps concurrent
        // leases so withTransaction queues past the limit instead of opening
        // unbounded sockets. connectTimeout bounds the initial TCP handshake;
        // pool acquire-wait is bounded separately via acquireWithTimeout.
        this._pool = mysql.createPool({
            uri: url,
            connectionLimit: poolSize,
            connectTimeout: acquireTimeoutMs,
            charset: 'utf8mb4',
            // Allow multiple PK fields without auto-string casts; the
            // composite-key handlers in Task 3 rely on raw 0/1 for is_group.
            namedPlaceholders: false,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10_000,
        });
        // Lazy schema bootstrap: first ping / withTransaction triggers
        // initSchema once and caches the promise so concurrent first calls
        // share the work. Mirrors SqliteEngine's _dbFor(handle) bootstrap.
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
                const conn = await acquireWithTimeout(this._pool, this._acquireTimeoutMs);
                try {
                    await conn.query('SELECT 1');
                } finally {
                    conn.release();
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
                const conn = await acquireWithTimeout(this._pool, this._acquireTimeoutMs);
                try {
                    await conn.beginTransaction();
                    const tx = new MysqlTransaction({ conn, handle });
                    try {
                        const result = await fn(tx);
                        await conn.commit();
                        return result;
                    } catch (err) {
                        try { await conn.rollback(); } catch { /* engine may already have rolled back */ }
                        throw err;
                    }
                } finally {
                    conn.release();
                }
            }, { retries: this._retries.transient });
        } catch (err) {
            logEngineError(this.kind, 'tx', handle, err);
            throw err;
        }
    }

    /**
     * Removes all of a user's data across every user-data table in one
     * transaction. Retry-wrapped and log-on-final-fail to match `ping` and
     * `withTransaction`. Idempotent — zero rows to delete is a success. The
     * `_storage_meta` table holds schema-version data, NOT user data, and is
     * intentionally left alone.
     *
     * Table order matters where there are FKs: child rows first (chat_states
     * has an FK on chats), then parents, then unrelated singletons. The list
     * is the canonical 9 user-data tables from migrations/mysql/0001-initial.sql.
     * @param {string} handle
     */
    async deleteUser(handle) {
        await this._ensureSchema();
        try {
            await withRetry(async () => {
                const conn = await acquireWithTimeout(this._pool, this._acquireTimeoutMs);
                try {
                    await conn.beginTransaction();
                    try {
                        for (const table of [
                            'chat_states', 'preset_states',
                            'chats', 'presets', 'worlds',
                            'named_docs', 'groups_table',
                            'settings', 'stats',
                        ]) {
                            await conn.query(`DELETE FROM ${table} WHERE handle = ?`, [handle]);
                        }
                        await conn.commit();
                    } catch (err) {
                        try { await conn.rollback(); } catch { /* best-effort */ }
                        throw err;
                    }
                } finally {
                    conn.release();
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
     * Per spec §4.1: mysql dumps to a text stream of newline-separated JSON-
     * encoded `{sql, params}` records — one INSERT per row. The dump is
     * dialect-specific (mysql uses `?` placeholders); the matching engine
     * kind is recorded in `_engine_meta.json` outside this stream so a
     * cross-dialect restore is caught at the orchestrator layer instead of
     * blowing up here with an opaque SQL error.
     *
     * Tables are emitted in PARENT-FIRST order (DUMP_TABLES) so a streaming
     * restore can INSERT in receive order without buffering: `chats` before
     * `chat_states` (FK CASCADE), `presets` before `preset_states` (no FK
     * today, future-proofed). The `integrity` column on `chats` is omitted
     * because it is GENERATED STORED — MySQL rejects explicit writes to it.
     *
     * Uses `Readable.from(asyncGenerator)` so backpressure flows naturally
     * to the consumer (HTTP response, file write, etc.) without holding the
     * whole dump in memory. The pool connection is acquired once at stream
     * start and released in the generator's `finally`, so an aborted
     * consumer still frees the slot.
     * @param {string} handle
     * @returns {Promise<import('node:stream').Readable>}
     */
    async dumpUser(handle) {
        await this._ensureSchema();
        const self = this;

        async function* generate() {
            const conn = await acquireWithTimeout(self._pool, self._acquireTimeoutMs);
            try {
                for (const t of DUMP_TABLES) {
                    const colsCsv = t.cols.join(', ');
                    const placeholders = t.cols.map(() => '?').join(', ');
                    const sqlText = `INSERT INTO ${t.name} (${colsCsv}) VALUES (${placeholders})`;
                    const [rows] = await conn.query(
                        `SELECT ${colsCsv} FROM ${t.name} WHERE handle = ?`,
                        [handle],
                    );
                    for (const row of rows) {
                        const params = t.cols.map((c) => normalizeDumpValue(row[c]));
                        yield JSON.stringify({ sql: sqlText, params }) + '\n';
                    }
                }
            } finally {
                conn.release();
            }
        }

        return Readable.from(generate());
    }

    /**
     * Per spec §4.1: mysql restore wipes the handle (idempotent — calls
     * `deleteUser` which is itself retry-wrapped) then replays the incoming
     * `{sql, params}` lines inside ONE transaction. A failed line rolls back
     * the whole restore so the user's slot is either fully restored or
     * unchanged — never half-applied.
     *
     * The wipe runs in its own transaction BEFORE the restore transaction
     * begins; if the restore later fails, the user is left wiped (not
     * mid-restored). This matches the spec's "idempotent" contract: re-
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
                const conn = await acquireWithTimeout(this._pool, this._acquireTimeoutMs);
                try {
                    await conn.beginTransaction();
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
                                await conn.query(sql, params);
                            }
                        }
                        buf += decoder.end();
                        const tail = buf.trim();
                        if (tail) {
                            const { sql, params } = JSON.parse(tail);
                            await conn.query(sql, params);
                        }
                        await conn.commit();
                    } catch (err) {
                        try { await conn.rollback(); } catch { /* best-effort */ }
                        throw err;
                    }
                } finally {
                    conn.release();
                }
            }, { retries: this._retries.transient });
        } catch (err) {
            logEngineError(this.kind, 'restore-user', handle, err);
            throw err;
        }
    }
}
