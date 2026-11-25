import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeRuntime, nativeSource } from './native-runtime.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const scratch = path.join(repository, 'test-results/resource-native-lifecycle');
const entry = new URL('../node.js', import.meta.url).href;
const sha = value => createHash('sha256').update(value).digest('hex');

function errorNodes(value) {
    if (value?.type !== 'error') return [];
    return [value, ...errorNodes(value.cause), ...(value.errors ?? []).flatMap(errorNodes)];
}

function fixture(t) {
    fs.mkdirSync(scratch, { recursive: true });
    assert.equal(fs.realpathSync(scratch), scratch);
    const root = fs.mkdtempSync(path.join(scratch, 'case-'));
    const identity = fs.lstatSync(root);
    for (const directory of ['project', 'borrowed']) fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, 'borrowed/original'), 'original borrowed bytes');
    t.after(() => {
        assert.equal(fs.realpathSync(root), root);
        assert.equal(fs.lstatSync(root).ino, identity.ino);
        assert.equal(fs.lstatSync(root).dev, identity.dev);
        assert.equal(fs.readFileSync(path.join(root, 'borrowed/original'), 'utf8'), 'original borrowed bytes');
        const inventory = directory => fs.readdirSync(directory, { withFileTypes: true }).map(item => {
            const target = path.join(directory, item.name);
            return item.isDirectory() ? { path: target, children: inventory(target) } : item.isSymbolicLink() ? { path: target, link: fs.readlinkSync(target) } : { path: target, bytes: fs.readFileSync(target).toString('base64') };
        });
        t.diagnostic(JSON.stringify({ beforeOuterTeardown: inventory(root), root, dev: identity.dev, ino: identity.ino }));
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    return { root, projectRoot: path.join(root, 'project'), borrowed: path.join(root, 'borrowed') };
}

async function consumer(t, input, source, args = []) {
    const runtimePath = path.join(input.root, 'runtime.json');
    source = nativeSource(source, runtimePath);
    const filename = path.join(input.root, 'lifecycle.test.mjs');
    fs.writeFileSync(filename, source, { flag: 'wx' });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const command = [process.execPath, '--test', ...args, filename];
    const child = spawn(command[0], command.slice(1), { cwd: path.join(repository, 'tests'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const outputPath = path.join(input.root, 'native-output.log');
    fs.writeFileSync(outputPath, '', { flag: 'wx' });
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', value => { output += value; fs.appendFileSync(outputPath, value); }); }
    const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    t.diagnostic(JSON.stringify({ native: { command, cwd: path.join(repository, 'tests'), runtime: nativeRuntime(runtimePath), source, sourceSHA256: sha(source), output, ...result } }));
    assert.equal(result.signal, null);
    return result;
}

for (const mode of ['later-success', 'later-failure', 'raw-child-later-success', 'raw-child-later-failure', 'body-later-failure']) {
    test(`native lifecycle ${mode} publishes only after the known owner's outcome`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { directoryProvider, registerProvider } from ${JSON.stringify(new URL('../resources/providers.js', import.meta.url).href)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const mode = ${JSON.stringify(mode)};
            const options = { projectRoot: input.projectRoot, profile: 'native-lifecycle', source: 'later-owner-hooks', command: [process.execPath, '--test'] };
            const hookEntered = Promise.withResolvers();
            const resourceClosed = Promise.withResolvers();
            const independentPeer = Promise.withResolvers();
            const hookError = new Error('original later owner hook error');
            const bodyError = new Error('original lifecycle body error');
            const rawError = new Error('original lifecycle raw child error');
            const receipt = { releases: 0, hookSettled: false, originals: [hookError, bodyError, rawError].map(error => serializeFailure(error)) };
            const save = () => fs.writeFileSync(input.root + '/receipt.json', JSON.stringify(receipt));
            const provider = { kind: 'lifecycle-directory', allocate: directoryProvider.allocate, async dispose(record) {
                receipt.releases++;
                await directoryProvider.dispose(record);
                resourceClosed.resolve();
                save();
            } };
            registerProvider(provider);
            nativeTest('actual lifecycle ancestor', { concurrency: true }, async ancestor => {
                let owner;
                ancestor.beforeEach(actual => {
                    if (actual.name !== 'known lifecycle owner') return;
                    if (!owner) { owner = actual; return; }
                    if (actual === owner || receipt.hookInstalled) return;
                    receipt.hookInstalled = true;
                    owner.after(async () => {
                        receipt.atHookEntrance = { passed: owner.passed, error: serializeFailure(owner.error), aborted: owner.signal.aborted };
                        save();
                        hookEntered.resolve();
                        await independentPeer.promise;
                        receipt.hookSettled = true;
                        save();
                        if (mode.endsWith('failure')) throw hookError;
                    });
                });
                const completion = managed.test('known lifecycle owner', options, async (context, scope, run) => {
                    await scope.borrowDirectory(input.borrowed);
                    const owned = await scope.acquire({ ...provider, label: 'lifecycle payload' });
                    fs.symlinkSync(input.borrowed, owned.path + '/borrowed-link');
                    const descriptor = fs.openSync(owned.path + '/payload', 'w');
                    fs.writeSync(descriptor, 'actual lifecycle payload');
                    fs.closeSync(descriptor);
                    receipt.allocation = { path: owned.path, registryPath: run.registryPath };
                    save();
                    if (mode.startsWith('raw-child-')) context.test('raw lifecycle failure', raw => {
                        raw.signal.addEventListener('abort', () => { receipt.rawNativeOutcome = serializeFailure(raw.error); save(); }, { once: true });
                        throw rawError;
                    });
                    if (mode.startsWith('body-')) throw bodyError;
                });
                completion.then(summary => {
                    receipt.completion = { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)), hookSettled: receipt.hookSettled, aborted: owner.signal.aborted, ownerError: serializeFailure(owner.error) };
                    save();
                }, error => { receipt.rejection = serializeFailure(error); save(); });
                const peer = managed.test('actual concurrent lifecycle peer', options, async (context, scope, run) => {
                    await hookEntered.promise;
                    await resourceClosed.promise;
                    const owned = await scope.directory('independent concurrent peer');
                    fs.writeFileSync(owned.path + '/peer', 'actual independent peer');
                    receipt.peer = { path: owned.path, registryPath: run.registryPath };
                    save();
                });
                await peer;
                receipt.beforeRelease = { completion: receipt.completion, status: JSON.parse(fs.readFileSync(receipt.allocation.registryPath)).status, payloadPresent: fs.existsSync(receipt.allocation.path) };
                independentPeer.resolve();
                await completion;
                receipt.ancestorContinued = true;
                save();
            });
        `);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'receipt.json')));
        t.diagnostic(JSON.stringify({ mode, receipt }));
        const passed = mode === 'later-success';
        assert.equal(result.code, passed ? 0 : 1);
        assert.equal(receipt.beforeRelease.completion, undefined, 'managed result was published while the later native owner hook was pending');
        assert.equal(receipt.beforeRelease.status, 'running');
        assert.equal(receipt.beforeRelease.payloadPresent, false);
        assert.equal(receipt.completion.hookSettled, true);
        assert.equal(receipt.completion.aborted, true);
        assert.equal(receipt.completion.status, passed ? 'passed' : 'failed');
        assert.equal(receipt.ancestorContinued, true);
        assert.equal(receipt.releases, 1);
        const durable = JSON.parse(fs.readFileSync(receipt.allocation.registryPath));
        assert.equal(durable.status, passed ? 'passed' : 'failed');
        assert.deepEqual(durable.errors, receipt.completion.errors);
        if (mode.endsWith('failure')) assert.ok(JSON.stringify(durable.errors).includes('original later owner hook error'));
        if (mode.startsWith('body-')) assert.ok(JSON.stringify(durable.errors).includes('original lifecycle body error'));
        const nodes = durable.errors.flatMap(errorNodes);
        if (mode.endsWith('failure')) assert.equal(nodes.filter(error => error.stack === receipt.originals[0].stack && error.message === receipt.originals[0].message).length, 1);
        if (mode.startsWith('body-')) assert.equal(nodes.filter(error => error.stack === receipt.originals[1].stack && error.message === receipt.originals[1].message).length, 1);
        if (mode.startsWith('raw-child-')) assert.ok(errorNodes(receipt.rawNativeOutcome).some(error => error.stack === receipt.originals[2].stack && error.message === receipt.originals[2].message));
        for (const allocation of [receipt.allocation, receipt.peer]) {
            assert.equal(fs.existsSync(allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
        }
        assert.equal(JSON.parse(fs.readFileSync(receipt.peer.registryPath)).status, 'passed');
    });
}

test('native lifecycle selected ancestor observes an omitted root without joining module finalization', async t => {
    const input = fixture(t);
    const result = await consumer(t, input, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { test as nativeTest, after } from 'node:test';
        import * as managed from ${JSON.stringify(entry)};
        const input = ${JSON.stringify(input)};
        const options = { projectRoot: input.projectRoot, profile: 'omission', source: 'nonblocking-root-observation', command: [process.execPath, '--test'] };
        const receipt = {};
        let observation;
        nativeTest('selected observation ancestor', async () => {
            observation = managed.test('omitted observation root', options, () => { assert.fail('omitted body executed'); });
            observation.then(value => { receipt.observationUndefined = value === undefined; });
            receipt.ancestorContinued = true;
        });
        nativeTest('actual omission peer', () => { receipt.peerCompleted = true; });
        after(async () => {
            await observation;
            assert.deepEqual(fs.readdirSync(input.projectRoot), []);
            fs.writeFileSync(input.root + '/omission.json', JSON.stringify(receipt));
        });
    `, ['--test-skip-pattern=omitted observation root']);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(input.root, 'omission.json'))), { ancestorContinued: true, peerCompleted: true, observationUndefined: true });
    assert.deepEqual(fs.readdirSync(input.projectRoot), []);
});

for (const cancelled of [false, true]) {
    test(`native lifecycle ${cancelled ? 'early cancellation' : 'earlier hook failure'} retains sticky failure with independent release`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import fs from 'node:fs';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { directoryProvider, registerProvider } from ${JSON.stringify(new URL('../resources/providers.js', import.meta.url).href)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const cancelled = ${JSON.stringify(cancelled)};
            const options = { projectRoot: input.projectRoot, profile: 'sticky-native-failure', source: 'independent-native-release', command: [process.execPath, '--test'] };
            const controller = new AbortController();
            const hookEntered = Promise.withResolvers();
            const resourceClosed = Promise.withResolvers();
            const declared = Promise.withResolvers();
            const release = Promise.withResolvers();
            const original = new Error('original independently released native failure');
            const receipt = { original: serializeFailure(original), releases: 0 };
            const save = () => fs.writeFileSync(input.root + '/sticky.json', JSON.stringify(receipt));
            const stickyProvider = { kind: 'sticky-directory', allocate: directoryProvider.allocate, async dispose(record) { receipt.releases++; await directoryProvider.dispose(record); resourceClosed.resolve(); } };
            registerProvider(stickyProvider);
            let completion;
            nativeTest('independent lifecycle coordinator', { concurrency: true }, async coordinator => {
                const peer = managed.test('independent sticky peer', options, async (context, scope, run) => {
                    await declared.promise;
                    await hookEntered.promise;
                    await resourceClosed.promise;
                    const owned = await scope.directory('sticky independent peer');
                    receipt.peer = { path: owned.path, registryPath: run.registryPath }; save();
                });
                coordinator.test('actual cancellable ancestor', { signal: controller.signal }, async ancestor => {
                    let owner;
                    ancestor.beforeEach(actual => {
                        if (owner) return;
                        owner = actual;
                        owner.after(async () => {
                            receipt.hookEntered = true; save(); hookEntered.resolve();
                            if (!cancelled) throw original;
                            await release.promise;
                            receipt.hookSettled = true; save();
                        });
                    });
                    completion = managed.test('actual sticky owner', options, async (context, scope, run) => {
                        await scope.borrowDirectory(input.borrowed);
                        const owned = await scope.acquire({ ...stickyProvider, label: 'sticky payload' });
                        receipt.allocation = { path: owned.path, registryPath: run.registryPath }; save();
                    });
                    completion.then(summary => { receipt.completion = { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)), owner: { passed: owner.passed, error: serializeFailure(owner.error) }, nativeAncestorError: serializeFailure(ancestor.error) }; save(); });
                    declared.resolve();
                    await completion;
                    receipt.ancestorContinued = true; save();
                });
                await declared.promise;
                await hookEntered.promise;
                if (cancelled) controller.abort(original);
                await peer;
                receipt.beforeRelease = { completion: receipt.completion, payloadPresent: fs.existsSync(receipt.allocation.path) }; save();
                release.resolve();
                await completion;
            });
        `);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'sticky.json')));
        t.diagnostic(JSON.stringify({ cancelled, receipt }));
        assert.equal(result.code, 1);
        assert.equal(receipt.completion.status, 'failed');
        assert.equal(receipt.completion.owner.passed, false);
        assert.equal(receipt.beforeRelease.payloadPresent, false);
        if (receipt.beforeRelease.completion) assert.equal(receipt.beforeRelease.completion.status, 'failed');
        if (cancelled) {
            assert.equal(receipt.hookSettled, true);
            assert.equal(receipt.completion.nativeAncestorError.stack, receipt.original.stack);
        } else assert.ok(JSON.stringify(receipt.completion.errors).includes(receipt.original.message));
        assert.equal(receipt.releases, 1);
        for (const allocation of [receipt.allocation, receipt.peer]) {
            assert.equal(fs.existsSync(allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
        }
        assert.equal(JSON.parse(fs.readFileSync(receipt.allocation.registryPath)).status, 'failed');
        assert.equal(JSON.parse(fs.readFileSync(receipt.peer.registryPath)).status, 'passed');
    });
}
