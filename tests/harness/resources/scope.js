import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { directoryProvider, requireProvider } from './providers.js';
import { launchOwnedProcess } from './process-owner.js';
import { failureFrom, failureGroup } from './errors.js';

/** @typedef {import('./run.js').ResourceRecord} ResourceRecord */
/** @typedef {import('./run.js').OwnedDirectory} OwnedDirectory */
/** @typedef {import('./run.js').BorrowedDirectory} BorrowedDirectory */

export class ResourceScope {
    #run;
    #parent;
    #children = [];
    #entries = [];
    #pending = new Set();
    #disposal;
    #preparation;
    #finalizers = [];
    #continuations = [];

    constructor(run, descriptor, parent = null) {
        if (!descriptor || typeof descriptor.kind !== 'string' || !descriptor.kind || typeof descriptor.label !== 'string' || !descriptor.label) {
            throw new TypeError('A scope requires a nonempty kind and label');
        }
        this.#run = run;
        this.#parent = parent;
        this.scopeId = randomUUID();
        this.record = { scopeId: this.scopeId, parentId: parent?.scopeId ?? null, kind: descriptor.kind, label: descriptor.label, state: 'active' };
        run.registry.scopes.push(this.record);
    }

    #admit(action) {
        for (let scope = this; scope !== null; scope = scope.#parent) {
            if (scope.record.state !== 'active') return Promise.reject(new Error(`Scope ${scope.scopeId} is ${scope.record.state}`));
        }
        if (!this.#run.active) return Promise.reject(new Error(`Run ${this.#run.runId} is finishing or finished`));
        const operation = action().catch(error => {
            this.#run.recordError(error);
            throw error;
        }).finally(() => { this.#pending.delete(operation); });
        this.#pending.add(operation);
        return operation;
    }

    child(descriptor) {
        return this.#admit(async () => {
            const child = new ResourceScope(this.#run, descriptor, this);
            this.#children.push(child);
            await this.#run.registry.save();
            return child;
        });
    }

    #dependencyVisible(scopeId) {
        return scopeId === this.scopeId || (this.#parent !== null && this.#parent.#dependencyVisible(scopeId));
    }

    #sharedOwner() {
        let scope = this;
        while (scope.#parent !== null && scope.record.kind !== 'worker') scope = scope.#parent;
        return scope;
    }

    get transport() { return 'local'; }

    get sharedScopeId() { return this.#sharedOwner().scopeId; }

    /** Keep reusable physical resources in worker custody, not a released case. */
    acquireShared(descriptor) {
        return this.#admit(() => this.#sharedOwner().acquire(descriptor));
    }

    releaseShared(resource) {
        return this.#admit(() => this.#sharedOwner().release(resource));
    }

    /** Internal admission is restricted to exactly registered provider functions. */
    acquire({ kind, label, allocate, dispose, dependsOn = [], options }) {
        return this.#admit(async () => {
            const provider = requireProvider({ kind, allocate, dispose });
            if (typeof label !== 'string' || !label) throw new TypeError('A resource requires a nonempty label');
            if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length) throw new TypeError('Resource dependencies must be distinct resource identities');
            for (const resourceId of dependsOn) {
                const dependency = this.#run.registry.resources.find(record => record.resourceId === resourceId);
                if (!dependency || dependency.owner !== 'owned' || dependency.state !== 'ready' || !this.#dependencyVisible(dependency.scopeId)) {
                    throw new Error(`Resource dependency is not ready in this scope or its ancestors: ${resourceId}`);
                }
            }
            /** @type {ResourceRecord} */
            const resourceId = randomUUID();
            const directoryPath = path.join(this.#run.registry.dataRoot, resourceId);
            const locator = kind === 'process'
                ? { executionId: randomUUID(), ownerExecutionId: this.#run.registry.owner.executionId, controller: null, worker: null }
                : { path: directoryPath, dev: null, ino: null };
            const record = { runId: this.#run.runId, scopeId: this.scopeId, resourceId, kind, label, locator, owner: 'owned', state: 'allocating', dependencies: [...dependsOn] };
            Object.defineProperty(record, 'removeDirectory', { value: () => this.#run.registry.removeDirectory(record) });
            Object.defineProperty(record, 'stopProcess', { value: () => this.#run.registry.stopProcess(record) });
            const entry = { record, provider, options: options ?? {}, release: null, releaseReported: false };
            this.#entries.push(entry);
            this.#run.registry.resources.push(record);
            try {
                await this.#run.registry.save();
                const value = await provider.allocate(Object.freeze({
                    runId: record.runId, scopeId: record.scopeId, resourceId: record.resourceId, directoryPath,
                    createDirectory: () => this.#run.registry.allocateDirectory(record),
                    publish: locator => this.#run.registry.publishDirectory(record, locator),
                    startProcess: () => {
                        const signal = options.signal && this.#run.signal ? AbortSignal.any([this.#run.signal, options.signal]) : options.signal ?? this.#run.signal;
                        return this.#run.registry.launchProcess(record, { ...options, signal });
                    },
                }), entry.options);
                if (record.state !== 'acquired') throw new Error(`Provider did not publish resource ${record.resourceId} before readiness`);
                record.state = 'ready';
                await this.#run.registry.save();
                return value;
            } catch (error) {
                const primary = failureFrom(error, `Resource ${record.resourceId} allocation rejected`);
                this.#run.recordError(primary);
                const cleanupErrors = await this.#release(entry);
                if (cleanupErrors.length) throw failureGroup([primary, ...cleanupErrors], `Acquisition and cleanup failed for resource ${record.resourceId}`);
                throw primary;
            }
        });
    }

    /** @returns {Promise<OwnedDirectory>} */
    directory(label) {
        return this.acquire({ ...directoryProvider, label });
    }

    /** @param {OwnedDirectory} directory @returns {Promise<OwnedDirectory>} */
    verifyDirectory(directory) {
        return this.#admit(async () => {
            const record = this.#run.registry.resources.find(record => record.resourceId === directory?.resourceId);
            if (!record || record.owner !== 'owned' || record.kind !== 'directory' || !this.#dependencyVisible(record.scopeId)) throw new Error(`Directory receipt does not match registered scope ownership: ${directory?.resourceId}`);
            const actual = this.#run.registry.verifyDirectory(record);
            if (Object.entries(actual).some(([key, value]) => directory[key] !== value)) throw new Error(`Directory receipt does not match registered resource ${record.resourceId}: ${directory.path}`);
            return actual;
        });
    }

    /** @param {import('./run.js').ProcessOptions} options */
    process(options) {
        return launchOwnedProcess(this, options);
    }

    /** @param {import('./run.js').DiagnosticCapture} descriptor */
    captureDiagnostic(descriptor) {
        return this.#admit(() => this.#run.diagnostics.capture(this.scopeId, descriptor));
    }

    /** @param {import('./run.js').Finalizer} descriptor */
    onFinalize({ label, stage, callback }) {
        return this.#admit(async () => {
            if (typeof label !== 'string' || !label || !['capture', 'drain', 'complete'].includes(stage) || typeof callback !== 'function') throw new TypeError('Scope finalization requires a label, capture/drain/complete stage and callback');
            const record = { id: randomUUID(), label, stage, state: 'registered' };
            this.record.finalizers ??= [];
            this.record.finalizers.push(record);
            this.#finalizers.push({ record, callback });
            await this.#run.registry.save();
            return record.id;
        });
    }

    /** @param {import('./run.js').DiagnosticProducer} descriptor */
    diagnostic(descriptor) {
        if (!descriptor || typeof descriptor.produce !== 'function' || !['capture', 'complete', undefined].includes(descriptor.stage) || typeof descriptor.name !== 'string' || !descriptor.name || path.basename(descriptor.name) !== descriptor.name || ['.', '..'].includes(descriptor.name) || /[\0\\/]/.test(descriptor.name) || typeof descriptor.contentType !== 'string' || !descriptor.contentType) return Promise.reject(new TypeError('Deferred diagnostic requires a filename, content type, capture/complete stage and producer'));
        const { name, contentType, produce, stage = 'capture' } = descriptor;
        return this.onFinalize({ label: name, stage, callback: async () => {
            try { await this.#run.diagnostics.capture(this.scopeId, { name, contentType, bytes: await produce() }); }
            catch (value) {
                const error = failureFrom(value, `Diagnostic producer ${name} rejected in scope ${this.scopeId}`);
                this.#run.recordError(error);
                try { await this.#run.diagnostics.captureFailed(this.scopeId, { name, contentType }, error); }
                catch (publication) { throw failureGroup([error, publication], `Cannot retain failed diagnostic capture ${name} in scope ${this.scopeId}`); }
                throw error;
            }
        } });
    }

    /** Register before invoking an actual native producer; join it in the drain stage. */
    continuation({ label, start }) {
        return this.#admit(async () => {
            if (typeof label !== 'string' || !label || typeof start !== 'function') throw new TypeError('Scope continuation requires a label and start callback');
            const record = { id: randomUUID(), label, stage: 'drain', state: 'registered' };
            this.record.finalizers ??= [];
            this.record.finalizers.push(record);
            await this.#run.registry.save();
            const operation = (async () => {
                try { return await start(this.#run.signal); }
                catch (value) { const error = failureFrom(value, `Continuation ${label} rejected in scope ${this.scopeId}`); this.#run.recordError(error); throw error; }
            })();
            const receipts = Promise.allSettled([operation]);
            this.#continuations.push({ record, callback: async () => {
                const [receipt] = await receipts;
                if (receipt.status === 'rejected') throw receipt.reason;
            } });
            return Object.freeze({ settled: operation });
        });
    }

    #invoke(entry) {
        const { record, callback } = entry;
        entry.operation ??= (async () => {
            const failures = [];
            record.state = 'running';
            try { await callback(); record.state = 'completed'; }
            catch (value) { const error = failureFrom(value, `Finalizer ${record.label} rejected in scope ${this.scopeId}`); this.#run.recordError(error); failures.push(error); record.state = 'failed'; }
            try { await this.#run.registry.save(); }
            catch (error) { this.#run.recordError(error); failures.push(error); }
            return failures;
        })();
        return entry.operation;
    }

    async #stage(stage, errors) {
        for (const child of [...this.#children].reverse()) await child.#stage(stage, errors);
        for (const entry of this.#finalizers.filter(entry => entry.record.stage === stage)) errors.push(...await this.#invoke(entry));
    }

    #startDrain(continuations) {
        return [
            ...[...this.#children].reverse().flatMap(child => child.#startDrain(continuations)),
            ...(continuations ? this.#continuations : this.#finalizers.filter(entry => entry.record.stage === 'drain')).map(entry => this.#invoke(entry)),
        ];
    }

    #seal() {
        if (this.record.state === 'active') this.record.state = 'disposing';
        for (const child of this.#children) child.#seal();
    }

    async #joinAdmission() {
        await Promise.allSettled([...this.#pending]);
        for (const child of this.#children) await child.#joinAdmission();
    }

    prepare() {
        if (this.#preparation) return this.#preparation;
        this.#seal();
        this.#preparation = (async () => {
            await this.#joinAdmission();
            this.#seal();
            const errors = [];
            await this.#stage('capture', errors);
            const actions = this.#startDrain(false);
            const continuations = this.#startDrain(true);
            for (const failures of await Promise.all([...actions, ...continuations])) errors.push(...failures);
            await this.#stage('complete', errors);
            if (errors.length) throw failureGroup(errors, `Cannot complete scope ${this.scopeId} producers`);
        })();
        return this.#preparation;
    }

    /** @returns {Promise<BorrowedDirectory>} */
    borrowDirectory(directory) {
        return this.#admit(async () => {
            if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('A borrowed directory requires an absolute path');
            const record = { runId: this.#run.runId, scopeId: this.scopeId, resourceId: randomUUID(), kind: 'directory', locator: null, owner: 'borrowed', state: 'registered', dependencies: [] };
            const value = this.#run.registry.borrow(record, directory);
            this.#entries.push({ record, release: null, releaseReported: false });
            await this.#run.registry.save();
            return value;
        });
    }

    /**
     * Release one owned resource before scope disposal. Errors are returned to
     * the caller instead of being reported again when the scope disposes.
     * @param {string|{resourceId: string}} resource
     * @returns {Promise<Error[]>}
     */
    async release(resource) {
        const resourceId = typeof resource === 'string' ? resource : resource?.resourceId;
        if (typeof resourceId !== 'string' || !resourceId) throw new TypeError('A resource release requires a resource identity');
        const entry = this.#entries.find(item => item.record.resourceId === resourceId);
        if (!entry) throw new Error(`Resource ${resourceId} is not owned by scope ${this.scopeId}`);
        const errors = await this.#release(entry);
        entry.releaseReported = true;
        return errors.map(error => error.cause ?? error);
    }

    #release(entry) {
        if (entry.release) return entry.release;
        entry.release = (async () => {
            const { record } = entry;
            const errors = [];
            let cleanupFailed = false;
            const failed = cause => {
                cleanupFailed = true;
                cause = failureFrom(cause, `Resource ${record.resourceId} cleanup rejected`);
                record.state = 'cleanup-failed';
                const error = new Error(`Cannot dispose resource ${record.resourceId} (${record.kind}) at ${record.locator?.path ?? 'unpublished identity'}: ${cause.message}`, { cause });
                error.resource = structuredClone(record);
                errors.push(error);
                this.#run.recordError(error);
            };
            if (record.owner === 'owned') {
                try {
                    const blocked = this.#run.registry.resources.find(dependent => dependent.dependencies.includes(record.resourceId) && dependent.state === 'cleanup-failed');
                    if (blocked) throw new Error(`Resource ${record.resourceId} is retained because dependent resource ${blocked.resourceId} has no successful disposal receipt`);
                    if (this.#run.registry.hasAllocation(record)) {
                        try { await this.#run.diagnostics.stageEnvironment(record); }
                        catch (error) { this.#run.recordError(error); errors.push(error); this.#run.registry.environmentExport.state = 'failed'; }
                        await entry.provider.dispose(record, entry.options);
                    }
                } catch (error) {
                    failed(error);
                }
            }
            if (!cleanupFailed) record.state = record.owner === 'borrowed' ? 'released' : 'disposed';
            try {
                await this.#run.registry.save();
            } catch (error) {
                failed(error);
            }
            return errors;
        })();
        return entry.release;
    }

    dispose() {
        if (this.#disposal) return this.#disposal;
        this.record.state = 'disposing';
        this.#disposal = (async () => {
            const errors = [];
            try { await this.prepare(); }
            catch (error) { errors.push(error); }
            for (const child of [...this.#children].reverse()) {
                try {
                    await child.dispose();
                } catch (error) {
                    errors.push(...error.errors);
                }
            }
            // Dependencies must already be ready when admitted, so reverse admission is topological.
            for (const entry of [...this.#entries].reverse()) {
                const released = await this.#release(entry);
                if (!entry.releaseReported) errors.push(...released);
            }
            this.record.state = 'disposed';
            if (errors.length) throw failureGroup(errors, `Cannot dispose scope ${this.scopeId}`);
        })();
        return this.#disposal;
    }
}
