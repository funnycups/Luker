import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Registry, contains } from './registry.js';
import { failureGroup, validateFailureGraph } from './errors.js';
import { reserveWriter, executionEnded, verifyCustodyBoundary } from './writer-custody.js';
import { readProcessIdentity, validateProcessIdentity } from './native-identity.js';
import { removalReceipt, verifyRemoval, removeOwnedTree, verifyOwnedTree } from './owned-tree.js';

/** @typedef {import('./run.js').ArtifactRef} ArtifactRef */
/** @typedef {import('./run.js').DiagnosticIndex} DiagnosticIndex */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identity = filename => {
    const stat = fs.lstatSync(filename);
    if (!stat.isDirectory() || fs.realpathSync(filename) !== filename) throw new Error(`Diagnostic boundary is not a real directory: ${filename}`);
    return { path: filename, dev: stat.dev, ino: stat.ino };
};
function verify(expected) {
    const actual = identity(expected.path);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`Diagnostic directory ownership changed: ${expected.path}`);
}
function admit(directory) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return identity(directory);
}
function sameFile(filename, expected) {
    const actual = fs.lstatSync(filename);
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`Diagnostic file ownership changed: ${filename}`);
}
function readFile(filename, expected) {
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const errors = [];
    let bytes;
    try {
        const actual = fs.fstatSync(descriptor);
        if (!actual.isFile() || expected && (actual.dev !== expected.dev || actual.ino !== expected.ino)) throw new Error(`Diagnostic content is not its registered regular file: ${filename}`);
        bytes = fs.readFileSync(descriptor);
        if (bytes.length !== actual.size) throw new Error(`Diagnostic content changed while reading: ${filename}`);
    } catch (error) { errors.push(error); }
    try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
    if (errors.length) throw failureGroup(errors, `Cannot read diagnostic content: ${filename}`);
    return bytes;
}
function layout(projectRoot, runId, profile) {
    const root = path.join(projectRoot, 'test-results/harness/diagnostics');
    return { root, stagingRoot: path.join(root, 'staging'), bundles: path.join(root, 'bundles'), slots: path.join(root, 'slots'), staging: path.join(root, 'staging', runId), bundle: path.join(root, 'bundles', runId), slot: path.join(root, 'slots', hash(Buffer.from(profile, 'utf16le')) + '.json') };
}
function validArtifact(ref) {
    return ref && typeof ref === 'object' && typeof ref.scopeId === 'string' && uuid.test(ref.scopeId) && typeof ref.name === 'string' && ref.name.length > 0 && path.basename(ref.name) === ref.name && !['.', '..'].includes(ref.name)
        && !/[\0\\/]/.test(ref.name) && typeof ref.sha256 === 'string' && digest.test(ref.sha256) && Number.isSafeInteger(ref.length) && ref.length >= 0
        && typeof ref.contentType === 'string' && ref.contentType.length > 0 && ref.readStatus === 'complete' && Number.isSafeInteger(ref.dev) && Number.isSafeInteger(ref.ino);
}
function content(directory, ref) {
    if (!validArtifact(ref)) throw new TypeError(`Diagnostic artifact ${ref?.name} has invalid integrity or reading metadata`);
    const bytes = readFile(path.join(directory, 'objects', ref.sha256), ref);
    if (bytes.length !== ref.length || hash(bytes) !== ref.sha256) throw new Error(`Diagnostic artifact ${ref.name} failed length/SHA256 verification in ${directory}: expected ${ref.length} bytes ${ref.sha256}, received ${bytes.length} bytes ${hash(bytes)}`);
    return bytes;
}

function storeContent(directory, bytes) {
    const filename = path.join(directory, 'objects', hash(bytes));
    let stat;
    try { stat = fs.lstatSync(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
        if (!readFile(filename).equals(bytes)) throw new Error(`Existing diagnostic content differs from its digest: ${filename}`);
    } else {
        const descriptor = fs.openSync(filename, 'wx', 0o600);
        const errors = [];
        try { stat = fs.fstatSync(descriptor); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
        catch (error) { errors.push(error); }
        try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
        if (errors.length) throw failureGroup(errors, `Cannot capture diagnostic content: ${filename}`);
    }
    return { sha256: hash(bytes), length: bytes.length, dev: stat.dev, ino: stat.ino };
}

/** Loaded indexes grant no arbitrary pathname authority. */
function validateIndex(index) {
    if (!index || index.format !== 'diagnostic-index-v1' || typeof index.projectRoot !== 'string' || !path.isAbsolute(index.projectRoot) || typeof index.runId !== 'string' || !uuid.test(index.runId) || typeof index.version !== 'string' || !uuid.test(index.version) || typeof index.profile !== 'string' || !index.profile || !['failed', 'cancelled'].includes(index.outcome) || !Array.isArray(index.artifacts) || !index.artifacts.every(validArtifact) || !Array.isArray(index.errors)) throw new TypeError('Diagnostic index has invalid run/profile/content metadata');
    const locations = layout(index.projectRoot, index.runId, index.profile);
    if (index.storage?.bundle?.path !== locations.bundle || index.slotPath !== locations.slot) throw new Error(`Diagnostic index for run ${index.runId} is outside its registered bundle`);
    identity(index.projectRoot);
    let runDirectory = index.projectRoot;
    for (const component of ['test-results', 'harness', 'runs', index.runId]) { runDirectory = path.join(runDirectory, component); identity(runDirectory); }
    const registryFile = path.join(index.projectRoot, 'test-results/harness/runs', index.runId, 'registry.json');
    const registered = JSON.parse(readFile(registryFile));
    if (registered.runId !== index.runId || registered.profile !== index.profile || registered.projectRoot !== index.projectRoot || !isDeepStrictEqual(registered.diagnostics?.bundle, index.storage.bundle)) throw new Error(`Diagnostic index has no matching run ownership: ${registryFile}`);
    if (registered.diagnostics.format !== 'run-diagnostics-v2') throw new Error(`Run ${index.runId} diagnostic retirement format ${registered.diagnostics.format} cannot establish single retirement authority; retain ${registryFile}`);
    const expected = [locations.root, locations.stagingRoot, locations.bundles, locations.slots];
    if (!Array.isArray(registered.diagnostics.boundaries) || registered.diagnostics.boundaries.length !== expected.length) throw new Error(`Run ${index.runId} has incomplete diagnostic boundaries`);
    for (const [position, boundary] of registered.diagnostics.boundaries.entries()) {
        if (boundary.path !== expected[position]) throw new Error(`Run ${index.runId} has an unregistered diagnostic boundary: ${boundary.path}`);
        verify(boundary);
    }
    verify(index.storage.bundle);
    if (registered.diagnostics.objects?.path !== path.join(locations.bundle, 'objects')) throw new Error(`Run ${index.runId} has an unregistered content directory`);
    verify(registered.diagnostics.objects);
    const receipt = registered.diagnostics.indexes.find(receipt => receipt.version === index.version);
    if (!receipt) throw new Error(`Run ${index.runId} has no registered diagnostic index version ${index.version}`);
    const bytes = readFile(path.join(locations.bundle, `index-${index.version}.json`), receipt);
    if (bytes.length !== receipt.length || hash(bytes) !== receipt.sha256) throw new Error(`Run ${index.runId} diagnostic index ${index.version} failed length/SHA256 verification`);
    const actual = JSON.parse(bytes);
    if (!isDeepStrictEqual(actual, index)) throw new Error(`Diagnostic index differs from the complete registered bundle: ${index.runId}`);
    for (const graph of index.errors) validateFailureGraph(graph);
    return { locations, registered };
}

/** @returns {Promise<Buffer>} */
export async function readDiagnostic(index, ref) {
    validateIndex(index);
    if (!index.artifacts.some(known => isDeepStrictEqual(known, ref))) throw new Error(`Diagnostic artifact is not present in run ${index.runId}: ${ref?.name}`);
    return content(index.storage.bundle.path, ref);
}

/** @returns {Promise<ArtifactRef>} */
export function captureDiagnostic(scope, descriptor) {
    return scope.captureDiagnostic(descriptor);
}

/** Publish only through the run's final outcome and idempotent completion. */
export async function publishFailure(run, outcome) {
    if (!outcome || !['failed', 'cancelled'].includes(outcome.status)) throw new TypeError('Failure publication requires a failed or cancelled outcome');
    const summary = await run.finish(outcome);
    if (summary.diagnosticIndex === null || run.registry.diagnostics.publication?.stage !== 'complete') throw failureGroup(summary.errors, `Run ${run.runId} has no complete diagnostic publication`);
    return summary.diagnosticIndex;
}

function destinationParent(destination, projectRoot, resources) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.resolve(destination) !== destination) throw new TypeError('Diagnostic export requires an explicit absolute new destination');
    const parent = identity(path.dirname(destination));
    const automatic = path.join(projectRoot, 'test-results/harness');
    if (contains(automatic, destination) || contains(destination, automatic)) throw new Error(`Export destination overlaps automatic cleanup metadata: ${destination}`);
    for (const record of resources) {
        const directory = record.owner === 'borrowed' ? record.locator.realPath : record.kind === 'directory' ? record.locator.path : null;
        if (directory && (contains(directory, destination) || contains(destination, directory))) throw new Error(`Export destination overlaps resource ${record.resourceId}: ${destination}`);
    }
    return parent;
}
function destinationBoundary(destination, projectRoot, resources) {
    const parent = destinationParent(destination, projectRoot, resources);
    try { fs.lstatSync(destination); }
    catch (error) { if (error.code === 'ENOENT') return parent; throw error; }
    throw new Error(`Export destination already exists; refusing overwrite: ${destination}`);
}
function fillArchive(destination, parent, root, files, directories = []) {
    verify(parent);
    for (const relative of directories) {
        verify(parent); verify(root);
        let directory = destination;
        for (const component of relative.split('/')) { directory = path.join(directory, component); admit(directory); }
    }
    for (const [name, bytes] of files) {
        verify(parent); verify(root);
        const filename = path.join(destination, name);
        const parts = name.split('/');
        let directory = destination;
        for (const part of parts.slice(0, -1)) { directory = path.join(directory, part); admit(directory); }
        let existing;
        try { existing = fs.lstatSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing) {
            if (!readFile(filename, existing).equals(bytes)) throw new Error(`Registered archive contains different bytes: ${filename}`);
            continue;
        }
        const descriptor = fs.openSync(filename, 'wx', 0o600);
        const errors = [];
        try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
        catch (error) { errors.push(error); }
        try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
        if (errors.length) throw failureGroup(errors, `Cannot export diagnostic file: ${filename}`);
        if (!readFile(filename).equals(bytes)) throw new Error(`Exported bytes differ from diagnostic content: ${filename}`);
    }
}
function createArchive(destination, parent, files, directories = []) {
    verify(parent);
    fs.mkdirSync(destination, { mode: 0o700 });
    fillArchive(destination, parent, identity(destination), files, directories);
}

/** @returns {Promise<void>} */
export async function exportDiagnostic(index, destination) {
    const { registered } = validateIndex(index);
    const parent = destinationBoundary(destination, index.projectRoot, registered.resources);
    const files = new Map(index.artifacts.map(ref => ['objects/' + ref.sha256, content(index.storage.bundle.path, ref)]));
    files.set('index.json', json({ ...index, storage: { format: 'diagnostic-archive-v1' } }));
    createArchive(destination, parent, files);
}

async function syncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    const errors = [];
    try { await new Promise((resolve, reject) => fs.fsync(descriptor, error => error ? reject(error) : resolve())); }
    catch (error) { errors.push(error); }
    try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
    if (errors.length) throw failureGroup(errors, `Cannot make diagnostic publication durable: ${directory}`);
}

/** One registered run owns its staging and immutable content, never another run's runtime data. */
export class RunDiagnostics {
    #registry;
    #ensuring;
    #operations = Promise.resolve();
    constructor(registry) { this.#registry = registry; }

    #verifyBoundaries() {
        const registry = this.#registry;
        registry.verifyBoundaries();
        const stored = registry.diagnostics;
        const locations = layout(registry.projectRoot, registry.runId, registry.profile);
        const expected = [locations.root, locations.stagingRoot, locations.bundles, locations.slots];
        if (!stored || stored.format !== 'run-diagnostics-v2' || !Array.isArray(stored.boundaries) || stored.boundaries.length !== expected.length || !Array.isArray(stored.artifacts) || !Object.hasOwn(stored, 'previous') || typeof stored.retentionPending !== 'boolean' || !Array.isArray(stored.pending) || !Array.isArray(stored.indexes)) throw new Error(`Run ${registry.runId} has incomplete diagnostic retirement/ownership metadata`);
        for (const [position, boundary] of stored.boundaries.entries()) {
            if (boundary.path !== expected[position]) throw new Error(`Run ${registry.runId} has an unregistered diagnostic boundary: ${boundary.path}`);
            verify(boundary);
        }
        return locations;
    }

    #verify() {
        const registry = this.#registry;
        const stored = registry.diagnostics;
        const locations = this.#verifyBoundaries();
        if (stored.staging?.path !== locations.staging || stored.bundle && stored.bundle.path !== locations.bundle) throw new Error(`Run ${registry.runId} diagnostic leaf is outside its registered path`);
        if (!stored.bundle) {
            let staged;
            try { staged = identity(stored.staging.path); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!staged) {
                const moved = identity(locations.bundle);
                if (moved.dev !== stored.staging.dev || moved.ino !== stored.staging.ino) throw new Error(`Run ${registry.runId} diagnostic publication did not preserve its registered inode`);
                stored.bundle = moved;
                stored.objects.path = path.join(moved.path, 'objects');
            }
        }
        verify(stored.bundle ?? stored.staging);
        if (stored.objects?.path !== path.join(stored.bundle?.path ?? stored.staging.path, 'objects')) throw new Error(`Run ${registry.runId} diagnostic content directory is unregistered`);
        verify(stored.objects);
        return stored.bundle?.path ?? stored.staging.path;
    }

    validateRegistration() {
        if (this.#registry.environmentExport?.archive) this.#verifyArchive();
        if (!this.#registry.diagnostics) return;
        if (this.#registry.diagnostics.discard) { verifyRemoval(this.#registry.diagnostics.discard, this.#discardInventory()); return; }
        if (this.#registry.diagnostics.retirement) { this.#verifyRetirement(); return; }
        const directory = this.#verify();
        const stored = this.#registry.diagnostics;
        const scopes = new Set(this.#registry.scopes.map(scope => scope.scopeId));
        for (const ref of stored.artifacts) if (!scopes.has(ref.scopeId) || !(validArtifact(ref) || ['pending', 'failed'].includes(ref.readStatus) && typeof ref.name === 'string' && typeof ref.contentType === 'string' && ref.sha256 === null && ref.length === null)) throw new Error(`Run ${this.#registry.runId} has invalid captured artifact metadata: ${ref?.name}`);
        for (const receipt of stored.indexes) this.#indexBytes(directory, receipt);
        for (const pending of stored.pending) {
            this.#temporaryPrefix(pending.path);
            if (Object.hasOwn(pending, 'removing') && (pending.removing !== true || !Number.isSafeInteger(pending.dev) || !Number.isSafeInteger(pending.ino))) throw new Error(`Run ${this.#registry.runId} has invalid pending removal authority: ${pending.path}`);
        }
    }

    #indexPath(directory, receipt) {
        if (!receipt || typeof receipt.version !== 'string' || !uuid.test(receipt.version) || typeof receipt.sha256 !== 'string' || !digest.test(receipt.sha256) || !Number.isSafeInteger(receipt.length) || receipt.length < 0 || !Number.isSafeInteger(receipt.dev) || !Number.isSafeInteger(receipt.ino)) throw new Error(`Run ${this.#registry.runId} has invalid diagnostic index integrity metadata`);
        if (Object.hasOwn(receipt, 'removing') && (receipt.removing !== true || !this.#registry.diagnosticIndex || receipt.version === this.#registry.diagnosticIndex.version)) throw new Error(`Run ${this.#registry.runId} has invalid superseded index removal authority: ${receipt.version}`);
        return path.join(directory, `index-${receipt.version}.json`);
    }

    #indexBytes(directory, receipt) {
        const filename = this.#indexPath(directory, receipt);
        let bytes;
        try { bytes = readFile(filename, receipt); }
        catch (error) { if (error.code === 'ENOENT' && receipt.removing === true) return null; throw error; }
        if (bytes.length !== receipt.length || hash(bytes) !== receipt.sha256) throw new Error(`Run ${this.#registry.runId} diagnostic index failed length/SHA256 verification: ${receipt.version}`);
        return bytes;
    }

    async #removeIndexes(receipts) {
        if (!receipts.length) return;
        const registry = this.#registry;
        const directory = this.#verify();
        for (const receipt of receipts) {
            if (!registry.diagnostics.indexes.includes(receipt) || !registry.diagnosticIndex || receipt.version === registry.diagnosticIndex.version) throw new Error(`Run ${registry.runId} has invalid superseded index removal authority: ${receipt.version}`);
            this.#indexBytes(directory, receipt);
        }
        for (const receipt of receipts) receipt.removing = true;
        await registry.save();
        for (const receipt of receipts) {
            const directory = this.#verify();
            if (this.#indexBytes(directory, receipt) !== null) fs.unlinkSync(this.#indexPath(directory, receipt));
        }
        await syncDirectory(directory);
        for (const receipt of receipts) registry.diagnostics.indexes.splice(registry.diagnostics.indexes.indexOf(receipt), 1);
        await registry.save();
    }

    #slotBytes(locations, required = ['published', 'retired'].includes(this.#registry.diagnostics.stage) || this.#registry.diagnostics.publication?.published === true || ['removing', 'complete'].includes(this.#registry.diagnostics.retirement?.state)) {
        const registry = this.#registry;
        const committed = registry.diagnosticIndex;
        if (committed !== null && !registry.diagnostics.retirement) {
            if (committed?.runId !== registry.runId || committed.projectRoot !== registry.projectRoot || committed.profile !== registry.profile || committed.source !== registry.source) throw new Error(`Run ${registry.runId} profile ${JSON.stringify(registry.profile)} has inconsistent committed diagnostic ownership: ${locations.slot}`);
            validateIndex(committed);
            required = true;
        }
        try { return readFile(locations.slot); }
        catch (cause) {
            if (cause.code === 'ENOENT' && !required) return null;
            throw new Error(`Run ${this.#registry.runId} profile ${JSON.stringify(this.#registry.profile)} cannot read required diagnostic slot ${locations.slot}: ${cause.message}`, { cause });
        }
    }

    restorePublished() {
        if (!this.#registry.diagnostics?.bundle || this.#registry.diagnostics.retirement) return;
        const registry = this.#registry;
        const directory = this.#verify();
        const locations = layout(registry.projectRoot, registry.runId, registry.profile);
        const slotBytes = this.#slotBytes(locations);
        if (slotBytes === null) return;
        const index = JSON.parse(slotBytes);
        if (index.runId !== registry.runId) return;
        if (index.format !== 'diagnostic-index-v1' || index.projectRoot !== registry.projectRoot || index.profile !== registry.profile || index.source !== registry.source || index.slotPath !== locations.slot || !['failed', 'cancelled'].includes(index.outcome) || typeof index.version !== 'string' || !uuid.test(index.version) || !isDeepStrictEqual(index.storage?.bundle, registry.diagnostics.bundle) || !Array.isArray(index.artifacts) || !index.artifacts.every(validArtifact) || !Array.isArray(index.errors)) throw new Error(`Run ${registry.runId} published diagnostic index has inconsistent run/content ownership`);
        const filename = path.join(directory, `index-${index.version}.json`);
        const bytes = readFile(filename);
        if (!bytes.equals(slotBytes)) throw new Error(`Run ${registry.runId} published slot differs from its immutable diagnostic index ${index.version}`);
        for (const graph of index.errors) validateFailureGraph(graph);
        for (const ref of index.artifacts) {
            if (!registry.scopes.some(scope => scope.scopeId === ref.scopeId)) throw new Error(`Run ${registry.runId} diagnostic artifact has no registered scope: ${ref.scopeId}`);
            content(directory, ref);
            if (!registry.diagnostics.artifacts.some(known => known.scopeId === ref.scopeId && known.name === ref.name)) registry.diagnostics.artifacts.push(ref);
        }
        if (!registry.diagnostics.indexes.some(receipt => receipt.version === index.version)) {
            const stat = fs.lstatSync(filename);
            registry.diagnostics.indexes.push({ version: index.version, dev: stat.dev, ino: stat.ino, length: bytes.length, sha256: hash(bytes) });
        }
        registry.diagnosticIndex = index;
        registry.diagnostics.stage = 'published';
        registry.diagnostics.publication = { stage: 'durability', published: true, slotPath: locations.slot };
    }

    ensure() {
        if (this.#ensuring) return this.#ensuring;
        this.#ensuring = (async () => {
            const registry = this.#registry;
            if (registry.diagnostics) { this.#verify(); return; }
            registry.verifyBoundaries();
            const locations = layout(registry.projectRoot, registry.runId, registry.profile);
            registry.diagnostics = { format: 'run-diagnostics-v2', stage: 'allocating', boundaries: [], staging: { path: locations.staging, dev: null, ino: null }, bundle: null, artifacts: [], previous: null, retirement: null, retentionPending: true, pending: [], indexes: [], publication: null };
            await registry.save();
            for (const directory of [locations.root, locations.stagingRoot, locations.bundles, locations.slots]) {
                registry.verifyBoundaries();
                for (const boundary of registry.diagnostics.boundaries) verify(boundary);
                registry.diagnostics.boundaries.push(admit(directory));
            }
            registry.verifyBoundaries();
            fs.mkdirSync(locations.staging, { mode: 0o700 });
            registry.diagnostics.staging = identity(locations.staging);
            fs.mkdirSync(path.join(locations.staging, 'objects'), { mode: 0o700 });
            registry.diagnostics.objects = identity(path.join(locations.staging, 'objects'));
            registry.diagnostics.stage = 'staging';
            if (registry.environmentExport) {
                registry.verifyBoundaries();
                const directory = path.join(path.dirname(registry.file), 'environment');
                fs.mkdirSync(directory, { mode: 0o700 });
                registry.environmentExport.storage = identity(directory);
                fs.mkdirSync(path.join(directory, 'objects'), { mode: 0o700 });
                registry.environmentExport.objects = identity(path.join(directory, 'objects'));
                registry.environmentExport.resources = [];
            }
            await registry.save();
        })();
        return this.#ensuring;
    }

    capture(scopeId, descriptor) {
        if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name || path.basename(descriptor.name) !== descriptor.name || ['.', '..'].includes(descriptor.name) || /[\0\\/]/.test(descriptor.name) || typeof descriptor.contentType !== 'string' || !descriptor.contentType || /[\r\n\0]/.test(descriptor.contentType) || !(descriptor.bytes instanceof Uint8Array)) return Promise.reject(new TypeError('Diagnostic capture requires a plain filename, content type and complete byte array'));
        const bytes = Buffer.from(descriptor.bytes);
        const { name, contentType } = descriptor;
        const operation = (async () => {
            await this.#operations;
            await this.ensure();
            const directory = this.#verify();
            const stored = this.#registry.diagnostics;
            verify(stored.objects);
            const prior = stored.artifacts.find(ref => ref.scopeId === scopeId && ref.name === name);
            if (prior?.readStatus === 'complete') throw new Error(`Diagnostic artifact is already captured in scope ${scopeId}: ${name}`);
            const ref = prior ?? { name, scopeId };
            Object.assign(ref, { sha256: null, length: null, contentType, readStatus: 'pending', dev: null, ino: null });
            if (!prior) stored.artifacts.push(ref);
            try {
                await this.#registry.save();
                this.#verify();
                Object.assign(ref, storeContent(directory, bytes), { readStatus: 'complete' });
                content(directory, ref);
                await this.#registry.save();
                content(this.#verify(), ref);
                return Object.freeze({ ...ref });
            } catch (error) {
                Object.assign(ref, { sha256: null, length: null, readStatus: 'failed', dev: null, ino: null });
                this.#registry.reportError(error);
                try { await this.#registry.save(); }
                catch (publication) { throw failureGroup([error, publication], `Cannot retain diagnostic capture failure ${name} for run ${this.#registry.runId}`); }
                throw error;
            }
        })();
        this.#operations = Promise.allSettled([operation]);
        return operation;
    }

    async captureFailed(scopeId, descriptor, error) {
        await this.ensure();
        if (!this.#registry.diagnostics.artifacts.some(ref => ref.scopeId === scopeId && ref.name === descriptor.name)) this.#registry.diagnostics.artifacts.push({ scopeId, name: descriptor.name, contentType: descriptor.contentType, sha256: null, length: null, readStatus: 'failed' });
        this.#registry.reportError(error);
        await this.#registry.save();
    }

    async captureLogs() {
        for (const record of this.#registry.resources.filter(record => record.kind === 'process' && record.startupLog && record.startupLog.ino !== null)) {
            const expected = path.join(path.dirname(this.#registry.file), record.resourceId + '-startup.log');
            if (record.startupLog.path !== expected) throw new Error(`Run ${this.#registry.runId} process ${record.resourceId} startup log is outside its registered path`);
            const name = record.resourceId + '-startup.log';
            if (this.#registry.diagnostics?.artifacts.some(ref => ref.name === name && ref.scopeId === record.scopeId && ref.readStatus === 'complete')) continue;
            const bytes = readFile(expected, record.startupLog);
            await this.capture(record.scopeId, { name, contentType: 'text/plain; charset=utf-8', bytes });
        }
    }

    async #lock(locations) {
        const filename = locations.slot.slice(0, -5) + '.lock';
        for (;;) {
            this.#verifyBoundaries();
            let descriptor;
            try { descriptor = fs.openSync(filename, 'wx', 0o600); }
            catch (error) { if (error.code !== 'EEXIST') throw error; }
            if (descriptor !== undefined) {
                let actual;
                try { actual = fs.fstatSync(descriptor); fs.writeFileSync(descriptor, json({ runId: this.#registry.runId, profile: this.#registry.profile, owner: this.#registry.writer })); fs.fsyncSync(descriptor); fs.closeSync(descriptor); }
                catch (error) {
                    const errors = [error];
                    try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
                    if (actual) { try { sameFile(filename, actual); fs.unlinkSync(filename); } catch (error) { errors.push(error); } }
                    throw failureGroup(errors, `Cannot establish diagnostic publication custody: ${filename}`);
                }
                return () => { sameFile(filename, actual); fs.unlinkSync(filename); };
            }
            let previous;
            let bytes;
            try { previous = fs.lstatSync(filename); bytes = readFile(filename, previous); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            const holder = JSON.parse(bytes);
            if (!uuid.test(holder.runId) || holder.profile !== this.#registry.profile || holder.owner?.runId !== holder.runId) throw new Error(`Unknown diagnostic publication holder: ${filename}`);
            if (!uuid.test(holder.owner.executionId)) throw new Error(`Unknown diagnostic publication execution: ${filename}`);
            if (!await executionEnded(holder.owner)) continue;
            this.#verifyBoundaries(); sameFile(filename, previous);
            if (!readFile(filename, previous).equals(bytes)) throw new Error(`Diagnostic publication custody changed: ${filename}`);
            fs.unlinkSync(filename);
        }
    }

    async #atomic(filename, bytes, renamed) {
        const temporary = filename + '-' + randomUUID() + '.tmp';
        const pending = { path: temporary, dev: null, ino: null };
        this.#registry.diagnostics.retentionPending = true;
        this.#registry.diagnostics.pending.push(pending);
        await this.#registry.save();
        const errors = [];
        let descriptor;
        let stat;
        try {
            this.#verify();
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            stat = fs.fstatSync(descriptor);
            pending.dev = stat.dev; pending.ino = stat.ino;
            await this.#registry.save();
            this.#verify(); sameFile(temporary, stat);
            fs.writeFileSync(descriptor, bytes);
            await new Promise((resolve, reject) => fs.fsync(descriptor, error => error ? reject(error) : resolve()));
        }
        catch (error) { errors.push(error); }
        if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (error) { errors.push(error); } }
        if (!errors.length) {
            try {
                this.#verify(); sameFile(temporary, stat);
                fs.renameSync(temporary, filename); renamed();
                await syncDirectory(path.dirname(filename));
            } catch (error) { errors.push(error); }
        }
        if (errors.length) throw failureGroup(errors, `Cannot publish diagnostic bytes: ${filename}`);
        this.#verify(); sameFile(filename, pending);
        return pending;
    }

    async #syncBundleMove() {
        const locations = this.#verifyBoundaries();
        for (const directory of [locations.bundles, locations.stagingRoot]) {
            this.#verify();
            await syncDirectory(directory);
        }
    }

    async recoverPending() {
        if (!this.#registry.diagnostics) return;
        if (this.#registry.diagnostics.discard) { await this.discard(); return; }
        if (this.#registry.diagnostics.retirement) { this.#verifyRetirement(); return; }
        this.#verify();
        const stored = this.#registry.diagnostics;
        if (stored.bundle && stored.stage === 'staging') await this.#syncBundleMove();
        if (!Array.isArray(stored.pending)) throw new Error(`Run ${this.#registry.runId} has no registered diagnostic pending-file inventory`);
        const changed = stored.pending.length > 0;
        for (const pending of [...stored.pending]) {
            const base = this.#temporaryPrefix(pending.path);
            const suffix = pending.path.slice(base.length);
            if (!pending.path.startsWith(base) || !suffix.endsWith('.tmp') || !uuid.test(suffix.slice(0, -4))) throw new Error(`Run ${this.#registry.runId} has an unregistered diagnostic temporary path: ${pending.path}`);
            const directory = this.#verify();
            let filename = pending.path;
            let actual;
            try { actual = fs.lstatSync(filename); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!actual && pending.ino !== null && path.dirname(filename) === directory) {
                filename = base.slice(0, -1);
                try { actual = fs.lstatSync(filename); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            if (actual) {
                sameFile(filename, pending);
                const registered = stored.indexes.find(receipt => this.#indexPath(directory, receipt) === filename);
                if (registered) this.#indexBytes(directory, registered);
                else {
                    if (this.#registry.diagnosticIndex && filename === path.join(directory, `index-${this.#registry.diagnosticIndex.version}.json`)) throw new Error(`Run ${this.#registry.runId} pending work cannot remove its committed diagnostic index: ${filename}`);
                    pending.removing = true;
                    await this.#registry.save();
                    this.#verify(); sameFile(filename, pending);
                    fs.unlinkSync(filename);
                }
            } else if (pending.ino !== null && !stored.bundle && pending.removing !== true) throw new Error(`Run ${this.#registry.runId} registered diagnostic temporary is missing before publication: ${pending.path}`);
            await syncDirectory(path.dirname(filename));
            stored.pending.splice(stored.pending.indexOf(pending), 1);
        }
        if (changed) await this.#registry.save();
    }

    /** Retain interruption receipts for callbacks whose native owner has ended. */
    async recoverProducers() {
        const registry = this.#registry;
        for (const scope of registry.scopes) for (const finalizer of scope.finalizers ?? []) {
            if (finalizer.state === 'completed') continue;
            finalizer.interruption ??= { previousState: finalizer.state, executionId: registry.owner.executionId };
            finalizer.state = 'interrupted';
            await registry.save();
            const name = `interrupted-${finalizer.id}.json`;
            const bytes = json({ format: 'interrupted-finalizer-v1', runId: registry.runId, scopeId: scope.scopeId, finalizerId: finalizer.id, label: finalizer.label, stage: finalizer.stage, ...finalizer.interruption });
            const prior = registry.diagnostics?.artifacts.find(ref => ref.scopeId === scope.scopeId && ref.name === name);
            if (prior?.readStatus === 'complete') {
                if (!content(this.#verify(), prior).equals(bytes)) throw new Error(`Run ${registry.runId} interruption receipt changed for finalizer ${finalizer.id}`);
            } else await this.capture(scope.scopeId, { name, contentType: 'application/json', bytes });
        }
    }

    #temporaryPrefix(filename) {
        if (typeof filename !== 'string') throw new Error(`Run ${this.#registry.runId} has an invalid diagnostic temporary path`);
        const directory = this.#verify();
        const locations = layout(this.#registry.projectRoot, this.#registry.runId, this.#registry.profile);
        const name = path.basename(filename);
        const version = name.slice(6, 42);
        const base = path.dirname(filename) === directory && name.startsWith('index-') && uuid.test(version) ? path.join(directory, `index-${version}.json-`) : locations.slot + '-';
        const suffix = filename.slice(base.length);
        if (!filename.startsWith(base) || !suffix.endsWith('.tmp') || !uuid.test(suffix.slice(0, -4))) throw new Error(`Run ${this.#registry.runId} has an unregistered diagnostic temporary path: ${filename}`);
        return base;
    }

    async publish(outcome) {
        const registry = this.#registry;
        let stage = 'prepare';
        let published = false;
        const errors = [];
        let unlock;
        let result;
        const locations = layout(registry.projectRoot, registry.runId, registry.profile);
        try {
            await this.#operations;
            await this.ensure();
            const directory = this.#verify();
            const incomplete = registry.scopes.flatMap(scope => (scope.finalizers ?? []).filter(finalizer => finalizer.state !== 'completed' && !(outcome.status === 'cancelled' && registry.recovery?.state === 'recovering' && finalizer.state === 'interrupted')).map(finalizer => `${scope.scopeId}/${finalizer.label}: ${finalizer.state}`));
            if (incomplete.length) throw new Error(`Run ${registry.runId} diagnostic producers did not complete: ${incomplete.join('; ')}`);
            for (const ref of registry.diagnostics.artifacts) content(directory, ref);
            await syncDirectory(registry.diagnostics.objects.path);
            const index = { format: 'diagnostic-index-v1', version: randomUUID(), projectRoot: registry.projectRoot, runId: registry.runId, profile: registry.profile, source: registry.source, command: path.basename(registry.command[0]), runtime: { version: process.version, platform: process.platform, arch: process.arch }, outcome: outcome.status, errors: registry.snapshot().errors, resources: registry.diagnosticGraph(structuredClone(registry.resources)), artifacts: structuredClone(registry.diagnostics.artifacts), storage: { bundle: { ...registry.diagnostics.staging, path: locations.bundle } }, slotPath: locations.slot };
            const indexBytes = json(index);
            // The committed record must be the exact material the bundle can
            // reproduce. Error and graph sources may carry non-JSON runtime
            // values, so keep the parsed bytes rather than the source object.
            const record = JSON.parse(indexBytes);
            const indexFile = path.join(directory, `index-${record.version}.json`);
            const indexPending = await this.#atomic(indexFile, indexBytes, () => {});
            this.#verify();
            sameFile(indexFile, indexPending);
            registry.diagnostics.indexes.push({ version: record.version, dev: indexPending.dev, ino: indexPending.ino, length: indexBytes.length, sha256: hash(indexBytes) });
            registry.diagnostics.pending.splice(registry.diagnostics.pending.indexOf(indexPending), 1);
            if (!registry.diagnostics.bundle) {
                await registry.save();
                this.#verify();
                fs.renameSync(locations.staging, locations.bundle);
                registry.diagnostics.bundle = identity(locations.bundle);
                registry.diagnostics.objects.path = path.join(locations.bundle, 'objects');
            }
            if (registry.diagnostics.stage === 'staging') await this.#syncBundleMove();
            registry.diagnostics.stage = 'prepared';
            await registry.save();
            unlock = await this.#lock(locations);
            const previousBytes = this.#slotBytes(locations);
            const previous = previousBytes === null ? null : JSON.parse(previousBytes);
            if (previous) {
                if (previous.projectRoot !== registry.projectRoot || previous.profile !== registry.profile || previous.slotPath !== locations.slot) throw new Error(`Diagnostic slot has foreign project/profile ownership: ${locations.slot}`);
                validateIndex(previous);
            }
            const lineage = previous ? this.#lineage(previous) : [];
            if (previous?.runId !== registry.runId && lineage.some(({ owner }) => owner.runId === registry.runId)) {
                stage = 'cleanup';
                const retirement = await this.reclaimDisplaced();
                registry.diagnostics.retentionPending = retirement.pending;
                registry.diagnostics.publication = { stage: 'complete', published: false, slotPath: locations.slot };
                await registry.save();
                result = registry.diagnosticIndex;
            } else {
                if (previous && previous.runId !== registry.runId) registry.diagnostics.previous = { runId: previous.runId, profile: previous.profile, bundle: previous.storage.bundle, version: previous.version };
                registry.diagnostics.publication = { stage, published, slotPath: locations.slot };
                await registry.save();
                const slotPending = await this.#atomic(locations.slot, json(record), () => {
                    published = true; stage = 'durability'; registry.diagnosticIndex = record;
                    registry.diagnostics.stage = 'published';
                    registry.diagnostics.publication = { stage, published, slotPath: locations.slot };
                });
                registry.diagnostics.pending.splice(registry.diagnostics.pending.indexOf(slotPending), 1);
                await registry.save();
                stage = 'cleanup';
                const retirement = await this.reclaimDisplaced();
                await this.#removeIndexes(registry.diagnostics.indexes.filter(receipt => receipt.version !== record.version));
                registry.diagnostics.retentionPending = retirement.pending;
                registry.diagnostics.publication = { stage: 'complete', published: true, slotPath: locations.slot };
                await registry.save();
                result = record;
            }
        } catch (error) { errors.push(error); }
        finally {
            if (unlock) { try { unlock(); } catch (error) { errors.push(error); } }
        }
        if (errors.length) {
            registry.diagnostics && (registry.diagnostics.publication = { stage, published, slotPath: locations.slot });
            const error = new AggregateError(errors, `Cannot publish diagnostics for run ${registry.runId} profile ${registry.profile} at ${stage}: ${errors.map(error => error.message).join('; ')}`);
            error.publication = { stage, published, slotPath: locations.slot };
            throw error;
        }
        return result;
    }

    async reclaimDisplaced() {
        const registry = this.#registry;
        const locations = this.#verifyBoundaries();
        const slotBytes = this.#slotBytes(locations);
        if (slotBytes === null) return { superseded: false, pending: false };
        const current = JSON.parse(slotBytes);
        if (current.projectRoot !== registry.projectRoot || current.profile !== registry.profile || current.slotPath !== locations.slot) throw new Error(`Diagnostic retirement slot has foreign project/profile ownership: ${locations.slot}`);
        const lineage = this.#lineage(current);
        let superseded = false;
        let pending = false;
        for (const { previous, owner } of lineage) {
            if (owner.runId === registry.runId) {
                superseded = true;
                if (registry.resources.every(record => ['disposed', 'released'].includes(record.state))) await this.#removeRetired(previous);
                else pending = true;
            } else if (owner.resources.every(record => ['disposed', 'released'].includes(record.state)) && await executionEnded(owner.writer)) {
                let target;
                let custody;
                let authority;
                const errors = [];
                try {
                    target = Registry.reopen(this.#previousOwner(previous));
                    const admittedDiagnostics = new RunDiagnostics(target);
                    admittedDiagnostics.validateRegistration();
                    admittedDiagnostics.restorePublished();
                    let hasCustodyMarker = true;
                    try { fs.lstatSync(path.join(target.custodyBoundary.path, 'execution.json')); }
                    catch (error) { if (error.code === 'ENOENT') hasCustodyMarker = false; else throw error; }
                    if (target.diagnostics.stage === 'retired' && target.diagnostics.retirement?.state === 'complete' && target.diagnostics.retentionPending === false && !hasCustodyMarker) {
                        await admittedDiagnostics.#removeRetired(previous);
                    } else {
                        const writer = { runId: owner.runId, executionId: randomUUID(), native: await readProcessIdentity(process.pid) };
                        const admission = await reserveWriter(target, writer, { skipActive: true, readCurrent: () => this.#previousOwner(previous), onError: error => { target.reportError(error); errors.push(error); } });
                        if (admission) {
                            ({ authority, custody } = admission);
                            const fresh = this.#previousOwner(previous);
                            if (!await executionEnded(fresh.writer)) throw new Error(`Run ${owner.runId} has an active registry writer under retirement custody`);
                            target = Registry.reopen(fresh);
                            const diagnostics = new RunDiagnostics(target);
                            diagnostics.validateRegistration();
                            diagnostics.restorePublished();
                            target.claimWriter(authority, custody);
                            await diagnostics.#removeRetired(previous);
                        } else pending = true;
                    }
                } catch (error) { errors.push(error); }
                finally {
                    if (authority) { try { await authority.close(); } catch (error) { errors.push(error); } }
                    if (authority && target.errors.length) { try { await target.save(); } catch (error) { errors.push(error); } }
                    if (custody) { try { custody.conclude(); } catch (error) { errors.push(error); } }
                }
                if (errors.length) throw failureGroup(errors, `Cannot retire diagnostic bundle for run ${owner.runId}`);
            } else pending = true;
        }
        return { superseded, pending };
    }

    #lineage(current) {
        const { registered } = validateIndex(current);
        const seen = new Set([current.runId]);
        const lineage = [];
        let previous = registered.diagnostics.previous;
        while (previous !== null) {
            const owner = this.#previousOwner(previous);
            if (seen.has(owner.runId)) throw new Error(`Run ${this.#registry.runId} diagnostic predecessor lineage contains a cycle at ${owner.runId}`);
            seen.add(owner.runId);
            new RunDiagnostics(Registry.reopen(owner)).validateRegistration();
            lineage.push({ previous, owner });
            previous = owner.diagnostics.previous;
        }
        return lineage;
    }

    #previousOwner(previous) {
        const registry = this.#registry;
        if (!previous || typeof previous.runId !== 'string' || !uuid.test(previous.runId) || previous.profile !== registry.profile || previous.bundle?.path !== layout(registry.projectRoot, previous.runId, previous.profile).bundle || typeof previous.version !== 'string' || !uuid.test(previous.version)) throw new Error(`Run ${registry.runId} has invalid predecessor diagnostic ownership`);
        const directory = path.join(registry.projectRoot, 'test-results/harness/runs', previous.runId);
        const filename = path.join(directory, 'registry.json');
        registry.verifyBoundaries(); identity(directory);
        const owner = JSON.parse(readFile(filename));
        if (owner.projectRoot !== registry.projectRoot || owner.profile !== registry.profile || owner.runId !== previous.runId || !isDeepStrictEqual(owner.diagnostics?.bundle, previous.bundle)) throw new Error(`Predecessor diagnostic bundle has no matching registered owner: ${filename}`);
        if (owner.diagnostics.format !== 'run-diagnostics-v2' || !Object.hasOwn(owner.diagnostics, 'previous')) throw new Error(`Run ${owner.runId} diagnostic retirement format cannot establish single retirement authority; retain ${filename}`);
        for (const writer of [owner.owner, owner.writer]) {
            if (!writer || writer.runId !== owner.runId || typeof writer.executionId !== 'string' || !uuid.test(writer.executionId) || writer.control?.host !== '127.0.0.1' || !Number.isInteger(writer.control.port) || writer.control.port < 1 || writer.control.port > 65535) throw new Error(`Run ${owner.runId} retirement writer has no registered execution authority`);
            validateProcessIdentity(writer.native);
            if (writer.native.platform !== process.platform) throw new Error(`Run ${owner.runId} retirement requires native ${writer.native.platform} identity inspection`);
        }
        if (owner.writer.control.port !== owner.owner.control.port || !Array.isArray(owner.resources) || !Array.isArray(owner.diagnostics.indexes)) throw new Error(`Run ${owner.runId} has incomplete retirement writer/resource metadata`);
        const expected = [registry.projectRoot];
        for (const part of ['test-results', 'harness', 'runs', previous.runId]) expected.push(path.join(expected.at(-1), part));
        if (!Array.isArray(owner.boundaries) || owner.boundaries.length !== expected.length) throw new Error(`Run ${owner.runId} has incomplete retirement boundaries`);
        for (const [index, boundary] of owner.boundaries.entries()) { if (boundary.path !== expected[index]) throw new Error(`Run ${owner.runId} has an unregistered retirement boundary`); verify(boundary); }
        verifyCustodyBoundary(owner.custodyBoundary, directory);
        if (owner.dataBoundary?.path !== path.join(directory, 'data')) throw new Error(`Run ${owner.runId} retirement data boundary is unregistered`);
        verify(owner.dataBoundary);
        if (!owner.diagnostics.indexes.some(receipt => receipt.version === previous.version)) throw new Error(`Run ${owner.runId} has no registered predecessor index ${previous.version}`);
        return owner;
    }

    #verifyRetirement() {
        const registry = this.#registry;
        const locations = this.#verifyBoundaries();
        const stored = registry.diagnostics;
        const receipt = stored.retirement;
        if (!receipt || receipt.format !== 'diagnostic-retirement-v1' || !['removing', 'complete'].includes(receipt.state) || !isDeepStrictEqual(receipt.bundle, stored.bundle) || stored.bundle.path !== locations.bundle || !isDeepStrictEqual(receipt.objects, stored.objects) || stored.objects.path !== path.join(locations.bundle, 'objects') || !Array.isArray(receipt.files)) throw new Error(`Run ${registry.runId} has invalid durable retirement authority`);
        const expected = new Map(stored.indexes.map(ref => [`index-${ref.version}.json`, ref]));
        if (!stored.artifacts.every(validArtifact) || !stored.indexes.every(ref => typeof ref.version === 'string' && uuid.test(ref.version) && typeof ref.sha256 === 'string' && digest.test(ref.sha256) && Number.isSafeInteger(ref.length) && ref.length >= 0 && Number.isSafeInteger(ref.dev) && Number.isSafeInteger(ref.ino))) throw new Error(`Run ${registry.runId} retirement inventory has invalid registered integrity metadata`);
        for (const ref of stored.artifacts) expected.set('objects/' + ref.sha256, ref);
        if (receipt.files.length !== expected.size) throw new Error(`Run ${registry.runId} retirement inventory is incomplete`);
        for (const file of receipt.files) if (!expected.has(file.name) || !['dev', 'ino', 'length', 'sha256'].every(key => file[key] === expected.get(file.name)[key])) throw new Error(`Run ${registry.runId} retirement file has no registered integrity authority: ${file.name}`);
        if (new Set(receipt.files.map(file => file.name)).size !== expected.size) throw new Error(`Run ${registry.runId} retirement inventory contains duplicate files`);
        return receipt;
    }

    async #removeRetired(previous) {
        const registry = this.#registry;
        const stored = registry.diagnostics;
        const locations = this.#verifyBoundaries();
        const currentBytes = this.#slotBytes(locations, true);
        const current = JSON.parse(currentBytes);
        if (current.projectRoot !== registry.projectRoot || current.profile !== registry.profile || current.slotPath !== locations.slot) throw new Error(`Diagnostic retirement slot has foreign project/profile ownership: ${locations.slot}`);
        validateIndex(current);
        if (current.runId === registry.runId) throw new Error(`Cannot delete the current diagnostic failure slot: ${registry.runId}`);
        if (!stored.retirement) {
            await this.#removeIndexes(stored.indexes.filter(receipt => receipt.removing === true));
            const index = JSON.parse(readFile(path.join(previous.bundle.path, `index-${previous.version}.json`)));
            validateIndex(index);
            this.#verify();
            const files = new Map(stored.indexes.map(ref => [`index-${ref.version}.json`, ref]));
            for (const ref of stored.artifacts) files.set('objects/' + ref.sha256, ref);
            if (!isDeepStrictEqual([...fs.readdirSync(locations.bundle)].sort(), [...stored.indexes.map(ref => `index-${ref.version}.json`), 'objects'].sort()) || !isDeepStrictEqual([...fs.readdirSync(stored.objects.path)].sort(), [...new Set(stored.artifacts.map(ref => ref.sha256))].sort())) throw new Error(`Displaced diagnostic bundle contains unregistered files: ${locations.bundle}`);
            for (const [name, ref] of files) { const bytes = readFile(path.join(locations.bundle, name), ref); if (bytes.length !== ref.length || hash(bytes) !== ref.sha256) throw new Error(`Run ${registry.runId} retirement content failed integrity verification: ${name}`); }
            stored.retirement = { format: 'diagnostic-retirement-v1', state: 'removing', bundle: stored.bundle, objects: stored.objects, files: [...files].map(([name, ref]) => ({ name, dev: ref.dev, ino: ref.ino, length: ref.length, sha256: ref.sha256 })) };
            await registry.save();
        }
        const receipt = this.#verifyRetirement();
        if (!this.#slotBytes(locations, true).equals(currentBytes)) throw new Error(`Run ${registry.runId} profile ${JSON.stringify(registry.profile)} diagnostic slot changed during retirement: ${locations.slot}`);
        const remaining = expected => {
            this.#verifyBoundaries();
            try { fs.lstatSync(expected.path); }
            catch (error) { if (error.code === 'ENOENT') return false; throw error; }
            verify(expected); return true;
        };
        if (receipt.state === 'complete') {
            if (remaining(receipt.bundle)) throw new Error(`Run ${registry.runId} retired bundle unexpectedly exists: ${locations.bundle}`);
            return;
        }
        if (remaining(receipt.bundle)) {
            const allowed = new Set(receipt.files.map(file => file.name));
            if (fs.readdirSync(locations.bundle).some(name => name !== 'objects' && !allowed.has(name))) throw new Error(`Run ${registry.runId} retirement bundle contains unregistered files`);
            if (remaining(receipt.objects) && fs.readdirSync(receipt.objects.path).some(name => !allowed.has('objects/' + name))) throw new Error(`Run ${registry.runId} retirement content contains unregistered files`);
            for (const file of receipt.files) {
                const filename = path.join(locations.bundle, file.name);
                let stat;
                try { stat = fs.lstatSync(filename); }
                catch (error) { if (error.code === 'ENOENT') continue; throw error; }
                const bytes = readFile(filename, file);
                if (!stat.isFile() || bytes.length !== file.length || hash(bytes) !== file.sha256) throw new Error(`Run ${registry.runId} retirement file changed: ${filename}`);
                fs.unlinkSync(filename);
            }
            if (remaining(receipt.objects)) fs.rmdirSync(receipt.objects.path);
            verify(receipt.bundle); fs.rmdirSync(receipt.bundle.path);
        }
        await syncDirectory(locations.bundles);
        this.#verifyRetirement();
        if (remaining(receipt.bundle)) throw new Error(`Run ${registry.runId} retirement bundle exists after removal: ${locations.bundle}`);
        receipt.state = 'complete'; stored.stage = 'retired'; stored.retentionPending = false;
        await registry.save();
    }

    async retire() {
        if (!this.#registry.diagnostics) return false;
        const locations = this.#verifyBoundaries();
        const unlock = await this.#lock(locations);
        const errors = [];
        let superseded;
        try {
            const result = await this.reclaimDisplaced();
            superseded = result.superseded;
            if (!superseded && this.#registry.diagnosticIndex !== null) await this.#removeIndexes(this.#registry.diagnostics.indexes.filter(receipt => receipt.version !== this.#registry.diagnosticIndex.version));
            const pending = result.pending || this.#registry.diagnostics.pending.length > 0;
            if (this.#registry.diagnostics.retentionPending !== pending) {
                this.#registry.diagnostics.retentionPending = pending;
                await this.#registry.save();
            }
        }
        catch (error) { errors.push(error); }
        try { unlock(); } catch (error) { errors.push(error); }
        if (errors.length) throw failureGroup(errors, `Cannot retire superseded diagnostics for run ${this.#registry.runId}`);
        return superseded;
    }

    async discard() {
        await this.#operations;
        if (!this.#registry.diagnostics) return;
        const stored = this.#registry.diagnostics;
        const expected = this.#discardInventory();
        if (!stored.discard) {
            this.#verify();
            stored.discard = removalReceipt(expected);
            await this.#registry.save();
        }
        await removeOwnedTree(stored.discard, expected);
        stored.stage = 'discarded'; stored.retentionPending = false;
        await this.#registry.save();
    }

    #discardInventory() {
        const stored = this.#registry.diagnostics;
        const locations = this.#verifyBoundaries();
        if (stored.bundle || this.#registry.diagnosticIndex !== null || stored.staging.path !== locations.staging || stored.objects.path !== path.join(locations.staging, 'objects') || stored.pending.length) throw new Error(`Run ${this.#registry.runId} cannot discard published or pending diagnostics`);
        const files = new Map();
        for (const ref of stored.artifacts) {
            if (!validArtifact(ref)) throw new Error(`Run ${this.#registry.runId} has incomplete staging evidence: ${ref.name}`);
            files.set('objects/' + ref.sha256, { name: 'objects/' + ref.sha256, dev: ref.dev, ino: ref.ino, length: ref.length, sha256: ref.sha256 });
        }
        for (const receipt of stored.indexes) files.set(path.basename(this.#indexPath(locations.staging, receipt)), { name: `index-${receipt.version}.json`, dev: receipt.dev, ino: receipt.ino, length: receipt.length, sha256: receipt.sha256 });
        return { root: stored.staging, parent: stored.boundaries.find(boundary => boundary.path === locations.stagingRoot), directories: [{ name: 'objects', dev: stored.objects.dev, ino: stored.objects.ino }], files: [...files.values()] };
    }

    #verifyEnvironment() {
        const registry = this.#registry;
        registry.verifyBoundaries();
        const selected = registry.environmentExport;
        const expected = path.join(path.dirname(registry.file), 'environment');
        if (selected.storage?.path !== expected || selected.objects?.path !== path.join(expected, 'objects') || !Array.isArray(selected.resources)) throw new Error(`Run ${registry.runId} has no registered environment staging`);
        registry.assertUnborrowed(expected);
        verify(selected.storage); verify(selected.objects);
        return expected;
    }

    #environmentInventory() {
        const selected = this.#registry.environmentExport;
        const expected = path.join(path.dirname(this.#registry.file), 'environment');
        this.#registry.verifyBoundaries();
        if (selected.storage?.path !== expected || selected.objects?.path !== path.join(expected, 'objects')) throw new Error(`Run ${this.#registry.runId} environment removal is outside registered staging`);
        const files = new Map();
        for (const staged of selected.resources) for (const { ref } of staged.files) {
            if (!validArtifact(ref)) throw new Error(`Run ${this.#registry.runId} has invalid environment removal content`);
            files.set(ref.sha256, { name: 'objects/' + ref.sha256, dev: ref.dev, ino: ref.ino, length: ref.length, sha256: ref.sha256 });
        }
        return { root: selected.storage, parent: identity(path.dirname(expected)), directories: [{ name: 'objects', dev: selected.objects.dev, ino: selected.objects.ino }], files: [...files.values()] };
    }

    #verifyArchive() {
        const selected = this.#registry.environmentExport;
        const archive = selected.archive;
        this.#registry.verifyBoundaries();
        if (!archive || archive.format !== 'owned-environment-archive-v1' || !archive.root || !archive.parent || archive.root.path !== selected.destination || archive.parent.path !== path.dirname(selected.destination) || !['allocating', 'copying', 'complete'].includes(archive.state)) throw new Error(`Run ${this.#registry.runId} has invalid registered environment archive`);
        if (!isDeepStrictEqual(destinationParent(selected.destination, this.#registry.projectRoot, this.#registry.resources), archive.parent)) throw new Error(`Run ${this.#registry.runId} environment archive parent changed`);
        verify(archive.parent);
        if (archive.state === 'allocating') {
            if (archive.root.dev !== null || archive.root.ino !== null) throw new Error(`Run ${this.#registry.runId} environment allocation has inconsistent identity`);
            let actual;
            try { actual = fs.lstatSync(archive.root.path); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (actual) throw new Error(`Run ${this.#registry.runId} environment destination exists without its registered allocation identity: ${archive.root.path}`);
        } else verify(archive.root);
        if (archive.state === 'complete') {
            if (selected.state !== 'complete' || !selected.cleanup || !Array.isArray(archive.inventory?.files) || !Array.isArray(archive.inventory?.directories) || !isDeepStrictEqual(archive.inventory.root, archive.root) || !isDeepStrictEqual(archive.inventory.parent, archive.parent)) throw new Error(`Run ${this.#registry.runId} environment archive has no matching completion inventory`);
            const { files, directories } = this.#environmentDescription();
            const expected = new Map(files.map(file => [file.name, file]));
            if (archive.inventory.files.length !== expected.size || archive.inventory.files.some(file => !isDeepStrictEqual({ name: file.name, length: file.length, sha256: file.sha256 }, expected.get(file.name))) || !isDeepStrictEqual(archive.inventory.directories.map(directory => directory.name).sort(), directories)) throw new Error(`Run ${this.#registry.runId} environment archive differs from its admitted staged state`);
            verifyOwnedTree(archive.inventory);
        }
        if (selected.cleanup) verifyRemoval(selected.cleanup, this.#environmentInventory());
    }

    #environmentDescription() {
        const registry = this.#registry;
        const files = [];
        const directories = [];
        for (const staged of registry.environmentExport.resources) {
            const record = registry.resources.find(record => record.resourceId === staged.resourceId && record.owner === 'owned' && record.kind === 'directory');
            if (!record || staged.readStatus !== 'complete') throw new Error(`Run ${registry.runId} has incomplete environment staging: ${staged.resourceId}`);
            const prefix = 'resources/' + record.resourceId;
            for (const name of [...staged.directories, ...staged.files.map(file => file.name)]) if (name !== prefix && (!name.startsWith(prefix + '/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part)))) throw new Error(`Run ${registry.runId} has an invalid environment path: ${name}`);
            directories.push(...staged.directories);
            for (const { name, ref } of staged.files) {
                if (!validArtifact(ref)) throw new Error(`Run ${registry.runId} has invalid environment content: ${name}`);
                files.push({ name, length: ref.length, sha256: ref.sha256 });
            }
        }
        const manifest = json({ format: 'owned-environment-v1', runId: registry.runId, source: registry.source, profile: registry.profile, supportedState: ['owned-directory-files'], directories, files });
        files.push({ name: 'environment.json', length: manifest.length, sha256: hash(manifest) });
        const names = new Set(directories);
        for (const name of [...directories, ...files.map(file => file.name)]) {
            const parts = name.split('/');
            for (let length = 1; length < parts.length; length++) names.add(parts.slice(0, length).join('/'));
        }
        return { files, directories: [...names].sort() };
    }

    async stageEnvironment(record) {
        const registry = this.#registry;
        const selected = registry.environmentExport;
        if (!selected || record.owner !== 'owned' || record.kind === 'process') return;
        if (selected.state === 'complete') return;
        if (selected.state !== 'requested') throw new Error(`Run ${registry.runId} environment staging is ${selected.state} for resource ${record.resourceId}`);
        if (record.kind !== 'directory') throw new Error(`Environment export has no registered state provider for resource ${record.resourceId} (${record.kind})`);
        if (selected.resources.some(known => known.resourceId === record.resourceId && known.readStatus === 'complete')) return;
        const storage = this.#verifyEnvironment();
        const files = new Map();
        const directories = [];
        const visit = (directory, relative) => {
            directories.push(relative);
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const filename = path.join(directory, entry.name);
                const stat = fs.lstatSync(filename);
                if (stat.isDirectory()) { identity(filename); visit(filename, relative + '/' + entry.name); }
                else if (stat.isFile()) files.set(relative + '/' + entry.name, readFile(filename, stat));
                else throw new Error(`Environment export requires a real directory or regular file, not a symbolic link or special file: ${filename}`);
            }
        };
        registry.verifyDataBoundary();
        const expected = path.join(registry.dataRoot, record.resourceId);
        if (!registry.resources.includes(record) || record.locator.path !== expected) throw new Error(`Environment export resource ${record.resourceId} is outside its owned data boundary`);
        registry.assertUnborrowed(expected); verify(record.locator);
        visit(expected, 'resources/' + record.resourceId);
        const staged = { resourceId: record.resourceId, readStatus: 'pending', directories, files: [] };
        selected.resources.push(staged);
        await registry.save();
        this.#verifyEnvironment();
        for (const [name, bytes] of files) {
            const ref = { name: record.resourceId + '-' + hash(bytes), scopeId: record.scopeId, contentType: 'application/octet-stream', readStatus: 'complete', ...storeContent(storage, bytes) };
            content(storage, ref); staged.files.push({ name, ref });
        }
        await syncDirectory(selected.objects.path);
        this.#verifyEnvironment();
        for (const file of staged.files) content(storage, file.ref);
        staged.readStatus = 'complete';
        await registry.save();
    }

    async exportEnvironment(destination) {
        const registry = this.#registry;
        const selected = registry.environmentExport;
        if (selected.archive?.state === 'complete') {
            this.#verifyArchive();
            await removeOwnedTree(selected.cleanup, this.#environmentInventory());
            await registry.save();
            return;
        }
        if (selected.state !== 'requested') throw new Error(`Run ${registry.runId} cannot export environment after ${selected.state} staging`);
        for (const record of registry.resources.filter(record => record.owner === 'owned' && record.kind !== 'process')) {
            if (record.kind !== 'directory') throw new Error(`Environment export has no registered state provider for resource ${record.resourceId} (${record.kind})`);
            const staged = selected.resources.find(known => known.resourceId === record.resourceId);
            if (staged?.readStatus === 'complete') continue;
            if (['disposed', 'released'].includes(record.state) && record.locator.ino !== null) throw new Error(`Run ${registry.runId} environment resource ${record.resourceId} was released without complete staged state`);
            if (registry.hasAllocation(record)) await this.stageEnvironment(record);
        }
        const storage = this.#verifyEnvironment();
        const files = new Map();
        const directories = [];
        for (const staged of selected.resources) {
            if (staged.readStatus !== 'complete') throw new Error(`Run ${registry.runId} environment resource ${staged.resourceId} has incomplete staged state`);
            const record = registry.resources.find(record => record.resourceId === staged.resourceId && record.owner === 'owned' && record.kind === 'directory');
            if (!record) throw new Error(`Run ${registry.runId} environment staging has no owned resource ${staged.resourceId}`);
            const prefix = 'resources/' + record.resourceId;
            for (const name of [...staged.directories, ...staged.files.map(file => file.name)]) if (name !== prefix && (!name.startsWith(prefix + '/') || name.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error(`Run ${registry.runId} environment resource ${record.resourceId} has an invalid staged path: ${name}`);
            directories.push(...staged.directories);
            for (const file of staged.files) files.set(file.name, content(storage, file.ref));
        }
        files.set('environment.json', json({ format: 'owned-environment-v1', runId: registry.runId, source: registry.source, profile: registry.profile, supportedState: ['owned-directory-files'], directories, files: [...files].map(([name, bytes]) => ({ name, length: bytes.length, sha256: hash(bytes) })) }));
        if (!selected.archive) {
            selected.archive = { format: 'owned-environment-archive-v1', state: 'allocating', parent: destinationBoundary(destination, registry.projectRoot, registry.resources), root: { path: destination, dev: null, ino: null } };
            await registry.save();
        }
        const archive = selected.archive;
        this.#verifyArchive();
        if (archive.state === 'allocating') {
            fs.mkdirSync(destination, { mode: 0o700 });
            archive.root = identity(destination); archive.state = 'copying';
            await registry.save();
        }
        this.#verifyArchive();
        fillArchive(destination, archive.parent, archive.root, files, directories);
        const directoryNames = new Set(directories);
        for (const name of [...directories, ...files.keys()]) {
            const parts = name.split('/');
            for (let length = 1; length < parts.length; length++) directoryNames.add(parts.slice(0, length).join('/'));
        }
        archive.inventory = { root: archive.root, parent: archive.parent, directories: [...directoryNames].sort().map(name => { const stat = identity(path.join(destination, name)); return { name, dev: stat.dev, ino: stat.ino }; }), files: [...files].map(([name, bytes]) => { const stat = fs.lstatSync(path.join(destination, name)); return { name, dev: stat.dev, ino: stat.ino, length: bytes.length, sha256: hash(bytes) }; }) };
        verifyOwnedTree(archive.inventory);
        for (const directory of [...archive.inventory.directories].sort((left, right) => right.name.split('/').length - left.name.split('/').length)) await syncDirectory(path.join(destination, directory.name));
        await syncDirectory(destination); await syncDirectory(archive.parent.path);
        this.#verifyEnvironment();
        selected.cleanup = removalReceipt(this.#environmentInventory());
        archive.state = 'complete'; selected.state = 'complete';
        this.#verifyArchive();
        await registry.save();
        this.#verifyArchive();
        await removeOwnedTree(selected.cleanup, this.#environmentInventory());
        await registry.save();
    }
}
