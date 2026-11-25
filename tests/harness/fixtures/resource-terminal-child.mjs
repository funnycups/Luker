import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { recoverRuns } from '../resources/recovery.js';
import { createRun } from '../resources/run.js';
import { serializeFailure } from '../resources/errors.js';

const [mode, encoded] = process.argv.slice(2);
const input = JSON.parse(encoded);
const runtime = { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') };
let receipt = 0;
const emit = value => {
    const filename = path.join(input.root, `${mode}-${process.pid}-${++receipt}.json`);
    fs.writeFileSync(filename, JSON.stringify(value), { flag: 'wx' });
    const line = 'PROOF ' + JSON.stringify({ receipt: filename }) + '\n';
    assert.equal(fs.writeSync(process.stdout.fd, line), Buffer.byteLength(line));
};
const settled = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
const evidence = result => result.status === 'fulfilled' ? result : { status: result.status, error: serializeFailure(result.error) };
emit({ type: 'runtime', runtime, mode, scheduling: { UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE } });

if (mode === 'recover') {
    const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    emit({ type: 'complete', runtime, result: evidence(result) });
    if (result.status === 'rejected') throw result.error;
} else if (mode === 'writer') {
    let held;
    let client;
    let fault;
    const hook = createHook({ init(id, type) {
        if (fault || held) return;
        const stack = new Error('actual final writer interval').stack;
        try {
            const fsync = type.startsWith('FSREQ') && stack.includes('fsync') && stack.includes('/resources/registry.js:');
            const snapshot = fsync ? JSON.parse(fs.readFileSync(input.registryPath)) : null;
            if (input.interval !== 'durability' && fsync && !client && snapshot.recovery?.state === 'recovering') {
                client = net.connect({ ...snapshot.writer.control, allowHalfOpen: true });
                client.on('error', error => { fault = error; });
                client.once('connect', () => client.write('{"admitted":'));
                client.once('end', () => client.end());
            }
            const prepublication = input.interval !== 'durability' && type === 'SHUTDOWNWRAP' && stack.includes('/resources/authority.js:');
            if (!prepublication && !(fsync && snapshot.recovery?.state === 'failed')) return;
            if (input.interval === 'prepare') fs.chmodSync(path.dirname(input.registryPath), 0o500);
            held = { id, type, stack, snapshot: JSON.parse(fs.readFileSync(input.registryPath)), bytes: fs.readFileSync(input.registryPath).toString('base64'), descriptors: execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' }) };
            emit({ type: 'pending', runtime, interval: input.interval, held });
            process.kill(process.pid, 'SIGSTOP');
        } catch (error) { fault = error; }
    } });
    hook.enable();
    const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    hook.disable();
    if (client && !client.destroyed) client.end();
    emit({ type: 'complete', runtime, interval: input.interval, held, fault: fault && serializeFailure(fault), result: evidence(result), after: JSON.parse(fs.readFileSync(input.registryPath)) });
    if (fault) throw fault;
    if (result.status === 'rejected') throw result.error;
} else if (mode === 'same-writer' || mode === 'same-finish') {
    assert.equal(process.platform, 'darwin', 'The FIFO ordering probe requires the process-based native-inspection backend; platform adoption requires its native ordering fixture');
    assert.equal(process.env.UV_THREADPOOL_SIZE, '1');
    let run;
    if (mode === 'same-finish') {
        run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'normal-terminal-custody', command: [process.execPath, ...process.argv.slice(1)] });
        const scope = await run.scope({ kind: 'case', label: 'normal final durability overlap' });
        await scope.borrowDirectory(input.borrowed);
        const data = await scope.directory('retained normal-finish data');
        fs.writeFileSync(data.path + '/scenario', 'original scenario data');
        fs.chmodSync(data.path, 0o500);
        input.registryPath = run.registryPath;
    }
    execFileSync('/usr/bin/mkfifo', [input.fifo]);
    let held;
    let later;
    let firstResult;
    let laterResult;
    let attemptedWrite;
    let openResult;
    let released = false;
    let fault;
    const release = () => {
        if (released) return;
        released = true;
        const descriptor = fs.openSync(input.fifo, 'w');
        fs.closeSync(descriptor);
    };
    const hook = createHook({ init(id, type) {
        if (!type.startsWith('FSREQ') || fault) return;
        const stack = new Error('actual same-native final durability').stack;
        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
        try {
            const snapshot = JSON.parse(fs.readFileSync(input.registryPath));
            if (!held && (run ? snapshot.status === 'failed' : snapshot.recovery?.state === 'failed')) {
                held = { id, type, stack, snapshot, bytes: fs.readFileSync(input.registryPath).toString('base64') };
                fs.open(input.fifo, 'r', (error, descriptor) => {
                    openResult = error ? { error: serializeFailure(error) } : { descriptor, dev: fs.fstatSync(descriptor).dev, ino: fs.fstatSync(descriptor).ino };
                    if (error) { fault = error; return; }
                    fs.closeSync(descriptor);
                });
                later = settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
                later.then(result => {
                    laterResult = { ...evidence(result), firstStillPending: !firstResult, bytes: fs.readFileSync(input.registryPath).toString('base64') };
                    release();
                });
            } else if (held && snapshot.writer.executionId !== held.snapshot.writer.executionId && !attemptedWrite) {
                attemptedWrite = { id, type, stack, snapshot, firstStillPending: !firstResult };
                release();
            }
        } catch (error) { fault = error; release(); }
    } });
    hook.enable();
    const first = settled(run ? run.finish({ status: 'failed', error: new Error('original normal terminal failure') }) : recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    first.then(result => { firstResult = evidence(result); });
    await first;
    if (later) await later;
    hook.disable();
    emit({ type: 'complete', runtime, held, attemptedWrite, firstResult, laterResult, openResult, released, fault: fault && serializeFailure(fault), after: JSON.parse(fs.readFileSync(input.registryPath)) });
    if (fault) throw fault;
} else throw new Error(`Unknown native terminal fixture: ${mode}`);
