import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { processDiagnostics } from '../resources/process-diagnostics.js';
import { receiveFailureGraph, serializeFailure } from '../resources/errors.js';
import { recoverRuns } from '../resources/recovery.js';
import { readProcessIdentity } from '../resources/native-identity.js';
import { outcomeFixture, inventory, sha, nodes, settled } from './process-native-control.mjs';

const childSource = new URL('./resource-policy-child.mjs', import.meta.url).pathname;
const samples = [
    { name: 'replacement versus supplementary', secret: '\uFFFD', value: 'a😀😁b', expected: 'a😀😁b' },
    { name: 'declared supplementary', secret: '😀', value: 'a😀😁b', expected: 'a[redacted]😁b' },
    { name: 'isolated high code unit', secret: '\uD83D', value: 'a😀\uD83D\uFFFDb', expected: 'a[redacted]\uDE00[redacted]\uFFFDb' },
    { name: 'isolated low code unit', secret: '\uDE00', value: 'a😀\uDE00\uFFFDb', expected: 'a\uD83D[redacted][redacted]\uFFFDb' },
    { name: 'replacement literal', secret: '\uFFFD', value: 'a\uFFFD😀b', expected: 'a[redacted]😀b' },
    { name: 'escaped code unit', secret: '\uD83D', value: 'a\\ud83d 😀b', expected: 'a[redacted] [redacted]\uDE00b' },
];
for (const sample of samples) {
    test(`policy equality: ${sample.name} preserves exact code units through persisted matching`, () => {
        const live = processDiagnostics({ sensitiveValues: [sample.secret] });
        const policy = JSON.parse(JSON.stringify(live.redaction));
        const original = new Error(sample.value, { cause: { [sample.value]: sample.value } });
        original.alias = original.cause;
        original.self = original;
        const before = serializeFailure(original);
        const expected = live.failure(original);
        assert.equal(expected.message, sample.expected);
        const replay = processDiagnostics({}, undefined, policy);
        const actual = replay.failure(original);
        assert.equal(actual.message, sample.expected);
        assert.deepEqual(actual, expected);
        assert.deepEqual(replay.failure(receiveFailureGraph(JSON.parse(JSON.stringify(expected)))), JSON.parse(JSON.stringify(expected)));
        assert.deepEqual(serializeFailure(original), before);
    });
}

test('policy admission: validates complete JSON types and tagged encoding without coercion', () => {
    const captured = processDiagnostics({ sensitiveValues: ['private declaration'] }).redaction;
    const rules = policy => policy.layers ?? policy;
    const changes = [
        policy => { rules(policy)[0][0].sha256 = [rules(policy)[0][0].sha256]; },
        policy => { rules(policy)[0][0].sha256 = { digest: rules(policy)[0][0].sha256 }; },
        policy => { rules(policy)[0][0].sha256 = null; },
        policy => { rules(policy)[0][0].sha256 = 'A'.repeat(64); },
        policy => { rules(policy)[0][0].length = '19'; },
        policy => { rules(policy)[0][0].length = 0; },
        policy => { rules(policy)[0][0].length = -1; },
        policy => { rules(policy)[0][0].length = 1.5; },
        policy => { rules(policy)[0][0].length = Number.MAX_SAFE_INTEGER + 1; },
        policy => { rules(policy)[0][0].other = true; },
        policy => { rules(policy)[0][0] = []; },
        policy => { rules(policy)[0] = {}; },
        policy => { rules(policy)[0] = []; },
    ];
    for (const change of changes) {
        const policy = structuredClone(captured);
        change(policy);
        assert.throws(() => processDiagnostics({}, undefined, policy), /redaction policy/, JSON.stringify(policy));
    }
    assert.equal(captured.format, 'literal-utf16le-sha256-v1');
    for (const policy of [null, [], {}, { ...captured, format: 'utf8' }, { ...captured, extra: true }, { ...captured, layers: {} }]) assert.throws(() => processDiagnostics({}, undefined, policy), /redaction policy/);
    assert.equal(JSON.stringify(captured).includes('private declaration'), false);
});

async function endedOwner(t, failure) {
    const input = outcomeFixture(t);
    const argv = [process.execPath, childSource, JSON.stringify({ ...input, failure })];
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    t.diagnostic(JSON.stringify({ policyOwner: { argv, sourceSHA256: sha(fs.readFileSync(childSource)), exit, stdout, stderr } }));
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(stderr, '');
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.runtime.version, process.version); assert.equal(receipt.runtime.execPath, process.execPath);
    assert.equal(await readProcessIdentity(child.pid), null);
    for (const record of receipt.resources.filter(record => record.kind === 'process')) {
        assert.equal(await readProcessIdentity(record.locator.controller.native.pid), null);
        assert.ok(record.locator.worker.exit);
    }
    if (failure) fs.writeFileSync(receipt.registryPath, Buffer.from(receipt.firstAcknowledgement.bytes, 'base64'));
    return { ...input, ...receipt };
}

test('policy equality: real native supplementary ENOENT and unchanged ended-owner prefix survive U+FFFD declaration', async t => {
    const input = await endedOwner(t, true);
    const before = JSON.parse(fs.readFileSync(input.registryPath));
    const native = nodes(before.errors).find(node => node.type === 'error' && node.code === 'ENOENT' && node.properties?.some(entry => entry.name === 'errno'));
    assert.ok(native.message.includes('/😀-missing'));
    assert.ok(!native.message.includes('[redacted]'));
    const prefix = JSON.stringify(before.errors);
    const result = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] });
    const after = JSON.parse(fs.readFileSync(input.registryPath));
    t.diagnostic(JSON.stringify({ policyRecovery: { before, after, result, firstAcknowledgement: input.firstAcknowledgement } }));
    assert.deepEqual(result.recovered, [input.runId]);
    assert.equal(JSON.stringify(after.errors.slice(0, before.errors.length)), prefix);
    assert.equal(fs.existsSync(input.data), false);
});

test('policy equality: changed unrelated supplementary complete cause refuses acknowledged recovery', async t => {
    const input = await endedOwner(t, true);
    const snapshot = JSON.parse(fs.readFileSync(input.registryPath));
    const native = nodes(snapshot.errors).find(node => node.type === 'error' && node.code === 'ENOENT' && node.properties?.some(entry => entry.name === 'errno'));
    assert.ok(native.message.includes('😀'));
    native.message = native.message.replace('😀', '😁');
    fs.writeFileSync(input.registryPath, JSON.stringify(snapshot, null, 2) + '\n');
    const prefix = JSON.stringify(snapshot.errors);
    const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
    t.diagnostic(JSON.stringify({ policyChangedCause: { result: result.status, error: result.error && serializeFailure(result.error), snapshot } }));
    assert.equal(result.status, 'rejected');
    assert.match(result.error.message, /complete|retained|original/i);
    assert.equal(fs.readFileSync(input.data + '/scenario', 'utf8'), 'complete policy scenario bytes');
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(input.registryPath)).errors.slice(0, snapshot.errors.length)), prefix);
});

for (const mode of ['array digest', 'unavailable', 'ambiguous encoding', 'valid sibling']) {
    test(`policy admission: actual ended healthy owner ${mode} preserves exact refusal inventory`, async t => {
        const input = await endedOwner(t, false);
        const snapshot = JSON.parse(fs.readFileSync(input.registryPath));
        if (mode === 'array digest') { const rules = snapshot.redaction.layers ?? snapshot.redaction; rules[0][0].sha256 = [rules[0][0].sha256]; }
        if (mode === 'unavailable') delete snapshot.redaction;
        if (mode === 'ambiguous encoding') snapshot.redaction = snapshot.redaction.layers ?? snapshot.redaction;
        fs.writeFileSync(input.registryPath, JSON.stringify(snapshot, null, 2) + '\n');
        const before = inventory(input.root);
        const bytes = fs.readFileSync(input.registryPath);
        const result = await settled(recoverRuns({ projectRoot: input.projectRoot, profiles: ['unit'] }));
        t.diagnostic(JSON.stringify({ policyAdmission: { mode, result: result.status, error: result.error && serializeFailure(result.error), bytes: bytes.toString('base64'), before, after: inventory(input.root) } }));
        if (mode === 'valid sibling') {
            assert.equal(result.status, 'fulfilled');
            assert.deepEqual(result.value.recovered, [input.runId]);
            assert.equal(fs.existsSync(input.data), false);
        } else {
            assert.equal(result.status, 'rejected');
            assert.match(result.error.message, /diagnostic.*(?:redaction )?policy/i);
            assert.ok(result.error.message.includes(input.runId));
            assert.deepEqual(fs.readFileSync(input.registryPath), bytes);
            assert.deepEqual(inventory(input.root), before);
            assert.equal(fs.readFileSync(input.data + '/scenario', 'utf8'), 'complete policy scenario bytes');
        }
    });
}
