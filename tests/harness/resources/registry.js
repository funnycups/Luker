import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { failureGroup, failureEvents, failureFrom, receiveFailureGraph, failureFingerprint } from './errors.js';
import { Authority } from './authority.js';
import { readProcessIdentity } from './native-identity.js';
import { processAllocation } from './process-owner.js';
import { processDiagnostics } from './process-diagnostics.js';
import { WriterCustody } from './writer-custody.js';
import { openProcessTerminal } from './process-terminal.js';
import { requireRecoveryProvider } from './providers.js';

/** @typedef {import('./run.js').ResourceRecord} ResourceRecord */

export function contains(parent, target) {
    const relative = path.relative(parent, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function directoryIdentitySync(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Directory boundary is not a real directory: ${directory}`);
    return Object.freeze({ path: directory, dev: stat.dev, ino: stat.ino });
}

function verifyIdentity(identity) {
    const actual = directoryIdentitySync(identity.path);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error(`Directory ownership boundary changed: ${identity.path}`);
}

function admitDirectory(directory) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return directoryIdentitySync(directory);
}

/**
 * Verified pathname mutations are synchronous transactions on this event loop.
 * Independent processes must not mutate an admitted boundary during its mutation;
 * pathname APIs do not provide cross-process inode-conditional mutation.
 */
export class Registry {
    #writes = Promise.resolve();
    #fileIdentity;
    #boundaries;
    #dataIdentity;
    #allocations = new WeakMap();
    #authority;
    #custody;
    #previousErrors = [];
    #diagnostic = processDiagnostics({});

    constructor(options, runId, boundaries, dataIdentity) {
        this.runId = runId;
        this.profile = options.profile;
        this.command = [...options.command];
        this.source = options.source;
        this.projectRoot = options.projectRoot;
        this.format = 'resource-run-v2';
        this.admission = 'initializing';
        this.owner = options.owner;
        this.writer = this.owner;
        this.file = path.join(boundaries.at(-1).path, 'registry.json');
        this.dataRoot = dataIdentity.path;
        this.scopes = [];
        /** @type {ResourceRecord[]} */
        this.resources = [];
        this.status = 'running';
        this.errors = [];
        this.diagnosticIndex = null;
        this.diagnostics = null;
        this.environmentExport = options.exportEnvironmentTo === undefined ? null : { destination: options.exportEnvironmentTo, state: 'requested' };
        this.#boundaries = boundaries;
        this.#dataIdentity = dataIdentity;
        this.custodyBoundary = { path: path.join(boundaries.at(-1).path, 'writer-custody'), dev: null, ino: null };
    }

    static async create(options, runId) {
        const boundaries = [directoryIdentitySync(options.projectRoot)];
        const owner = { runId, pid: process.pid, executionId: randomUUID(), native: await readProcessIdentity(process.pid), control: null };
        let directory = options.projectRoot;
        for (const component of ['test-results', 'harness', 'runs']) {
            for (const identity of boundaries) verifyIdentity(identity);
            directory = path.join(directory, component);
            boundaries.push(admitDirectory(directory));
        }
        for (const identity of boundaries) verifyIdentity(identity);
        directory = path.join(directory, runId);
        fs.mkdirSync(directory, { mode: 0o700 });
        boundaries.push(directoryIdentitySync(directory));
        const registry = new Registry({ ...options, owner }, runId, boundaries, { path: path.join(directory, 'data'), dev: null, ino: null });
        try {
            registry.verifyBoundaries();
            fs.mkdirSync(registry.custodyBoundary.path, { mode: 0o700 });
            registry.custodyBoundary = directoryIdentitySync(registry.custodyBoundary.path);
            registry.#custody = await WriterCustody.acquire(registry.custodyBoundary, owner, () => registry.verifyBoundaries());
            await registry.save();
            registry.#authority = await Authority.open(owner, { handle: options.authorityHandler, onError: error => registry.reportError(error) });
            registry.owner = registry.#authority.identity;
            registry.writer = registry.owner;
            registry.verifyBoundaries();
            fs.mkdirSync(registry.dataRoot, { mode: 0o700 });
            registry.#dataIdentity = directoryIdentitySync(registry.dataRoot);
            registry.admission = 'ready';
            await registry.save();
            return registry;
        } catch (error) {
            return registry.rejectAdmission(error);
        }
    }

    reportError(error) {
        for (const event of failureEvents(error)) {
            const original = failureFrom(event);
            if (!this.errors.includes(original)) this.errors.push(original);
        }
    }

    diagnosticGraph(value) { return this.#diagnostic.failure(value); }

    /** Retry authority requires the complete original content in the same error store. */
    retainsFailure(event, original) {
        const expected = failureFingerprint(receiveFailureGraph(this.#diagnostic.failure(original)));
        const contains = value => {
            if (!value || typeof value !== 'object') return false;
            if (value.type === 'error' && value.event?.id === event.id && value.event.fingerprint === event.fingerprint && failureFingerprint(receiveFailureGraph(this.#diagnostic.failure(value.cause))) === expected) return true;
            return Object.values(value).some(contains);
        };
        return [...this.#previousErrors, ...this.errors.map(error => this.#diagnostic.failure(error))].some(graph => contains(receiveFailureGraph(graph)));
    }

    closeAuthority() {
        return this.#authority?.close();
    }

    concludeWriter() {
        this.#custody?.conclude();
    }

    async rejectAdmission(error) {
        const errors = [error];
        try { await this.closeAuthority(); }
        catch (cleanup) { errors.push(cleanup); }
        try { this.concludeWriter(); }
        catch (cleanup) { errors.push(cleanup); }
        errors.push(...this.errors);
        const originals = [...new Set(errors)];
        throw originals.length === 1 ? error : failureGroup(originals, `Run admission and owner release failed: ${this.file}`);
    }

    failure(message) {
        return failureGroup([...this.#previousErrors.map(value => new Error(`Previously recorded run failure: ${value.message}`, { cause: value })), ...this.errors], message);
    }

    verifyBoundaries() {
        for (const identity of this.#boundaries) verifyIdentity(identity);
    }

    verifyDataBoundary() {
        this.verifyBoundaries();
        verifyIdentity(this.#dataIdentity);
    }

    assertUnborrowed(directory) {
        for (const record of this.resources) {
            if (record.owner === 'borrowed' && (contains(record.locator.realPath, directory) || contains(directory, record.locator.realPath))) {
                throw new Error(`Directory overlaps borrowed resource ${record.resourceId}: ${directory}`);
            }
        }
    }

    #registeredDirectory(record) {
        if (record.owner !== 'owned' || !this.resources.includes(record)) throw new Error(`Resource is not registered as owned: ${record.resourceId}`);
        const expected = path.join(this.dataRoot, record.resourceId);
        if (record.locator.path !== expected) throw new Error(`Resource locator is outside its registered boundary: ${record.resourceId}`);
        this.assertUnborrowed(expected);
    }

    allocateDirectory(record) {
        this.#registeredDirectory(record);
        if (this.#allocations.has(record)) throw new Error(`Resource was already allocated: ${record.resourceId}`);
        this.verifyDataBoundary();
        fs.mkdirSync(record.locator.path, { mode: 0o700 });
        const identity = directoryIdentitySync(record.locator.path);
        this.#allocations.set(record, identity);
        record.locator = identity;
        record.state = 'created';
        return identity;
    }

    async publishDirectory(record, locator) {
        this.#registeredDirectory(record);
        const identity = this.#allocations.get(record);
        if (!identity) throw new Error(`Allocation ownership was not established for resource ${record.resourceId} at ${record.locator.path}`);
        if (locator.path !== identity.path || locator.dev !== identity.dev || locator.ino !== identity.ino) throw new Error(`Resource ${record.resourceId} must publish its actual allocated directory: ${identity.path}`);
        this.verifyDataBoundary();
        verifyIdentity(identity);
        record.state = 'acquired';
        await this.save();
    }

    verifyDirectory(record) {
        this.#registeredDirectory(record);
        const allocated = this.#allocations.get(record);
        if (record.kind !== 'directory' || record.state !== 'ready' || !allocated) throw new Error(`Directory has no ready allocation authority: ${record.resourceId}`);
        if (record.locator.dev !== allocated.dev || record.locator.ino !== allocated.ino) throw new Error(`Registered directory identity changed: ${record.resourceId}`);
        this.verifyDataBoundary();
        verifyIdentity(allocated);
        return Object.freeze({ path: allocated.path, dev: allocated.dev, ino: allocated.ino, resourceId: record.resourceId, ownership: 'owned' });
    }

    hasAllocation(record) {
        if (record.kind === 'process') {
            if (record.owner !== 'owned' || !this.resources.includes(record)) throw new Error(`Process is not registered as owned: ${record.resourceId}`);
            return this.#allocations.has(record);
        }
        this.#registeredDirectory(record);
        if (this.#allocations.has(record)) return true;
        this.verifyDataBoundary();
        try { fs.lstatSync(record.locator.path); }
        catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
        throw new Error(`Unresolved allocation ownership for resource ${record.resourceId} at ${record.locator.path}: identity was not published; retained without deletion`);
    }

    removeDirectory(record) {
        this.#registeredDirectory(record);
        const identity = this.#allocations.get(record);
        if (!identity) throw new Error(`Cannot remove resource without established allocation ownership: ${record.resourceId} at ${record.locator.path}`);
        this.verifyDataBoundary();
        verifyIdentity(identity);
        fs.rmSync(identity.path, { recursive: true });
    }

    async launchProcess(record, options) {
        if (record.kind !== 'process' || record.owner !== 'owned' || !this.resources.includes(record) || record.locator.ownerExecutionId !== this.owner.executionId) throw new Error(`Process allocation has no run authority: ${record.resourceId}`);
        this.verifyBoundaries();
        this.#diagnostic = this.#diagnostic.extend(options);
        const filename = path.join(path.dirname(this.file), `${record.resourceId}-startup.log`);
        record.startupLog = { path: filename, dev: null, ino: null };
        record.terminal = { path: path.join(path.dirname(this.file), `${record.resourceId}-terminal.json`), dev: null, ino: null, acknowledged: null };
        await this.save();
        this.verifyBoundaries();
        const descriptor = fs.openSync(filename, 'wx', 0o600);
        let identity;
        try { identity = fs.fstatSync(descriptor); }
        catch (error) {
            try { fs.closeSync(descriptor); }
            catch (cleanup) { throw failureGroup([error, cleanup], `Cannot acquire startup log identity: ${filename}`); }
            throw error;
        }
        record.startupLog = { path: filename, dev: identity.dev, ino: identity.ino };
        let terminal;
        try { this.verifyBoundaries(); terminal = openProcessTerminal(record); }
        catch (error) {
            try { fs.closeSync(descriptor); }
            catch (cleanup) { throw failureGroup([error, cleanup], `Cannot acquire terminal transport for process ${record.resourceId}`); }
            throw error;
        }
        let text = '';
        let closed = false;
        const append = value => {
            fs.writeSync(descriptor, value);
            text += value;
        };
        const diagnostic = processDiagnostics(options, (stream, value) => append(value));
        const log = {
            path: filename,
            get text() { return text; },
            append,
            write: diagnostic.write,
            flush: diagnostic.flush,
            close() {
                if (closed) return;
                closed = true;
                const errors = [];
                try { this.flush(); fs.fsyncSync(descriptor); }
                catch (error) { errors.push(error); }
                try { fs.closeSync(descriptor); }
                catch (error) { errors.push(error); }
                if (errors.length) throw failureGroup(errors, `Cannot close startup log: ${filename}`);
            },
        };
        const allocation = processAllocation({ record, owner: this.owner, options, log, terminal, registry: this,
            publish: async (locator, state) => { record.locator = locator; if (state) record.state = state; await this.save(); },
            onError: error => this.reportError(error),
        });
        this.#allocations.set(record, allocation);
        await this.save();
        const lease = await allocation.start();
        record.state = 'acquired';
        await this.save();
        return lease;
    }

    stopProcess(record) {
        if (record.kind !== 'process' || record.owner !== 'owned' || !this.resources.includes(record)) throw new Error(`Process release has no run authority: ${record.resourceId}`);
        return this.#allocations.get(record).stop();
    }

    borrow(record, directory) {
        const absolute = path.resolve(directory);
        const realPath = fs.realpathSync(absolute);
        const identity = directoryIdentitySync(realPath);
        for (const owned of this.resources) {
            if (owned.owner !== 'owned') continue;
            const ownedPath = path.join(this.dataRoot, owned.resourceId);
            if (contains(ownedPath, realPath) || contains(realPath, ownedPath)) throw new Error(`Borrowed directory overlaps owned resource ${owned.resourceId}: ${absolute}`);
        }
        record.locator = { ...identity, path: absolute, realPath };
        record.state = 'borrowed';
        this.resources.push(record);
        return Object.freeze({ path: absolute, ownership: 'borrowed' });
    }

    snapshot() {
        return {
            format: this.format, admission: this.admission, writer: this.writer, recovery: this.recovery,
            runId: this.runId, profile: this.profile, command: this.command, source: this.source,
            projectRoot: this.projectRoot, owner: this.owner, status: this.status,
            boundaries: this.#boundaries, dataBoundary: this.#dataIdentity, custodyBoundary: this.custodyBoundary,
            scopes: this.scopes, resources: this.resources,
            errors: [...this.#previousErrors.map(error => {
                const projected = this.#diagnostic.failure(error);
                return isDeepStrictEqual(projected, error) ? error : projected;
            }), ...this.errors.map(error => this.#diagnostic.failure(error))], redaction: this.#diagnostic.redaction, diagnosticIndex: this.diagnosticIndex, diagnostics: this.diagnostics, environmentExport: this.environmentExport,
        };
    }

    /** Restore and validate ownership without granting mutation authority. */
    static reopen(snapshot) {
        const registry = new Registry({ ...snapshot, owner: snapshot.owner }, snapshot.runId, snapshot.boundaries, snapshot.dataBoundary);
        registry.admission = snapshot.admission;
        registry.writer = snapshot.writer;
        registry.custodyBoundary = snapshot.custodyBoundary;
        registry.scopes = snapshot.scopes;
        registry.resources = snapshot.resources;
        registry.status = snapshot.status;
        registry.#previousErrors = snapshot.errors.map(receiveFailureGraph);
        if (!Object.hasOwn(snapshot, 'redaction')) throw new Error(`Run ${snapshot.runId} has no verifiable diagnostic redaction policy; retain registry and scenario data`);
        try { registry.#diagnostic = processDiagnostics({}, undefined, snapshot.redaction); }
        catch (cause) { throw new Error(`Run ${snapshot.runId} has an invalid diagnostic redaction policy: ${cause.message}`, { cause }); }
        registry.diagnosticIndex = snapshot.diagnosticIndex;
        registry.diagnostics = snapshot.diagnostics ?? null;
        registry.environmentExport = snapshot.environmentExport ?? null;
        registry.recovery = snapshot.recovery;
        const stat = fs.lstatSync(registry.file);
        if (!stat.isFile()) throw new Error(`Recovery registry is not a real file: ${registry.file}`);
        registry.#fileIdentity = { dev: stat.dev, ino: stat.ino };
        registry.verifyDataBoundary();
        for (const record of registry.resources) {
            if (record.owner !== 'owned' || record.kind === 'process' || ['disposed', 'released'].includes(record.state)) continue;
            if (record.kind !== 'directory') requireRecoveryProvider(record.kind);
            registry.#registeredDirectory(record);
            try {
                verifyIdentity(record.locator);
                registry.#allocations.set(record, record.locator);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        return registry;
    }

    claimWriter(authority, custody) {
        custody.verify();
        this.writer = authority.identity;
        this.#authority = authority;
        this.#custody = custody;
    }

    #verifyFile() {
        if (!this.#fileIdentity) return;
        const actual = fs.lstatSync(this.file);
        if (!actual.isFile() || actual.dev !== this.#fileIdentity.dev || actual.ino !== this.#fileIdentity.ino) throw new Error(`Registry file ownership changed: ${this.file}`);
    }

    save() {
        const preceding = this.#writes;
        const writing = (async () => {
            await Promise.allSettled([preceding]);
            const temporary = path.join(path.dirname(this.file), `registry-${randomUUID()}.tmp`);
            const errors = [];
            let identity;
            let file;
            let published = false;
            let stage = 'prepare';
            try {
                this.#custody.verify();
                const bytes = `${JSON.stringify(this.snapshot())}\n`;
                this.verifyBoundaries();
                this.#verifyFile();
                file = fs.openSync(temporary, 'wx', 0o600);
                identity = fs.fstatSync(file);
                fs.writeFileSync(file, bytes);
                fs.fsyncSync(file);
            } catch (error) { errors.push(error); }
            if (file !== undefined) {
                try { fs.closeSync(file); } catch (error) { errors.push(error); }
            }
            if (errors.length === 0) {
                try {
                    stage = 'publish';
                    this.verifyBoundaries();
                    this.#verifyFile();
                    const actual = fs.lstatSync(temporary);
                    if (!actual.isFile() || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error(`Registry temporary file ownership changed: ${temporary}`);
                    fs.renameSync(temporary, this.file);
                    published = true;
                    this.#fileIdentity = { dev: identity.dev, ino: identity.ino };
                    stage = 'durability';
                    this.verifyBoundaries();
                    const directory = fs.openSync(path.dirname(this.file), 'r');
                    try {
                        await new Promise((resolve, reject) => fs.fsync(directory, error => error ? reject(error) : resolve()));
                    } catch (error) { errors.push(error); }
                    try { fs.closeSync(directory); } catch (error) { errors.push(error); }
                } catch (error) { errors.push(error); }
            }
            if (!published && identity) {
                try {
                    this.verifyBoundaries();
                    const actual = fs.lstatSync(temporary);
                    if (!actual.isFile() || actual.dev !== identity.dev || actual.ino !== identity.ino) throw new Error(`Registry temporary file ownership changed: ${temporary}`);
                    fs.unlinkSync(temporary);
                } catch (error) { errors.push(error); }
            }
            if (errors.length) {
                const failure = new AggregateError(errors, `Cannot persist resource registry at ${stage}: ${this.file}: ${errors.map(error => error.message).join('; ')}`);
                failure.publication = { registryPath: this.file, temporary, stage, published };
                throw failure;
            }
        })();
        this.#writes = writing;
        return writing;
    }
}
