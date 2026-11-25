import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRun } from '../resources/run.js';
import { recoverRuns } from '../resources/recovery.js';
import { readProcessIdentity, sameProcessIdentity } from '../resources/native-identity.js';
import { requestAuthority } from '../resources/authority.js';
import { serializeFailure } from '../resources/errors.js';
import { processDiagnostics } from '../resources/process-diagnostics.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const childSource = fileURLToPath(new URL('./resource-terminal-child.mjs', import.meta.url));
const ownerSource = fileURLToPath(new URL('./resource-child.mjs', import.meta.url));
const heldOwnerSource = fileURLToPath(new URL('./resource-boundary-child.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const settled = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
const diagnostic = result => result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) };
const runOptions = projectRoot => ({ projectRoot, profile: 'unit', source: 'terminal-custody-proof', command: [process.execPath, '--test', 'harness/resource-recovery.test.mjs'] });

function nodes(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    return [value, ...Object.getOwnPropertyNames(value).flatMap(key => nodes(value[key], seen))];
}

function inventory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
        const filename = path.join(directory, entry.name);
        const stat = fs.lstatSync(filename);
        return { name: entry.name, dev: stat.dev, ino: stat.ino, mode: stat.mode, ...(entry.isDirectory() ? { children: inventory(filename) } : entry.isSymbolicLink() ? { link: fs.readlinkSync(filename) } : stat.isFIFO() ? { fifo: true } : { bytes: fs.readFileSync(filename).toString('base64') }) };
    });
}

function fixture(t) {
    const parent = repository + '/test-results/resource-terminal-boundaries';
    fs.mkdirSync(parent, { recursive: true });
    assert.equal(fs.realpathSync(parent), parent);
    const root = fs.mkdtempSync(parent + '/case-');
    const identity = fs.lstatSync(root);
    for (const name of ['project', 'borrowed', 'sibling', 'peer']) fs.mkdirSync(root + '/' + name);
    fs.writeFileSync(root + '/borrowed/original', 'borrowed terminal bytes');
    fs.writeFileSync(root + '/sibling/original', 'sibling terminal bytes');
    const protectedBefore = [inventory(root + '/borrowed'), inventory(root + '/sibling')];
    t.after(() => {
        assert.equal(fs.realpathSync(root), root);
        const stat = fs.lstatSync(root);
        assert.equal(stat.dev, identity.dev); assert.equal(stat.ino, identity.ino);
        const descriptors = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
        t.diagnostic(JSON.stringify({ terminalFixture: root, dev: identity.dev, ino: identity.ino, beforeOuterTeardown: inventory(root), descriptors }));
        try {
            assert.deepEqual([inventory(root + '/borrowed'), inventory(root + '/sibling')], protectedBefore);
            assert.equal(descriptors.includes(root + '/'), false);
        } finally {
            const restore = directory => {
                const stat = fs.lstatSync(directory);
                if (!stat.isDirectory()) return;
                fs.chmodSync(directory, stat.mode | 0o700);
                for (const entry of fs.readdirSync(directory)) restore(path.join(directory, entry));
            };
            restore(root + '/project');
            fs.rmSync(root, { recursive: true });
        }
        assert.equal(fs.existsSync(root), false);
    });
    return { root, projectRoot: root + '/project', borrowed: root + '/borrowed', report: root + '/worker.json', release: root + '/release', termination: root + '/termination', fifo: root + '/writer-fifo' };
}

async function nativeChild(t, filename, mode, input, environment = {}) {
    const argv = [process.execPath, filename, mode, JSON.stringify(input)];
    const actual = spawn(argv[0], argv.slice(1), { cwd: repository + '/tests', env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    let pending = '';
    const events = [];
    const waiters = [];
    const receive = event => {
        events.push(event);
        for (const waiter of [...waiters]) if (waiter.type === event.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
    };
    actual.on('message', receive);
    actual.stdout.setEncoding('utf8'); actual.stderr.setEncoding('utf8');
    actual.stdout.on('data', value => {
        output += value; pending += value;
        while (pending.includes('\n')) {
            const end = pending.indexOf('\n');
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (line.startsWith('PROOF ')) {
                const proof = JSON.parse(line.slice(6));
                assert.equal(path.dirname(proof.receipt), input.root);
                receive(JSON.parse(fs.readFileSync(proof.receipt)));
            }
        }
    });
    actual.stderr.on('data', value => { output += value; });
    const exited = new Promise((resolve, reject) => {
        actual.once('error', reject);
        actual.once('close', (code, signal) => {
            const result = { code, signal };
            t.diagnostic(JSON.stringify({ terminalChild: { command: argv, cwd: repository + '/tests', environment, sourceSHA256: sha(fs.readFileSync(filename)), output, events, ...result } }));
            resolve(result);
        });
    });
    const next = type => {
        const event = events.find(event => event.type === type);
        if (event) return Promise.resolve(event);
        return Promise.race([new Promise(resolve => waiters.push({ type, resolve })), exited.then(result => { throw new Error(`Native ${mode} ended before ${type}: ${JSON.stringify(result)}: ${output}`); })]);
    };
    const first = await next(filename === childSource ? 'runtime' : 'ready');
    assert.equal(first.runtime.execPath, process.execPath); assert.equal(first.runtime.version, process.version);
    return { process: actual, exited, next, events, first };
}

async function failedOwner(t, input) {
    const owner = await nativeChild(t, ownerSource, 'owner', input);
    const finished = owner.next('owner-finished');
    owner.process.send({ type: 'finish-with-cleanup-failure' });
    await finished;
    assert.deepEqual(await owner.exited, { code: 0, signal: null });
    return { ...input, registryPath: owner.first.registryPath, data: owner.first.data };
}

for (const interval of ['prepublication', 'prepare', 'durability']) {
    test(`a separate native recovery refuses mutation during pending final ${interval}`, async t => {
        const input = await failedOwner(t, fixture(t));
        const earlier = await nativeChild(t, childSource, 'writer', { ...input, interval });
        let pending;
        let later;
        let laterExit;
        let observed;
        try {
            pending = await earlier.next('pending');
            assert.deepEqual(await readProcessIdentity(earlier.process.pid), pending.held.snapshot.writer.native);
            const before = fs.readFileSync(input.registryPath);
            later = await nativeChild(t, childSource, 'recover', input);
            const complete = await later.next('complete');
            laterExit = await later.exited;
            observed = { before: before.toString('base64'), after: fs.readFileSync(input.registryPath).toString('base64'), complete, earlierNative: await readProcessIdentity(earlier.process.pid), data: fs.readFileSync(input.data + '/scenario', 'utf8') };
        } finally { earlier.process.kill('SIGCONT'); }
        const firstExit = await earlier.exited;
        const conclusion = await earlier.next('complete');
        t.diagnostic(JSON.stringify({ foreignWriterCustody: { interval, pending, observed, firstExit, laterExit, conclusion } }));
        fs.chmodSync(path.dirname(input.registryPath), 0o700);
        fs.chmodSync(input.data, 0o700);
        await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        assert.deepEqual(firstExit, { code: 1, signal: null });
        assert.deepEqual(laterExit, { code: 1, signal: null });
        assert.equal(observed.complete.result.status, 'rejected');
        assert.match(JSON.stringify(observed.complete.result.error), /active.*writer|custody.*(active|held)|writer.*(active|in use)/i);
        assert.equal(observed.after, observed.before, 'another native writer changed metadata before the pending final write concluded');
        assert.equal(observed.data, 'original scenario data');
        assert.ok(sameProcessIdentity(observed.earlierNative, pending.held.snapshot.writer.native));
    });
}

test('a same-native recovery refuses reopening during pending failed final durability', async t => {
    const input = await failedOwner(t, fixture(t));
    const child = await nativeChild(t, childSource, 'same-writer', input, { UV_THREADPOOL_SIZE: '1' });
    const receipt = await child.next('complete');
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    t.diagnostic(JSON.stringify({ localWriterCustody: receipt }));
    fs.chmodSync(input.data, 0o700);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.ok(receipt.held);
    assert.equal(receipt.released, true);
    assert.equal(receipt.attemptedWrite, undefined, 'another managed invocation reopened and wrote while its same-native predecessor was still pending');
    assert.equal(receipt.laterResult.status, 'rejected');
    assert.equal(receipt.laterResult.firstStillPending, true);
    assert.equal(receipt.laterResult.bytes, receipt.held.bytes);
    assert.match(JSON.stringify(receipt.laterResult.error), /active.*writer|custody.*(active|held)|writer.*(active|in use)/i);
});

test('normal finish retains mutation custody after listener retirement through final durability', async t => {
    const input = fixture(t);
    const child = await nativeChild(t, childSource, 'same-finish', input, { UV_THREADPOOL_SIZE: '1' });
    const receipt = await child.next('complete');
    assert.deepEqual(await child.exited, { code: 0, signal: null });
    const data = receipt.after.resources.find(record => record.owner === 'owned' && record.kind === 'directory');
    t.diagnostic(JSON.stringify({ normalFinalCustody: receipt }));
    assert.equal(fs.readFileSync(data.locator.path + '/scenario', 'utf8'), 'original scenario data');
    fs.chmodSync(data.locator.path, 0o700);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.ok(receipt.held);
    assert.equal(receipt.attemptedWrite, undefined);
    assert.equal(receipt.laterResult.status, 'rejected');
    assert.equal(receipt.laterResult.firstStillPending, true);
    assert.equal(receipt.laterResult.bytes, receipt.held.bytes);
    assert.equal(fs.existsSync(data.locator.path), false);
});

for (const state of ['recovering', 'failed']) {
    test(`unknown same-native ${state} execution is not treated as positively concluded`, async t => {
        const input = await failedOwner(t, fixture(t));
        const original = fs.readFileSync(input.registryPath);
        const snapshot = JSON.parse(original);
        snapshot.writer = { ...snapshot.owner, pid: process.pid, native: await readProcessIdentity(process.pid), executionId: randomUUID() };
        snapshot.recovery = { state, executionId: snapshot.writer.executionId };
        fs.writeFileSync(input.registryPath, JSON.stringify(snapshot));
        const before = fs.readFileSync(input.registryPath);
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        const after = fs.readFileSync(input.registryPath);
        t.diagnostic(JSON.stringify({ unknownLocalExecution: { fixture: 'actual current native identity with deliberately unknown execution UUID; no OS identity invented', state, before: JSON.parse(before), after: JSON.parse(after), result: diagnostic(result) } }));
        fs.writeFileSync(input.registryPath, original);
        fs.chmodSync(input.data, 0o700);
        await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        assert.equal(result.status, 'rejected');
        assert.match(JSON.stringify(serializeFailure(result.error)), /unknown.*execution|execution.*(unknown|concluded)|positive.*conclu/i);
        assert.deepEqual(after, before, 'unknown local execution authorized a registry mutation');
    });
}

test('an awaited rejected recovery supplies an affirmative serial execution conclusion', async t => {
    const input = await failedOwner(t, fixture(t));
    const first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const failed = JSON.parse(fs.readFileSync(input.registryPath));
    assert.equal(first.status, 'rejected');
    assert.equal(fs.readFileSync(input.data + '/scenario', 'utf8'), 'original scenario data');
    fs.chmodSync(input.data, 0o700);
    const second = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    const final = JSON.parse(fs.readFileSync(input.registryPath));
    t.diagnostic(JSON.stringify({ positiveExecutionConclusion: { first: diagnostic(first), failed, second, final } }));
    assert.deepEqual(second.recovered, [failed.runId]);
    assert.deepEqual(final.errors, failed.errors);
    assert.equal(fs.existsSync(input.data), false);
});

for (const damage of ['missing', 'partial', 'mismatched', 'unknown', 'partial-graph']) {
    test(`ended process recovery retains scenario data with ${damage} terminal evidence`, async t => {
        const input = fixture(t);
        const owner = await nativeChild(t, ownerSource, 'owner', input);
        const before = JSON.parse(fs.readFileSync(owner.first.registryPath));
        const record = before.resources.find(record => record.kind === 'process');
        await requestAuthority(record.locator.controller, 'stop');
        while (sameProcessIdentity(await readProcessIdentity(record.locator.controller.native.pid), record.locator.controller.native)) { /* Wait for the actual owned execution, not elapsed turns. */ }
        owner.process.kill('SIGKILL');
        await owner.exited;
        assert.ok(record.terminal, 'controller started without a registered terminal transport');
        const original = fs.readFileSync(record.terminal.path);
        if (damage === 'missing') fs.renameSync(record.terminal.path, record.terminal.path + '.retained');
        else if (damage === 'partial') fs.writeFileSync(record.terminal.path, original.subarray(0, original.length - 2));
        else {
            const receipt = JSON.parse(original);
            if (damage === 'mismatched') receipt.executionId = randomUUID();
            else if (damage === 'partial-graph') {
                let native;
                try { fs.openSync(input.root + '/absent-native-graph-input', 'r'); }
                catch (error) { native = error; }
                assert.equal(native.code, 'ENOENT');
                receipt.status = 'failed';
                receipt.error = serializeFailure(native);
                delete receipt.error.name;
            }
            else receipt.status = 'unknown';
            fs.writeFileSync(record.terminal.path, JSON.stringify(receipt) + '\n');
        }
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        const after = JSON.parse(fs.readFileSync(owner.first.registryPath));
        t.diagnostic(JSON.stringify({ damagedTerminal: { damage, original: JSON.parse(original), result: diagnostic(result), after, data: fs.readFileSync(owner.first.data + '/scenario', 'utf8'), native: await readProcessIdentity(record.locator.controller.native.pid) } }));
        assert.equal(after.resources.find(record => record.kind === 'process').terminal.acknowledged, null, 'incomplete evidence was acknowledged as a complete terminal failure');
        if (damage === 'missing') fs.renameSync(record.terminal.path + '.retained', record.terminal.path);
        else fs.writeFileSync(record.terminal.path, original);
        await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        assert.equal(result.status, 'rejected');
        assert.match(result.error.message, /terminal/);
        assert.equal(after.recovery.state, 'failed');
        assert.equal(after.resources.find(record => record.kind === 'process').state, 'cleanup-failed');
        assert.equal(fs.existsSync(owner.first.data), false);
    });
}

test('a reset after a concurrent stop reply reaches the ended-owner recoverer terminal outcome', async t => {
    const input = fixture(t);
    const owner = await nativeChild(t, heldOwnerSource, 'owner', input);
    const record = JSON.parse(fs.readFileSync(owner.first.registryPath)).resources.find(record => record.kind === 'process');
    const identity = record.locator.controller;
    const peer = net.connect({ ...identity.control, allowHalfOpen: true });
    await once(peer, 'connect');
    let response = '';
    peer.setEncoding('utf8'); peer.on('data', value => { response += value; });
    const peerEnd = once(peer, 'end');
    const peerClosed = new Promise(resolve => peer.once('close', resolve));
    const nonce = randomUUID();
    peer.write(JSON.stringify({ runId: identity.runId, executionId: identity.executionId, nonce, action: 'stop' }) + '\n');
    const watching = fs.watch(input.root);
    try { while (!fs.existsSync(input.termination)) await once(watching, 'change'); }
    finally { watching.close(); }
    owner.process.kill('SIGKILL');
    assert.deepEqual(await owner.exited, { code: null, signal: 'SIGKILL' });
    let result;
    const recovering = settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    recovering.then(value => { result = value; });
    let admitted;
    while (!admitted && !result) {
        await readProcessIdentity(identity.native.pid);
        const descriptors = execFileSync('lsof', ['-nP', '-a', '-p', String(identity.native.pid), '-Ffn'], { encoding: 'utf8' });
        if (descriptors.split('\n').filter(line => line.startsWith(`n127.0.0.1:${identity.control.port}->`)).length < 2) continue;
        await requestAuthority(identity, 'identify');
        admitted = descriptors;
    }
    fs.writeFileSync(input.release, 'independent worker release before replying-peer reset');
    await peerEnd;
    const priorResponse = JSON.parse(response);
    const independent = await createRun(runOptions(input.root + '/peer'));
    await (await independent.scope({ kind: 'peer', label: 'post-reply observer' })).directory('real independent I/O');
    await independent.finish({ status: 'passed' });
    const beforeReset = { resultStatus: result?.status ?? 'pending', native: await readProcessIdentity(identity.native.pid), data: fs.readFileSync(owner.first.data + '/scenario', 'utf8'), snapshot: JSON.parse(fs.readFileSync(owner.first.registryPath)), descriptors: execFileSync('lsof', ['-nP', '-a', '-p', String(identity.native.pid), '-Ffn'], { encoding: 'utf8' }) };
    peer.resetAndDestroy();
    await peerClosed;
    const returned = await recovering;
    const after = JSON.parse(fs.readFileSync(owner.first.registryPath));
    const retained = fs.existsSync(owner.first.data);
    t.diagnostic(JSON.stringify({ postReplyTerminalOutcome: { identity, admitted, priorResponse, beforeReset, returned: diagnostic(returned), after, retained, workerNative: await readProcessIdentity(owner.first.pid), controllerNative: await readProcessIdentity(identity.native.pid) } }));
    const repaired = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    t.diagnostic(JSON.stringify({ postReplyRepeat: { repaired, final: JSON.parse(fs.readFileSync(owner.first.registryPath)) } }));
    assert.equal(priorResponse.nonce, nonce);
    assert.deepEqual(priorResponse.result.worker.exit, { code: 0, signal: null });
    assert.equal(beforeReset.resultStatus, 'pending');
    assert.ok(sameProcessIdentity(beforeReset.native, identity.native));
    assert.equal(beforeReset.data, 'original scenario data');
    assert.equal(returned.status, 'rejected', 'recoverer promoted a preliminary successful reply and native disappearance to a complete successful shutdown');
    assert.ok(nodes(serializeFailure(returned.error)).some(node => node.type === 'error' && node.code === 'ECONNRESET'), 'post-reply reset original was lost');
    assert.equal(after.recovery.state, 'failed');
    assert.equal(retained, true);
    assert.equal(fs.existsSync(owner.first.data), false);
});

function graphFixture() {
    const secrets = ['generated-slot-alpha', 'generated-slot-beta'];
    const earlier = new Error('original earlier slot error');
    const later = new TypeError('original later slot error');
    const original = new AggregateError([new Error('ordinary aggregate member')], 'original structured graph', { cause: new Error('ordinary graph cause') });
    original.payload = { ['slot-' + secrets[0]]: earlier, ['slot-' + secrets[1]]: later, alias: earlier };
    original.payload.self = original.payload;
    const getter = function () { throw new Error('serializer invoked an accessor'); };
    Object.defineProperty(getter, 'name', { value: 'getter-' + secrets[0] });
    Object.defineProperty(original.payload, 'access-' + secrets[1], { get: getter, enumerable: true });
    return { secrets, earlier, later, original };
}

test('redaction preserves colliding payload slots and resolves shared cyclic graph identities', () => {
    const { secrets, earlier, later, original } = graphFixture();
    const before = serializeFailure(original);
    const graph = processDiagnostics({ sensitiveValues: secrets }).failure(original);
    const all = nodes(graph);
    assert.ok(all.some(node => node.type === 'error' && node.message === earlier.message), 'redaction discarded the earlier colliding payload Error');
    assert.ok(all.some(node => node.type === 'error' && node.message === later.message));
    const identities = new Set(all.filter(node => Number.isInteger(node.id)).map(node => node.id));
    for (const reference of all.filter(node => node.type === 'reference')) assert.ok(identities.has(reference.ref), `Diagnostic reference ${reference.ref} lost its identity`);
    assert.deepEqual(serializeFailure(original), before);
    assert.equal(original.payload.alias, earlier);
    assert.equal(original.payload.self, original.payload);
    for (const secret of secrets) assert.equal(JSON.stringify(graph).includes(secret), false);
});

test('declared serialization vocabulary redacts payload without changing schema tags or references', () => {
    const secrets = ['type', 'error', 'properties', 'reference', 'id', 'ref', 'name', 'code', 'accessor'];
    const original = new Error('payload type error properties reference id ref name code accessor');
    const value = { type: 'type', error: 'error', properties: 'properties' };
    value.self = value;
    original.details = value;
    original.alias = value;
    const before = serializeFailure(original);
    const graph = processDiagnostics({ sensitiveValues: secrets }).failure(original);
    assert.equal(graph.type, 'error', 'payload transformation changed the constant Error type tag');
    assert.equal(typeof graph.id, 'number');
    assert.equal(graph.message, 'payload [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted]');
    const all = nodes(graph);
    assert.ok(all.some(node => node.type === 'object'));
    assert.ok(all.some(node => node.type === 'reference'));
    const identities = new Set(all.filter(node => Number.isInteger(node.id)).map(node => node.id));
    for (const reference of all.filter(node => node.type === 'reference')) assert.ok(identities.has(reference.ref));
    assert.deepEqual(serializeFailure(original), before);
});

test('durable process diagnostics retain both colliding Error originals and accessor payload metadata', async t => {
    const input = fixture(t);
    const run = await createRun(runOptions(input.projectRoot));
    const { launchOwnedProcess } = await import('../resources/process-owner.js');
    const scope = await run.scope({ kind: 'case', label: 'durable graph projection' });
    const value = graphFixture();
    const lease = await launchOwnedProcess(scope, { label: 'registered diagnostic declarations', command: [process.execPath, heldOwnerSource, 'capture', JSON.stringify({ ...input, marker: 'resource-ready' })], readyLine: 'resource-ready', sensitiveValues: value.secrets });
    await lease.stop();
    run.recordError(value.original);
    const summary = await run.finish({ status: 'failed', error: value.original });
    const durable = JSON.parse(fs.readFileSync(run.registryPath));
    t.diagnostic(JSON.stringify({ durableGraphProjection: { durable, original: serializeFailure(value.original), summaryErrorIdentity: summary.errors[0] === value.original } }));
    const all = nodes(durable.errors);
    assert.ok(all.some(node => node.type === 'error' && node.stack === value.earlier.stack), 'durable projection lost the earlier payload Error');
    assert.ok(all.some(node => node.type === 'error' && node.stack === value.later.stack));
    assert.ok(all.some(node => node.type === 'accessor' && node.get === 'getter-[redacted]'));
    for (const secret of value.secrets) assert.equal(JSON.stringify(durable).includes(secret), false);
    assert.equal(summary.errors[0], value.original);
});
