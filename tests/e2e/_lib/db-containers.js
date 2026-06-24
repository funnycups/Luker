// Spin up ephemeral mysql / postgres containers via testcontainers so the
// LAN Sync mysql / postgres specs can run their full pair-and-sync flow
// against real engines without depending on a long-lived dev database.
//
// Both helpers return `{ url, host, port, stop }`. The URL targets the
// root user against a chosen database; for two-server specs the caller
// invokes the helper TWICE per container (or creates two databases up
// front) so each Luker process has an isolated namespace.
//
// `Wait.forLogMessage` is preferred over `forSuccessfulCommand`: the
// official mysql/postgres images print a distinctive "ready for
// connections" line as the final startup signal. The test harness
// blocks on that and only then opens the first connection — avoiding
// races where the schema bootstrap inside Luker hits the engine
// while it's still finishing crash recovery on a cold start.

import { GenericContainer, Wait } from 'testcontainers';
import mysql from 'mysql2/promise';
import pg from 'pg';

const ROOT_PASSWORD = 'luker-test-root';

/**
 * @typedef {object} DbContainerHandle
 * @property {string} url        Connection string with root creds + db.
 * @property {string} host       Host the container is bound to.
 * @property {number} port       Random mapped port on the host.
 * @property {() => Promise<void>} stop  Stop the container and free the port.
 */

/**
 * @typedef {object} DbContainerOpts
 * @property {string[]} databases   Names of empty databases to create at
 *   boot. The first one is used in the returned `url`.
 * @property {number} [startupTimeoutMs]  Override the default startup
 *   wait (mysql cold-starts are slower on first pull).
 */

/**
 * Start a one-off mysql:8.0 container with the requested databases.
 *
 * @param {DbContainerOpts} opts
 * @returns {Promise<DbContainerHandle & { urlFor: (db: string) => string }>}
 */
export async function startMysqlContainer({ databases = ['luker'], startupTimeoutMs = 180_000 } = {}) {
    if (!Array.isArray(databases) || databases.length === 0) {
        throw new TypeError('startMysqlContainer: databases must be a non-empty array');
    }
    const primaryDb = databases[0];
    const container = await new GenericContainer('mysql:8.0')
        .withEnvironment({
            MYSQL_ROOT_PASSWORD: ROOT_PASSWORD,
            MYSQL_DATABASE: primaryDb,
        })
        .withExposedPorts(3306)
        // The mysql:8.0 entrypoint logs the "ready for connections" line
        // twice — first when init scripts run, then on the second listen.
        // Anchor on the second occurrence so the pool is ready before any
        // test query.
        .withWaitStrategy(Wait.forLogMessage(/ready for connections.*port: 3306/, 2))
        .withStartupTimeout(startupTimeoutMs)
        .start();
    const host = container.getHost();
    const port = container.getMappedPort(3306);
    const urlFor = (db) => `mysql://root:${encodeURIComponent(ROOT_PASSWORD)}@${host}:${port}/${encodeURIComponent(db)}`;
    // Create the remaining databases (the first one is created by the
    // MYSQL_DATABASE env var). We open a transient root pool against the
    // server (no db scoped) for the CREATE DATABASE statements.
    if (databases.length > 1) {
        const adminPool = mysql.createPool({
            uri: `mysql://root:${encodeURIComponent(ROOT_PASSWORD)}@${host}:${port}/`,
            connectionLimit: 2,
        });
        try {
            for (const db of databases.slice(1)) {
                // Identifier escaping: mysql allows `IF NOT EXISTS` and
                // backtick-quoted db names. The names come from the caller
                // (test code), not user input, so a basic identifier-safe
                // check is enough; reject anything outside [A-Za-z0-9_].
                if (!/^[A-Za-z0-9_]+$/.test(db)) {
                    throw new Error(`startMysqlContainer: unsafe database name "${db}"`);
                }
                await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
            }
        } finally {
            await adminPool.end();
        }
    }
    return {
        url: urlFor(primaryDb),
        urlFor,
        host,
        port,
        async stop() { await container.stop({ remove: true, removeVolumes: true }); },
    };
}

/**
 * Start a one-off postgres:16 container with the requested databases.
 *
 * @param {DbContainerOpts} opts
 * @returns {Promise<DbContainerHandle & { urlFor: (db: string) => string }>}
 */
export async function startPostgresContainer({ databases = ['luker'], startupTimeoutMs = 120_000 } = {}) {
    if (!Array.isArray(databases) || databases.length === 0) {
        throw new TypeError('startPostgresContainer: databases must be a non-empty array');
    }
    const primaryDb = databases[0];
    const container = await new GenericContainer('postgres:16')
        .withEnvironment({
            POSTGRES_PASSWORD: ROOT_PASSWORD,
            POSTGRES_DB: primaryDb,
        })
        .withExposedPorts(5432)
        // The postgres image prints "database system is ready to accept
        // connections" twice (initdb then the actual server bind); anchor
        // on the second so the pool query in `urlFor` doesn't race the
        // first-boot init.
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withStartupTimeout(startupTimeoutMs)
        .start();
    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const urlFor = (db) => `postgresql://postgres:${encodeURIComponent(ROOT_PASSWORD)}@${host}:${port}/${encodeURIComponent(db)}`;
    if (databases.length > 1) {
        const adminClient = new pg.Client({ connectionString: urlFor(primaryDb) });
        await adminClient.connect();
        try {
            for (const db of databases.slice(1)) {
                if (!/^[A-Za-z0-9_]+$/.test(db)) {
                    throw new Error(`startPostgresContainer: unsafe database name "${db}"`);
                }
                // CREATE DATABASE is non-transactional; emit it raw and
                // swallow "already exists" so the helper is idempotent
                // across test re-runs on a reused container.
                try {
                    await adminClient.query(`CREATE DATABASE "${db}"`);
                } catch (err) {
                    if (!/already exists/i.test(String(err?.message || ''))) throw err;
                }
            }
        } finally {
            await adminClient.end();
        }
    }
    return {
        url: urlFor(primaryDb),
        urlFor,
        host,
        port,
        async stop() { await container.stop({ remove: true, removeVolumes: true }); },
    };
}
