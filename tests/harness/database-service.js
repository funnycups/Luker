import mysql from 'mysql2/promise';
import pg from 'pg';
import { failureGroup } from './resources/errors.js';

export const MYSQL_ROOT_URL = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
export const PG_ROOT_URL = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';

export function rootUrl(value, backend) {
    const label = backend === 'mysql' ? 'MySQL' : 'PostgreSQL';
    if (typeof value !== 'string' || !value) throw new TypeError(`${label} root URL must be a nonempty string`);
    let url;
    try { url = new URL(value); }
    catch { throw new TypeError(`${label} root URL is not a valid URL`); }
    const protocols = backend === 'mysql' ? ['mysql:'] : ['postgres:', 'postgresql:'];
    if (!protocols.includes(url.protocol)) throw new TypeError(`${label} root URL must use ${protocols.join(' or ')}`);
    if (backend === 'postgres' && (!url.pathname || url.pathname === '/')) {
        throw new TypeError('PostgreSQL root URL requires an explicit database');
    }
    return url;
}

export function databaseUrl(value, backend, namespace) {
    const url = rootUrl(value, backend);
    if (backend === 'mysql') url.pathname = `/${namespace}`;
    else url.searchParams.set('options', `-csearch_path=${namespace}`);
    return url.toString();
}

async function withConnection(connect, action, close) {
    const connection = await connect();
    const errors = [];
    let value;
    try { value = await action(connection); }
    catch (error) { errors.push(error); }
    try { await close(connection); }
    catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) {
        throw failureGroup(errors, `Database operation and connection shutdown failed: ${errors.map(e => e.message).join('; ')}`);
    }
    return value;
}

export function withMysql(value, action) {
    const url = rootUrl(value, 'mysql');
    return withConnection(
        () => mysql.createConnection(url.toString()),
        action,
        async (connection) => {
            const stream = connection.connection.stream;
            const closed = stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));
            try { await connection.end(); }
            catch (error) { connection.destroy(); throw error; }
            finally { await closed; }
        },
    );
}

export function withPostgres(value, action) {
    const client = new pg.Client({ connectionString: rootUrl(value, 'postgres').toString() });
    return withConnection(
        async () => {
            try { await client.connect(); }
            catch (primary) {
                try { await client.end(); }
                catch (cleanup) { throw failureGroup([primary, cleanup], 'PostgreSQL connection failed'); }
                throw primary;
            }
            return client;
        },
        action,
        client => client.end(),
    );
}

export async function preflightDatabases({ mysqlRootUrl = MYSQL_ROOT_URL, postgresRootUrl = PG_ROOT_URL } = {}) {
    const results = await Promise.allSettled([
        withMysql(mysqlRootUrl, async (connection) => {
            const [rows] = await connection.query('SELECT VERSION() AS version, @@server_uuid AS server_id');
            return Object.freeze({ backend: 'mysql', version: rows[0]?.version, serverId: rows[0]?.server_id });
        }),
        withPostgres(postgresRootUrl, async (client) => {
            const result = await client.query('SELECT current_database() AS database, version() AS version');
            return Object.freeze({ backend: 'postgres', version: result.rows[0]?.version, database: result.rows[0]?.database });
        }),
    ]);
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) {
        throw failureGroup(errors, `Database preflight failed: ${errors.map(e => e.message).join('; ')}`);
    }
    return Object.freeze({ mysql: results[0].value, postgres: results[1].value });
}

export async function dropMysqlDatabase(rootUrlValue, namespace) {
    await withMysql(rootUrlValue, async (connection) => {
        await connection.query(`DROP DATABASE IF EXISTS \`${namespace}\``);
    });
}

export async function dropPostgresSchema(rootUrlValue, namespace) {
    await withPostgres(rootUrlValue, async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    });
}
