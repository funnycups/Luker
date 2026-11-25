import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRun } from './resources/run.js';
import { nativeRuntime, nativeSource } from './fixtures/native-runtime.mjs';
import './fixtures/resource-process-boundaries.mjs';
import './fixtures/resource-terminal-boundaries.mjs';
import './fixtures/resource-outcome-boundaries.mjs';
import './fixtures/resource-acknowledgement-boundaries.mjs';
import './fixtures/resource-redaction-boundaries.mjs';
import './fixtures/resource-policy-boundaries.mjs';
import { property } from './fixtures/failure-graph.mjs';
import { serializeFailure } from './resources/errors.js';
import { observeNativeStartup } from './fixtures/process-native-control.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const childSource = fileURLToPath(new URL('./fixtures/resource-child.mjs', import.meta.url));
const scratch = path.join(repository, 'test-results/resource-recovery');
const sha = value => createHash('sha256').update(value).digest('hex');
const options = projectRoot => ({ projectRoot, profile: 'unit', source: 'actual-process-recovery', command: [process.execPath, '--test', 'harness/resource-recovery.test.mjs'] });

function errorNodes(value) {
    if (value?.type !== 'error') return [];
    return [value, ...errorNodes(value.cause), ...(value.errors ?? []).flatMap(errorNodes)];
}

async function api() {
    assert.ok(fs.existsSync(new URL('./resources/process-owner.js', import.meta.url)), 'launchOwnedProcess is not implemented');
    assert.ok(fs.existsSync(new URL('./resources/recovery.js', import.meta.url)), 'recoverRuns is not implemented');
    return { ...await import('./resources/process-owner.js'), ...await import('./resources/recovery.js'), ...await import('./resources/native-identity.js'), ...await import('./resources/authority.js') };
}

async function endedOwnerController(t, registryPath) {
    const { readProcessIdentity, sameProcessIdentity } = await api();
    const record = JSON.parse(fs.readFileSync(registryPath)).resources.find(record => record.kind === 'process');
    const identity = record.locator.controller;
    while (sameProcessIdentity(await readProcessIdentity(identity.native.pid), identity.native)) { /* Join the real terminal writer before taking preservation inventories. */ }
    const worker = await readProcessIdentity(record.locator.worker.pid);
    assert.equal(worker, null);
    t.diagnostic(JSON.stringify({ endedOwnerController: { identity, worker: record.locator.worker, controllerNative: await readProcessIdentity(identity.native.pid), workerNative: worker } }));
}

function inventory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).map(item => {
        const target = path.join(directory, item.name);
        const stat = fs.lstatSync(target);
        const record = { path: target, dev: stat.dev, ino: stat.ino };
        if (item.isDirectory()) record.children = inventory(target);
        else if (item.isSymbolicLink()) record.link = fs.readlinkSync(target);
        else { const bytes = fs.readFileSync(target); record.sha256 = sha(bytes); if (item.name === 'registry.json') record.registry = JSON.parse(bytes); }
        return record;
    });
}

function fixture(t) {
    fs.mkdirSync(scratch, { recursive: true });
    assert.equal(fs.realpathSync(scratch), scratch);
    const root = fs.mkdtempSync(path.join(scratch, 'case-'));
    const identity = fs.lstatSync(root);
    for (const item of ['project', 'borrowed', 'other-worktree']) fs.mkdirSync(path.join(root, item));
    fs.writeFileSync(path.join(root, 'borrowed/original'), 'borrowed original');
    fs.writeFileSync(path.join(root, 'other-worktree/original'), 'other worktree original');
    t.after(() => {
        assert.equal(fs.realpathSync(root), root);
        assert.equal(fs.lstatSync(root).ino, identity.ino);
        assert.equal(fs.lstatSync(root).dev, identity.dev);
        assert.equal(fs.readFileSync(path.join(root, 'borrowed/original'), 'utf8'), 'borrowed original');
        assert.equal(fs.readFileSync(path.join(root, 'other-worktree/original'), 'utf8'), 'other worktree original');
        t.diagnostic(JSON.stringify({ root, dev: identity.dev, ino: identity.ino, beforeOuterTeardown: inventory(root) }));
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    return { root, projectRoot: path.join(root, 'project'), borrowed: path.join(root, 'borrowed'), report: path.join(root, 'worker.json') };
}

function command(mode, input) {
    return [process.execPath, childSource, mode, JSON.stringify(input)];
}

async function listening(port) {
    const socket = net.connect({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.resume();
    socket.end();
    await once(socket, 'close');
}

async function closed(port) {
    await assert.rejects(listening(port), { code: 'ECONNREFUSED' });
}

function descriptors() {
    return execFileSync('lsof', ['-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
}

async function child(t, mode, input) {
    const argv = command(mode, input);
    const process_ = spawn(argv[0], argv.slice(1), { cwd: path.join(repository, 'tests'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '';
    let stderr = '';
    process_.stdout.setEncoding('utf8');
    process_.stderr.setEncoding('utf8');
    process_.stdout.on('data', value => { stdout += value; });
    process_.stderr.on('data', value => { stderr += value; });
    const exited = new Promise((resolve, reject) => {
        process_.once('error', reject);
        process_.once('close', (code, signal) => {
            const result = { code, signal };
            t.diagnostic(JSON.stringify({ processChild: { command: argv, cwd: path.join(repository, 'tests'), sourceSHA256: sha(fs.readFileSync(childSource)), stdout, stderr, ...result } }));
            resolve(result);
        });
    });
    t.after(async () => {
        if (mode === 'owner' && process_.connected) process_.send({ type: 'finish-owned-fixture' });
        await exited;
    });
    const message = await Promise.race([once(process_, 'message').then(([message]) => message), exited.then(result => { throw new Error(`Child exited before ownership receipt: ${JSON.stringify(result)}: ${stdout}${stderr}`); })]);
    assert.equal(message.runtime.version, process.version);
    assert.equal(message.runtime.execPath, process.execPath);
    t.diagnostic(JSON.stringify({ processChildRuntime: message.runtime, message }));
    return { process: process_, exited, message };
}

test('startup failure releases a child before a handle returns', async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'scenario', label: 'partial startup' });
    const data = await scope.directory('scenario');
    fs.writeFileSync(data.path + '/original', 'scenario survives stop');
    let original;
    await assert.rejects(launchOwnedProcess(scope, { label: 'partial listener', command: command('startup-failure', { report: input.report }), readyLine: 'resource-ready', dependsOn: [data.resourceId] }), error => {
        original = error;
        assert.match(error.message, /startup/);
        assert.match(error.startupLog, /original startup failure after listening/);
        return true;
    });
    const worker = JSON.parse(fs.readFileSync(input.report));
    await closed(worker.port);
    assert.equal(await readProcessIdentity(worker.pid), null);
    assert.equal(fs.readFileSync(data.path + '/original', 'utf8'), 'scenario survives stop');
    const before = JSON.parse(fs.readFileSync(run.registryPath));
    assert.equal(before.resources.find(item => item.kind === 'process').state, 'disposed');
    t.diagnostic(JSON.stringify({ beforeFinish: before, worker, startupFailure: { name: original.name, message: original.message, startupLog: original.startupLog } }));
    const summary = await run.finish({ status: 'failed', error: original });
    assert.equal(summary.errors[0], original);
    assert.equal(fs.existsSync(data.path), false);
});

test('native exit permits recovery before the owner is reaped', async t => {
    const { readProcessIdentity, recoverRuns } = await api();
    const input = fixture(t);
    const holder = spawn(process.execPath, [
        fileURLToPath(new URL('./fixtures/unreaped-owner.mjs', import.meta.url)), 'holder', input.projectRoot,
    ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const exited = once(holder, 'close');
    let stderr = '';
    holder.stderr.on('data', bytes => { stderr += bytes; });
    try {
        const [bytes] = await Promise.race([
            once(holder.stdout, 'data'),
            exited.then(([code, signal]) => { throw new Error(`Native owner holder exited before registration: ${code}/${signal}: ${stderr}`); }),
        ]);
        const receipt = JSON.parse(bytes);
        assert.deepEqual(await readProcessIdentity(receipt.owner.native.pid), receipt.owner.native);
        const before = fs.readFileSync(receipt.registryPath);
        const active = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        assert.deepEqual(active.active, [receipt.runId]);
        assert.deepEqual(fs.readFileSync(receipt.registryPath), before);

        holder.stdio[3].end('exit');
        let state;
        do {
            state = execFileSync('/bin/ps', ['-p', String(receipt.owner.native.pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
        } while (!state.startsWith('Z'));
        assert.equal(await readProcessIdentity(receipt.owner.native.pid), null);

        const report = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        assert.deepEqual(report.recovered, [receipt.runId]);
        const recovered = JSON.parse(fs.readFileSync(receipt.registryPath));
        assert.equal(recovered.recovery.state, 'recovered');
        assert.ok(recovered.resources.every(resource => resource.state === 'disposed'));
        assert.equal(fs.existsSync(receipt.data), false);
        t.diagnostic(JSON.stringify({ unreapedOwner: { receipt, state, report } }));
    } finally {
        holder.stdio[3].end();
        holder.stdin.end('reap');
        assert.deepEqual(await exited, [0, null], stderr);
    }
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`controller ${signal} publishes the drained terminal outcome`, async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const observed = observeNativeStartup();
    const release = path.join(input.root, 'release-worker');
    let lease;
    try {
        const scope = await run.scope({ kind: 'case', label: 'controller signal shutdown' });
        lease = await launchOwnedProcess(scope, {
            label: 'signal-controlled worker',
            command: command('ignore-term', { release, terminationObserved: input.root + '/termination' }),
            readyLine: 'resource-ready',
            stopSignal: 'SIGKILL',
        });
        const controller = observed.controller;
        const exited = once(controller, 'close');
        controller.kill(signal);
        assert.deepEqual(await exited, [0, null]);
        const record = run.registry.resources.find(record => record.resourceId === lease.resourceId);
        assert.equal(fs.existsSync(record.terminal.completion), true);
        assert.deepEqual(await lease.exited, { code: null, signal: 'SIGKILL' });
        await scope.dispose();
        assert.equal(record.state, 'disposed');
    } finally {
        observed.close();
        fs.writeFileSync(release, 'release actual worker');
        if (lease) while (await readProcessIdentity(lease.pid)) { /* Join the controlled fixture's actual exit. */ }
        await run.finish({ status: 'failed' });
    }
});

test('process stop preserves admitted scenario data across restart', async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const input = fixture(t);
    const beforeDescriptors = descriptors();
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'passed' }));
    const scope = await run.scope({ kind: 'scenario', label: 'restart' });
    await scope.borrowDirectory(input.borrowed);
    const data = await scope.directory('persistent scenario');
    fs.writeFileSync(data.path + '/scenario', 'restart state');
    const launch = () => launchOwnedProcess(scope, { label: 'restart listener', command: command('server', { report: input.report }), readyLine: 'resource-ready', dependsOn: [data.resourceId] });
    const first = await launch();
    const firstWorker = JSON.parse(fs.readFileSync(input.report));
    await listening(firstWorker.port);
    const stopping = first.stop();
    assert.equal(first.stop(), stopping);
    await stopping;
    await closed(firstWorker.port);
    assert.equal(await readProcessIdentity(first.pid), null);
    assert.equal(fs.readFileSync(data.path + '/scenario', 'utf8'), 'restart state');
    const second = await launch();
    const secondWorker = JSON.parse(fs.readFileSync(input.report));
    await listening(secondWorker.port);
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'passed');
    assert.equal(await readProcessIdentity(second.pid), null);
    await closed(secondWorker.port);
    assert.equal(fs.existsSync(data.path), false);
    const afterDescriptors = descriptors();
    assert.equal(afterDescriptors.includes(input.root), false);
    t.diagnostic(JSON.stringify({ beforeDescriptors, afterDescriptors, summary, firstWorker, secondWorker }));
});

test('explicit terminal signal stops a child that does not terminate on SIGTERM', async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'passed' }));
    const scope = await run.scope({ kind: 'scenario', label: 'explicit termination policy' });
    const data = await scope.directory('retained until disposal');
    const watch = fs.watch(input.root, (event, filename) => {
        if (filename === 'termination-observed') fs.writeFileSync(input.root + '/release', 'independent fixture release, not managed-stop proof');
    });
    t.after(() => watch.close());
    const lease = await launchOwnedProcess(scope, { label: 'explicit SIGKILL', command: command('ignore-term', { report: input.report, release: input.root + '/release', terminationObserved: input.root + '/termination-observed' }), readyLine: 'resource-ready', stopSignal: 'SIGKILL', dependsOn: [data.resourceId] });
    const worker = JSON.parse(fs.readFileSync(input.report));
    await lease.stop();
    watch.close();
    assert.deepEqual(await lease.exited, { code: null, signal: 'SIGKILL' });
    assert.equal(fs.existsSync(input.root + '/termination-observed'), false);
    assert.equal(await readProcessIdentity(lease.pid), null);
    await closed(worker.port);
    assert.equal(fs.existsSync(data.path), true);
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'passed');
    assert.equal(fs.existsSync(data.path), false);
    t.diagnostic(JSON.stringify({ worker, summary }));
});

test('worker death is reclaimed by its surviving owner', async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'worker', label: 'worker death' });
    const data = await scope.directory('worker data');
    const lease = await launchOwnedProcess(scope, { label: 'worker listener', command: command('server', { report: input.report }), readyLine: 'resource-ready', dependsOn: [data.resourceId] });
    const worker = JSON.parse(fs.readFileSync(input.report));
    assert.deepEqual(await readProcessIdentity(lease.pid), lease.identity);
    process.kill(lease.pid, 'SIGKILL');
    assert.deepEqual(await lease.exited, { code: null, signal: 'SIGKILL' });
    assert.equal(JSON.parse(fs.readFileSync(run.registryPath)).resources.find(record => record.kind === 'process').state, 'exited');
    const summary = await run.finish({ status: 'failed' });
    assert.ok(summary.errors.some(error => /unexpectedly/.test(error.message)));
    await closed(worker.port);
    assert.equal(await readProcessIdentity(lease.pid), null);
    assert.equal(fs.existsSync(data.path), false);
    t.diagnostic(JSON.stringify({ survivingOwner: await readProcessIdentity(process.pid), worker, summary }));
});

test('declared expected process exit accepts matching self-kill and still rejects mismatched exits', async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const matchedInput = fixture(t);
    const matchedRun = await createRun(options(matchedInput.projectRoot));
    t.after(() => matchedRun.finish({ status: 'failed' }));
    const matchedScope = await matchedRun.scope({ kind: 'worker', label: 'expected worker exit' });
    const matchedLease = await launchOwnedProcess(matchedScope, { label: 'expected sigkill', command: command('server', { report: matchedInput.report }), readyLine: 'resource-ready' });
    matchedLease.expectExit({ code: null, signal: 'SIGKILL' });
    process.kill(matchedLease.pid, 'SIGKILL');
    assert.deepEqual(await matchedLease.exited, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(await matchedLease.kill(), { code: null, signal: 'SIGKILL' });
    const matchedSummary = await matchedRun.finish({ status: 'passed' });
    assert.equal(matchedSummary.status, 'passed');
    assert.deepEqual(matchedSummary.errors, []);
    assert.equal(await readProcessIdentity(matchedLease.pid), null);

    const mismatchedInput = fixture(t);
    const mismatchedRun = await createRun(options(mismatchedInput.projectRoot));
    t.after(() => mismatchedRun.finish({ status: 'failed' }));
    const mismatchedScope = await mismatchedRun.scope({ kind: 'worker', label: 'mismatched worker exit' });
    const mismatchedLease = await launchOwnedProcess(mismatchedScope, { label: 'unexpected sigterm', command: command('server', { report: mismatchedInput.report }), readyLine: 'resource-ready' });
    mismatchedLease.expectExit({ code: null, signal: 'SIGKILL' });
    process.kill(mismatchedLease.pid, 'SIGTERM');
    await mismatchedLease.exited;
    const mismatchedSummary = await mismatchedRun.finish({ status: 'failed' });
    assert.ok(mismatchedSummary.errors.some(error => /unexpectedly/.test(error.message)));
    assert.equal(await readProcessIdentity(mismatchedLease.pid), null);
});

test('startup registration precedes the actual worker and retains redacted logs', async t => {
    const { launchOwnedProcess } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'passed' }));
    const scope = await run.scope({ kind: 'case', label: 'startup registration' });
    const lease = await launchOwnedProcess(scope, { label: 'registered before spawn', command: command('server', { report: input.report, registryPath: run.registryPath }), readyLine: 'resource-ready', env: { RESOURCE_FIXTURE_SECRET: 'private-startup-value' } });
    const worker = JSON.parse(fs.readFileSync(input.report));
    const admitted = worker.registration.resources.find(record => record.kind === 'process');
    assert.equal(admitted.owner, 'owned');
    assert.ok(['allocating', 'acquired'].includes(admitted.state));
    assert.equal(admitted.locator.ownerExecutionId, worker.registration.owner.executionId);
    assert.equal(admitted.locator.controller.runId, run.runId);
    assert.equal(admitted.locator.controller.resourceId, lease.resourceId);
    assert.equal(admitted.locator.controller.executionId, lease.executionId);
    assert.equal(admitted.runId, lease.runId);
    assert.equal(admitted.scopeId, lease.scopeId);
    assert.ok(admitted.locator.controller.runtime, 'actual controller runtime receipt is absent');
    assert.equal(admitted.locator.controller.runtime.execPath, process.execPath);
    assert.equal(admitted.locator.controller.runtime.version, process.version);
    await lease.stop();
    const durable = JSON.parse(fs.readFileSync(run.registryPath));
    const processRecord = durable.resources.find(record => record.kind === 'process');
    assert.equal(processRecord.state, 'stopped');
    assert.equal(JSON.stringify(durable).includes('private-startup-value'), false);
    const log = fs.readFileSync(processRecord.startupLog.path, 'utf8');
    assert.equal(log.includes('private-startup-value'), false);
    assert.ok(log.includes('[redacted]'));
    assert.equal(lease.startupLog, log);
    t.diagnostic(JSON.stringify({ registrationAtWorkerEntrance: worker.registration, controllerRuntime: admitted.locator.controller.runtime, durable, startupLog: log }));
    await run.finish({ status: 'passed' });
});

test('port conflict is distinct from a missing executable startup failure', async t => {
    const { launchOwnedProcess } = await api();
    const input = fixture(t);
    const server = net.createServer(socket => socket.end());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const port = server.address().port;
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'startup errors' });
    await assert.rejects(launchOwnedProcess(scope, { label: 'conflicting listener', command: command('server', { port }), readyLine: 'resource-ready' }), error => error.code === 'EADDRINUSE' && /Port conflict/.test(error.message) && /EADDRINUSE/.test(error.startupLog));
    await assert.rejects(launchOwnedProcess(scope, { label: 'missing executable', command: [input.root + '/absent-executable'], readyLine: 'resource-ready' }), error => error.code === 'ENOENT' && error.cause.message.includes('ENOENT'));
    await listening(port);
    const summary = await run.finish({ status: 'failed' });
    assert.ok(summary.resources.every(record => record.state === 'disposed'));
    assert.equal(summary.errors.length, 2);
    t.diagnostic(JSON.stringify({ summary, unownedListenerPreserved: port }));
});

test('startup credentials remain redacted across separately flushed output fragments', async t => {
    const { launchOwnedProcess } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'passed' }));
    const scope = await run.scope({ kind: 'case', label: 'streaming startup log' });
    const staged = Promise.withResolvers();
    const watch = fs.watch(input.root, (event, filename) => { if (filename === 'stage') { watch.close(); staged.resolve(); } });
    t.after(() => watch.close());
    const launching = launchOwnedProcess(scope, { label: 'split startup output', command: command('split-secret', { report: input.report, release: input.root + '/release', stage: input.root + '/stage' }), readyLine: 'resource-ready', env: { RESOURCE_FIXTURE_SECRET: 'credential-first\ncredential-last' } });
    Promise.allSettled([launching]);
    await staged.promise;
    // Independent registry/filesystem work lets the actual output reach the writer.
    const peer = await run.scope({ kind: 'case', label: 'independent log observation' });
    await peer.directory('independent peer');
    await peer.dispose();
    const before = JSON.parse(fs.readFileSync(run.registryPath));
    const record = before.resources.find(record => record.kind === 'process');
    const during = fs.readFileSync(record.startupLog.path, 'utf8');
    fs.writeFileSync(input.root + '/release', 'independent output release');
    const lease = await launching;
    await lease.stop();
    const after = fs.readFileSync(record.startupLog.path, 'utf8');
    assert.equal(during.includes('credential-first'), false);
    assert.equal(after.includes('credential-first'), false);
    assert.equal(after.includes('credential-last'), false);
    assert.ok(after.includes('[redacted]'));
    t.diagnostic(JSON.stringify({ redactedDuringSHA256: sha(during), redactedAfterSHA256: sha(after), before, afterStop: JSON.parse(fs.readFileSync(run.registryPath)) }));
    await run.finish({ status: 'passed' });
});

test('startup failure redacts a partial credential at output termination', async t => {
    const { launchOwnedProcess } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'partial credential termination' });
    await assert.rejects(launchOwnedProcess(scope, { label: 'partial credential failure', command: command('split-secret', { report: input.report, release: input.root + '/release', failAfterPartialSecret: true }), readyLine: 'resource-ready', env: { RESOURCE_FIXTURE_SECRET: 'credential-first\ncredential-last' } }), error => {
        assert.match(error.startupLog, /original startup failure after partial credential output/);
        assert.equal(error.startupLog.includes('credential-first'), false);
        assert.equal(error.startupLog.includes('credential-last'), false);
        assert.ok(error.startupLog.includes('[redacted]'));
        return true;
    });
    await closed(JSON.parse(fs.readFileSync(input.report)).port);
    const summary = await run.finish({ status: 'failed' });
    assert.equal(summary.errors.length, 1);
    assert.ok(summary.resources.every(record => record.state === 'disposed'));
    t.diagnostic(JSON.stringify({ summary }));
});

test('cancellation during readiness retains the original reason and stops the actual listener', async t => {
    const { launchOwnedProcess, readProcessIdentity } = await api();
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'readiness cancellation' });
    const data = await scope.directory('cancelled scenario');
    const controller = new AbortController();
    const original = new Error('original cancellation during process readiness');
    const created = Promise.withResolvers();
    const watch = fs.watch(input.root, (event, filename) => { if (filename === 'worker.json') { watch.close(); created.resolve(); } });
    t.after(() => watch.close());
    const launching = launchOwnedProcess(scope, { label: 'delayed actual readiness', command: command('delayed-readiness', { report: input.report, release: input.root + '/release' }), readyLine: 'resource-ready', signal: controller.signal, dependsOn: [data.resourceId] });
    Promise.allSettled([launching]);
    await created.promise;
    const worker = JSON.parse(fs.readFileSync(input.report));
    controller.abort(original);
    // Native filesystem work releases readiness independently of the managed promise.
    fs.writeFileSync(input.root + '/release', 'independent readiness release');
    await assert.rejects(launching, error => error === original);
    await closed(worker.port);
    assert.equal(await readProcessIdentity(worker.pid), null);
    assert.equal(fs.existsSync(data.path), true);
    const summary = await run.finish({ status: 'failed', error: original });
    assert.equal(summary.errors[0], original);
    assert.equal(fs.existsSync(data.path), false);
    t.diagnostic(JSON.stringify({ worker, summary }));
});

test('native owner cancellation reaches admitted process readiness without a caller cleanup hook', async t => {
    const { readProcessIdentity } = await api();
    const input = fixture(t);
    const runtimePath = input.root + '/native-runtime.json';
    const entry = new URL('./node.js', import.meta.url).href;
    const processes = new URL('./resources/process-owner.js', import.meta.url).href;
    const errors = new URL('./resources/errors.js', import.meta.url).href;
    const source = nativeSource(`
        import fs from 'node:fs';
        import { test as nativeTest } from 'node:test';
        import * as managed from ${JSON.stringify(entry)};
        import { launchOwnedProcess } from ${JSON.stringify(processes)};
        import { serializeFailure } from ${JSON.stringify(errors)};
        const input = ${JSON.stringify(input)};
        const options = ${JSON.stringify(options(input.projectRoot))};
        const controller = new AbortController();
        const original = new Error('original native process-owner cancellation');
        const receipt = { original: serializeFailure(original) };
        const save = () => fs.writeFileSync(input.root + '/native-process.json', JSON.stringify(receipt));
        nativeTest('actual process cancellation ancestor', { signal: controller.signal }, async ancestor => {
            let owner;
            ancestor.beforeEach(actual => { if (!owner) owner = actual; });
            const created = Promise.withResolvers();
            const watch = fs.watch(input.root, (event, filename) => { if (filename === 'worker.json') { watch.close(); created.resolve(); } });
            const completion = managed.test('actual native process owner', options, async (context, scope, run) => {
                await scope.borrowDirectory(input.borrowed);
                const data = await scope.directory('native cancelled process data');
                receipt.allocation = { path: data.path, registryPath: run.registryPath }; save();
                try {
                    await launchOwnedProcess(scope, { label: 'native pending readiness', command: ${JSON.stringify(command('delayed-readiness', { report: input.report, release: input.root + '/release' }))}, readyLine: 'resource-ready', signal: new AbortController().signal, dependsOn: [data.resourceId] });
                    receipt.startupReturned = true; save();
                } catch (error) {
                    receipt.startupRejected = serializeFailure(error);
                    receipt.startupRejectedSameReason = error === owner.signal.reason; save();
                    throw error;
                }
            });
            await created.promise;
            controller.abort(original);
            fs.writeFileSync(input.root + '/release', 'independent native readiness release');
            const summary = await completion;
            receipt.completion = { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)), resources: summary.resources };
            receipt.actualAncestorError = serializeFailure(ancestor.error); save();
        });
        managed.test('actual native process peer', options, async (context, scope, run) => {
            const data = await scope.directory('native process peer data');
            receipt.peer = { path: data.path, registryPath: run.registryPath }; save();
        });
    `, runtimePath);
    const filename = input.root + '/native-process.test.mjs';
    fs.writeFileSync(filename, source, { flag: 'wx' });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const argv = [process.execPath, '--test', filename];
    const native = spawn(argv[0], argv.slice(1), { cwd: path.join(repository, 'tests'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [native.stdout, native.stderr]) { stream.setEncoding('utf8'); stream.on('data', value => { output += value; }); }
    const result = await new Promise((resolve, reject) => { native.once('error', reject); native.once('close', (code, signal) => resolve({ code, signal })); });
    const receipt = JSON.parse(fs.readFileSync(input.root + '/native-process.json'));
    const worker = JSON.parse(fs.readFileSync(input.report));
    t.diagnostic(JSON.stringify({ native: { command: argv, cwd: path.join(repository, 'tests'), runtime: nativeRuntime(runtimePath), source, sourceSHA256: sha(source), output, ...result }, receipt, worker }));
    assert.deepEqual(result, { code: 1, signal: null });
    assert.equal(receipt.completion.status, 'failed');
    assert.equal(receipt.startupReturned, undefined);
    assert.equal(receipt.startupRejectedSameReason, true);
    assert.equal(receipt.actualAncestorError.stack, receipt.original.stack);
    assert.ok(receipt.completion.resources.every(record => record.state === 'disposed' || record.state === 'released'));
    for (const allocation of [receipt.allocation, receipt.peer]) assert.equal(fs.existsSync(allocation.path), false);
    assert.equal(JSON.parse(fs.readFileSync(receipt.peer.registryPath)).status, 'passed');
    assert.equal(await readProcessIdentity(worker.pid), null);
    await closed(worker.port);
});

for (const [label, reason] of [['null', null], ['zero', 0], ['original-error', new Error('original pre-aborted process reason')]]) {
    test(`pre-aborted process startup preserves the ${label} reason without spawning`, async t => {
        const { launchOwnedProcess } = await api();
        const input = fixture(t);
        const run = await createRun(options(input.projectRoot));
        t.after(() => run.finish({ status: 'failed' }));
        const scope = await run.scope({ kind: 'case', label: 'pre-aborted startup' });
        let rejection;
        await assert.rejects(launchOwnedProcess(scope, { label: 'never spawned', command: command('server', { report: input.report }), readyLine: 'resource-ready', signal: AbortSignal.abort(reason) }), error => {
            rejection = error;
            return reason instanceof Error ? error === reason : Object.is(error.cause, reason);
        });
        assert.equal(fs.existsSync(input.report), false);
        const summary = await run.finish({ status: 'failed' });
        assert.deepEqual(summary.errors, [rejection]);
        assert.equal(summary.resources[0].state, 'disposed');
        assert.equal(summary.resources[0].locator.controller, null);
        assert.equal(summary.resources[0].locator.worker, null);
        t.diagnostic(JSON.stringify({ reasonKind: label, summary }));
    });
}

test('recovery ignores completed and unrequested runs before inspecting retired borrowed paths', async t => {
    const { recoverRuns } = await api();
    const input = fixture(t);
    const retired = input.root + '/retired-borrowed';
    fs.mkdirSync(retired);
    const completed = await createRun(options(input.projectRoot));
    const completeScope = await completed.scope({ kind: 'case', label: 'completed run' });
    await completeScope.borrowDirectory(retired);
    await completeScope.directory('completed payload');
    await completed.finish({ status: 'passed' });
    const unrequested = await createRun({ ...options(input.projectRoot), profile: 'unrequested' });
    t.after(() => unrequested.finish({ status: 'passed' }));
    const scope = await unrequested.scope({ kind: 'case', label: 'unrequested active run' });
    await scope.borrowDirectory(retired);
    const data = await scope.directory('unrequested active data');
    fs.writeFileSync(data.path + '/marker', 'unrequested original');
    const before = [completed, unrequested].map(run => fs.readFileSync(run.registryPath));
    fs.rmdirSync(retired);
    const report = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.deepEqual(report.recovered, []);
    assert.deepEqual(report.active, []);
    assert.deepEqual(report.ignored.sort(), [completed.runId, unrequested.runId].sort());
    assert.deepEqual([completed, unrequested].map(run => fs.readFileSync(run.registryPath)), before);
    assert.equal(fs.readFileSync(data.path + '/marker', 'utf8'), 'unrequested original');
    t.diagnostic(JSON.stringify({ report, preservedRegistries: before.map(sha), afterObservation: inventory(input.root) }));
    await unrequested.finish({ status: 'passed' });
});

for (const boundary of ['resource', 'data', 'run', 'borrowed-overlap', 'unknown-provider', 'unpublished-resource', 'unverified-worker']) {
    test(`orphan recovery preserves an unverifiable ${boundary} boundary`, async t => {
        const { recoverRuns } = await api();
        const input = fixture(t);
        const owner = await child(t, 'owner', input);
        owner.process.kill('SIGKILL');
        await owner.exited;
        await endedOwnerController(t, owner.message.registryPath);
        const filename = owner.message.registryPath;
        const snapshot = JSON.parse(fs.readFileSync(filename));
        const directory = snapshot.resources.find(record => record.kind === 'directory' && record.owner === 'owned');
        let target;
        let moved;
        if (['resource', 'data', 'run'].includes(boundary)) {
            target = boundary === 'resource' ? directory.locator.path : boundary === 'data' ? snapshot.dataBoundary.path : path.dirname(filename);
            moved = target + '-original';
            fs.renameSync(target, moved);
            fs.symlinkSync(input.borrowed, target);
        } else {
            if (boundary === 'borrowed-overlap') snapshot.resources.find(record => record.owner === 'borrowed').locator.realPath = directory.locator.path;
            if (boundary === 'unknown-provider') directory.kind = 'unsupported-persisted-provider';
            if (boundary === 'unpublished-resource') { directory.locator.dev = null; directory.locator.ino = null; }
            if (boundary === 'unverified-worker') snapshot.resources.find(record => record.kind === 'process').locator.worker = { pid: owner.message.pid };
            fs.writeFileSync(filename, JSON.stringify(snapshot));
        }
        const before = inventory(input.root);
        await assert.rejects(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }), error => /boundary|overlaps|provider|worker identity/.test(error.message));
        assert.deepEqual(inventory(input.root), before);
        t.diagnostic(JSON.stringify({ boundary, retainedBefore: before, retainedAfter: inventory(input.root) }));
        if (target) { fs.unlinkSync(target); fs.renameSync(moved, target); }
    });
}

test('terminated owner is recovered on the next invocation', async t => {
    const { readProcessIdentity } = await api();
    const input = fixture(t);
    const owner = await child(t, 'owner', input);
    const before = inventory(input.root);
    owner.process.kill('SIGKILL');
    assert.deepEqual(await owner.exited, { code: null, signal: 'SIGKILL' });
    assert.equal(await readProcessIdentity(owner.process.pid), null);
    const recovery = await child(t, 'recover', input);
    assert.deepEqual(await recovery.exited, { code: 0, signal: null });
    assert.equal(recovery.message.report.recovered.length, 1);
    assert.equal(fs.existsSync(owner.message.data), false);
    await closed(owner.message.port);
    assert.equal(await readProcessIdentity(owner.message.pid), null);
    const after = inventory(input.root);
    t.diagnostic(JSON.stringify({ beforeRecovery: before, afterRecovery: after, report: recovery.message.report }));
});

test('ended controller without a published worker outcome retains dependent scenario data', async t => {
    const { recoverRuns } = await api();
    const input = fixture(t);
    const owner = await child(t, 'owner', input);
    owner.process.kill('SIGKILL');
    await owner.exited;
    await endedOwnerController(t, owner.message.registryPath);
    const before = JSON.parse(fs.readFileSync(owner.message.registryPath));
    const processRecord = before.resources.find(record => record.kind === 'process');
    processRecord.state = 'allocating';
    processRecord.locator.worker = null;
    fs.writeFileSync(owner.message.registryPath, JSON.stringify(before));
    await assert.rejects(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }), /worker identity or exit/);
    const after = JSON.parse(fs.readFileSync(owner.message.registryPath));
    assert.deepEqual(after.owner, before.owner);
    assert.equal(after.recovery.state, 'failed');
    assert.deepEqual(after.errors.slice(0, before.errors.length), before.errors);
    assert.equal(after.resources.find(record => record.kind === 'process').state, 'cleanup-failed');
    assert.equal(fs.readFileSync(owner.message.data + '/scenario', 'utf8'), 'original scenario data');
    assert.equal(fs.readFileSync(input.borrowed + '/original', 'utf8'), 'borrowed original');
    t.diagnostic(JSON.stringify({ publicationGapFixture: 'worker publication deliberately omitted; no native identity invented', beforeRecovery: before, retainedAfter: after, retainedData: inventory(input.root) }));
});

test('another run and a reused pid are preserved', async t => {
    const { recoverRuns, launchOwnedProcess, readProcessIdentity, requestAuthority } = await api();
    const input = fixture(t);
    const active = await createRun(options(input.projectRoot));
    t.after(() => active.finish({ status: 'passed' }));
    const scope = await active.scope({ kind: 'scenario', label: 'actual active run' });
    const marker = await scope.directory('active marker');
    fs.writeFileSync(marker.path + '/active', 'original active marker');
    const live = await launchOwnedProcess(scope, { label: 'actual live preservation process', command: command('server', { report: input.root + '/active-worker.json' }), readyLine: 'resource-ready', dependsOn: [marker.resourceId] });
    const liveWorker = JSON.parse(fs.readFileSync(input.root + '/active-worker.json'));
    const otherProject = await createRun(options(input.root + '/other-worktree'));
    t.after(() => otherProject.finish({ status: 'passed' }));
    const otherData = await (await otherProject.scope({ kind: 'case', label: 'another project root' })).directory('other active data');
    fs.writeFileSync(otherData.path + '/marker', 'other project original');
    const otherBytes = fs.readFileSync(otherProject.registryPath);
    const owner = await child(t, 'owner', input);
    const liveRegistry = JSON.parse(fs.readFileSync(owner.message.registryPath));
    await requestAuthority(liveRegistry.resources.find(item => item.kind === 'process').locator.controller, 'stop');
    owner.process.kill('SIGKILL');
    await owner.exited;
    await endedOwnerController(t, owner.message.registryPath);
    const registry = JSON.parse(fs.readFileSync(owner.message.registryPath));
    const record = registry.resources.find(item => item.kind === 'process');
    // Deliberately stale registered-PID fixture, not an OS PID-recycling claim.
    record.locator.worker.pid = process.pid;
    record.locator.worker.native = { ...record.locator.worker.native, pid: process.pid };
    fs.writeFileSync(owner.message.registryPath, JSON.stringify(registry));
    const activeBytes = fs.readFileSync(active.registryPath);
    const old = path.join(input.projectRoot, '.e2e-scratch');
    fs.mkdirSync(old);
    fs.writeFileSync(old + '/historical', 'historical scratch');
    const legacy = path.join(path.dirname(path.dirname(active.registryPath)), randomUUID());
    fs.mkdirSync(legacy);
    fs.writeFileSync(legacy + '/registry.json', JSON.stringify({ owner: { pid: 123 }, resources: [{ locator: { path: old } }] }));
    const before = inventory(input.root);
    const report = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(report.recovered.length, 1);
    assert.equal(report.active.length, 1);
    assert.deepEqual(fs.readFileSync(active.registryPath), activeBytes);
    assert.deepEqual(fs.readFileSync(otherProject.registryPath), otherBytes);
    assert.equal(fs.readFileSync(otherData.path + '/marker', 'utf8'), 'other project original');
    assert.equal(fs.readFileSync(marker.path + '/active', 'utf8'), 'original active marker');
    assert.equal(fs.readFileSync(old + '/historical', 'utf8'), 'historical scratch');
    assert.deepEqual(await readProcessIdentity(live.pid), live.identity);
    await listening(liveWorker.port);
    t.diagnostic(JSON.stringify({ staleFixture: 'registered pid changed deliberately; no actual OS reuse asserted', beforeRecovery: before, afterRecovery: inventory(input.root), liveIdentity: live.identity, report }));
    await active.finish({ status: 'passed' });
    await otherProject.finish({ status: 'passed' });
});

test('reused writer port cannot authorize orphan mutation', async t => {
    const { recoverRuns } = await api();
    const input = fixture(t);
    const owner = await child(t, 'owner', input);
    const ownerRegistry = JSON.parse(fs.readFileSync(owner.message.registryPath));
    owner.process.kill('SIGKILL');
    await owner.exited;
    await endedOwnerController(t, owner.message.registryPath);
    const server = net.createServer(socket => socket.end('unrelated listener'));
    server.listen(ownerRegistry.owner.control.port, '127.0.0.1');
    await once(server, 'listening');
    const before = inventory(input.root);
    try {
        await assert.rejects(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }), /writer authority is in use/);
        assert.deepEqual(inventory(input.root), before);
        await listening(ownerRegistry.owner.control.port);
        assert.equal(fs.existsSync(owner.message.data), true);
        t.diagnostic(JSON.stringify({ unrelatedPort: ownerRegistry.owner.control.port, beforeRecovery: before, afterRecovery: inventory(input.root) }));
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(fs.existsSync(owner.message.data), false);
});

test('recovery cleanup errors fail the invocation while preserving original serialized failures', async t => {
    const { recoverRuns } = await api();
    const input = fixture(t);
    const owner = await child(t, 'owner', input);
    const finished = Promise.race([once(owner.process, 'message'), owner.exited.then(result => { throw new Error(`Owner ended before disposal receipt: ${JSON.stringify(result)}`); })]);
    owner.process.send({ type: 'finish-with-cleanup-failure' });
    assert.equal((await finished)[0].type, 'owner-finished');
    assert.deepEqual(await owner.exited, { code: 0, signal: null });
    const before = JSON.parse(fs.readFileSync(owner.message.registryPath));
    const originalReceipt = JSON.parse(fs.readFileSync(input.root + '/failed-owner.json'));
    assert.equal(before.status, 'failed');
    assert.ok(before.errors.some(error => error.name === 'AssertionError' && error.message === 'original assertion before owner disposal'));
    assert.equal(originalReceipt.permissionProbe.code, 'EACCES');
    assert.equal(fs.statSync(owner.message.data).mode & 0o777, 0o500);
    const cleanup = before.errors.find(error => property(error.resource, 'kind') === 'directory');
    assert.ok(cleanup.cause.code);
    const recovery = await child(t, 'recover', input);
    assert.equal(recovery.message.type, 'recovery-failed');
    assert.deepEqual(await recovery.exited, { code: 1, signal: null });
    const failed = JSON.parse(fs.readFileSync(owner.message.registryPath));
    assert.equal(failed.recovery.state, 'failed');
    assert.deepEqual(failed.errors.slice(0, before.errors.length), before.errors);
    assert.equal(fs.existsSync(owner.message.data), true);
    assert.equal(fs.readFileSync(owner.message.data + '/scenario', 'utf8'), 'original scenario data');
    assert.ok(errorNodes(JSON.parse(fs.readFileSync(recovery.message.errorPath))).some(error => error.code === cleanup.cause.code));
    t.diagnostic(JSON.stringify({ originalFailedSummaryIsNotNativeCommandFailure: true, actualPermissionProbe: originalReceipt.permissionProbe, recursiveCleanupCode: cleanup.cause.code, beforeRecovery: before, failedRecovery: failed, beforeRepair: inventory(input.root) }));
    fs.chmodSync(owner.message.data, 0o700);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(fs.existsSync(owner.message.data), false);
    const completed = JSON.parse(fs.readFileSync(owner.message.registryPath));
    assert.deepEqual(completed.errors, failed.errors);
});

test('concurrent recovery has a single registry mutation authority', async t => {
    const { recoverRuns } = await api();
    const input = fixture(t);
    const owner = await child(t, 'owner', input);
    owner.process.kill('SIGKILL');
    await owner.exited;
    const results = await Promise.allSettled([recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }), recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] })]);
    assert.ok(results.some(result => result.status === 'fulfilled' && result.value.recovered.length === 1));
    for (const result of results) if (result.status === 'rejected') assert.match(result.reason.message, /authority.*in use|concurrent recovery/i);
    assert.equal(fs.existsSync(owner.message.data), false);
    await closed(owner.message.port);
    const durable = JSON.parse(fs.readFileSync(owner.message.registryPath));
    assert.equal(durable.recovery.state, 'recovered');
    t.diagnostic(JSON.stringify({ concurrentRecovery: results.map(result => result.status === 'fulfilled' ? result : { status: result.status, message: result.reason.message }), durable }));
});

for (const state of ['complete', 'failed']) test(`${state} environment export retains its terminal state during actual cleanup retry`, async t => {
    const { recoverRuns } = await api();
    const input = fixture(t);
    const destination = state === 'complete' ? input.root + '/selected-environment' : input.borrowed;
    const owner = await child(t, 'owner', { ...input, exportEnvironmentTo: destination, includeBorrowedLink: false });
    const finished = Promise.race([once(owner.process, 'message'), owner.exited.then(exit => { throw new Error(`Owner ended before cleanup receipt: ${JSON.stringify(exit)}`); })]);
    owner.process.send({ type: 'finish-with-cleanup-failure' });
    await finished;
    const exit = await owner.exited;
    const before = JSON.parse(fs.readFileSync(owner.message.registryPath));
    const archiveBefore = inventory(destination);
    fs.chmodSync(owner.message.data, 0o700);
    const [result] = await Promise.allSettled([recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] })]);
    const after = JSON.parse(fs.readFileSync(owner.message.registryPath));
    t.diagnostic(JSON.stringify({ terminalEnvironmentRetry: { state, exit, before, after, archiveBefore, archiveAfter: inventory(destination), result: result.status, error: result.reason && serializeFailure(result.reason) } }));
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(before.environmentExport.state, state);
    assert.ok(before.resources.some(record => record.kind === 'directory' && record.owner === 'owned' && record.state === 'cleanup-failed'));
    assert.equal(result.status, state === 'complete' ? 'fulfilled' : 'rejected');
    assert.equal(after.environmentExport.state, state);
    assert.deepEqual(inventory(destination), archiveBefore);
    assert.deepEqual(after.errors.slice(0, before.errors.length), before.errors);
    assert.equal(fs.existsSync(owner.message.data), false);
    if (state === 'complete') {
        assert.deepEqual(after.errors, before.errors);
        const record = before.resources.find(record => record.kind === 'directory' && record.owner === 'owned');
        assert.equal(fs.readFileSync(destination + '/resources/' + record.resourceId + '/scenario', 'utf8'), 'original scenario data');
    } else assert.match(result.reason.message, /environment staging is failed/);
});
