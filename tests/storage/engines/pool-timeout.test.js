import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { MysqlEngine } from '../../../src/storage/engines/mysql-engine.js';
import { PgEngine } from '../../../src/storage/engines/postgres-engine.js';

// Match the harness's DB/connection-string defaults; the controller's docker
// containers expose mysql on 53306 and postgres on 55432 against these roles.
const MYSQL_ROOT_URL = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
const PG_ROOT_URL = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';

const describeMysql = process.env.LUKER_DISABLE_MYSQL_TESTS ? describe.skip : describe;
const describePg = process.env.LUKER_DISABLE_POSTGRES_TESTS ? describe.skip : describe;

// MysqlEngine bootstraps schema on first withTransaction/ping. The pool-timeout
// test deliberately holds the only pool slot with a controllable promise, so
// the bootstrap must already be complete before we wedge the pool. We create a
// real per-test database via the same CREATE-DATABASE recipe the harness uses,
// run a one-shot ping with the timeout-free engine, then construct the timeout
// engine pointed at the same database.

describeMysql('MysqlEngine pool acquire timeout', () => {
    const dbName = `luker_test_pool_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const dbUrl = `${MYSQL_ROOT_URL}/${dbName}`;

    beforeAll(async () => {
        const rootConn = await mysql.createConnection(MYSQL_ROOT_URL);
        try {
            await rootConn.query(
                `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
            );
        } finally {
            await rootConn.end();
        }
        // Warm the schema with a normal-default engine so the timeout engine's
        // first withTransaction doesn't have to run initSchema while one slot
        // is wedged by the blocker promise.
        const warmEngine = new MysqlEngine({ url: dbUrl });
        try {
            await warmEngine.ping('alice');
        } finally {
            await warmEngine.close();
        }
    }, 15000);

    afterAll(async () => {
        const rootConn = await mysql.createConnection(MYSQL_ROOT_URL);
        try {
            await rootConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
        } finally {
            await rootConn.end();
        }
    }, 15000);

    test('respects acquireTimeoutMs when pool is exhausted', async () => {
        // poolSize=1 so the second concurrent acquire queues; acquireTimeoutMs=200
        // short-circuits the queue. retries=0 so the timeout failure surfaces
        // immediately instead of three retries x ~200ms each.
        const engine = new MysqlEngine({
            url: dbUrl,
            poolSize: 1,
            acquireTimeoutMs: 200,
            retries: { transient: 0 },
        });
        // Controllable blocker: the first withTransaction's `fn(tx)` awaits
        // this signal so we can hold the only pool slot until we're ready to
        // tear down. Resolving the signal lets the blocker commit + release
        // its connection so engine.close() can drain the pool cleanly.
        let releaseBlocker;
        const blockerReleased = new Promise((resolve) => { releaseBlocker = resolve; });
        try {
            const blocker = engine.withTransaction('alice', () => blockerReleased);
            blocker.catch(() => {}); // never reject silently in case teardown races
            // Second call should time out — the queue wait must reject before
            // the jest timeout fires.
            const start = Date.now();
            await expect(
                engine.withTransaction('alice', async () => 'unreachable'),
            ).rejects.toThrow(/POOL_ACQUIRE_TIMEOUT|timed out/);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeLessThan(2000);
            // Let the blocker finish so engine.close() can drain.
            releaseBlocker();
            await blocker;
        } finally {
            // If the test threw before releasing the blocker, do it now so
            // engine.close() doesn't hang on the in-flight transaction.
            if (releaseBlocker) releaseBlocker();
            await engine.close();
        }
    }, 5000);
});

describePg('PgEngine pool acquire timeout', () => {
    const schemaName = `luker_test_pool_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    // Bake search_path into the URL the same way the pg harness does so the
    // schema bootstrap targets the per-test namespace instead of public.
    const dbUrl = `${PG_ROOT_URL}?options=-csearch_path%3D${encodeURIComponent(schemaName)}`;

    beforeAll(async () => {
        const rootClient = new pg.Client({ connectionString: PG_ROOT_URL });
        await rootClient.connect();
        try {
            await rootClient.query(`CREATE SCHEMA "${schemaName}"`);
        } finally {
            await rootClient.end();
        }
        const warmEngine = new PgEngine({ url: dbUrl });
        try {
            await warmEngine.ping('alice');
        } finally {
            await warmEngine.close();
        }
    }, 15000);

    afterAll(async () => {
        const rootClient = new pg.Client({ connectionString: PG_ROOT_URL });
        await rootClient.connect();
        try {
            await rootClient.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } finally {
            await rootClient.end();
        }
    }, 15000);

    test('respects acquireTimeoutMs when pool is exhausted', async () => {
        const engine = new PgEngine({
            url: dbUrl,
            poolSize: 1,
            acquireTimeoutMs: 200,
            retries: { transient: 0 },
        });
        let releaseBlocker;
        const blockerReleased = new Promise((resolve) => { releaseBlocker = resolve; });
        try {
            const blocker = engine.withTransaction('alice', () => blockerReleased);
            blocker.catch(() => {});
            const start = Date.now();
            await expect(
                engine.withTransaction('alice', async () => 'unreachable'),
            ).rejects.toThrow(/timeout|timed out/i);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeLessThan(2000);
            releaseBlocker();
            await blocker;
        } finally {
            if (releaseBlocker) releaseBlocker();
            await engine.close();
        }
    }, 5000);
});
