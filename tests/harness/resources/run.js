import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { failureFrom, failureGroup } from './errors.js';

const FINALIZER_STAGES = ['capture', 'drain', 'complete'];
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text) {
    return String(text ?? '').replace(ANSI_ESCAPE, '');
}

function validateExpectedExit(expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        throw new TypeError('Expected process exit requires an expectation object');
    }
    const { code, signal } = expected;
    if (code === undefined && signal === undefined) {
        throw new TypeError('Expected process exit requires code or signal');
    }
    return { code, signal };
}

function spawnManagedProcess(scope, run, options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('Managed process requires options');
    }
    const {
        label = 'process',
        command,
        cwd,
        env = {},
        readyLine,
        expectedExit: initialExpectedExit = null,
        readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
        signal: abortSignal,
    } = options;
    if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string')) {
        throw new TypeError('Managed process requires a non-empty command array of strings');
    }
    const onSpawnReady = readyLine && typeof readyLine === 'object' && readyLine.onSpawn === true;
    const readyRegex = readyLine && typeof readyLine === 'object' && typeof readyLine.pattern === 'string'
        ? new RegExp(readyLine.pattern)
        : null;
    let expectedExit = initialExpectedExit ? validateExpectedExit(initialExpectedExit) : null;

    return scope.acquire({
        kind: 'process',
        label,
        allocate: async (handle) => {
            if (abortSignal?.aborted) throw abortSignal.reason ?? new Error(`Process ${label} aborted before spawn`);
            const child = spawn(command[0], command.slice(1), {
                cwd,
                env: { ...process.env, ...env },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let output = '';
            let lineBuffer = '';
            let matchedLine = '';
            let exited = null;
            let stopping = false;
            let killing = false;
            let settledReady = false;
            let resolveReady;
            let rejectReady;
            const readyPromise = new Promise((resolve, reject) => {
                resolveReady = resolve;
                rejectReady = reject;
            });
            let resolveExit;
            const exitPromise = new Promise(resolve => {
                resolveExit = resolve;
            });

            const matchesExpected = actual => expectedExit !== null
                && (expectedExit.code === undefined || actual.code === expectedExit.code)
                && (expectedExit.signal === undefined || actual.signal === expectedExit.signal);

            const makeStartupError = (detail) => {
                const err = new Error(
                    `${output.includes('EADDRINUSE') ? 'Port conflict during' : 'Process'} startup (${label}): ${detail}\n${output}`,
                );
                if (output.includes('EADDRINUSE')) err.code = 'EADDRINUSE';
                err.startupLog = output;
                return err;
            };

            const finishReady = (line = '') => {
                if (settledReady) return;
                settledReady = true;
                matchedLine = line;
                clearTimeout(readyTimer);
                resolveReady();
            };

            const failReady = (err) => {
                if (settledReady) return;
                settledReady = true;
                clearTimeout(readyTimer);
                rejectReady(err);
            };

            const readyTimer = setTimeout(() => {
                failReady(makeStartupError(`timed out after ${readyTimeoutMs}ms waiting for readiness`));
            }, readyTimeoutMs);
            readyTimer.unref?.();

            const onChunk = (chunk) => {
                const text = chunk.toString('utf8');
                output += text;
                if (readyRegex && !settledReady) {
                    lineBuffer += text;
                    const lines = lineBuffer.split(/\r?\n/);
                    lineBuffer = lines.pop() ?? '';
                    for (const line of lines) {
                        const clean = stripAnsi(line);
                        if (readyRegex.test(clean)) {
                            finishReady(clean);
                            return;
                        }
                    }
                    const cleanTail = stripAnsi(lineBuffer);
                    if (readyRegex.test(cleanTail)) {
                        finishReady(cleanTail);
                    }
                }
            };

            child.stdout?.on('data', onChunk);
            child.stderr?.on('data', onChunk);

            child.once('spawn', () => {
                if (onSpawnReady || !readyRegex) finishReady('');
            });

            child.once('error', (err) => {
                const failure = failureFrom(err, `Failed to spawn process ${label}`);
                failReady(failure);
                if (!exited) {
                    exited = { code: null, signal: null, error: failure };
                    resolveExit(exited);
                }
            });

            child.once('close', (code, sig) => {
                exited = { code, signal: sig };
                const isExpected = stopping || killing || matchesExpected(exited);
                if (!settledReady) {
                    if (onSpawnReady && isExpected) finishReady('');
                    else failReady(makeStartupError(`exited before ready (code=${code}, signal=${sig})`));
                } else if (!isExpected) {
                    run.recordError(new Error(`Process ${label} exited unexpectedly (code=${code}, signal=${sig})`));
                }
                resolveExit(exited);
            });

            const stop = async () => {
                if (exited) return exited;
                stopping = true;
                if (child.exitCode === null && child.signalCode === null) {
                    try { child.kill('SIGTERM'); } catch { /* already gone */ }
                }
                const grace = new Promise(resolve => {
                    const timer = setTimeout(() => resolve('timeout'), STOP_GRACE_MS);
                    timer.unref?.();
                    exitPromise.then(() => { clearTimeout(timer); resolve('exited'); });
                });
                const outcome = await grace;
                if (outcome === 'timeout' && !exited && child.exitCode === null && child.signalCode === null) {
                    try { child.kill('SIGKILL'); } catch { /* already gone */ }
                }
                return await exitPromise;
            };

            const onAbort = () => {
                failReady(abortSignal.reason ?? new Error(`Process ${label} aborted`));
                void stop();
            };
            abortSignal?.addEventListener('abort', onAbort, { once: true });

            handle.onDispose(stop);

            try {
                await readyPromise;
            } catch (err) {
                await stop().catch(() => {});
                throw err;
            } finally {
                abortSignal?.removeEventListener('abort', onAbort);
            }

            return Object.freeze({
                resourceId: handle.resourceId,
                runId: handle.runId,
                scopeId: handle.scopeId,
                get pid() { return child.pid ?? null; },
                get output() { return output; },
                get startupLog() { return output; },
                get readyLine() { return matchedLine; },
                get killed() { return killing; },
                exited: exitPromise,
                waitForExit: () => exitPromise,
                expectExit(expected) {
                    expectedExit = validateExpectedExit(expected);
                },
                async kill(sig = 'SIGKILL') {
                    if (exited) return { ...exited };
                    killing = true;
                    try { child.kill(sig); } catch { /* already gone */ }
                    return await exitPromise;
                },
                stop,
            });
        },
        dispose: async (record) => {
            if (typeof record.disposeFn === 'function') {
                await record.disposeFn();
            }
        },
    });
}

export class ResourceScope {
    #run;
    #parent;
    #children = [];
    #entries = [];
    #finalizers = [];
    #continuations = [];
    #disposal = null;

    constructor(run, descriptor, parent = null) {
        if (!descriptor || typeof descriptor.kind !== 'string' || !descriptor.kind || typeof descriptor.label !== 'string' || !descriptor.label) {
            throw new TypeError('A scope requires a nonempty kind and label');
        }
        this.#run = run;
        this.#parent = parent;
        this.scopeId = randomUUID();
        this.record = {
            scopeId: this.scopeId,
            parentId: parent?.scopeId ?? null,
            kind: descriptor.kind,
            label: descriptor.label,
            state: 'active',
        };
    }

    get transport() { return 'local'; }

    #sharedOwner() {
        let scope = this;
        while (scope.#parent !== null && scope.record.kind !== 'worker') {
            scope = scope.#parent;
        }
        return scope;
    }

    get sharedScopeId() {
        return this.#sharedOwner().scopeId;
    }

    #hasResource(resourceId) {
        if (this.#entries.some(entry => entry.record.resourceId === resourceId)) return true;
        return this.#parent ? this.#parent.#hasResource(resourceId) : false;
    }

    #findDirectoryEntry(resourceId) {
        const hit = this.#entries.find(entry => entry.record.resourceId === resourceId && entry.record.kind === 'directory');
        if (hit) return hit;
        return this.#parent ? this.#parent.#findDirectoryEntry(resourceId) : null;
    }

    async child(descriptor) {
        if (this.record.state !== 'active') throw new Error(`Scope ${this.scopeId} is ${this.record.state}`);
        const child = new ResourceScope(this.#run, descriptor, this);
        this.#children.push(child);
        return child;
    }

    acquireShared(descriptor) {
        return this.#sharedOwner().acquire(descriptor);
    }

    releaseShared(resource) {
        return this.#sharedOwner().release(resource);
    }

    async acquire({ kind, label, allocate, dispose, options = {} }) {
        if (this.record.state !== 'active') throw new Error(`Scope ${this.scopeId} is ${this.record.state}`);
        if (typeof kind !== 'string' || !kind) throw new TypeError('A resource requires a kind');
        if (typeof label !== 'string' || !label) throw new TypeError('A resource requires a nonempty label');
        if (typeof allocate !== 'function') throw new TypeError('A resource requires an allocate function');

        const resourceId = randomUUID();
        const record = {
            runId: this.#run.runId,
            scopeId: this.scopeId,
            resourceId,
            kind,
            label,
            owner: 'owned',
            state: 'allocating',
            locator: null,
            disposeFn: null,
        };
        const entry = {
            record,
            dispose: typeof dispose === 'function' ? dispose : async () => {},
            options,
            disposed: false,
            releaseReported: false,
        };
        this.#entries.push(entry);

        const handle = Object.freeze({
            runId: this.#run.runId,
            scopeId: this.scopeId,
            resourceId,
            onDispose(fn) {
                record.disposeFn = fn;
            },
            setLocator(locator) {
                record.locator = locator;
            },
        });

        try {
            const value = await allocate(handle, options);
            record.state = 'ready';
            return value;
        } catch (error) {
            const primary = failureFrom(error, `Resource ${resourceId} allocation failed`);
            this.#run.recordError(primary);
            const cleanupErrors = await this.#releaseEntry(entry);
            if (cleanupErrors.length) {
                throw failureGroup([primary, ...cleanupErrors], `Allocation and cleanup failed for ${label}`);
            }
            throw primary;
        }
    }

    directory(label = 'temp directory') {
        return this.acquire({
            kind: 'directory',
            label,
            allocate: async (handle) => {
                const base = this.#run.ensureTempRoot();
                const dirPath = path.join(base, handle.resourceId);
                fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
                const realPath = fs.realpathSync(dirPath);
                const receipt = Object.freeze({
                    resourceId: handle.resourceId,
                    runId: handle.runId,
                    scopeId: handle.scopeId,
                    path: realPath,
                    ownership: 'owned',
                    label,
                });
                handle.setLocator({ path: realPath });
                return receipt;
            },
            dispose: async (record) => {
                const target = record.locator?.path;
                if (target && fs.existsSync(target)) {
                    fs.rmSync(target, { recursive: true, force: true });
                }
            },
        });
    }

    async verifyDirectory(directory) {
        const entry = directory && typeof directory.resourceId === 'string'
            ? this.#findDirectoryEntry(directory.resourceId)
            : null;
        if (!entry || entry.record.owner !== 'owned') {
            throw new Error(`Directory does not belong to this scope: ${directory?.resourceId ?? directory?.path}`);
        }
        const dirPath = entry.record.locator?.path;
        if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
            throw new Error(`Managed directory is missing: ${dirPath}`);
        }
        return Object.freeze({
            resourceId: entry.record.resourceId,
            runId: entry.record.runId,
            scopeId: entry.record.scopeId,
            path: dirPath,
            ownership: 'owned',
            label: entry.record.label,
        });
    }

    async borrowDirectory(directory) {
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
            throw new TypeError('A borrowed directory requires an absolute path');
        }
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
            throw new Error(`Borrowed directory does not exist: ${directory}`);
        }
        const realPath = fs.realpathSync(directory);
        const resourceId = randomUUID();
        const record = {
            runId: this.#run.runId,
            scopeId: this.scopeId,
            resourceId,
            kind: 'directory',
            label: 'borrowed directory',
            owner: 'borrowed',
            state: 'registered',
            locator: { path: realPath },
        };
        this.#entries.push({ record, dispose: async () => {}, options: {}, disposed: false, releaseReported: false });
        return Object.freeze({
            resourceId,
            runId: this.#run.runId,
            scopeId: this.scopeId,
            path: realPath,
            ownership: 'borrowed',
        });
    }

    process(options) {
        return spawnManagedProcess(this, this.#run, options);
    }

    async onFinalize({ label, stage = 'drain', callback }) {
        if (typeof label !== 'string' || !label || !FINALIZER_STAGES.includes(stage) || typeof callback !== 'function') {
            throw new TypeError('Scope finalization requires a label, capture/drain/complete stage and callback');
        }
        const id = randomUUID();
        this.#finalizers.push({ id, label, stage, callback, ran: false });
        return id;
    }

    async continuation({ label, start }) {
        if (typeof label !== 'string' || !label || typeof start !== 'function') {
            throw new TypeError('Scope continuation requires a label and start callback');
        }
        const operation = (async () => {
            try {
                return await start();
            } catch (value) {
                const error = failureFrom(value, `Continuation ${label} rejected`);
                this.#run.recordError(error);
                throw error;
            }
        })();
        const settled = Promise.allSettled([operation]);
        this.#continuations.push(async () => {
            const [receipt] = await settled;
            if (receipt.status === 'rejected') throw receipt.reason;
        });
        return Object.freeze({ settled: operation });
    }

    async release(resource) {
        const resourceId = typeof resource === 'string' ? resource : resource?.resourceId;
        if (typeof resourceId !== 'string' || !resourceId) {
            throw new TypeError('A resource release requires a resource identity');
        }
        const entry = this.#entries.find(item => item.record.resourceId === resourceId);
        if (!entry) {
            if (this.#hasResource(resourceId)) return [];
            throw new Error(`Resource ${resourceId} is not owned by scope ${this.scopeId}`);
        }
        const errors = await this.#releaseEntry(entry);
        entry.releaseReported = true;
        return errors;
    }

    async #releaseEntry(entry) {
        if (entry.disposed) return [];
        const { record } = entry;
        if (record.owner !== 'owned') {
            entry.disposed = true;
            record.state = 'released';
            return [];
        }
        try {
            await entry.dispose(record, entry.options);
            entry.disposed = true;
            record.state = 'disposed';
            return [];
        } catch (cause) {
            const error = failureFrom(cause, `Cannot dispose resource ${record.resourceId} (${record.kind})`);
            record.state = 'cleanup-failed';
            this.#run.recordError(error);
            return [error];
        }
    }

    async #runFinalizerStage(stage, errors) {
        for (const child of [...this.#children].reverse()) {
            await child.#runFinalizerStage(stage, errors);
        }
        const entries = this.#finalizers.filter(item => item.stage === stage && !item.ran).reverse();
        for (const item of entries) {
            item.ran = true;
            try {
                await item.callback();
            } catch (value) {
                const error = failureFrom(value, `Finalizer ${item.label} failed`);
                this.#run.recordError(error);
                errors.push(error);
            }
        }
        if (stage === 'drain') {
            for (const wait of this.#continuations.splice(0)) {
                try {
                    await wait();
                } catch (value) {
                    errors.push(failureFrom(value, 'Scope continuation failed'));
                }
            }
        }
    }

    dispose() {
        if (this.#disposal) return this.#disposal;
        this.record.state = 'disposing';
        this.#disposal = (async () => {
            const errors = [];
            for (const stage of FINALIZER_STAGES) {
                await this.#runFinalizerStage(stage, errors);
            }
            for (const child of [...this.#children].reverse()) {
                try {
                    await child.dispose();
                } catch (err) {
                    errors.push(...(err instanceof AggregateError ? err.errors : [err]));
                }
            }
            for (const entry of [...this.#entries].reverse()) {
                const released = await this.#releaseEntry(entry);
                if (!entry.releaseReported) {
                    errors.push(...released);
                }
            }
            this.record.state = 'disposed';
            if (errors.length) {
                throw failureGroup(errors, `Cannot dispose scope ${this.scopeId}`);
            }
        })();
        return this.#disposal;
    }
}

export async function createRun({ profile = 'unit' } = {}) {
    const runId = randomUUID();
    const scopes = [];
    const errors = [];
    let tempRoot = null;
    let active = true;
    let finished = null;

    const run = {
        runId,
        profile,
        get active() { return active; },
        get errors() { return errors; },
        ensureTempRoot() {
            if (!tempRoot) {
                const root = path.join(fs.realpathSync(os.tmpdir()), `luker-test-${runId}`);
                fs.mkdirSync(root, { recursive: true, mode: 0o700 });
                tempRoot = root;
            }
            return tempRoot;
        },
        recordError(error) {
            const normalized = failureFrom(error);
            if (!errors.includes(normalized)) errors.push(normalized);
            return normalized;
        },
        async scope(descriptor) {
            if (!active) throw new Error(`Run ${runId} is finished`);
            const scope = new ResourceScope(run, descriptor, null);
            scopes.push(scope);
            return scope;
        },
        finish({ status = 'passed' } = {}) {
            if (finished) return finished;
            active = false;
            finished = (async () => {
                for (const scope of [...scopes].reverse()) {
                    try {
                        await scope.dispose();
                    } catch (err) {
                        for (const item of (err instanceof AggregateError ? err.errors : [err])) {
                            run.recordError(item);
                        }
                    }
                }
                if (tempRoot && fs.existsSync(tempRoot)) {
                    try {
                        fs.rmSync(tempRoot, { recursive: true, force: true });
                    } catch (err) {
                        run.recordError(err);
                    }
                }
                const finalStatus = status === 'passed' && errors.length === 0 ? 'passed' : 'failed';
                return { runId, status: finalStatus, errors: [...errors] };
            })();
            return finished;
        },
    };

    return run;
}
