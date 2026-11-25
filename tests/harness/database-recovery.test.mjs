import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { createRun } from './resources/run.js';
import { recoverRuns } from './resources/recovery.js';
import { failureEvents } from './resources/errors.js';
import { acquireMysqlDatabase, acquirePostgresDatabase, MYSQL_ROOT_URL, PG_ROOT_URL, registerDatabaseProviders } from './database.js';
import { OWNERSHIP_ROUTINE, withMysql } from './database-service.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const profile = 'database-recovery-contract';
const rejectsWith = pattern => error => failureEvents(error).some(event => pattern.test(event.message));

async function fixture(context) {
    const parent = path.join(repository, 'test-results/database-recovery-self-tests');
    fs.mkdirSync(parent, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(parent, 'case-'));
    const identity = fs.lstatSync(projectRoot);
    const run = await createRun({ projectRoot, profile, command: [process.execPath, '--test', 'harness/database-recovery.test.mjs'], source: context.name });
    const beforeFinish = [], afterRecovery = [], leases = [];
    const providerOptions = {};
    context.after(async () => {
        const failures = [];
        try {
            for (const callback of beforeFinish) await callback();
            await run.finish({ status: 'passed' });
            if (run.registry.resources.some(record => !['disposed', 'released'].includes(record.state))) await recoverRuns({ projectRoot, profiles: [profile], providerOptions });
            for (const lease of leases) assert.equal(await exists(lease), false);
        } catch (error) { failures.push(error); }
        // These are explicit test-created fixtures, never resources discovered
        // by a prefix. Preserve a failing assertion while removing its fixture.
        for (const lease of leases) {
            try {
                if (lease.backend === 'mysql') {
                    const root = await mysql.createConnection(MYSQL_ROOT_URL);
                    try { await root.query(`DROP DATABASE IF EXISTS \`${lease.namespace}\``); }
                    finally { await root.end(); }
                } else {
                    const client = new pg.Client({ connectionString: PG_ROOT_URL });
                    await client.connect();
                    try { await client.query(`DROP SCHEMA IF EXISTS "${lease.namespace}" CASCADE`); }
                    finally { await client.end(); }
                }
            } catch (error) { failures.push(error); }
        }
        for (const callback of afterRecovery) {
            try { await callback(); }
            catch (error) { failures.push(error); }
        }
        const actual = fs.lstatSync(projectRoot);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        fs.rmSync(projectRoot, { recursive: true });
        if (failures.length) throw new AggregateError(failures, 'Database fixture cleanup failed');
    });
    const scope = await run.scope({ kind: 'case', label: context.name });
    return { run, scope, beforeFinish, afterRecovery, providerOptions, ownLease: lease => { leases.push(lease); return lease; } };
}

async function exists(lease) {
    if (lease.backend === 'mysql') {
        const connection = await mysql.createConnection(MYSQL_ROOT_URL);
        try {
            const [rows] = await connection.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [lease.namespace]);
            return rows.length !== 0;
        } finally { await connection.end(); }
    }
    const client = new pg.Client({ connectionString: PG_ROOT_URL });
    await client.connect();
    try { return (await client.query('SELECT oid FROM pg_namespace WHERE nspname = $1', [lease.namespace])).rowCount !== 0; }
    finally { await client.end(); }
}

async function lostCreateAcknowledgement(input) {
    const upstreamUrl = new URL(MYSQL_ROOT_URL);
    const sockets = new Set(), errors = [];
    let resolveFault, rejectFault, faulted = false;
    const fault = new Promise((resolve, reject) => { resolveFault = resolve; rejectFault = reject; });
    const packets = consume => {
        let pending = Buffer.alloc(0);
        return chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 4) {
                const length = 4 + pending.readUIntLE(0, 3);
                if (pending.length < length) return;
                const packet = pending.subarray(0, length);
                pending = pending.subarray(length);
                consume(packet);
            }
        };
    };
    const server = net.createServer(client => {
        const upstream = net.connect({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 3306) });
        sockets.add(client); sockets.add(upstream);
        let creating = null;
        let queryAttributes;
        client.on('data', packets(packet => {
            if (queryAttributes === undefined) queryAttributes = Boolean(packet.readUInt32LE(4) & 0x08000000);
            if (!faulted && packet[4] === 3) creating = packet.subarray(queryAttributes ? 7 : 5).toString('utf8').match(/^CREATE DATABASE `(luker_test_[a-f0-9]{32})`/)?.[1] ?? null;
            upstream.write(packet);
        }));
        upstream.on('data', packets(packet => {
            if (creating && !faulted) {
                faulted = true;
                resolveFault({ namespace: creating, acknowledged: packet[4] === 0 });
                if (packet[4] === 0) { client.resetAndDestroy(); upstream.destroy(); return; }
            }
            client.write(packet);
        }));
        client.on('error', error => { errors.push(error); rejectFault(error); upstream.destroy(); });
        upstream.on('error', error => { errors.push(error); rejectFault(error); client.destroy(); });
        client.on('close', () => { sockets.delete(client); upstream.destroy(); });
        upstream.on('close', () => { sockets.delete(upstream); client.end(); });
    });
    input.afterRecovery.push(async () => {
        const closed = server.listening ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
        await Promise.all([...sockets].map(socket => {
            const ended = new Promise(resolve => socket.once('close', resolve));
            socket.destroy();
            return ended;
        }));
        await closed;
        if (errors.length) throw new AggregateError(errors, 'Database acknowledgement fixture failed');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const proxyUrl = new URL(upstreamUrl);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(server.address().port);
    return { url: proxyUrl.toString(), fault };
}

test('a lost CREATE acknowledgement retains exact metadata until remote ownership can be proved', async context => {
    const input = await fixture(context);
    const proxy = await lostCreateAcknowledgement(input);
    input.providerOptions.databaseRootUrls = { mysql: [proxy.url] };
    const result = acquireMysqlDatabase(input.scope, proxy.url, { fresh: true }).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
    const observed = await Promise.race([proxy.fault, result.then(outcome => { throw new Error('Database allocation settled before the actual CREATE acknowledgement', { cause: outcome.reason }); })]);
    const record = input.run.registry.resources.find(resource => resource.kind === 'mysql-database');
    const lease = input.ownLease({ backend: 'mysql', namespace: observed.namespace, manifestPath: path.join(record.locator.path, 'lease.json') });
    input.beforeFinish.push(async () => {
        const manifest = JSON.parse(fs.readFileSync(lease.manifestPath, 'utf8'));
        await withMysql(MYSQL_ROOT_URL, connection => connection.query(`CREATE PROCEDURE \`${lease.namespace}\`.\`${OWNERSHIP_ROUTINE}\`() COMMENT ? SELECT 1`, [manifest.receipt]));
    });
    assert.equal(observed.acknowledged, true);
    const outcome = await result;
    assert.equal(outcome.status, 'rejected');
    assert.ok(failureEvents(outcome.reason).some(error => /lost|ECONNRESET|closed/i.test(error.message)));
    assert.equal(await exists(lease), true);
    assert.equal(record.state, 'cleanup-failed');
    const manifest = JSON.parse(fs.readFileSync(lease.manifestPath, 'utf8'));
    assert.equal(manifest.state, 'creating');
    assert.equal(manifest.created, false);
    assert.equal(manifest.claimed, false);
    assert.equal(manifest.resourceId, record.resourceId);
    assert.equal(manifest.runId, input.run.runId);
    assert.match(manifest.serverIdentity.serverId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(JSON.parse(manifest.receipt), { format: 'test-db-owner-v2', runId: input.run.runId, resourceId: record.resourceId, nonce: manifest.nonce });
});

for (const backend of ['mysql', 'postgres']) test(`${backend} disposal refuses another service identity and retains its exact manifest`, async context => {
    const input = await fixture(context);
    const lease = input.ownLease(await (backend === 'mysql' ? acquireMysqlDatabase(input.scope, MYSQL_ROOT_URL) : acquirePostgresDatabase(input.scope, PG_ROOT_URL)));
    const original = fs.readFileSync(lease.manifestPath, 'utf8');
    input.beforeFinish.push(() => {
        if (fs.existsSync(lease.manifestPath)) fs.writeFileSync(lease.manifestPath, original);
    });
    const manifest = JSON.parse(original);
    manifest.serverIdentity = { ...manifest.serverIdentity, serverId: backend === 'mysql' ? randomUUID() : '1' };
    fs.writeFileSync(lease.manifestPath, JSON.stringify(manifest));
    await assert.rejects(input.scope.dispose(), rejectsWith(/identity changed/));
    assert.equal(await exists(lease), true);
    assert.equal(fs.readFileSync(lease.manifestPath, 'utf8'), JSON.stringify(manifest));
});

test('schema disposal refuses a replaced remote ownership receipt', async context => {
    const input = await fixture(context);
    const lease = input.ownLease(await acquirePostgresDatabase(input.scope, PG_ROOT_URL));
    const original = JSON.parse(fs.readFileSync(lease.manifestPath, 'utf8'));
    const client = new pg.Client({ connectionString: PG_ROOT_URL });
    await client.connect();
    try { await client.query(`COMMENT ON SCHEMA "${lease.namespace}" IS 'unregistered replacement owner'`); }
    finally { await client.end(); }
    input.beforeFinish.push(async () => {
        if (await exists(lease)) {
            const client = new pg.Client({ connectionString: PG_ROOT_URL });
            await client.connect();
            try { await client.query(`COMMENT ON SCHEMA "${lease.namespace}" IS ${client.escapeLiteral(original.receipt)}`); }
            finally { await client.end(); }
        }
    });
    await assert.rejects(input.scope.dispose(), rejectsWith(/ownership changed/));
    assert.equal(await exists(lease), true);
    assert.equal(fs.existsSync(lease.manifestPath), true);
});

test('a refused remote DROP retains the exact release manifest for later recovery', async context => {
    const input = await fixture(context);
    const username = `lukdrop_${process.pid.toString(36)}_${Date.now().toString(36)}`;
    const root = await mysql.createConnection(MYSQL_ROOT_URL);
    try {
        await root.query(`CREATE USER '${username}'@'%' IDENTIFIED BY 'release-permission-probe'`);
        await root.query(`GRANT ALL PRIVILEGES ON *.* TO '${username}'@'%'`);
    } finally { await root.end(); }
    input.beforeFinish.push(async () => {
        const root = await mysql.createConnection(MYSQL_ROOT_URL);
        try { await root.query(`GRANT DROP ON *.* TO '${username}'@'%'`); }
        finally { await root.end(); }
    });
    input.afterRecovery.push(async () => {
        const root = await mysql.createConnection(MYSQL_ROOT_URL);
        try { await root.query(`DROP USER '${username}'@'%'`); }
        finally { await root.end(); }
    });
    const url = new URL(MYSQL_ROOT_URL);
    url.username = username;
    url.password = 'release-permission-probe';
    const lease = input.ownLease(await acquireMysqlDatabase(input.scope, url.toString()));
    const original = fs.readFileSync(lease.manifestPath, 'utf8');
    const revoke = await mysql.createConnection(MYSQL_ROOT_URL);
    try { await revoke.query(`REVOKE DROP ON *.* FROM '${username}'@'%'`); }
    finally { await revoke.end(); }
    await assert.rejects(input.scope.dispose(), rejectsWith(/DROP|denied/i));
    assert.equal(await exists(lease), true);
    assert.equal(fs.existsSync(lease.manifestPath), true);
    assert.equal(fs.readFileSync(lease.manifestPath, 'utf8'), original);
});

test('a process killed mid-allocation after creating a namespace is cleanly recovered', async context => {
    const parent = path.join(repository, 'test-results/database-recovery-self-tests');
    fs.mkdirSync(parent, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(parent, 'case-'));
    const identity = fs.lstatSync(projectRoot);
    const upstreamUrl = new URL(MYSQL_ROOT_URL);
    const sockets = new Set();
    let createdNamespace = null;
    let holdMidAllocation = true;
    let resolvePaused;
    const paused = new Promise(resolve => { resolvePaused = resolve; });
    const packets = consume => {
        let pending = Buffer.alloc(0);
        return chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 4) {
                const length = 4 + pending.readUIntLE(0, 3);
                if (pending.length < length) return;
                const packet = pending.subarray(0, length);
                pending = pending.subarray(length);
                consume(packet);
            }
        };
    };
    const server = net.createServer(client => {
        const upstream = net.connect({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 3306) });
        sockets.add(client); sockets.add(upstream);
        let queryAttributes;
        client.on('data', packets(packet => {
            if (queryAttributes === undefined) queryAttributes = Boolean(packet.readUInt32LE(4) & 0x08000000);
            const sql = packet[4] === 3 ? packet.subarray(queryAttributes ? 7 : 5).toString('utf8') : '';
            const created = sql.match(/^CREATE PROCEDURE `(luker_test_[a-f0-9]{32})`\./)?.[1];
            if (created) createdNamespace = created;
            if (holdMidAllocation && createdNamespace && /^SELECT SCHEMA_NAME FROM information_schema\.SCHEMATA/.test(sql)) {
                holdMidAllocation = false;
                resolvePaused(createdNamespace);
                return;
            }
            upstream.write(packet);
        }));
        upstream.on('data', chunk => client.write(chunk));
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.on('close', () => { sockets.delete(client); upstream.destroy(); });
        upstream.on('close', () => { sockets.delete(upstream); client.end(); });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const proxyUrl = new URL(upstreamUrl);
    proxyUrl.hostname = '127.0.0.1';
    proxyUrl.port = String(server.address().port);

    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { createRun } from ${JSON.stringify(new URL('./resources/run.js', import.meta.url).href)};
        import { acquireMysqlDatabase } from ${JSON.stringify(new URL('./database.js', import.meta.url).href)};
        const run = await createRun({ projectRoot: ${JSON.stringify(projectRoot)}, profile: ${JSON.stringify(profile)}, command: ['node'], source: 'killed mid-allocation worker' });
        const scope = await run.scope({ kind: 'case', label: 'killed mid-allocation' });
        await acquireMysqlDatabase(scope, ${JSON.stringify(proxyUrl.toString())});
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    context.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (createdNamespace) {
            const root = await mysql.createConnection(MYSQL_ROOT_URL);
            try { await root.query(`DROP DATABASE IF EXISTS \`${createdNamespace}\``); }
            finally { await root.end(); }
        }
        const actual = fs.lstatSync(projectRoot);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        fs.rmSync(projectRoot, { recursive: true });
    });

    const namespace = await paused;
    child.kill('SIGTERM');
    await closed;
    assert.equal(await exists({ backend: 'mysql', namespace }), true);
    registerDatabaseProviders();
    const [runId] = fs.readdirSync(path.join(projectRoot, 'test-results/harness/runs'));
    const report = await recoverRuns({ projectRoot, profiles: [profile], providerOptions: { databaseRootUrls: { mysql: [proxyUrl.toString()] } } });
    assert.deepEqual(report.recovered, [runId]);
    assert.equal(await exists({ backend: 'mysql', namespace }), false);
});
