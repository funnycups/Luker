import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createRun } from '../resources/run.js';
import { launchOwnedProcess } from '../resources/process-owner.js';
import { serializeFailure } from '../resources/errors.js';

const input = JSON.parse(process.argv[2]);
const run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'policy-code-unit-boundary', command: [process.execPath, ...process.argv.slice(1)] });
const scope = await run.scope({ kind: 'scenario', label: 'ended policy owner' });
await scope.borrowDirectory(input.borrowed);
const data = await scope.directory('policy scenario');
fs.writeFileSync(data.path + '/scenario', 'complete policy scenario bytes');
run.recordError(new Error('prior non-native original', { cause: 'unchanged prefix' }));
const lease = await launchOwnedProcess(scope, { label: 'prior declaration healthy worker', command: [process.execPath, new URL('./resource-boundary-child.mjs', import.meta.url).pathname, 'capture', JSON.stringify({ report: input.report, marker: 'resource-ready' })], readyLine: 'resource-ready', sensitiveValues: ['\uFFFD'], dependsOn: [data.resourceId] });
await lease.stop();
let firstAcknowledgement;
const hook = createHook({ init(id, type) {
    if (!input.failure || firstAcknowledgement || !type.startsWith('FSREQ')) return;
    const stack = new Error('actual acknowledgement publication observation').stack;
    if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
    const bytes = fs.readFileSync(run.registryPath);
    const snapshot = JSON.parse(bytes);
    const failed = snapshot.resources.find(record => record.kind === 'process' && record.label === 'supplementary absent executable');
    if (failed?.terminal?.acknowledged) firstAcknowledgement = { bytes: bytes.toString('base64'), id, type, stack };
} });
hook.enable();
let nativeError;
if (input.failure) {
    try { await launchOwnedProcess(scope, { label: 'supplementary absent executable', command: [data.path + '/😀-missing'], readyLine: 'resource-ready', dependsOn: [data.resourceId] }); }
    catch (error) { nativeError = error; }
    assert.equal(nativeError.cause.code, 'ENOENT');
    assert.ok(firstAcknowledgement);
}
hook.disable();
await run.registry.closeAuthority();
run.registry.concludeWriter();
const bytes = fs.readFileSync(run.registryPath);
console.log(JSON.stringify({ runtime: { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') }, registryPath: run.registryPath, runId: run.runId, data: data.path, firstAcknowledgement, bytes: bytes.toString('base64'), nativeError: nativeError && serializeFailure(nativeError), resources: run.registry.resources }));
