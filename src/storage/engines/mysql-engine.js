import mysql from 'mysql2/promise';
import { MysqlTransaction } from './mysql-engine-transaction.js';
import { initSchema } from './mysql-schema.js';

export class MysqlEngine {
    constructor({ url, poolSize = 10 } = {}) {
        if (typeof url !== 'string' || !url) {
            throw new TypeError('MysqlEngine requires { url: "mysql://user:pass@host:port/db" }');
        }
        this.kind = 'mysql';
        // mysql2/promise pool. charset=utf8mb4 keeps inserts consistent with
        // the schema's utf8mb4_bin collation; connectionLimit caps concurrent
        // leases so withTransaction queues past the limit instead of opening
        // unbounded sockets.
        this._pool = mysql.createPool({
            uri: url,
            connectionLimit: poolSize,
            charset: 'utf8mb4',
            // Allow multiple PK fields without auto-string casts; the
            // composite-key handlers in Task 3 rely on raw 0/1 for is_group.
            namedPlaceholders: false,
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
                throw err;
            });
        }
        return this._schemaReady;
    }

    async ping(handle) { // eslint-disable-line no-unused-vars
        await this._ensureSchema();
        const conn = await this._pool.getConnection();
        try {
            await conn.query('SELECT 1');
        } finally {
            conn.release();
        }
    }

    async withTransaction(handle, fn) {
        await this._ensureSchema();
        const conn = await this._pool.getConnection();
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
    }

    async close() {
        await this._pool.end();
    }
}
