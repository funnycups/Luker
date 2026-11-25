import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { initSchema as initMysqlSchema } from '../../src/storage/engines/mysql-schema.js';
import { registerProvider } from './resources/providers.js';
import { failureGroup } from './resources/errors.js';
import { mysqlFingerprint, emptyMysql } from './database-fingerprint.js';
import { MYSQL_ROOT_URL, PG_ROOT_URL, OWNERSHIP_ROUTINE, serviceFor, databaseUrl, withMysql, withPostgres, mysqlIdentity, postgresIdentity, mysqlNamespace, checkServer, checkNamespace, releaseNamespace } from './database-service.js';

const idleMysql = new Map();
const physicalUrls = new Map();
const caseLeases = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const namespaceFor = resourceId => `luker_test_${resourceId.replaceAll('-', '')}`;
let registered = false;

function saveManifest(filename, lease, initial = false) {
    const value = JSON.stringify(lease, null, 2) + '\n';
    if (initial) fs.writeFileSync(filename, value, { flag: 'wx', mode: 0o600 });
    else {
        const pending = `${filename}.pending`;
        fs.writeFileSync(pending, value, { mode: 0o600 });
        fs.renameSync(pending, filename);
    }
}

function readManifest(record, format) {
    if (!fs.existsSync(record.locator.path)) {
        if (record.locator.dev !== null) throw new Error(`Database custody directory is missing for run ${record.runId} resource ${record.resourceId}; remote ownership cannot be verified`);
        return null;
    }
    const filename = path.join(record.locator.path, 'lease.json');
    let descriptor;
    try { descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
        if (error.code === 'ENOENT' && ['allocating', 'acquired'].includes(record.state)) return null;
        throw error;
    }
    let lease;
    try {
        if (!fs.fstatSync(descriptor).isFile()) throw new Error(`Database manifest is not a regular file: ${filename}`);
        lease = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally { fs.closeSync(descriptor); }
    const physicalId = format === 'test-db-resource-v2' ? record.resourceId : lease.physicalResourceId;
    if (lease.format !== format || lease.runId !== record.runId || lease.resourceId !== record.resourceId ||
        typeof physicalId !== 'string' || !/^[a-f0-9-]{36}$/.test(physicalId) || lease.namespace !== namespaceFor(physicalId) ||
        !['mysql', 'postgres'].includes(lease.backend) || Object.hasOwn(lease, 'rootUrl') || Object.hasOwn(lease, 'url')) {
        throw new Error(`Database manifest does not match registered run ${record.runId} resource ${record.resourceId}: ${filename}`);
    }
    if (format === 'test-db-resource-v2' && (!/^[a-f0-9-]{36}$/.test(lease.nonce) || !['prepared', 'creating', 'ready', 'idle'].includes(lease.state) ||
        lease.receipt !== JSON.stringify({ format: 'test-db-owner-v2', runId: record.runId, resourceId: record.resourceId, nonce: lease.nonce }))) {
        throw new Error(`Database ownership receipt is invalid: ${filename}`);
    }
    if (format === 'test-db-case-lease-v2' && !record.dependencies.includes(lease.physicalResourceId)) throw new Error(`Database case lease has no registered physical dependency: ${filename}`);
    return lease;
}

function configuredRoot(lease, options) {
    const defaults = lease.backend === 'mysql' ? MYSQL_ROOT_URL : PG_ROOT_URL;
    const candidates = options.databaseRootUrls?.[lease.backend] ?? [defaults];
    if (!Array.isArray(candidates) || candidates.some(value => typeof value !== 'string')) throw new TypeError('Database recovery requires databaseRootUrls arrays keyed by backend');
    const result = candidates.find(value => JSON.stringify(serviceFor(value, lease.backend)) === JSON.stringify(lease.service));
    if (!result) throw new Error(`Configure databaseRootUrls.${lease.backend} for ${lease.service.host}:${lease.service.port} before recovering run ${lease.runId} resource ${lease.resourceId}`);
    return result;
}

async function allocatePhysical(handle, { rootUrl, fresh = false }, backend) {
    const service = serviceFor(rootUrl, backend);
    const identity = handle.createDirectory();
    await handle.publish(identity);
    const directory = identity.path;
    const filename = path.join(directory, 'lease.json');
    const nonce = randomUUID();
    const lease = {
        format: 'test-db-resource-v2', runId: handle.runId, resourceId: handle.resourceId, scopeId: handle.scopeId,
        backend, namespace: namespaceFor(handle.resourceId), service, serverIdentity: null, serverVersion: null,
        nonce, receipt: JSON.stringify({ format: 'test-db-owner-v2', runId: handle.runId, resourceId: handle.resourceId, nonce }),
        state: 'prepared', created: false, claimed: false, namespaceOid: null, fresh, fingerprint: null,
    };
    physicalUrls.set(handle.resourceId, rootUrl);
    saveManifest(filename, lease, true);
    if (backend === 'mysql') {
        await withMysql(rootUrl, async connection => {
            lease.serverIdentity = await mysqlIdentity(connection);
            lease.serverVersion = lease.serverIdentity.version;
            lease.state = 'creating';
            saveManifest(filename, lease);
            await connection.query(`CREATE DATABASE \`${lease.namespace}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
            lease.created = true;
            saveManifest(filename, lease);
            await connection.query(`CREATE PROCEDURE \`${lease.namespace}\`.\`${OWNERSHIP_ROUTINE}\`() COMMENT ? SELECT 1`, [lease.receipt]);
            lease.claimed = true;
            saveManifest(filename, lease);
        });
        if (!fresh) await withMysql(databaseUrl(rootUrl, backend, lease.namespace), async connection => {
            checkServer(lease, await mysqlIdentity(connection));
            checkNamespace(lease, await mysqlNamespace(connection, lease.namespace));
            await initMysqlSchema(connection);
            lease.fingerprint = sha(await mysqlFingerprint(connection, lease.namespace));
            saveManifest(filename, lease);
        });
    } else {
        await withPostgres(rootUrl, async client => {
            lease.serverIdentity = await postgresIdentity(client);
            lease.serverVersion = lease.serverIdentity.version;
            lease.state = 'creating';
            saveManifest(filename, lease);
            await client.query('BEGIN');
            try {
                await client.query(`CREATE SCHEMA "${lease.namespace}"`);
                await client.query(`COMMENT ON SCHEMA "${lease.namespace}" IS ${client.escapeLiteral(lease.receipt)}`);
                const result = await client.query('SELECT oid::text AS oid FROM pg_namespace WHERE nspname = $1', [lease.namespace]);
                await client.query('COMMIT');
                lease.created = true;
                lease.claimed = true;
                lease.namespaceOid = result.rows[0].oid;
                saveManifest(filename, lease);
            } catch (primary) {
                try { await client.query('ROLLBACK'); }
                catch (cleanup) { throw failureGroup([primary, cleanup], `Schema ${lease.namespace} creation and rollback failed`); }
                throw primary;
            }
        });
    }
    lease.state = 'ready';
    saveManifest(filename, lease);
    return Object.freeze({
        backend, name: lease.namespace, namespace: lease.namespace, ...(backend === 'postgres' ? { schemaName: lease.namespace } : {}),
        url: databaseUrl(rootUrl, backend, lease.namespace), runId: handle.runId, scopeId: handle.scopeId,
        resourceId: handle.resourceId, manifestPath: filename, locator: Object.freeze({ path: directory, dev: identity.dev, ino: identity.ino }), fresh, reused: false,
    });
}

function forgetPhysical(resourceId) {
    physicalUrls.delete(resourceId);
    for (const [key, idle] of idleMysql) {
        const retained = idle.filter(value => value.resourceId !== resourceId);
        if (retained.length) idleMysql.set(key, retained);
        else idleMysql.delete(key);
    }
}

async function disposePhysical(record) {
    const lease = readManifest(record, 'test-db-resource-v2');
    if (lease !== null) await releaseNamespace(lease, physicalUrls.get(record.resourceId));
    record.removeDirectory();
    forgetPhysical(record.resourceId);
}

async function withPhysicalMysql(physical, action) {
    const lease = readManifest(physical, 'test-db-resource-v2');
    return withMysql(physical.url, async connection => {
        checkServer(lease, await mysqlIdentity(connection));
        const actual = await mysqlNamespace(connection, lease.namespace);
        if (actual === null) throw new Error(`Registered database disappeared before lease release: ${lease.namespace}`);
        checkNamespace(lease, actual);
        return action(connection, lease);
    });
}

async function allocateCaseLease(handle, { physical, poolKey, reused }) {
    const identity = handle.createDirectory();
    await handle.publish(identity);
    const directory = identity.path;
    const manifestPath = path.join(directory, 'lease.json');
    saveManifest(manifestPath, {
        format: 'test-db-case-lease-v2', runId: handle.runId, resourceId: handle.resourceId,
        backend: physical.backend, namespace: physical.namespace, physicalResourceId: physical.resourceId,
    }, true);
    caseLeases.set(handle.resourceId, { physical, poolKey });
    return Object.freeze({ ...physical, resourceId: handle.resourceId, manifestPath, fresh: false, reused });
}

async function disposeCaseLease(record) {
    const lease = readManifest(record, 'test-db-case-lease-v2');
    if (lease !== null) {
        const live = caseLeases.get(record.resourceId);
        await withPhysicalMysql(live.physical, async (connection, physicalLease) => {
            if (sha(await mysqlFingerprint(connection, lease.namespace)) === physicalLease.fingerprint) await emptyMysql(connection, lease.namespace);
            physicalLease.state = 'idle';
            saveManifest(live.physical.manifestPath, physicalLease);
        });
        const idle = idleMysql.get(live.poolKey) ?? [];
        idle.push(live.physical);
        idleMysql.set(live.poolKey, idle);
    }
    record.removeDirectory();
    caseLeases.delete(record.resourceId);
}

const recoverPhysical = async (record, options) => {
    const lease = readManifest(record, 'test-db-resource-v2');
    if (lease !== null) await releaseNamespace(lease, configuredRoot(lease, options));
    forgetPhysical(record.resourceId);
};
const mysqlProvider = Object.freeze({ kind: 'mysql-database', allocate: (handle, options) => allocatePhysical(handle, options, 'mysql'), dispose: disposePhysical, recover: recoverPhysical });
const postgresProvider = Object.freeze({ kind: 'postgres-schema', allocate: (handle, options) => allocatePhysical(handle, options, 'postgres'), dispose: disposePhysical, recover: recoverPhysical });
const mysqlLeaseProvider = Object.freeze({ kind: 'mysql-database-lease', allocate: allocateCaseLease, dispose: disposeCaseLease, recover: async record => {
    readManifest(record, 'test-db-case-lease-v2');
} });

export function registerDatabaseProviders() {
    if (registered) return;
    for (const provider of [mysqlProvider, postgresProvider, mysqlLeaseProvider]) registerProvider(provider);
    registered = true;
}

export async function acquireDatabase(scope, rootUrl, { fresh = false, reuse = false, label }, backend) {
    if (scope && typeof scope.resolveScope === 'function') scope = await scope.resolveScope();
    if (!scope || typeof scope.acquire !== 'function') throw new TypeError(`${backend} lease requires a managed resource scope`);
    if (fresh && reuse) throw new TypeError('A fresh database cannot be reused');
    registerDatabaseProviders();
    const provider = backend === 'mysql' ? mysqlProvider : postgresProvider;
    if (scope.transport === 'remote' || !reuse) return scope.acquire({ ...provider, label, options: { rootUrl, fresh, reuse } });
    if (backend !== 'mysql') throw new TypeError('Reusable database leases require the mysql backend');
    const poolKey = `${scope.sharedScopeId}:${sha(rootUrl)}`;
    const idle = idleMysql.get(poolKey);
    let physical = idle?.pop();
    let reused = Boolean(physical);
    if (physical) {
        const matches = await withPhysicalMysql(physical, async (connection, lease) => sha(await mysqlFingerprint(connection, lease.namespace)) === lease.fingerprint);
        if (!matches) {
            const errors = await scope.releaseShared(physical);
            if (errors.length) throw failureGroup(errors, `Cannot retire database schema drift in ${physical.namespace}`);
            physical = undefined;
            reused = false;
        }
    }
    physical ??= await scope.acquireShared({ ...mysqlProvider, label: `${label} physical namespace`, options: { rootUrl, fresh: false } });
    return scope.acquire({ ...mysqlLeaseProvider, label, dependsOn: [physical.resourceId], options: { physical, poolKey, reused } });
}
