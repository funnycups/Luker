import { createHash } from 'node:crypto';
import { initSchema as initMysqlSchema } from '../../src/storage/engines/mysql-schema.js';
import { failureGroup } from './resources/errors.js';
import { mysqlFingerprint, emptyMysql } from './database-fingerprint.js';
import { databaseUrl, withMysql, withPostgres, dropMysqlDatabase, dropPostgresSchema } from './database-service.js';

const idleMysql = new Map();
const sha = value => createHash('sha256').update(value).digest('hex');
const namespaceFor = resourceId => `luker_test_${resourceId.replaceAll('-', '')}`;

function forgetPhysical(resourceId) {
    for (const [key, idle] of idleMysql) {
        const retained = idle.filter(entry => entry.resourceId !== resourceId);
        if (retained.length) idleMysql.set(key, retained);
        else idleMysql.delete(key);
    }
}

async function allocatePhysical(handle, { rootUrl, fresh = false }, backend) {
    const namespace = namespaceFor(handle.resourceId);
    let fingerprint = null;
    if (backend === 'mysql') {
        await withMysql(rootUrl, async (connection) => {
            await connection.query(`CREATE DATABASE \`${namespace}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        });
        if (!fresh) {
            await withMysql(databaseUrl(rootUrl, 'mysql', namespace), async (connection) => {
                await initMysqlSchema(connection);
                fingerprint = sha(await mysqlFingerprint(connection, namespace));
            });
        }
    } else {
        await withPostgres(rootUrl, async (client) => {
            await client.query(`CREATE SCHEMA "${namespace}"`);
        });
    }

    handle.setLocator({ backend, namespace, rootUrl });
    return Object.freeze({
        backend,
        name: namespace,
        namespace,
        ...(backend === 'postgres' ? { schemaName: namespace } : {}),
        url: databaseUrl(rootUrl, backend, namespace),
        runId: handle.runId,
        scopeId: handle.scopeId,
        resourceId: handle.resourceId,
        fresh,
        reused: false,
        fingerprint,
    });
}

async function disposePhysical(record) {
    const locator = record.locator;
    if (locator) {
        if (locator.backend === 'mysql') await dropMysqlDatabase(locator.rootUrl, locator.namespace);
        else await dropPostgresSchema(locator.rootUrl, locator.namespace);
    }
    forgetPhysical(record.resourceId);
}

const mysqlProvider = Object.freeze({
    kind: 'mysql-database',
    allocate: (handle, options) => allocatePhysical(handle, options, 'mysql'),
    dispose: disposePhysical,
});

const postgresProvider = Object.freeze({
    kind: 'postgres-schema',
    allocate: (handle, options) => allocatePhysical(handle, options, 'postgres'),
    dispose: disposePhysical,
});

export function registerDatabaseProviders() {
    // Providers are passed directly to scope.acquire; kept as a no-op export for compatibility.
}

export async function acquireDatabase(scope, rootUrl, { fresh = false, reuse = false, label }, backend) {
    if (scope && typeof scope.resolveScope === 'function') scope = await scope.resolveScope();
    if (!scope || typeof scope.acquire !== 'function') {
        throw new TypeError(`${backend} lease requires a managed resource scope`);
    }
    if (fresh && reuse) throw new TypeError('A fresh database cannot be reused');

    const provider = backend === 'mysql' ? mysqlProvider : postgresProvider;
    if (!reuse) {
        return scope.acquire({ ...provider, label, options: { rootUrl, fresh, reuse } });
    }
    if (backend !== 'mysql') throw new TypeError('Reusable database leases require the mysql backend');

    const poolKey = `${scope.sharedScopeId}:${sha(rootUrl)}`;
    const idle = idleMysql.get(poolKey);
    let physical = idle?.pop();
    let reused = Boolean(physical);

    if (physical) {
        const matches = await withMysql(physical.url, async (connection) => (
            sha(await mysqlFingerprint(connection, physical.namespace)) === physical.fingerprint
        ));
        if (!matches) {
            const errors = await scope.releaseShared(physical);
            if (errors.length) {
                throw failureGroup(errors, `Cannot retire database schema drift in ${physical.namespace}`);
            }
            physical = undefined;
            reused = false;
        }
    }

    physical ??= await scope.acquireShared({
        ...mysqlProvider,
        label: `${label} physical namespace`,
        options: { rootUrl, fresh: false },
    });

    return scope.acquire({
        kind: 'mysql-database-lease',
        label,
        allocate: async (handle) => Object.freeze({
            ...physical,
            resourceId: handle.resourceId,
            fresh: false,
            reused,
        }),
        dispose: async () => {
            await withMysql(physical.url, async (connection) => {
                if (sha(await mysqlFingerprint(connection, physical.namespace)) === physical.fingerprint) {
                    await emptyMysql(connection, physical.namespace);
                }
            });
            const list = idleMysql.get(poolKey) ?? [];
            list.push(physical);
            idleMysql.set(poolKey, list);
        },
    });
}
