import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createHook } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { createRun } from '../resources/run.js';
import { launchOwnedProcess } from '../resources/process-owner.js';
import { serializeFailure } from '../resources/errors.js';
import { observeNativeStartup, settled, vocabulary, nodes, inventory } from './process-native-control.mjs';

const [mode, encoded] = process.argv.slice(2);
const input = JSON.parse(encoded);
const runtime = { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') };
let sequence = 0;
const emit = async value => {
    const receipt = path.join(input.root, `outcome-${process.pid}-${++sequence}.json`);
    fs.writeFileSync(receipt, JSON.stringify(value), { flag: 'wx' });
    await new Promise((resolve, reject) => process.send({ receipt }, error => error ? reject(error) : resolve()));
};
await emit({ type: 'runtime', runtime, mode });
if (mode === 'startup' || mode === 'publication') {
    const run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'native-outcome-boundary', command: [process.execPath, ...process.argv.slice(1)] });
    const scope = await run.scope({ kind: 'case', label: 'transported native failure' });
    await scope.borrowDirectory(input.borrowed);
    const data = await scope.directory('dependent outcome data');
    fs.writeFileSync(data.path + '/scenario', 'original outcome scenario');
    const cancel = new AbortController();
    const reason = new Error('original cancellation after admitted start');
    const observer = observeNativeStartup();
    let publicationPrimary;
    const publisher = input.publicationPrimary && createHook({ init(id, type) {
        if (publicationPrimary || !type.startsWith('FSREQ')) return;
        const stack = new Error('actual startup controller publication durability').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        const snapshot = JSON.parse(fs.readFileSync(run.registryPath));
        const record = snapshot.resources.find(record => record.kind === 'process');
        if (!record?.locator.controller || record.locator.worker !== null) return;
        let fd;
        let descriptor;
        const descriptors = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
        for (const line of descriptors.split('\n')) {
            if (line.startsWith('f')) fd = Number.parseInt(line.slice(1));
            if (line === 'n' + path.dirname(run.registryPath)) descriptor = fd;
        }
        assert.ok(Number.isSafeInteger(descriptor));
        const stat = fs.fstatSync(descriptor);
        assert.equal(stat.isDirectory(), true);
        assert.equal(stat.dev, snapshot.boundaries.at(-1).dev); assert.equal(stat.ino, snapshot.boundaries.at(-1).ino);
        publicationPrimary = { id, type, stack, descriptor, dev: stat.dev, ino: stat.ino, snapshot, descriptors };
        fs.closeSync(descriptor);
    } });
    publisher?.enable();
    const watching = input.cancel && fs.watch(input.root);
    const launching = settled(launchOwnedProcess(scope, { label: 'actual native startup', command: input.ready || mode === 'publication' ? [process.execPath, new URL('./resource-boundary-child.mjs', import.meta.url).pathname, 'capture', JSON.stringify({ ...input, marker: 'resource-ready' })] : [input.root + '/missing-executable', 'payload type error id ref name code'], readyLine: 'resource-ready', signal: cancel.signal, sensitiveValues: input.vocabulary ? vocabulary : [], dependsOn: [data.resourceId] }));
    if (input.cancel) {
        try {
            while (!fs.existsSync(process.env.RESOURCE_OUTCOME_START)) await Promise.race([once(watching, 'change'), launching.then(result => { throw new Error(`Native startup concluded before actual start admission: ${result.status}`); })]);
            const admission = JSON.parse(fs.readFileSync(process.env.RESOURCE_OUTCOME_START));
            if (admission.pid !== observer.controller.pid) throw new Error('Start admission did not come from the actual owned controller');
            let state;
            do { state = execFileSync('ps', ['-o', 'stat=', '-p', String(admission.pid)], { encoding: 'utf8' }).trim(); } while (!state.includes('T'));
            admission.stoppedState = state;
            observer.events.push(admission, { event: 'cancel' });
            cancel.abort(reason);
        } finally { watching.close(); observer.controller.kill('SIGCONT'); }
    }
    let result = await launching;
    publisher?.disable();
    if (mode === 'publication') {
        if (result.status !== 'fulfilled') throw result.error;
        const lease = result.value;
        await emit({ type: 'ready', runtime, registryPath: run.registryPath, data: data.path, pid: lease.pid, snapshot: JSON.parse(fs.readFileSync(run.registryPath)) });
        await once(process, 'message');
        result = await settled(lease.stop());
    }
    observer.close();
    const original = new Error('wrapped transported original', { cause: result.error });
    original.shared = result.error;
    original.self = original;
    original.lookalike = { type: 'error', id: 731, name: 'name', message: 'error', stack: 'type', code: 'code' };
    const getter = function () { throw new Error('must not invoke payload accessor'); };
    Object.defineProperty(getter, 'name', { value: 'accessor' });
    Object.defineProperty(original, 'properties', { get: getter, enumerable: true });
    const before = serializeFailure(original);
    run.recordError(original);
    if (input.retainData) fs.chmodSync(data.path, 0o500);
    const beforeRestoration = input.publication ? { inventory: inventory(input.projectRoot), registry: JSON.parse(fs.readFileSync(run.registryPath)), data: fs.readFileSync(data.path + '/scenario', 'utf8') } : null;
    if (input.publication === 'completion') fs.chmodSync(path.dirname(run.registryPath), 0o700);
    const summary = await run.finish({ status: 'failed' });
    const durable = JSON.parse(fs.readFileSync(run.registryPath));
    const record = durable.resources.find(record => record.kind === 'process');
    const terminalBytes = fs.readFileSync(record.terminal.path, 'utf8');
    const publicationBytes = fs.readFileSync(record.terminal.publication.path, 'utf8');
    await emit({ type: 'complete', runtime, result: result.status === 'fulfilled' ? { status: result.status } : { status: result.status, error: serializeFailure(result.error), retainsCancellation: nodes(result.error).includes(reason) }, events: observer.events, publicationPrimary, summary: { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)), originalIdentity: summary.errors.includes(original), cancellationIdentity: summary.errors.includes(reason) }, durable, beforeRestoration, registryPath: run.registryPath, data: data.path, retainedData: fs.existsSync(data.path) && fs.readFileSync(data.path + '/scenario', 'utf8'), terminalBytes, terminal: terminalBytes ? JSON.parse(terminalBytes) : null, publicationBytes, publication: publicationBytes ? JSON.parse(publicationBytes) : null, originalUnchanged: JSON.stringify(before) === JSON.stringify(serializeFailure(original)) });
    process.disconnect();
    if (result.status === 'rejected') throw result.error;
} else throw new Error(`Unknown native outcome mode: ${mode}`);
