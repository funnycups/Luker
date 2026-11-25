import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { recoverRuns } from '../resources/recovery.js';
import { readProcessIdentity } from '../resources/native-identity.js';
import { failureFingerprint, receiveFailureGraph, serializeFailure, validateFailureGraph } from '../resources/errors.js';
import { property } from './failure-graph.mjs';
import { processDiagnostics } from '../resources/process-diagnostics.js';
import { outcomeFixture, repository, nodes, settled, sha } from './process-native-control.mjs';

const childSource = new URL('./resource-acknowledgement-child.mjs', import.meta.url).pathname;
const diagnostic = result => result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) };
const decode = bytes => JSON.parse(Buffer.from(bytes, 'base64'));

async function owner(t, input) {
    const environment = { RESOURCE_ACK_INPUT: JSON.stringify(input), RESOURCE_ACK_CHANNEL: input.root + '/channel-admitted.json', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./resource-acknowledgement-preload.mjs', import.meta.url).href}` };
    const argv = [process.execPath, ...(input.entrance === 'framework' ? ['--test'] : []), childSource];
    const childEnvironment = { ...process.env, ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const actual = spawn(argv[0], argv.slice(1), { cwd: repository + '/tests', env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const events = [];
    const waiters = [];
    let output = '';
    let pending = '';
    const receive = message => {
        assert.equal(path.dirname(message.receipt), input.root);
        const receipt = JSON.parse(fs.readFileSync(message.receipt));
        events.push(receipt);
        for (const waiter of [...waiters]) if (waiter.type === receipt.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(receipt); }
    };
    actual.stdout.on('data', bytes => {
        output += bytes; pending += bytes;
        while (pending.includes('\n')) {
            const end = pending.indexOf('\n');
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            const marker = line.indexOf('ACK_PROOF ');
            if (marker !== -1) receive(JSON.parse(line.slice(marker + 'ACK_PROOF '.length)));
        }
    });
    actual.stderr.on('data', bytes => { output += bytes; });
    const exited = new Promise((resolve, reject) => {
        actual.once('error', reject);
        actual.once('close', (code, signal) => {
            t.diagnostic(JSON.stringify({ acknowledgementOwner: { argv, cwd: repository + '/tests', environment, sourceSHA256: sha(fs.readFileSync(childSource)), events, output, code, signal } }));
            resolve({ code, signal });
        });
    });
    const next = type => {
        const existing = events.find(event => event.type === type);
        if (existing) return Promise.resolve(existing);
        return Promise.race([new Promise(resolve => waiters.push({ type, resolve })), exited.then(result => { throw new Error(`Native acknowledgement owner ended before ${type}: ${JSON.stringify(result)}: ${output}`); })]);
    };
    const runtime = await next('runtime');
    assert.equal(runtime.runtime.version, process.version); assert.equal(runtime.runtime.execPath, process.execPath);
    return { process: actual, next, exited };
}

function retained(snapshot, original) {
    return snapshot.errors.some(graph => nodes(receiveFailureGraph(graph)).some(node => node.type === 'error' && failureFingerprint(node) === failureFingerprint(receiveFailureGraph(original))));
}

function assertTransaction(t, terminal, snapshots) {
    const native = nodes(terminal.terminal.error).find(node => node.type === 'error' && node.code === 'EPIPE');
    assert.ok(native, 'real failed IPC write original was absent');
    assert.match(native.stack, /child_process|write/);
    assert.equal(terminal.admission.connected, true); assert.equal(terminal.admission.ownerDisconnected, true);
    assert.deepEqual(terminal.controllerExit, { code: 1, signal: null });
    assert.equal(terminal.events.some(event => event.message?.type === 'failure'), false, 'terminal-only control unexpectedly delivered its failure through IPC');
    const published = decode(terminal.workerPublished);
    assert.deepEqual(published.resources.find(record => record.kind === 'process').locator.worker.exit, terminal.workerExit);
    assert.equal(published.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
    for (const [index, event] of terminal.terminal.errorEvents.entries()) assert.equal(event.fingerprint, failureFingerprint(receiveFailureGraph(terminal.terminal.error).errors[index]));
    const acknowledged = snapshots.filter(item => item.snapshot.resources.some(record => record.kind === 'process' && record.terminal.acknowledged !== null));
    assert.ok(acknowledged.length, 'no actual acknowledgement-bearing registry publication was observed');
    t.diagnostic(JSON.stringify({ acknowledgementTransaction: { terminal, firstAcknowledged: acknowledged[0], snapshots } }));
    for (const publication of acknowledged) {
        assert.equal(sha(Buffer.from(publication.bytes, 'base64')), publication.sha256);
        assert.equal(publication.snapshot.resources.find(record => record.kind === 'process').terminal.acknowledged, terminal.digest);
        for (const graph of publication.snapshot.errors) validateFailureGraph(graph);
        for (const original of terminal.terminal.error.errors) assert.equal(retained(publication.snapshot, original), true, 'acknowledgement-bearing bytes omitted an exact complete terminal original');
        assert.equal(publication.snapshot.errors.some(error => error.stack === terminal.original.stack && error.cause.stack === terminal.original.cause.stack), true, 'intermediate publication lost the pre-existing test original');
    }
    return acknowledged[0];
}

async function absentActors(t, terminal) {
    const record = decode(terminal.workerPublished).resources.find(record => record.kind === 'process');
    for (const identity of [record.locator.controller.native, record.locator.worker.native]) {
        assert.equal(await readProcessIdentity(identity.pid), null);
        const result = spawnSync('lsof', ['-nP', '-a', '-p', String(identity.pid), '-Ffn'], { encoding: 'utf8' });
        t.diagnostic(JSON.stringify({ acknowledgementActorEnded: { identity, exit: result.status, stdout: result.stdout, stderr: result.stderr } }));
        assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    }
}

for (const entrance of ['direct', 'scope', 'run']) {
    test(`${entrance} stop retains terminal-only originals in the first queued acknowledgement publication`, async t => {
        const input = { ...outcomeFixture(t), entrance, cleanupFault: true };
        const child = await owner(t, input);
        const terminal = await child.next('terminal');
        const intermediate = await child.next('intermediate');
        child.process.send({ type: 'finish' });
        const complete = await child.next('complete');
        assert.deepEqual(await child.exited, { code: 1, signal: null });
        const final = decode(complete.beforeRestoration.bytes);
        t.diagnostic(JSON.stringify({ normalAcknowledgement: { entrance, intermediate, complete } }));
        assert.equal(intermediate.result.status, 'rejected');
        assertTransaction(t, terminal, intermediate.snapshots);
        assert.equal(intermediate.originalIdentity, true);
        assert.equal(complete.summary.originalIdentity, true); assert.equal(complete.summary.originalOccurrences, 1);
        assert.equal(complete.originalUnchanged, true);
        assert.equal(intermediate.retainedData, 'original acknowledgement scenario');
        assert.ok(nodes(final.errors).some(node => node.type === 'error' && node.code === 'ENOTEMPTY' && node.stack.includes('rmSync') && node.message.includes(terminal.neighbor)));
        fs.chmodSync(terminal.neighbor, 0o700);
        await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        const recovered = JSON.parse(fs.readFileSync(terminal.registryPath));
        assert.deepEqual(recovered.errors, final.errors);
        assert.equal(fs.existsSync(terminal.data), false);
        await absentActors(t, terminal);
    });
}

test('native framework disposal publishes terminal originals before final finish', async t => {
    const input = { ...outcomeFixture(t), entrance: 'framework', cleanupFault: true };
    const child = await owner(t, input);
    const complete = await child.next('complete');
    assert.deepEqual(await child.exited, { code: 1, signal: null });
    assertTransaction(t, complete.beforeConsumption, complete.snapshots);
    fs.chmodSync(complete.beforeConsumption.neighbor, 0o700);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
});

for (const finalFault of ['interrupted', 'prepare', 'durability']) {
    test(`normal-owner ${finalFault} final publication recovers the original acknowledgement-bearing bytes`, async t => {
        const input = { ...outcomeFixture(t), entrance: 'scope', finalFault, cleanupFault: true };
        const child = await owner(t, input);
        const terminal = await child.next('terminal');
        const intermediate = await child.next('intermediate');
        const before = fs.readFileSync(terminal.registryPath);
        let complete;
        if (finalFault === 'interrupted') {
            child.process.kill('SIGKILL');
            assert.deepEqual(await child.exited, { code: null, signal: 'SIGKILL' });
        } else {
            child.process.send({ type: 'finish' });
            complete = await child.next('complete');
            assert.deepEqual(await child.exited, { code: 1, signal: null });
        }
        const readable = fs.readFileSync(terminal.registryPath);
        const after = JSON.parse(readable);
        const preRestoration = { bytes: readable.toString('base64'), data: fs.readFileSync(terminal.data + '/scenario', 'utf8'), directoryMode: fs.statSync(path.dirname(terminal.registryPath)).mode };
        if (finalFault === 'prepare') fs.chmodSync(path.dirname(terminal.registryPath), 0o700);
        const failedRecovery = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        const failed = JSON.parse(fs.readFileSync(terminal.registryPath));
        fs.chmodSync(terminal.neighbor, 0o700);
        const retry = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        const recovered = JSON.parse(fs.readFileSync(terminal.registryPath));
        t.diagnostic(JSON.stringify({ interruptedAcknowledgement: { finalFault, intermediate, complete, preRestoration, after, failedRecovery: diagnostic(failedRecovery), failed, retry, recovered } }));
        assertTransaction(t, terminal, intermediate.snapshots);
        if (finalFault !== 'durability') assert.deepEqual(readable, before, 'pre-publication failure changed the previous readable registry');
        else {
            assert.notDeepEqual(readable, before);
            assert.ok(complete.durabilityFault);
            assert.ok(nodes(complete.result.error).some(node => node.type === 'error' && node.code === 'EBADF'));
        }
        if (complete) {
            assert.equal(complete.result.status, 'rejected');
            assert.ok(nodes(complete.result.error).some(node => node.type === 'error' && property(node.publication, 'stage') === finalFault && property(node.publication, 'published') === (finalFault === 'durability')));
            for (const original of terminal.terminal.error.errors) assert.equal(retained({ errors: complete.authoritativeErrors }, original), true);
            assert.ok(nodes(complete.result.error).some(node => node.type === 'error' && node.stack === terminal.original.stack && node.cause.stack === terminal.original.cause.stack));
            assert.ok(nodes(complete.result.error).some(node => node.type === 'error' && node.code === 'ENOTEMPTY' && node.message.includes(terminal.neighbor)));
        }
        assert.equal(failedRecovery.status, 'rejected');
        assert.deepEqual(failed.errors.slice(0, after.errors.length), after.errors);
        assert.deepEqual(recovered.errors, failed.errors);
        assert.equal(fs.existsSync(terminal.data), false);
        assert.deepEqual(retry.recovered, [after.runId]);
        await absentActors(t, terminal);
    });
}

test('ended-owner terminal consumption retains originals with acknowledgement before safe retry', async t => {
    const input = { ...outcomeFixture(t), entrance: 'direct', endedOwner: true };
    const child = await owner(t, input);
    const terminal = await child.next('terminal');
    child.process.kill('SIGKILL'); await child.exited;
    const first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const failedBytes = fs.readFileSync(terminal.registryPath);
    const failed = JSON.parse(failedBytes);
    const second = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    const recovered = JSON.parse(fs.readFileSync(terminal.registryPath));
    t.diagnostic(JSON.stringify({ endedOwnerAcknowledgement: { terminal, first: diagnostic(first), failed, second, recovered } }));
    assert.equal(first.status, 'rejected');
    for (const original of terminal.terminal.error.errors) assert.equal(retained(failed, original), true);
    assert.deepEqual(recovered.errors, failed.errors);
    assert.equal(fs.existsSync(terminal.data), false);
});

for (const ackFault of ['prepare', 'durability']) {
    test(`failed acknowledgement ${ackFault} publication retains the actual readable original state for recovery`, async t => {
        const input = { ...outcomeFixture(t), entrance: 'direct', ackFault };
        const child = await owner(t, input);
        const terminal = await child.next('terminal');
        const intermediate = await child.next('intermediate');
        const before = fs.readFileSync(terminal.registryPath);
        child.process.kill('SIGKILL'); await child.exited;
        const readable = JSON.parse(before);
        const retainedData = fs.readFileSync(terminal.data + '/scenario', 'utf8');
        if (ackFault === 'prepare') fs.chmodSync(path.dirname(terminal.registryPath), 0o700);
        const first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        const recorded = JSON.parse(fs.readFileSync(terminal.registryPath));
        const afterFirstData = fs.existsSync(terminal.data);
        const retry = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        const recovered = JSON.parse(fs.readFileSync(terminal.registryPath));
        t.diagnostic(JSON.stringify({ failedAcknowledgementPublication: { ackFault, terminal, intermediate, readable, retainedData, first: diagnostic(first), recorded, afterFirstData, retry, recovered } }));
        assert.equal(intermediate.acknowledgementFault.stage, ackFault);
        assert.ok(intermediate.queuedResults.some(result => result.status === 'rejected' && nodes(result.error).some(node => property(node.publication, 'stage') === ackFault && property(node.publication, 'published') === (ackFault === 'durability'))));
        assert.equal(readable.errors.some(error => error.stack === terminal.original.stack), true);
        assert.equal(retainedData, 'original acknowledgement scenario');
        assert.deepEqual(recorded.errors.slice(0, readable.errors.length), readable.errors);
        for (const original of terminal.terminal.error.errors) assert.equal(retained(recorded, original), true);
        if (ackFault === 'prepare') {
            assert.equal(readable.resources.find(record => record.kind === 'process').terminal.acknowledged, null);
            assert.equal(first.status, 'rejected'); assert.equal(afterFirstData, true);
            assert.deepEqual(before, Buffer.from(intermediate.acknowledgementFault.bytes, 'base64'));
        } else {
            assertTransaction(t, terminal, intermediate.snapshots);
            assert.equal(first.status, 'fulfilled'); assert.equal(afterFirstData, false);
            assert.equal(readable.resources.find(record => record.kind === 'process').terminal.acknowledged, terminal.digest);
            assert.deepEqual(before, Buffer.from(intermediate.acknowledgementFault.bytes, 'base64'));
        }
        assert.deepEqual(recovered.errors, recorded.errors);
        assert.equal(fs.existsSync(terminal.data), false);
        await absentActors(t, terminal);
    });
}

test('acknowledged retry refuses missing persisted originals until exact recorded bytes return', async t => {
    const input = { ...outcomeFixture(t), entrance: 'scope' };
    const child = await owner(t, input);
    const terminal = await child.next('terminal');
    await child.next('intermediate');
    child.process.kill('SIGKILL'); await child.exited;
    const original = fs.readFileSync(terminal.registryPath);
    const damaged = JSON.parse(original);
    damaged.errors = [damaged.errors.find(error => error.stack === terminal.original.stack)].filter(Boolean);
    fs.writeFileSync(terminal.registryPath, JSON.stringify(damaged) + '\n');
    const refused = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const refusal = JSON.parse(fs.readFileSync(terminal.registryPath));
    const retainedData = fs.existsSync(terminal.data);
    t.diagnostic(JSON.stringify({ missingAcknowledgedOriginal: { terminal, original: JSON.parse(original), damaged, refused: diagnostic(refused), refusal, retainedData } }));
    fs.writeFileSync(terminal.registryPath, original);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.equal(refused.status, 'rejected', 'digest equality bypassed absent persisted originals');
    assert.equal(retainedData, true);
    assert.match(refused.error.message, /retained|original|acknowledg/);
});

test('an earlier native failure cannot substitute for a distinct acknowledged event with identical content', async t => {
    const priorInput = { ...outcomeFixture(t), entrance: 'direct' };
    const earlier = await owner(t, priorInput);
    const priorTerminal = await earlier.next('terminal');
    const priorIntermediate = await earlier.next('intermediate');
    earlier.process.kill('SIGKILL'); await earlier.exited;
    await recoverRuns({ projectRoot: priorInput.projectRoot, profiles: ['unit'] });
    const priorFailure = decode(priorIntermediate.bytes).errors.find(error => error.cause?.code === 'EPIPE');
    const input = { ...outcomeFixture(t), entrance: 'direct' };
    const child = await owner(t, { ...input, priorFailure });
    const terminal = await child.next('terminal');
    const intermediate = await child.next('intermediate');
    child.process.kill('SIGKILL'); await child.exited;
    const original = fs.readFileSync(terminal.registryPath);
    const damaged = JSON.parse(original);
    const priorEvent = priorTerminal.terminal.errorEvents.find((event, index) => priorTerminal.terminal.error.errors[index].code === 'EPIPE');
    const currentEvent = terminal.terminal.errorEvents.find((event, index) => terminal.terminal.error.errors[index].code === 'EPIPE');
    const removedIndex = damaged.errors.findIndex(error => error.cause?.code === 'EPIPE' && error.message.includes(terminal.terminal.resourceId));
    const [removed] = damaged.errors.splice(removedIndex, 1);
    fs.writeFileSync(terminal.registryPath, JSON.stringify(damaged) + '\n');
    const first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const refused = JSON.parse(fs.readFileSync(terminal.registryPath));
    const retainedData = fs.existsSync(terminal.data);
    fs.writeFileSync(terminal.registryPath, original);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    t.diagnostic(JSON.stringify({ distinctAcknowledgedEvents: { priorTerminal, priorIntermediate, terminal, intermediate, priorEvent, currentEvent, removed, damaged, first: diagnostic(first), refused, retainedData, recovered: JSON.parse(fs.readFileSync(terminal.registryPath)) } }));
    assert.notEqual(priorEvent.id, currentEvent.id);
    assert.equal(priorEvent.fingerprint, currentEvent.fingerprint);
    assert.ok(removedIndex >= 0);
    assert.ok(damaged.errors.some(error => error.cause?.cause?.code === 'EPIPE'));
    assert.equal(first.status, 'rejected', 'another event with identical content authorized the missing acknowledged original');
    assert.equal(retainedData, true);
    assert.deepEqual(refused.errors.slice(0, damaged.errors.length), damaged.errors);
});

for (const channel of ['healthy', 'observed']) {
    test(`${channel} channel control retains normal-stop data and observed event identity`, async t => {
        const input = { ...outcomeFixture(t), entrance: 'direct', channel };
        const child = await owner(t, input);
        const terminal = await child.next('terminal');
        const intermediate = await child.next('intermediate');
        child.process.send({ type: 'finish' });
        const complete = await child.next('complete');
        assert.deepEqual(await child.exited, { code: channel === 'healthy' ? 0 : 1, signal: null });
        t.diagnostic(JSON.stringify({ acknowledgedSiblingControl: { channel, terminal, intermediate, complete } }));
        assert.equal(intermediate.retainedData, 'original acknowledgement scenario');
        assert.equal(intermediate.result.status, channel === 'healthy' ? 'fulfilled' : 'rejected');
        if (channel === 'healthy') {
            assert.equal(terminal.terminal.error, null);
            assert.equal(decode(intermediate.bytes).resources.find(record => record.kind === 'process').terminal.acknowledged, null);
            assert.equal(fs.existsSync(terminal.data), false);
        } else {
            const received = terminal.events.filter(event => event.message?.type === 'failure');
            assert.ok(received.length);
            for (const event of terminal.terminal.errorEvents) assert.ok(received.some(item => item.message.eventId === event.id));
            for (const original of terminal.terminal.error.errors) assert.equal(retained(decode(intermediate.bytes), original), true);
            await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        }
    });
}

test('caller event lookalikes retain redacted payload without received-event authority', () => {
    const original = new Error('ordinary caller event payload');
    original.event = { id: 'caller identity', fingerprint: 'caller fingerprint' };
    const before = serializeFailure(original);
    const graph = processDiagnostics({ sensitiveValues: ['caller', 'event', 'id', 'fingerprint'] }).failure(original);
    validateFailureGraph(graph);
    const received = receiveFailureGraph(graph);
    assert.equal(graph.event, undefined);
    assert.equal(received.event, undefined);
    assert.equal(graph.properties[0].name, '[redacted]');
    assert.deepEqual(graph.properties[0].value.properties, [{ name: '[redacted]', value: '[redacted] [redacted]entity' }, { name: '[redacted]', value: '[redacted] [redacted]' }]);
    assert.deepEqual(serializeFailure(original), before);
});

for (const change of ['later declarations', 'terminal marker overlap']) {
    test(`canonical redaction: ${change} preserves terminal-only acknowledgement and ended-owner retry`, async t => {
        const input = { ...outcomeFixture(t), entrance: 'direct', ...(change === 'later declarations' ? { afterDeclarations: ['write', 'acknowledgement'] } : { terminalSensitive: ['write', 'redacted'] }) };
        const child = await owner(t, input);
        const terminal = await child.next('terminal');
        const intermediate = await child.next('intermediate');
        child.process.kill('SIGKILL');
        assert.deepEqual(await child.exited, { code: null, signal: 'SIGKILL' });
        const published = decode(intermediate.bytes);
        const refusals = [];
        for (const damage of ['content', 'provenance', 'caller lookalike', 'redaction policy']) {
            const damaged = structuredClone(published);
            const target = nodes(damaged.errors).find(node => node.type === 'error' && node.event && node.cause?.code === 'EPIPE');
            assert.ok(target, 'the actual retained EPIPE event is absent');
            if (damage === 'content') target.cause.code = 'CHANGED_RETAINED_CONTENT';
            else if (damage === 'provenance') delete target.event;
            else if (damage === 'redaction policy') delete damaged.redaction;
            else {
                const binding = target.event;
                delete target.event;
                (target.properties ??= []).push({ name: 'event', value: serializeFailure(binding) });
            }
            fs.writeFileSync(terminal.registryPath, JSON.stringify(damaged) + '\n');
            const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
            const snapshot = JSON.parse(fs.readFileSync(terminal.registryPath));
            const dataRetained = fs.existsSync(terminal.data);
            refusals.push({ damage, damaged, result: diagnostic(result), snapshot, dataRetained });
            fs.writeFileSync(terminal.registryPath, Buffer.from(intermediate.bytes, 'base64'));
            assert.equal(result.status, 'rejected', `${damage} authorized a missing or changed complete original`);
            assert.equal(dataRetained, true);
            assert.deepEqual(snapshot.errors.slice(0, damaged.errors.length), damaged.errors);
        }
        const first = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        const recovered = JSON.parse(fs.readFileSync(terminal.registryPath));
        const retainedData = fs.existsSync(terminal.data);
        t.diagnostic(JSON.stringify({ canonicalAcknowledgement: { change, terminal, intermediate, published, refusals, first: diagnostic(first), recovered, retainedData } }));
        await absentActors(t, terminal);
        assert.equal(first.status, 'fulfilled', 'run-wide/repeated redaction invalidated a complete retained native event');
        assert.equal(retainedData, false);
        assert.deepEqual(first.value.recovered, [published.runId]);
        assert.deepEqual(recovered.errors, published.errors);
        assert.equal(intermediate.originalIdentity, true);
        assert.equal(terminal.events.some(event => event.message?.type === 'failure'), false);
        const acknowledged = intermediate.snapshots.filter(item => item.snapshot.resources.some(record => record.kind === 'process' && record.terminal.acknowledged !== null));
        assert.ok(acknowledged.length);
        assert.equal(acknowledged[0].snapshot.status, 'running');
        assert.equal(acknowledged[0].snapshot.errors.some(error => error.stack === terminal.original.stack), true);
        const retained = nodes(published.errors).filter(node => node.type === 'error' && node.event);
        for (const event of terminal.terminal.errorEvents) assert.ok(retained.some(node => node.event.id === event.id && node.event.fingerprint === event.fingerprint && node.cause));
    });
}
