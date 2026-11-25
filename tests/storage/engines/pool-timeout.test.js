import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { MysqlEngine } from '../../../src/storage/engines/mysql-engine.js';
import { PgEngine } from '../../../src/storage/engines/postgres-engine.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { makeTempMysqlEngineHarness } from '../harness/mysql-harness.js';
import { makeTempPgEngineHarness } from '../harness/pg-harness.js';

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

    test('respects acquireTimeoutMs when pool is exhausted (mysql)', async () => {
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

    test('respects acquireTimeoutMs when pool is exhausted (postgres)', async () => {
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

describeMysql('MysqlEngine connection error lifecycle and deterministic ordering', () => {
    let h;

    beforeEach(async () => {
        h = await makeTempMysqlEngineHarness();
        await h.engine.ping(h.handle);
    });

    afterEach(async () => {
        if (h) await h.cleanup();
    });

    test('destroys an errored connection even after BEGIN succeeded', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        let firstConnId;
        let secondConnId;
        try {
            await h.engine.withTransaction(h.handle, async (tx) => {
                const [[{ id }]] = await tx._conn.query('SELECT CONNECTION_ID() AS id');
                firstConnId = id;
                tx._conn.emit('error', Object.assign(new Error('synthetic mysql socket drop'), { code: 'ECONNRESET' }));
            });

            await h.engine.withTransaction(h.handle, async (tx) => {
                const [[{ id }]] = await tx._conn.query('SELECT CONNECTION_ID() AS id');
                secondConnId = id;
            });

            expect(secondConnId).toBeDefined();
            expect(secondConnId).not.toBe(firstConnId);
        } finally {
            errSpy.mockRestore();
        }
    });

    test('logs idle raw connection errors via pool connection listener without crashing', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await h.engine.ping(h.handle);
            const rawPool = h.engine._pool.pool;
            expect(rawPool._freeConnections.length).toBeGreaterThan(0);
            const idleConn = rawPool._freeConnections.get(0);
            expect(idleConn._released).toBe(true);

            expect(() => {
                idleConn.emit('error', Object.assign(new Error('idle mysql reset'), { code: 'PROTOCOL_CONNECTION_LOST' }));
            }).not.toThrow();

            expect(errSpy).toHaveBeenCalledWith(
                expect.stringContaining('[storage:mysql] op=idle-connection'),
            );
        } finally {
            errSpy.mockRestore();
        }
    });

    test('destroys errored connection in ping (mysql)', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const origGetConnection = h.engine._pool.getConnection.bind(h.engine._pool);
            let destroyedInPing = false;
            h.engine._pool.getConnection = async () => {
                const conn = await origGetConnection();
                const origQuery = conn.query.bind(conn);
                const origDestroy = conn.destroy.bind(conn);
                conn.destroy = () => {
                    destroyedInPing = true;
                    return origDestroy();
                };
                conn.query = async (...args) => {
                    conn.emit('error', new Error('ping socket error'));
                    return origQuery(...args);
                };
                h.engine._pool.getConnection = origGetConnection;
                return conn;
            };
            await h.engine.ping(h.handle);
            expect(destroyedInPing).toBe(true);
        } finally {
            errSpy.mockRestore();
        }
    });

    test('listAllNames resolves tolerant world lookup deterministically by ORDER BY name ASC (mysql)', async () => {
        const worlds = new WorldInfoRepo({ engine: h.engine });
        await h.engine._pool.execute(
            'INSERT INTO worlds (handle, name, doc, updated_at, revision) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
            [
                h.handle, 'Beta Book', JSON.stringify({ entries: { '1': { content: 'single-space' } } }), 100, 'r1',
                h.handle, 'Beta  Book', JSON.stringify({ entries: { '2': { content: 'double-space' } } }), 100, 'r2',
            ],
        );
        expect(await worlds.resolveName(h.handle, 'Beta   Book')).toBe('Beta  Book');
    });
});

describePg('PgEngine connection error lifecycle and deterministic ordering', () => {
    let h;

    beforeEach(async () => {
        h = await makeTempPgEngineHarness();
        await h.engine.ping(h.handle);
    });

    afterEach(async () => {
        if (h) await h.cleanup();
    });

    test('destroys an errored client even after BEGIN succeeded', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        let firstPid;
        let secondPid;
        try {
            await h.engine.withTransaction(h.handle, async (tx) => {
                const r = await tx._client.query('SELECT pg_backend_pid() AS pid');
                firstPid = r.rows[0].pid;
                tx._client.emit('error', new Error('synthetic pg connection error'));
            });

            await h.engine.withTransaction(h.handle, async (tx) => {
                const r = await tx._client.query('SELECT pg_backend_pid() AS pid');
                secondPid = r.rows[0].pid;
            });

            expect(secondPid).toBeDefined();
            expect(secondPid).not.toBe(firstPid);
        } finally {
            errSpy.mockRestore();
        }
    });

    test('attaches error listener and destroys errored client in ping and dumpUser', async () => {
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const origConnect = h.engine._pool.connect.bind(h.engine._pool);
            let pingReleaseArg;
            h.engine._pool.connect = async () => {
                const client = await origConnect();
                const origQuery = client.query.bind(client);
                const origRelease = client.release.bind(client);
                client.release = (arg) => {
                    pingReleaseArg = arg;
                    return origRelease(arg);
                };
                client.query = async (...args) => {
                    client.emit('error', new Error('pg ping socket error'));
                    return origQuery(...args);
                };
                h.engine._pool.connect = origConnect;
                return client;
            };
            await h.engine.ping(h.handle);
            expect(pingReleaseArg).toBeInstanceOf(Error);
            expect(pingReleaseArg.message).toBe('pg ping socket error');

            let dumpReleaseArg;
            h.engine._pool.connect = async () => {
                const client = await origConnect();
                const origQuery = client.query.bind(client);
                const origRelease = client.release.bind(client);
                let emitted = false;
                client.release = (arg) => {
                    dumpReleaseArg = arg;
                    return origRelease(arg);
                };
                client.query = async (...args) => {
                    if (!emitted) {
                        emitted = true;
                        client.emit('error', new Error('pg dump socket error'));
                    }
                    return origQuery(...args);
                };
                h.engine._pool.connect = origConnect;
                return client;
            };
            const dump = await h.engine.dumpUser(h.handle);
            const chunks = [];
            for await (const chunk of dump) { chunks.push(chunk); }
            expect(chunks.length).toBeGreaterThanOrEqual(0);
            expect(dumpReleaseArg).toBeInstanceOf(Error);
            expect(dumpReleaseArg.message).toBe('pg dump socket error');
        } finally {
            errSpy.mockRestore();
        }
    });

    test('listAllNames resolves tolerant world lookup deterministically by ORDER BY name ASC (postgres)', async () => {
        const worlds = new WorldInfoRepo({ engine: h.engine });
        await h.engine._pool.query(
            'INSERT INTO worlds (handle, name, doc, updated_at, revision) VALUES ($1, $2, $3::jsonb, $4, $5), ($1, $6, $7::jsonb, $4, $8)',
            [
                h.handle,
                'Beta Book', JSON.stringify({ entries: { '1': { content: 'single-space' } } }), 100, 'r1',
                'Beta  Book', JSON.stringify({ entries: { '2': { content: 'double-space' } } }), 'r2',
            ],
        );
        const expected = (await h.engine._pool.query('SELECT name FROM worlds WHERE handle=$1 ORDER BY name ASC', [h.handle])).rows[0].name;
        expect(await worlds.resolveName(h.handle, 'Beta   Book')).toBe(expected);
    });
});
