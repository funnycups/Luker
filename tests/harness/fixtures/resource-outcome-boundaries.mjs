import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { recoverRuns } from '../resources/recovery.js';
import { serializeFailure, validateFailureGraph, receiveFailureGraph } from '../resources/errors.js';
import { processDiagnostics } from '../resources/process-diagnostics.js';
import { createRun } from '../resources/run.js';
import { readProcessIdentity, sameProcessIdentity } from '../resources/native-identity.js';
import { requestAuthority } from '../resources/authority.js';
import { property } from './failure-graph.mjs';
import { controllerSource, outcomeFixture, nativeOutcomeChild, nodes, settled, sha, vocabulary, registeredTerminal } from './process-native-control.mjs';

for (const mode of ['asynchronous missing executable', 'synchronous native argument rejection']) {
    test(`process diagnostic IPC redacts declared values after ${mode}`, async t => {
        const input = outcomeFixture(t);
        const secret = 'generated-native-credential-' + randomUUID();
        const run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'registered-native-error-consumer', command: [process.execPath, '--test', 'harness/resource-recovery.test.mjs'] });
        const scope = await run.scope({ kind: 'fixture', label: 'complete raw native-error IPC' });
        const transport = await registeredTerminal(run, scope);
        const actual = spawn(process.execPath, [controllerSource], { stdio: ['ignore', 'pipe', 'pipe', 'ipc', transport.descriptor] });
        transport.close();
        const messages = [];
        let output = '';
        actual.on('message', message => messages.push(message));
        for (const stream of [actual.stdout, actual.stderr]) stream.on('data', bytes => { output += bytes; });
        const exited = new Promise((resolve, reject) => { actual.once('error', reject); actual.once('close', (code, signal) => resolve({ code, signal })); });
        const configured = once(actual, 'message');
        const configuration = { type: 'configure', terminal: transport.terminal, runId: run.runId, scopeId: scope.scopeId, resourceId: transport.resourceId, ownerExecutionId: run.registry.owner.executionId, executionId: randomUUID(), options: { command: mode.startsWith('asynchronous') ? [input.root + '/missing', secret] : [process.execPath, secret + '\0invalid'], readyLine: 'resource-ready', sensitiveValues: [secret, ...vocabulary], stopSignal: 'SIGTERM' } };
        actual.send(configuration);
        const [controller] = await configured;
        const failed = once(actual, 'message');
        actual.send({ type: 'start' });
        await failed;
        if (actual.connected) actual.send({ type: 'stop' });
        const result = await exited;
        const failure = messages.find(message => message.type === 'failure');
        const terminalBytes = fs.readFileSync(transport.terminal.path);
        const receipt = JSON.parse(terminalBytes);
        const completion = fs.lstatSync(transport.terminal.completion);
        const nativeGraph = receiveFailureGraph(failure.error);
        const wrapper = new Error('wrapped received native diagnostic', { cause: nativeGraph });
        wrapper.alias = nativeGraph;
        const joined = new AggregateError([wrapper, new Error('received terminal context', { cause: receiveFailureGraph(receipt.workerFailure) })], 'joined received graph scopes', { cause: wrapper });
        const joinedGraph = processDiagnostics({ sensitiveValues: vocabulary }).failure(joined);
        validateFailureGraph(joinedGraph);
        assert.equal(Object.isFrozen(nativeGraph), true);
        assert.equal(Object.isFrozen(nativeGraph.properties), true);
        assert.equal(joinedGraph.errors[0].type, 'reference');
        assert.equal(joinedGraph.errors[0].ref, joinedGraph.cause.id);
        run.recordError(wrapper);
        await run.finish({ status: 'failed' });
        const durable = JSON.parse(fs.readFileSync(run.registryPath));
        t.diagnostic(JSON.stringify({ nativeDiagnosticIPC: { mode, secretSHA256: sha(secret), messages, output, terminal: transport.terminal, receipt, completion: { dev: completion.dev, ino: completion.ino }, durable, ...result } }));
        assert.ok(failure, 'actual native error IPC was absent');
        assert.equal(failure.error.name, mode.startsWith('asynchronous') ? 'Error' : 'TypeError');
        assert.equal(failure.error.code, mode.startsWith('asynchronous') ? 'ENOENT' : 'ERR_INVALID_ARG_VALUE');
        assert.ok(failure.error.stack.includes('spawn'));
        assert.equal(JSON.stringify(messages).includes(secret), false, 'declared credential leaked through structured native failure IPC');
        assert.deepEqual(result, { code: 0, signal: null }, 'native-error consumer failed unrelated controller shutdown');
        assert.equal(output, '');
        assert.equal(receipt.format, 'process-terminal-v2');
        assert.equal(receipt.complete, true);
        assert.equal(receipt.executionId, configuration.executionId);
        assert.deepEqual(receipt.controller, controller.identity);
        assert.equal(receipt.status, 'stopped'); assert.equal(receipt.error, null);
        assert.deepEqual(receipt.errorEvents, []);
        assert.equal(receipt.workerEvents[0].id, failure.eventId);
        assert.equal(completion.dev, transport.terminal.dev); assert.equal(completion.ino, transport.terminal.ino);
        assert.ok(nodes(receipt.workerFailure).some(node => node.type === 'error' && node.stack === failure.error.stack && node.code === failure.error.code));
        assert.ok(nodes(durable.errors).some(node => node.type === 'error' && node.stack === failure.error.stack && node.code === failure.error.code));
        assert.equal(terminalBytes.includes(secret), false);
    });
}

for (const declarations of [false, true]) {
    test(`native primary failure ${declarations ? 'preserves transported schema vocabulary' : 'retains its original without cancellation'}`, async t => {
        const input = outcomeFixture(t);
        const child = await nativeOutcomeChild(t, 'startup', { ...input, vocabulary: declarations });
        const receipt = await child.next('complete');
        assert.deepEqual(await child.exited, { code: 1, signal: null });
        assert.equal(receipt.result.status, 'rejected');
        assert.equal(receipt.result.error.code, 'ENOENT');
        assert.equal(receipt.originalUnchanged, true);
        assert.equal(receipt.summary.originalIdentity, true);
        const native = nodes(receipt.durable.errors).find(node => node.type === 'error' && node.code === 'ENOENT');
        assert.ok(native, 'IPC-to-registry serialization lost the native Error schema');
        assert.ok(native.stack.includes('spawn'));
        if (declarations) {
            const transported = receipt.events.find(event => event.message?.type === 'failure').message.error;
            assert.ok(nodes(receipt.durable.errors).some(node => node.type === 'error' && node.stack === transported.stack && node.code === 'ENOENT'), 'transported native fields were reclassified as caller payload');
            assert.ok(nodes(receipt.result.error).some(node => node.type === 'error' && node.stack === transported.stack && node.code === 'ENOENT'));
            for (const graph of receipt.durable.errors) validateFailureGraph(graph);
        }
        assert.equal(receipt.terminal.workerFailure.type, 'error');
        assert.ok(nodes(receipt.terminal.workerFailure).some(node => node.code === 'ENOENT'));
        assert.equal(fs.existsSync(receipt.data), false);
    });
}

for (const ready of [false, true]) {
    test(`cancellation after admitted start retains ${ready ? 'the reason during normal worker cleanup' : 'the later actual native failure before acknowledgement'}`, async t => {
        const input = outcomeFixture(t);
        const child = await nativeOutcomeChild(t, 'startup', { ...input, cancel: true, ready });
        const receipt = await child.next('complete');
        assert.deepEqual(await child.exited, { code: 1, signal: null });
        assert.equal(receipt.result.status, 'rejected');
        assert.ok(receipt.events.some(event => event.event === 'start-admitted'));
        assert.equal(receipt.result.retainsCancellation, true);
        assert.equal(receipt.summary.cancellationIdentity, true);
        if (!ready) {
            const arrival = receipt.events.findIndex(event => event.message?.type === 'failure');
            assert.ok(arrival > receipt.events.findIndex(event => event.event === 'cancel'));
            assert.equal(receipt.events[arrival].message.error.code, 'ENOENT');
            assert.ok(nodes(receipt.terminal.workerFailure).some(node => node.code === 'ENOENT'));
            assert.ok(nodes(receipt.result.error).some(node => node.type === 'error' && node.code === 'ENOENT'), 'cancellation suppressed a distinct later native original');
            assert.ok(nodes(receipt.summary.errors).some(node => node.type === 'error' && node.code === 'ENOENT'));
            assert.ok(nodes(receipt.durable.errors).some(node => node.type === 'error' && node.code === 'ENOENT'));
            assert.match(receipt.durable.resources.find(record => record.kind === 'process').terminal.acknowledged, /^[a-f0-9]{64}$/);
        } else assert.equal(receipt.terminal.workerFailure, null);
        assert.equal(fs.existsSync(receipt.data), false);
    });
}

test('recovery wrappers preserve validated prior native graphs and their reference scopes', async t => {
    const input = outcomeFixture(t);
    const child = await nativeOutcomeChild(t, 'startup', { ...input, vocabulary: true, retainData: true });
    const receipt = await child.next('complete');
    assert.deepEqual(await child.exited, { code: 1, signal: null });
    const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const after = JSON.parse(fs.readFileSync(receipt.registryPath));
    t.diagnostic(JSON.stringify({ priorGraphRecovery: { receipt, result: result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) }, after } }));
    assert.equal(result.status, 'rejected');
    const graph = serializeFailure(result.error);
    validateFailureGraph(graph);
    assert.ok(nodes(graph).some(node => node.type === 'error' && node.code === 'ENOENT'), 'recovery converted the previous native graph to ordinary payload');
    assert.deepEqual(after.errors.slice(0, receipt.durable.errors.length), receipt.durable.errors);
    fs.chmodSync(receipt.data, 0o700);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(fs.existsSync(receipt.data), false);
});

test('controller publication failure before start retains its own original without inventing a worker failure', async t => {
    const input = outcomeFixture(t);
    const child = await nativeOutcomeChild(t, 'startup', { ...input, publicationPrimary: true });
    const receipt = await child.next('complete');
    assert.deepEqual(await child.exited, { code: 1, signal: null });
    assert.ok(receipt.publicationPrimary);
    assert.equal(receipt.result.status, 'rejected');
    assert.ok(nodes(receipt.result.error).some(node => node.type === 'error' && node.code === 'EBADF'));
    assert.ok(nodes(receipt.result.error).some(node => property(node.publication, 'stage') === 'durability'));
    assert.equal(receipt.events.some(event => event.message?.type === 'failure'), false);
    assert.equal(receipt.terminal.workerFailure, null);
    assert.deepEqual(receipt.terminal.worker, { allocation: 'never-started' });
    assert.equal(receipt.durable.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
    assert.equal(fs.readFileSync(receipt.data + '/scenario', 'utf8'), 'original outcome scenario');
});

test('caller graph lookalikes remain redacted ordered payload with cyclic aliases', () => {
    const lookalike = { type: 'error', id: 731, ref: 731, name: 'name', code: 'code', message: 'type error' };
    lookalike.self = lookalike;
    const original = new Error('ordinary local wrapper', { cause: lookalike });
    original.alias = lookalike;
    const before = serializeFailure(original);
    const graph = processDiagnostics({ sensitiveValues: vocabulary }).failure(original);
    validateFailureGraph(graph);
    assert.equal(graph.cause.type, 'object');
    assert.equal(graph.cause.properties[0].name, '[redacted]');
    assert.equal(graph.cause.properties[0].value, '[redacted]');
    assert.ok(nodes(graph).some(node => node.type === 'reference' && node.ref === graph.cause.id));
    assert.deepEqual(serializeFailure(original), before);
});

async function absentNative(t, ready) {
    const record = ready.snapshot.resources.find(record => record.kind === 'process');
    for (const identity of [record.locator.controller.native, record.locator.worker.native]) {
        assert.equal(await readProcessIdentity(identity.pid), null);
        const result = spawnSync('lsof', ['-nP', '-a', '-p', String(identity.pid), '-Ffn'], { encoding: 'utf8' });
        t.diagnostic(JSON.stringify({ outcomeActorEnded: { identity, exit: result.status, stdout: result.stdout, stderr: result.stderr } }));
        assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    }
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = net.connect(record.locator.controller.control);
        socket.once('error', reject); socket.once('connect', () => { socket.end(); resolve(); });
    }), { code: 'ECONNREFUSED' });
}

async function fileCreated(filename) {
    const watcher = fs.watch(path.dirname(filename));
    try { while (!fs.existsSync(filename)) await once(watcher, 'change'); }
    finally { watcher.close(); }
    return JSON.parse(fs.readFileSync(filename));
}

for (const stage of ['prepare', 'durability', 'close', 'completion']) {
    for (const endedOwner of [false, true]) {
        test(`${endedOwner ? 'ended-owner recovery' : 'normal owner'} retains data after actual terminal ${stage} failure`, async t => {
            const input = outcomeFixture(t);
            const child = await nativeOutcomeChild(t, 'publication', { ...input, publication: stage });
            const ready = await child.next('ready');
            const record = ready.snapshot.resources.find(record => record.kind === 'process');
            let result;
            let after;
            let receipt;
            if (endedOwner) {
                child.process.kill('SIGKILL');
                assert.deepEqual(await child.exited, { code: null, signal: 'SIGKILL' });
                while (sameProcessIdentity(await readProcessIdentity(record.locator.controller.native.pid), record.locator.controller.native)) { /* Await this exact controller's native end. */ }
                const beforeRestoration = { registry: JSON.parse(fs.readFileSync(ready.registryPath)), directoryMode: fs.statSync(path.dirname(ready.registryPath)).mode, data: fs.readFileSync(ready.data + '/scenario', 'utf8'), publication: JSON.parse(fs.readFileSync(record.terminal.publication.path)) };
                if (stage === 'completion') fs.chmodSync(path.dirname(ready.registryPath), 0o700);
                result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
                after = JSON.parse(fs.readFileSync(ready.registryPath));
                receipt = { beforeRestoration, result: { status: result.status, error: serializeFailure(result.error) } };
            } else {
                child.process.send({ type: 'stop' });
                receipt = await child.next('complete');
                assert.deepEqual(await child.exited, { code: 1, signal: null });
                result = receipt.result;
                after = receipt.durable;
            }
            const fault = JSON.parse(fs.readFileSync(input.root + '/publication-fault.json'));
            const publication = JSON.parse(fs.readFileSync(record.terminal.publication.path));
            const beforeRetry = fs.readFileSync(ready.data + '/scenario', 'utf8');
            const retry = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
            const repeated = JSON.parse(fs.readFileSync(ready.registryPath));
            t.diagnostic(JSON.stringify({ nativeTerminalPublicationFault: { stage, endedOwner, ready, fault, receipt, after, publication, beforeRetry, retry: { status: retry.status, error: serializeFailure(retry.error) }, repeated } }));
            assert.equal(fault.completionExists, false);
            assert.equal(fault.runtime.version, process.version); assert.equal(fault.runtime.execPath, process.execPath);
            assert.equal(result.status, 'rejected');
            assert.equal(retry.status, 'rejected', 'an incomplete publication became an acknowledged successful retry');
            assert.equal(fs.existsSync(record.terminal.completion), false);
            assert.equal(beforeRetry, 'original outcome scenario');
            assert.equal(fs.readFileSync(ready.data + '/scenario', 'utf8'), 'original outcome scenario');
            assert.equal(after.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
            assert.equal(repeated.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
            const all = nodes(endedOwner ? serializeFailure(result.error) : result.error);
            assert.ok(all.some(node => node.type === 'error' && node.code === (stage === 'completion' ? 'EACCES' : 'EBADF')), 'surviving observer lost the real terminal publication original');
            assert.ok(nodes(publication.publicationFailure).some(node => property(node.publication, 'stage') === stage));
            if (stage !== 'prepare') {
                const staged = JSON.parse(Buffer.from(fault.stagedBytes, 'base64'));
                assert.equal(staged.complete, true); assert.equal(staged.status, 'stopped'); assert.equal(staged.error, null);
            }
            await absentNative(t, ready);
        });
    }
}

test('native terminal durability failure retains an earlier native startup original', async t => {
    const input = outcomeFixture(t);
    const child = await nativeOutcomeChild(t, 'startup', { ...input, publication: 'durability', vocabulary: true });
    const receipt = await child.next('complete');
    assert.deepEqual(await child.exited, { code: 1, signal: null });
    assert.equal(receipt.result.status, 'rejected');
    for (const code of ['ENOENT', 'EBADF']) {
        assert.ok(nodes(receipt.result.error).some(node => node.type === 'error' && node.code === code));
        assert.ok(nodes(receipt.durable.errors).some(node => node.type === 'error' && node.code === code));
    }
    assert.equal(receipt.retainedData, 'original outcome scenario');
    assert.equal(receipt.durable.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
});

test('readable staged success cannot authorize recovery while native durability is held', async t => {
    const input = outcomeFixture(t);
    const child = await nativeOutcomeChild(t, 'publication', { ...input, publication: 'hold' });
    const ready = await child.next('ready');
    const record = ready.snapshot.resources.find(record => record.kind === 'process');
    const faultReady = fileCreated(input.root + '/publication-fault.json');
    child.process.kill('SIGKILL');
    assert.deepEqual(await child.exited, { code: null, signal: 'SIGKILL' });
    const fault = await faultReady;
    let state;
    do { state = execFileSync('ps', ['-o', 'stat=', '-p', String(fault.pid)], { encoding: 'utf8' }).trim(); } while (!state.includes('T'));
    let first;
    let beforeResume;
    try {
        assert.ok(sameProcessIdentity(await readProcessIdentity(fault.pid), record.locator.controller.native));
        first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        beforeResume = { first: { status: first.status, error: serializeFailure(first.error) }, state, registry: JSON.parse(fs.readFileSync(ready.registryPath)), data: fs.readFileSync(ready.data + '/scenario', 'utf8'), completionExists: fs.existsSync(record.terminal.completion) };
    } finally { process.kill(fault.pid, 'SIGCONT'); }
    while (sameProcessIdentity(await readProcessIdentity(fault.pid), record.locator.controller.native)) { /* Observe the exact completed native execution. */ }
    const recovered = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    const complete = JSON.parse(fs.readFileSync(record.terminal.path));
    t.diagnostic(JSON.stringify({ heldNativeTerminalDurability: { fault, beforeResume, recovered, complete, final: JSON.parse(fs.readFileSync(ready.registryPath)) } }));
    assert.equal(JSON.parse(Buffer.from(fault.stagedBytes, 'base64')).complete, true);
    assert.equal(beforeResume.first.status, 'rejected'); assert.equal(beforeResume.completionExists, false);
    assert.equal(beforeResume.data, 'original outcome scenario');
    assert.equal(beforeResume.registry.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
    assert.deepEqual(recovered.recovered, [ready.snapshot.runId]);
    assert.equal(fs.existsSync(record.terminal.completion), true);
    assert.equal(complete.status, 'stopped'); assert.equal(complete.error, null);
    assert.equal(fs.existsSync(ready.data), false);
    await absentNative(t, ready);
});

test('missing or replaced completion links cannot authorize recovery of readable success bytes', async t => {
    const input = outcomeFixture(t);
    const child = await nativeOutcomeChild(t, 'publication', input);
    const ready = await child.next('ready');
    const record = ready.snapshot.resources.find(record => record.kind === 'process');
    child.process.kill('SIGKILL'); await child.exited;
    while (sameProcessIdentity(await readProcessIdentity(record.locator.controller.native.pid), record.locator.controller.native)) { /* Observe the original native end. */ }
    const original = fs.readFileSync(record.terminal.path);
    const completion = record.terminal.completion;
    fs.unlinkSync(completion);
    const missing = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const refused = JSON.parse(fs.readFileSync(ready.registryPath));
    fs.writeFileSync(completion, original, { flag: 'wx' });
    const replaced = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const changed = JSON.parse(fs.readFileSync(ready.registryPath));
    t.diagnostic(JSON.stringify({ missingOrChangedCompletion: { missing: { status: missing.status, error: serializeFailure(missing.error) }, replaced: { status: replaced.status, error: serializeFailure(replaced.error) }, refused, changed, data: fs.readFileSync(ready.data + '/scenario', 'utf8') } }));
    assert.equal(missing.status, 'rejected'); assert.equal(replaced.status, 'rejected');
    assert.equal(refused.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
    assert.equal(changed.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
    fs.unlinkSync(completion); fs.linkSync(record.terminal.path, completion);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(fs.existsSync(ready.data), false);
});

test('changed acknowledged failure bytes reject until the exact recorded receipt is restored', async t => {
    const input = outcomeFixture(t);
    const child = await nativeOutcomeChild(t, 'publication', input);
    const ready = await child.next('ready');
    const record = ready.snapshot.resources.find(record => record.kind === 'process');
    const control = await settled(requestAuthority(record.locator.controller, 'unknown-outcome-action'));
    while (sameProcessIdentity(await readProcessIdentity(record.locator.controller.native.pid), record.locator.controller.native)) { /* Await complete failed shutdown, not its preliminary response. */ }
    child.process.kill('SIGKILL'); await child.exited;
    const original = fs.readFileSync(record.terminal.path);
    const first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const acknowledged = JSON.parse(fs.readFileSync(ready.registryPath));
    fs.appendFileSync(record.terminal.path, '\n');
    const changed = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const refused = JSON.parse(fs.readFileSync(ready.registryPath));
    t.diagnostic(JSON.stringify({ changedFailureAcknowledgement: { control: { status: control.status, error: serializeFailure(control.error) }, first: { status: first.status, error: serializeFailure(first.error) }, acknowledged, changed: { status: changed.status, error: serializeFailure(changed.error) }, refused, data: fs.readFileSync(ready.data + '/scenario', 'utf8') } }));
    assert.equal(control.status, 'rejected'); assert.equal(first.status, 'rejected'); assert.equal(changed.status, 'rejected');
    const digest = acknowledged.resources.find(record => record.kind === 'process').terminal.acknowledged;
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(refused.resources.find(record => record.kind === 'process').terminal.acknowledged, digest);
    assert.deepEqual(refused.errors.slice(0, acknowledged.errors.length), acknowledged.errors);
    fs.writeFileSync(record.terminal.path, original);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(fs.existsSync(ready.data), false);
});
