import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHook } from 'node:async_hooks';
import net from 'node:net';
import { once } from 'node:events';
import { createRun } from './resources/run.js';
import { launchOwnedProcess } from './resources/process-owner.js';
import { recoverRuns } from './resources/recovery.js';
import { serializeFailure } from './resources/errors.js';
import { directoryProvider, registerProvider } from './resources/providers.js';
import { outcomeFixture, inventory, sha, nodes, settled, descriptors } from './fixtures/process-native-control.mjs';
import { property } from './fixtures/failure-graph.mjs';

const api = () => import('./resources/diagnostics.js');
const options = (input, profile = 'unit', extra = {}) => ({ projectRoot: input.projectRoot, profile, source: 'diagnostic-retention-source', command: [process.execPath, '--test', '--test-name-pattern=selected', '--test-concurrency=2'], ...extra });
const slot = (input, profile = 'unit') => path.join(input.projectRoot, 'test-results/harness/diagnostics/slots', sha(Buffer.from(profile, 'utf16le')) + '.json');

async function failure(t, input, profile = 'unit', bytes) {
    const run = await createRun(options(input, profile));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'failure diagnostics' });
    const data = await scope.directory('temporary failure data');
    fs.writeFileSync(data.path + '/original', 'runtime-only bytes');
    const original = new Error('actual assertion original', { cause: new TypeError('assertion context') });
    if (bytes !== undefined) await (await api()).captureDiagnostic(scope, { name: 'evidence.bin', bytes, contentType: 'application/octet-stream' });
    const summary = await run.finish({ status: 'failed', error: original });
    assert.equal(fs.existsSync(data.path), false);
    return { run, scope, data, original, summary };
}

test('passing rerun retains the latest failure', async t => {
    const input = outcomeFixture(t);
    const failed = await failure(t, input);
    const before = fs.readFileSync(slot(input), 'utf8');
    assert.ok(failed.summary.diagnosticIndex);
    const run = await createRun(options(input, 'unit', { command: [process.execPath, '--test', '--test-name-pattern=other', '--test-concurrency=8'] }));
    const scope = await run.scope({ kind: 'case', label: 'passing rerun' });
    const directory = await scope.directory('passing data');
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'passed');
    assert.equal(fs.existsSync(directory.path), false);
    assert.equal(fs.readFileSync(slot(input), 'utf8'), before);
    assert.equal(summary.diagnosticIndex, null);
    t.diagnostic(JSON.stringify({ passingRetention: { before, after: fs.readFileSync(slot(input), 'utf8'), registry: JSON.parse(fs.readFileSync(run.registryPath)) } }));
});

test('new failure replaces only its own profile bundle', async t => {
    const input = outcomeFixture(t);
    const initial = await failure(t, input);
    const prior = JSON.parse(fs.readFileSync(slot(input)));
    const peer = await failure(t, input, 'storage-local');
    const peerBytes = fs.readFileSync(slot(input, 'storage-local'));
    const latest = await failure(t, input);
    const index = JSON.parse(fs.readFileSync(slot(input)));
    assert.notEqual(index.runId, initial.run.runId);
    assert.equal(index.runId, latest.run.runId);
    assert.equal(fs.existsSync(prior.storage.bundle.path), false);
    assert.ok(fs.existsSync(peer.summary.diagnosticIndex.storage.bundle.path));
    assert.deepEqual(fs.readFileSync(slot(input, 'storage-local')), peerBytes);
    assert.equal(fs.existsSync(index.storage.bundle.path), true);
    t.diagnostic(JSON.stringify({ replacedProfile: { prior, index, peer: peer.summary.diagnosticIndex } }));
});

test('failure slot records actual cancelled outcome after runtime disposal', async t => {
    const input = outcomeFixture(t);
    const run = await createRun(options(input));
    const scope = await run.scope({ kind: 'case', label: 'cancelled scope' });
    const data = await scope.directory('cancelled data');
    const original = new Error('actual cancellation reason');
    const summary = await run.finish({ status: 'cancelled', error: original });
    assert.notEqual(summary.diagnosticIndex, null);
    assert.equal(summary.diagnosticIndex.outcome, 'cancelled');
    assert.equal(summary.errors.includes(original), true);
    assert.equal(fs.existsSync(data.path), false);
});

test('profile slot identity preserves literal code units', async t => {
    const input = outcomeFixture(t);
    const replacement = 'profile-\uFFFD';
    const isolated = 'profile-\uD83D';
    const prior = await failure(t, input, replacement);
    const before = fs.readFileSync(slot(input, replacement));
    await failure(t, input, isolated);
    assert.notEqual(slot(input, replacement), slot(input, isolated));
    assert.deepEqual(fs.readFileSync(slot(input, replacement)), before);
    assert.equal(fs.existsSync(prior.summary.diagnosticIndex.storage.bundle.path), true);
});

test('byte capture copies inputs before await and restores repeated complete binary evidence', async t => {
    const input = outcomeFixture(t);
    const run = await createRun(options(input));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'binary capture' });
    const { captureDiagnostic, exportDiagnostic, readDiagnostic } = await api();
    const original = Buffer.from([0, 255, 13, 10, 0, 240, 159, 152, 128]);
    const caller = Buffer.from(original);
    const pending = captureDiagnostic(scope, { name: 'original.bin', bytes: caller, contentType: 'application/octet-stream' });
    caller.fill(1);
    const first = await pending;
    const second = await captureDiagnostic(scope, { name: 'duplicate.bin', bytes: original, contentType: 'application/octet-stream' });
    await captureDiagnostic(scope, { name: 'empty.bin', bytes: Buffer.alloc(0), contentType: 'application/octet-stream' });
    const summary = await run.finish({ status: 'failed', error: new Error('binary evidence failure') });
    const index = JSON.parse(fs.readFileSync(slot(input)));
    assert.equal(first.sha256, sha(original)); assert.equal(first.length, original.length); assert.equal(first.readStatus, 'complete');
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(await readDiagnostic(index, first), original);
    const archive = input.root + '/explicit-diagnostics';
    await exportDiagnostic(index, archive);
    assert.deepEqual(fs.readFileSync(archive + '/objects/' + first.sha256), original);
    assert.equal(fs.readFileSync(archive + '/objects/' + sha(Buffer.alloc(0))).length, 0);
    assert.equal(fs.readdirSync(index.storage.bundle.path + '/objects').length, 2);
    assert.ok(summary.diagnosticIndex);
    t.diagnostic(JSON.stringify({ restoredEvidence: { original: original.toString('base64'), first, second, index, restored: fs.readFileSync(archive + '/objects/' + first.sha256).toString('base64'), archive: inventory(archive) } }));
});

test('capture revalidates registered ancestors after pending-reference publication', async t => {
    const input = outcomeFixture(t);
    const run = await createRun(options(input));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'post-await capture custody' });
    await scope.borrowDirectory(input.borrowed);
    const before = inventory(input.borrowed);
    const objects = run.registry.diagnostics.objects.path;
    let replacement;
    const hook = createHook({ init(id, type) {
        if (replacement || !type.startsWith('FSREQ') || !run.registry.diagnostics.artifacts.some(ref => ref.name === 'replacement.bin' && ref.readStatus === 'pending')) return;
        const stack = new Error('actual pending capture publication').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        replacement = { id, type, stack, original: fs.lstatSync(objects).ino };
        fs.renameSync(objects, objects + '-held');
        fs.symlinkSync(input.borrowed, objects);
    } });
    hook.enable();
    const result = await settled(scope.captureDiagnostic({ name: 'replacement.bin', bytes: Buffer.from('owned capture bytes'), contentType: 'application/octet-stream' }));
    hook.disable();
    const after = inventory(input.borrowed);
    assert.equal(fs.readlinkSync(objects), input.borrowed);
    fs.unlinkSync(objects); fs.renameSync(objects + '-held', objects);
    await run.finish({ status: 'failed' });
    t.diagnostic(JSON.stringify({ captureCustody: { replacement, result: result.status, error: result.error && serializeFailure(result.error), before, after } }));
    assert.ok(replacement);
    assert.deepEqual(after, before);
    assert.equal(result.status, 'rejected');
    assert.match(result.error.message, /directory|boundary|ownership/i);
    assert.equal(run.registry.diagnostics.artifacts.find(ref => ref.name === 'replacement.bin').readStatus, 'failed');
});

for (const corruption of ['missing', 'truncated', 'corrupt', 'unreadable', 'symlink']) {
    test(`artifact ${corruption} blocks publication and preserves the previous readable failure`, async t => {
        const input = outcomeFixture(t);
        await failure(t, input);
        const before = fs.readFileSync(slot(input));
        const run = await createRun(options(input));
        const scope = await run.scope({ kind: 'case', label: 'damaged capture' });
        const data = await scope.directory('capture-dependent data');
        const { captureDiagnostic } = await api();
        const ref = await captureDiagnostic(scope, { name: 'complete.bin', bytes: Buffer.from('complete original bytes'), contentType: 'application/octet-stream' });
        const filename = run.registry.diagnostics.staging.path + '/objects/' + ref.sha256;
        if (corruption === 'missing') fs.unlinkSync(filename);
        if (corruption === 'truncated') fs.truncateSync(filename, 4);
        if (corruption === 'corrupt') fs.writeFileSync(filename, 'damaged original bytes!');
        if (corruption === 'unreadable') fs.chmodSync(filename, 0o000);
        if (corruption === 'symlink') { fs.unlinkSync(filename); fs.symlinkSync(input.borrowed + '/original', filename); }
        const original = new Error('test failure before damaged capture publication');
        const result = await settled(run.finish({ status: 'failed', error: original }));
        if (corruption === 'unreadable') fs.chmodSync(filename, 0o600);
        const errors = result.status === 'fulfilled' ? result.value.errors : nodes(result.error);
        assert.equal(errors.includes(original), true);
        assert.ok(errors.some(error => /artifact|diagnostic|content/i.test(error.message)));
        assert.deepEqual(fs.readFileSync(slot(input)), before);
        assert.equal(fs.existsSync(data.path), false);
        t.diagnostic(JSON.stringify({ damagedArtifact: { corruption, result: result.status, errors: errors.map(error => serializeFailure(error)), registry: JSON.parse(fs.readFileSync(run.registryPath)) } }));
    });
}

test('diagnostic failure still disposes runtime data with complete original and cleanup errors', async t => {
    const input = outcomeFixture(t);
    await failure(t, input);
    const before = fs.readFileSync(slot(input));
    const run = await createRun(options(input));
    const scope = await run.scope({ kind: 'case', label: 'capture failure' });
    const data = await scope.directory('failed diagnostic data');
    const blocked = await scope.directory('native cleanup failure');
    fs.writeFileSync(blocked.path + '/original', 'retained cleanup failure bytes');
    fs.chmodSync(blocked.path, 0o500);
    const original = new Error('original body failure');
    const captureError = new Error('native diagnostic source is unavailable', { cause: new TypeError('source failure context') });
    await scope.diagnostic({ name: 'unavailable.log', contentType: 'text/plain', produce: () => { throw captureError; } });
    const structured = { nativeProducer: 'structured rejection context' };
    await scope.onFinalize({ label: 'structured producer rejection', stage: 'complete', callback: () => { throw structured; } });
    const summary = await run.finish({ status: 'failed', error: original });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.errors.includes(original)); assert.ok(summary.errors.includes(captureError));
    assert.equal(summary.errors.filter(error => error.cause === structured).length, 1);
    assert.equal(summary.resources.find(record => record.resourceId === blocked.resourceId).state, 'cleanup-failed');
    assert.equal(fs.existsSync(data.path), false);
    assert.deepEqual(fs.readFileSync(slot(input)), before);
    assert.equal(run.registry.diagnostics.artifacts.find(ref => ref.name === 'unavailable.log').readStatus, 'failed');
});

for (const placement of ['local', 'ancestor-action', 'descendant-action', 'cancelled']) test(`${placement} owned network continuations settle before trace closure`, async t => {
    const cancelled = placement === 'cancelled';
    const input = outcomeFixture(t);
    if (cancelled) await failure(t, input);
    const previous = cancelled && fs.readFileSync(slot(input));
    const controller = new AbortController();
    const run = await createRun(options(input, 'unit', { signal: controller.signal }));
    t.after(() => run.finish({ status: 'failed' }));
    const scope = await run.scope({ kind: 'case', label: 'actual network trace producer' });
    const child = await scope.child({ kind: 'case', label: 'nested network control' });
    const operationScope = placement === 'ancestor-action' ? child : scope;
    const actionScope = placement === 'descendant-action' ? child : scope;
    const data = await scope.directory('network trace sources');
    const source = data.path + '/server.mjs';
    const sourceBytes = Buffer.from('import http from \'node:http\'; let pending; let observed; const seen=new Promise(r=>observed=r); const server=http.createServer(async(req,res)=>{if(req.url===\'/pending\'){observed(); pending=res;} else if(req.url===\'/seen\'){await seen;res.end(\'observed\');}else if(req.url===\'/release\'){if(!pending.writableEnded)pending.end(\'complete owned response bytes\');res.end(\'released\');}});server.listen(0,\'127.0.0.1\',()=>console.log(\'port:\'+server.address().port+\'\\nresource-ready\'));');
    fs.writeFileSync(source, sourceBytes);
    const lease = await launchOwnedProcess(scope, { label: 'owned HTTP producer', command: [process.execPath, source], readyLine: 'resource-ready', dependsOn: [data.resourceId] });
    const port = /port:(\d+)/.exec(lease.startupLog)[1];
    const baseURL = 'http://127.0.0.1:' + port;
    const tracePath = data.path + '/trace.bin';
    const descriptor = fs.openSync(tracePath, 'wx');
    let closed = false;
    const events = [];
    const continuation = await operationScope.continuation({ label: 'owned pending HTTP response', start: async signal => {
        const response = await fetch(baseURL + '/pending', { signal });
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(closed, false);
        fs.writeSync(descriptor, bytes);
        events.push('response complete');
        return bytes;
    } });
    assert.equal(await (await fetch(baseURL + '/seen')).text(), 'observed');
    await actionScope.onFinalize({ label: 'release held HTTP response', stage: 'drain', callback: async () => {
        events.push('release action');
        if (!cancelled) assert.equal(await (await fetch(baseURL + '/release')).text(), 'released');
    } });
    await scope.onFinalize({ label: 'trace descriptor closure', stage: 'complete', callback: () => { fs.fsyncSync(descriptor); fs.closeSync(descriptor); closed = true; events.push('trace closed'); } });
    await scope.diagnostic({ name: 'trace.bin', contentType: 'application/octet-stream', stage: 'complete', produce: () => fs.readFileSync(tracePath) });
    const original = new Error(cancelled ? 'actual cancelled native HTTP continuation' : 'retain actual trace');
    if (cancelled) controller.abort(original);
    const disposing = settled(run.dispose());
    assert.equal(closed, false);
    const actual = await settled(continuation.settled);
    const disposal = await disposing;
    t.diagnostic(JSON.stringify({ automaticDrain: { placement, events } }));
    assert.equal(disposal.status, cancelled ? 'rejected' : 'fulfilled');
    assert.equal(closed, true);
    assert.equal(fs.existsSync(data.path), false);
    const summary = await run.finish({ status: cancelled ? 'cancelled' : 'failed', error: original });
    const { readDiagnostic } = await api();
    if (cancelled) {
        assert.equal(actual.status, 'rejected');
        assert.ok(summary.errors.includes(original));
        assert.equal(summary.diagnosticIndex, null);
        assert.deepEqual(fs.readFileSync(slot(input)), previous);
    } else {
        assert.equal(actual.status, 'fulfilled');
        assert.deepEqual(await readDiagnostic(summary.diagnosticIndex, summary.diagnosticIndex.artifacts.find(ref => ref.name === 'trace.bin')), Buffer.from('complete owned response bytes'));
        assert.deepEqual(actual.value, Buffer.from('complete owned response bytes'));
        assert.deepEqual(events, ['release action', 'response complete', 'trace closed']);
    }
    assert.equal(descriptors().includes(data.path), false);
    t.diagnostic(JSON.stringify({ networkTrace: { cancelled, source, sourceSHA256: sha(sourceBytes), sourceBytes: sourceBytes.toString('base64'), port, runtime: { version: process.version, execPath: process.execPath }, result: actual.status, bytes: actual.value?.toString('base64'), error: actual.error && serializeFailure(actual.error), index: summary.diagnosticIndex } }));
});

for (const release of ['run', 'nested-scope', 'allocated-failure']) test(`environment export requires an explicit destination before ${release} release`, async t => {
    const input = outcomeFixture(t);
    const ordinary = await failure(t, input);
    const ordinaryIndex = JSON.parse(fs.readFileSync(slot(input)));
    assert.equal(ordinaryIndex.environment, undefined);
    const destination = input.root + '/explicit-environment';
    const run = await createRun(options(input, 'unit', { exportEnvironmentTo: destination }));
    const parent = await run.scope({ kind: 'scenario', label: 'explicit environment' });
    const scope = await parent.child({ kind: 'case', label: 'independent export lifetime' });
    await scope.borrowDirectory(input.borrowed);
    const bytes = Buffer.from([0, 255, 13, 10, 42]);
    let data;
    let acquisition;
    let fault;
    const hook = release === 'allocated-failure' && createHook({ init(id, type) {
        if (fault || !type.startsWith('FSREQ')) return;
        const record = run.registry.resources.find(record => record.owner === 'owned' && record.kind === 'directory' && record.state === 'acquired');
        if (!record) return;
        const stack = new Error('actual allocated directory publication fault').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        data = { path: record.locator.path, resourceId: record.resourceId };
        fs.mkdirSync(data.path + '/nested'); fs.mkdirSync(data.path + '/empty');
        fs.writeFileSync(data.path + '/nested/original', bytes);
        let fd; let selected;
        for (const line of descriptors().split('\n')) { if (line.startsWith('f')) fd = Number.parseInt(line.slice(1)); if (line === 'n' + path.dirname(run.registryPath)) selected = fd; }
        assert.ok(Number.isSafeInteger(selected));
        fault = { id, type, stack, descriptor: selected };
        fs.closeSync(selected);
    } });
    if (hook) { hook.enable(); acquisition = await settled(scope.directory('owned export files')); hook.disable(); }
    else data = await scope.directory('owned export files');
    if (release !== 'allocated-failure') {
        fs.mkdirSync(data.path + '/nested');
        fs.mkdirSync(data.path + '/empty');
        fs.writeFileSync(data.path + '/nested/original', bytes);
    }
    if (release === 'nested-scope') { await scope.dispose(); await parent.dispose(); }
    if (release !== 'run') assert.equal(fs.existsSync(data.path), false);
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, release === 'allocated-failure' ? 'failed' : 'passed');
    if (release === 'allocated-failure') { assert.ok(fault); assert.equal(acquisition.status, 'rejected'); assert.ok(summary.errors.some(error => nodes(error).includes(acquisition.error))); }
    assert.deepEqual(fs.readFileSync(destination + '/resources/' + data.resourceId + '/nested/original'), bytes);
    assert.deepEqual(fs.readdirSync(destination + '/resources/' + data.resourceId + '/empty'), []);
    assert.equal(fs.existsSync(destination + '/resources/original'), false);
    assert.equal(fs.existsSync(data.path), false);
    assert.equal(fs.existsSync(ordinary.data.path), false);
    assert.equal(JSON.stringify(inventory(destination)).includes('borrowed outcome bytes'), false);
    const exportedBefore = inventory(destination);
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.deepEqual(inventory(destination), exportedBefore);
    t.diagnostic(JSON.stringify({ environmentExport: { release, fault, destination, manifest: JSON.parse(fs.readFileSync(destination + '/environment.json')), original: bytes.toString('base64'), restored: fs.readFileSync(destination + '/resources/' + data.resourceId + '/nested/original').toString('base64') } }));
});

test('external export and capture boundaries reject overwrite, traversal and foreign symlinks', async t => {
    const input = outcomeFixture(t);
    const result = await failure(t, input, 'unit', Buffer.from('selected evidence'));
    const { exportDiagnostic, captureDiagnostic } = await api();
    const run = await createRun(options(input));
    const scope = await run.scope({ kind: 'case', label: 'external boundaries' });
    await scope.borrowDirectory(input.borrowed);
    for (const name of ['../escape', 'a/b', '.', '', 'a\0b']) await assert.rejects(captureDiagnostic(scope, { name, bytes: Buffer.from('never written'), contentType: 'text/plain' }));
    const before = inventory(input.borrowed);
    await assert.rejects(exportDiagnostic(result.summary.diagnosticIndex, input.borrowed));
    fs.symlinkSync(input.borrowed, input.root + '/linked-export');
    await assert.rejects(exportDiagnostic(result.summary.diagnosticIndex, input.root + '/linked-export/new'));
    const damaged = structuredClone(result.summary.diagnosticIndex);
    damaged.storage.bundle.path = input.borrowed;
    await assert.rejects(exportDiagnostic(damaged, input.root + '/never-created'));
    const originalRegistry = fs.readFileSync(result.run.registryPath);
    const unsupported = JSON.parse(originalRegistry);
    unsupported.diagnostics.format = 'unsupported-retirement-format';
    fs.writeFileSync(result.run.registryPath, JSON.stringify(unsupported));
    try { await assert.rejects(exportDiagnostic(result.summary.diagnosticIndex, input.root + '/unsupported-format'), /retirement format/); }
    finally { fs.writeFileSync(result.run.registryPath, originalRegistry); }
    assert.equal(fs.existsSync(input.root + '/never-created'), false);
    assert.deepEqual(inventory(input.borrowed), before);
    const previous = fs.readFileSync(slot(input));
    const objects = run.registry.diagnostics.objects.path;
    fs.chmodSync(objects, 0o500);
    await assert.rejects(captureDiagnostic(scope, { name: 'native-permission.bin', bytes: Buffer.from('complete requested native evidence'), contentType: 'application/octet-stream' }));
    fs.chmodSync(objects, 0o700);
    assert.equal(run.registry.diagnostics.artifacts.find(ref => ref.name === 'native-permission.bin').readStatus, 'failed');
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(fs.readFileSync(slot(input)), previous);
});

test('explicit environment export refuses foreign symlink files and still cleans owned runtime data', async t => {
    const input = outcomeFixture(t);
    const destination = input.root + '/rejected-environment';
    const run = await createRun(options(input, 'unit', { exportEnvironmentTo: destination }));
    const scope = await run.scope({ kind: 'scenario', label: 'linked environment' });
    const data = await scope.directory('owned linked files');
    fs.symlinkSync(input.borrowed, data.path + '/foreign');
    const original = new Error('original export failure test');
    const summary = await run.finish({ status: 'failed', error: original });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.errors.includes(original));
    assert.ok(summary.errors.some(error => /symbolic|symlink|regular file/i.test(error.message)));
    assert.equal(fs.existsSync(data.path), false);
    assert.equal(fs.existsSync(destination), false);
});

test('explicit environment export refuses unsupported registered state rather than creating an empty export', async t => {
    const input = outcomeFixture(t);
    const destination = input.root + '/unsupported-state';
    const run = await createRun(options(input, 'unit', { exportEnvironmentTo: destination }));
    const scope = await run.scope({ kind: 'scenario', label: 'registered export state' });
    const provider = { ...directoryProvider, kind: 'diagnostic-state' };
    registerProvider(provider);
    const data = await scope.acquire({ ...provider, label: 'actual owned state files' });
    fs.writeFileSync(data.path + '/state', 'actual registered native state');
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.errors.some(error => /no registered state provider/.test(error.message)));
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(data.path), false);
});

for (const stage of ['prepare', 'durability']) {
    test(`actual native profile publication ${stage} failure records published facts and preserves original errors`, async t => {
        const input = outcomeFixture(t);
        await failure(t, input);
        const before = fs.readFileSync(slot(input));
        const run = await createRun(options(input));
        const scope = await run.scope({ kind: 'case', label: 'native publication fault' });
        await (await api()).captureDiagnostic(scope, { name: 'new.bin', bytes: Buffer.from('new complete evidence'), contentType: 'application/octet-stream' });
        const directory = path.dirname(slot(input));
        const original = new Error('publication original');
        let fault;
        const hook = createHook({ init(id, type) {
            if (fault || !type.startsWith('FSREQ')) return;
            const stack = new Error('native diagnostic durability fault').stack;
            if (!stack.includes('fsync') || !stack.includes('/resources/diagnostics.js:') || stack.includes('/resources/registry.js:')) return;
            if (stage === 'prepare') { fault = { id, type, stack }; fs.chmodSync(directory, 0o500); }
            else {
                const published = JSON.parse(fs.readFileSync(slot(input)));
                if (published.runId !== run.runId) return;
                const open = descriptors();
                let fd; let selected;
                for (const line of open.split('\n')) { if (line.startsWith('f')) fd = Number.parseInt(line.slice(1)); if (line === 'n' + directory) selected = fd; }
                assert.ok(Number.isSafeInteger(selected));
                const actual = fs.fstatSync(selected);
                assert.equal(actual.isDirectory(), true);
                fault = { id, type, stack, descriptor: selected, dev: actual.dev, ino: actual.ino, open };
                fs.closeSync(selected);
            }
        } });
        hook.enable();
        const result = await settled(run.finish({ status: 'failed', error: original }));
        hook.disable(); fs.chmodSync(directory, 0o700);
        assert.ok(fault);
        assert.ok(run.registry.errors.includes(original));
        assert.equal(run.registry.errors.some(error => nodes(error).some(node => node.publication?.stage === stage && node.publication.published === (stage === 'durability'))), true);
        if (stage === 'prepare') assert.deepEqual(fs.readFileSync(slot(input)), before);
        else assert.equal(JSON.parse(fs.readFileSync(slot(input))).runId, run.runId);
        t.diagnostic(JSON.stringify({ diagnosticPublicationFault: { stage, fault, before: before.toString('base64'), after: fs.readFileSync(slot(input)).toString('base64'), result: result.status, registry: JSON.parse(fs.readFileSync(run.registryPath)), errors: run.registry.errors.map(error => serializeFailure(error)) } }));
    });
}

test('finish and failure publication join repeated calls without duplicate capture or disposal', async t => {
    const input = outcomeFixture(t);
    const run = await createRun(options(input));
    const scope = await run.scope({ kind: 'case', label: 'idempotent capture' });
    let captures = 0;
    await scope.diagnostic({ name: 'once.log', contentType: 'text/plain', produce: () => { captures++; return Buffer.from('once'); } });
    const original = new Error('idempotent original');
    const first = run.finish({ status: 'failed', error: original });
    const second = run.finish({ status: 'failed', error: original });
    assert.equal(first, second);
    const index = await (await api()).publishFailure(run, { status: 'failed', error: original });
    assert.deepEqual(index, (await first).diagnosticIndex);
    assert.equal(captures, 1);
});

async function nativePublisher(t, input, mode, profile = 'unit', control = {}) {
    const source = new URL('./fixtures/diagnostic-child.mjs', import.meta.url).pathname;
    const argv = [process.execPath, source, JSON.stringify({ ...input, mode, profile, ...control })];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = ''; let partial = '';
    const events = [];
    const waiters = [];
    child.stdout.on('data', bytes => {
        output += bytes; partial += bytes;
        let newline;
        while ((newline = partial.indexOf('\n')) !== -1) {
            const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
            if (!line.startsWith('DIAGNOSTIC_PROOF ')) continue;
            const transport = JSON.parse(line.slice('DIAGNOSTIC_PROOF '.length));
            assert.equal(path.dirname(transport.receipt), input.root);
            const event = JSON.parse(fs.readFileSync(transport.receipt));
            assert.equal(event.runtime.version, process.version); assert.equal(event.runtime.execPath, process.execPath);
            events.push(event);
            for (const waiter of [...waiters]) if (waiter.type === event.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
        }
    });
    child.stderr.on('data', bytes => { output += bytes; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            t.diagnostic(JSON.stringify({ nativeDiagnosticPublisher: { argv, sourceSHA256: sha(fs.readFileSync(source)), events, output, code, signal } }));
            resolve({ code, signal });
        });
    });
    const next = type => events.some(event => event.type === type) ? Promise.resolve(events.find(event => event.type === type)) : Promise.race([new Promise(resolve => waiters.push({ type, resolve })), exited.then(exit => { throw new Error(`Native diagnostic publisher ended before ${type}: ${JSON.stringify(exit)}: ${output}`); })]);
    return { child, next, exited, events };
}

test('interrupted publication preserves the previous index and recovers only its owned staging', async t => {
    const input = outcomeFixture(t);
    await failure(t, input);
    const before = fs.readFileSync(slot(input));
    const native = await nativePublisher(t, input, 'interrupt');
    const ready = await native.next('ready');
    native.child.send({ type: 'finish' });
    const interrupted = await native.next('interrupted-before-slot');
    native.child.kill('SIGKILL');
    assert.deepEqual(await native.exited, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(fs.readFileSync(slot(input)), before);
    const recovered = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.deepEqual(recovered.recovered, [ready.runId]);
    assert.equal(fs.existsSync(ready.data), false);
    const current = JSON.parse(fs.readFileSync(slot(input)));
    assert.equal(current.runId, ready.runId);
    assert.equal(current.outcome, 'cancelled');
    const { readDiagnostic } = await api();
    assert.deepEqual(await readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
    t.diagnostic(JSON.stringify({ interruptedDiagnostic: { before: before.toString('base64'), interrupted, recovered, current } }));
});

for (const profiles of [['unit', 'unit'], ['unit', 'storage-local']]) {
    test(`concurrent actual native publishers preserve coherent ${profiles.join('/')} slots and readable bytes`, async t => {
        const input = outcomeFixture(t);
        const natives = await Promise.all(profiles.map(profile => nativePublisher(t, input, 'publish', profile)));
        const ready = await Promise.all(natives.map(native => native.next('ready')));
        for (const native of natives) native.child.send({ type: 'finish' });
        const complete = await Promise.all(natives.map(native => native.next('complete')));
        assert.deepEqual(await Promise.all(natives.map(native => native.exited)), [{ code: 0, signal: null }, { code: 0, signal: null }]);
        await recoverRuns({ projectRoot: input.projectRoot, profiles: [...new Set(profiles)] });
        for (const item of ready) assert.equal(fs.existsSync(item.data), false);
        const { readDiagnostic } = await api();
        for (const profile of new Set(profiles)) {
            const index = JSON.parse(fs.readFileSync(slot(input, profile)));
            assert.ok(complete.some(event => event.summary.runId === index.runId));
            assert.deepEqual(await readDiagnostic(index, index.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
            const roots = complete.filter(event => event.summary.profile === profile).map(event => event.summary.diagnosticIndex.storage.bundle.path);
            for (const root of roots) assert.equal(fs.existsSync(root), root === index.storage.bundle.path);
        }
    });
}

for (const order of ['predecessor-first', 'successor-first']) test(`native publication chain retires through one durable authority in ${order} recovery`, async t => {
    const input = outcomeFixture(t);
    const natives = await Promise.all(Array.from({ length: 3 }, () => nativePublisher(t, input, 'hold-final')));
    const ready = await Promise.all(natives.map(native => native.next('ready')));
    const enumeration = fs.readdirSync(input.projectRoot + '/test-results/harness/runs');
    const ordered = enumeration.map(id => ready.findIndex(item => item.runId === id)).filter(index => index !== -1);
    const publication = order === 'predecessor-first' ? ordered : [ordered[0], ordered[2], ordered[1]];
    const held = [];
    for (const index of publication) { natives[index].child.send({ type: 'finish' }); held.push(await natives[index].next('held-final-save')); }
    const before = fs.readFileSync(slot(input));
    const active = held.map(event => ({ runId: event.current.runId, present: fs.existsSync(event.current.storage.bundle.path) }));
    for (const native of natives) native.child.kill('SIGCONT');
    const exits = await Promise.all(natives.map(native => native.exited));
    const recovered = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const current = JSON.parse(fs.readFileSync(slot(input)));
    const restored = await (await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin'));
    t.diagnostic(JSON.stringify({ retirementChain: { order, enumeration, publication: publication.map(index => ready[index].runId), active, exits, recovered: recovered.status, error: recovered.error && serializeFailure(recovered.error), repeated: repeated.status, current } }));
    assert.ok(active.every(item => item.present));
    assert.deepEqual(exits, [{ code: 0, signal: null }, { code: 0, signal: null }, { code: 0, signal: null }]);
    assert.equal(recovered.status, 'fulfilled'); assert.equal(repeated.status, 'fulfilled');
    assert.deepEqual(fs.readFileSync(slot(input)), before);
    assert.deepEqual(restored, Buffer.from('actual native evidence'));
    for (const event of held) assert.equal(fs.existsSync(event.current.storage.bundle.path), event.current.runId === current.runId);
});

test('native retirement custody excludes an interleaved claimed recovery writer', async t => {
    const input = outcomeFixture(t);
    const natives = await Promise.all([nativePublisher(t, input, 'publish'), nativePublisher(t, input, 'publish')]);
    const candidates = await Promise.all(natives.map(native => native.next('ready')));
    const enumeration = fs.readdirSync(input.projectRoot + '/test-results/harness/runs');
    const selected = enumeration.map(id => candidates.findIndex(item => item.runId === id));
    const [old, replacing] = selected.map(index => natives[index]);
    const ready = candidates[selected[0]];
    old.child.send({ type: 'finish', mode: 'interrupt-after-slot' });
    const stopped = await old.next('interrupted-after-slot');
    old.child.kill('SIGKILL');
    const oldExit = await old.exited;
    replacing.child.send({ type: 'finish', mode: 'pause-retirement' });
    const inspection = await replacing.next('retirement-inspection');
    const recovering = await nativePublisher(t, input, 'recover', 'unit', { targetRegistry: ready.registryPath, pauseClaim: true });
    const claimed = await recovering.next('recovery-claimed');
    replacing.child.kill('SIGCONT');
    const replacementExit = await replacing.exited;
    const replacement = await replacing.next('complete');
    const protectedWhileClaimed = fs.existsSync(stopped.current.storage.bundle.path);
    const selectedBytes = fs.readFileSync(slot(input));
    recovering.child.kill('SIGCONT');
    const recoveryExit = await recovering.exited;
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    t.diagnostic(JSON.stringify({ retirementCustody: { ready, enumeration, inspection, claimed, oldExit, replacementExit, protectedWhileClaimed, recoveryExit, repeated: repeated.status, error: repeated.error && serializeFailure(repeated.error) } }));
    assert.deepEqual(oldExit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(replacementExit, { code: 0, signal: null });
    assert.deepEqual(replacement.summary.errors.map(error => error.message), ['actual native publisher assertion']);
    assert.equal(protectedWhileClaimed, true);
    assert.deepEqual(recoveryExit, { code: 0, signal: null });
    assert.equal(repeated.status, 'fulfilled');
    assert.deepEqual(fs.readFileSync(slot(input)), selectedBytes);
    assert.equal(fs.existsSync(stopped.current.storage.bundle.path), false);
    const current = JSON.parse(selectedBytes);
    assert.deepEqual(await (await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
});

test('interrupted native retirement reconciles its durable deletion intent before repeat recovery', async t => {
    const input = outcomeFixture(t);
    const previous = await nativePublisher(t, input, 'publish');
    const ready = await previous.next('ready'); previous.child.send({ type: 'finish' });
    const complete = await previous.next('complete');
    assert.deepEqual(await previous.exited, { code: 0, signal: null });
    const oldIndex = complete.summary.diagnosticIndex;
    const native = await nativePublisher(t, input, 'interrupt-retirement', 'unit', { targetBundle: oldIndex.storage.bundle.path });
    await native.next('ready'); native.child.send({ type: 'finish' });
    const interrupted = await native.next('retirement-removed');
    native.child.kill('SIGKILL');
    const exit = await native.exited;
    const before = fs.readFileSync(slot(input));
    const intent = JSON.parse(fs.readFileSync(ready.registryPath));
    const recovered = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    const repeated = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
    assert.equal(intent.diagnostics.retirement.state, 'removing');
    assert.equal(JSON.parse(fs.readFileSync(ready.registryPath)).diagnostics.retirement.state, 'complete');
    assert.equal(fs.existsSync(oldIndex.storage.bundle.path), false);
    assert.deepEqual(fs.readFileSync(slot(input)), before);
    const current = JSON.parse(before);
    assert.deepEqual(await (await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
    t.diagnostic(JSON.stringify({ interruptedRetirement: { interrupted, intent, recovered, repeated, current } }));
});

for (const damage of ['unregistered-file', 'unproved-absence']) test(`retirement refuses ${damage} without losing the current readable slot`, async t => {
    const input = outcomeFixture(t);
    const previous = await failure(t, input, 'unit', Buffer.from('owned previous evidence'));
    const bundle = previous.summary.diagnosticIndex.storage.bundle.path;
    if (damage === 'unregistered-file') fs.writeFileSync(bundle + '/unregistered', 'unregistered retained bytes');
    const preserved = inventory(bundle);
    let moved = false;
    const hook = damage === 'unproved-absence' && createHook({ init(id, type) {
        if (moved || type !== 'PROCESSWRAP' || JSON.parse(fs.readFileSync(slot(input))).runId === previous.run.runId) return;
        const stack = new Error('actual superseded bundle absence').stack;
        if (!stack.includes('executionEnded') || !stack.includes('/resources/diagnostics.js:')) return;
        moved = true; fs.renameSync(bundle, bundle + '-held');
    } });
    hook && hook.enable();
    const current = await failure(t, input, 'unit', Buffer.from('current readable evidence'));
    hook && hook.disable();
    if (hook) assert.equal(moved, true);
    assert.equal(current.summary.status, 'failed');
    assert.ok(current.summary.errors.some(error => /retire|unregistered|ENOENT/i.test(error.message)));
    assert.deepEqual(inventory(damage === 'unregistered-file' ? bundle : bundle + '-held'), preserved);
    assert.equal(JSON.parse(fs.readFileSync(previous.run.registryPath)).diagnostics.retirement, null);
    const index = JSON.parse(fs.readFileSync(slot(input)));
    assert.equal(index.runId, current.run.runId);
    assert.deepEqual(await (await api()).readDiagnostic(index, index.artifacts.find(ref => ref.name === 'evidence.bin')), Buffer.from('current readable evidence'));
});

test('retirement listener refusal preserves the interrupted predecessor inventory', async t => {
    const input = outcomeFixture(t);
    const previous = await nativePublisher(t, input, 'interrupt-after-slot');
    const ready = await previous.next('ready'); previous.child.send({ type: 'finish' });
    const interrupted = await previous.next('interrupted-after-slot');
    previous.child.kill('SIGKILL');
    const oldExit = await previous.exited;
    const snapshot = JSON.parse(fs.readFileSync(ready.registryPath));
    const directory = path.dirname(ready.registryPath);
    const execution = snapshot.custodyBoundary.path + '/execution.json';
    const executionBefore = fs.readFileSync(execution);
    const before = inventory(directory);
    const server = net.createServer(socket => socket.end('unrelated listener'));
    server.listen(snapshot.owner.control.port, '127.0.0.1'); await once(server, 'listening');
    let complete; let exit; let after;
    try {
        const replacing = await nativePublisher(t, input, 'publish');
        await replacing.next('ready'); replacing.child.send({ type: 'finish' });
        complete = await replacing.next('complete'); exit = await replacing.exited;
        after = inventory(directory);
        const socket = net.connect({ host: '127.0.0.1', port: snapshot.owner.control.port });
        await once(socket, 'connect'); socket.resume(); socket.end(); await once(socket, 'close');
    } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    const selected = fs.readFileSync(slot(input));
    t.diagnostic(JSON.stringify({ retirementListenerRefusal: { interrupted, oldExit, exit, before, after, executionBefore: executionBefore.toString('base64'), complete, selected: selected.toString('base64') } }));
    assert.deepEqual(oldExit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.deepEqual(after, before);
    assert.deepEqual(fs.readFileSync(execution), executionBefore);
    assert.ok(nodes(complete.summary.errors).some(error => error.code === 'EADDRINUSE'));
    assert.ok(nodes(complete.summary.errors).some(error => property(error.publication, 'published') === true && property(error.publication, 'stage') === 'cleanup'));
    const index = JSON.parse(selected);
    assert.equal(index.runId, complete.summary.runId);
    assert.deepEqual(await (await api()).readDiagnostic(index, index.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
    await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    assert.deepEqual(fs.readFileSync(slot(input)), selected);
});

for (const damage of ['committed-removal', 'escaping-version']) test(`foreign retirement refuses ${damage} before predecessor mutation`, async t => {
    const input = outcomeFixture(t);
    const previous = await nativePublisher(t, input, 'publish');
    const ready = await previous.next('ready'); previous.child.send({ type: 'finish' });
    await previous.next('complete');
    assert.deepEqual(await previous.exited, { code: 0, signal: null });
    const predecessor = JSON.parse(fs.readFileSync(ready.registryPath));
    assert.ok(predecessor.resources.every(record => ['disposed', 'released'].includes(record.state)));
    assert.equal(predecessor.diagnostics.retirement, null);
    const replacing = await nativePublisher(t, input, 'pause-retirement');
    const latest = await replacing.next('ready'); replacing.child.send({ type: 'finish' });
    const entrance = await replacing.next('retirement-inspection');
    const selected = fs.readFileSync(slot(input));
    const actual = fs.lstatSync(slot(input));
    const selectedIdentity = { dev: actual.dev, ino: actual.ino, length: selected.length, sha256: sha(selected), bytes: selected.toString('base64') };
    assert.equal(JSON.parse(selected).runId, latest.runId);
    assert.equal(entrance.current.runId, latest.runId);
    if (damage === 'committed-removal') predecessor.diagnostics.indexes.find(receipt => receipt.version === predecessor.diagnosticIndex.version).removing = true;
    else {
        const version = '/../../../slots/' + path.basename(slot(input), '.json');
        assert.equal(path.join(predecessor.diagnostics.bundle.path, `index-${version}.json`), slot(input));
        predecessor.diagnostics.indexes.push({ version, removing: true, dev: actual.dev, ino: actual.ino, length: selected.length, sha256: sha(selected) });
    }
    fs.writeFileSync(ready.registryPath, JSON.stringify(predecessor, null, 2) + '\n');
    const before = { run: inventory(path.dirname(ready.registryPath)), bundle: inventory(predecessor.diagnostics.bundle.path) };
    replacing.child.kill('SIGCONT');
    const complete = await replacing.next('complete');
    const exit = await replacing.exited;
    const results = [{ status: complete.summary.status, errors: complete.summary.errors, after: { run: inventory(path.dirname(ready.registryPath)), bundle: inventory(predecessor.diagnostics.bundle.path) }, selected: fs.existsSync(slot(input)) && inventory(path.dirname(slot(input))).find(file => file.name === path.basename(slot(input))) }];
    for (const repeat of [false, true]) {
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        results.push({ repeat, status: result.status, errors: result.error && serializeFailure(result.error), report: result.error?.report ?? result.value, after: { run: inventory(path.dirname(ready.registryPath)), bundle: inventory(predecessor.diagnostics.bundle.path) }, selected: fs.existsSync(slot(input)) && inventory(path.dirname(slot(input))).find(file => file.name === path.basename(slot(input))) });
    }
    t.diagnostic(JSON.stringify({ foreignRemovalAdmission: { damage, ready, latest, entrance, predecessor, selectedIdentity, before, exit, complete, results } }));
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(results[0].status, 'failed');
    assert.ok(nodes(complete.summary.errors).some(error => property(error.publication, 'published') === true && property(error.publication, 'stage') === 'cleanup'));
    for (const result of results) {
        if (result.repeat !== undefined) assert.equal(result.status, 'rejected');
        assert.ok(nodes(result.errors).some(error => /invalid (superseded index removal authority|diagnostic index integrity metadata)/.test(error.message)));
        assert.deepEqual(result.after, before);
        assert.equal(result.selected.dev, selectedIdentity.dev);
        assert.equal(result.selected.ino, selectedIdentity.ino);
        assert.equal(result.selected.bytes, selectedIdentity.bytes);
    }
    const current = JSON.parse(selected);
    assert.deepEqual(await (await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
});

test('retirement refuses a missing published slot without clearing pending work on repeat recovery', async t => {
    const input = outcomeFixture(t);
    const previous = await nativePublisher(t, input, 'hold-final');
    const ready = await previous.next('ready'); previous.child.send({ type: 'finish' });
    await previous.next('held-final-save');
    const current = await nativePublisher(t, input, 'hold-final');
    const latest = await current.next('ready'); current.child.send({ type: 'finish' });
    await current.next('held-final-save');
    previous.child.kill('SIGCONT'); current.child.kill('SIGCONT');
    const exits = await Promise.all([previous.exited, current.exited]);
    const initial = JSON.parse(fs.readFileSync(latest.registryPath));
    const slotPath = slot(input);
    fs.renameSync(slotPath, slotPath + '.selected');
    const before = inventory(input.projectRoot);
    const results = [];
    for (const repeat of [false, true]) {
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        results.push({ repeat, status: result.status, error: result.error && serializeFailure(result.error), report: result.error?.report ?? result.value, inventory: inventory(input.projectRoot) });
    }
    const after = JSON.parse(fs.readFileSync(latest.registryPath));
    t.diagnostic(JSON.stringify({ missingPublishedSlot: { ready, latest, exits, slotPath, initial, before, results, after } }));
    assert.deepEqual(exits, [{ code: 0, signal: null }, { code: 0, signal: null }]);
    assert.equal(initial.diagnostics.retentionPending, true);
    assert.equal(initial.diagnostics.publication.published, true);
    for (const result of results) {
        assert.equal(result.status, 'rejected');
        assert.ok(nodes(result.error).some(error => error.code === 'ENOENT'));
        assert.ok(nodes(result.error).some(error => error.message?.includes(latest.runId) && error.message.includes(slotPath) && error.message.includes('unit')));
        assert.deepEqual(result.report.recovered, []);
        assert.deepEqual(result.inventory, before);
    }
    assert.equal(after.diagnostics.retentionPending, true);
    assert.deepEqual(after.errors, initial.errors);
    assert.equal(fs.existsSync(slotPath), false);
});

for (const [published, missing] of [[false, true], [true, false], [true, true]]) test(`interrupted prepared ${published ? 'same-run retry' : 'unpublished run'} with ${missing ? 'missing' : 'valid'} slot preserves publication authority`, async t => {
    const input = outcomeFixture(t);
    const destination = input.root + '/selected-environment';
    const native = await nativePublisher(t, input, 'publish', 'unit', { pausePrepared: !published, failCleanup: published, exportEnvironmentTo: published ? destination : undefined });
    const ready = await native.next('ready'); native.child.send({ type: 'finish' });
    let writer = native;
    let initial;
    let archiveBefore;
    let selected;
    if (published) {
        await native.next('complete');
        assert.deepEqual(await native.exited, { code: 0, signal: null });
        initial = JSON.parse(fs.readFileSync(ready.registryPath));
        selected = fs.readFileSync(slot(input));
        archiveBefore = inventory(destination);
        assert.equal(initial.environmentExport.state, 'complete');
        assert.ok(initial.resources.some(record => record.state === 'cleanup-failed'));
        fs.chmodSync(ready.data, 0o700);
        writer = await nativePublisher(t, input, 'recover', 'unit', { pausePrepared: true, targetRegistry: ready.registryPath });
    }
    const stopped = await writer.next('prepared-before-slot');
    writer.child.kill('SIGKILL');
    const exit = await writer.exited;
    const prepared = JSON.parse(fs.readFileSync(ready.registryPath));
    const slotPath = slot(input);
    assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(stopped.snapshot, prepared);
    assert.equal(prepared.diagnostics.stage, 'prepared');
    assert.equal(prepared.diagnostics.publication.published, false);
    assert.equal(prepared.diagnostics.retirement, null);
    assert.ok(prepared.diagnostics.pending.some(pending => pending.path.startsWith(slotPath + '-') && pending.ino !== null && fs.statSync(pending.path).ino === pending.ino));
    if (published) {
        assert.deepEqual(prepared.diagnosticIndex, initial.diagnosticIndex);
        assert.deepEqual(prepared.errors, initial.errors);
        assert.deepEqual(fs.readFileSync(slotPath), selected);
        assert.equal(fs.existsSync(ready.data), false);
        if (missing) fs.renameSync(slotPath, slotPath + '.held');
    } else {
        assert.equal(prepared.diagnosticIndex, null);
        assert.equal(fs.existsSync(prepared.diagnostics.bundle.path), true);
        assert.equal(fs.existsSync(slotPath), false);
    }
    const before = inventory(input.projectRoot);
    const refused = published && missing;
    const results = [];
    for (const repeat of refused ? [false, true] : [false]) {
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        results.push({ repeat, status: result.status, error: result.error && serializeFailure(result.error), report: result.error?.report ?? result.value, after: inventory(input.projectRoot) });
    }
    const after = JSON.parse(fs.readFileSync(ready.registryPath));
    t.diagnostic(JSON.stringify({ preparedPublication: { published, missing, ready, initial, stopped, prepared, selected: selected?.toString('base64'), before, results, after } }));
    for (const result of results) {
        assert.equal(result.status, refused ? 'rejected' : 'fulfilled');
        if (refused) {
            assert.deepEqual(result.report.recovered, []);
            assert.ok(nodes(result.error).some(error => error.code === 'ENOENT'));
            assert.ok(nodes(result.error).some(error => error.message?.includes(prepared.runId) && error.message.includes(slotPath) && error.message.includes('unit')));
            assert.deepEqual(result.after, before);
        } else assert.deepEqual(result.report.recovered, [ready.runId]);
    }
    assert.deepEqual(after.errors, prepared.errors);
    if (refused) {
        assert.deepEqual(after, prepared);
        assert.equal(fs.existsSync(slotPath), false);
    } else {
        const index = JSON.parse(fs.readFileSync(slotPath));
        assert.deepEqual(await (await api()).readDiagnostic(index, index.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from('actual native evidence'));
        if (published) assert.deepEqual(fs.readFileSync(slotPath), selected);
    }
    if (published) {
        assert.equal(after.environmentExport.state, 'complete');
        assert.deepEqual(inventory(destination), archiveBefore);
    }
});

for (const boundary of ['initial-temporary', 'initial-renamed', 'initial-removal-durability']) test(`initial replacement work remains eligible through ${boundary} interruption`, async t => {
    const input = outcomeFixture(t);
    const native = await nativePublisher(t, input, 'publish', 'unit', { failCleanup: true });
    const ready = await native.next('ready'); native.child.send({ type: 'finish' });
    await native.next('complete');
    assert.deepEqual(await native.exited, { code: 0, signal: null });
    const initial = JSON.parse(fs.readFileSync(ready.registryPath));
    const selected = fs.readFileSync(slot(input));
    const selectedIdentity = fs.lstatSync(slot(input));
    const oldFile = path.join(initial.diagnostics.bundle.path, `index-${initial.diagnosticIndex.version}.json`);
    const oldBytes = fs.readFileSync(oldFile);
    assert.equal(initial.diagnostics.stage, 'published');
    assert.equal(initial.diagnostics.retentionPending, false);
    assert.ok(initial.resources.some(record => record.state === 'cleanup-failed'));
    fs.chmodSync(ready.data, 0o700);
    const writer = await nativePublisher(t, input, 'recover', 'unit', { targetRegistry: ready.registryPath, indexFault: boundary === 'initial-removal-durability' ? 'initial-temporary' : boundary });
    const fault = await writer.next('index-persistence-fault');
    writer.child.kill('SIGKILL');
    const exit = await writer.exited;
    const interrupted = JSON.parse(fs.readFileSync(ready.registryPath));
    const pending = interrupted.diagnostics.pending.find(pending => pending.path === fault.pending.path);
    const actual = fs.lstatSync(fault.filename);
    const present = { path: fault.filename, dev: actual.dev, ino: actual.ino, bytes: fs.readFileSync(fault.filename).toString('base64') };
    const durability = [];
    let attempt = 'fault'; let faulted = false;
    const hook = boundary === 'initial-removal-durability' && createHook({ init(id, type) {
        if (!type.startsWith('FSREQ') || attempt === 'fault' && faulted || fs.existsSync(fault.filename)) return;
        const stack = new Error('actual pending removal durability').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/diagnostics.js:') || stack.includes('/resources/registry.js:')) return;
        const snapshot = JSON.parse(fs.readFileSync(ready.registryPath));
        if (!snapshot.diagnostics.pending.some(entry => entry.path === pending.path)) return;
        const open = descriptors();
        let fd; let selected;
        for (const line of open.split('\n')) { if (line.startsWith('f')) fd = Number.parseInt(line.slice(1)); if (line === 'n' + initial.diagnostics.bundle.path) selected = fd; }
        assert.ok(Number.isSafeInteger(selected));
        const directory = fs.fstatSync(selected);
        assert.equal(directory.isDirectory(), true);
        durability.push({ attempt, id, nativeType: type, stack, descriptor: selected, dev: directory.dev, ino: directory.ino, open });
        if (attempt === 'fault') { faulted = true; fs.closeSync(selected); }
    } });
    hook && hook.enable();
    const failed = hook && await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    attempt = 'repair';
    const recovered = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    hook && hook.disable();
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const after = JSON.parse(fs.readFileSync(ready.registryPath));
    const readable = await settled((await api()).readDiagnostic(JSON.parse(selected), initial.diagnosticIndex.artifacts.find(ref => ref.name === 'native.bin')));
    const temporaryPresent = fs.existsSync(pending.path);
    const replacementPresent = fs.existsSync(fault.filename);
    t.diagnostic(JSON.stringify({ initialReplacement: { boundary, ready, initial, selected: selected.toString('base64'), selectedIdentity: { dev: selectedIdentity.dev, ino: selectedIdentity.ino }, oldBytes: oldBytes.toString('base64'), fault, exit, interrupted, present, durability, failed: failed && { status: failed.status, error: failed.error && serializeFailure(failed.error) }, recovered: recovered.status, report: recovered.error?.report ?? recovered.value, error: recovered.error && serializeFailure(recovered.error), repeated: repeated.status, repeatedReport: repeated.error?.report ?? repeated.value, after, temporaryPresent, replacementPresent, readable: readable.status } }));
    assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
    assert.deepEqual(interrupted, fault.snapshot);
    assert.equal(interrupted.writer.native.pid, writer.child.pid);
    assert.equal(interrupted.recovery.state, 'recovering');
    assert.ok(interrupted.resources.every(record => ['disposed', 'released'].includes(record.state)));
    assert.equal(interrupted.diagnostics.stage, 'published');
    assert.equal(interrupted.diagnostics.retentionPending, true);
    assert.deepEqual(interrupted.diagnosticIndex, initial.diagnosticIndex);
    assert.notEqual(fault.filename, oldFile);
    assert.equal(pending.dev, actual.dev); assert.equal(pending.ino, actual.ino);
    assert.deepEqual(fault.actual, { dev: actual.dev, ino: actual.ino, size: actual.size });
    assert.equal(fault.selected, selected.toString('base64')); assert.equal(fault.oldBytes, oldBytes.toString('base64'));
    assert.equal(recovered.status, 'fulfilled');
    assert.deepEqual(recovered.value.recovered, [ready.runId]);
    assert.equal(repeated.status, 'fulfilled');
    assert.deepEqual(repeated.value.recovered, []);
    assert.equal(temporaryPresent, false);
    assert.equal(replacementPresent, false);
    if (hook) {
        assert.equal(failed.status, 'rejected');
        assert.ok(nodes(failed.error).some(error => error.code === 'EBADF'));
        assert.deepEqual(durability.map(receipt => receipt.attempt), ['fault', 'repair']);
        for (const receipt of durability) { assert.equal(receipt.dev, initial.diagnostics.bundle.dev); assert.equal(receipt.ino, initial.diagnostics.bundle.ino); }
    }
    assert.deepEqual(after.diagnostics.pending, []);
    assert.equal(after.diagnostics.retentionPending, false);
    assert.deepEqual(after.diagnosticIndex, initial.diagnosticIndex);
    assert.deepEqual(after.errors.slice(0, initial.errors.length), initial.errors);
    assert.deepEqual(fs.readFileSync(slot(input)), selected);
    assert.equal(fs.lstatSync(slot(input)).dev, selectedIdentity.dev); assert.equal(fs.lstatSync(slot(input)).ino, selectedIdentity.ino);
    assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
    assert.equal(readable.status, 'fulfilled'); assert.deepEqual(readable.value, Buffer.from('actual native evidence'));
});

for (const boundary of ['file-sync', 'rename', 'index-sync', 'slot-sync', 'bundle-sync', 'bundle-registry']) test(`returned publication errors retain ownership through ${boundary}`, async t => {
    const input = outcomeFixture(t);
    const initialPublication = boundary.startsWith('bundle-');
    const native = await nativePublisher(t, input, 'publish', 'unit', initialPublication ? { atomicFault: boundary } : { failCleanup: true });
    const ready = await native.next('ready');
    native.child.send({ type: 'finish' });
    let writer = native;
    let original;
    let originalSlot;
    if (!initialPublication) {
        await native.next('complete');
        assert.deepEqual(await native.exited, { code: 0, signal: null });
        original = JSON.parse(fs.readFileSync(ready.registryPath));
        originalSlot = fs.readFileSync(slot(input));
        fs.chmodSync(ready.data, 0o700);
        writer = await nativePublisher(t, input, 'recover', 'unit', { targetRegistry: ready.registryPath, atomicFault: boundary });
    }
    const fault = await writer.next('atomic-publication-fault');
    const exit = await writer.exited;
    const failed = JSON.parse(fs.readFileSync(ready.registryPath));
    const failedPublication = writer.events.find(event => event.type === 'recovery-failed' || event.type === 'publication-failed' || event.type === 'complete');
    const bundle = path.join(input.projectRoot, 'test-results/harness/diagnostics/bundles', ready.runId);
    fs.chmodSync(path.dirname(ready.registryPath), 0o700);
    fs.chmodSync(bundle, 0o700);
    const dependencies = failed.diagnostics.indexes.map(receipt => {
        const filename = path.join(bundle, 'index-' + receipt.version + '.json');
        const actual = fs.lstatSync(filename);
        const bytes = fs.readFileSync(filename);
        return { receipt, dev: actual.dev, ino: actual.ino, length: bytes.length, sha256: sha(bytes) };
    });
    const synchronizations = [];
    const hook = createHook({ init(id, type) {
        if (!type.startsWith('FSREQ')) return;
        const stack = new Error('actual recovery directory synchronization').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/diagnostics.js:') || stack.includes('/resources/registry.js:')) return;
        let descriptor;
        for (const line of descriptors().split('\n')) {
            if (line.startsWith('f')) descriptor = Number.parseInt(line.slice(1));
            if (line.startsWith('n' + input.projectRoot + '/test-results/harness/diagnostics/') && Number.isSafeInteger(descriptor) && fs.fstatSync(descriptor).isDirectory()) synchronizations.push({ id, path: line.slice(1) });
        }
    } });
    hook.enable();
    let recovered;
    try { recovered = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] })); }
    finally { hook.disable(); }
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const after = JSON.parse(fs.readFileSync(ready.registryPath));
    t.diagnostic(JSON.stringify({ returnedPublicationRecovery: { boundary, fault, exit, failed, recovered: recovered.status, report: recovered.error?.report ?? recovered.value, error: recovered.error && serializeFailure(recovered.error), repeated: repeated.status, after, synchronizations } }));
    assert.equal(recovered.status, 'fulfilled');
    const selected = fs.readFileSync(slot(input));
    const current = JSON.parse(selected);
    const readable = await settled((await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin')));
    const pendingWorkPresent = fault.pending && (fs.existsSync(fault.pending.path) || boundary === 'index-sync' && fs.existsSync(fault.filename));
    const versions = fs.readdirSync(bundle).sort();
    const successor = await failure(t, input, 'unit', Buffer.from('successor after publication repair'));
    t.diagnostic(JSON.stringify({ returnedPublicationSettlement: { boundary, dependencies, selected: selected.toString('base64'), pendingWorkPresent, versions, oldBundlePresent: fs.existsSync(bundle), successor: successor.summary.diagnosticIndex } }));
    assert.deepEqual(exit, { code: initialPublication && boundary !== 'bundle-registry' ? 0 : 1, signal: null });
    assert.ok(nodes(failedPublication.error ?? failedPublication.summary.errors).some(error => error.code === (boundary === 'rename' ? 'EACCES' : 'EBADF')));
    assert.deepEqual(recovered.value.recovered, [ready.runId]);
    assert.equal(repeated.status, 'fulfilled'); assert.deepEqual(repeated.value.recovered, []);
    assert.deepEqual(after.errors.slice(0, failed.errors.length), failed.errors);
    for (const dependency of dependencies) for (const key of ['dev', 'ino', 'length', 'sha256']) assert.equal(dependency[key], dependency.receipt[key]);
    assert.deepEqual(after.diagnostics.pending, []); assert.equal(after.diagnostics.retentionPending, false);
    if (!initialPublication) assert.equal(pendingWorkPresent, false);
    assert.deepEqual(versions, ['index-' + after.diagnosticIndex.version + '.json', 'objects'].sort());
    assert.equal(readable.status, 'fulfilled'); assert.deepEqual(readable.value, Buffer.from('actual native evidence'));
    if (initialPublication) {
        assert.ok(failed.diagnostics.indexes.length > 0);
        for (const directory of ['bundles', 'staging']) assert.ok(synchronizations.some(entry => entry.path === path.join(path.dirname(path.dirname(bundle)), directory)));
    } else {
        const pending = failed.diagnostics.pending.find(entry => entry.path === fault.pending.path);
        assert.ok(pending); assert.equal(pending.dev, fault.file.dev); assert.equal(pending.ino, fault.file.ino);
        assert.ok(synchronizations.some(entry => entry.path === path.dirname(fault.filename)));
        if (boundary !== 'slot-sync') assert.deepEqual(selected, originalSlot);
        else assert.notEqual(current.version, original.diagnosticIndex.version);
    }
    assert.equal(fs.existsSync(bundle), false);
    assert.ok(successor.summary.diagnosticIndex);
});

for (const boundary of ['normal', 'reference-prepare', 'reference-durability', 'cleanup-failure', 'inventory-prepare', 'inventory-durability', 'interrupted-removal', 'retired-removal', 'unproved-absence', 'changed-removal']) test(`same-run replacement preserves committed dependencies through ${boundary}`, async t => {
    const input = outcomeFixture(t);
    const native = await nativePublisher(t, input, 'publish', 'unit', { failCleanup: true });
    const ready = await native.next('ready'); native.child.send({ type: 'finish' });
    await native.next('complete');
    assert.deepEqual(await native.exited, { code: 0, signal: null });
    const initial = JSON.parse(fs.readFileSync(ready.registryPath));
    const before = fs.readFileSync(slot(input));
    const oldFile = path.join(initial.diagnostics.bundle.path, `index-${initial.diagnosticIndex.version}.json`);
    const oldBytes = fs.readFileSync(oldFile);
    assert.deepEqual(oldBytes, before);
    assert.ok(initial.resources.some(record => record.state === 'cleanup-failed'));
    fs.chmodSync(ready.data, 0o700);
    const writer = await nativePublisher(t, input, 'recover', 'unit', { targetRegistry: ready.registryPath, indexFault: boundary === 'normal' ? undefined : boundary });
    const interruptedRemoval = ['interrupted-removal', 'retired-removal'].includes(boundary);
    if (interruptedRemoval) { await writer.next('index-persistence-fault'); writer.child.kill('SIGKILL'); }
    const exit = await writer.exited;
    const selected = fs.readFileSync(slot(input));
    const current = JSON.parse(selected);
    const interrupted = JSON.parse(fs.readFileSync(ready.registryPath));
    const oldPresent = fs.existsSync(oldFile);
    const retainedOld = oldPresent && fs.readFileSync(oldFile).toString('base64');
    const readable = await settled((await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'native.bin')));
    fs.chmodSync(path.dirname(ready.registryPath), 0o700);
    fs.chmodSync(current.storage.bundle.path, 0o700);
    const refused = [];
    if (['unproved-absence', 'changed-removal'].includes(boundary)) {
        const inventoryBefore = inventory(input.projectRoot);
        for (const repeat of [false, true]) {
            const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
            refused.push({ repeat, status: result.status, error: result.error && serializeFailure(result.error), after: inventory(input.projectRoot) });
            assert.equal(result.status, 'rejected');
            assert.deepEqual(inventory(input.projectRoot), inventoryBefore);
        }
        if (boundary === 'unproved-absence') fs.renameSync(input.root + '/held-index', oldFile);
        else fs.writeFileSync(oldFile, oldBytes);
    }
    const replacing = boundary === 'retired-removal' && await failure(t, input, 'unit', Buffer.from('current successor evidence'));
    const finalSelected = fs.readFileSync(slot(input));
    const recovered = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const after = JSON.parse(fs.readFileSync(ready.registryPath));
    t.diagnostic(JSON.stringify({ committedReplacement: { boundary, ready, initial, before: before.toString('base64'), exit, selected: selected.toString('base64'), current, interrupted, oldPresent, retainedOld, readable: readable.status, refused, finalSelected: finalSelected.toString('base64'), recovered: recovered.status, error: recovered.error && serializeFailure(recovered.error), repeated: repeated.status, repeatedError: repeated.error && serializeFailure(repeated.error), after } }));
    assert.deepEqual(exit, interruptedRemoval ? { code: null, signal: 'SIGKILL' } : { code: boundary === 'normal' ? 0 : 1, signal: null });
    assert.notEqual(current.version, initial.diagnosticIndex.version);
    assert.equal(current.runId, initial.runId);
    assert.equal(readable.status, 'fulfilled');
    assert.deepEqual(readable.value, Buffer.from('actual native evidence'));
    assert.deepEqual(interrupted.errors.slice(0, initial.errors.length), initial.errors);
    if (boundary !== 'normal') {
        const fault = writer.events.find(event => event.type === 'index-persistence-fault');
        assert.ok(fault);
        assert.equal(interrupted.diagnostics.retentionPending, true);
        if (boundary.startsWith('reference-') || boundary === 'cleanup-failure') {
            assert.equal(oldPresent, true);
            assert.equal(retainedOld, oldBytes.toString('base64'));
        }
        if (!interruptedRemoval) {
            const failed = writer.events.find(event => event.type === 'recovery-failed');
            assert.ok(failed);
            if (['reference-prepare', 'inventory-prepare', 'cleanup-failure'].includes(boundary)) assert.ok(nodes(failed.error).some(error => error.code === 'EACCES'));
            if (boundary.endsWith('durability')) assert.ok(nodes(failed.error).some(error => error.code === 'EBADF'));
            if (boundary.startsWith('reference-') || boundary.startsWith('inventory-')) {
                const stage = boundary.endsWith('durability') ? 'durability' : 'prepare';
                assert.ok(nodes(failed.error).some(error => property(error.publication, 'stage') === stage && property(error.publication, 'published') === (stage === 'durability')));
            }
            if (boundary.startsWith('reference-')) assert.ok(nodes(failed.error).some(error => property(error.publication, 'stage') === 'durability' && property(error.publication, 'published') === true && property(error.publication, 'slotPath') === slot(input)));
        }
        if (boundary === 'reference-prepare') assert.deepEqual(interrupted.diagnosticIndex, initial.diagnosticIndex);
        else assert.deepEqual(interrupted.diagnosticIndex, current);
        if (['cleanup-failure', 'inventory-prepare', 'changed-removal', 'interrupted-removal', 'retired-removal'].includes(boundary)) assert.equal(interrupted.diagnostics.indexes.find(receipt => receipt.version === initial.diagnosticIndex.version).removing, true);
        if (boundary.startsWith('inventory-') || interruptedRemoval) assert.equal(oldPresent, false);
        if (boundary === 'unproved-absence') assert.equal(interrupted.diagnostics.indexes.find(receipt => receipt.version === initial.diagnosticIndex.version).removing, undefined);
    }
    assert.equal(recovered.status, 'fulfilled');
    assert.equal(repeated.status, 'fulfilled');
    assert.deepEqual(fs.readFileSync(slot(input)), finalSelected);
    assert.deepEqual(after.diagnosticIndex, current);
    assert.deepEqual(after.errors.slice(0, initial.errors.length), initial.errors);
    assert.equal(after.diagnostics.retentionPending, false);
    assert.equal(fs.existsSync(oldFile), false);
    if (replacing) {
        assert.equal(after.diagnostics.retirement.state, 'complete');
        assert.equal(fs.existsSync(current.storage.bundle.path), false);
        const index = JSON.parse(finalSelected);
        assert.equal(index.runId, replacing.run.runId);
        assert.deepEqual(await (await api()).readDiagnostic(index, index.artifacts.find(ref => ref.name === 'evidence.bin')), Buffer.from('current successor evidence'));
        return;
    }
    assert.deepEqual(finalSelected, selected);
    assert.deepEqual(after.diagnostics.indexes.map(receipt => receipt.version), [current.version]);
    const receipt = after.diagnostics.indexes[0];
    const filename = path.join(current.storage.bundle.path, `index-${current.version}.json`);
    assert.deepEqual(fs.readFileSync(filename), selected);
    assert.equal(fs.statSync(filename).ino, receipt.ino);
    assert.equal(selected.length, receipt.length);
    assert.equal(sha(selected), receipt.sha256);
});

test('concluded execution releases profile custody without ending its native process', async t => {
    const input = outcomeFixture(t);
    const run = await createRun(options(input));
    const scope = await run.scope({ kind: 'case', label: 'profile release failure' });
    await scope.directory('profile data');
    const slots = path.dirname(slot(input));
    const lock = slot(input).slice(0, -5) + '.lock';
    let fault;
    const hook = createHook({ init(id, type) {
        if (fault || !type.startsWith('FSREQ') || run.registry.diagnostics.publication?.stage !== 'complete' || !fs.existsSync(lock)) return;
        const stack = new Error('actual profile unlock permission failure').stack;
        if (!stack.includes('/resources/registry.js:') || !stack.includes('fsync')) return;
        fault = { id, type, stack, lock: fs.readFileSync(lock, 'utf8') };
        fs.chmodSync(slots, 0o500);
    } });
    hook.enable();
    let first;
    try { first = await run.finish({ status: 'failed', error: new Error('profile assertion') }); }
    finally { hook.disable(); fs.chmodSync(slots, 0o700); }
    assert.ok(fault);
    assert.ok(nodes(first.errors).some(error => error.code === 'EACCES'));
    const original = fs.lstatSync(lock);
    let observations = 0; let releasedExternally = false;
    const guard = createHook({ init(id, type) {
        if (releasedExternally || !['PROCESSWRAP', 'FSREQPROMISE'].includes(type) || !fs.existsSync(lock) || fs.lstatSync(lock).ino !== original.ino) return;
        const stack = new Error('actual profile contention observation').stack;
        if (!stack.includes('/resources/diagnostics.js:') || !stack.includes('readProcessIdentity')) return;
        if (++observations < 8) return;
        releasedExternally = true; fs.unlinkSync(lock);
    } });
    guard.enable();
    let next;
    try { next = await failure(t, input); }
    finally { guard.disable(); }
    t.diagnostic(JSON.stringify({ concludedProfileCustody: { fault, releasedExternally, observations, firstRun: run.runId, nextRun: next.run.runId } }));
    assert.equal(releasedExternally, false, 'a concluded execution must release its own profile custody without an external release');
    assert.equal(next.summary.errors.length, 1);
    assert.equal(fs.existsSync(lock), false);
});

test('overtaken same-run retry preserves acyclic selected lineage', async t => {
    const input = outcomeFixture(t);
    const native = await nativePublisher(t, input, 'publish', 'unit', { failCleanup: true });
    const ready = await native.next('ready'); native.child.send({ type: 'finish' });
    await native.next('complete'); assert.deepEqual(await native.exited, { code: 0, signal: null });
    fs.chmodSync(ready.data, 0o700);
    const writer = await nativePublisher(t, input, 'recover', 'unit', { targetRegistry: ready.registryPath, pauseBeforeLock: true });
    const paused = await writer.next('retry-before-lock');
    const successor = await failure(t, input, 'unit', Buffer.from('overtaking successor'));
    const selected = fs.readFileSync(slot(input));
    writer.child.kill('SIGCONT');
    const exit = await writer.exited;
    const recovered = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const lineage = []; let owner = JSON.parse(fs.readFileSync(successor.run.registryPath));
    while (!lineage.includes(owner.runId)) {
        lineage.push(owner.runId);
        if (!owner.diagnostics.previous) break;
        owner = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(ready.registryPath)), owner.diagnostics.previous.runId, 'registry.json')));
    }
    t.diagnostic(JSON.stringify({ overtakenRetry: { paused, selected: selected.toString('base64'), exit, recovered: recovered.status, error: recovered.error && serializeFailure(recovered.error), repeated: repeated.status, lineage, last: owner.runId } }));
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(recovered.status, 'fulfilled'); assert.equal(repeated.status, 'fulfilled');
    assert.equal(owner.diagnostics.previous, null);
    assert.deepEqual(fs.readFileSync(slot(input)), selected);
    assert.deepEqual(await (await api()).readDiagnostic(JSON.parse(selected), JSON.parse(selected).artifacts[0]), Buffer.from('overtaking successor'));
    const latest = await failure(t, input);
    assert.equal(latest.summary.errors.length, 1);
});

for (const boundary of ['pending-sync', 'pending-save', 'discard-save', 'discard-completion', 'archive-save', 'archive-completion', 'archive-removal']) test(`staging settlement survives ${boundary}`, async t => {
    const input = outcomeFixture(t);
    let registryPath; let run; let pending; let scope;
    const destination = input.root + '/settled-environment';
    if (boundary.startsWith('pending-')) {
        const native = await nativePublisher(t, input, 'publish', 'unit', { atomicFault: 'file-sync' });
        const ready = await native.next('ready'); registryPath = ready.registryPath; native.child.send({ type: 'finish' });
        const fault = await native.next('atomic-publication-fault'); pending = fault.pending;
        assert.deepEqual(await native.exited, { code: 0, signal: null });
    } else {
        run = await createRun(options(input, 'unit', boundary.startsWith('archive-') ? { exportEnvironmentTo: destination } : {}));
        registryPath = run.registryPath;
        scope = await run.scope({ kind: 'case', label: 'staging completion retry' });
        const data = await scope.directory('staged original');
        fs.writeFileSync(data.path + '/binary', Buffer.from([0, 255, 13, 10]));
        await (await api()).captureDiagnostic(scope, { name: 'binary', bytes: Buffer.from([0, 255, 13, 10]), contentType: 'application/octet-stream' });
    }
    const before = JSON.parse(fs.readFileSync(registryPath));
    const staging = before.diagnostics.staging.path;
    let fault;
    if (boundary.startsWith('discard-')) { await run.dispose(); await run.registry.closeAuthority(); }
    if (boundary.startsWith('archive-')) await scope.dispose();
    if (boundary.endsWith('-save') && run) {
        fault = { boundary, directory: path.dirname(registryPath), snapshot: JSON.parse(fs.readFileSync(registryPath)) };
        fs.chmodSync(path.dirname(registryPath), 0o500);
    }
    const hook = createHook({ init(id, type) {
        if (fault || !type.startsWith('FSREQ')) return;
        const stack = new Error('actual destructive staging settlement boundary').stack;
        if (!stack.includes('fsync')) return;
        const archiveCommit = boundary === 'archive-completion' && run.registry.environmentExport.archive?.state === 'complete' && fs.existsSync(before.environmentExport.storage.path);
        const absent = archiveCommit || (boundary.startsWith('pending-') ? !fs.existsSync(pending.path) : boundary.startsWith('archive-') ? fs.existsSync(destination) && !fs.existsSync(before.environmentExport.storage.path) : !fs.existsSync(staging));
        if (!absent) return;
        if (archiveCommit ? !stack.includes('/resources/registry.js:') : !stack.includes('/resources/diagnostics.js:') || stack.includes('/resources/registry.js:')) return;
        fault = { id, type, stack, snapshot: JSON.parse(fs.readFileSync(registryPath)) };
        if (boundary === 'pending-sync') {
            let fd; let target;
            for (const line of descriptors().split('\n')) { if (line.startsWith('f')) fd = Number.parseInt(line.slice(1)); if (line === 'n' + staging) target = fd; }
            assert.ok(Number.isSafeInteger(target)); fs.closeSync(target);
        } else fs.chmodSync(path.dirname(registryPath), 0o500);
    } });
    hook.enable();
    let failed;
    try { failed = await settled(run ? run.finish({ status: 'passed' }) : recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] })); }
    finally { hook.disable(); fs.chmodSync(path.dirname(registryPath), 0o700); }
    const interrupted = JSON.parse(fs.readFileSync(registryPath));
    const archiveBefore = boundary.startsWith('archive-') && fs.existsSync(destination) && inventory(destination);
    if (boundary === 'archive-removal') {
        const manifest = fs.readFileSync(destination + '/environment.json');
        fs.writeFileSync(destination + '/environment.json', 'changed completed archive');
        const protectedBefore = inventory(input.projectRoot);
        const refusal = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        assert.equal(refusal.status, 'rejected');
        assert.deepEqual(inventory(input.projectRoot), protectedBefore);
        fs.writeFileSync(destination + '/environment.json', manifest);
    }
    const recovered = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const repeated = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    const after = JSON.parse(fs.readFileSync(registryPath));
    t.diagnostic(JSON.stringify({ stagingSettlement: { boundary, fault, failed: failed.status, error: failed.error && serializeFailure(failed.error), interrupted, recovered: recovered.status, recoveryError: recovered.error && serializeFailure(recovered.error), repeated: repeated.status, after } }));
    assert.ok(fault); assert.equal(failed.status, 'rejected');
    assert.equal(recovered.status, 'fulfilled'); assert.deepEqual(recovered.value.recovered, [after.runId]);
    assert.equal(repeated.status, 'fulfilled'); assert.deepEqual(repeated.value.recovered, []);
    assert.deepEqual(after.errors.slice(0, interrupted.errors.length), interrupted.errors);
    if (pending) assert.equal(fs.existsSync(pending.path), false);
    if (boundary.startsWith('archive-')) { assert.equal(after.environmentExport.state, 'complete'); if (archiveBefore) assert.deepEqual(inventory(destination), archiveBefore); }
    if (boundary.startsWith('discard-')) { assert.ok(['discarded', 'published'].includes(after.diagnostics.stage)); assert.equal(fs.existsSync(staging), false); }
});

test('startup log closure retains primary and close native errors', async t => {
    const input = outcomeFixture(t);
    const run = await createRun(options(input));
    const scope = await run.scope({ kind: 'case', label: 'actual native close failures' });
    const lease = await launchOwnedProcess(scope, { label: 'native close owner', command: [process.execPath, new URL('./fixtures/resource-child.mjs', import.meta.url).pathname, 'server', JSON.stringify({ report: input.report })], readyLine: 'resource-ready' });
    const log = run.registry.resources.find(record => record.resourceId === lease.resourceId).startupLog;
    let fd; let target;
    for (const line of descriptors().split('\n')) { if (line.startsWith('f')) fd = Number.parseInt(line.slice(1)); if (line === 'n' + log.path) target = fd; }
    assert.ok(Number.isSafeInteger(target)); fs.closeSync(target);
    const stopped = await settled(lease.stop());
    const original = new Error('original assertion with native close errors');
    const summary = await run.finish({ status: 'failed', error: original });
    const errors = nodes(stopped.error).filter(error => error instanceof Error && error.code === 'EBADF');
    t.diagnostic(JSON.stringify({ primaryCloseErrors: { errors: errors.map(error => serializeFailure(error)), summary: summary.errors.map(error => serializeFailure(error)) } }));
    assert.equal(stopped.status, 'rejected');
    assert.ok(errors.some(error => error.syscall === 'fsync'));
    assert.ok(errors.some(error => error.syscall === 'close'));
    assert.ok(summary.errors.includes(original));
    for (const error of errors) assert.ok(nodes(summary.errors).includes(error));
});

for (const mode of ['native-success', 'native-failure']) {
    test(`native resource staging precedes the actual late owner ${mode} result without publishing early`, async t => {
        const input = outcomeFixture(t);
        const native = await nativePublisher(t, input, mode);
        const before = await native.next('before-native-owner-result');
        assert.equal(before.dataPresent, false);
        assert.equal(before.snapshot.status, 'running');
        assert.equal(before.snapshot.diagnosticIndex, null);
        const completion = await native.next('native-complete');
        const exit = await native.exited;
        assert.equal(exit.code, mode === 'native-success' ? 0 : 1);
        if (mode === 'native-success') {
            assert.equal(completion.summary.status, 'passed');
            assert.equal(fs.existsSync(slot(input)), false);
            assert.equal(fs.existsSync(before.snapshot.diagnostics.staging.path), false);
        } else {
            assert.equal(completion.summary.status, 'failed');
            const index = JSON.parse(fs.readFileSync(slot(input)));
            const { readDiagnostic } = await api();
            assert.deepEqual(await readDiagnostic(index, index.artifacts.find(ref => ref.name === 'native.bin')), Buffer.from([0, 255, 42, 13, 10]));
            assert.ok(JSON.stringify(index.errors).includes('actual late native owner failure'));
        }
    });
}

test('already-retired predecessor tolerates reused historical control port without retaining bundle', async t => {
    const input = outcomeFixture(t);
    const first = await failure(t, input, 'unit', Buffer.from('retired ancestor evidence'));
    const firstRegistry = JSON.parse(fs.readFileSync(first.run.registryPath));
    const second = await failure(t, input, 'unit', Buffer.from('retiring successor evidence'));
    const retiredFirst = JSON.parse(fs.readFileSync(first.run.registryPath));
    assert.equal(retiredFirst.diagnostics.stage, 'retired');
    assert.equal(retiredFirst.diagnostics.retirement?.state, 'complete');
    assert.equal(retiredFirst.diagnostics.retentionPending, false);
    assert.equal(fs.existsSync(firstRegistry.diagnostics.bundle.path), false);
    const server = net.createServer(socket => socket.end('unrelated listener'));
    server.listen(firstRegistry.owner.control.port, '127.0.0.1');
    await once(server, 'listening');
    let third;
    try {
        third = await failure(t, input, 'unit', Buffer.from('current failure after historical port reuse'));
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    assert.deepEqual(third.summary.errors, [third.original]);
    assert.equal(fs.existsSync(second.summary.diagnosticIndex.storage.bundle.path), false);
    const current = JSON.parse(fs.readFileSync(slot(input)));
    assert.equal(current.runId, third.run.runId);
    assert.deepEqual(await (await api()).readDiagnostic(current, current.artifacts.find(ref => ref.name === 'evidence.bin')), Buffer.from('current failure after historical port reuse'));
});
