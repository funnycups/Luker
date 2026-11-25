import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Registry, contains } from './registry.js';
import { requestAuthority } from './authority.js';
import { readProcessIdentity, sameProcessIdentity, validateProcessIdentity, validateProcessExit } from './native-identity.js';
import { recoverOwnedProcess } from './process-owner.js';
import { failureGroup } from './errors.js';
import { validateProcessTerminalRegistration } from './process-terminal.js';
import { reserveWriter, executionEnded, verifyCustodyBoundary } from './writer-custody.js';
import { RunDiagnostics } from './diagnostics.js';
import { requireRecoveryProvider } from './providers.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const terminal = new Set(['disposed', 'released']);
const states = new Set(['registered', 'allocating', 'created', 'acquired', 'ready', 'borrowed', 'stopped', 'exited', 'released', 'disposed', 'cleanup-failed']);

function realDirectory(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Recovery directory is not a real boundary: ${directory}`);
    return stat;
}

function validateAuthority(identity, runId) {
    if (!identity || identity.runId !== runId || !uuid.test(identity.executionId) || identity.control?.host !== '127.0.0.1' || !Number.isInteger(identity.control.port) || identity.control.port < 1 || identity.control.port > 65535) throw new Error(`Run ${runId} has no verifiable execution authority`);
    validateProcessIdentity(identity.native);
    if (identity.native.platform !== process.platform) throw new Error(`Run ${runId} requires native ${identity.native.platform} identity inspection on its original platform`);
}

function readSnapshot(projectRoot, runDirectory, profiles) {
    realDirectory(runDirectory);
    const filename = path.join(runDirectory, 'registry.json');
    let stat;
    try { stat = fs.lstatSync(filename); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile()) throw new Error(`Recovery registry is not a real file: ${filename}`);
    const snapshot = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (snapshot.format !== 'resource-run-v2') return null;
    const id = path.basename(runDirectory);
    if (typeof snapshot.profile !== 'string' || !snapshot.profile) throw new Error(`Run ${id} has no registered recovery profile: ${filename}`);
    if (!profiles.includes(snapshot.profile)) return null;
    if (!uuid.test(id) || snapshot.runId !== id || snapshot.projectRoot !== projectRoot || snapshot.admission !== 'ready' || !Array.isArray(snapshot.scopes) || !Array.isArray(snapshot.resources) || !Array.isArray(snapshot.errors) || !['running', 'passed', 'failed', 'cancelled'].includes(snapshot.status) || !Array.isArray(snapshot.command) || !snapshot.command.length || snapshot.command.some(value => typeof value !== 'string') || typeof snapshot.source !== 'string' || !snapshot.source) throw new Error(`Run ${id} has an incomplete or inconsistent recovery registry: ${filename}`);
    const pendingDiagnostics = snapshot.diagnostics && (snapshot.diagnostics.format !== 'run-diagnostics-v2' || typeof snapshot.diagnostics.retentionPending !== 'boolean' || !Array.isArray(snapshot.diagnostics.pending) || snapshot.diagnostics.pending.length > 0 || !['published', 'discarded', 'retired'].includes(snapshot.diagnostics.stage) || snapshot.diagnostics.retentionPending === true || snapshot.diagnostics.retirement?.state === 'removing');
    if (!pendingDiagnostics && snapshot.environmentExport?.state !== 'requested' && snapshot.environmentExport?.cleanup?.state !== 'removing' && (snapshot.recovery?.state === 'recovered' || snapshot.status !== 'running' && snapshot.resources.every(record => record && terminal.has(record.state)))) return null;
    validateAuthority(snapshot.owner, id);
    validateAuthority(snapshot.writer, id);
    if (snapshot.writer.control.port !== snapshot.owner.control.port) throw new Error(`Run ${id} writer is outside its registered execution authority`);
    const expected = [projectRoot];
    for (const component of ['test-results', 'harness', 'runs', id]) expected.push(path.join(expected.at(-1), component));
    if (!Array.isArray(snapshot.boundaries) || snapshot.boundaries.length !== expected.length) throw new Error(`Run ${id} has incomplete registered directory boundaries`);
    for (const [index, boundary] of snapshot.boundaries.entries()) {
        if (boundary.path !== expected[index]) throw new Error(`Run ${id} directory boundary is outside its registered path: ${boundary.path}`);
        const actual = realDirectory(boundary.path);
        if (actual.dev !== boundary.dev || actual.ino !== boundary.ino) throw new Error(`Run ${id} directory ownership boundary changed: ${boundary.path}`);
    }
    verifyCustodyBoundary(snapshot.custodyBoundary, runDirectory);
    if (snapshot.dataBoundary?.path !== path.join(runDirectory, 'data')) throw new Error(`Run ${id} data boundary is outside its registered path`);
    const data = realDirectory(snapshot.dataBoundary.path);
    if (data.dev !== snapshot.dataBoundary.dev || data.ino !== snapshot.dataBoundary.ino) throw new Error(`Run ${id} data ownership boundary changed: ${snapshot.dataBoundary.path}`);
    const scopes = new Map();
    for (const scope of snapshot.scopes) {
        if (!uuid.test(scope.scopeId) || scopes.has(scope.scopeId) || typeof scope.kind !== 'string' || !scope.kind || typeof scope.label !== 'string' || !scope.label || !['active', 'disposing', 'disposed'].includes(scope.state)) throw new Error(`Run ${id} has an invalid scope identity`);
        if (scope.finalizers !== undefined && (!Array.isArray(scope.finalizers) || scope.finalizers.some(finalizer => !uuid.test(finalizer?.id) || typeof finalizer.label !== 'string' || !finalizer.label || !['capture', 'drain', 'complete'].includes(finalizer.stage) || !['registered', 'running', 'completed', 'failed', 'interrupted'].includes(finalizer.state)))) throw new Error(`Run ${id} scope ${scope.scopeId} has invalid finalizer records`);
        for (const finalizer of scope.finalizers ?? []) if (finalizer.state === 'interrupted' && (finalizer.interruption?.executionId !== snapshot.owner.executionId || !['registered', 'running', 'failed'].includes(finalizer.interruption?.previousState))) throw new Error(`Run ${id} finalizer ${finalizer.id} has an invalid interruption receipt`);
        scopes.set(scope.scopeId, scope);
    }
    for (const scope of scopes.values()) {
        const seen = new Set([scope.scopeId]);
        let parentId = scope.parentId;
        while (parentId !== null) {
            if (!scopes.has(parentId) || seen.has(parentId)) throw new Error(`Run ${id} has an invalid scope ancestry at ${scope.scopeId}`);
            seen.add(parentId);
            parentId = scopes.get(parentId).parentId;
        }
    }
    const resources = new Map();
    for (const resource of snapshot.resources) {
        if (resource.runId !== id || !scopes.has(resource.scopeId) || !uuid.test(resource.resourceId) || resources.has(resource.resourceId) || !states.has(resource.state) || !['owned', 'borrowed'].includes(resource.owner) || !Array.isArray(resource.dependencies) || new Set(resource.dependencies).size !== resource.dependencies.length) throw new Error(`Run ${id} has an invalid resource registration at ${resource.resourceId}`);
        for (const dependency of resource.dependencies) {
            const known = resources.get(dependency);
            if (!known || known.owner !== 'owned') throw new Error(`Run ${id} resource ${resource.resourceId} has an unregistered dependency ${dependency}`);
            let scope = scopes.get(resource.scopeId);
            while (scope && scope.scopeId !== known.scopeId) scope = scopes.get(scope.parentId);
            if (!scope) throw new Error(`Run ${id} resource ${resource.resourceId} has a dependency outside its scope ancestry`);
        }
        if (resource.owner === 'borrowed') {
            if (resource.kind !== 'directory' || typeof resource.locator?.realPath !== 'string' || !path.isAbsolute(resource.locator.path) || !path.isAbsolute(resource.locator.realPath)) throw new Error(`Run ${id} has an invalid borrowed resource ${resource.resourceId}`);
        } else if (resource.kind === 'directory') {
            if (resource.locator?.path !== path.join(snapshot.dataBoundary.path, resource.resourceId)) throw new Error(`Run ${id} directory ${resource.resourceId} is outside its registered boundary`);
        } else if (resource.kind === 'process') {
            const locator = resource.locator;
            if (!locator || !uuid.test(locator.executionId) || locator.ownerExecutionId !== snapshot.owner.executionId) throw new Error(`Run ${id} process ${resource.resourceId} has no execution ownership`);
            if (locator.controller) {
                validateAuthority(locator.controller, id);
                if (locator.controller.resourceId !== resource.resourceId || locator.controller.scopeId !== resource.scopeId || locator.controller.executionId !== locator.executionId || locator.controller.ownerExecutionId !== locator.ownerExecutionId) throw new Error(`Run ${id} process ${resource.resourceId} has a mismatched controller identity`);
                validateProcessTerminalRegistration(resource, filename);
            }
            if (locator.worker !== null) {
                const worker = locator.worker;
                if (!worker || typeof worker !== 'object' || !worker.native && !worker.exit && worker.allocation !== 'never-started') throw new Error(`Run ${id} process ${resource.resourceId} has no verified worker identity or exit`);
                if (worker.allocation === 'never-started' && (!locator.controller || Object.keys(worker).some(name => name !== 'allocation'))) throw new Error(`Run ${id} process ${resource.resourceId} has inconsistent native nonallocation evidence`);
                if (worker.native !== undefined && worker.native !== null) {
                    validateProcessIdentity(worker.native);
                    if (worker.pid !== worker.native.pid) throw new Error(`Run ${id} process ${resource.resourceId} has a mismatched worker identity`);
                }
                if (worker.exit !== undefined) validateProcessExit(worker.exit);
            }
        } else if (!terminal.has(resource.state)) {
            requireRecoveryProvider(resource.kind);
            if (resource.locator?.path !== path.join(snapshot.dataBoundary.path, resource.resourceId)) throw new Error(`Run ${id} resource ${resource.resourceId} is outside its registered directory boundary`);
        }
        resources.set(resource.resourceId, resource);
    }
    for (const borrowed of snapshot.resources.filter(record => record.owner === 'borrowed')) {
        const actual = fs.realpathSync(borrowed.locator.path);
        for (const owned of snapshot.resources.filter(record => record.owner === 'owned' && record.kind !== 'process')) {
            if ([actual, borrowed.locator.realPath].some(target => contains(target, owned.locator.path) || contains(owned.locator.path, target))) throw new Error(`Run ${id} owned directory ${owned.resourceId} overlaps borrowed resource ${borrowed.resourceId}`);
        }
    }
    return snapshot;
}

/** @returns {Promise<import('./run.js').RecoveryReport>} */
export async function recoverRuns({ projectRoot, profiles, providerOptions = {} }) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || !Array.isArray(profiles) || !profiles.length || profiles.some(profile => typeof profile !== 'string' || !profile)) throw new TypeError('Recovery requires an absolute projectRoot and explicit nonempty profiles');
    realDirectory(projectRoot);
    const report = { recovered: [], active: [], ignored: [] };
    let runs = projectRoot;
    for (const component of ['test-results', 'harness', 'runs']) {
        runs = path.join(runs, component);
        try { realDirectory(runs); }
        catch (error) { if (error.code === 'ENOENT') return report; throw error; }
    }
    const failures = [];
    for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
        if (!uuid.test(entry.name)) { report.ignored.push(entry.name); continue; }
        if (entry.isSymbolicLink()) { failures.push(new Error(`Run recovery boundary is a symbolic link: ${path.join(runs, entry.name)}`)); continue; }
        if (!entry.isDirectory()) { report.ignored.push(entry.name); continue; }
        const directory = path.join(runs, entry.name);
        let authority;
        let registry;
        let custody;
        const errors = [];
        let recovered = false;
        try {
            let snapshot = readSnapshot(projectRoot, directory, profiles);
            if (!snapshot) { report.ignored.push(entry.name); continue; }
            const executionId = snapshot.owner.executionId;
            const ownerPort = snapshot.owner.control.port;
            if (!await executionEnded(snapshot.owner)) {
                const known = await requestAuthority(snapshot.owner, 'identify');
                if (known.runId !== snapshot.runId || known.executionId !== snapshot.owner.executionId || !sameProcessIdentity(known.native, snapshot.owner.native)) throw new Error(`Run ${snapshot.runId} has a live native process without its registered execution authority`);
                report.active.push(snapshot.runId);
                continue;
            }
            if (!await executionEnded(snapshot.writer)) throw new Error(`Run ${snapshot.runId} has another active recovery writer; concurrent recovery must retain ${directory}/registry.json`);
            const writer = { runId: snapshot.runId, executionId: randomUUID(), native: await readProcessIdentity(process.pid) };
            const admitted = Registry.reopen(snapshot);
            const admittedDiagnostics = new RunDiagnostics(admitted);
            admittedDiagnostics.validateRegistration();
            admittedDiagnostics.restorePublished();
            ({ authority, custody } = await reserveWriter(admitted, writer, { onError: error => errors.push(error) }));
            snapshot = readSnapshot(projectRoot, directory, profiles);
            if (!snapshot) report.ignored.push(entry.name);
            else {
                if (snapshot.owner.executionId !== executionId || snapshot.owner.control.port !== ownerPort) throw new Error(`Run ${snapshot.runId} execution authority changed before recovery; preserve ${directory}/registry.json`);
                if (!await executionEnded(snapshot.owner) || !await executionEnded(snapshot.writer)) throw new Error(`Run ${snapshot.runId} has an active writer after recovery custody acquisition`);
                const candidate = Registry.reopen(snapshot);
                const diagnostics = new RunDiagnostics(candidate);
                diagnostics.validateRegistration();
                diagnostics.restorePublished();
                candidate.claimWriter(authority, custody);
                registry = candidate;
                registry.errors = errors;
                registry.recovery = { state: 'recovering', executionId: authority.identity.executionId };
                await registry.save();
                await diagnostics.recoverPending();
                await diagnostics.recoverProducers();
                const retentionOnly = snapshot.status !== 'running' && snapshot.resources.every(record => terminal.has(record.state)) && snapshot.diagnostics?.stage === 'published';
                for (const record of [...registry.resources].reverse()) {
                    if (terminal.has(record.state)) continue;
                    try {
                        if (record.owner === 'borrowed') record.state = 'released';
                        else {
                            const blocked = registry.resources.find(dependent => dependent.dependencies.includes(record.resourceId) && dependent.state === 'cleanup-failed');
                            if (blocked) throw new Error(`Resource ${record.resourceId} is retained because dependent resource ${blocked.resourceId} could not be recovered`);
                            if (record.kind === 'process') await recoverOwnedProcess(record, registry);
                            else if (registry.hasAllocation(record)) {
                                if (record.kind !== 'directory') await requireRecoveryProvider(record.kind).recover(record, providerOptions);
                                try { await diagnostics.stageEnvironment(record); }
                                catch (error) { errors.push(error); registry.environmentExport.state = 'failed'; }
                                registry.removeDirectory(record);
                            }
                            record.state = 'disposed';
                        }
                    } catch (cause) {
                        record.state = 'cleanup-failed';
                        const error = new Error(`Cannot recover run ${registry.runId} resource ${record.resourceId} (${record.kind}): ${cause.message}`, { cause });
                        error.resource = structuredClone(record);
                        errors.push(error);
                        registry.status = 'failed';
                    }
                    await registry.save();
                }
                if (registry.environmentExport?.state === 'requested' || registry.environmentExport?.cleanup?.state === 'removing') {
                    try { await diagnostics.exportEnvironment(registry.environmentExport.destination); }
                    catch (error) { errors.push(error); if (!registry.environmentExport.archive) registry.environmentExport.state = 'failed'; }
                    await registry.save();
                }
                try {
                    if (registry.diagnostics?.stage !== 'discarded') {
                        const superseded = await diagnostics.retire();
                        if (!retentionOnly && !superseded && !errors.length) { await diagnostics.captureLogs(); await diagnostics.publish({ status: 'cancelled' }); }
                    }
                } catch (error) { errors.push(error); registry.status = 'failed'; }
                recovered = true;
            }
        } catch (cause) {
            errors.push(cause);
        } finally {
            if (authority) {
                try { await authority.close(); }
                catch (error) { errors.push(new Error(`Cannot release recovery writer for ${directory}: ${error.message}`, { cause: error })); }
            }
        }
        try {
            if (registry) {
                if (recovered) for (const scope of registry.scopes) scope.state = 'disposed';
                registry.recovery.state = errors.length ? 'failed' : 'recovered';
                if (errors.length) registry.status = 'failed';
                else if (registry.status === 'running') registry.status = 'cancelled';
                try { await registry.save(); }
                catch (error) { errors.push(error); registry.status = 'failed'; registry.recovery.state = 'failed'; }
            }
        } finally {
            if (custody) {
                try { custody.conclude(); }
                catch (error) { errors.push(error); }
            }
        }
        if (errors.length) {
            const message = `Cannot recover registered run at ${directory}: ${errors.map(error => error.message).join('; ')}`;
            failures.push(registry ? registry.failure(message) : failureGroup(errors, message));
        } else if (registry) report.recovered.push(registry.runId);
    }
    if (failures.length) {
        const error = failureGroup(failures, `Resource recovery failed: ${failures.map(error => error.message).join('; ')}`);
        error.report = report;
        throw error;
    }
    return report;
}
