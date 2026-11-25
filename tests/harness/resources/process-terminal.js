import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateProcessExit, validateProcessIdentity } from './native-identity.js';
import { failureGroup, receiveFailureGraph, failureFingerprint, bindFailureEvent } from './errors.js';

/** The registry registers this descriptor before the controller may inherit it. */
export function openProcessTerminal(record) {
    const descriptor = fs.openSync(record.terminal.path, 'wx', 0o600);
    try {
        const stat = fs.fstatSync(descriptor);
        const directory = path.dirname(record.terminal.path);
        const boundary = fs.lstatSync(directory);
        const publication = { path: record.terminal.path + '.publication.json', dev: null, ino: null };
        const diagnostic = fs.openSync(publication.path, 'wx', 0o600);
        try { const stat = fs.fstatSync(diagnostic); publication.dev = stat.dev; publication.ino = stat.ino; }
        finally { fs.closeSync(diagnostic); }
        record.terminal = { ...record.terminal, dev: stat.dev, ino: stat.ino, completion: record.terminal.path + '.complete', publication, directory: { path: directory, dev: boundary.dev, ino: boundary.ino } };
    } catch (error) {
        try { fs.closeSync(descriptor); }
        catch (cleanup) { throw failureGroup([error, cleanup], `Cannot acquire terminal descriptor identity for process ${record.resourceId}`); }
        throw error;
    }
    let closed = false;
    return { descriptor, close() { if (!closed) { closed = true; fs.closeSync(descriptor); } } };
}

function verifyFile(identity) {
    const stat = fs.lstatSync(identity.path);
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error(`Terminal file identity changed at ${identity.path}`);
    return stat;
}

function verifyDirectory(identity) {
    const stat = fs.lstatSync(identity.path);
    if (!stat.isDirectory() || fs.realpathSync(identity.path) !== identity.path || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error(`Terminal directory identity changed at ${identity.path}`);
}

const durable = descriptor => new Promise((resolve, reject) => fs.fsync(descriptor, error => error ? reject(error) : resolve()));

/** Completion is the exclusive final link, after all required writes, durability and closes. */
export async function writeProcessTerminal(config, controller, worker, error, workerFailure, errorEvents, workerEvents, diagnostic) {
    const terminal = config.terminal;
    const outcome = { format: 'process-terminal-v2', runId: config.runId, scopeId: config.scopeId, resourceId: config.resourceId, ownerExecutionId: config.ownerExecutionId, executionId: config.executionId, controller, worker, status: error ? 'failed' : 'stopped', error, workerFailure, errorEvents, workerEvents, complete: true };
    const errors = [];
    let stage = 'prepare';
    let owned = false;
    let directory;
    try {
        const stat = fs.fstatSync(4);
        if (!stat.isFile() || stat.dev !== terminal.dev || stat.ino !== terminal.ino) throw new Error(`Controller terminal descriptor does not match resource ${config.resourceId}`);
        owned = true;
        verifyDirectory(terminal.directory);
        verifyFile(terminal);
        stage = 'write';
        fs.writeFileSync(4, JSON.stringify(outcome) + '\n');
        stage = 'durability';
        await durable(4);
        directory = fs.openSync(terminal.directory.path, 'r');
        await durable(directory);
        stage = 'close';
        owned = false;
        fs.closeSync(4);
        const closing = directory;
        directory = undefined;
        fs.closeSync(closing);
        stage = 'completion';
        verifyDirectory(terminal.directory);
        verifyFile(terminal);
        fs.linkSync(terminal.path, terminal.completion);
        return;
    } catch (error) { errors.push(error); }
    if (owned) { try { fs.closeSync(4); } catch (error) { errors.push(error); } }
    if (directory !== undefined) { try { fs.closeSync(directory); } catch (error) { errors.push(error); } }
    const failure = new AggregateError(errors, `Process ${config.resourceId} terminal publication failed at ${stage}: ${errors.map(error => error.message).join('; ')}`);
    failure.publication = { terminalPath: terminal.path, completionPath: terminal.completion, stage, published: false };
    let descriptor;
    try {
        verifyDirectory(terminal.directory);
        verifyFile(terminal.publication);
        descriptor = fs.openSync(terminal.publication.path, 'r+');
        const stat = fs.fstatSync(descriptor);
        if (stat.dev !== terminal.publication.dev || stat.ino !== terminal.publication.ino) throw new Error(`Terminal publication diagnostic identity changed at ${terminal.publication.path}`);
        fs.writeFileSync(descriptor, JSON.stringify({ ...outcome, format: 'process-terminal-publication-v1', publicationFailure: diagnostic(failure) }) + '\n');
        fs.fsyncSync(descriptor);
    } catch (error) { errors.push(error); }
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch (error) { errors.push(error); } }
    if (errors.length !== failure.errors.length) throw failureGroup([failure, ...errors.slice(failure.errors.length)], `Cannot retain terminal publication diagnostics for process ${config.resourceId}`);
    throw failure;
}

export function validateProcessTerminalRegistration(record, registryFile) {
    const terminal = record.terminal;
    const expected = path.join(path.dirname(registryFile), `${record.resourceId}-terminal.json`);
    if (!terminal || terminal.path !== expected || !Number.isSafeInteger(terminal.dev) || !Number.isSafeInteger(terminal.ino) || terminal.completion !== expected + '.complete' || terminal.publication?.path !== expected + '.publication.json' || !Number.isSafeInteger(terminal.publication.dev) || !Number.isSafeInteger(terminal.publication.ino) || terminal.directory?.path !== path.dirname(expected) || !Number.isSafeInteger(terminal.directory.dev) || !Number.isSafeInteger(terminal.directory.ino) || terminal.acknowledged !== null && !/^[a-f0-9]{64}$/.test(terminal.acknowledged)) throw new Error(`Process ${record.resourceId} terminal evidence is missing or unregistered; retain scenario data and registry ${record.runId}`);
}

function readRegistered(identity) {
    const stat = verifyFile(identity);
    const descriptor = fs.openSync(identity.path, 'r');
    const errors = [];
    let bytes;
    try {
        const actual = fs.fstatSync(descriptor);
        if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error(`Terminal file changed before reading ${identity.path}`);
        bytes = fs.readFileSync(descriptor);
    } catch (error) { errors.push(error); }
    try { fs.closeSync(descriptor); } catch (error) { errors.push(error); }
    if (errors.length) throw failureGroup(errors, `Cannot read registered terminal file ${identity.path}`);
    return bytes;
}

function receiveOutcome(receipt, record, format) {
    if (!receipt || receipt.format !== format || receipt.complete !== true || !['stopped', 'failed'].includes(receipt.status) || ['runId', 'scopeId', 'resourceId'].some(name => receipt[name] !== record[name]) || receipt.executionId !== record.locator.executionId || receipt.ownerExecutionId !== record.locator.ownerExecutionId || !receipt.controller || JSON.stringify(receipt.controller) !== JSON.stringify(record.locator.controller)) throw new Error('unknown or mismatched execution outcome');
    if (!receipt.worker || receipt.worker.allocation !== 'never-started' && !receipt.worker.exit) throw new Error('no complete worker outcome');
    if (receipt.worker.allocation !== 'never-started') {
        validateProcessExit(receipt.worker.exit);
        if (receipt.worker.native) validateProcessIdentity(receipt.worker.native);
    } else if (Object.keys(receipt.worker).some(name => name !== 'allocation')) throw new Error('inconsistent native nonallocation evidence');
    if (receipt.status === 'failed' ? receipt.error?.type !== 'error' : receipt.error !== null) throw new Error('inconsistent failure graph');
    if (receipt.workerFailure !== null && receipt.workerFailure?.type !== 'error') throw new Error('unknown worker failure graph');
    if (receipt.error !== null) receipt.error = receiveFailureGraph(receipt.error);
    if (receipt.workerFailure !== null) receipt.workerFailure = receiveFailureGraph(receipt.workerFailure);
    const ids = new Set();
    for (const [graph, events] of [[receipt.error, receipt.errorEvents], [receipt.workerFailure, receipt.workerEvents]]) {
        if (!Array.isArray(events) || graph !== null && (!Array.isArray(graph.errors) || !graph.errors.length) || events.length !== (graph?.errors?.length ?? 0)) throw new Error('incomplete failure event binding');
        for (const [index, event] of events.entries()) {
            if (!event || !/^[a-f0-9-]{36}$/.test(event.id) || ids.has(event.id) || event.fingerprint !== failureFingerprint(graph.errors[index])) throw new Error('failure event content does not match its graph');
            ids.add(event.id);
        }
    }
    return receipt;
}

/** Only authorized, same-execution evidence is consumed, after the controller has ended. */
export function consumeProcessTerminal(record, registry, observed = new Map()) {
    validateProcessTerminalRegistration(record, registry.file);
    const terminal = record.terminal;
    const expected = terminal.path;
    const invalid = message => new Error(`Process ${record.resourceId} terminal evidence ${message}; retain scenario data and registry ${record.runId}`);
    registry.verifyBoundaries();
    verifyDirectory(terminal.directory);
    verifyFile(terminal);
    try { verifyFile({ ...terminal, path: terminal.completion }); }
    catch (authorization) {
        try {
            const bytes = readRegistered(terminal.publication);
            if (!bytes.length) throw invalid(`has no completion authorization at ${terminal.completion}`);
            const receipt = receiveOutcome(JSON.parse(bytes), record, 'process-terminal-publication-v1');
            if (receipt.publicationFailure?.type !== 'error') throw invalid('has an incomplete publication failure diagnostic');
            receipt.publicationFailure = receiveFailureGraph(receipt.publicationFailure);
            throw new Error(`Process ${record.resourceId} terminal publication is incomplete at ${expected}: ${receipt.publicationFailure.message}; retain scenario data`, { cause: receipt });
        } catch (error) { throw failureGroup([authorization, error], `Process ${record.resourceId} has no verified terminal completion; retain scenario data`); }
    }
    const bytes = readRegistered(terminal);
    let receipt;
    try { receipt = receiveOutcome(JSON.parse(bytes), record, 'process-terminal-v2'); }
    catch (error) { throw new Error(`Process ${record.resourceId} terminal evidence is partial or incomplete at ${expected}: ${error.message}`, { cause: error }); }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (terminal.acknowledged !== null && terminal.acknowledged !== digest) throw invalid('changed after its failure acknowledgement');
    if (terminal.acknowledged !== null) {
        for (const [graph, events] of [[receipt.error, receipt.errorEvents], [receipt.workerFailure, receipt.workerEvents]]) for (const [index, event] of events.entries()) {
            if (!registry.retainsFailure(event, graph.errors[index])) throw invalid(`acknowledges event ${event.id} without its retained complete original`);
        }
    }
    record.locator.worker = receipt.worker;
    if (terminal.acknowledged === null && (receipt.status === 'failed' || receipt.workerFailure !== null)) {
        const failures = [];
        const originals = [];
        for (const [graph, events, required] of [[receipt.error, receipt.errorEvents, true], [receipt.workerFailure, receipt.workerEvents, false]]) {
            for (const [index, event] of events.entries()) {
                const observation = observed.get(event.id);
                if (observation && observation.fingerprint !== event.fingerprint) throw invalid(`changed failure content for event ${event.id}`);
                const original = observation?.error ?? bindFailureEvent(new Error(`Process ${record.resourceId} complete terminal shutdown failed: ${graph.errors[index].message}`, { cause: graph.errors[index] }), event);
                originals.push(original);
                if (!observation || required) failures.push(original);
            }
        }
        registry.reportError(failureGroup(originals, `Process ${record.resourceId} complete terminal originals`));
        for (const [graph, events] of [[receipt.error, receipt.errorEvents], [receipt.workerFailure, receipt.workerEvents]]) for (const [index, event] of events.entries()) {
            if (!registry.retainsFailure(event, graph.errors[index])) throw invalid(`cannot retain complete original content for event ${event.id}`);
        }
        terminal.acknowledged = digest;
        if (failures.length) throw failureGroup(failures, `Process ${record.resourceId} complete terminal shutdown failed`);
    }
    return receipt;
}
