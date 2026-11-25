import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { openProcessTerminal } from '../resources/process-terminal.js';

export const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
export const outcomeChild = fileURLToPath(new URL('./resource-outcome-child.mjs', import.meta.url));
export const controllerSource = fileURLToPath(new URL('../resources/process-controller.js', import.meta.url));
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const settled = promise => promise.then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
export const vocabulary = ['type', 'error', 'id', 'ref', 'name', 'code', 'properties', 'reference', 'accessor'];

export function nodes(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return [];
    seen.add(value);
    return [value, ...Object.getOwnPropertyNames(value).flatMap(key => nodes(value[key], seen))];
}

export function inventory(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).map(entry => {
        const filename = path.join(directory, entry.name);
        const stat = fs.lstatSync(filename);
        return { name: entry.name, dev: stat.dev, ino: stat.ino, mode: stat.mode, ...(entry.isDirectory() ? { children: inventory(filename) } : entry.isSymbolicLink() ? { link: fs.readlinkSync(filename) } : stat.isFIFO() ? { fifo: true } : { bytes: fs.readFileSync(filename).toString('base64') }) };
    });
}

export function descriptors(pid = process.pid) {
    return execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-Ffn'], { encoding: 'utf8' });
}

export async function registeredTerminal(run, scope) {
    const directory = await scope.directory('registered raw-controller terminal transport');
    const record = run.registry.resources.find(record => record.resourceId === directory.resourceId);
    record.terminal = { path: directory.path + '/terminal.json', dev: null, ino: null, acknowledged: null };
    const transport = openProcessTerminal(record);
    await run.registry.save();
    return { ...transport, terminal: record.terminal, resourceId: record.resourceId };
}

export function outcomeFixture(t) {
    const parent = repository + '/test-results/resource-outcome-boundaries';
    fs.mkdirSync(parent, { recursive: true });
    assert.equal(fs.realpathSync(parent), parent);
    const root = fs.mkdtempSync(parent + '/case-');
    const identity = fs.lstatSync(root);
    for (const name of ['project', 'borrowed', 'sibling']) fs.mkdirSync(root + '/' + name);
    fs.writeFileSync(root + '/borrowed/original', 'borrowed outcome bytes');
    fs.writeFileSync(root + '/sibling/original', 'sibling outcome bytes');
    const protectedBefore = [inventory(root + '/borrowed'), inventory(root + '/sibling')];
    t.after(() => {
        const actual = fs.lstatSync(root);
        assert.equal(fs.realpathSync(root), root);
        assert.equal(actual.dev, identity.dev); assert.equal(actual.ino, identity.ino);
        const open = descriptors();
        t.diagnostic(JSON.stringify({ outcomeFixture: { root, dev: identity.dev, ino: identity.ino, beforeOuterTeardown: inventory(root), descriptors: open } }));
        assert.deepEqual([inventory(root + '/borrowed'), inventory(root + '/sibling')], protectedBefore);
        assert.equal(open.includes(root + '/'), false);
        const restore = directory => {
            const stat = fs.lstatSync(directory);
            if (!stat.isDirectory()) return;
            fs.chmodSync(directory, stat.mode | 0o700);
            for (const entry of fs.readdirSync(directory)) restore(path.join(directory, entry));
        };
        restore(root + '/project');
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    return { root, projectRoot: root + '/project', borrowed: root + '/borrowed', report: root + '/worker.json', release: root + '/release', termination: root + '/termination' };
}

/** Observe actual controller IPC without replacing native allocation or delivery. */
export function observeNativeStartup() {
    const events = [];
    let controller;
    const admitted = process => {
        const stack = new Error('actual owned controller allocation').stack;
        if (!stack.includes('/resources/process-owner.js:')) return;
        process.on('message', message => {
            if (message.type === 'controller') controller = process;
            if (['controller', 'failure', 'exit', 'unallocated'].includes(message.type)) events.push({ event: 'received', message });
        });
    };
    const subscriber = value => admitted(value.process);
    channel('child_process').subscribe(subscriber);
    return { events, get controller() { return controller; }, close() { channel('child_process').unsubscribe(subscriber); } };
}

export async function nativeOutcomeChild(t, mode, input, environment = {}) {
    const argv = [process.execPath, outcomeChild, mode, JSON.stringify(input)];
    if (input.cancel) environment = { ...environment, RESOURCE_OUTCOME_START: input.root + '/start-admitted.json', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./resource-outcome-preload.mjs', import.meta.url).href}` };
    if (input.publication) environment = { ...environment, RESOURCE_OUTCOME_FAULT: JSON.stringify({ root: input.root, stage: input.publication }), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('./resource-outcome-preload.mjs', import.meta.url).href}` };
    const actual = spawn(argv[0], argv.slice(1), { cwd: repository + '/tests', env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const events = [];
    let output = '';
    const waiters = [];
    actual.on('message', message => {
        assert.equal(path.dirname(message.receipt), input.root);
        const event = JSON.parse(fs.readFileSync(message.receipt));
        events.push(event);
        for (const waiter of [...waiters]) if (waiter.type === event.type) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
    });
    for (const stream of [actual.stdout, actual.stderr]) stream.on('data', bytes => { output += bytes; });
    const exited = new Promise((resolve, reject) => {
        actual.once('error', reject);
        actual.once('close', (code, signal) => {
            t.diagnostic(JSON.stringify({ outcomeChild: { command: argv, cwd: repository + '/tests', environment, sourceSHA256: sha(fs.readFileSync(outcomeChild)), events, output, code, signal } }));
            resolve({ code, signal });
        });
    });
    const next = type => {
        const event = events.find(event => event.type === type);
        if (event) return Promise.resolve(event);
        return Promise.race([new Promise(resolve => waiters.push({ type, resolve })), exited.then(result => { throw new Error(`Native outcome ${mode} ended before ${type}: ${JSON.stringify(result)}: ${output}`); })]);
    };
    const first = await next('runtime');
    assert.equal(first.runtime.version, process.version); assert.equal(first.runtime.execPath, process.execPath);
    return { process: actual, events, next, exited };
}
