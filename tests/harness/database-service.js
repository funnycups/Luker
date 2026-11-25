import mysql from 'mysql2/promise';
import pg from 'pg';
import { failureGroup } from './resources/errors.js';

export const MYSQL_ROOT_URL = process.env.LUKER_TEST_MYSQL_ROOT_URL || 'mysql://root:root@127.0.0.1:53306';
export const PG_ROOT_URL = process.env.LUKER_TEST_POSTGRES_URL || 'postgresql://luker:postgres@127.0.0.1:55432/luker_test';
export const OWNERSHIP_ROUTINE = '_test_resource_owner';

export function rootUrl(value, backend) {
    const label = backend === 'mysql' ? 'MySQL' : 'PostgreSQL';
    if (typeof value !== 'string' || !value) throw new TypeError(`${label} root URL must be a nonempty string`);
    let url;
    try { url = new URL(value); }
    catch { throw new TypeError(`${label} root URL is not a valid URL`); }
    const protocols = backend === 'mysql' ? ['mysql:'] : ['postgres:', 'postgresql:'];
    if (!protocols.includes(url.protocol)) throw new TypeError(`${label} root URL must use ${protocols.join(' or ')}`);
    if (backend === 'postgres' && (!url.pathname || url.pathname === '/')) throw new TypeError('PostgreSQL root URL requires an explicit database');
    return url;
}

/** Connection credentials never enter a service receipt. */
export function serviceFor(value, backend) {
    const url = rootUrl(value, backend);
    return Object.freeze({ backend, host: url.hostname, port: url.port || (backend === 'mysql' ? '3306' : '5432'), database: backend === 'postgres' ? decodeURIComponent(url.pathname.slice(1)) : null });
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
    if (errors.length) throw failureGroup(errors, `Database operation and connection shutdown failed: ${errors.map(error => error.message).join('; ')}`);
    return value;
}

export function withMysql(value, action) {
    const url = rootUrl(value, 'mysql');
    return withConnection(() => mysql.createConnection(url.toString()), action, async connection => {
        const stream = connection.connection.stream;
        const closed = stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));
        try { await connection.end(); }
        catch (error) { connection.destroy(); throw error; }
        finally { await closed; }
    });
}

export function withPostgres(value, action) {
    const client = new pg.Client({ connectionString: rootUrl(value, 'postgres').toString() });
    return withConnection(async () => {
        try { await client.connect(); }
        catch (primary) {
            try { await client.end(); }
            catch (cleanup) { throw failureGroup([primary, cleanup], 'PostgreSQL connection admission and shutdown failed'); }
            throw primary;
        }
        return client;
    }, action, client => client.end());
}

export async function mysqlIdentity(connection) {
    const [rows] = await connection.query('SELECT VERSION() AS version, @@server_uuid AS server_id');
    const row = rows[0];
    if (typeof row?.version !== 'string' || !/^[a-f0-9-]{36}$/i.test(row?.server_id)) throw new Error('MySQL authentication preflight returned no verifiable server identity');
    return Object.freeze({ backend: 'mysql', version: row.version, serverId: row.server_id });
}

export async function postgresIdentity(client) {
    const result = await client.query('SELECT current_database() AS database, version() AS version, (pg_control_system()).system_identifier::text AS server_id');
    const row = result.rows[0];
    if (typeof row?.database !== 'string' || typeof row.version !== 'string' || !/^\d+$/.test(row.server_id)) throw new Error('PostgreSQL authentication preflight returned no verifiable server identity');
    return Object.freeze({ backend: 'postgres', version: row.version, database: row.database, serverId: row.server_id });
}

export function checkServer(lease, actual) {
    if (actual.backend !== lease.backend || actual.serverId !== lease.serverIdentity?.serverId || actual.database !== lease.serverIdentity?.database) {
        throw new Error(`Database service identity changed for run ${lease.runId} resource ${lease.resourceId} namespace ${lease.namespace}; retain ${lease.namespace}`);
    }
}

export async function preflightDatabases({ mysqlRootUrl = MYSQL_ROOT_URL, postgresRootUrl = PG_ROOT_URL } = {}) {
    const results = await Promise.allSettled([withMysql(mysqlRootUrl, mysqlIdentity), withPostgres(postgresRootUrl, postgresIdentity)]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw failureGroup(errors, `Database preflight failed: ${errors.map(error => error.message).join('; ')}`);
    return Object.freeze({ mysql: results[0].value, postgres: results[1].value });
}

export async function mysqlNamespace(connection, namespace) {
    const [schemas] = await connection.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [namespace]);
    if (!schemas.length) return null;
    const [routines] = await connection.query('SELECT ROUTINE_COMMENT AS receipt FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = \'PROCEDURE\'', [namespace, OWNERSHIP_ROUTINE]);
    return { receipt: routines[0]?.receipt ?? null };
}

export async function postgresNamespace(client, namespace) {
    const result = await client.query('SELECT oid::text AS oid, obj_description(oid, \'pg_namespace\') AS receipt FROM pg_namespace WHERE nspname = $1', [namespace]);
    return result.rows[0] ?? null;
}

export function checkNamespace(lease, actual) {
    if (actual.receipt !== lease.receipt || lease.backend === 'postgres' && lease.namespaceOid !== null && actual.oid !== lease.namespaceOid) {
        throw new Error(`Database namespace ownership changed for run ${lease.runId} resource ${lease.resourceId}: ${lease.namespace}; retain its manifest`);
    }
}

/** Exact identity is checked on the same connection that performs the DROP. */
export async function releaseNamespace(lease, configuredUrl) {
    const configured = serviceFor(configuredUrl, lease.backend);
    if (JSON.stringify(configured) !== JSON.stringify(lease.service)) throw new Error(`Configure the registered ${lease.backend} service ${lease.service.host}:${lease.service.port} before recovering run ${lease.runId} resource ${lease.resourceId}`);
    if (lease.state === 'prepared') return;
    if (lease.backend === 'mysql') {
        await withMysql(configuredUrl, async connection => {
            checkServer(lease, await mysqlIdentity(connection));
            const actual = await mysqlNamespace(connection, lease.namespace);
            if (actual === null) return;
            checkNamespace(lease, actual);
            await connection.query(`DROP DATABASE \`${lease.namespace}\``);
            if (await mysqlNamespace(connection, lease.namespace) !== null) throw new Error(`MySQL namespace still exists after DROP: ${lease.namespace}`);
        });
    } else {
        await withPostgres(configuredUrl, async client => {
            checkServer(lease, await postgresIdentity(client));
            const actual = await postgresNamespace(client, lease.namespace);
            if (actual === null) return;
            checkNamespace(lease, actual);
            await client.query(`DROP SCHEMA "${lease.namespace}" CASCADE`);
            if (await postgresNamespace(client, lease.namespace) !== null) throw new Error(`PostgreSQL namespace still exists after DROP: ${lease.namespace}`);
        });
    }
}
