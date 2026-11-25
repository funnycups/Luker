import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Registry } from './registry.js';
import { ResourceScope } from './scope.js';
import { failureGroup, failureEvents } from './errors.js';
import { RunDiagnostics } from './diagnostics.js';

/**
 * @typedef {object} RunOptions
 * @property {string} projectRoot
 * @property {string} profile
 * @property {string[]} command
 * @property {string} source
 * @property {string} [exportEnvironmentTo]
 * @property {AbortSignal} [signal] Actual execution cancellation; never persisted.
 * @property {(request: object) => unknown|Promise<unknown>} [authorityHandler] Execution-bound adapter commands; never persisted.
 *
 * @typedef {{ status: 'passed'|'failed'|'cancelled', error?: Error }} Outcome
 * @typedef {object} ResourceRecord
 * @property {string} runId
 * @property {string} scopeId
 * @property {string} resourceId
 * @property {string} kind
 * @property {string} [label]
 * @property {null|{path: string, dev: number|null, ino: number|null, realPath?: string}|ProcessLocator} locator
 * @property {'owned'|'borrowed'} owner
 * @property {'registered'|'allocating'|'created'|'acquired'|'ready'|'borrowed'|'stopped'|'exited'|'released'|'disposed'|'cleanup-failed'} state
 * @property {string[]} dependencies
 * @property {{path: string, dev: number|null, ino: number|null}} [startupLog]
 * @property {{path: string, dev: number|null, ino: number|null, acknowledged: string|null, completion?: string, publication?: {path: string, dev: number, ino: number}, directory?: {path: string, dev: number, ino: number}}} [terminal]
 *
 * @typedef {{ path: string, resourceId: string, ownership: 'owned', dev: number, ino: number }} OwnedDirectory
 * @typedef {{ path: string, ownership: 'borrowed' }} BorrowedDirectory
 * @typedef {{ runId: string, scopeId: string, resourceId: string, directoryPath: string, createDirectory: () => ResourceRecord['locator'], publish: (identity: ResourceRecord['locator']) => Promise<void> }} DirectoryAcquisition
 * @typedef {ResourceRecord & {removeDirectory: () => void}} DirectoryRelease
 * @typedef {{startProcess: () => Promise<ProcessLease>}} ProcessAcquisition
 * @typedef {ResourceRecord & {stopProcess: () => Promise<void>}} ProcessRelease
 * @typedef {{ name: string, scopeId: string, sha256: string, length: number, contentType: string, readStatus: 'complete', dev: number, ino: number }} ArtifactRef
 * @typedef {{ format: 'diagnostic-index-v1', version: string, projectRoot: string, runId: string, profile: string, source: string, outcome: 'failed'|'cancelled', artifacts: ArtifactRef[], errors: object[], storage: {bundle: {path: string, dev: number, ino: number}}, slotPath: string }} DiagnosticIndex
 * @typedef {{name: string, bytes: Uint8Array, contentType: string}} DiagnosticCapture
 * @typedef {{name: string, contentType: string, stage?: 'capture'|'complete', produce: () => Uint8Array|Promise<Uint8Array>}} DiagnosticProducer
 * @typedef {{label: string, stage: 'capture'|'drain'|'complete', callback: () => void|Promise<void>}} Finalizer
 * @typedef {{label: string, start: (signal: AbortSignal|undefined) => unknown|Promise<unknown>}} Continuation
 * @typedef {{ runId: string, profile: string, status: 'passed'|'failed'|'cancelled', errors: Error[], resources: ResourceRecord[], diagnosticIndex: DiagnosticIndex|null }} RunSummary
 * @typedef {{platform: 'darwin'|'linux', bootId: string, pid: number, startTime: string, uid: number}} NativeProcessIdentity
 * @typedef {{code: number|null, signal: string|null}} ProcessExit
 * @typedef {{runId: string, executionId: string, native: NativeProcessIdentity, control: {host: '127.0.0.1', port: number}}} ExecutionAuthority
 * @typedef {ExecutionAuthority & {resourceId: string, scopeId: string, ownerExecutionId: string, runtime: {version: string, execPath: string, sourceSHA256: string}}} ProcessAuthority
 * @typedef {{executionId: string, ownerExecutionId: string, controller: null|ProcessAuthority, worker: null|{allocation?: 'never-started', pid?: number, native?: null|NativeProcessIdentity, exit?: ProcessExit}}} ProcessLocator
 * @typedef {{label: string, command: string[], readyLine: string|{pattern: string}, cwd?: string, env?: Record<string, string>, sensitiveValues?: string[], dependsOn?: string[], signal?: AbortSignal, stopSignal?: 'SIGTERM'|'SIGKILL'}} ProcessOptions
 * @typedef {{resourceId: string, runId: string, scopeId: string, executionId: string, pid: number, identity: NativeProcessIdentity, startupLog: string, readyLine: string, exited: Promise<ProcessExit>, stop: () => Promise<void>}} ProcessLease
 * @typedef {{recovered: string[], active: string[], ignored: string[]}} RecoveryReport
 */

export class TestRun {
    #root;
    #disposal;
    #finishing;

    constructor(registry, signal, exportEnvironmentTo) {
        this.registry = registry;
        this.runId = registry.runId;
        this.registryPath = registry.file;
        this.active = true;
        this.signal = signal;
        this.exportEnvironmentTo = exportEnvironmentTo;
        this.diagnostics = new RunDiagnostics(registry);
        this.#root = new ResourceScope(this, { kind: 'run', label: registry.profile });
    }

    recordError(error) {
        this.registry.reportError(error);
    }

    scope(descriptor) {
        if (!this.active) return Promise.reject(new Error(`Run ${this.runId} is finishing or finished`));
        return this.#root.child(descriptor);
    }

    /** Close admission and release resources without publishing a test outcome. */
    dispose() {
        if (this.#disposal) return this.#disposal;
        this.active = false;
        this.#disposal = (async () => {
            const errors = [];
            try { await this.#root.prepare(); }
            catch (error) { this.recordError(error); errors.push(error); }
            try { await this.#root.dispose(); }
            catch (error) { this.recordError(error); errors.push(error); }
            if (this.exportEnvironmentTo !== undefined) {
                try { await this.diagnostics.exportEnvironment(this.exportEnvironmentTo); }
                catch (error) { this.recordError(error); errors.push(error); if (!this.registry.environmentExport.archive) this.registry.environmentExport.state = 'failed'; }
                try { await this.registry.save(); }
                catch (error) { this.recordError(error); errors.push(error); }
            }
            const originals = [...new Set(errors.flatMap(failureEvents))];
            if (originals.length) throw failureGroup(originals, `Cannot dispose run ${this.runId}`);
        })();
        return this.#disposal;
    }

    /** @param {Outcome} outcome @returns {Promise<RunSummary>} */
    finish(outcome) {
        if (this.#finishing) return this.#finishing;
        if (!outcome || !['passed', 'failed', 'cancelled'].includes(outcome.status) || (outcome.error !== undefined && !(outcome.error instanceof Error))) {
            return Promise.reject(new TypeError('Run outcome requires passed, failed or cancelled status and an optional Error'));
        }
        this.active = false;
        this.#finishing = (async () => {
            if (outcome.error !== undefined) this.recordError(outcome.error);
            try {
                await this.dispose();
            } catch (error) {
                this.recordError(error);
            }
            let failed = false;
            try { await this.registry.closeAuthority(); }
            catch (error) { this.recordError(error); failed = true; }
            this.registry.status = this.registry.errors.length ? 'failed' : outcome.status;
            try {
                if (this.registry.status !== 'passed') {
                    await this.diagnostics.captureLogs();
                    await this.diagnostics.publish({ status: outcome.status === 'cancelled' ? 'cancelled' : 'failed' });
                } else await this.diagnostics.discard();
            } catch (error) {
                this.recordError(error); this.registry.status = 'failed';
                const persistence = value => value?.publication?.registryPath === this.registryPath || value instanceof AggregateError && value.errors.some(persistence);
                if (persistence(error)) failed = true;
            }
            try {
                await this.registry.save();
            } catch (error) {
                this.recordError(error);
                this.registry.status = 'failed';
                failed = true;
            }
            try { this.registry.concludeWriter(); }
            catch (error) { this.recordError(error); this.registry.status = 'failed'; failed = true; }
            if (failed) throw failureGroup([...this.registry.errors], `Cannot finish run ${this.runId}: registry ${this.registryPath}`);
            return Object.freeze({
                runId: this.runId, profile: this.registry.profile, status: this.registry.status,
                errors: Object.freeze([...this.registry.errors]), resources: structuredClone(this.registry.resources), diagnosticIndex: this.registry.diagnosticIndex,
            });
        })();
        return this.#finishing;
    }
}

/** @param {RunOptions} options @returns {Promise<TestRun>} */
export async function createRun(options) {
    if (!options || typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) throw new TypeError('Run projectRoot must be an absolute real directory');
    for (const name of ['profile', 'source']) {
        if (typeof options[name] !== 'string' || !options[name]) throw new TypeError(`Run ${name} must be a nonempty string`);
    }
    if (!Array.isArray(options.command) || options.command.length === 0 || options.command.some(value => typeof value !== 'string')) throw new TypeError('Run command must contain its executable and arguments');
    if (options.exportEnvironmentTo !== undefined && (typeof options.exportEnvironmentTo !== 'string' || !path.isAbsolute(options.exportEnvironmentTo))) throw new TypeError('Environment export requires an explicit absolute destination');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Run signal must be an AbortSignal');
    if (options.authorityHandler !== undefined && typeof options.authorityHandler !== 'function') throw new TypeError('Run authorityHandler must be a function');
    const exportEnvironmentTo = options.exportEnvironmentTo;
    const registry = await Registry.create({ ...options, projectRoot: path.resolve(options.projectRoot) }, randomUUID());
    const run = new TestRun(registry, options.signal, exportEnvironmentTo);
    try { await registry.save(); await run.diagnostics.ensure(); }
    catch (error) {
        return registry.rejectAdmission(error);
    }
    return run;
}
