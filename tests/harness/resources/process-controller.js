import { spawn } from 'node:child_process';
import { Authority } from './authority.js';
import { readProcessIdentity } from './native-identity.js';
import { failureGroup, receiveFailureGraph, failureFingerprint } from './errors.js';
import { normalizeReadinessLine, processDiagnostics } from './process-diagnostics.js';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { writeProcessTerminal } from './process-terminal.js';

let child;
let authority;
let exit;
let closed;
let stopping;
let shutdown;
let config;
let worker;
let ready = false;
let buffered = '';
const decoder = new StringDecoder('utf8');
const releaseRequests = new Set();
const producers = new Set();
const sends = new Set();
const failures = new Set();
const workerFailures = new Set();
const events = new Map();
let diagnostic = processDiagnostics({});

function failureEvent(error) {
    if (!events.has(error)) {
        const graph = diagnostic.failure(error);
        events.set(error, { id: randomUUID(), fingerprint: failureFingerprint(receiveFailureGraph(graph)), graph });
    }
    return events.get(error);
}

function reportFailure(error, worker = false) {
    const failuresForKind = worker ? workerFailures : failures;
    if (failuresForKind.has(error)) return;
    failuresForKind.add(error);
    const event = failureEvent(error);
    send({ type: 'failure', eventId: event.id, error: event.graph });
}

function send(message) {
    if (!process.connected) return;
    const sending = new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
    const observed = sending.catch(error => { failures.add(error); closeController(); }).finally(() => sends.delete(observed));
    sends.add(observed);
}

function stopWorker() {
    if (stopping) return stopping;
    stopping = (async () => {
        if (!child) return;
        // This handle is the actual unreaped direct child, not a recovered pid.
        if (!exit) child.kill(config.options.stopSignal);
        return closed;
    })();
    return stopping;
}

function closeController() {
    if (shutdown) return shutdown;
    shutdown = (async () => {
        await Promise.all([...producers]);
        await stopWorker();
        if (authority) await authority.close();
        while (sends.size) await Promise.all([...sends]);
        if (process.connected) {
            try {
                await new Promise((resolve, reject) => {
                    process.once('disconnect', resolve);
                    try { process.disconnect(); } catch (error) { reject(error); }
                });
            } catch (error) { failures.add(error); }
        }
        while (producers.size) await Promise.all([...producers]);
        const errors = [...new Set([...failures, ...authority?.errors ?? []])];
        if (errors.length) process.exitCode = 1;
        const bindings = errors => errors.map(error => { const { id, fingerprint } = failureEvent(error); return { id, fingerprint }; });
        if (config && authority) await writeProcessTerminal(config, authority.identity, child ? { ...worker, exit } : { allocation: 'never-started' }, errors.length ? diagnostic.failure(failureGroup(errors, `Process controller ${config.resourceId} terminal shutdown failed`)) : null, workerFailures.size ? diagnostic.failure(failureGroup([...workerFailures], `Process ${config.resourceId} worker startup failed`)) : null, bindings(errors), bindings([...workerFailures]), diagnostic.failure);
    })();
    shutdown.catch(error => { process.stderr.write(JSON.stringify(diagnostic.failure(error)) + '\n'); process.exitCode = 1; if (process.connected) process.disconnect(); });
    return shutdown;
}

process.once('disconnect', closeController);
process.on('SIGTERM', closeController);
process.on('SIGINT', closeController);
process.on('message', message => {
    if (message.type === 'stop') { closeController(); return; }
    const receiving = async () => {
        if (shutdown) throw new Error(`Process execution ${config?.executionId} is closing`);
        if (message.type === 'configure') {
            config = message;
            diagnostic = processDiagnostics(config.options, (stream, value) => send({ type: 'output', stream, data: Buffer.from(value).toString('base64') }));
            authority = await Authority.open({ runId: config.runId, executionId: config.executionId, resourceId: config.resourceId, scopeId: config.scopeId, ownerExecutionId: config.ownerExecutionId, native: await readProcessIdentity(process.pid), runtime: { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') } }, {
                handle: async request => {
                    if (request.action !== 'stop') throw new Error(`Unknown process-control action: ${request.action}`);
                    releaseRequests.add(request);
                    try {
                        await stopWorker();
                        await authority.quiesce(releaseRequests);
                        if (authority.errors.length) throw failureGroup(authority.errors, `Cannot release process controller ${config.resourceId}`);
                        return { worker: child ? { exit } : { allocation: 'never-started' }, controller: authority.identity, released: true, resourceId: config.resourceId, executionId: config.executionId };
                    } finally { closeController(); }
                },
                diagnostic: error => diagnostic.failure(error),
                onError: error => { reportFailure(error); closeController(); },
            });
            if (shutdown) { await authority.close(); return; }
            send({ type: 'controller', identity: authority.identity });
        } else if (message.type === 'kill') {
            if (shutdown) throw new Error(`Process execution ${config.executionId} is closing`);
            if (!child) throw new Error(`Process execution ${config.executionId} has no running worker`);
            if (!['SIGTERM', 'SIGKILL'].includes(message.signal)) throw new TypeError(`Unsupported worker kill signal: ${message.signal}`);
            if (!exit) child.kill(message.signal);
            await closed;
        } else if (message.type === 'start') {
            if (shutdown) throw new Error(`Process execution ${config.executionId} is closing`);
            const [executable, ...args] = config.options.command;
            const expected = config.options.readyLine;
            const onSpawn = expected !== null && typeof expected === 'object' && expected.onSpawn === true;
            const readiness = typeof expected === 'string' || onSpawn ? null : new RegExp(`^(?:${expected.pattern})$`, 'u');
            try { child = spawn(executable, args, { cwd: config.options.cwd, env: { ...process.env, ...config.options.env }, stdio: ['ignore', 'pipe', 'pipe'] }); }
            catch (error) { send({ type: 'unallocated' }); throw error; }
            closed = new Promise(resolve => child.once('close', (code, signal) => {
                exit = { code, signal };
                diagnostic.flush();
                send({ type: 'exit', exit });
                resolve(exit);
            }));
            child.once('error', error => reportFailure(error, true));
            for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
                stream.on('data', data => {
                    diagnostic.write(name, data);
                    if (name === 'stdout' && !ready && !onSpawn) {
                        buffered += decoder.write(data);
                        const lines = buffered.split(/\r?\n/);
                        buffered = lines.pop();
                        const line = lines.find(value => typeof expected === 'string' ? value === expected : readiness.test(normalizeReadinessLine(value)));
                        if (line !== undefined) { ready = true; send({ type: 'ready', line }); }
                    }
                });
            }
            if (child.pid !== undefined) {
                const native = await readProcessIdentity(child.pid);
                worker = { native, pid: child.pid };
                send({ type: 'worker', worker });
                if (onSpawn && !ready) {
                    ready = true;
                    send({ type: 'ready', line: '' });
                }
            }
        } else throw new Error(`Unknown process-control message: ${message.type}`);
    };
    const producer = receiving().catch(error => { reportFailure(error, message.type === 'start'); closeController(); }).finally(() => producers.delete(producer));
    producers.add(producer);
});
