import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createRun } from '../resources/run.js';
import { launchOwnedProcess } from '../resources/process-owner.js';
import { readProcessIdentity } from '../resources/native-identity.js';
import { serializeFailure, receiveFailureGraph, validateFailureGraph } from '../resources/errors.js';
import { processDiagnostics } from '../resources/process-diagnostics.js';
import { outcomeFixture, observeNativeStartup, settled, nodes, sha } from './process-native-control.mjs';

const childSource = new URL('./resource-boundary-child.mjs', import.meta.url).pathname;
const cases = [
    { name: 'prior environment declaration', prior: { MODE: 'test' }, missing: 'test-missing', declarations: [], expected: '[redacted]-missing' },
    { name: 'marker word', missing: 'redacted-missing', declarations: ['redacted'], expected: '[redacted]-missing' },
    { name: 'marker delimiter', missing: '[missing', declarations: ['['], expected: '[redacted]missing' },
    { name: 'overlapping declarations', missing: 'needle-long-missing', declarations: ['needle', 'needle-long'], expected: '[redacted]-missing' },
    { name: 'escaped non-ASCII declaration', missing: '钥匙\\\n-missing', declarations: ['钥匙\\\n'], expected: '[redacted]-missing' },
    { name: 'unchanged declaration control', missing: 'ordinary-missing', declarations: ['unrelated-private-value'], expected: 'ordinary-missing' },
];

for (const sample of cases) {
    test(`canonical redaction: actual native startup retains ${sample.name}`, async t => {
        const input = outcomeFixture(t);
        const run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'native-redaction-boundary', command: [process.execPath, '--test', 'harness/resource-recovery.test.mjs'] });
        t.after(() => run.finish({ status: 'failed' }));
        const scope = await run.scope({ kind: 'case', label: 'canonical native startup' });
        await scope.borrowDirectory(input.borrowed);
        const data = await scope.directory('native startup dependent data');
        fs.writeFileSync(data.path + '/scenario', 'retained redaction scenario');
        if (sample.prior) {
            const prior = await launchOwnedProcess(scope, { label: 'prior declaration', command: [process.execPath, childSource, 'capture', JSON.stringify({ report: input.report, marker: 'resource-ready' })], readyLine: 'resource-ready', env: sample.prior, dependsOn: [data.resourceId] });
            await prior.stop();
            assert.equal(await readProcessIdentity(prior.pid), null);
        }
        const observer = observeNativeStartup();
        t.after(() => observer.close());
        const result = await settled(launchOwnedProcess(scope, { label: 'real absent executable', command: [data.path + '/' + sample.missing], readyLine: 'resource-ready', sensitiveValues: sample.declarations, dependsOn: [data.resourceId] }));
        observer.close();
        const original = run.registry.errors.find(error => error.cause?.code === 'ENOENT');
        const originalBefore = serializeFailure(original);
        const record = run.registry.resources.filter(record => record.kind === 'process').at(-1);
        const terminalBytes = fs.readFileSync(record.terminal.path);
        const receipt = JSON.parse(terminalBytes);
        const before = JSON.parse(fs.readFileSync(run.registryPath));
        const controllerNative = await readProcessIdentity(record.locator.controller.native.pid);
        const summary = await run.finish({ status: 'failed' });
        const durable = JSON.parse(fs.readFileSync(run.registryPath));
        t.diagnostic(JSON.stringify({ canonicalStartup: { name: sample.name, declarationsSHA256: [...Object.values(sample.prior ?? {}), ...sample.declarations].map(sha), result: { status: result.status, error: serializeFailure(result.error) }, original: originalBefore, originalIdentity: summary.errors.includes(original), originalOccurrences: summary.errors.filter(error => error === original).length, events: observer.events, receipt, terminalSHA256: sha(terminalBytes), before, durable, controllerNative, dataAbsent: !fs.existsSync(data.path) } }));
        assert.equal(result.status, 'rejected');
        assert.ok(original, 'actual native ENOENT original is absent');
        assert.equal(result.error, original, 'valid redaction added an unrelated retention failure');
        assert.equal(summary.errors.filter(error => error === original).length, 1);
        assert.deepEqual(serializeFailure(original), originalBefore);
        assert.equal(controllerNative, null);
        assert.ok(record.locator.worker.exit);
        assert.match(record.terminal.acknowledged, /^[a-f0-9]{64}$/, 'complete retained native event was not acknowledged');
        assert.equal(record.state, 'disposed');
        assert.equal(fs.existsSync(data.path), false);
        const retained = nodes(receiveFailureGraph(durable.errors.find(error => error.event?.id === receipt.workerEvents[0].id))).find(node => node.type === 'error' && node.code === 'ENOENT' && node.properties?.some(entry => entry.name === 'errno'));
        assert.equal(retained.name, 'Error');
        assert.ok(retained.message.includes(sample.expected));
        assert.ok(retained.stack.includes('spawn'));
        assert.ok(retained.properties.length);
        for (const graph of durable.errors) validateFailureGraph(graph);
        for (const value of [...Object.values(sample.prior ?? {}), ...sample.declarations].filter(value => !'[redacted]'.includes(value))) assert.equal(retained.message.includes(value), false);
    });
}

test('canonical redaction: generated markers remain distinct from literal marker payload through repeated graph imports', () => {
    const original = new Error('secret redacted literal [redacted] payload', { cause: { marker: 'redacted', unicode: '钥匙\\\n', overlap: 'needle-long' } });
    original.alias = original.cause;
    original.self = original;
    original.event = { id: 'redacted', fingerprint: 'redacted' };
    const before = serializeFailure(original);
    const first = processDiagnostics({ sensitiveValues: ['secret', 'redacted', '钥匙\\\n', 'needle', 'needle-long'] }).failure(original);
    const second = processDiagnostics({ sensitiveValues: ['redacted', '[', 'literal'] }).failure(receiveFailureGraph(first));
    const third = processDiagnostics({ sensitiveValues: ['redacted', '[', 'literal'] }).failure(receiveFailureGraph(second));
    validateFailureGraph(first); validateFailureGraph(second); validateFailureGraph(third);
    assert.equal(first.message, '[redacted] [redacted] literal [[redacted]] payload');
    assert.equal(second.message, '[redacted] [redacted] [redacted] [redacted][redacted]] payload');
    assert.deepEqual(third, second, 'repeated import consumed generated replacement text');
    assert.equal(first.event, undefined);
    assert.equal(second.event, undefined);
    assert.equal(second.self, undefined);
    assert.deepEqual(serializeFailure(original), before);
});

test('canonical redaction: ordered declaration projection survives nested persisted graph imports without raw values', () => {
    const secret = 'private-钥匙\\\n';
    const original = new Error('prefix ' + secret + ' needle-long [redacted]', { cause: { [secret]: 'needle-long', bigint: 1234n, symbol: Symbol.for(secret), function: function payload() {} } });
    original.alias = original.cause;
    original.self = original;
    Object.defineProperty(original.cause, 'accessor', { get: function needle() { throw new Error('must not invoke accessor'); } });
    const before = serializeFailure(original);
    const initial = processDiagnostics({ sensitiveValues: [secret, 'needle'] });
    const first = initial.failure(original);
    const captured = initial.extend({ sensitiveValues: ['needle-long', 'redacted', '['] });
    const expected = JSON.parse(JSON.stringify(captured.failure(original)));
    const persisted = JSON.parse(JSON.stringify(first));
    const imported = captured.failure(receiveFailureGraph(persisted));
    assert.deepEqual(imported, expected, 'later overlapping declarations changed the meaning of an earlier projection');
    const policy = JSON.parse(JSON.stringify(captured.redaction));
    assert.equal(JSON.stringify(policy).includes(secret), false);
    const recovered = processDiagnostics({}, undefined, policy);
    assert.deepEqual(JSON.parse(JSON.stringify(recovered.failure(original))), expected);
    assert.deepEqual(recovered.failure(receiveFailureGraph(expected)), expected);
    const wrapper = new AggregateError([new Error('nested persisted graph', { cause: receiveFailureGraph(imported) })], 'complete persisted aggregate');
    wrapper.cause = wrapper.errors[0];
    const graph = recovered.failure(wrapper);
    validateFailureGraph(graph);
    assert.deepEqual(recovered.failure(receiveFailureGraph(JSON.parse(JSON.stringify(graph)))), graph);
    assert.equal(graph.errors[0].type, 'reference');
    assert.deepEqual(serializeFailure(original), before);
    assert.throws(() => processDiagnostics({}, undefined, [[{ length: 0, sha256: 'a'.repeat(64) }]]), /redaction policy/);
    assert.throws(() => processDiagnostics({}, undefined, { format: policy.format, layers: [[{ length: 0, sha256: 'a'.repeat(64) }]] }), /redaction policy/);
    const damaged = structuredClone(expected);
    damaged.redactions[0].ranges[0][0]++;
    assert.throws(() => receiveFailureGraph(damaged), /redaction range/);
    const lookalike = new Error('ordinary caller metadata', { cause: { type: 'error', redactions: [{ path: ['message'], ranges: [[0, 10]] }], message: secret } });
    const payload = captured.failure(lookalike);
    assert.equal(payload.cause.type, 'object');
    assert.ok(payload.cause.properties.some(entry => entry.name === 'redactions'));
    assert.ok(payload.cause.redactions.every(entry => entry.path[0] === 'properties'));
    assert.equal(JSON.stringify(payload).includes(secret), false);
});
