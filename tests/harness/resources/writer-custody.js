import fs from 'node:fs';
import path from 'node:path';
import { readProcessIdentity, sameProcessIdentity, validateProcessIdentity } from './native-identity.js';
import { Authority } from './authority.js';
import { failureGroup } from './errors.js';

// These are affirmative managed receipts, not an absence-based liveness registry.
// A native process can host successive isolated module realms. Their completed
// execution receipts must remain visible to the next realm in that process.
const nativeProcess = process.getBuiltinModule('node:process');
const executionReceipts = Symbol.for('luker.test-resources.execution-receipts');
if (!Object.hasOwn(nativeProcess, executionReceipts)) {
    Object.defineProperty(nativeProcess, executionReceipts, { value: new Map() });
}
const executions = nativeProcess[executionReceipts];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function executionEnded(identity) {
    validateProcessIdentity(identity.native);
    const actual = await readProcessIdentity(identity.native.pid);
    if (!sameProcessIdentity(actual, identity.native)) return true;
    if (!sameProcessIdentity(identity.native, await readProcessIdentity(process.pid))) return false;
    const known = executions.get(identity.executionId);
    if (!known || known.identity.runId !== identity.runId || !sameProcessIdentity(known.identity.native, identity.native)) throw new Error(`Run ${identity.runId} has unknown local execution ${identity.executionId}; no affirmative execution conclusion permits recovery`);
    return known.concluded;
}

export function verifyCustodyBoundary(boundary, directory) {
    if (!boundary || boundary.path !== path.join(directory, 'writer-custody')) throw new Error(`Run writer custody boundary is unregistered: ${directory}`);
    const actual = fs.lstatSync(boundary.path);
    if (!actual.isDirectory() || fs.realpathSync(boundary.path) !== boundary.path || actual.dev !== boundary.dev || actual.ino !== boundary.ino) throw new Error(`Run writer custody boundary changed: ${boundary.path}`);
}

/** Reserve the registered listener before any ended-custody file mutation. */
export async function reserveWriter(registry, writer, { skipActive = false, readCurrent, onError } = {}) {
    registry.verifyBoundaries();
    verifyCustodyBoundary(registry.custodyBoundary, path.dirname(registry.file));
    let authority;
    try { authority = await Authority.open(writer, { port: registry.owner.control.port, onError }); }
    catch (cause) {
        if (skipActive && cause.code === 'EADDRINUSE') {
            const current = readCurrent();
            if (current && !await executionEnded(current.writer)) return null;
        }
        throw new Error(`Run ${registry.runId} registry writer authority is in use or unavailable; retain ${registry.file}: ${cause.message}`, { cause });
    }
    let custody;
    const errors = [];
    try { custody = await WriterCustody.acquire(registry.custodyBoundary, writer, () => registry.verifyBoundaries(), { skipActive }); }
    catch (error) { errors.push(error); }
    if (!custody) {
        try { await authority.close(); }
        catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors.length === 1 ? errors[0] : failureGroup(errors, `Cannot admit registry writer for run ${registry.runId}`);
    return custody ? { authority, custody } : null;
}

/** One exclusive file spans listener retirement, every final save and its actual settlement. */
export class WriterCustody {
    static async acquire(boundary, identity, verify, { skipActive = false } = {}) {
        const filename = path.join(boundary.path, 'execution.json');
        const check = () => { verify(); verifyCustodyBoundary(boundary, path.dirname(boundary.path)); };
        check();
        let previous;
        try { previous = fs.lstatSync(filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous) {
            if (!previous.isFile()) throw new Error(`Writer custody is not a registered file: ${filename}`);
            const bytes = fs.readFileSync(filename);
            const holder = JSON.parse(bytes);
            if (holder.runId !== identity.runId || !uuid.test(holder.executionId)) throw new Error(`Writer custody has an unknown execution: ${filename}`);
            if (!await executionEnded(holder)) {
                if (skipActive) return null;
                throw new Error(`Run ${identity.runId} writer custody is held by active execution ${holder.executionId}; concurrent recovery must retain ${filename}`);
            }
            check();
            const actual = fs.lstatSync(filename);
            if (!actual.isFile() || actual.dev !== previous.dev || actual.ino !== previous.ino || !fs.readFileSync(filename).equals(bytes)) throw new Error(`Writer custody changed before ended-execution release: ${filename}`);
            fs.unlinkSync(filename);
        }
        check();
        let descriptor;
        try { descriptor = fs.openSync(filename, 'wx', 0o600); }
        catch (error) {
            if (skipActive && error.code === 'EEXIST') {
                const actual = fs.lstatSync(filename);
                if (!actual.isFile()) throw new Error(`Writer custody is not a registered file: ${filename}`);
                const holder = JSON.parse(fs.readFileSync(filename));
                if (holder.runId !== identity.runId || !uuid.test(holder.executionId)) throw new Error(`Writer custody has an unknown execution: ${filename}`);
                validateProcessIdentity(holder.native);
                return null;
            }
            throw new Error(`Run ${identity.runId} writer custody is in use or unavailable; concurrent recovery must retain ${filename}: ${error.message}`, { cause: error });
        }
        let stat;
        const errors = [];
        try {
            stat = fs.fstatSync(descriptor);
            fs.writeFileSync(descriptor, JSON.stringify(identity));
            fs.fsyncSync(descriptor);
        } catch (error) { errors.push(error); }
        try { fs.closeSync(descriptor); }
        catch (error) { errors.push(error); }
        if (errors.length) throw failureGroup(errors, `Cannot persist writer custody: ${filename}`);
        const execution = { identity: structuredClone(identity), concluded: false };
        executions.set(identity.executionId, execution);
        const custody = new WriterCustody();
        custody.verify = () => {
            check();
            const actual = fs.lstatSync(filename);
            if (execution.concluded || !actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error(`Writer execution no longer holds mutation custody: ${filename}`);
        };
        custody.conclude = () => {
            try { custody.verify(); fs.unlinkSync(filename); }
            finally { execution.concluded = true; }
        };
        return custody;
    }
}
