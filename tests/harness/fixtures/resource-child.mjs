import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { serializeFailure } from '../resources/errors.js';

const [mode, inputJSON] = process.argv.slice(2);
const input = JSON.parse(inputJSON);
const runtime = { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') };

if (mode === 'owner') {
    const { createRun } = await import('../resources/run.js');
    const { launchOwnedProcess } = await import('../resources/process-owner.js');
    const run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'real-owner-child', command: [process.execPath, ...process.argv.slice(1)], exportEnvironmentTo: input.exportEnvironmentTo });
    const scope = await run.scope({ kind: 'worker', label: 'interrupted owner' });
    await scope.borrowDirectory(input.borrowed);
    const data = await scope.directory('scenario data');
    fs.writeFileSync(data.path + '/scenario', 'original scenario data');
    if (input.includeBorrowedLink !== false) fs.symlinkSync(input.borrowed, data.path + '/borrowed-link');
    const lease = await launchOwnedProcess(scope, { label: 'actual listening worker', command: [process.execPath, new URL(import.meta.url).pathname, 'server', JSON.stringify({ report: input.report })], dependsOn: [data.resourceId], readyLine: 'resource-ready' });
    process.send({ type: 'ready', runtime, registryPath: run.registryPath, data: data.path, pid: lease.pid, identity: lease.identity, port: JSON.parse(fs.readFileSync(input.report)).port });
    const [request] = await once(process, 'message');
    if (request.type === 'finish-with-cleanup-failure') {
        let original;
        try { assert.fail('original assertion before owner disposal'); } catch (error) { original = error; }
        fs.chmodSync(data.path, 0o500);
        let permissionProbe;
        try { fs.unlinkSync(data.path + '/scenario'); }
        catch (error) { assert.equal(error.code, 'EACCES'); permissionProbe = error; }
        assert.ok(permissionProbe, 'read-only scenario unexpectedly allowed native unlink');
        const summary = await run.finish({ status: 'failed', error: original });
        fs.writeFileSync(input.root + '/failed-owner.json', JSON.stringify({ original: serializeFailure(original), permissionProbe: serializeFailure(permissionProbe), errors: summary.errors.map(error => serializeFailure(error)), resources: summary.resources }));
        await new Promise((resolve, reject) => process.send({ type: 'owner-finished', runtime, registryPath: run.registryPath }, error => error ? reject(error) : resolve()));
    } else await run.finish({ status: 'passed' });
    process.disconnect();
} else if (mode === 'recover') {
    const { recoverRuns } = await import('../resources/recovery.js');
    try {
        const report = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
        process.send({ type: 'recovered', runtime, report });
        process.disconnect();
    } catch (error) {
        const errorPath = input.root + '/recovery-error.json';
        fs.writeFileSync(errorPath, JSON.stringify(serializeFailure(error)));
        await new Promise((resolve, reject) => process.send({ type: 'recovery-failed', runtime, errorPath }, error => error ? reject(error) : resolve()));
        process.disconnect();
        throw error;
    }
} else {
    const dataDescriptor = input.dataFile ? fs.openSync(input.dataFile, 'r') : null;
    const server = http.createServer((request, response) => { response.end(input.dataFile ? fs.readFileSync(input.dataFile) : 'actual owned listener'); });
    server.listen(input.port ?? 0, '127.0.0.1');
    await once(server, 'listening');
    let watcher;
    if (mode === 'delayed-readiness' || mode === 'split-secret' || mode === 'ignore-term') watcher = fs.watch(path.dirname(input.release), (event, filename) => {
        if (filename !== path.basename(input.release)) return;
        watcher.close();
        if (mode === 'ignore-term') { server.close(); return; }
        if (mode === 'split-secret') process.stdout.write(process.env.RESOURCE_FIXTURE_SECRET.split('\n').slice(1).join('\n') + '\n');
        process.stdout.write('resource-ready\n');
    });
    if (mode === 'ignore-term') process.on('SIGTERM', () => { fs.writeFileSync(input.terminationObserved + '.tmp', 'actual SIGTERM observed'); fs.renameSync(input.terminationObserved + '.tmp', input.terminationObserved); });
    else process.once('SIGTERM', () => { watcher?.close(); server.close(); if (dataDescriptor !== null) fs.closeSync(dataDescriptor); });
    const report = { pid: process.pid, port: server.address().port, runtime, dataDescriptor, registration: input.registryPath && JSON.parse(fs.readFileSync(input.registryPath)) };
    if (input.report) { fs.writeFileSync(input.report + '.tmp', JSON.stringify(report)); fs.renameSync(input.report + '.tmp', input.report); }
    process.stdout.write(JSON.stringify({ listening: report }) + '\n');
    if (mode === 'split-secret') {
        await new Promise((resolve, reject) => process.stdout.write(process.env.RESOURCE_FIXTURE_SECRET.split('\n')[0] + '\n', error => error ? reject(error) : resolve()));
        if (input.failAfterPartialSecret) throw new Error('original startup failure after partial credential output');
        await fs.promises.writeFile(input.stage, 'actual first output fragment flushed');
    } else if (process.env.RESOURCE_FIXTURE_SECRET) process.stdout.write(process.env.RESOURCE_FIXTURE_SECRET + '\n');
    if (mode === 'startup-failure') throw new Error('original startup failure after listening');
    if (mode !== 'delayed-readiness' && mode !== 'split-secret') process.stdout.write('resource-ready\n');
}
