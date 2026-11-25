import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createRun } from '../resources/run.js';
import { captureDiagnostic } from '../resources/diagnostics.js';
import { serializeFailure } from '../resources/errors.js';
import { recoverRuns } from '../resources/recovery.js';
import { descriptors } from './process-native-control.mjs';

const input = JSON.parse(process.argv[2]);
const runtime = { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') };
let sequence = 0;
const emit = value => {
    const receipt = input.root + `/diagnostic-${process.pid}-${++sequence}.json`;
    fs.writeFileSync(receipt, JSON.stringify({ runtime, ...value }), { flag: 'wx' });
    const line = 'DIAGNOSTIC_PROOF ' + JSON.stringify({ receipt }) + '\n';
    assert.equal(fs.writeSync(process.stdout.fd, line), Buffer.byteLength(line));
};
const options = { projectRoot: input.projectRoot, profile: input.profile ?? 'unit', source: 'native-diagnostic-child', command: [process.execPath, ...process.argv.slice(1)], exportEnvironmentTo: input.exportEnvironmentTo };
const armAtomicFault = registryPath => {
    if (!input.atomicFault) return;
    let tripped = false;
    let completion;
    const hook = createHook({
        init(id, type) {
            if (tripped || completion || !type.startsWith('FSREQ')) return;
            const stack = new Error('actual diagnostic atomic publication failure').stack;
            if (!stack.includes('fsync') || !stack.includes('/resources/diagnostics.js:') || stack.includes('/resources/registry.js:')) return;
            const snapshot = JSON.parse(fs.readFileSync(registryPath));
            const stored = snapshot.diagnostics;
            const root = path.join(input.projectRoot, 'test-results/harness/diagnostics');
            const indexPending = stored.pending.find(entry => path.basename(entry.path).startsWith('index-') && entry.ino !== null);
            const slotPending = stored.pending.find(entry => path.dirname(entry.path) === root + '/slots' && entry.ino !== null);
            const pending = input.atomicFault === 'slot-sync' ? slotPending : indexPending;
            const bundleMove = input.atomicFault.startsWith('bundle-');
            let filename;
            let target;
            if (bundleMove) {
                filename = root + '/bundles/' + snapshot.runId;
                if (!fs.existsSync(filename)) return;
                target = root + '/bundles';
            } else {
                if (!pending) return;
                filename = ['file-sync', 'rename'].includes(input.atomicFault) ? pending.path : pending.path.slice(0, -41);
                if (!fs.existsSync(filename)) return;
                target = ['file-sync', 'rename'].includes(input.atomicFault) ? filename : path.dirname(filename);
            }
            const open = descriptors();
            let descriptor; let selected;
            for (const line of open.split('\n')) { if (line.startsWith('f')) descriptor = Number.parseInt(line.slice(1)); if (line === 'n' + target) selected = descriptor; }
            if (!Number.isSafeInteger(selected)) return;
            const actual = fs.fstatSync(selected);
            const file = fs.lstatSync(filename);
            const trip = () => {
                tripped = true; hook.disable();
                if (input.atomicFault === 'rename') fs.chmodSync(path.dirname(filename), 0o500);
                else fs.closeSync(selected);
                if (input.atomicFault === 'bundle-registry') fs.chmodSync(path.dirname(registryPath), 0o500);
                emit({ type: 'atomic-publication-fault', boundary: input.atomicFault, id, nativeType: type, stack, snapshot, pending, filename, file: { dev: file.dev, ino: file.ino }, target, descriptor: selected, dev: actual.dev, ino: actual.ino });
            };
            if (input.atomicFault === 'rename') completion = { id, trip };
            else trip();
        },
        before(id) { if (completion?.id === id) completion.trip(); },
    });
    hook.enable();
    return hook;
};
const pausePrepared = registryPath => {
    const hook = createHook({ init(id, type) {
        if (!type.startsWith('FSREQ')) return;
        const snapshot = JSON.parse(fs.readFileSync(registryPath));
        const stored = snapshot.diagnostics;
        if (stored.stage !== 'prepared' || stored.publication?.stage !== 'prepare' || stored.publication.published !== false || !stored.pending.some(pending => pending.path.startsWith(stored.publication.slotPath + '-') && pending.ino !== null)) return;
        hook.disable();
        emit({ type: 'prepared-before-slot', registryPath, snapshot, id, nativeType: type });
        process.kill(process.pid, 'SIGSTOP');
    } });
    hook.enable();
};
if (input.mode === 'recover') {
    if (input.pausePrepared) pausePrepared(input.targetRegistry);
    if (input.pauseBeforeLock) {
        const hook = createHook({ init(id, type) {
            if (!type.startsWith('FSREQ')) return;
            const snapshot = JSON.parse(fs.readFileSync(input.targetRegistry));
            const stack = new Error('actual prepared retry before profile custody').stack;
            if (snapshot.diagnostics.stage !== 'prepared' || snapshot.diagnostics.indexes.length < 2 || !stack.includes('/resources/registry.js:') || !stack.includes('fsync')) return;
            hook.disable();
            emit({ type: 'retry-before-lock', snapshot, id, nativeType: type, stack });
            process.kill(process.pid, 'SIGSTOP');
        } });
        hook.enable();
    }
    const atomicHook = armAtomicFault(input.targetRegistry);
    let indexHook;
    let indexFault;
    let slotDurability;
    if (input.indexFault) {
        const original = JSON.parse(fs.readFileSync(input.targetRegistry));
        const oldFile = path.join(original.diagnostics.bundle.path, `index-${original.diagnosticIndex.version}.json`);
        const directory = path.dirname(input.targetRegistry);
        indexHook = createHook({
            init(id, type) {
                if (indexFault || !type.startsWith('FSREQ')) return;
                const stack = new Error('actual replacement index persistence boundary').stack;
                if (!stack.includes('fsync')) return;
                const snapshot = JSON.parse(fs.readFileSync(input.targetRegistry));
                if (['initial-temporary', 'initial-renamed'].includes(input.indexFault)) {
                    const pending = snapshot.diagnostics.pending.find(pending => path.dirname(pending.path) === original.diagnostics.bundle.path && path.basename(pending.path).startsWith('index-') && pending.ino !== null);
                    if (!pending) return;
                    const renamed = input.indexFault === 'initial-renamed';
                    if (renamed ? stack.includes('/resources/registry.js:') || !stack.includes('/resources/diagnostics.js:') || fs.existsSync(pending.path) : !stack.includes('/resources/registry.js:')) return;
                    const filename = renamed ? pending.path.slice(0, -41) : pending.path;
                    const actual = fs.lstatSync(filename);
                    indexFault = { id, nativeType: type, stack, snapshot, pending, filename, actual: { dev: actual.dev, ino: actual.ino, size: actual.size }, selected: fs.readFileSync(original.diagnosticIndex.slotPath).toString('base64'), oldBytes: fs.readFileSync(oldFile).toString('base64') };
                    emit({ type: 'index-persistence-fault', boundary: input.indexFault, ...indexFault });
                    process.kill(process.pid, 'SIGSTOP');
                    return;
                }
                const current = JSON.parse(fs.readFileSync(original.diagnosticIndex.slotPath));
                if (current.version === original.diagnosticIndex.version) return;
                if (!stack.includes('/resources/registry.js:') && stack.includes('/resources/diagnostics.js:') && !slotDurability) {
                    slotDurability = { id, type, stack };
                    return;
                }
                const registrySync = stack.includes('/resources/registry.js:') && snapshot.diagnosticIndex.version === current.version;
                const removing = snapshot.diagnostics.indexes.find(receipt => receipt.version === original.diagnosticIndex.version)?.removing === true;
                const removed = !fs.existsSync(oldFile);
                if (registrySync && (input.indexFault === 'reference-durability' || input.indexFault === 'inventory-durability' && removed)) {
                    let fd; let selected;
                    const open = descriptors();
                    for (const line of open.split('\n')) { if (line.startsWith('f')) fd = Number.parseInt(line.slice(1)); if (line === 'n' + directory) selected = fd; }
                    assert.ok(Number.isSafeInteger(selected));
                    const actual = fs.fstatSync(selected);
                    assert.equal(actual.isDirectory(), true);
                    indexFault = { id, nativeType: type, stack, descriptor: selected, dev: actual.dev, ino: actual.ino, open, snapshot, current, oldPresent: !removed, slotDurability };
                    fs.closeSync(selected);
                } else if (['cleanup-failure', 'changed-removal'].includes(input.indexFault) && registrySync && removing) {
                    indexFault = { id, nativeType: type, stack, snapshot, current, oldPresent: !removed, slotDurability };
                    if (input.indexFault === 'cleanup-failure') fs.chmodSync(original.diagnostics.bundle.path, 0o500);
                    else fs.writeFileSync(oldFile, 'changed registered version bytes');
                } else if (input.indexFault === 'unproved-absence' && registrySync && !removing) {
                    indexFault = { id, nativeType: type, stack, snapshot, current, oldPresent: !removed, slotDurability };
                    fs.renameSync(oldFile, input.root + '/held-index');
                } else if (['inventory-prepare', 'interrupted-removal', 'retired-removal'].includes(input.indexFault) && !registrySync && removing && removed) {
                    indexFault = { id, nativeType: type, stack, snapshot, current, oldPresent: false, slotDurability };
                    if (input.indexFault === 'inventory-prepare') fs.chmodSync(directory, 0o500);
                } else return;
                emit({ type: 'index-persistence-fault', boundary: input.indexFault, ...indexFault });
                if (['interrupted-removal', 'retired-removal'].includes(input.indexFault)) process.kill(process.pid, 'SIGSTOP');
            },
            before(id) {
                if (indexFault || input.indexFault !== 'reference-prepare' || slotDurability?.id !== id) return;
                indexFault = { slotDurability, atNativeCompletion: true, snapshot: JSON.parse(fs.readFileSync(input.targetRegistry)), current: JSON.parse(fs.readFileSync(original.diagnosticIndex.slotPath)), oldPresent: fs.existsSync(oldFile) };
                fs.chmodSync(directory, 0o500);
                emit({ type: 'index-persistence-fault', boundary: input.indexFault, ...indexFault });
            },
        });
        indexHook.enable();
    }
    const hook = input.pauseClaim && createHook({ init(id, type) {
        if (!type.startsWith('FSREQ')) return;
        const snapshot = JSON.parse(fs.readFileSync(input.targetRegistry));
        if (snapshot.writer.native.pid !== process.pid || snapshot.recovery?.state !== 'recovering') return;
        hook.disable(); emit({ type: 'recovery-claimed', snapshot, id, nativeType: type });
        process.kill(process.pid, 'SIGSTOP');
    } });
    hook && hook.enable();
    let report;
    try { report = await recoverRuns({ projectRoot: input.projectRoot, profiles: [options.profile] }); }
    catch (error) {
        indexHook?.disable();
        atomicHook?.disable();
        if (input.indexFault || input.atomicFault) emit({ type: 'recovery-failed', error: serializeFailure(error) });
        throw error;
    }
    indexHook?.disable();
    atomicHook?.disable();
    emit({ type: 'recovered', report });
    if (process.connected) process.disconnect();
} else if (input.mode.startsWith('native-')) {
    const { test: nativeTest, after } = await import('node:test');
    const managed = await import('../node.js');
    after(() => { if (process.connected) process.disconnect(); });
    nativeTest('diagnostic actual native ancestor', { concurrency: true }, async ancestor => {
        let owner;
        let runRef;
        let data;
        let installed = false;
        const hookEntered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const original = new Error('actual late native owner failure');
        ancestor.beforeEach(actual => {
            if (actual.name !== 'diagnostic actual native owner') return;
            if (!owner) { owner = actual; return; }
            if (actual === owner || installed) return;
            installed = true;
            owner.after(async () => {
                hookEntered.resolve();
                await release.promise;
                if (input.mode === 'native-failure') throw original;
            });
        });
        const completion = managed.test('diagnostic actual native owner', options, async (context, scope, run) => {
            runRef = run;
            data = await scope.directory('native artifact sources');
            fs.writeFileSync(data.path + '/artifact.bin', Buffer.from([0, 255, 42, 13, 10]));
            await scope.diagnostic({ name: 'native.bin', contentType: 'application/octet-stream', stage: 'complete', produce: () => fs.readFileSync(data.path + '/artifact.bin') });
        });
        const peer = managed.test('diagnostic independent native peer', { ...options, profile: 'native-peer' }, async () => {
            await hookEntered.promise;
            await runRef.dispose();
            const snapshot = JSON.parse(fs.readFileSync(runRef.registryPath));
            emit({ type: 'before-native-owner-result', registryPath: runRef.registryPath, data: data.path, dataPresent: fs.existsSync(data.path), snapshot });
            assert.equal(snapshot.status, 'running');
            assert.equal(snapshot.diagnosticIndex, null);
            assert.equal(fs.existsSync(data.path), false);
            release.resolve();
        });
        await peer;
        const summary = await completion;
        emit({ type: 'native-complete', registryPath: runRef.registryPath, summary: { ...summary, errors: summary.errors.map(error => serializeFailure(error)) }, original: serializeFailure(original) });
    });
} else {
    const run = await createRun(options);
    const scope = await run.scope({ kind: 'case', label: 'native publisher' });
    const data = await scope.directory('native publication data');
    fs.writeFileSync(data.path + '/scenario', 'actual native publisher scenario');
    await captureDiagnostic(scope, { name: 'native.bin', bytes: Buffer.from(input.bytes ?? 'actual native evidence'), contentType: 'application/octet-stream' });
    emit({ type: 'ready', registryPath: run.registryPath, data: data.path, runId: run.runId });
    const [action] = await once(process, 'message');
    if (action.mode !== undefined) input.mode = action.mode;
    if (input.pausePrepared) pausePrepared(run.registryPath);
    let hook;
    if (['interrupt', 'hold-final', 'interrupt-after-slot', 'pause-retirement', 'interrupt-retirement'].includes(input.mode)) {
        hook = createHook({ init(id, type) {
            if (!type.startsWith('FSREQ') && type !== 'PROCESSWRAP') return;
            const stack = new Error('actual pre-slot diagnostic publication').stack;
            const current = fs.existsSync(input.projectRoot + '/test-results/harness/diagnostics/slots') && fs.readdirSync(input.projectRoot + '/test-results/harness/diagnostics/slots').filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(input.projectRoot + '/test-results/harness/diagnostics/slots/' + name))).find(index => index.profile === options.profile);
            let event;
            if (input.mode === 'interrupt' && type.startsWith('FSREQ') && stack.includes('fsync') && stack.includes('/resources/diagnostics.js:') && !stack.includes('/resources/registry.js:')) event = 'interrupted-before-slot';
            if (input.mode === 'interrupt-after-slot' && type.startsWith('FSREQ') && current?.runId === run.runId && stack.includes('fsync')) event = 'interrupted-after-slot';
            if (input.mode === 'hold-final' && type.startsWith('FSREQ') && current?.runId === run.runId && run.registry.diagnostics.publication?.stage === 'complete' && !fs.existsSync(current.slotPath.slice(0, -5) + '.lock')) event = 'held-final-save';
            if (input.mode === 'pause-retirement' && type === 'PROCESSWRAP' && stack.includes('executionEnded') && stack.includes('/resources/diagnostics.js:')) event = 'retirement-inspection';
            if (input.mode === 'interrupt-retirement' && type.startsWith('FSREQ') && input.targetBundle && !fs.existsSync(input.targetBundle) && stack.includes('fsync') && stack.includes('/resources/diagnostics.js:')) event = 'retirement-removed';
            if (!event) return;
            hook.disable();
            emit({ type: event, registryPath: run.registryPath, data: data.path, id, nativeType: type, stack, current, bytes: fs.readFileSync(run.registryPath).toString('base64') });
            process.kill(process.pid, 'SIGSTOP');
        } });
        hook.enable();
    }
    if (input.failCleanup) {
        fs.chmodSync(data.path, 0o500);
        assert.throws(() => fs.unlinkSync(data.path + '/scenario'), { code: 'EACCES' });
    }
    const atomicHook = armAtomicFault(run.registryPath);
    let summary;
    try { summary = await run.finish({ status: 'failed', error: new Error('actual native publisher assertion') }); }
    catch (error) { emit({ type: 'publication-failed', error: serializeFailure(error) }); throw error; }
    finally { atomicHook?.disable(); }
    emit({ type: 'complete', registryPath: run.registryPath, summary: { ...summary, errors: summary.errors.map(error => serializeFailure(error)) } });
    if (process.connected) process.disconnect();
}
