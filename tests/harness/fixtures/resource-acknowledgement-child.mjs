import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRun } from '../resources/run.js';
import { launchOwnedProcess } from '../resources/process-owner.js';
import { serializeFailure, receiveFailureGraph } from '../resources/errors.js';
import { observeNativeStartup, settled, nodes, inventory } from './process-native-control.mjs';

const input = JSON.parse(process.env.RESOURCE_ACK_INPUT);
const runtime = { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') };
const options = { projectRoot: input.projectRoot, profile: 'unit', source: 'normal-owner-acknowledgement', command: [process.execPath, ...process.argv.slice(1)] };
const evidence = result => result.status === 'fulfilled' ? { status: result.status } : { status: result.status, error: serializeFailure(result.error) };
let sequence = 0;
const emit = async value => {
    const receipt = path.join(input.root, `acknowledgement-${process.pid}-${++sequence}.json`);
    fs.writeFileSync(receipt, JSON.stringify(value), { flag: 'wx' });
    const line = 'ACK_PROOF ' + JSON.stringify({ receipt }) + '\n';
    assert.equal(fs.writeSync(process.stdout.fd, line), Buffer.byteLength(line));
};
await emit({ type: 'runtime', runtime });

async function scenario(scope, run) {
    let stageSequence = 0;
    const stage = value => fs.writeFileSync(path.join(input.root, `control-stage-${++stageSequence}.json`), JSON.stringify(value), { flag: 'wx' });
    await scope.borrowDirectory(input.borrowed);
    const data = await scope.directory('acknowledgement dependent data');
    fs.writeFileSync(data.path + '/scenario', 'original acknowledgement scenario');
    const neighbor = await scope.directory('distinct native cleanup failure');
    fs.writeFileSync(neighbor.path + '/original', 'original neighboring cleanup data');
    const original = new Error('pre-existing test original', { cause: new TypeError('pre-existing test cause') });
    run.recordError(original);
    run.recordError(original);
    if (input.priorFailure) run.recordError(new Error('unrelated earlier controller failure', { cause: receiveFailureGraph(input.priorFailure) }));
    const observer = observeNativeStartup();
    const lease = await launchOwnedProcess(scope, { label: 'acknowledgement native worker', command: [process.execPath, new URL('./resource-boundary-child.mjs', import.meta.url).pathname, 'capture', JSON.stringify({ ...input, marker: 'resource-ready' })], readyLine: 'resource-ready', dependsOn: [data.resourceId], sensitiveValues: input.terminalSensitive });
    const record = run.registry.resources.find(record => record.resourceId === lease.resourceId);
    const controllerEnded = once(observer.controller, 'close');
    observer.controller.once('exit', (code, signal) => stage({ event: 'native-controller-exit', code, signal }));
    const queued = [];
    let controllerClosing = false;
    observer.controller.prependOnceListener('close', () => {
        controllerClosing = true;
        queued.push(settled(run.registry.save()), settled(run.registry.save()));
    });
    const snapshots = [];
    let durabilityFault;
    let acknowledgementFault;
    const hook = createHook({ init(id, type) {
        if (!type.startsWith('FSREQ')) return;
        const stack = new Error('actual registry publication observer').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        const bytes = fs.readFileSync(run.registryPath);
        const snapshot = JSON.parse(bytes);
        snapshots.push({ id, type, stack, bytes: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), snapshot });
        const acknowledged = snapshot.resources.find(record => record.resourceId === lease.resourceId).terminal.acknowledged;
        if (input.ackFault === 'prepare' && !acknowledgementFault && controllerClosing && acknowledged === null) {
            acknowledgementFault = { id, type, stack, stage: 'prepare', bytes: bytes.toString('base64') };
            fs.chmodSync(path.dirname(run.registryPath), 0o500);
            return;
        }
        const acknowledgementDurability = input.ackFault === 'durability' && !acknowledgementFault && acknowledged !== null;
        const finalDurability = input.finalFault === 'durability' && !durabilityFault && snapshot.status !== 'running';
        if (!acknowledgementDurability && !finalDurability) return;
        const descriptors = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
        let descriptor;
        let fd;
        for (const line of descriptors.split('\n')) {
            if (line.startsWith('f')) fd = Number.parseInt(line.slice(1));
            if (line === 'n' + path.dirname(run.registryPath)) descriptor = fd;
        }
        assert.ok(Number.isSafeInteger(descriptor));
        const stat = fs.fstatSync(descriptor);
        assert.equal(stat.isDirectory(), true);
        assert.equal(stat.dev, snapshot.boundaries.at(-1).dev); assert.equal(stat.ino, snapshot.boundaries.at(-1).ino);
        const fault = { id, type, stack, descriptor, dev: stat.dev, ino: stat.ino, descriptors, bytes: bytes.toString('base64') };
        if (acknowledgementDurability) acknowledgementFault = { ...fault, stage: 'durability' };
        else durabilityFault = fault;
        fs.closeSync(descriptor);
    } });
    hook.enable();
    process.kill(lease.pid, 'SIGTERM');
    const workerExit = await lease.exited;
    const workerPublished = fs.readFileSync(run.registryPath);
    stage({ event: 'worker-exit-published', workerExit, workerPublished: workerPublished.toString('base64') });
    assert.deepEqual(JSON.parse(workerPublished).resources.find(record => record.resourceId === lease.resourceId).locator.worker.exit, workerExit);
    let admission;
    if (input.channel !== 'healthy') {
        const watcher = fs.watch(input.root);
        try {
            observer.controller.send({ type: 'acknowledgement-channel-probe' });
            while (!fs.existsSync(process.env.RESOURCE_ACK_CHANNEL)) await once(watcher, 'change');
            admission = JSON.parse(fs.readFileSync(process.env.RESOURCE_ACK_CHANNEL));
            assert.equal(admission.pid, observer.controller.pid);
            let state;
            do { state = execFileSync('ps', ['-o', 'stat=', '-p', String(admission.pid)], { encoding: 'utf8' }).trim(); } while (!state.includes('T'));
            admission.stoppedState = state;
            stage({ event: 'controller-stopped', admission });
            if (input.channel !== 'observed') {
                const disconnected = once(observer.controller, 'disconnect');
                const descriptor = observer.controller.channel.fd;
                const identity = fs.fstatSync(descriptor, { bigint: true });
                assert.equal(identity.isSocket(), true);
                const shutdown = JSON.parse(execFileSync('/opt/homebrew/bin/python3', ['-c', 'import json,os,socket,sys; s=socket.socket(fileno=3); st=os.fstat(3); s.shutdown(socket.SHUT_RDWR); print(json.dumps({"pid":os.getpid(),"version":sys.version,"descriptor":3,"dev":str(st.st_dev),"ino":str(st.st_ino),"shutdown":"SHUT_RDWR"})); s.close()'], { stdio: ['ignore', 'pipe', 'pipe', descriptor], encoding: 'utf8' }));
                assert.equal(BigInt(shutdown.dev), identity.dev); assert.equal(BigInt(shutdown.ino), identity.ino);
                admission.nativeShutdown = { descriptor, identity: { dev: String(identity.dev), ino: String(identity.ino) }, shutdown };
                stage({ event: 'owner-native-channel-shutdown', connected: observer.controller.connected, nativeShutdown: admission.nativeShutdown });
                await disconnected;
                admission.ownerDisconnected = observer.controller.connected === false;
                stage({ event: 'owner-channel-disconnected', admission });
            }
        } finally { watcher.close(); observer.controller.kill('SIGCONT'); stage({ event: 'controller-resumed' }); }
    }
    if (input.channel === 'healthy') observer.controller.send({ type: 'stop' });
    const [controllerCode, controllerSignal] = await controllerEnded;
    stage({ event: 'controller-ended', controllerCode, controllerSignal });
    const terminalBytes = fs.readFileSync(record.terminal.path);
    const terminal = JSON.parse(terminalBytes);
    const completion = fs.lstatSync(record.terminal.completion);
    assert.equal(completion.dev, record.terminal.dev); assert.equal(completion.ino, record.terminal.ino);
    const beforeConsumption = { registryPath: run.registryPath, data: data.path, neighbor: neighbor.path, workerExit, workerPublished: workerPublished.toString('base64'), admission, events: observer.events, controllerExit: { code: controllerCode, signal: controllerSignal }, terminal, terminalBytes: terminalBytes.toString('base64'), digest: createHash('sha256').update(terminalBytes).digest('hex'), completion: { dev: completion.dev, ino: completion.ino }, original: serializeFailure(original) };
    await emit({ type: 'terminal', runtime, ...beforeConsumption });
    if (input.endedOwner) {
        await once(process, 'message');
        throw new Error('Ended-owner fixture was continued instead of terminated');
    }
    if (input.cleanupFault) fs.chmodSync(neighbor.path, 0o500);
    let result;
    if (input.entrance === 'scope') result = await settled(scope.dispose());
    else if (input.entrance === 'run') result = await settled(run.dispose());
    else if (input.entrance !== 'framework') result = await settled(lease.stop());
    if (input.entrance === 'framework') return { data, neighbor, original, observer, hook, snapshots, queued, beforeConsumption, get durabilityFault() { return durabilityFault; } };
    if (input.afterDeclarations) {
        const later = await launchOwnedProcess(scope, { label: 'later declaration allocation', command: [process.execPath, new URL('./resource-boundary-child.mjs', import.meta.url).pathname, 'capture', JSON.stringify({ report: input.root + '/later-worker.json', marker: 'resource-ready' })], readyLine: 'resource-ready', sensitiveValues: input.afterDeclarations, dependsOn: [data.resourceId] });
        await later.stop();
    }
    const queuedResults = await Promise.all(queued);
    for (const publication of queuedResults) if (publication.status === 'rejected') run.recordError(publication.error);
    const intermediate = { type: 'intermediate', runtime, ...beforeConsumption, result: evidence(result), snapshots: [...snapshots], acknowledgementFault, queuedResults: queuedResults.map(evidence), bytes: fs.readFileSync(run.registryPath).toString('base64'), errors: run.registry.errors.map(error => serializeFailure(error)), originalIdentity: run.registry.errors.includes(original), retainedData: fs.readFileSync(data.path + '/scenario', 'utf8'), inventory: inventory(input.projectRoot) };
    await emit(intermediate);
    await once(process, 'message');
    if (input.finalFault === 'prepare') fs.chmodSync(path.dirname(run.registryPath), 0o500);
    const finishing = await settled(run.finish({ status: 'failed', error: original }));
    const beforeRestoration = { bytes: fs.readFileSync(run.registryPath).toString('base64'), inventory: inventory(input.projectRoot), data: fs.existsSync(data.path) && fs.readFileSync(data.path + '/scenario', 'utf8') };
    hook.disable(); observer.close();
    await emit({ type: 'complete', runtime, result: evidence(finishing), summary: finishing.status === 'fulfilled' && { status: finishing.value.status, errors: finishing.value.errors.map(error => serializeFailure(error)), originalIdentity: finishing.value.errors.includes(original), originalOccurrences: finishing.value.errors.filter(error => error === original).length }, snapshots, durabilityFault, beforeRestoration, originalUnchanged: JSON.stringify(serializeFailure(original)) === JSON.stringify(beforeConsumption.original), authoritativeErrors: run.registry.errors.map(error => serializeFailure(error)), terminalNativeInErrors: nodes(run.registry.errors).some(error => error.type === 'error' && error.code === 'EPIPE') });
    if (process.connected) process.disconnect();
    if (finishing.status === 'rejected') throw finishing.error;
    if (result.status === 'rejected') throw result.error;
}

if (input.entrance === 'framework') {
    const { test: managedTest } = await import('../node.js');
    let state;
    const result = await settled(managedTest('native framework acknowledgement transaction', options, async (t, scope, run) => {
        state = await scenario(scope, run);
        throw state.original;
    }));
    state.hook.disable(); state.observer.close();
    await emit({ type: 'complete', runtime, result: evidence(result), snapshots: state.snapshots, queuedResults: (await Promise.all(state.queued)).map(evidence), bytes: fs.readFileSync(state.beforeConsumption.registryPath).toString('base64'), beforeConsumption: state.beforeConsumption });
    if (process.connected) process.disconnect();
} else {
    const run = await createRun(options);
    const scope = await run.scope({ kind: 'case', label: 'normal owner transaction' });
    await scenario(scope, run);
}
