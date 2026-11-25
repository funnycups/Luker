/** Own a real transaction's row lock and observe only its blocked DELETE. */
export async function holdWorldRow(harness, handle, name) {
    const mysql = harness.kind === 'mysql';
    const pool = harness.engine._pool;
    const connection = mysql ? await pool.getConnection() : await pool.connect();
    let active = false;
    try {
        await connection.query('BEGIN');
        active = true;
        await connection.query(mysql ? 'SELECT name FROM worlds WHERE handle=? AND name=? FOR UPDATE' : 'SELECT name FROM worlds WHERE handle=$1 AND name=$2 FOR UPDATE', [handle, name]);
        const result = await connection.query(mysql ? 'SELECT CONNECTION_ID() AS pid' : 'SELECT pg_backend_pid() AS pid');
        const pid = mysql ? result[0][0].pid : result.rows[0].pid;
        return {
            pid,
            async waits() {
                if (mysql) {
                    const [rows] = await pool.query(`SELECT t.PROCESSLIST_ID AS pid, t.PROCESSLIST_INFO AS statement
                        FROM performance_schema.data_lock_waits w
                        JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE=w.ENGINE
                        JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID
                        JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID
                        WHERE l.OBJECT_SCHEMA=? AND l.OBJECT_NAME='worlds' AND b.PROCESSLIST_ID=? AND t.PROCESSLIST_INFO LIKE 'DELETE FROM worlds%'`, [harness.dbName, pid]);
                    return rows;
                }
                const result = await pool.query(`SELECT pid, query AS statement, pg_blocking_pids(pid) AS blockers
                    FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user
                    AND wait_event_type='Lock' AND query LIKE 'DELETE FROM worlds%' AND $1=ANY(pg_blocking_pids(pid))`, [pid]);
                return result.rows;
            },
            async release() {
                if (active) { await connection.query('COMMIT'); active = false; }
            },
            async close() {
                try { if (active) { await connection.query('ROLLBACK'); active = false; } }
                finally { connection.release(); }
            },
        };
    } catch (error) {
        try { if (active) await connection.query('ROLLBACK'); }
        finally { connection.release(); }
        throw error;
    }
}
