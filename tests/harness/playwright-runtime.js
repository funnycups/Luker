import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRun } from './resources/run.js';
import { launchOwnedProcess } from './resources/process-owner.js';
import { failureGroup, serializeFailure } from './resources/errors.js';
import { validateResourcePaths, selectedProjects } from './playwright-config.js';
import { startServer } from './server.js';
import { acquireMysqlDatabase, acquirePostgresDatabase } from './database.js';
import { recoverBeforeRun } from './startup.js';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const caseKey = (id, retry, worker) => `${worker}:${retry}:${id}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let current;

function nativeError(value) {
    const error = new Error(value.message ?? value.value ?? JSON.stringify(value));
    if (value.stack) error.stack = value.stack;
    error.nativeResult = structuredClone(value);
    return error;
}

class ProjectResources {
    constructor(runtime, project) {
        this.runtime = runtime;
        this.project = project;
        this.workers = new Map(); this.scopes = new Map(); this.cases = new Map();
        this.planned = new Map(); this.plannedTests = new Map(); this.completed = new Set(); this.jobs = new Set();
        this.events = []; this.results = []; this.processes = new Map();
        this.nativeFailures = new Set();
        this.interrupted = false;
        this.frontendCancellation = new AbortController();
    }

    async open() {
        const exportEnvironmentTo = process.env.LUKER_EXPORT_ENVIRONMENT || undefined;
        try { this.run = await createRun({ projectRoot: this.runtime.root, profile: this.project.name, source: 'native-browser-execution', command: [process.execPath, ...process.argv.slice(1)], authorityHandler: request => this.request(request), ...(exportEnvironmentTo ? { exportEnvironmentTo } : {}) }); }
        catch (error) { this.initializationError = error; throw error; }
    }

    track(promise) {
        this.jobs.add(promise);
        promise.catch(error => this.run.recordError(error)).finally(() => this.jobs.delete(promise));
        return promise;
    }

    async scope(parent, descriptor, metadata) {
        const scope = parent ? await parent.scope.child(descriptor) : await this.run.scope(descriptor);
        const entry = { scope, ...metadata, directories: [], closed: false };
        this.scopes.set(scope.scopeId, entry);
        return entry;
    }

    descriptor(entry) {
        return { scopeId: entry.scope.scopeId, runId: this.run.runId, project: this.project.name, workerIndex: entry.workerIndex };
    }

    async request(request) {
        if (request.action !== 'resource') throw new Error(`Unknown browser resource action: ${request.action}`);
        if (this.runtime.teardownComplete) throw new Error(`Browser resource admission is closed for project ${this.project.name}`);
        const operation = this.dispatch(request.payload);
        return this.track(operation);
    }

    async dispatch(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.command !== 'string') throw new TypeError('Browser resource command requires a payload');
        if (input.command === 'worker') {
            if (!integer(input.workerIndex) || !integer(input.parallelIndex)) throw new TypeError('Browser worker requires native worker and parallel indices');
            if (this.workers.has(input.workerIndex)) throw new Error(`Native worker ${input.workerIndex} was admitted twice`);
            const entry = await this.scope(null, { kind: 'worker', label: `native worker ${input.workerIndex}` }, { workerIndex: input.workerIndex, kind: 'worker', closing: false, cancellation: new AbortController() });
            this.workers.set(input.workerIndex, entry);
            return this.descriptor(entry);
        }
        const entry = this.scopes.get(input.scopeId);
        if (!entry || entry.closed) throw new Error(`Browser resource scope is not active: ${input.scopeId}`);
        const worker = this.workers.get(entry.workerIndex);
        if (input.command === 'worker-done') {
            worker.closing = true;
            worker.cancellation.abort(new Error(`Native worker ${entry.workerIndex} concluded during startup`));
            return { closed: true };
        }
        if (worker.closing) throw new Error(`Native worker ${entry.workerIndex} admission is closed`);
        if (input.command === 'frontend-application') {
            if (this.project.name !== 'frontend') throw new Error(`Shared frontend application requires the frontend project: ${this.project.name}`);
            this.frontend ??= this.startFrontend();
            return this.frontend;
        }
        if (input.command === 'case') {
            const key = caseKey(input.testId, input.retry, entry.workerIndex);
            let actual = this.cases.get(key);
            if (!actual) {
                const planned = this.plannedTests.get(input.testId);
                if (!planned || !integer(input.retry)) throw new Error(`Native case is not awaiting resource admission: ${key}`);
                actual = { key, testId: input.testId, file: planned.file, title: planned.title, ended: false };
                this.cases.set(key, actual);
            }
            if (actual.ended || actual.entry || actual.admitting) throw new Error(`Native case is not awaiting resource admission: ${key}`);
            actual.admitting = true;
            try {
                actual.entry = await this.scope(worker, { kind: 'case', label: actual.title }, { workerIndex: entry.workerIndex, file: actual.file, kind: 'case' });
                return this.descriptor(actual.entry);
            } finally {
                actual.admitting = false;
            }
        }
        if (input.command === 'scenario') {
            if (!this.planned.has(input.file)) throw new Error(`Scenario is not part of native project selection: ${input.file}`);
            const existing = [...this.scopes.values()].find(candidate => candidate.kind === 'scenario' && candidate.workerIndex === entry.workerIndex && candidate.file === input.file);
            if (existing) return this.descriptor(existing);
            const scenario = await this.scope(worker, { kind: 'scenario', label: input.file }, { workerIndex: entry.workerIndex, file: input.file, kind: 'scenario' });
            return this.descriptor(scenario);
        }
        if (input.command === 'child') {
            const child = await this.scope(entry, input.descriptor, { workerIndex: entry.workerIndex, file: entry.file, kind: 'child' });
            return this.descriptor(child);
        }
        if (input.command === 'directory') {
            const directory = await entry.scope.directory(input.label);
            entry.directories.push(directory);
            return directory;
        }
        if (input.command === 'acquire') {
            if (!input.options || typeof input.options !== 'object') throw new TypeError('Browser resource acquisition requires options');
            if (input.kind === 'mysql-database') return acquireMysqlDatabase(entry.scope, input.options.rootUrl, { ...input.options, label: input.label });
            if (input.kind === 'postgres-schema') return acquirePostgresDatabase(entry.scope, input.options.rootUrl, { ...input.options, label: input.label });
            throw new Error(`Unknown browser resource provider: ${input.kind}`);
        }
        if (input.command === 'borrow-directory') return entry.scope.borrowDirectory(input.path);
        if (input.command === 'verify-directory') return entry.scope.verifyDirectory(input.directory);
        if (input.command === 'release') {
            const errors = await entry.scope.release(input.resource);
            if (errors.length) throw failureGroup(errors, `Browser resource release failed in scope ${entry.scope.scopeId}`);
            return { released: true };
        }
        if (input.command === 'process') {
            const lease = await launchOwnedProcess(entry.scope, { ...input.options, signal: worker.cancellation.signal });
            this.processes.set(lease.resourceId, { lease, scopeId: entry.scope.scopeId });
            return { resourceId: lease.resourceId, pid: lease.pid, runId: lease.runId, scopeId: lease.scopeId, identity: lease.identity, readyLine: lease.readyLine, outputPath: lease.startupLogPath };
        }
        if (input.command === 'stop-process') {
            const owned = this.processes.get(input.resourceId);
            if (!owned || owned.scopeId !== entry.scope.scopeId) throw new Error(`Process is not owned by scope ${entry.scope.scopeId}: ${input.resourceId}`);
            await owned.lease.stop();
            return { stopped: true };
        }
        if (input.command === 'kill-process') {
            const owned = this.processes.get(input.resourceId);
            if (!owned || owned.scopeId !== entry.scope.scopeId) throw new Error(`Process is not owned by scope ${entry.scope.scopeId}: ${input.resourceId}`);
            return await owned.lease.kill(input.signal);
        }
        if (input.command === 'expect-process-exit') {
            const owned = this.processes.get(input.resourceId);
            if (!owned || owned.scopeId !== entry.scope.scopeId) throw new Error(`Process is not owned by scope ${entry.scope.scopeId}: ${input.resourceId}`);
            owned.lease.expectExit(input.expected);
            return { armed: true };
        }
        if (input.command === 'wait-process-exit') {
            const owned = this.processes.get(input.resourceId);
            if (!owned || owned.scopeId !== entry.scope.scopeId) throw new Error(`Process is not owned by scope ${entry.scope.scopeId}: ${input.resourceId}`);
            return await owned.lease.exited;
        }
        if (input.command === 'capture') {
            if (typeof input.bytes !== 'string' || Buffer.from(input.bytes, 'base64').toString('base64') !== input.bytes) throw new TypeError('Browser capture requires complete base64 bytes');
            return entry.scope.captureDiagnostic({ name: input.name, bytes: Buffer.from(input.bytes, 'base64'), contentType: input.contentType });
        }
        throw new Error(`Unknown browser resource command: ${input.command}`);
    }

    async startFrontend() {
        const entry = await this.scope(null, { kind: 'project', label: 'shared frontend application' }, { kind: 'shared' });
        const scope = {
            directory: async label => { const directory = await entry.scope.directory(label); entry.directories.push(directory); return directory; },
            verifyDirectory: directory => entry.scope.verifyDirectory(directory),
            process: options => launchOwnedProcess(entry.scope, { ...options, signal: this.frontendCancellation.signal }),
        };
        const server = await startServer({ scope, batchKey: 'frontend', scenarioId: 'shared' });
        const filename = path.join(server.dataRoot, 'default-user/settings.json');
        const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
        settings.power_user.frontend_debug_logging = true;
        fs.writeFileSync(filename, JSON.stringify(settings, null, 4));
        return { baseURL: server.baseURL, dataRoot: server.dataRoot, port: server.port, pid: server.pid, resourceId: server.resourceId, owner: server.owner, dataOwner: server.dataOwner };
    }

    plan(tests) {
        for (const test of tests) {
            let ids = this.planned.get(test.location.file);
            if (!ids) { ids = new Set(); this.planned.set(test.location.file, ids); }
            ids.add(test.id);
            this.plannedTests.set(test.id, { file: test.location.file, title: test.titlePath().join(' > ') });
        }
    }

    begin(test, result) {
        const key = caseKey(test.id, result.retry, result.workerIndex);
        const existing = this.cases.get(key);
        if (existing) {
            existing.file = test.location.file;
            existing.title = test.titlePath().join(' > ');
            return;
        }
        this.cases.set(key, { key, testId: test.id, file: test.location.file, title: test.titlePath().join(' > '), ended: false });
    }

    async close(entry) {
        if (entry.closed) return;
        entry.closed = true;
        await entry.scope.dispose();
        this.events.push({ type: 'scope-disposed', scopeId: entry.scope.scopeId });
    }

    end(test, result) {
        const actual = this.cases.get(caseKey(test.id, result.retry, result.workerIndex));
        const native = { id: test.id, file: test.location.file, title: test.titlePath(), expectedStatus: test.expectedStatus, status: result.status, retry: result.retry, workerIndex: result.workerIndex, duration: result.duration, errors: result.errors, stdout: result.stdout, stderr: result.stderr };
        this.results.push(native);
        if (result.status === 'interrupted') this.interrupted = true;
        if (result.status !== 'skipped' && result.status !== test.expectedStatus) for (const value of result.errors) {
            const error = nativeError(value);
            this.nativeFailures.add(error); this.run.recordError(error);
        }
        const attachments = [], artifactErrors = [];
        const recordFailure = error => { this.run.recordError(error); artifactErrors.push(error); };
        for (const attachment of result.attachments) {
            try {
                if (!attachment.path && attachment.body === undefined) throw new Error(`Native attachment has no readable source: ${attachment.name}`);
                const bytes = attachment.path ? fs.readFileSync(attachment.path, { flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }) : Buffer.from(attachment.body);
                attachments.push({ name: attachment.name, contentType: attachment.contentType, filename: attachment.path && path.basename(attachment.path), bytes });
            } catch (cause) { recordFailure(new Error(`Cannot read native attachment ${attachment.path ?? attachment.name}: ${cause.message}`, { cause })); }
        }
        return this.track((async () => {
            const entry = actual.entry ?? await this.scope(null, { kind: 'case', label: actual.title }, { workerIndex: result.workerIndex, file: actual.file, kind: 'case' });
            const prefix = hash(Buffer.from(actual.key));
            try { await entry.scope.captureDiagnostic({ name: `${prefix}-native-result.json`, bytes: Buffer.from(JSON.stringify(native, null, 2)), contentType: 'application/json' }); }
            catch (error) { recordFailure(error); }
            for (const [index, attachment] of attachments.entries()) {
                try { await entry.scope.captureDiagnostic({ name: `${prefix}-${index}-${attachment.filename ?? attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`, bytes: attachment.bytes, contentType: attachment.contentType }); }
                catch (error) { recordFailure(error); }
            }
            this.events.push({ type: artifactErrors.length ? 'artifacts-failed' : 'artifacts-complete', case: actual.key, attachments: attachments.map(attachment => ({ name: attachment.name, length: attachment.bytes.length, sha256: hash(attachment.bytes) })), errors: artifactErrors.map(error => serializeFailure(error)), directories: [...this.scopes.values()].filter(candidate => (candidate.workerIndex === result.workerIndex || candidate.kind === 'shared') && candidate.scope.record.state !== 'disposed').flatMap(candidate => candidate.directories.map(directory => ({ path: directory.path, present: fs.existsSync(directory.path) }))) });
            actual.ended = true; this.completed.add(test.id);
            await this.close(entry);
            for (const scenario of this.scopes.values()) if (scenario.kind === 'scenario' && scenario.file === actual.file && scenario.workerIndex === result.workerIndex && [...this.planned.get(actual.file)].every(id => this.completed.has(id))) await this.close(scenario);
            const worker = this.workers.get(result.workerIndex);
            if (worker?.closing && [...this.cases.values()].filter(candidate => candidate.key.startsWith(result.workerIndex + ':')).every(candidate => candidate.ended)) await this.close(worker);
        })());
    }

    async finish(status) {
        this.closeAdmission();
        await Promise.allSettled([...this.jobs]);
        for (const entry of this.workers.values()) {
            try { await this.close(entry); }
            catch (error) { this.run.recordError(error); }
        }
        const failed = this.run.registry.errors.length > 0 || this.results.some(result => !['passed', 'skipped', 'interrupted'].includes(result.status) && result.status !== result.expectedStatus);
        const outcome = this.interrupted || status === 'interrupted' ? 'cancelled' : failed ? 'failed' : 'passed';
        const summary = await this.run.finish({ status: outcome });
        return { name: this.project.name, registryPath: this.run.registryPath, events: this.events, results: this.results, resourceFailure: this.run.registry.errors.some(error => !this.nativeFailures.has(error)), summary: { ...summary, errors: summary.errors.map(error => serializeFailure(error)) } };
    }

    closeAdmission() {
        this.frontendCancellation.abort(new Error(`Native project ${this.project.name} reached final reporting`));
        for (const worker of this.workers.values()) {
            worker.closing = true;
            worker.cancellation.abort(new Error(`Native project ${this.project.name} reached final reporting`));
        }
    }
}

export function getRuntime() { return current; }

export function finishNativeDispatch() {
    if (!current) return;
    current.teardownComplete = true;
    for (const manager of current.projects.values()) manager.closeAdmission();
}

export async function setupRuntime(config) {
    if (current) throw new Error('Native browser resource runtime is already initialized');
    validateResourcePaths(config, path.dirname(config.configFile));
    if (config.preserveOutput !== 'always') throw new Error('Managed browser resources require preserveOutput: always so native artifacts survive until final reporting');
    current = { root: config.metadata.resourceProjectRoot ?? repository, reportPath: config.metadata.resourceReportPath ?? path.join(config.projects[0].outputDir, 'managed-run.json'), projects: new Map(), teardownComplete: false, errors: [] };
    const projects = selectedProjects(config);
    await recoverBeforeRun({ projectRoot: current.root, profiles: projects.map(project => project.name) });
    for (const project of projects) {
        const manager = new ProjectResources(current, project);
        current.projects.set(project.name, manager);
        await manager.open();
    }
    process.env.LUKER_BROWSER_RESOURCES = JSON.stringify(Object.fromEntries([...current.projects].map(([name, manager]) => [name, manager.run.registry.owner])));
}

export async function finishRuntime(status) {
    if (!current.teardownComplete) current.errors.push(new Error('Managed native teardown completion was not recorded before final reporting'));
    const managers = [...current.projects.values()].filter(manager => manager.run);
    for (const manager of managers) manager.closeAdmission();
    const errors = [...current.errors, ...[...current.projects.values()].filter(manager => manager.initializationError).map(manager => manager.initializationError)];
    await Promise.all(managers.flatMap(manager => [...manager.jobs]).map(job => job.then(() => undefined, error => { errors.push(error); })));
    const report = { nativeTeardownComplete: current.teardownComplete, nativeOutcomeBeforeResourceFinalization: status, projects: managers.map(manager => ({ name: manager.project.name, registryPath: manager.run.registryPath, events: manager.events, results: manager.results })), errors: errors.map(error => serializeFailure(error)) };
    try {
        fs.mkdirSync(path.dirname(current.reportPath), { recursive: true });
        fs.writeFileSync(current.reportPath, JSON.stringify(report, null, 2) + '\n');
    } catch (cause) {
        errors.push(new Error(`Cannot publish native browser report ${current.reportPath}: ${cause.message}`, { cause }));
    }
    const projects = [];
    for (const manager of managers) {
        for (const error of errors) manager.run.recordError(error);
        try {
            const summary = await manager.run.scope({ kind: 'run-summary', label: 'complete native browser results' });
            await summary.captureDiagnostic({ name: 'native-browser-results.json', bytes: Buffer.from(JSON.stringify({ ...report, errors: errors.map(error => serializeFailure(error)) }, null, 2)), contentType: 'application/json' });
        } catch (error) { manager.run.recordError(error); errors.push(error); }
        try { projects.push(await manager.finish(status)); }
        catch (error) { errors.push(error); }
    }
    delete process.env.LUKER_BROWSER_RESOURCES;
    if (errors.length) throw failureGroup(errors, 'Native browser resource reporting failed');
    return projects.some(project => project.resourceFailure) ? { status: 'failed' } : undefined;
}
