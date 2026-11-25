import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { createRun } from './resources/run.js';
import { recoverRuns } from './resources/recovery.js';
import {
    acquireMysqlDatabase, acquirePostgresDatabase, registerDatabaseProviders,
    fingerprintDatabase, preflightDatabases, MYSQL_ROOT_URL, PG_ROOT_URL,
} from './database.js';
import { initSchema as initMysqlSchema } from '../../src/storage/engines/mysql-schema.js';
import { initSchema as initPgSchema } from '../../src/storage/engines/postgres-schema.js';
import { makeTempMysqlEngineHarness } from '../storage/harness/mysql-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../..');
const command = [process.execPath, '--test', 'harness/database-lifecycle.test.mjs'];

function scopedRun() {
    return createRun({ projectRoot: repository, profile: 'storage-sql', command, source: 'tests/harness/database-lifecycle.test.mjs' });
}

async function withRun(body, descriptor = 'database lifecycle', expectedErrors = []) {
    const run = await scopedRun();
    const scope = await run.scope({ kind: 'case', label: descriptor });
    let result;
    const failures = [];
    try { result = await body(scope, run); }
    catch (error) { failures.push(error); run.recordError(error); }
    try { await scope.dispose(); }
    catch (error) { failures.push(error); run.recordError(error); }
    let summary;
    try { summary = await run.finish({ status: failures.length ? 'failed' : 'passed' }); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${descriptor}: case and cleanup failed`);
    const unexpected = summary.errors.filter(error => !expectedErrors.includes(error));
    if (unexpected.length) throw new AggregateError(unexpected, `${descriptor}: managed run ${run.runId} ${summary.status}`);
    assert.equal(summary.status, expectedErrors.length ? 'failed' : 'passed');
    assert.deepEqual(summary.errors, expectedErrors);
    return result;
}

async function mysqlNamespaces() {
    const connection = await mysql.createConnection(MYSQL_ROOT_URL);
    try {
        const [rows] = await connection.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE LEFT(SCHEMA_NAME, ?) = ?', ['luker_test_'.length, 'luker_test_']);
        return rows.map(row => row.name).sort();
    } finally {
        await connection.end();
    }
}

async function mysqlDatabaseExists(namespace) {
    const connection = await mysql.createConnection(MYSQL_ROOT_URL);
    try {
        const [rows] = await connection.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [namespace]);
        return rows.length === 1;
    } finally {
        await connection.end();
    }
}

async function createForeignDatabase(name) {
    const connection = await mysql.createConnection(MYSQL_ROOT_URL);
    try { await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`); }
    finally { await connection.end(); }
}

async function dropForeignDatabase(name) {
    const connection = await mysql.createConnection(MYSQL_ROOT_URL);
    try { await connection.query(`DROP DATABASE IF EXISTS \`${name}\``); }
    finally { await connection.end(); }
}

async function postgresSchemaExists(namespace) {
    const client = new pg.Client({ connectionString: PG_ROOT_URL });
    await client.connect();
    try {
        const result = await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1', [namespace]);
        return result.rowCount === 1;
    } finally {
        await client.end();
    }
}

async function createForeignSchema(name) {
    const client = new pg.Client({ connectionString: PG_ROOT_URL });
    await client.connect();
    try { await client.query(`CREATE SCHEMA "${name}"`); }
    finally { await client.end(); }
}

async function dropForeignSchema(name) {
    const client = new pg.Client({ connectionString: PG_ROOT_URL });
    await client.connect();
    try { await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); }
    finally { await client.end(); }
}

test('a native database fixture rejects a failed managed summary', async context => {
    const failure = new Error('actual native database fixture failure');
    await assert.rejects(withRun(async (scope, run) => {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL);
        context.after(async () => assert.equal(await mysqlDatabaseExists(lease.namespace), false));
        run.recordError(failure);
    }), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [failure]);
        return true;
    });
});

test('a native database fixture preserves an undefined rejection', async () => {
    let rejected = false;
    await withRun(async () => { throw undefined; }).then(() => {
        assert.fail('The native fixture accepted an undefined rejection');
    }, error => {
        rejected = true;
        assert.equal(error, undefined);
    });
    assert.equal(rejected, true);
});

test('MySQL lease authenticates before creating a registered namespace', async () => {
    await withRun(async scope => {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL);
        assert.equal(lease.backend, 'mysql');
        assert.equal(lease.namespace, `luker_test_${lease.resourceId.replaceAll('-', '')}`);
        const manifest = JSON.parse(fs.readFileSync(lease.manifestPath, 'utf8'));
        assert.equal(manifest.state, 'ready');
        assert.equal(manifest.backend, 'mysql');
        assert.equal(manifest.created, true);
        assert.ok(manifest.serverVersion.length > 0);
        assert.equal(await mysqlDatabaseExists(lease.namespace), true);
        const connection = await mysql.createConnection(lease.url);
        try {
            const [rows] = await connection.query('SELECT DATABASE() AS name');
            assert.equal(rows[0].name, lease.namespace);
            const [tables] = await connection.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = \'_storage_meta\'', [lease.namespace]);
            assert.equal(tables.length, 1);
        } finally {
            await connection.end();
        }
    });
});

test('PostgreSQL lease authenticates and creates an isolated schema', async () => {
    await withRun(async scope => {
        const lease = await acquirePostgresDatabase(scope, PG_ROOT_URL);
        assert.equal(lease.backend, 'postgres');
        assert.equal(lease.schemaName, `luker_test_${lease.resourceId.replaceAll('-', '')}`);
        assert.equal(await postgresSchemaExists(lease.schemaName), true);
        const client = new pg.Client({ connectionString: lease.url });
        await client.connect();
        try {
            const result = await client.query('SELECT current_schema() AS name');
            assert.equal(result.rows[0].name, lease.schemaName);
        } finally {
            await client.end();
        }
    });
});

test('parallel leases receive distinct namespaces on the same server', async () => {
    const run = await scopedRun();
    const left = await run.scope({ kind: 'case', label: 'left' });
    const right = await run.scope({ kind: 'case', label: 'right' });
    let failure;
    try {
        const [a, b] = await Promise.all([
            acquireMysqlDatabase(left, MYSQL_ROOT_URL),
            acquireMysqlDatabase(right, MYSQL_ROOT_URL),
        ]);
        assert.notEqual(a.namespace, b.namespace);
        assert.equal(await mysqlDatabaseExists(a.namespace), true);
        assert.equal(await mysqlDatabaseExists(b.namespace), true);
        await left.dispose();
        assert.equal(await mysqlDatabaseExists(a.namespace), false);
        assert.equal(await mysqlDatabaseExists(b.namespace), true);
        await right.dispose();
        assert.equal(await mysqlDatabaseExists(b.namespace), false);
    } catch (error) { failure = error; }
    try { await left.dispose(); } catch (error) { failure ??= error; }
    try { await right.dispose(); } catch (error) { failure ??= error; }
    try { await run.finish({ status: failure ? 'failed' : 'passed', ...(failure ? { error: failure } : {}) }); }
    catch (error) { failure ??= error; }
    if (failure) throw failure;
});

test('authentication failure refuses before namespace creation', async () => {
    const expectedErrors = [];
    await withRun(async scope => {
        const before = await mysqlNamespaces();
        await assert.rejects(
            acquireMysqlDatabase(scope, 'mysql://root:wrong-password@127.0.0.1:53306'),
            error => {
                assert.match(error.message, /Access denied|authentication|ER_ACCESS_DENIED/i);
                expectedErrors.push(error);
                return true;
            },
        );
        assert.deepEqual(await mysqlNamespaces(), before);
    }, 'authentication refusal', expectedErrors);
});

test('mid-acquisition failure rolls back without leaving a namespace', async () => {
    const user = `luklim_${process.pid.toString(36)}_${Date.now().toString(36)}`;
    const root = await mysql.createConnection(MYSQL_ROOT_URL);
    try {
        await root.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'limited-password'`);
        try {
            const expectedErrors = [];
            await withRun(async scope => {
                const before = await mysqlNamespaces();
                await assert.rejects(
                    acquireMysqlDatabase(scope, `mysql://${user}:limited-password@127.0.0.1:53306`),
                    error => {
                        assert.match(error.message, /CREATE|denied|ER_DBACCESS_DENIED_ERROR|ER_ACCESS_DENIED_ERROR/i);
                        expectedErrors.push(error);
                        return true;
                    },
                );
                assert.deepEqual(await mysqlNamespaces(), before);
            }, 'creation refusal', expectedErrors);
        } finally {
            await root.query(`DROP USER IF EXISTS '${user}'@'%'`);
        }
    } finally {
        await root.end();
    }
});

test('a released pooled namespace is emptied, reused and removed by normal run finish', async context => {
    const run = await scopedRun();
    context.after(() => run.finish({ status: 'passed' }));
    const firstScope = await run.scope({ kind: 'case', label: 'first lease' });
    const first = await acquireMysqlDatabase(firstScope, MYSQL_ROOT_URL, { reuse: true });
    const firstFingerprint = await fingerprintDatabase(first);
    const connection = await mysql.createConnection(first.url);
    try {
        await connection.query('INSERT INTO settings (handle, doc, updated_at) VALUES (?, ?, ?)', ['u', '{"probe":1}', 1]);
    } finally {
        await connection.end();
    }
    await firstScope.dispose();
    assert.equal(await mysqlDatabaseExists(first.namespace), true);

    const secondScope = await run.scope({ kind: 'case', label: 'second lease' });
    const second = await acquireMysqlDatabase(secondScope, MYSQL_ROOT_URL, { reuse: true });
    assert.equal(second.namespace, first.namespace);
    assert.equal(second.reused, true);
    assert.equal(await fingerprintDatabase(second), firstFingerprint);
    const reused = await mysql.createConnection(second.url);
    try {
        const [rows] = await reused.query('SELECT COUNT(*) AS count FROM settings');
        assert.equal(rows[0].count, 0);
    } finally {
        await reused.end();
    }
    await secondScope.dispose();
    assert.equal((await run.finish({ status: 'passed' })).status, 'passed');

    assert.equal(await mysqlDatabaseExists(first.namespace), false);
});

test('a fresh lease has no tables and is dropped without pooling', async () => {
    await withRun(async scope => {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL, { fresh: true });
        const connection = await mysql.createConnection(lease.url);
        try {
            const [tables] = await connection.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [lease.namespace]);
            assert.deepEqual(tables, []);
        } finally {
            await connection.end();
        }
        await scope.dispose();
        assert.equal(await mysqlDatabaseExists(lease.namespace), false);
    });
});

test('closing the managed engine closes its connection pool', async () => {
    await withRun(async scope => {
        const harness = await makeTempMysqlEngineHarness({ scope });
        await harness.engine.ping(harness.handle);
        await scope.dispose();
        await assert.rejects(harness.engine.ping(harness.handle), /closed|ended|Cannot use a pool/i);
    });
});

test('MySQL schema fingerprint is stable across migration reuse and changes on drift', async () => {
    await withRun(async scope => {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL);
        const pool = mysql.createPool({ uri: lease.url, connectionLimit: 1 });
        try {
            await initMysqlSchema(pool);
            const first = await fingerprintDatabase(lease);
            await initMysqlSchema(pool);
            const second = await fingerprintDatabase(lease);
            assert.equal(second, first);
            await pool.query('ALTER TABLE _storage_meta ADD COLUMN drift_probe VARCHAR(8) NULL');
            const drifted = await fingerprintDatabase(lease);
            assert.notEqual(drifted, first);
        } finally {
            await pool.end();
        }
    });
});

test('MySQL schema fingerprint changes when a foreign key rule or target column changes', async () => {
    await withRun(async scope => {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL);
        const pool = mysql.createPool({ uri: lease.url, connectionLimit: 1 });
        try {
            const first = await fingerprintDatabase(lease);
            await pool.query('CREATE TABLE drift_parent (id INTEGER PRIMARY KEY, alt_id INTEGER UNIQUE)');
            await pool.query('CREATE TABLE drift_child (id INTEGER PRIMARY KEY, parent_id INTEGER, CONSTRAINT drift_child_fk FOREIGN KEY (parent_id) REFERENCES drift_parent(id) ON DELETE RESTRICT)');
            const withRestrict = await fingerprintDatabase(lease);
            assert.notEqual(withRestrict, first);
            await pool.query('ALTER TABLE drift_child DROP FOREIGN KEY drift_child_fk');
            await pool.query('ALTER TABLE drift_child ADD CONSTRAINT drift_child_fk FOREIGN KEY (parent_id) REFERENCES drift_parent(id) ON DELETE CASCADE');
            const withCascade = await fingerprintDatabase(lease);
            assert.notEqual(withCascade, withRestrict);
            await pool.query('ALTER TABLE drift_child DROP FOREIGN KEY drift_child_fk');
            await pool.query('ALTER TABLE drift_child ADD CONSTRAINT drift_child_fk FOREIGN KEY (parent_id) REFERENCES drift_parent(alt_id) ON DELETE CASCADE');
            const withAltColumn = await fingerprintDatabase(lease);
            assert.notEqual(withAltColumn, withCascade);
            await pool.query('ALTER TABLE drift_child DROP FOREIGN KEY drift_child_fk');
            const withoutForeignKey = await fingerprintDatabase(lease);
            assert.notEqual(withoutForeignKey, withAltColumn);
        } finally {
            await pool.end();
        }
    });
});

test('PostgreSQL schema fingerprint changes when a foreign key changes', async () => {
    await withRun(async scope => {
        const lease = await acquirePostgresDatabase(scope, PG_ROOT_URL);
        const pool = new pg.Pool({ connectionString: lease.url, max: 1 });
        try {
            await initPgSchema(pool);
            const first = await fingerprintDatabase(lease);
            await pool.query('CREATE TABLE drift_parent (id INTEGER PRIMARY KEY)');
            await pool.query('CREATE TABLE drift_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES drift_parent(id))');
            const withForeignKey = await fingerprintDatabase(lease);
            assert.notEqual(withForeignKey, first);
            await pool.query('ALTER TABLE drift_child DROP CONSTRAINT drift_child_parent_id_fkey');
            const withoutForeignKey = await fingerprintDatabase(lease);
            assert.notEqual(withoutForeignKey, withForeignKey);
        } finally {
            await pool.end();
        }
    });
});

test('ended run recovery preserves unregistered namespaces with the same prefix', async context => {
    const parent = path.join(repository, 'test-results/database-lifecycle-self-tests');
    fs.mkdirSync(parent, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(parent, 'case-'));
    const identity = fs.lstatSync(projectRoot);
    registerDatabaseProviders();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { createRun } from ${JSON.stringify(new URL('./resources/run.js', import.meta.url).href)};
        import { acquireMysqlDatabase, acquirePostgresDatabase, MYSQL_ROOT_URL, PG_ROOT_URL } from ${JSON.stringify(new URL('./database.js', import.meta.url).href)};
        const run = await createRun({ projectRoot: ${JSON.stringify(projectRoot)}, profile: 'storage-sql', command: ['node'], source: 'interrupted lease worker' });
        const scope = await run.scope({ kind: 'case', label: 'interrupted leases' });
        const mysqlLease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL);
        const pgLease = await acquirePostgresDatabase(scope, PG_ROOT_URL);
        await new Promise(resolve => process.stdout.write(JSON.stringify({ runId: run.runId, namespace: mysqlLease.namespace, schema: pgLease.schemaName }), resolve));
        process.exit(0);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    context.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
        await closed;
        await recoverRuns({ projectRoot, profiles: ['storage-sql'] });
        const actual = fs.lstatSync(projectRoot);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        fs.rmSync(projectRoot, { recursive: true });
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const [exit, signal] = await closed;
    assert.equal(exit, 0, errors);
    assert.equal(signal, null);
    const { runId, namespace, schema } = JSON.parse(output);
    const activeMysql = `${namespace.slice(0, 32)}_foreign`;
    const activePostgres = `${schema.slice(0, 32)}_foreign`;
    assert.equal(await mysqlDatabaseExists(namespace), true);
    assert.equal(await postgresSchemaExists(schema), true);
    await createForeignDatabase(activeMysql);
    await createForeignSchema(activePostgres);
    try {
        const report = await recoverRuns({ projectRoot, profiles: ['storage-sql'] });
        assert.deepEqual(report.recovered, [runId]);
        assert.equal(await mysqlDatabaseExists(namespace), false);
        assert.equal(await postgresSchemaExists(schema), false);
        assert.equal(await mysqlDatabaseExists(activeMysql), true);
        assert.equal(await postgresSchemaExists(activePostgres), true);
    } finally {
        await dropForeignDatabase(activeMysql);
        await dropForeignSchema(activePostgres);
    }
    assert.deepEqual((await recoverRuns({ projectRoot, profiles: ['storage-sql'] })).recovered, []);
});

test('preflight reports the authenticated identity of both servers', async () => {
    const identities = await preflightDatabases({ mysqlRootUrl: MYSQL_ROOT_URL, postgresRootUrl: PG_ROOT_URL });
    assert.equal(identities.mysql.backend, 'mysql');
    assert.match(identities.mysql.version, /^\d+\.\d+/);
    assert.match(identities.mysql.serverId, /^[a-f0-9-]{36}$/);
    assert.equal(identities.postgres.backend, 'postgres');
    assert.match(identities.postgres.version, /PostgreSQL/);
    assert.equal(typeof identities.postgres.database, 'string');
    assert.match(identities.postgres.serverId, /^\d+$/);
});

test('database manifests do not persist connection credentials', async () => {
    await withRun(async scope => {
        const leases = await Promise.all([
            acquireMysqlDatabase(scope, MYSQL_ROOT_URL),
            acquirePostgresDatabase(scope, PG_ROOT_URL),
        ]);
        for (const lease of leases) {
            const bytes = fs.readFileSync(lease.manifestPath, 'utf8');
            const manifest = JSON.parse(bytes);
            assert.equal(Object.hasOwn(manifest, 'rootUrl'), false, `${lease.backend} persisted its root connection URL`);
            assert.equal(bytes.includes(lease.url), false);
        }
    });
});

test('preflight rejects a malformed explicit URL before connecting', async () => {
    await assert.rejects(
        preflightDatabases({ mysqlRootUrl: 'not a url', postgresRootUrl: PG_ROOT_URL }),
        /MySQL root URL is not a valid URL/,
    );
});

test('normal release removes its exact registered custody directory', async () => {
    await withRun(async scope => {
        const lease = await acquireMysqlDatabase(scope, MYSQL_ROOT_URL);
        const directory = path.dirname(lease.manifestPath);
        assert.equal(fs.existsSync(directory), true);
        await scope.dispose();
        assert.equal(fs.existsSync(directory), false);
        assert.equal(await mysqlDatabaseExists(lease.namespace), false);
    });
});
