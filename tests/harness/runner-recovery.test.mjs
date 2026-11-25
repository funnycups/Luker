import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recoverRuns } from './resources/recovery.js';
import { registerDatabaseProviders } from './database.js';
import { MYSQL_ROOT_URL, PG_ROOT_URL, withMysql, withPostgres } from './database-service.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const harness = new URL('./', import.meta.url);
const profile = 'runner-recovery-contract';
const filename = name => fileURLToPath(new URL(name, harness));
const literal = value => JSON.stringify(value);

function command(context, cwd, args, ipc = false, extraEnvironment = {}) {
    const environment = { ...process.env, ...extraEnvironment };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    context.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
        await closed;
    });
    return { child, closed, output: () => output };
}

async function namespaceExists(lease) {
    if (lease.backend === 'mysql') return withMysql(MYSQL_ROOT_URL, async connection => {
        const [rows] = await connection.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [lease.namespace]);
        return rows.length > 0;
    });
    return withPostgres(PG_ROOT_URL, async client => (await client.query('SELECT oid FROM pg_namespace WHERE nspname = $1', [lease.namespace])).rowCount > 0);
}

for (const runner of ['node', 'jest', 'playwright']) test(`the actual ${runner} command recovers SQL owned by an interrupted execution`, async context => {
    const parent = path.join(repository, 'test-results/runner-recovery-self-tests');
    fs.mkdirSync(parent, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(parent, 'case-'));
    const identity = fs.lstatSync(projectRoot);
    let owner, consumer;
    context.after(async () => {
        for (const execution of [consumer, owner]) {
            if (!execution) continue;
            if (execution.child.exitCode === null && execution.child.signalCode === null) execution.child.kill('SIGINT');
            await execution.closed;
        }
        registerDatabaseProviders();
        await recoverRuns({ projectRoot, profiles: [profile] });
        const actual = fs.lstatSync(projectRoot);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        fs.rmSync(projectRoot, { recursive: true });
    });

    owner = command(context, projectRoot, ['--input-type=module', '--eval', `
        import fs from 'node:fs';
        import { createRun } from ${literal(filename('resources/run.js'))};
        import { acquireMysqlDatabase, acquirePostgresDatabase } from ${literal(filename('database.js'))};
        const run = await createRun({ projectRoot: ${literal(projectRoot)}, profile: ${literal(profile)}, command: [process.execPath, ...process.argv.slice(1)], source: 'interrupted SQL owner' });
        const scope = await run.scope({ kind: 'case', label: 'interrupted SQL allocation' });
        await scope.onFinalize({ label: 'ended owner callback', stage: 'drain', callback: () => fs.writeFileSync(${literal(path.join(projectRoot, 'unexpected-old-callback'))}, 'old callback executed') });
        const leases = [await acquireMysqlDatabase(scope, undefined, { fresh: true }), await acquirePostgresDatabase(scope)];
        process.send({ registryPath: run.registryPath, runId: run.runId, leases: leases.map(({ backend, namespace, manifestPath }) => ({ backend, namespace, manifestPath })) });
        await new Promise(resolve => process.once('message', resolve));
    `], true);
    const receipt = await new Promise((resolve, reject) => {
        owner.child.once('message', resolve);
        owner.closed.then(exit => reject(new Error(`SQL owner exited before admission: ${literal(exit)} ${owner.output()}`)), reject);
    });
    for (const lease of receipt.leases) assert.equal(await namespaceExists(lease), true);
    owner.child.kill('SIGKILL');
    assert.deepEqual(await owner.closed, { code: null, signal: 'SIGKILL' });

    const observedPath = path.join(projectRoot, 'body-observation.json');
    const body = `
        const prior = JSON.parse(fs.readFileSync(${literal(receipt.registryPath)}, 'utf8'));
        fs.writeFileSync(${literal(observedPath)}, JSON.stringify({ status: prior.status, recovery: prior.recovery?.state, resources: prior.resources.map(resource => resource.state) }));
        assert.equal(prior.recovery?.state, 'recovered');
        assert.equal(prior.status, 'cancelled');
        assert.ok(prior.resources.every(resource => resource.state === 'disposed'));
        const owned = await scope.directory('ordinary selected case');
        assert.equal(fs.statSync(owned.path).isDirectory(), true);
    `;
    let args;
    if (runner === 'node') {
        const source = path.join(projectRoot, 'ordinary.test.mjs');
        fs.writeFileSync(source, `import fs from 'node:fs'; import assert from 'node:assert/strict';
            import { test } from ${literal(filename('node.js'))};
            test('ordinary selected case', { projectRoot: ${literal(projectRoot)}, profile: ${literal(profile)}, command: [process.execPath, ...process.argv.slice(1)], source: 'next native command' }, async (context, scope) => { ${body} });
        `);
        args = ['--test', source];
    } else if (runner === 'jest') {
        const config = path.join(projectRoot, 'jest.config.json');
        fs.writeFileSync(config, JSON.stringify({
            rootDir: projectRoot, displayName: profile, transform: {},
            testEnvironment: filename('jest-environment.js'), testEnvironmentOptions: { resourceProjectRoot: projectRoot },
            setupFilesAfterEnv: [filename('jest-run.js')], testMatch: ['**/ordinary.test.mjs'],
            globalSetup: path.join(repository, 'tests/util/global-setup.js'),
        }));
        fs.writeFileSync(path.join(projectRoot, 'ordinary.test.mjs'), `import fs from 'node:fs'; import assert from 'node:assert/strict';
            import { testWithResources } from ${literal(filename('jest.js'))};
            testWithResources('ordinary selected case', async scope => { ${body} });
        `);
        args = ['--experimental-vm-modules', path.join(repository, 'tests/node_modules/jest/bin/jest.js'), '--config', config, '--runInBand'];
    } else {
        const config = path.join(projectRoot, 'playwright.config.mjs');
        const managedConfigLiteral = literal({
            testDir: projectRoot,
            testMatch: 'ordinary.spec.mjs',
            outputDir: path.join(projectRoot, 'native-output'),
            preserveOutput: 'always',
            workers: 1,
            projects: [{ name: profile }],
            metadata: { resourceProjectRoot: projectRoot },
            globalSetup: filename('playwright-setup.js'),
            globalTeardown: filename('playwright-teardown.js'),
            reporter: [[filename('playwright-reporter.js')], ['line']],
        });
        fs.writeFileSync(config, `import { defineManagedConfig } from ${literal(filename('playwright-config.js'))};
export default defineManagedConfig(${managedConfigLiteral}, import.meta.filename);
`);
        fs.writeFileSync(path.join(projectRoot, 'ordinary.spec.mjs'), `import fs from 'node:fs'; import assert from 'node:assert/strict';
            import { test } from ${literal(filename('playwright.js'))};
            test('ordinary selected case', async ({ resources: scope }) => { ${body} });
        `);
        args = [path.join(repository, 'tests/node_modules/playwright/cli.js'), 'test', '--config', config];
    }
    consumer = command(context, projectRoot, args, false, { LUKER_TEST_PROFILE: profile });
    const exit = await consumer.closed;
    context.diagnostic(JSON.stringify({ runner, exit, output: consumer.output(), registryPath: receipt.registryPath }));
    const observed = JSON.parse(fs.readFileSync(observedPath, 'utf8'));
    assert.equal(observed.recovery, 'recovered', consumer.output());
    assert.deepEqual(exit, { code: 0, signal: null }, consumer.output());
    const recovered = JSON.parse(fs.readFileSync(receipt.registryPath, 'utf8'));
    assert.equal(recovered.status, 'cancelled');
    assert.ok(recovered.resources.every(resource => resource.state === 'disposed'));
    const producers = recovered.scopes.flatMap(scope => scope.finalizers ?? []);
    assert.equal(producers.length, 1);
    assert.equal(producers[0].state, 'interrupted');
    const interruption = recovered.diagnosticIndex.artifacts.find(artifact => artifact.name === `interrupted-${producers[0].id}.json`);
    assert.equal(interruption.readStatus, 'complete');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(recovered.diagnosticIndex.storage.bundle.path, 'objects', interruption.sha256), 'utf8')), {
        format: 'interrupted-finalizer-v1', runId: receipt.runId, scopeId: interruption.scopeId, finalizerId: producers[0].id,
        label: 'ended owner callback', stage: 'drain', previousState: 'registered', executionId: recovered.owner.executionId,
    });
    assert.equal(fs.existsSync(path.join(projectRoot, 'unexpected-old-callback')), false);
    for (const lease of receipt.leases) {
        assert.equal(await namespaceExists(lease), false);
        assert.equal(fs.existsSync(lease.manifestPath), false);
    }
});
