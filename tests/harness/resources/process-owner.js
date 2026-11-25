import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProcessIdentity, sameProcessIdentity, validateProcessExit } from './native-identity.js';
import { requestAuthority } from './authority.js';
import { failureGroup, failureEvents, failureFrom, receiveFailureGraph, failureFingerprint, bindFailureEvent } from './errors.js';
import { processDiagnostics } from './process-diagnostics.js';
import { consumeProcessTerminal } from './process-terminal.js';

/** @typedef {import('./run.js').ProcessOptions} ProcessOptions */

function observed() {
    const receipt = Promise.withResolvers();
    Promise.allSettled([receipt.promise]);
    return receipt;
}

function validateExpectedExit(expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new TypeError('Expected process exit requires an expectation object');
    for (const key of Object.keys(expected)) if (!['code', 'signal'].includes(key)) throw new TypeError(`Unknown expected process exit key: ${key}`);
    const { code, signal } = expected;
    if (code === undefined && signal === undefined) throw new TypeError('Expected process exit requires code or signal');
    if (code !== undefined && code !== null && !Number.isInteger(code)) throw new TypeError('Expected process exit code must be an integer or null');
    if (signal !== undefined && signal !== null && !['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal)) throw new TypeError(`Unsupported expected process exit signal: ${signal}`);
    return { code, signal };
}

/** Allocation responsibility is installed in the registry before start() may spawn. */
export function processAllocation({ record, owner, options, publish, log, terminal, registry, onError }) {
    const controllerReceipt = observed();
    const workerReceipt = observed();
    const readyReceipt = observed();
    const exitedReceipt = observed();
    const controllerClosed = observed();
    const locator = structuredClone(record.locator);
    const publications = [];
    const failures = new Set();
    const observations = new Map();
    let controller;
    let starting;
    let stopping;
    let workerExit;
    let ready = false;
    let matchedLine;
    let returned = false;
    let primary;
    let failed = false;
    let controllerExit;
    let spawnRequested = false;
    let killing = false;
    let expectedExit = options.expectedExit ? { ...options.expectedExit } : null;
    const onSpawnReady = options.readyLine !== null && typeof options.readyLine === 'object' && options.readyLine.onSpawn === true;
    const matchesExpectedExit = actual => expectedExit !== null
        && (expectedExit.code === undefined || actual.code === expectedExit.code)
        && (expectedExit.signal === undefined || actual.signal === expectedExit.signal);
    const diagnostic = processDiagnostics(options);
    const cancelled = () => fail(options.signal.reason);

    const snapshot = state => {
        const writing = publish(structuredClone(locator), state);
        publications.push(writing);
        writing.catch(error => fail(error));
        return writing;
    };
    const startupError = () => {
        const error = new Error(`${log.text.includes('EADDRINUSE') ? 'Port conflict during' : 'Owned process'} startup for resource ${record.resourceId}: ${workerExit ? `exit ${workerExit.code}, signal ${workerExit.signal}` : primary?.message ?? 'controller ended before readiness'}`);
        if (log.text.includes('EADDRINUSE')) error.code = 'EADDRINUSE';
        error.startupLog = log.text;
        if (failed) error.cause = primary;
        return error;
    };
    const fail = error => {
        error = failureFrom(error);
        if (failures.has(error)) return;
        failures.add(error);
        if (!failed) { primary = error; failed = true; }
        controllerReceipt.reject(error);
        workerReceipt.reject(error);
        readyReceipt.reject(error);
        onError(error);
    };
    const lease = Object.freeze({
        resourceId: record.resourceId,
        runId: record.runId,
        scopeId: record.scopeId,
        executionId: locator.executionId,
        get pid() { return locator.worker?.pid ?? null; },
        get identity() { return structuredClone(locator.worker?.native ?? null); },
        get startupLog() { return log.text; },
        get startupLogPath() { return log.path; },
        get output() { return log.text; },
        get readyLine() { return matchedLine; },
        get killed() { return killing; },
        expectExit(expected) {
            const validated = validateExpectedExit(expected);
            if (workerExit || !controller || !spawnRequested || controllerExit) throw new Error(`Owned process ${record.resourceId} is not running`);
            expectedExit = validated;
        },
        async kill(signal = 'SIGKILL') {
            if (workerExit) return { ...workerExit };
            if (!controller || !spawnRequested || controllerExit) throw new Error(`Owned process ${record.resourceId} is not running`);
            killing = true;
            controller.send({ type: 'kill', signal });
            return await exitedReceipt.promise;
        },
        exited: exitedReceipt.promise,
        stop: () => allocation.stop(),
    });
    const allocation = {
        start() {
            if (starting) return starting;
            starting = (async () => {
                if (options.signal?.aborted) throw options.signal.reason;
                options.signal?.addEventListener('abort', cancelled, { once: true });
                controller = spawn(process.execPath, [fileURLToPath(new URL('./process-controller.js', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe', 'ipc', terminal.descriptor] });
                terminal.close();
                controller.once('error', error => fail(new Error(`Native process controller failed for resource ${record.resourceId}`, { cause: diagnostic.failure(error) })));
                for (const stream of [controller.stdout, controller.stderr]) stream.on('data', data => {
                    try { log.write('controller', data); } catch (error) { fail(error); }
                });
                controller.on('message', message => {
                    try {
                        if (message.type === 'controller') controllerReceipt.resolve(message.identity);
                        else if (message.type === 'worker') {
                            locator.worker = { ...locator.worker, ...message.worker };
                            snapshot();
                            workerReceipt.resolve();
                        } else if (message.type === 'unallocated') {
                            locator.worker = { allocation: 'never-started' };
                            snapshot();
                        } else if (message.type === 'output') log.append(Buffer.from(message.data, 'base64').toString('utf8'));
                        else if (message.type === 'ready') { ready = true; matchedLine = message.line; readyReceipt.resolve(); }
                        else if (message.type === 'exit') {
                            log.flush();
                            workerExit = message.exit;
                            locator.worker = { ...locator.worker, exit: workerExit };
                            const expected = stopping || killing || matchesExpectedExit(workerExit);
                            const publication = snapshot(returned && !expected ? 'exited' : undefined);
                            if (!returned) {
                                if (onSpawnReady && expected) {
                                    ready = true;
                                    matchedLine = '';
                                    workerReceipt.resolve();
                                    readyReceipt.resolve();
                                } else {
                                    readyReceipt.reject(startupError());
                                }
                            } else if (!expected) onError(new Error(`Owned process ${record.resourceId} exited unexpectedly: code ${workerExit.code}, signal ${workerExit.signal}; startup log ${log.path}`));
                            publication.then(() => exitedReceipt.resolve(workerExit), exitedReceipt.reject);
                        } else if (message.type === 'failure') {
                            if (!/^[a-f0-9-]{36}$/.test(message.eventId) || message.error?.type !== 'error') throw new Error(`Process ${record.resourceId} received an incomplete failure event`);
                            const graph = receiveFailureGraph(message.error);
                            const fingerprint = failureFingerprint(graph);
                            const prior = observations.get(message.eventId);
                            if (prior) {
                                if (prior.fingerprint !== fingerprint) throw new Error(`Process ${record.resourceId} failure event ${message.eventId} changed content`);
                                return;
                            }
                            const error = bindFailureEvent(new Error(`Process control failed for resource ${record.resourceId}: ${graph.message}`, { cause: graph }), { id: message.eventId, fingerprint });
                            error.code = graph.code;
                            observations.set(message.eventId, { fingerprint, error });
                            fail(error);
                        } else throw new Error(`Unknown process-control receipt for resource ${record.resourceId}: ${message.type}`);
                    } catch (error) { fail(error); }
                });
                controller.once('close', (code, signal) => {
                    controllerExit = { code, signal };
                    if (!workerExit && locator.worker?.allocation !== 'never-started' && (spawnRequested || !stopping)) {
                        const error = new Error(`Process controller for resource ${record.resourceId} ended ${spawnRequested ? 'without a worker exit receipt' : 'before worker startup'}: code ${code}, signal ${signal}; preserve its registry and scenario data`);
                        exitedReceipt.reject(error);
                        fail(error);
                    }
                    controllerClosed.resolve();
                });
                const { command, cwd, env, readyLine, stopSignal, sensitiveValues } = options;
                controller.send({ type: 'configure', terminal: record.terminal, runId: record.runId, scopeId: record.scopeId, resourceId: record.resourceId, ownerExecutionId: owner.executionId, executionId: locator.executionId, options: { command, cwd, env, readyLine, stopSignal, sensitiveValues } });
                const identity = await controllerReceipt.promise;
                if (identity.runId !== record.runId || identity.resourceId !== record.resourceId || identity.scopeId !== record.scopeId || identity.executionId !== locator.executionId || identity.ownerExecutionId !== owner.executionId || identity.native.pid !== controller.pid || !sameProcessIdentity(await readProcessIdentity(controller.pid), identity.native)) throw new Error(`Actual process controller identity does not match resource ${record.resourceId}`);
                locator.controller = identity;
                await snapshot();
                if (failed) throw primary;
                spawnRequested = true;
                controller.send({ type: 'start' });
                await workerReceipt.promise;
                await snapshot();
                await readyReceipt.promise;
                if (failed) throw primary;
                const fastExpectedExit = onSpawnReady && Boolean(workerExit) && matchesExpectedExit(workerExit);
                if ((workerExit && !fastExpectedExit) || !ready) throw startupError();
                if (!fastExpectedExit && locator.worker?.native === null) throw new Error(`Cannot establish the actual native worker identity for resource ${record.resourceId} before readiness`);
                returned = true;
                options.signal?.removeEventListener('abort', cancelled);
                return lease;
            })().catch(async error => {
                const errors = [failureFrom(error), ...failures];
                try { await allocation.stop(); }
                catch (cleanup) { errors.push(...failureEvents(cleanup)); }
                errors.push(...failures);
                const originals = [...new Set(errors)];
                throw originals.length === 1 ? originals[0] : failureGroup(originals, `Process ${record.resourceId} startup failed`);
            });
            return starting;
        },
        stop() {
            if (stopping) return stopping;
            stopping = (async () => {
                const errors = [];
                options.signal?.removeEventListener('abort', cancelled);
                if (controller && !controllerExit) {
                    try {
                        if (controller.connected) controller.send({ type: 'stop' });
                    } catch (error) { errors.push(error); }
                    await controllerClosed.promise;
                }
                if (spawnRequested && !workerExit && locator.worker?.allocation !== 'never-started') errors.push(new Error(`Cannot establish owned worker exit for resource ${record.resourceId}; preserve scenario data`));
                if (controllerExit && (controllerExit.code !== 0 || controllerExit.signal !== null)) errors.push(new Error(`Owned process controller ${record.resourceId} failed: code ${controllerExit.code}, signal ${controllerExit.signal}`));
                try {
                    terminal.close();
                    if (locator.controller) consumeProcessTerminal({ ...record, locator }, registry, observations);
                } catch (error) { errors.push(error); }
                const results = await Promise.allSettled(publications);
                errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
                try { log.close(); } catch (error) { errors.push(error); }
                if (errors.length) throw failureGroup(errors, `Cannot stop owned process ${record.resourceId}`);
                await snapshot('stopped');
            })();
            return stopping;
        },
    };
    return allocation;
}

export const processProvider = Object.freeze({
    kind: 'process',
    async allocate(handle) { return handle.startProcess(); },
    async dispose(record) { await record.stopProcess(); },
});

/** @param {import('./scope.js').ResourceScope} scope @param {ProcessOptions} options */
export function launchOwnedProcess(scope, options) {
    if (options) {
        options = { ...options };
        if (Array.isArray(options.command)) options.command = [...options.command];
        if (options.env && typeof options.env === 'object') options.env = { ...options.env };
        if (options.readyLine && typeof options.readyLine === 'object' && !Array.isArray(options.readyLine)) options.readyLine = { ...options.readyLine };
        if (Array.isArray(options.sensitiveValues)) options.sensitiveValues = [...options.sensitiveValues];
        if (Array.isArray(options.dependsOn)) options.dependsOn = [...options.dependsOn];
    }
    const readiness = options?.readyLine;
    const pattern = readiness !== null && typeof readiness === 'object' && !Array.isArray(readiness) && Object.keys(readiness).length === 1 && Object.hasOwn(readiness, 'pattern');
    const onSpawn = readiness !== null && typeof readiness === 'object' && !Array.isArray(readiness) && Object.keys(readiness).length === 1 && readiness.onSpawn === true;
    const literal = typeof readiness === 'string' ? readiness : pattern ? readiness.pattern : undefined;
    if (!options || !Array.isArray(options.command) || options.command.length === 0 || options.command.some(value => typeof value !== 'string' || !value) || (!onSpawn && (typeof literal !== 'string' || !literal || /[\r\n]/.test(literal)))) {
        return Promise.reject(new TypeError('Owned process requires command executable/arguments and a nonempty readiness line or pattern'));
    }
    if (options.expectedExit !== undefined) {
        try { options.expectedExit = validateExpectedExit(options.expectedExit); }
        catch (error) { return Promise.reject(error); }
    }
    if (pattern) {
        try { new RegExp(`^(?:${literal})$`, 'u'); }
        catch (cause) { return Promise.reject(new TypeError(`Owned process readiness pattern is invalid: ${literal}`, { cause })); }
    }
    if (options.cwd !== undefined && typeof options.cwd !== 'string') return Promise.reject(new TypeError('Owned process cwd must be a directory path'));
    if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Object.values(options.env).some(value => typeof value !== 'string'))) return Promise.reject(new TypeError('Owned process environment values must be strings'));
    if (options.sensitiveValues !== undefined && (!Array.isArray(options.sensitiveValues) || options.sensitiveValues.some(value => typeof value !== 'string' || !value))) return Promise.reject(new TypeError('Owned process sensitive values must be nonempty strings'));
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return Promise.reject(new TypeError('Owned process signal must be an AbortSignal'));
    if (options.stopSignal !== undefined && !['SIGTERM', 'SIGKILL'].includes(options.stopSignal)) return Promise.reject(new TypeError('Owned process stopSignal must be SIGTERM or SIGKILL'));
    if (options.command.some(value => value.includes('\0')) || options.cwd?.includes('\0') || Object.entries(options.env ?? {}).some(([name, value]) => name.includes('\0') || value.includes('\0'))) return Promise.reject(new TypeError('Owned process executable, arguments, cwd and environment must not contain NUL'));
    return scope.acquire({ ...processProvider, label: options.label, dependsOn: options.dependsOn, options: { ...options, stopSignal: options.stopSignal ?? 'SIGTERM' } });
}

/** Recovery never signals a recorded pid; only its exact live controller can stop a child. */
export async function recoverOwnedProcess(record, registry) {
    const identity = record.locator.controller;
    if (!identity) {
        if (record.locator.worker) throw new Error(`Process ${record.resourceId} has a worker without a published controller; preserve registry ${record.runId}`);
        return;
    }
    const actual = await readProcessIdentity(identity.native.pid);
    if (sameProcessIdentity(actual, identity.native)) {
        const known = await requestAuthority(identity, 'identify');
        if (known.runId !== record.runId || known.resourceId !== record.resourceId || known.scopeId !== record.scopeId || known.ownerExecutionId !== record.locator.ownerExecutionId || known.executionId !== record.locator.executionId || !sameProcessIdentity(known.native, identity.native)) throw new Error(`Recovery controller identity does not match process resource ${record.resourceId}`);
        let preliminary;
        try {
            const stopped = await requestAuthority(identity, 'stop');
            if (stopped.resourceId !== record.resourceId || stopped.executionId !== record.locator.executionId || stopped.released !== true || !stopped.controller || stopped.controller.executionId !== identity.executionId || !sameProcessIdentity(stopped.controller.native, identity.native)) throw new Error(`Controller did not establish execution-bound listener release for resource ${record.resourceId}`);
            if (stopped.worker?.allocation === 'never-started') record.locator.worker = { allocation: 'never-started' };
            else { validateProcessExit(stopped.worker?.exit); record.locator.worker = { ...record.locator.worker, exit: stopped.worker.exit }; }
        } catch (error) { preliminary = error; }
        // Observe the exact execution ending; a queued shutdown or worker exit is not controller release.
        while (sameProcessIdentity(await readProcessIdentity(identity.native.pid), identity.native)) { /* Native inspection yields until this controller has actually ended. */ }
        try { consumeProcessTerminal(record, registry); }
        catch (error) { throw preliminary ? failureGroup([preliminary, error], `Cannot establish complete terminal outcome for process ${record.resourceId}`) : error; }
        if (preliminary) throw preliminary;
        return;
    }
    const worker = record.locator.worker;
    if (!worker) throw new Error(`Process resource ${record.resourceId} lost its controller before worker identity or exit was published; preserve data and registry ${record.runId}`);
    if (worker?.native && sameProcessIdentity(await readProcessIdentity(worker.native.pid), worker.native)) throw new Error(`Orphan process resource ${record.resourceId} has a live worker without its execution controller; preserve data and registry ${record.runId}`);
    if (!worker.native && !worker.exit && worker.allocation !== 'never-started') throw new Error(`Cannot establish native worker identity or exit for resource ${record.resourceId}; preserve registry ${record.runId}`);
    consumeProcessTerminal(record, registry);
}
