import pg from 'pg';
import { PgTransaction } from './postgres-engine-transaction.js';
import { initSchema } from './postgres-schema.js';

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
    constructor({ url, poolSize = 10 } = {}) {
        if (typeof url !== 'string' || !url) {
            throw new TypeError('PgEngine requires { url: "postgresql://user:pass@host:port/db" }');
        }
        this.kind = 'postgres';
        // pg.Pool keyed on connection-string + max. Max caps concurrent
        // leases so withTransaction queues past the limit instead of opening
        // unbounded sockets. The harness encodes a per-test schema into the
        // URL's `options=-csearch_path=...` parameter, so every connection
        // pulled from this pool already targets the right namespace — no
        // per-connection `SET search_path` needed.
        this._pool = new pg.Pool({ connectionString: url, max: poolSize });
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
                throw err;
            });
        }
        return this._schemaReady;
    }

    async ping(handle) { // eslint-disable-line no-unused-vars
        await this._ensureSchema();
        const client = await this._pool.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    }

    async withTransaction(handle, fn) {
        await this._ensureSchema();
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
    }

    async close() {
        await this._pool.end();
    }
}
