import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createHook } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRun } from '../resources/run.js';
import { launchOwnedProcess, recoverOwnedProcess } from '../resources/process-owner.js';
import { recoverRuns } from '../resources/recovery.js';
import { Authority, requestAuthority } from '../resources/authority.js';
import { serializeFailure } from '../resources/errors.js';
import { readProcessIdentity, sameProcessIdentity } from '../resources/native-identity.js';
import { property } from './failure-graph.mjs';
import { registeredTerminal } from './process-native-control.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const source = fileURLToPath(new URL('./resource-boundary-child.mjs', import.meta.url));
const oldChild = fileURLToPath(new URL('./resource-child.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const options = projectRoot => ({ projectRoot, profile: 'unit', source: 'real-process-boundaries', command: [process.execPath, '--test', 'harness/resource-recovery.test.mjs'] });
const settled = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
const command = (mode, input) => [process.execPath, source, mode, JSON.stringify(input)];

function inventory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
        const filename = path.join(directory, entry.name);
        const stat = fs.lstatSync(filename);
        return { name: entry.name, dev: stat.dev, ino: stat.ino, mode: stat.mode, ...(entry.isDirectory() ? { children: inventory(filename) } : entry.isSymbolicLink() ? { link: fs.readlinkSync(filename) } : { bytes: fs.readFileSync(filename).toString('base64') }) };
    });
}

function descriptors(pid = process.pid) {
    const output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-Ffn'], { encoding: 'utf8' });
    let fd;
    const records = [];
    for (const line of output.split('\n')) {
        if (line.startsWith('f')) fd = line.slice(1);
        if (line.startsWith('n')) records.push({ fd, path: line.slice(1) });
    }
    return records;
}

function fixture(t) {
    const parent = path.join(repository, 'test-results/resource-process-boundaries');
    fs.mkdirSync(parent, { recursive: true });
    assert.equal(fs.realpathSync(parent), parent);
    const root = fs.mkdtempSync(parent + '/case-');
    const identity = fs.lstatSync(root);
    for (const name of ['project', 'borrowed', 'sibling']) fs.mkdirSync(root + '/' + name);
    fs.writeFileSync(root + '/borrowed/original', Buffer.from('borrowed\0original\xff', 'latin1'));
    fs.writeFileSync(root + '/sibling/original', 'sibling original');
    const protectedBefore = [inventory(root + '/borrowed'), inventory(root + '/sibling')];
    t.after(() => {
        assert.equal(fs.realpathSync(root), root);
        const actual = fs.lstatSync(root);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        const ownedDescriptors = descriptors().filter(item => item.path.startsWith(root + '/'));
        t.diagnostic(JSON.stringify({ boundaryFixture: root, dev: identity.dev, ino: identity.ino, beforeOuterTeardown: inventory(root), ownedDescriptors }));
        try {
            assert.deepEqual([inventory(root + '/borrowed'), inventory(root + '/sibling')], protectedBefore);
            assert.deepEqual(ownedDescriptors, []);
        } finally { fs.rmSync(root, { recursive: true }); }
        assert.equal(fs.existsSync(root), false);
    });
    return { root, projectRoot: root + '/project', borrowed: root + '/borrowed', report: root + '/worker.json', stage: root + '/stage', release: root + '/release', emitted: root + '/emitted', termination: root + '/termination' };
}

function watchFile(filename) {
    const receipt = Promise.withResolvers();
    const watcher = fs.watch(path.dirname(filename), (event, name) => {
        if (name === path.basename(filename) && fs.existsSync(filename)) { watcher.close(); receipt.resolve(JSON.parse(fs.readFileSync(filename))); }
    });
    if (fs.existsSync(filename)) { watcher.close(); receipt.resolve(JSON.parse(fs.readFileSync(filename))); }
    return { promise: receipt.promise, close: () => watcher.close() };
}

async function closed(port) {
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('error', reject);
        socket.once('connect', () => { socket.end(); resolve(); });
    }), { code: 'ECONNREFUSED' });
}

function allNodes(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    return [value, ...Object.getOwnPropertyNames(value).flatMap(key => allNodes(value[key], seen))];
}

async function child(t, filename, mode, input) {
    const argv = [process.execPath, filename, mode, JSON.stringify(input)];
    const actual = spawn(argv[0], argv.slice(1), { cwd: repository + '/tests', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    const messages = [];
    for (const stream of [actual.stdout, actual.stderr]) { stream.setEncoding('utf8'); stream.on('data', value => { output += value; }); }
    actual.on('message', message => messages.push(message));
    const exited = new Promise((resolve, reject) => {
        actual.once('error', reject);
        actual.once('close', (code, signal) => {
            const result = { code, signal };
            t.diagnostic(JSON.stringify({ boundaryChild: { command: argv, cwd: repository + '/tests', sourceSHA256: sha(fs.readFileSync(filename)), output, messages, ...result } }));
            resolve(result);
        });
    });
    const message = await Promise.race([once(actual, 'message').then(([value]) => value), exited.then(result => { throw new Error(`Native boundary child ended before receipt: ${JSON.stringify(result)}: ${output}`); })]);
    assert.equal(message.runtime.execPath, process.execPath);
    assert.equal(message.runtime.version, process.version);
    return { process: actual, exited, message };
}

function fsyncObserver(callback) {
    let failure;
    const hook = createHook({ init(id, type) {
        if (!type.startsWith('FSREQ') || failure) return;
        const stack = new Error('actual registered directory fsync').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        try { callback({ id, type, stack }); }
        catch (error) { failure = error; }
    } });
    return { enable: () => hook.enable(), disable: () => hook.disable(), check: () => { if (failure) throw failure; } };
}

test('missing executable preserves useful redacted native errors in the durable registry', async t => {
    const input = fixture(t);
    const secret = 'generated-durable-credential-' + randomUUID();
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'diagnostic native error' });
    const result = await settled(launchOwnedProcess(scope, { label: 'missing native executable', command: [input.root + '/missing', secret], readyLine: 'resource-ready', sensitiveValues: [secret] }));
    const summary = await run.finish({ status: 'failed' });
    const durable = fs.readFileSync(run.registryPath, 'utf8');
    const record = summary.resources.find(item => item.kind === 'process');
    const log = fs.readFileSync(record.startupLog.path, 'utf8');
    t.diagnostic(JSON.stringify({ durableDiagnostic: JSON.parse(durable), returnedFailure: serializeFailure(result.error), startupLog: log }));
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'ENOENT');
    assert.ok(allNodes(serializeFailure(result.error)).some(node => node.type === 'error' && node.code === 'ENOENT' && node.stack.includes('spawn')));
    assert.equal(durable.includes(secret), false, 'declared credential leaked into registry error graph');
    assert.equal(JSON.stringify(serializeFailure(result.error)).includes(secret), false);
    assert.equal(log.includes(secret), false);
    assert.equal(record.state, 'disposed');
});

for (const nativeInput of ['argument', 'environment value', 'environment key', 'cwd', 'executable']) {
    test(`invalid native ${nativeInput} is rejected without allocating a process`, async t => {
        const input = fixture(t);
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: 'native input validation' });
        const data = await scope.directory('valid dependency');
        const processOptions = { label: 'invalid native input', command: command('capture', { ...input, marker: 'resource-ready' }), readyLine: 'resource-ready', dependsOn: [data.resourceId] };
        if (nativeInput === 'argument') processOptions.command.push('native\0argument');
        if (nativeInput === 'executable') processOptions.command[0] += '\0invalid';
        if (nativeInput === 'environment value') processOptions.env = { RESOURCE_CAPTURE_VALUE: 'native\0environment' };
        if (nativeInput === 'environment key') processOptions.env = { ['RESOURCE\0CAPTURE']: 'native environment' };
        if (nativeInput === 'cwd') processOptions.cwd = input.root + '/native\0cwd';
        const result = await settled(launchOwnedProcess(scope, processOptions));
        const beforeFinish = JSON.parse(fs.readFileSync(run.registryPath));
        const summary = await run.finish({ status: 'passed' });
        t.diagnostic(JSON.stringify({ invalidNativeInput: nativeInput, error: serializeFailure(result.error), beforeFinish, summary }));
        assert.equal(result.status, 'rejected');
        assert.ok(result.error instanceof TypeError);
        assert.equal(beforeFinish.resources.some(record => record.kind === 'process'), false, 'invalid public native input acquired process custody');
        assert.equal(fs.existsSync(input.report), false);
        assert.equal(fs.existsSync(data.path), false);
        assert.equal(summary.status, 'passed');
    });
}

for (const interval of ['queued', 'after diagnostic capture']) {
    test(`${interval} command environment and declared values use one captured input`, async t => {
        const input = fixture(t);
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: 'captured mutable input' });
        const original = 'generated-captured-value-' + randomUUID();
        const replacement = 'generated-replacement-value-' + randomUUID();
        const processOptions = { label: 'captured native child', command: command('capture', { ...input, marker: 'resource-ready' }), env: { RESOURCE_CAPTURE_VALUE: original }, sensitiveValues: [original], readyLine: 'resource-ready', signal: new AbortController().signal };
        let mutation;
        const mutate = () => {
            processOptions.command[2] = 'mutated-command';
            processOptions.env.RESOURCE_CAPTURE_VALUE = replacement;
            processOptions.sensitiveValues[0] = replacement;
            mutation = true;
        };
        const hook = fsyncObserver(() => {
            if (mutation) return;
            const snapshot = JSON.parse(fs.readFileSync(run.registryPath));
            if (snapshot.resources.some(record => record.startupLog?.ino && record.locator.controller === null)) mutate();
        });
        if (interval === 'after diagnostic capture') hook.enable();
        const launching = launchOwnedProcess(scope, processOptions);
        if (interval === 'queued') mutate();
        const result = await settled(launching);
        hook.disable(); hook.check();
        if (result.status === 'fulfilled') await result.value.stop();
        const summary = await run.finish({ status: result.status === 'fulfilled' ? 'passed' : 'failed' });
        const worker = JSON.parse(fs.readFileSync(input.report));
        const log = fs.readFileSync(summary.resources.find(record => record.kind === 'process').startupLog.path, 'utf8');
        t.diagnostic(JSON.stringify({ capturedInput: { interval, mutation, runtime: worker.runtime, argv: worker.argv, valueSHA256: sha(worker.value), originalSHA256: sha(original), callerCommand: processOptions.command, callerValueSHA256: sha(processOptions.env.RESOURCE_CAPTURE_VALUE), log, summary } }));
        assert.equal(mutation, true);
        assert.equal(result.status, 'fulfilled');
        assert.equal(worker.argv[0], 'capture');
        assert.equal(worker.value, original);
        assert.equal(log.includes(original), false);
        assert.ok(log.includes('[redacted]'));
        assert.equal(processOptions.env.RESOURCE_CAPTURE_VALUE, replacement);
        assert.equal(Object.isFrozen(processOptions.command), false);
    });
}

test('startup log acquisition rejects a run ancestor replaced during registration fsync', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'log acquisition boundary' });
    const directory = path.dirname(run.registryPath);
    const moved = directory + '-registered';
    const before = JSON.parse(fs.readFileSync(run.registryPath));
    const protectedBefore = inventory(input.borrowed);
    let injection;
    const hook = fsyncObserver(receipt => {
        if (injection) return;
        const snapshot = JSON.parse(fs.readFileSync(run.registryPath));
        const record = snapshot.resources.find(record => record.startupLog?.dev === null);
        if (!record) return;
        const descriptor = descriptors().find(item => item.path === directory && /^\d+$/.test(item.fd));
        assert.ok(descriptor);
        injection = { ...receipt, descriptor, originalRun: snapshot, borrowedBefore: inventory(input.borrowed), nativeDirectory: { dev: fs.fstatSync(Number(descriptor.fd)).dev, ino: fs.fstatSync(Number(descriptor.fd)).ino } };
        fs.renameSync(directory, moved);
        fs.symlinkSync(input.borrowed, directory);
    });
    hook.enable();
    const result = await settled(launchOwnedProcess(scope, { label: 'log through replaced ancestor', command: command('capture', { ...input, marker: 'resource-ready' }), readyLine: 'resource-ready' }));
    hook.disable();
    const finish = await settled(run.finish({ status: 'failed' }));
    const observed = { borrowedAfter: inventory(input.borrowed), movedRegistry: JSON.parse(fs.readFileSync(moved + '/registry.json')), descriptorsAfter: descriptors(), workerStarted: fs.existsSync(input.report), failure: serializeFailure(result.error), finish: serializeFailure(finish.error) };
    t.diagnostic(JSON.stringify({ logBoundary: { before, injection, ...observed } }));
    fs.unlinkSync(directory);
    fs.renameSync(moved, directory);
    // Foreign entries remain unchanged until exact outer-fixture reclamation.
    hook.check();
    assert.ok(injection, 'startup-log registration fsync was not observed');
    assert.equal(result.status, 'rejected');
    assert.match(JSON.stringify(serializeFailure(result.error)), /boundary|ownership/);
    assert.equal(observed.workerStarted, false);
    assert.deepEqual(observed.borrowedAfter, protectedBefore, 'startup-log open created a foreign leaf through the replaced ancestor');
    assert.deepEqual(observed.movedRegistry.owner, before.owner);
    assert.deepEqual(observed.movedRegistry.boundaries, before.boundaries);
    assert.deepEqual(observed.descriptorsAfter.filter(item => item.path.startsWith(input.root + '/')), []);
});

test('diagnostic serialization transforms full graphs without mutating original failures', () => {
    const secret = 'generated-graph-credential';
    const cause = new TypeError('original useful cause ' + secret);
    cause.code = 'USEFUL_NATIVE_CODE';
    const original = new AggregateError([cause], 'original useful aggregate ' + secret, { cause });
    original.resource = { kind: 'process', label: secret };
    original.publication = { stage: 'prepare', path: secret };
    original.detail = { credential: secret };
    original.detail.self = original.detail;
    const before = serializeFailure(original);
    const diagnostic = serializeFailure(original, new Map(), value => value.replaceAll(secret, '[redacted]'));
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
    assert.deepEqual(serializeFailure(original), before);
    assert.equal(original.cause, cause);
    assert.equal(diagnostic.name, 'AggregateError');
    assert.equal(diagnostic.cause.name, 'TypeError');
    assert.equal(diagnostic.cause.code, 'USEFUL_NATIVE_CODE');
    assert.ok(diagnostic.stack.includes('original useful aggregate [redacted]'));
    assert.deepEqual(diagnostic.errors[0], { type: 'reference', ref: diagnostic.cause.id });
    assert.equal(property(diagnostic.resource, 'kind'), 'process');
    assert.equal(property(diagnostic.resource, 'label'), '[redacted]');
    assert.equal(property(diagnostic.publication, 'stage'), 'prepare');
    assert.equal(property(diagnostic.publication, 'path'), '[redacted]');
    assert.deepEqual(property(property(diagnostic, 'detail'), 'self'), { type: 'reference', ref: property(diagnostic, 'detail').id });
});

for (const marker of ['ready-雪', 'ready-ASCII']) {
    test(`readiness acknowledges actual split pipe bytes for ${marker}`, async t => {
        const input = fixture(t);
        input.marker = marker;
        input.split = marker === 'ready-雪' ? Buffer.byteLength('ready-') + 1 : 3;
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: 'streamed native readiness' });
        const data = await scope.directory('readiness scenario');
        const staged = watchFile(input.stage);
        const emitted = watchFile(input.emitted);
        const cancel = new AbortController();
        const original = new Error('independent release after UTF-8 readiness observation');
        let startup;
        const launching = launchOwnedProcess(scope, { label: 'split native marker', command: command('utf8', input), readyLine: marker, signal: cancel.signal, dependsOn: [data.resourceId] });
        launching.then(value => { startup = { status: 'fulfilled', value }; }, error => { startup = { status: 'rejected', error }; });
        const first = await staged.promise;
        const peer = await run.scope({ kind: 'peer', label: 'independent pipe progress' });
        await peer.directory('real filesystem peer');
        fs.writeFileSync(input.release, 'independent pipe continuation');
        const bytes = await emitted.promise;
        await peer.dispose();
        // An independent execution-bound identity round trip follows the emitted marker.
        const processRecord = run.registry.resources.find(record => record.kind === 'process');
        await requestAuthority(processRecord.locator.controller, 'identify');
        await run.registry.save();
        const beforeCancellation = { startupStatus: startup?.status ?? 'pending', registry: JSON.parse(fs.readFileSync(run.registryPath)), worker: JSON.parse(fs.readFileSync(input.report)), log: fs.readFileSync(processRecord.startupLog.path, 'utf8') };
        if (!startup) cancel.abort(original);
        const result = await settled(launching);
        if (result.status === 'fulfilled') await result.value.stop();
        const summary = await run.finish({ status: result.status === 'fulfilled' ? 'passed' : 'failed' });
        staged.close(); emitted.close();
        t.diagnostic(JSON.stringify({ utf8Readiness: { marker, split: input.split, first, bytes, beforeCancellation, result: { status: result.status, error: result.error && serializeFailure(result.error) }, summary } }));
        await closed(beforeCancellation.worker.port);
        assert.equal(await readProcessIdentity(beforeCancellation.worker.pid), null);
        assert.equal(fs.existsSync(data.path), false);
        assert.equal(bytes.emitted, Buffer.from(marker + '\r\n').toString('hex'));
        assert.ok(beforeCancellation.log.includes(marker));
        assert.equal(beforeCancellation.startupStatus, 'fulfilled', 'valid emitted readiness was not acknowledged before independent cancellation');
        assert.equal(result.status, 'fulfilled');
    });
}

test('normal finish quiesces an actual reset before terminal status and error publication', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const client = net.connect({ ...run.registry.owner.control, allowHalfOpen: true });
    await once(client, 'connect');
    client.write('{"incomplete":');
    await requestAuthority(run.registry.owner, 'identify');
    const clientClosed = new Promise(resolve => client.once('close', resolve));
    let injection;
    let injectionFailure;
    const hook = createHook({ init(id, type) {
        if (injection || injectionFailure) return;
        const stack = new Error('native terminal authority interleaving').stack;
        const finalFsync = type.startsWith('FSREQ') && stack.includes('fsync') && stack.includes('/resources/registry.js:') && JSON.parse(fs.readFileSync(run.registryPath)).status === 'passed';
        const closingSocket = type === 'SHUTDOWNWRAP' && stack.includes('/resources/authority.js:');
        if (!finalFsync && !closingSocket) return;
        try {
            injection = { id, type, stack, snapshot: JSON.parse(fs.readFileSync(run.registryPath)) };
            client.resetAndDestroy();
        } catch (error) { injectionFailure = error; }
    } });
    hook.enable();
    const result = await settled(run.finish({ status: 'passed' }));
    hook.disable();
    if (!client.destroyed) client.end();
    await clientClosed;
    const durable = JSON.parse(fs.readFileSync(run.registryPath));
    t.diagnostic(JSON.stringify({ terminalReset: { injection, injectionFailure: injectionFailure && serializeFailure(injectionFailure), result: result.status === 'fulfilled' ? { status: result.status, summary: { ...result.value, errors: result.value.errors.map(error => serializeFailure(error)) } } : { status: result.status, error: serializeFailure(result.error) }, durable } }));
    if (injectionFailure) throw injectionFailure;
    assert.ok(injection, 'native final fsync/socket shutdown was not observed');
    assert.equal(result.status, 'fulfilled');
    assert.ok(result.value.errors.some(error => error.cause?.code === 'ECONNRESET'), 'actual admitted reset error was not retained');
    assert.equal(result.value.status, 'failed', 'direct finish returned passed after its admitted authority error');
    assert.equal(durable.status, 'failed');
    assert.ok(durable.errors.some(error => error.cause?.code === 'ECONNRESET'));
    await closed(run.registry.owner.control.port);
});

for (const publication of ['intermediate prepare', 'intermediate durability', 'final prepare', 'final durability']) {
    test(`recovery retains original cleanup and ${publication} failure graphs`, async t => {
        const input = fixture(t);
        const owner = await child(t, oldChild, 'owner', input);
        const finished = once(owner.process, 'message');
        owner.process.send({ type: 'finish-with-cleanup-failure' });
        await finished;
        assert.deepEqual(await owner.exited, { code: 0, signal: null });
        const filename = owner.message.registryPath;
        const directory = path.dirname(filename);
        const before = JSON.parse(fs.readFileSync(filename));
        const original = JSON.parse(fs.readFileSync(input.root + '/failed-owner.json'));
        let injection;
        let initialSave;
        const hook = fsyncObserver(receipt => {
            if (injection) return;
            const snapshot = JSON.parse(fs.readFileSync(filename));
            const isFailed = snapshot.recovery?.state === 'failed';
            const initial = !initialSave && snapshot.recovery?.state === 'recovering' && snapshot.writer.executionId !== before.writer.executionId;
            if (initial) initialSave = { ...receipt, snapshot };
            const cleanupRecorded = !initial && initialSave && snapshot.recovery?.state === 'recovering' && snapshot.resources.some(record => record.owner === 'owned' && record.kind === 'directory' && record.state === 'cleanup-failed');
            if (publication === 'intermediate prepare' ? !initial : publication === 'final prepare' || publication === 'intermediate durability' ? !cleanupRecorded : !isFailed) return;
            const descriptor = descriptors().find(item => item.path === directory && /^\d+$/.test(item.fd));
            assert.ok(descriptor);
            const stat = fs.fstatSync(Number(descriptor.fd));
            const expected = fs.statSync(directory);
            assert.equal(stat.dev, expected.dev); assert.equal(stat.ino, expected.ino);
            injection = { ...receipt, descriptor, snapshot, beforeFaultBytes: fs.readFileSync(filename).toString('base64') };
            if (publication.endsWith('prepare')) fs.chmodSync(directory, 0o500);
            else fs.closeSync(Number(descriptor.fd));
        });
        hook.enable();
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        hook.disable();
        const afterBytes = fs.readFileSync(filename);
        const durable = JSON.parse(afterBytes);
        const observed = { before, original, injection, result: serializeFailure(result.error), durable, afterDescriptors: descriptors(), scenario: fs.readFileSync(owner.message.data + '/scenario', 'utf8'), borrowed: inventory(input.borrowed) };
        t.diagnostic(JSON.stringify({ recoveryPublication: { publication, initialSave, ...observed } }));
        fs.chmodSync(directory, 0o700);
        fs.chmodSync(owner.message.data, 0o700);
        const repaired = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        t.diagnostic(JSON.stringify({ repeatedRecovery: { publication, result: repaired.status === 'fulfilled' ? repaired : { status: repaired.status, error: serializeFailure(repaired.error) } } }));
        hook.check();
        assert.ok(injection, 'actual requested recovery publication stage was not observed');
        assert.equal(result.status, 'rejected');
        const nodes = allNodes(serializeFailure(result.error));
        const cleanup = nodes.find(node => node.message?.includes('Cannot recover run') && property(node.resource, 'kind') === 'directory');
        assert.ok(cleanup, 'new recovery cleanup original was lost when persistence failed');
        assert.ok(cleanup.cause.code === 'ENOTEMPTY' || cleanup.cause.code === 'EACCES');
        assert.equal(property(property(cleanup.resource, 'locator'), 'path'), owner.message.data);
        assert.ok(nodes.some(node => node.type === 'error' && node.stack === original.original.stack && node.message === original.original.message), 'prior recorded original was absent from returned recovery graph');
        assert.ok(nodes.some(node => property(node.publication, 'stage') === (publication.endsWith('prepare') ? 'prepare' : 'durability') && property(node.publication, 'published') === !publication.endsWith('prepare')));
        if (publication.endsWith('prepare')) assert.equal(afterBytes.toString('base64'), injection.beforeFaultBytes);
        assert.deepEqual(durable.errors.slice(0, before.errors.length), before.errors);
        assert.equal(observed.scenario, 'original scenario data');
        assert.deepEqual(observed.afterDescriptors.filter(item => item.path.startsWith(input.root + '/')), []);
        assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
        assert.equal(repaired.status, 'fulfilled');
        assert.equal(fs.existsSync(owner.message.data), false);
    });
}

async function heldControllerRecovery(t, releaseMode) {
    const input = fixture(t);
    const owner = await child(t, source, 'owner', input);
    const before = JSON.parse(fs.readFileSync(owner.message.registryPath));
    const record = before.resources.find(record => record.kind === 'process');
    const identity = record.locator.controller;
    const held = net.connect({ ...identity.control, allowHalfOpen: true });
    await once(held, 'connect');
    held.write('{"admitted":');
    const identified = await requestAuthority(identity, 'identify');
    assert.equal(identified.executionId, record.locator.executionId);
    const terminating = watchFile(input.termination);
    owner.process.kill('SIGKILL');
    assert.deepEqual(await owner.exited, { code: null, signal: 'SIGKILL' });
    await terminating.promise;
    assert.deepEqual(await readProcessIdentity(identity.native.pid), identity.native);
    fs.mkdirSync(input.root + '/peer');
    const peer = await createRun(options(input.root + '/peer'));
    const peerScope = await peer.scope({ kind: 'peer', label: 'independent controller release' });
    let recovery;
    let released;
    const heldClosed = new Promise(resolve => held.once('close', resolve));
    const releaseHeld = new Promise((resolve, reject) => held.once('end', () => {
        (async () => {
            const directory = await peerScope.directory('actual independent I/O');
            await peerScope.dispose();
            const snapshot = JSON.parse(fs.readFileSync(owner.message.registryPath));
            released = { recoveryStatus: recovery?.status ?? 'pending', dataExists: fs.existsSync(owner.message.data), process: snapshot.resources.find(record => record.kind === 'process'), native: await readProcessIdentity(identity.native.pid), descriptors: descriptors(identity.native.pid), peerDataRemoved: !fs.existsSync(directory.path) };
            if (releaseMode === 'reset') held.resetAndDestroy();
            else held.end();
            resolve();
        })().catch(reject);
    }));
    const removing = [];
    const hook = fsyncObserver(receipt => {
        const snapshot = JSON.parse(fs.readFileSync(owner.message.registryPath));
        const processRecord = snapshot.resources.find(record => record.kind === 'process');
        if (processRecord.state !== 'disposed' || !fs.existsSync(owner.message.data)) return;
        let native;
        try { native = execFileSync('/bin/ps', ['-p', String(identity.native.pid), '-o', 'pid=', '-o', 'stat='], { encoding: 'utf8' }).trim(); }
        catch (error) { if (error.status !== 1 || error.stdout !== '') throw error; native = null; }
        const actors = [identity.native.pid, owner.message.pid].map(pid => {
            const command = ['lsof', '-nP', '-a', '-p', String(pid), '-Ffn'];
            try { return { pid, command, exit: 0, output: execFileSync(command[0], command.slice(1), { encoding: 'utf8' }) }; }
            catch (error) {
                if (error.status !== 1 || error.stdout !== '' || error.stderr !== '') throw error;
                return { pid, command, exit: 1, output: error.stdout, stderr: error.stderr };
            }
        });
        removing.push({ ...receipt, native, actors, snapshot });
    });
    hook.enable();
    const recovering = settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    recovering.then(result => { recovery = result; });
    let inFlightStop;
    while (!inFlightStop && !recovery) {
        await readProcessIdentity(identity.native.pid);
        const connections = descriptors(identity.native.pid).filter(item => item.path.startsWith(`127.0.0.1:${identity.control.port}->`));
        if (connections.length < 2) continue;
        await requestAuthority(identity, 'identify');
        const admitted = descriptors(identity.native.pid).filter(item => item.path.startsWith(`127.0.0.1:${identity.control.port}->`));
        if (admitted.length >= 2) inFlightStop = admitted;
    }
    fs.writeFileSync(input.release, 'actual independent worker release');
    const result = await recovering;
    await releaseHeld;
    await heldClosed;
    hook.disable();
    await peer.finish({ status: 'passed' });
    if (releaseMode === 'reset') while (sameProcessIdentity(await readProcessIdentity(identity.native.pid), identity.native)) { /* Join actual outer-fixture actor termination after the failed release. */ }
    const actual = await readProcessIdentity(identity.native.pid);
    const durable = JSON.parse(fs.readFileSync(owner.message.registryPath));
    t.diagnostic(JSON.stringify({ joinedControllerRecovery: { releaseMode, before, identified, inFlightStop, released, beforeDependentMutation: removing, result: result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) }, actual, durable } }));
    hook.check();
    assert.ok(inFlightStop, 'held-live controller stop connection was not established');
    assert.equal(released.recoveryStatus, 'pending');
    assert.equal(released.dataExists, true, 'dependent data was deleted while the exact controller remained held alive');
    assert.notEqual(released.process.state, 'disposed', 'worker exit was promoted to controller disposal before listener release');
    assert.ok(sameProcessIdentity(released.native, identity.native));
    assert.equal(actual, null);
    await closed(identity.control.port);
    await closed(owner.message.worker.port);
    if (releaseMode === 'graceful') {
        assert.equal(result.status, 'fulfilled');
        assert.ok(removing.length > 0);
        assert.ok(removing.every(receipt => receipt.native === null), 'controller remained native-live before dependent directory mutation');
        assert.ok(removing.every(receipt => receipt.actors.every(actor => actor.exit === 1 && actor.output === '')), 'owned worker/controller descriptors remained before dependent directory mutation');
        assert.equal(fs.existsSync(owner.message.data), false);
        assert.equal(durable.recovery.state, 'recovered');
    } else {
        assert.equal(result.status, 'rejected');
        assert.ok(allNodes(serializeFailure(result.error)).some(error => error.type === 'error' && error.code === 'ECONNRESET'), 'controller shutdown reset original was absent from the rejected recovery graph');
        assert.equal(durable.recovery.state, 'failed');
        assert.equal(durable.resources.find(record => record.kind === 'process').state, 'cleanup-failed');
        assert.equal(fs.readFileSync(owner.message.data + '/scenario', 'utf8'), 'original scenario data');
        assert.deepEqual(removing, []);
        const repaired = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        assert.deepEqual(repaired.recovered, [owner.message.registryPath.split('/').at(-2)]);
        assert.equal(fs.existsSync(owner.message.data), false);
        t.diagnostic(JSON.stringify({ controllerShutdownRepeat: { repaired, durable: JSON.parse(fs.readFileSync(owner.message.registryPath)) } }));
    }
}

for (const releaseMode of ['graceful', 'reset']) {
    test(releaseMode === 'graceful' ? 'recovery joins a held live controller and listener before dependent data disposal' : 'recovery retains dependent data and shutdown originals after a held connection resets', t => heldControllerRecovery(t, releaseMode));
}

test('unconfirmed controller loss remains an actionable recovery refusal', async t => {
    const input = fixture(t);
    const record = { resourceId: randomUUID(), runId: randomUUID(), locator: { controller: null, worker: { pid: process.pid } } };
    await assert.rejects(recoverOwnedProcess(record, null), /worker without a published controller/);
    assert.deepEqual(fs.readdirSync(input.projectRoot), []);
});

test('recovered process stop does not return while its native controller is held alive', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'recovered stop receipt' });
    const lease = await launchOwnedProcess(scope, { label: 'actual controlled service', command: command('capture', { ...input, marker: 'resource-ready' }), readyLine: 'resource-ready' });
    const record = run.registry.resources.find(record => record.kind === 'process');
    const identity = structuredClone(record.locator.controller);
    const held = net.connect({ ...identity.control, allowHalfOpen: true });
    await once(held, 'connect');
    held.write('{"admitted":');
    await requestAuthority(identity, 'identify');
    let result;
    let observed;
    const heldClosed = new Promise(resolve => held.once('close', resolve));
    const release = new Promise((resolve, reject) => held.once('end', () => {
        (async () => {
            await (await run.scope({ kind: 'peer', label: 'independent stop observer' })).directory('independent stop observation');
            observed = { recoveryStatus: result?.status ?? 'pending', native: await readProcessIdentity(identity.native.pid), descriptors: descriptors(identity.native.pid) };
            held.end();
            resolve();
        })().catch(reject);
    }));
    const recovering = settled(recoverOwnedProcess(structuredClone(record), run.registry));
    recovering.then(value => { result = value; });
    const returned = await recovering;
    const nativeAtReturn = await readProcessIdentity(identity.native.pid);
    await release;
    await heldClosed;
    await lease.stop();
    await run.finish({ status: 'failed' });
    t.diagnostic(JSON.stringify({ recoveredStopJoin: { originalOwnerStillObservesThisLowerLevelControl: true, identity, observed, returned: returned.status === 'fulfilled' ? returned : { status: returned.status, error: serializeFailure(returned.error) }, nativeAtReturn } }));
    assert.equal(returned.status, 'fulfilled');
    assert.equal(observed.recoveryStatus, 'pending', 'recovered stop returned before actual controller/listener release');
    assert.ok(sameProcessIdentity(observed.native, identity.native));
    assert.equal(nativeAtReturn, null);
    await closed(identity.control.port);
});

test('authority closure joins an admitted handler after its client has reset', async t => {
    const input = fixture(t);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const errors = [];
    const authority = await Authority.open({ runId: randomUUID(), executionId: randomUUID() }, { onError: error => errors.push(error), handle: async () => { entered.resolve(); await release.promise; throw new Error('original admitted handler failure after reset'); } });
    const client = net.connect(authority.identity.control);
    await once(client, 'connect');
    client.write(JSON.stringify({ runId: authority.identity.runId, executionId: authority.identity.executionId, nonce: randomUUID(), action: 'held' }) + '\n');
    await entered.promise;
    client.resetAndDestroy();
    let closure;
    const closing = settled(authority.close());
    closing.then(value => { closure = value; });
    const peer = await createRun(options(input.projectRoot));
    await peer.finish({ status: 'passed' });
    const beforeRelease = { closureStatus: closure?.status ?? 'pending', errors: errors.map(error => serializeFailure(error)) };
    release.resolve();
    const result = await closing;
    t.diagnostic(JSON.stringify({ admittedHandlerClosure: { beforeRelease, result: result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) }, errors: errors.map(error => serializeFailure(error)) } }));
    assert.equal(beforeRelease.closureStatus, 'pending', 'authority closed before its admitted handler settled');
    assert.ok(errors.some(error => error.message === 'original admitted handler failure after reset'));
    await closed(authority.identity.control.port);
});

test('recovery quiesces its reset error producer before publishing recovered state', async t => {
    const input = fixture(t);
    const owner = await child(t, oldChild, 'owner', input);
    owner.process.kill('SIGKILL');
    await owner.exited;
    const filename = owner.message.registryPath;
    let client;
    let clientClosed;
    let connected;
    let injection;
    let injectionFailure;
    const hook = createHook({ init(id, type) {
        if (injectionFailure) return;
        const stack = new Error('actual recovery authority lifetime').stack;
        const fsync = type.startsWith('FSREQ') && stack.includes('fsync') && stack.includes('/resources/registry.js:');
        try {
            const snapshot = fsync ? JSON.parse(fs.readFileSync(filename)) : null;
            if (fsync && !client && snapshot.recovery?.state === 'recovering') {
                client = net.connect({ ...snapshot.writer.control, allowHalfOpen: true });
                clientClosed = new Promise(resolve => client.once('close', resolve));
                connected = once(client, 'connect').then(async () => { client.write('{"incomplete":'); await requestAuthority(snapshot.writer, 'identify'); });
                Promise.allSettled([connected]);
            }
            const closingSocket = client && type === 'SHUTDOWNWRAP' && stack.includes('/resources/authority.js:');
            if (client && !injection && (snapshot?.recovery?.state === 'recovered' || closingSocket)) {
                injection = { id, type, stack, snapshot: JSON.parse(fs.readFileSync(filename)) };
                client.resetAndDestroy();
            }
        } catch (error) { injectionFailure = error; }
    } });
    hook.enable();
    const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    hook.disable();
    if (client && !client.destroyed) client.end();
    if (clientClosed) await clientClosed;
    const connection = connected && await settled(connected);
    const durable = JSON.parse(fs.readFileSync(filename));
    t.diagnostic(JSON.stringify({ recoveryReset: { injection, injectionFailure: injectionFailure && serializeFailure(injectionFailure), connection: connection?.status === 'rejected' ? serializeFailure(connection.error) : connection, result: result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) }, durable } }));
    if (injectionFailure) throw injectionFailure;
    assert.ok(injection);
    assert.equal(connection.status, 'fulfilled');
    assert.equal(result.status, 'rejected');
    assert.ok(allNodes(serializeFailure(result.error)).some(error => error.type === 'error' && error.code === 'ECONNRESET'));
    assert.equal(durable.recovery.state, 'failed', 'recovery published complete metadata before its authority reset arrived');
    assert.equal(durable.status, 'failed');
    assert.ok(durable.errors.some(error => error.cause?.code === 'ECONNRESET'));
});

test('post-listener admission rollback joins admitted socket errors with publication failure', async t => {
    const input = fixture(t);
    let client;
    let clientClosed;
    let connection;
    let injection;
    let reset;
    const hook = createHook({ init(id, type) {
        const stack = new Error('actual admission rollback lifetime').stack;
        if (!type.startsWith('FSREQ') || !stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        const runs = input.projectRoot + '/test-results/harness/runs';
        const names = fs.readdirSync(runs);
        if (names.length !== 1) return;
        const filename = runs + '/' + names[0] + '/registry.json';
        const snapshot = JSON.parse(fs.readFileSync(filename));
        if (snapshot.admission !== 'ready') return;
        if (!client) {
            client = net.connect({ ...snapshot.owner.control, allowHalfOpen: true });
            clientClosed = new Promise(resolve => client.once('close', resolve));
            connection = once(client, 'connect').then(async () => { client.write('{"incomplete":'); await requestAuthority(snapshot.owner, 'identify'); });
            Promise.allSettled([connection]);
        } else if (!injection && snapshot.scopes.length > 0) {
            const descriptor = descriptors().find(item => item.path === path.dirname(filename) && /^\d+$/.test(item.fd));
            assert.ok(descriptor);
            injection = { id, type, stack, snapshot, descriptor, filename };
            fs.closeSync(Number(descriptor.fd));
            client.resetAndDestroy(); reset = true;
        }
    } });
    hook.enable();
    const result = await settled(createRun(options(input.projectRoot)));
    hook.disable();
    if (result.status === 'fulfilled') await result.value.finish({ status: 'passed' });
    if (client && !client.destroyed) client.end();
    if (clientClosed) await clientClosed;
    const connected = connection && await settled(connection);
    t.diagnostic(JSON.stringify({ admissionRollback: { injection, reset, connected: connected?.status === 'rejected' ? serializeFailure(connected.error) : connected, result: result.status === 'rejected' ? serializeFailure(result.error) : 'unexpected admitted run' } }));
    assert.ok(injection);
    assert.equal(result.status, 'rejected');
    const nodes = allNodes(serializeFailure(result.error));
    assert.ok(nodes.some(error => property(error.publication, 'stage') === 'durability' && property(error.publication, 'published')));
    assert.ok(nodes.some(error => error.cause?.code === 'ECONNRESET'), 'post-listener rollback lost an admitted authority reset');
    assert.deepEqual(descriptors().filter(item => item.path.startsWith(input.root + '/')), []);
});

test('terminal publication failure retains body cleanup and admitted reset originals together', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'combined terminal errors' });
    const data = await scope.directory('read-only actual cleanup');
    fs.writeFileSync(data.path + '/scenario', 'retained permission fixture');
    fs.chmodSync(data.path, 0o500);
    const original = new Error('original body before terminal producer closure');
    const client = net.connect({ ...run.registry.owner.control, allowHalfOpen: true });
    await once(client, 'connect'); client.write('{"incomplete":');
    await requestAuthority(run.registry.owner, 'identify');
    const clientClosed = new Promise(resolve => client.once('close', resolve));
    let reset;
    let publication;
    let injectionFailure;
    const hook = createHook({ init(id, type) {
        if (injectionFailure) return;
        const stack = new Error('combined native terminal errors').stack;
        try {
            const fsync = type.startsWith('FSREQ') && stack.includes('fsync') && stack.includes('/resources/registry.js:');
            const snapshot = fsync ? JSON.parse(fs.readFileSync(run.registryPath)) : null;
            const final = snapshot?.scopes[0].state === 'disposed';
            const closingSocket = type === 'SHUTDOWNWRAP' && stack.includes('/resources/authority.js:');
            if (!reset && (final || closingSocket)) { reset = { id, type, stack }; client.resetAndDestroy(); }
            if (final && !publication) {
                const descriptor = descriptors().find(item => item.path === path.dirname(run.registryPath) && /^\d+$/.test(item.fd));
                assert.ok(descriptor);
                publication = { id, type, stack, descriptor, snapshot };
                fs.closeSync(Number(descriptor.fd));
            }
        } catch (error) { injectionFailure = error; }
    } });
    hook.enable();
    const result = await settled(run.finish({ status: 'failed', error: original }));
    hook.disable();
    if (!client.destroyed) client.end();
    await clientClosed;
    const durable = JSON.parse(fs.readFileSync(run.registryPath));
    const beforeRestoration = inventory(input.root);
    fs.chmodSync(data.path, 0o700);
    t.diagnostic(JSON.stringify({ combinedTerminalErrors: { reset, publication, beforeRestoration, error: serializeFailure(result.error), durable } }));
    if (injectionFailure) throw injectionFailure;
    assert.ok(reset); assert.ok(publication);
    assert.equal(result.status, 'rejected');
    const nodes = allNodes(serializeFailure(result.error));
    assert.ok(nodes.some(error => error.stack === original.stack && error.message === original.message));
    assert.ok(nodes.some(error => property(error.resource, 'resourceId') === data.resourceId && ['ENOTEMPTY', 'EACCES'].includes(error.cause?.code)));
    assert.ok(nodes.some(error => error.cause?.code === 'ECONNRESET'));
    assert.ok(nodes.some(error => property(error.publication, 'stage') === 'durability' && property(error.publication, 'published')));
    assert.equal(durable.status, 'failed');
    assert.ok(durable.errors.some(error => error.cause?.code === 'ECONNRESET'), 'late reset original was absent from the published failed snapshot');
});

test('fragmented process output is redacted before diagnostic IPC transport', async t => {
    const input = fixture(t);
    const secret = 'generated-first-雪\ngenerated-last-' + randomUUID();
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'fixture', label: 'raw diagnostic IPC observation' });
    const transport = await registeredTerminal(run, scope);
    const { terminal } = transport;
    const controllerSource = fileURLToPath(new URL('../resources/process-controller.js', import.meta.url));
    const actual = spawn(process.execPath, [controllerSource], { stdio: ['ignore', 'pipe', 'pipe', 'ipc', transport.descriptor] });
    transport.close();
    const messages = [];
    let controllerOutput = '';
    for (const stream of [actual.stdout, actual.stderr]) stream.on('data', bytes => { controllerOutput += bytes; });
    const exited = new Promise((resolve, reject) => { actual.once('error', reject); actual.once('close', (code, signal) => resolve({ code, signal })); });
    actual.on('message', message => messages.push(message));
    const configured = once(actual, 'message');
    actual.send({ type: 'configure', terminal, runId: run.runId, scopeId: scope.scopeId, resourceId: transport.resourceId, ownerExecutionId: run.registry.owner.executionId, executionId: randomUUID(), options: { command: [process.execPath, oldChild, 'split-secret', JSON.stringify(input)], readyLine: 'resource-ready', env: { RESOURCE_FIXTURE_SECRET: secret }, stopSignal: 'SIGTERM' } });
    const [controller] = await configured;
    actual.send({ type: 'start' });
    // This fixture's stage is plain text; observe its actual file creation independently.
    if (!fs.existsSync(input.stage)) {
        const watcher = fs.watch(input.root);
        try { while (!fs.existsSync(input.stage)) await once(watcher, 'change'); }
        finally { watcher.close(); }
    }
    await requestAuthority(controller.identity, 'identify');
    const ready = new Promise(resolve => actual.on('message', message => { if (message.type === 'ready') resolve(); }));
    fs.writeFileSync(input.release, 'independent fragmented output release');
    await ready;
    actual.send({ type: 'stop' });
    const result = await exited;
    const output = messages.filter(message => message.type === 'output').map(message => Buffer.from(message.data, 'base64').toString('utf8')).join('');
    const terminalBytes = fs.readFileSync(terminal.path, 'utf8');
    const terminalReceipt = JSON.parse(terminalBytes);
    const completion = fs.lstatSync(terminal.completion);
    t.diagnostic(JSON.stringify({ outputDiagnosticIPC: { messages, output, controllerOutput, terminal, terminalReceipt, completion: { dev: completion.dev, ino: completion.ino }, secretSHA256: sha(secret), result } }));
    await run.finish({ status: 'passed' });
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(controllerOutput, '');
    assert.equal(terminalReceipt.format, 'process-terminal-v2');
    assert.equal(terminalReceipt.complete, true);
    assert.equal(terminalReceipt.executionId, controller.identity.executionId);
    assert.deepEqual(terminalReceipt.controller, controller.identity);
    assert.equal(terminalReceipt.status, 'stopped');
    assert.equal(terminalReceipt.error, null); assert.equal(terminalReceipt.workerFailure, null);
    assert.equal(completion.dev, terminal.dev); assert.equal(completion.ino, terminal.ino);
    assert.equal(output.includes('generated-first-雪'), false, 'partial declared value entered diagnostic IPC');
    assert.equal(output.includes('generated-last-'), false);
    assert.ok(output.includes('[redacted]'));
    assert.equal(terminalBytes.includes('generated-first-雪'), false);
    assert.equal(terminalBytes.includes('generated-last-'), false);
    await closed(JSON.parse(fs.readFileSync(input.report)).port);
});

test('shared release handlers quiesce without joining their own in-flight replies', async t => {
    const input = fixture(t);
    const requests = new Set();
    const entered = Promise.withResolvers();
    const start = Promise.withResolvers();
    const cancel = Promise.withResolvers();
    const originals = [];
    const receipts = [];
    const original = new Error('independent cancellation of a cyclic release transaction');
    const authority = await Authority.open({ runId: randomUUID(), executionId: randomUUID() }, { onError: error => originals.push(error), handle: async request => {
        requests.add(request);
        if (requests.size === 2) entered.resolve();
        await start.promise;
        const receipt = {};
        receipts.push(receipt);
        const quiescing = settled(authority.quiesce(requests));
        quiescing.then(result => { receipt.status = result.status; });
        const result = await Promise.race([quiescing, cancel.promise]);
        if (result.status === 'cancelled') throw original;
        if (result.status === 'rejected') throw result.error;
        return { released: true };
    } });
    const clients = [settled(requestAuthority(authority.identity, 'release')), settled(requestAuthority(authority.identity, 'release'))];
    await entered.promise;
    start.resolve();
    const peer = await createRun(options(input.projectRoot));
    await peer.finish({ status: 'passed' });
    const beforeIndependentCancellation = structuredClone(receipts);
    const cancellationUsed = receipts.some(receipt => receipt.status !== 'fulfilled');
    if (cancellationUsed) cancel.resolve({ status: 'cancelled' });
    const returned = await Promise.all(clients);
    await authority.close();
    t.diagnostic(JSON.stringify({ sharedReleaseHandlers: { beforeIndependentCancellation, cancellationUsed, returned: returned.map(result => result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) }), originals: originals.map(error => serializeFailure(error)) } }));
    assert.equal(cancellationUsed, false, 'release handlers waited on their own admitted replies until independent cancellation');
    assert.ok(returned.every(result => result.status === 'fulfilled' && result.value.released === true));
    await closed(authority.identity.control.port);
});

test('concurrent execution-bound stop replies join normal controller shutdown', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'concurrent release transaction' });
    const data = await scope.directory('scenario held until joined stop');
    fs.writeFileSync(data.path + '/scenario', 'scenario survives joined stop');
    const lease = await launchOwnedProcess(scope, { label: 'concurrent native controller', command: command('held-service', input), readyLine: 'resource-ready', dependsOn: [data.resourceId] });
    const record = run.registry.resources.find(record => record.kind === 'process');
    const identity = record.locator.controller;
    const terminating = watchFile(input.termination);
    const replies = [settled(requestAuthority(identity, 'stop')), settled(requestAuthority(identity, 'stop'))];
    await terminating.promise;
    await requestAuthority(identity, 'identify');
    const admitted = descriptors(identity.native.pid).filter(item => item.path.startsWith(`127.0.0.1:${identity.control.port}->`));
    const stopping = lease.stop();
    fs.writeFileSync(input.release, 'independent actual concurrent worker release');
    const returned = await Promise.all(replies);
    await stopping;
    const stopped = JSON.parse(fs.readFileSync(run.registryPath));
    const retained = fs.readFileSync(data.path + '/scenario', 'utf8');
    const summary = await run.finish({ status: 'passed' });
    t.diagnostic(JSON.stringify({ concurrentControllerRelease: { identity, admitted, returned: returned.map(result => result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) }), stopped, retained, summary } }));
    assert.ok(admitted.length >= 2, 'actual concurrent stop sockets were not admitted');
    for (const reply of returned) {
        assert.equal(reply.status, 'fulfilled');
        assert.equal(reply.value.released, true);
        assert.equal(reply.value.executionId, lease.executionId);
        assert.deepEqual(reply.value.worker.exit, { code: 0, signal: null });
    }
    assert.equal(retained, 'scenario survives joined stop');
    assert.equal(summary.status, 'passed');
    assert.equal(fs.existsSync(data.path), false);
    assert.equal(await readProcessIdentity(identity.native.pid), null);
    assert.equal(await readProcessIdentity(lease.pid), null);
    await closed(identity.control.port);
    await closed(JSON.parse(fs.readFileSync(input.report)).port);
});
