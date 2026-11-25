import assert from 'node:assert/strict';
import { property, fields } from './failure-graph.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nativeRuntime, nativeSource } from './native-runtime.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const scratch = path.join(repository, 'test-results/resource-native-registration');
const entry = new URL('../node.js', import.meta.url).href;
const reporter = fileURLToPath(new URL('./native-diagnostics-reporter.mjs', import.meta.url));
const borrowedBytes = Buffer.from('native registration borrowed data\n\0\xff', 'latin1');
const sha = value => createHash('sha256').update(value).digest('hex');

function inventory(root) {
    return fs.readdirSync(root, { withFileTypes: true }).map(entry => {
        const location = path.join(root, entry.name);
        const stat = fs.lstatSync(location);
        const record = { name: entry.name, dev: stat.dev, ino: stat.ino };
        if (entry.isDirectory()) record.children = inventory(location);
        else if (entry.isSymbolicLink()) record.link = fs.readlinkSync(location);
        else {
            const data = fs.readFileSync(location);
            record.sha256 = sha(data);
            if (entry.name.endsWith('.json')) record.content = JSON.parse(data);
        }
        return record;
    });
}

function fixture(t) {
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    assert.equal(fs.realpathSync(path.dirname(scratch)), path.dirname(scratch));
    fs.mkdirSync(scratch, { recursive: true });
    assert.equal(fs.realpathSync(scratch), scratch);
    const root = fs.mkdtempSync(path.join(scratch, 'case-'));
    const identity = fs.lstatSync(root);
    const projectRoot = path.join(root, 'project');
    const borrowed = path.join(root, 'borrowed');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(borrowed);
    fs.writeFileSync(path.join(borrowed, 'original'), borrowedBytes);
    t.after(() => {
        const actual = fs.lstatSync(root);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        assert.equal(fs.realpathSync(root), root);
        assert.deepEqual(fs.readFileSync(path.join(borrowed, 'original')), borrowedBytes);
        t.diagnostic(JSON.stringify({ fixture: root, dev: actual.dev, ino: actual.ino, borrowedSHA256: sha(borrowedBytes), beforeOuterTeardown: inventory(root) }));
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    return { root, projectRoot, borrowed };
}

async function consumer(t, input, source, arguments_ = []) {
    const runtimePath = path.join(input.root, 'runtime.json');
    source = nativeSource(source, runtimePath);
    const filename = path.join(input.root, 'native-registration.test.mjs');
    fs.writeFileSync(filename, source, { flag: 'wx' });
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const command = [process.execPath, '--test', `--test-reporter=${reporter}`, ...arguments_, filename];
    const child = spawn(command[0], command.slice(1), { cwd: path.join(repository, 'tests'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const completion = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    fs.writeFileSync(path.join(input.root, 'native-output.log'), stdout + stderr);
    const runtime = nativeRuntime(runtimePath);
    const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    t.diagnostic(JSON.stringify({ native: { command, cwd: path.join(repository, 'tests'), runtime, source, sourceSHA256: sha(source), stdout, stderr, events, ...completion } }));
    assert.equal(completion.signal, null);
    assert.equal(stderr, '');
    return { ...completion, events };
}

function errorNodes(error) {
    if (error?.type !== 'error') return [];
    return [error, ...(error.errors ?? []).flatMap(errorNodes), ...errorNodes(error.cause)];
}

for (const mode of ['passed', 'raw-pre-aborted', 'managed-pre-aborted', 'managed-skipped-pre-aborted', 'managed-live-abort', 'managed-live-abort-resolved', 'raw-errors']) {
    test(`Fix3 native ${mode} preserves outcome and registered payload lifetime`, async t => {
        const input = fixture(t);
        const options = { projectRoot: input.projectRoot, profile: 'native-registration', command: [process.execPath, '--test', 'harness/resource-scope.test.mjs'], source: 'exact-owned-native-registration' };
        const result = await consumer(t, input, `
            import fs from 'node:fs';
            import assert from 'node:assert/strict';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const options = ${JSON.stringify(options)};
            const mode = ${JSON.stringify(mode)};
            const callbacks = [];
            const allocations = [];
            const originals = [];
            function save() { fs.writeFileSync(input.root + '/receipts.json', JSON.stringify({ callbacks, allocations, originals })); }
            function original(message) {
                const error = new Error(message);
                originals.push({ name: error.name, message: error.message, stack: error.stack });
                save();
                return error;
            }
            let context;
            const completion = managed.test('managed caller', options, async function (t, scope, run) {
                assert.equal(this, t);
                context = t;
                await scope.borrowDirectory(input.borrowed);
                const owned = await scope.directory(mode);
                fs.writeFileSync(owned.path + '/payload', 'actual managed caller payload');
                allocations.push({ label: 'caller', path: owned.path, registryPath: run.registryPath });
                callbacks.push('parent');
                save();
                if (mode === 'raw-pre-aborted') {
                    const reason = original('original child cancellation');
                    await t.test('cancelled child', { signal: AbortSignal.abort(reason) }, () => {});
                }
                if (mode === 'managed-pre-aborted' || mode === 'managed-skipped-pre-aborted') {
                    const reason = original('original child cancellation');
                    const value = await managed.subtest(t, 'cancelled child', { signal: AbortSignal.abort(reason), skip: mode === 'managed-skipped-pre-aborted' }, () => { callbacks.push('cancelled child'); save(); });
                    assert.equal(value, undefined);
                }
                if (mode === 'managed-live-abort' || mode === 'managed-live-abort-resolved') {
                    const controller = new AbortController();
                    const entered = Promise.withResolvers();
                    const reason = original('original live child cancellation');
                    const child = managed.subtest(t, 'live cancelled child', { signal: controller.signal }, async function (childContext) {
                        assert.equal(this, childContext);
                        callbacks.push('live child');
                        save();
                        const aborted = new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => {
                            callbacks.push('child observed abort');
                            save();
                             if (mode === 'managed-live-abort-resolved') resolve();
                             else reject(controller.signal.reason);
                        }, { once: true }));
                        entered.resolve();
                        await aborted;
                    });
                    await entered.promise;
                    controller.abort(reason);
                    assert.equal(await child, undefined);
                }
                if (mode === 'raw-errors') {
                    t.after(() => { callbacks.push('raw hook'); save(); throw original('raw discarded hook failure'); });
                    await t.test('raw failing child', () => { callbacks.push('raw child'); save(); throw original('raw child failure'); });
                    throw original('raw body failure');
                }
                callbacks.push('continued');
                save();
            });
            completion.then(summary => {
                fs.writeFileSync(input.root + '/completion.json', JSON.stringify({
                    result: summary === undefined ? { type: 'undefined' } : { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)), resources: summary.resources },
                    native: context === undefined ? null : { passed: context.passed, error: serializeFailure(context.error) },
                }));
            });
            managed.test('ordinary peer', options, async (t, scope, run) => {
                const owned = await scope.directory('peer');
                fs.writeFileSync(owned.path + '/payload', 'actual peer payload');
                allocations.push({ label: 'peer', path: owned.path, registryPath: run.registryPath });
                callbacks.push('peer');
                save();
            });
        `);
        assert.equal(result.code, mode === 'passed' ? 0 : 1);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'receipts.json')));
        const completion = JSON.parse(fs.readFileSync(path.join(input.root, 'completion.json')));
        assert.deepEqual(receipt.allocations.map(item => item.label), ['caller', 'peer']);
        const [caller, peer] = receipt.allocations;
        for (const allocation of receipt.allocations) {
            assert.equal(fs.existsSync(allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
        }
        const durable = JSON.parse(fs.readFileSync(caller.registryPath));
        assert.equal(durable.status, mode === 'passed' ? 'passed' : 'failed');
        assert.equal(completion.result.status, durable.status);
        assert.equal(completion.native.passed, mode === 'passed');
        assert.deepEqual(completion.result.errors, durable.errors);
        assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
        const managedErrors = durable.errors.flatMap(errorNodes);
        const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
        for (const original of receipt.originals) {
            if (original.message === 'raw discarded hook failure') {
                assert.ok(receipt.callbacks.includes('raw hook'));
                assert.equal(managedErrors.some(error => error.message === original.message), false);
                assert.equal(nativeErrors.some(error => error.message === original.message), false);
                continue;
            }
            // Callback-less originals are native diagnostic evidence, not an invented child receipt.
            const recorded = (mode.startsWith('raw-') || mode === 'managed-pre-aborted' || mode === 'managed-skipped-pre-aborted' ? nativeErrors : managedErrors).find(error => error.message === original.message && error.stack === original.stack);
            assert.ok(recorded, original.message);
            assert.equal(recorded.name, original.name);
            assert.equal(recorded.stack, original.stack);
        }
        if (mode === 'raw-pre-aborted') assert.deepEqual(durable.errors, [completion.native.error]);
        if (mode === 'managed-pre-aborted') assert.equal(receipt.callbacks.includes('cancelled child'), false);
        if (mode === 'managed-skipped-pre-aborted') assert.equal(receipt.callbacks.includes('cancelled child'), false);
        if (mode === 'managed-live-abort' || mode === 'managed-live-abort-resolved') assert.ok(receipt.callbacks.includes('live child') && receipt.callbacks.includes('child observed abort'));
        if (mode !== 'raw-errors') assert.ok(receipt.callbacks.includes('continued'));
        t.diagnostic(JSON.stringify({ mode, receipt, completion, durable, nativeFailureEvidence: nativeErrors }));
    });
}

test('Fix3 unsupported native registration input allocates no run resources', async t => {
    const input = fixture(t);
    const result = await consumer(t, input, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { test as nativeTest } from 'node:test';
        import * as managed from ${JSON.stringify(entry)};
        const projectRoot = ${JSON.stringify(input.projectRoot)};
        const options = { projectRoot, profile: 'unsupported-input', source: 'actual-native-input', command: [process.execPath, '--test'] };
        for (const callback of [null, function (context, scope, run, done) {}]) {
            assert.throws(() => managed.test('unsupported', options, callback), TypeError);
        }
        assert.deepEqual(fs.readdirSync(projectRoot), []);
        nativeTest('real unmanaged context', context => {
            assert.throws(() => managed.after(context, () => {}), TypeError);
            assert.throws(() => managed.subtest(context, 'unsupported child', {}, () => {}), TypeError);
            assert.deepEqual(fs.readdirSync(projectRoot), []);
        });
    `);
    assert.equal(result.code, 0);
    assert.deepEqual(fs.readdirSync(input.projectRoot), []);
});

test('Fix4 native filtering can omit only the inner body without admitting a run', async t => {
    const input = fixture(t);
    const result = await consumer(t, input, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import * as managed from ${JSON.stringify(entry)};
        const input = ${JSON.stringify(input)};
        const options = { projectRoot: input.projectRoot, profile: 'native-inner-selection', source: 'actual-native-body-filter', command: [process.execPath, '--test'] };
        managed.test('inner omission', options, () => {
            fs.writeFileSync(input.root + '/unexpected-body', 'body must remain unselected');
        }).then(value => {
            assert.equal(value, undefined);
            fs.writeFileSync(input.root + '/completion.json', JSON.stringify({ type: 'undefined' }));
        });
        managed.test('ordinary selection peer', options, async (context, scope, run) => {
            const owned = await scope.directory('selected peer');
            fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
        });
    `, ['--test-skip-pattern=^inner omission inner omission$']);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(input.root, 'completion.json'))), { type: 'undefined' });
    assert.equal(fs.existsSync(path.join(input.root, 'unexpected-body')), false);
    const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
    const runs = path.dirname(path.dirname(peer.registryPath));
    assert.deepEqual(fs.readdirSync(runs), [path.basename(path.dirname(peer.registryPath))]);
    assert.equal(fs.existsSync(peer.path), false);
    assert.deepEqual(fs.readdirSync(path.dirname(peer.path)), []);
    assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
});

for (const mode of ['rejected-options', 'late-abort', 'skipped-late-abort', 'filtered-late-abort', 'filtered-pre-aborted', 'todo-executed', 'only-omitted', 'skipped-late-abort-failed-parent', 'filtered-pre-aborted-failed-parent']) {
    test(`Fix3 native ${mode} records only admitted failures`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { test as nativeTest } from 'node:test';
            import { getEventListeners } from 'node:events';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const mode = ${JSON.stringify(mode)};
            const options = { projectRoot: input.projectRoot, profile: 'native-registration-state', source: 'registered-state-fixture', command: [process.execPath, '--test'] };
            function register() {
            const completion = managed.test('admitted caller', options, async (context, scope, run) => {
                await scope.borrowDirectory(input.borrowed);
                const owned = await scope.directory(mode);
                fs.writeFileSync(owned.path + '/payload', 'actual admission-state payload');
                fs.writeFileSync(input.root + '/allocation.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
                if (mode === 'rejected-options') {
                    assert.throws(() => managed.after(context, function (actual, done) {}), TypeError);
                    assert.throws(() => managed.subtest(context, 'unsupported callback', function (actual, done) {}), TypeError);
                    const reason = new Error('unadmitted cancellation reason');
                    assert.throws(() => managed.subtest(context, 'unadmitted child', { concurrency: 'invalid', signal: AbortSignal.abort(reason) }, () => {
                        fs.writeFileSync(input.root + '/unexpected-child', 'must not execute');
                    }), { code: 'ERR_INVALID_ARG_TYPE' });
                    assert.throws(() => managed.subtest(context, 'invalid signal', { signal: {} }, () => {}), { code: 'ERR_INVALID_ARG_TYPE' });
                } else if (mode === 'late-abort') {
                    const controller = new AbortController();
                    const finished = Promise.withResolvers();
                    managed.subtest(context, 'completed child', { signal: controller.signal }, child => {
                        child.signal.addEventListener('abort', finished.resolve, { once: true });
                    });
                    await finished.promise;
                    controller.abort(new Error('unused reason after child completion'));
                } else {
                    const controller = new AbortController();
                    if (mode.includes('pre-aborted')) controller.abort(new Error('unused already-aborted filtered signal'));
                    const nativeOptions = { signal: controller.signal };
                    if (mode.startsWith('skipped-')) nativeOptions.skip = true;
                    if (mode === 'todo-executed') nativeOptions.todo = true;
                    if (mode === 'only-omitted') context.runOnly(true);
                    const execution = managed.subtest(context, 'unused child', nativeOptions, function (actual) {
                        assert.equal(this, actual);
                        if (mode !== 'todo-executed') fs.writeFileSync(input.root + '/unexpected-child', 'must not execute');
                    });
                    fs.writeFileSync(input.root + '/native-return.json', JSON.stringify({ type: execution === undefined ? 'undefined' : 'promise', result: await execution }));
                    managed.after(context, function (actual) {
                        assert.equal(this, actual);
                        assert.equal(actual, context);
                        assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
                        controller.abort(new Error('unused signal after omitted child completion'));
                        if (mode.endsWith('failed-parent')) {
                            const error = new Error('original unrelated parent hook failure');
                            fs.writeFileSync(input.root + '/original-hook.json', JSON.stringify(serializeFailure(error)));
                            throw error;
                        }
                    });
                }
            });
            completion.then(summary => fs.writeFileSync(input.root + '/completion.json', JSON.stringify({ status: summary.status, errors: summary.errors.map(error => serializeFailure(error)) })));
            }
            if (mode === 'only-omitted') nativeTest('selected native owner', { only: true }, register);
            else register();
        `, mode.startsWith('filtered-') ? ['--test-skip-pattern=unused child'] : mode === 'only-omitted' ? ['--test-only'] : []);
        assert.equal(result.code, mode.endsWith('failed-parent') ? 1 : 0);
        const allocation = JSON.parse(fs.readFileSync(path.join(input.root, 'allocation.json')));
        const completion = JSON.parse(fs.readFileSync(path.join(input.root, 'completion.json')));
        const durable = JSON.parse(fs.readFileSync(allocation.registryPath));
        assert.equal(fs.existsSync(allocation.path), false);
        assert.equal(fs.existsSync(path.join(input.root, 'unexpected-child')), false);
        if (mode.endsWith('failed-parent')) {
            const original = JSON.parse(fs.readFileSync(path.join(input.root, 'original-hook.json')));
            assert.deepEqual(completion, { status: 'failed', errors: [original] });
            assert.equal(durable.status, 'failed');
            assert.deepEqual(durable.errors, [original]);
        } else {
            assert.deepEqual(completion, { status: 'passed', errors: [] });
            assert.equal(durable.status, 'passed');
            assert.deepEqual(durable.errors, []);
        }
        if (!['rejected-options', 'late-abort'].includes(mode)) {
            const returned = JSON.parse(fs.readFileSync(path.join(input.root, 'native-return.json')));
            assert.deepEqual(returned, { type: process.version === 'v24.0.0' ? 'undefined' : 'promise' });
        }
        t.diagnostic(JSON.stringify({ mode, allocation, completion, durable }));
    });
}

test('Fix3 native parent cancellation joins run admission before automatic closure', async t => {
    const input = fixture(t);
    const result = await consumer(t, input, `
        import fs from 'node:fs';
        import { createHook } from 'node:async_hooks';
        import { test as nativeTest } from 'node:test';
        import * as managed from ${JSON.stringify(entry)};
        import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
        const input = ${JSON.stringify(input)};
        const options = { projectRoot: input.projectRoot, profile: 'native-admission-cancellation', source: 'actual-admission-fsync-fixture', command: [process.execPath, '--test'] };
        const controller = new AbortController();
        const reason = new Error('original outer admission cancellation');
        const entered = Promise.withResolvers();
        let dispatch;
        nativeTest('cancel during managed admission', { signal: controller.signal }, async () => {
            const hook = createHook({ init(id, type) {
                if (dispatch || !type.startsWith('FSREQ')) return;
                const stack = new Error('actual initial registry directory fsync').stack;
                if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
                dispatch = { id, type, stack, reason: serializeFailure(reason) };
                fs.writeFileSync(input.root + '/dispatch.json', JSON.stringify(dispatch));
                entered.resolve();
            } });
            hook.enable();
            let actual;
            const completion = managed.test('interrupted admission', options, async (context, scope, run) => {
                actual = context;
                await scope.borrowDirectory(input.borrowed);
                const owned = await scope.directory('admitted after native cancellation');
                fs.writeFileSync(owned.path + '/payload', 'actual admission payload');
                fs.writeFileSync(input.root + '/allocation.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath, nativeAborted: context.signal.aborted }));
            });
            completion.then(summary => {
                fs.writeFileSync(input.root + '/completion.json', JSON.stringify({ status: 'fulfilled', result: { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)) }, native: { passed: actual.passed, error: serializeFailure(actual.error) } }));
            }, error => {
                fs.writeFileSync(input.root + '/completion.json', JSON.stringify({ status: 'rejected', error: serializeFailure(error) }));
            });
            await entered.promise;
            hook.disable();
            controller.abort(reason);
            await completion;
        });
        managed.test('ordinary admission peer', options, async (context, scope, run) => {
            const owned = await scope.directory('peer');
            fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
        });
    `);
    assert.equal(result.code, 1);
    const allocation = JSON.parse(fs.readFileSync(path.join(input.root, 'allocation.json')));
    const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
    const completion = JSON.parse(fs.readFileSync(path.join(input.root, 'completion.json')));
    const dispatch = JSON.parse(fs.readFileSync(path.join(input.root, 'dispatch.json')));
    const durable = JSON.parse(fs.readFileSync(allocation.registryPath));
    t.diagnostic(JSON.stringify({ allocation, peer, completion, dispatch, durable }));
    assert.equal(allocation.nativeAborted, true);
    assert.equal(fs.existsSync(allocation.path), false);
    assert.equal(fs.existsSync(peer.path), false);
    assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
    assert.equal(completion.status, 'fulfilled');
    assert.equal(completion.result.status, 'failed');
    assert.equal(completion.native.passed, false);
    assert.equal(durable.status, 'failed');
    assert.deepEqual(durable.errors, completion.result.errors);
    assert.deepEqual(durable.errors, [completion.native.error]);
    assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
    const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
    assert.ok(nativeErrors.some(error => error.message === dispatch.reason.message && error.stack === dispatch.reason.stack));
});

for (const mode of ['inner-hook-failure', 'inner-hook-cancellation', 'inner-hook-delay', 'owner-hook-failure', 'owner-hook-cancellation', 'owner-hook-delay']) {
    test(`Fix4 native ${mode} closes registration before terminal callback entrance`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const mode = ${JSON.stringify(mode)};
            const options = { projectRoot: input.projectRoot, profile: 'native-hook-lifetime', source: 'actual-inherited-hook', command: [process.execPath, '--test'] };
            const controller = new AbortController();
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            const original = new Error('original ' + mode);
            const receipt = { hooks: [], callbacks: [], original: serializeFailure(original) };
            const save = () => fs.writeFileSync(input.root + '/hook-receipt.json', JSON.stringify(receipt));
            save();
            nativeTest('native inherited-hook owner', { signal: controller.signal }, async function (ancestor) {
                let entrances = 0;
                ancestor.beforeEach(async function (actual) {
                    assert.equal(this, actual);
                    entrances++;
                    receipt.hooks.push({ entrance: entrances, name: actual.name, aborted: actual.signal.aborted });
                    save();
                    if (entrances !== (mode.startsWith('owner-') ? 1 : 2)) return;
                    if (mode.endsWith('failure')) throw original;
                    entered.resolve();
                    await release.promise;
                    receipt.hooks.push({ settled: true, aborted: actual.signal.aborted });
                    save();
                });
                const completion = managed.test('managed hook caller', options, async function (actual, scope, run) {
                    assert.equal(this, actual);
                    receipt.callbacks.push('caller');
                    const owned = await scope.directory('inherited-hook payload');
                    fs.writeFileSync(owned.path + '/payload', 'actual inherited-hook payload');
                    receipt.allocation = { path: owned.path, registryPath: run.registryPath };
                    save();
                });
                completion.then(summary => {
                    receipt.completion = { status: 'fulfilled', value: summary === undefined ? { type: 'undefined' } : { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)) } };
                    save();
                    if (mode.endsWith('cancellation')) release.resolve();
                }, error => {
                    receipt.completion = { status: 'rejected', error: serializeFailure(error) };
                    save();
                    if (mode.endsWith('cancellation')) release.resolve();
                });
                if (mode.endsWith('cancellation') || mode.endsWith('delay')) {
                    await entered.promise;
                    if (mode.endsWith('cancellation')) controller.abort(original);
                    else release.resolve();
                }
                if (!mode.startsWith('owner-')) await completion;
            });
            managed.test('ordinary hook peer', options, async function (actual, scope, run) {
                assert.equal(this, actual);
                const owned = await scope.directory('hook peer');
                fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
            });
        `);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'hook-receipt.json')));
        const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
        const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
        t.diagnostic(JSON.stringify({ mode, receipt, peer, nativeFailureEvidence: nativeErrors }));
        assert.equal(result.code, mode.endsWith('delay') ? 0 : 1);
        assert.equal(fs.existsSync(peer.path), false);
        assert.deepEqual(fs.readdirSync(path.dirname(peer.path)), []);
        assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
        assert.equal(nativeErrors.some(error => error.name === 'TypeError'), false);
        if (!mode.endsWith('delay')) assert.ok(nativeErrors.some(error => error.message === receipt.original.message && error.stack === receipt.original.stack));
        if (mode.endsWith('cancellation')) assert.ok(receipt.hooks.some(hook => hook.settled === true && hook.aborted === true));
        if (mode.endsWith('delay')) {
            assert.deepEqual(receipt.callbacks, ['caller']);
            assert.equal(receipt.completion.value.status, 'passed');
        } else {
            assert.deepEqual(receipt.callbacks, []);
            const runs = path.dirname(path.dirname(peer.registryPath));
            assert.deepEqual(fs.readdirSync(runs), [path.basename(path.dirname(peer.registryPath))]);
        }
        if (receipt.allocation) {
            assert.equal(fs.existsSync(receipt.allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(receipt.allocation.path)), []);
        }
        if (mode === 'inner-hook-failure' || mode === 'inner-hook-cancellation') {
            assert.equal(receipt.completion.status, 'rejected');
            assert.ok(errorNodes(receipt.completion.error).some(error => error.code === 'ERR_TEST_FAILURE'));
        }
    });
}

for (const cancelled of [false, true]) {
    test(`Fix4 delayed native afterEach ${cancelled ? 'closes' : 'permits'} managed final-hook entrance`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const cancelled = ${JSON.stringify(cancelled)};
            const options = { projectRoot: input.projectRoot, profile: 'native-final-hook-entrance', source: 'actual-delayed-afterEach', command: [process.execPath, '--test'] };
            const controller = new AbortController();
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            const original = new Error('original cancellation before final-hook entrance');
            const receipt = { original: serializeFailure(original), allocations: [], hookEntered: false };
            const save = () => fs.writeFileSync(input.root + '/final-hook.json', JSON.stringify(receipt));
            save();
            nativeTest('native final-hook owner', { signal: controller.signal }, async ancestor => {
                let entrances = 0;
                ancestor.afterEach(async () => {
                    if (++entrances !== 1) return;
                    entered.resolve();
                    await release.promise;
                    receipt.nativeHookSettled = true;
                    save();
                });
                const completion = managed.test('final-hook caller', options, async (context, scope, run) => {
                    const owned = await scope.directory('body payload');
                    receipt.allocations.push({ path: owned.path, registryPath: run.registryPath });
                    save();
                    managed.after(context, async function (actual) {
                        assert.equal(this, actual);
                        assert.equal(actual, context);
                        receipt.hookEntered = true;
                        save();
                        const owned = await scope.directory('hook payload');
                        receipt.allocations.push({ path: owned.path, registryPath: run.registryPath });
                        save();
                    });
                });
                completion.then(summary => {
                    receipt.completion = { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)) };
                    save();
                    if (cancelled) release.resolve();
                });
                await entered.promise;
                if (cancelled) controller.abort(original);
                else release.resolve();
                await completion;
            });
            managed.test('ordinary final-hook peer', options, async (context, scope, run) => {
                const owned = await scope.directory('peer');
                fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
            });
        `);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'final-hook.json')));
        const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
        const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
        t.diagnostic(JSON.stringify({ cancelled, receipt, peer, nativeFailureEvidence: nativeErrors }));
        assert.equal(result.code, cancelled ? 1 : 0);
        assert.equal(receipt.nativeHookSettled, true);
        assert.equal(receipt.hookEntered, !cancelled);
        assert.equal(receipt.completion.status, cancelled ? 'failed' : 'passed');
        if (cancelled) assert.ok(nativeErrors.some(error => error.message === receipt.original.message && error.stack === receipt.original.stack));
        for (const allocation of [...receipt.allocations, peer]) {
            assert.equal(fs.existsSync(allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
        }
        assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
    });
}

for (const mode of ['queued-skip', 'queued-signal', 'hook-mutation', 'skipped-hooks', 'pre-aborted-hooks', 'plan-passed', 'plan-failed', 'deadline', 'deadline-expired', 'todo-failed', 'native-metadata']) {
    test(`Fix5 native ${mode} consumes one logical registration like its direct control`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const mode = ${JSON.stringify(mode)};
            const options = { projectRoot: input.projectRoot, profile: 'native-options', source: 'immediate-native-options', command: [process.execPath, '--test'] };
            const receipt = { direct: { callbacks: [], hooks: [] }, managed: { callbacks: [], hooks: [] } };
            const save = () => fs.writeFileSync(input.root + '/options.json', JSON.stringify(receipt));
            async function exercise(context, register, record) {
                const reason = new Error('original option cancellation ' + mode);
                record.original = serializeFailure(reason);
                save();
                if (mode.startsWith('queued-')) {
                    const entered = Promise.withResolvers();
                    const release = Promise.withResolvers();
                    register(context, 'held child', async () => { record.callbacks.push('held'); save(); entered.resolve(); await release.promise; });
                    await entered.promise;
                    const nativeOptions = { skip: false, signal: new AbortController().signal };
                    register(context, 'queued child', nativeOptions, () => { record.callbacks.push('queued'); save(); });
                    register(context, 'shared options child', nativeOptions, () => { record.callbacks.push('shared'); save(); });
                    if (mode === 'queued-skip') nativeOptions.skip = true;
                    else nativeOptions.signal = AbortSignal.abort(reason);
                    release.resolve();
                } else if (mode === 'hook-mutation') {
                    const entered = Promise.withResolvers();
                    const release = Promise.withResolvers();
                    let waiting = false;
                    context.beforeEach(async () => { if (waiting) return; waiting = true; entered.resolve(); await release.promise; });
                    const nativeOptions = { skip: false, signal: new AbortController().signal };
                    register(context, 'hook delayed child', nativeOptions, () => { record.callbacks.push('delayed'); save(); });
                    await entered.promise;
                    nativeOptions.skip = true;
                    nativeOptions.signal = AbortSignal.abort(reason);
                    release.resolve();
                } else if (mode.endsWith('-hooks')) {
                    context.beforeEach(() => { record.hooks.push('beforeEach'); save(); throw new Error('unexpected skipped setup'); });
                    context.afterEach(() => { record.hooks.push('afterEach'); save(); });
                    register(context, 'omitted child', mode === 'skipped-hooks' ? { skip: true, signal: new AbortController().signal } : { signal: AbortSignal.abort(reason) }, () => { record.callbacks.push('omitted'); save(); });
                } else if (mode.startsWith('plan-')) {
                    register(context, 'planned child', { plan: 1 }, actual => {
                        record.callbacks.push('planned');
                        save();
                        if (mode === 'plan-passed') actual.assert.equal('actual', 'actual');
                    });
                } else if (mode === 'deadline') {
                    const entered = Promise.withResolvers();
                    const release = Promise.withResolvers();
                    let waiting = false;
                    context.beforeEach(async actual => {
                        if (waiting) return;
                        waiting = true;
                        actual.test('native deadline witness', { timeout: 1, todo: true }, witness => new Promise(resolve => {
                            witness.signal.addEventListener('abort', () => { release.resolve(); resolve(); }, { once: true });
                        }));
                        entered.resolve();
                        await release.promise;
                        record.hooks.push('released');
                        save();
                    });
                    register(context, 'deadline child', { timeout: 1 }, actual => { record.callbacks.push('deadline'); save(); actual.assert.ok(true); });
                    await entered.promise;
                } else if (mode === 'deadline-expired') {
                    register(context, 'expired deadline child', { timeout: 1 }, actual => new Promise(resolve => {
                        record.callbacks.push('deadline entered'); save();
                        actual.signal.addEventListener('abort', () => { record.callbacks.push('deadline aborted'); save(); resolve(); }, { once: true });
                    }));
                } else if (mode === 'native-metadata') {
                    register(context, 'metadata child', { tags: ['native-registration'], expectFailure: false, concurrency: true }, actual => {
                        record.callbacks.push('metadata');
                        save();
                        actual.assert.ok(true);
                    });
                } else {
                    register(context, 'todo child', { todo: true }, () => { record.callbacks.push('todo'); record.original = serializeFailure(reason); save(); throw reason; });
                }
            }
            nativeTest('direct option control', async context => { await exercise(context, (parent, ...args) => parent.test(...args), receipt.direct); });
            managed.test('managed option caller', options, async function (context, scope, run) {
                assert.equal(this, context);
                await scope.borrowDirectory(input.borrowed);
                const owned = await scope.directory(mode);
                receipt.allocation = { path: owned.path, registryPath: run.registryPath };
                save();
                await exercise(context, managed.subtest, receipt.managed);
            }).then(summary => {
                receipt.completion = { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)) }; save();
            }, error => {
                receipt.completion = { status: 'rejected', rejection: serializeFailure(error), errors: JSON.parse(fs.readFileSync(receipt.allocation.registryPath)).errors }; save();
            });
            managed.test('ordinary options peer', options, async (context, scope, run) => {
                const owned = await scope.directory('options peer');
                fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
            });
        `);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'options.json')));
        const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
        const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
        t.diagnostic(JSON.stringify({ mode, receipt, peer, nativeFailureEvidence: nativeErrors }));
        const failing = ['pre-aborted-hooks', 'plan-failed', 'deadline-expired', 'todo-failed'].includes(mode);
        assert.equal(result.code, failing ? 1 : 0);
        assert.deepEqual(receipt.managed.callbacks, receipt.direct.callbacks);
        assert.deepEqual(receipt.managed.hooks, receipt.direct.hooks);
        assert.equal(receipt.completion.status, mode === 'todo-failed' ? 'rejected' : failing ? 'failed' : 'passed');
        if (mode.startsWith('queued-')) assert.deepEqual(receipt.managed.callbacks, ['held', 'queued', 'shared']);
        if (mode === 'hook-mutation') assert.deepEqual(receipt.managed.callbacks, ['delayed']);
        if (mode.endsWith('-hooks')) {
            assert.deepEqual(receipt.managed.callbacks, []);
            assert.deepEqual(receipt.managed.hooks, []);
        }
        if (mode === 'pre-aborted-hooks') assert.ok(nativeErrors.some(error => error.message === receipt.managed.original.message && error.stack === receipt.managed.original.stack));
        if (mode === 'deadline') assert.deepEqual(receipt.managed.callbacks, ['deadline']);
        if (mode === 'deadline-expired') {
            assert.deepEqual(receipt.managed.callbacks, ['deadline entered', 'deadline aborted']);
            assert.ok(receipt.completion.errors.flatMap(errorNodes).some(error => property(error, 'failureType') === 'testTimeoutFailure'));
        }
        if (mode === 'native-metadata') {
            const registrations = result.events.filter(event => event.type === 'test:complete' && event.data.name === 'metadata child');
            assert.equal(registrations.length, 2);
            assert.deepEqual(registrations[0].data.tags, registrations[1].data.tags);
        }
        if (mode === 'todo-failed') assert.ok(receipt.completion.errors.flatMap(errorNodes).some(error => error.stack === receipt.managed.original.stack));
        for (const allocation of [receipt.allocation, peer]) {
            assert.equal(fs.existsSync(allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
        }
        const durable = JSON.parse(fs.readFileSync(receipt.allocation.registryPath));
        assert.equal(durable.status, failing ? 'failed' : 'passed');
        assert.deepEqual(durable.errors, receipt.completion.errors);
        assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
    });
}

test('Fix5 actual native own-after returns before the known owner aggregates children', async t => {
    const input = fixture(t);
    const result = await consumer(t, input, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { test as nativeTest } from 'node:test';
        import { setImmediate as turn } from 'node:timers/promises';
        import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
        const receipt = {};
        nativeTest('native completion ancestor', async ancestor => {
            const completed = Promise.withResolvers();
            ancestor.test('known native completion owner', owner => {
                owner.test('real failed descendant', () => { throw new Error('original native completion descendant'); });
                owner.after(() => {
                    receipt.ownAfter = { passed: owner.passed, error: serializeFailure(owner.error) };
                    const publishing = async () => {
                        await turn();
                        receipt.completed = { passed: owner.passed, error: serializeFailure(owner.error) };
                    };
                    publishing().then(completed.resolve, completed.reject);
                });
            });
            await completed.promise;
            receipt.ancestorContinued = true;
            fs.writeFileSync(${JSON.stringify(path.join(input.root, 'native-completion.json'))}, JSON.stringify(receipt));
            assert.equal(receipt.completed.passed, false);
        });
    `);
    assert.equal(result.code, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'native-completion.json')));
    assert.deepEqual(receipt.ownAfter, { passed: true, error: null });
    assert.equal(receipt.completed.passed, false);
    assert.equal(property(receipt.completed.error, 'failureType'), 'subtestsFailed');
    assert.equal(receipt.ancestorContinued, true);
    t.diagnostic(JSON.stringify({ nativePhase: receipt }));
});

for (const mode of ['root-hook-descendant-failure', 'child-hook-descendant-failure', 'child-filtered-inner-signal', 'owner-only-raw-failure', 'owner-only-filtered-signal', 'owner-prior-after-failure', 'owner-prior-after-cancellation']) {
    test(`Fix5 native ${mode} retains actual ownership without inherited-context inference`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import { setImmediate as turn } from 'node:timers/promises';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const mode = ${JSON.stringify(mode)};
            const options = { projectRoot: input.projectRoot, profile: 'native-owner-outcome', source: 'actual-hook-created-descendants', command: [process.execPath, '--test'] };
            const original = new Error('original ' + mode);
            const unused = new Error('unused filtered cancellation');
            const controller = new AbortController();
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            const receipt = { callbacks: [], hooks: [], original: serializeFailure(original), unused: serializeFailure(unused) };
            const save = () => fs.writeFileSync(input.root + '/ownership.json', JSON.stringify(receipt));
            save();
            async function raw(actual, failing) {
                const done = Promise.withResolvers();
                actual.test('actual raw hook descendant', child => {
                    child.signal.addEventListener('abort', done.resolve, { once: true });
                    receipt.callbacks.push('raw'); save();
                    if (failing) throw original;
                });
                await done.promise;
                await turn();
            }
            nativeTest('ordinary native ancestor awaits managed completion', { signal: controller.signal }, async ancestor => {
                let entrances = 0;
                ancestor.beforeEach(async actual => {
                    receipt.hooks.push(actual.name); save();
                    if (++entrances !== (mode === 'root-hook-descendant-failure' ? 2 : 1)) return;
                    if (mode.startsWith('child-')) return;
                    if (mode.startsWith('owner-prior-after-')) {
                        actual.after(async () => {
                            receipt.priorHookEntered = true; save();
                            if (mode.endsWith('failure')) throw original;
                            entered.resolve();
                            await release.promise;
                            receipt.priorHookSettled = true; save();
                        });
                        return;
                    }
                    await raw(actual, mode.startsWith('owner-only-'));
                    if (mode === 'root-hook-descendant-failure') throw original;
                });
                const completion = managed.test('actual managed owner', options, async function (context, scope, run) {
                    assert.equal(this, context);
                    receipt.callbacks.push('body');
                    await scope.borrowDirectory(input.borrowed);
                    const owned = await scope.directory(mode);
                    receipt.allocation = { path: owned.path, registryPath: run.registryPath };
                    save();
                    if (mode === 'child-hook-descendant-failure') {
                        let entered = false;
                        context.beforeEach(async actual => {
                            if (entered) return;
                            entered = true;
                            await raw(actual, false);
                            throw original;
                        });
                        managed.subtest(context, 'actual omitted child', () => { receipt.callbacks.push('unexpected child'); save(); });
                    }
                    if (mode === 'child-filtered-inner-signal') {
                        await raw(context, true);
                        managed.subtest(context, 'unused filtered child', { signal: AbortSignal.abort(unused) }, () => { receipt.callbacks.push('unexpected filtered child'); save(); });
                    }
                    if (mode === 'owner-only-filtered-signal') managed.subtest(context, 'unused filtered child', { signal: AbortSignal.abort(unused) }, () => { receipt.callbacks.push('unexpected filtered child'); save(); });
                });
                if (mode === 'owner-prior-after-cancellation') {
                    await entered.promise;
                    controller.abort(original);
                }
                try {
                    const summary = await completion;
                    receipt.completion = summary === undefined ? { status: 'undefined' } : { status: summary.status, errors: summary.errors.map(error => serializeFailure(error)) };
                } catch (error) { receipt.completion = { status: 'rejected', error: serializeFailure(error) }; }
                if (mode === 'owner-prior-after-cancellation') {
                    release.resolve();
                    await turn();
                }
                receipt.ancestorContinued = true;
                if (receipt.allocation) assert.equal(fs.existsSync(receipt.allocation.path), false);
                save();
            });
            managed.test('ordinary ownership peer', options, async (context, scope, run) => {
                const owned = await scope.directory('ownership peer');
                fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
            });
        `, mode === 'child-filtered-inner-signal' || mode === 'owner-only-filtered-signal' ? ['--test-skip-pattern=unused filtered child'] : []);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'ownership.json')));
        const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
        const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
        t.diagnostic(JSON.stringify({ mode, receipt, peer, nativeFailureEvidence: nativeErrors }));
        assert.equal(result.code, 1);
        assert.equal(receipt.ancestorContinued, true);
        assert.ok(nativeErrors.some(error => error.message === receipt.original.message && error.stack === receipt.original.stack));
        assert.equal(receipt.callbacks.includes('unexpected child'), false);
        assert.equal(receipt.callbacks.includes('unexpected filtered child'), false);
        assert.equal(JSON.stringify(receipt.completion).includes(receipt.unused.message), false);
        if (mode === 'root-hook-descendant-failure') {
            assert.deepEqual(receipt.callbacks, ['raw']);
            assert.equal(receipt.completion.status, 'rejected');
            assert.ok(errorNodes(receipt.completion.error).some(error => error.code === 'ERR_TEST_FAILURE'));
        } else {
            assert.equal(receipt.completion.status, 'failed');
            const durable = JSON.parse(fs.readFileSync(receipt.allocation.registryPath));
            assert.equal(durable.status, 'failed');
            assert.deepEqual(durable.errors, receipt.completion.errors);
            assert.equal(JSON.stringify(durable.errors).includes(receipt.unused.message), false);
            if (mode.startsWith('owner-prior-after-')) {
                assert.equal(receipt.priorHookEntered, true);
                if (mode.endsWith('cancellation')) assert.equal(receipt.priorHookSettled, true);
                assert.ok(durable.errors.flatMap(errorNodes).some(error => error.code === 'ERR_TEST_FAILURE'));
            } else assert.ok(durable.errors.flatMap(errorNodes).some(error => property(error, 'failureType') === 'subtestsFailed'));
            assert.equal(fs.existsSync(receipt.allocation.path), false);
            assert.deepEqual(fs.readdirSync(path.dirname(receipt.allocation.path)), []);
        }
        assert.equal(fs.existsSync(peer.path), false);
        assert.deepEqual(fs.readdirSync(path.dirname(peer.path)), []);
        assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
    });
}

for (const cancelled of [false, true]) {
    test(`Fix4 initial admission rejection ${cancelled ? 'with' : 'without'} native cancellation retains actual persistence error`, async t => {
        const input = fixture(t);
        const result = await consumer(t, input, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs';
            import path from 'node:path';
            import { execFileSync } from 'node:child_process';
            import { createHook } from 'node:async_hooks';
            import { test as nativeTest } from 'node:test';
            import * as managed from ${JSON.stringify(entry)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const input = ${JSON.stringify(input)};
            const cancelled = ${JSON.stringify(cancelled)};
            const options = { projectRoot: input.projectRoot, profile: 'native-admission-rejection', source: 'exact-owned-admission-fsync-fault', command: [process.execPath, '--test'] };
            const controller = new AbortController();
            const reason = new Error('original cancellation at rejected admission');
            const entered = Promise.withResolvers();
            let injected;
            let injectionError;
            function descriptors() {
                const output = execFileSync('lsof', ['-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
                let fd;
                const records = [];
                for (const line of output.split('\\n')) {
                    if (line.startsWith('f')) fd = line.slice(1);
                    if (line.startsWith('n')) records.push({ fd, path: line.slice(1) });
                }
                return records;
            }
            const peerCompletion = managed.test('ordinary rejected-admission peer', options, async (actual, scope, run) => {
                const owned = await scope.directory('admission fault peer');
                fs.writeFileSync(input.root + '/peer.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
            });
            nativeTest('native admission fault owner', { signal: controller.signal }, async ancestor => {
                const hook = createHook({ init(id, type) {
                    if (injected || injectionError || !type.startsWith('FSREQ')) return;
                    const stack = new Error('actual initial registry directory fsync').stack;
                    if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
                    try {
                        const runs = input.projectRoot + '/test-results/harness/runs';
                        const active = descriptors().filter(item => path.dirname(item.path) === runs && /^\\d+$/.test(item.fd));
                        assert.equal(active.length, 1, 'exact initial registry directory descriptor is absent');
                        const descriptor = active[0];
                        const registryRoot = descriptor.path;
                        const actual = fs.fstatSync(Number(descriptor.fd));
                        const expected = fs.lstatSync(registryRoot);
                        assert.equal(actual.dev, expected.dev);
                        assert.equal(actual.ino, expected.ino);
                        injected = { id, type, stack, descriptor, dev: actual.dev, ino: actual.ino, registryPath: registryRoot + '/registry.json', before: JSON.parse(fs.readFileSync(registryRoot + '/registry.json')), reason: serializeFailure(reason) };
                        fs.closeSync(Number(descriptor.fd));
                        fs.writeFileSync(input.root + '/injection.json', JSON.stringify(injected));
                    } catch (error) { injectionError = error; }
                    entered.resolve();
                } });
                ancestor.beforeEach(async () => {
                    await peerCompletion;
                    hook.enable();
                });
                const completion = managed.test('rejected admission caller', options, () => {
                    fs.writeFileSync(input.root + '/unexpected-body', 'admission must reject before body');
                });
                completion.then(summary => {
                    fs.writeFileSync(input.root + '/admission-completion.json', JSON.stringify({ status: 'fulfilled', summary }));
                }, error => {
                    const after = descriptors();
                    fs.writeFileSync(input.root + '/admission-completion.json', JSON.stringify({ status: 'rejected', error: serializeFailure(error), injectionError: injectionError && serializeFailure(injectionError), ownedDescriptors: after.filter(item => item.path.startsWith(input.root + path.sep)) }));
                });
                await entered.promise;
                hook.disable();
                if (injectionError) throw injectionError;
                if (cancelled) controller.abort(reason);
                await completion;
            });
        `);
        const completion = JSON.parse(fs.readFileSync(path.join(input.root, 'admission-completion.json')));
        const injection = JSON.parse(fs.readFileSync(path.join(input.root, 'injection.json')));
        const peer = JSON.parse(fs.readFileSync(path.join(input.root, 'peer.json')));
        const durable = JSON.parse(fs.readFileSync(injection.registryPath));
        const nativeErrors = result.events.flatMap(event => errorNodes(event.data.details?.error));
        t.diagnostic(JSON.stringify({ cancelled, completion, injection, durable, peer, nativeFailureEvidence: nativeErrors }));
        assert.equal(result.code, 1);
        assert.equal(completion.status, 'rejected');
        assert.equal(completion.injectionError, undefined);
        assert.deepEqual(completion.ownedDescriptors, []);
        assert.equal(fs.existsSync(path.join(input.root, 'unexpected-body')), false);
        assert.equal(fs.existsSync(peer.path), false);
        assert.deepEqual(fs.readdirSync(path.dirname(peer.path)), []);
        assert.equal(JSON.parse(fs.readFileSync(peer.registryPath)).status, 'passed');
        assert.deepEqual(durable, injection.before);
        assert.equal(durable.status, 'running');
        assert.deepEqual(durable.resources, []);
        assert.deepEqual(durable.scopes, []);
        assert.deepEqual(fs.readdirSync(path.dirname(injection.registryPath)), ['registry.json', 'writer-custody']);
        assert.deepEqual(fs.readdirSync(durable.custodyBoundary.path), []);
        const errors = errorNodes(completion.error);
        const publication = errors.find(error => error.publication);
        assert.ok(publication, 'initial admission persistence error was discarded');
        assert.deepEqual({ ...fields(publication.publication) }, { registryPath: injection.registryPath, temporary: property(publication.publication, 'temporary'), stage: 'durability', published: true });
        assert.equal(path.dirname(property(publication.publication, 'temporary')), path.dirname(injection.registryPath));
        assert.equal(fs.existsSync(property(publication.publication, 'temporary')), false);
        assert.ok(publication.errors.some(error => error.code === 'EBADF' && error.stack.includes('/resources/registry.js:')));
        assert.equal(publication.name, 'AggregateError');
        assert.ok(publication.stack.includes('/resources/registry.js:'));
        if (cancelled) {
            assert.ok(errors.some(error => error.code === 'ERR_TEST_FAILURE'));
            assert.ok(nativeErrors.some(error => error.message === injection.reason.message && error.stack === injection.reason.stack));
            assert.ok(nativeErrors.some(error => error.message === 'Managed native resource finalization failed'));
        } else assert.ok(nativeErrors.some(error => error.message === publication.message && error.stack === publication.stack));
    });
}
