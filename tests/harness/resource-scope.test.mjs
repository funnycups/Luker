import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRun } from './resources/run.js';
import { directoryProvider, registerProvider } from './resources/providers.js';
import { nativeRuntime, nativeSource } from './fixtures/native-runtime.mjs';
import './fixtures/resource-core-failures.mjs';
import './fixtures/resource-native-outcomes.mjs';
import './fixtures/resource-native-registration.mjs';
import './fixtures/resource-native-lifecycle.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const scratch = path.join(repository, 'test-results', 'resource-scope-self-tests');
const bytes = Buffer.from('borrowed fixture\n\0unchanged\xff', 'latin1');
const digest = value => createHash('sha256').update(value).digest('hex');
const options = projectRoot => ({
    projectRoot,
    profile: 'resource-core',
    command: [process.execPath, '--test', 'harness/resource-scope.test.mjs'],
    source: 'resource-core-fixture',
});

async function fixture(t) {
    const results = path.dirname(scratch);
    await fs.mkdir(results, { recursive: true });
    assert.equal(await fs.realpath(results), results);
    assert.ok((await fs.lstat(results)).isDirectory());
    await fs.mkdir(scratch, { recursive: true });
    assert.equal(await fs.realpath(scratch), scratch);
    assert.ok((await fs.lstat(scratch)).isDirectory());
    const root = await fs.realpath(await fs.mkdtemp(path.join(scratch, 'case-')));
    const identity = await fs.lstat(root);
    const projectRoot = path.join(root, 'project');
    const borrowed = path.join(root, 'borrowed');
    await fs.mkdir(projectRoot);
    await fs.mkdir(borrowed);
    await fs.writeFile(path.join(borrowed, 'original'), bytes);
    t.after(async () => {
        assert.deepEqual(await fs.readFile(path.join(borrowed, 'original')), bytes);
        const current = await fs.lstat(root);
        assert.equal(current.ino, identity.ino);
        assert.equal(current.dev, identity.dev);
        assert.equal(await fs.realpath(root), root);
        t.diagnostic(JSON.stringify({ fixture: root, dev: identity.dev, ino: identity.ino, borrowedSHA256: digest(bytes), cleanup: 'exact fixture identity verified' }));
        await fs.rm(root, { recursive: true });
        await absent(root);
    });
    return { root, projectRoot, borrowed };
}

async function absent(target) {
    await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
}

function provider(allocate, dispose = directoryProvider.dispose) {
    const definition = { kind: `fault-directory-${randomUUID()}`, allocate, dispose };
    registerProvider(definition);
    return definition;
}

function acquire(scope, definition, dependsOn = []) {
    return scope.acquire({ ...definition, label: 'fault', dependsOn });
}

async function registry(run) {
    return JSON.parse(await fs.readFile(run.registryPath, 'utf8'));
}

for (const failing of [false, true]) {
    test(`resource-only run disposal ${failing ? 'retains cleanup failure' : 'closes admission'} before outcome publication`, async t => {
        const input = await fixture(t);
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: 'separate lifecycle' });
        await scope.borrowDirectory(input.borrowed);
        const original = new Error('original phased cleanup failure');
        let releases = 0;
        const definition = provider(directoryProvider.allocate, async record => {
            releases++;
            await directoryProvider.dispose(record);
            if (failing) throw original;
        });
        const owned = await acquire(scope, definition);
        try {
            assert.equal(typeof run.dispose, 'function');
            const disposal = run.dispose();
            assert.equal(run.dispose(), disposal);
            assert.equal(run.active, false);
            await assert.rejects(run.scope({ kind: 'case', label: 'late' }), /finishing or finished/);
            await assert.rejects(scope.directory('late'), /finishing or finished|disposing|disposed/);
            if (failing) await assert.rejects(disposal, error => error instanceof AggregateError && error.errors[0].cause === original);
            else await disposal;
            await absent(owned.path);
            assert.equal((await registry(run)).status, 'running');
            const summary = await run.finish({ status: 'passed' });
            assert.equal(summary.status, failing ? 'failed' : 'passed');
            assert.equal(releases, 1);
            if (failing) assert.equal(summary.errors[0].cause, original);
            assert.equal((await registry(run)).status, summary.status);
            assert.equal(run.finish({ status: 'failed' }), run.finish({ status: 'passed' }));
        } finally {
            await run.finish({ status: 'passed' });
        }
    });
}

// Losing the registration before a provider returns must leak a real directory.
test('failed acquisition retains a disposable registration', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'partial' });
    const primary = new Error('readiness rejected after directory creation');
    let allocated;
    const fault = provider(async handle => {
        const before = await registry(run);
        assert.equal(before.resources.at(-1).state, 'allocating');
        allocated = await directoryProvider.allocate(handle);
        await fs.writeFile(path.join(allocated.path, 'partial'), 'created before readiness');
        const during = await registry(run);
        assert.equal(during.resources.at(-1).state, 'acquired');
        assert.equal(during.resources.at(-1).locator.path, allocated.path);
        throw primary;
    });
    await assert.rejects(acquire(scope, fault), error => error === primary);
    await absent(allocated.path);
    await scope.dispose();
    const summary = await run.finish({ status: 'failed', error: primary });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.errors, [primary]);
    assert.equal(summary.resources[0].state, 'disposed');
});

// Label-derived paths collide across repeated acquisitions and child scopes.
test('duplicate labels allocate distinct resources', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const parent = await run.scope({ kind: 'scenario', label: 'same' });
    const child = await parent.child({ kind: 'case', label: 'same' });
    const directories = await Promise.all([parent.directory('same'), parent.directory('same'), child.directory('same')]);
    assert.equal(new Set(directories.map(item => item.path)).size, 3);
    for (const [index, directory] of directories.entries()) {
        assert.equal(directory.ownership, 'owned');
        await fs.writeFile(path.join(directory.path, 'fixture'), String(index));
    }
    const first = parent.dispose();
    assert.equal(parent.dispose(), first);
    await first;
    for (const directory of directories) await absent(directory.path);
    await assert.rejects(parent.directory('late'), /disposed|disposing/);
    await assert.rejects(parent.child({ kind: 'case', label: 'late' }), /disposed|disposing/);
    const finishing = run.finish({ status: 'passed' });
    assert.equal(run.finish({ status: 'passed' }), finishing);
    const summary = await finishing;
    assert.equal(summary.status, 'passed');
    assert.equal(summary.resources.length, 3);
    assert.equal((await registry(run)).status, 'passed');
    await assert.rejects(run.scope({ kind: 'case', label: 'late' }), /finished|finishing/);
});

for (const ancestorKind of ['worker', 'scenario']) {
    test(`shared resources retain ${ancestorKind === 'worker' ? 'worker' : 'run'} custody after case disposal`, async t => {
        const input = await fixture(t);
        const run = await createRun(options(input.projectRoot));
        try {
            const ancestor = await run.scope({ kind: ancestorKind, label: 'shared owner' });
            const scope = await ancestor.child({ kind: 'case', label: 'shared consumer' });
            assert.equal(typeof scope.acquireShared, 'function');
            const shared = await scope.acquireShared({ ...directoryProvider, label: 'shared physical resource' });
            const consumer = await acquire(scope, directoryProvider, [shared.resourceId]);
            const snapshot = await registry(run);
            const sharedRecord = snapshot.resources.find(record => record.resourceId === shared.resourceId);
            const sharedScope = snapshot.scopes.find(record => record.scopeId === sharedRecord.scopeId);
            assert.equal(sharedScope.kind, ancestorKind === 'worker' ? 'worker' : 'run');
            assert.equal(scope.sharedScopeId, sharedScope.scopeId);
            await scope.dispose();
            await absent(consumer.path);
            assert.ok((await fs.lstat(shared.path)).isDirectory());
            await ancestor.dispose();
            if (ancestorKind === 'worker') await absent(shared.path);
            else assert.ok((await fs.lstat(shared.path)).isDirectory());
            const summary = await run.finish({ status: 'passed' });
            assert.equal(summary.status, 'passed');
            await absent(shared.path);
            await assert.rejects(scope.acquireShared({ ...directoryProvider, label: 'late shared allocation' }), /disposed|disposing/);
        } finally {
            await run.finish({ status: 'passed' });
        }
    });
}

test('a shared resource is retained when its dependent release fails', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    try {
        const scope = await run.scope({ kind: 'case', label: 'failed shared consumer' });
        const shared = await scope.acquireShared({ ...directoryProvider, label: 'shared physical resource' });
        const failure = new Error('consumer is still using the shared resource');
        const definition = provider(directoryProvider.allocate, async () => { throw failure; });
        await acquire(scope, definition, [shared.resourceId]);
        const summary = await run.finish({ status: 'passed' });
        assert.equal(summary.status, 'failed');
        assert.ok((await fs.lstat(shared.path)).isDirectory());
        assert.equal(summary.resources.find(record => record.resourceId === shared.resourceId).state, 'cleanup-failed');
    } finally {
        await run.finish({ status: 'passed' });
    }
});

// Recursive removal must unlink links, never traverse borrowed targets or a prefix sibling.
test('borrowed and linked paths remain unchanged', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'boundaries' });
    const borrowed = await scope.borrowDirectory(input.borrowed);
    assert.deepEqual(borrowed, { path: input.borrowed, ownership: 'borrowed' });
    const owned = await scope.directory('case');
    const sibling = `${owned.path}-borrowed`;
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'original'), bytes);
    await scope.borrowDirectory(sibling);
    await fs.symlink(input.borrowed, path.join(owned.path, 'linked-directory'));
    await fs.symlink(path.join(input.borrowed, 'original'), path.join(owned.path, 'linked-file'));
    await fs.writeFile(path.join(owned.path, 'ordinary-fixture'), 'inherits ownership');
    await scope.dispose();
    await absent(owned.path);
    assert.deepEqual(await fs.readFile(path.join(borrowed.path, 'original')), bytes);
    assert.deepEqual(await fs.readFile(path.join(sibling, 'original')), bytes);
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'passed');
    assert.equal(summary.resources.filter(item => item.owner === 'borrowed').length, 2);
});

// Borrowing an owned boundary must not leave a second deletion authority.
test('borrowed ownership cannot be promoted or overlap a disposable boundary', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'ownership' });
    const owned = await scope.directory('owned');
    await assert.rejects(scope.borrowDirectory(owned.path), /owned|overlap/);
    await assert.rejects(scope.borrowDirectory(path.dirname(owned.path)), /owned|overlap/);
    const link = path.join(input.root, 'borrowed-link');
    await fs.symlink(input.borrowed, link);
    await scope.borrowDirectory(link);
    await scope.dispose();
    await absent(owned.path);
    assert.equal(await fs.readlink(link), input.borrowed);
    await run.finish({ status: 'passed' });
});

// A replaced root must fail closed, retaining the exact resource and underlying error.
for (const boundary of ['resource', 'data-root', 'run-root']) {
    test(`replaced ${boundary} ownership boundary is not deleted`, async t => {
        const input = await fixture(t);
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: 'replacement' });
        const owned = await scope.directory('case');
        const target = boundary === 'resource' ? owned.path : boundary === 'data-root' ? path.dirname(owned.path) : path.dirname(run.registryPath);
        const moved = `${target}-original`;
        await fs.rename(target, moved);
        await fs.symlink(input.borrowed, target);
        let failure;
        try {
            await scope.dispose();
            assert.fail('replaced ownership boundary was accepted');
        } catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof AggregateError);
        assert.equal(failure.errors[0].resource.resourceId, owned.resourceId);
        assert.ok(failure.errors[0].cause instanceof Error);
        assert.match(failure.errors[0].message, new RegExp(owned.resourceId));
        assert.deepEqual(await fs.readFile(path.join(input.borrowed, 'original')), bytes);
        assert.equal(await fs.readlink(target), input.borrowed);
        await fs.unlink(target);
        await fs.rename(moved, target);
        const summary = await run.finish({ status: 'passed' });
        assert.equal(summary.status, 'failed');
        assert.deepEqual(summary.errors, failure.errors);
        assert.equal(summary.resources[0].state, 'cleanup-failed');
    });
}

// Retaining only the last error loses the primary failure and misreports a passed run.
test('cleanup preserves the original failure', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'errors' });
    const primary = new Error('original acquisition failure');
    const cleanup = new Error('cleanup failed after removing owned directory');
    let owned;
    const fault = provider(async handle => {
        owned = await directoryProvider.allocate(handle);
        throw primary;
    }, async record => {
        await directoryProvider.dispose(record);
        throw cleanup;
    });
    let failure;
    await assert.rejects(acquire(scope, fault), error => {
        failure = error;
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primary);
        assert.equal(error.errors[1].cause, cleanup);
        assert.equal(error.errors[1].resource.locator.path, owned.path);
        return true;
    });
    await absent(owned.path);
    await assert.rejects(scope.dispose(), AggregateError);
    const summary = await run.finish({ status: 'failed', error: failure });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.errors, [primary, failure.errors[1]]);
    const durable = await registry(run);
    assert.equal(durable.errors.length, 2);
    assert.equal(durable.errors[1].cause.message, cleanup.message);
});

// Parent data must remain until child/dependent cleanup has actually finished.
test('child scopes and dependencies dispose before their providers', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const parent = await run.scope({ kind: 'scenario', label: 'parent' });
    const child = await parent.child({ kind: 'case', label: 'child' });
    const dependency = await parent.directory('dependency');
    let dependent;
    const definition = provider(directoryProvider.allocate, async record => {
        assert.equal(await fs.readFile(path.join(dependency.path, 'state'), 'utf8'), 'parent still present');
        await directoryProvider.dispose(record);
        await fs.writeFile(path.join(dependency.path, 'child-finished'), 'released');
    });
    await fs.writeFile(path.join(dependency.path, 'state'), 'parent still present');
    dependent = await acquire(child, definition, [dependency.resourceId]);
    const ownDependent = await acquire(parent, definition, [dependency.resourceId]);
    await parent.dispose();
    for (const item of [dependency, dependent, ownDependent]) await absent(item.path);
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'passed');
    assert.deepEqual(summary.resources.find(item => item.resourceId === dependent.resourceId).dependencies, [dependency.resourceId]);
});

// Disposal must join admitted acquisition, while rejecting additional children/resources.
test('disposal joins an acquisition that has published before readiness', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'in-flight' });
    let release;
    let publish;
    const ready = new Promise(resolve => { release = resolve; });
    const published = new Promise(resolve => { publish = resolve; });
    let owned;
    const definition = provider(async handle => {
        owned = await directoryProvider.allocate(handle);
        publish();
        await ready;
        return owned;
    });
    const acquiring = acquire(scope, definition);
    await published;
    assert.equal((await registry(run)).resources[0].state, 'acquired');
    const disposing = scope.dispose();
    await assert.rejects(scope.directory('late'), /disposing|disposed/);
    await assert.rejects(scope.child({ kind: 'case', label: 'late' }), /disposing|disposed/);
    release();
    await acquiring;
    await disposing;
    await absent(owned.path);
    assert.equal((await run.finish({ status: 'passed' })).status, 'passed');
});

test('disposing a parent immediately stops descendant admission', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const parent = await run.scope({ kind: 'scenario', label: 'parent' });
    const child = await parent.child({ kind: 'case', label: 'child' });
    const disposal = parent.dispose();
    const checks = (async () => {
        await assert.rejects(child.directory('too-late'), /disposing|disposed/);
        await assert.rejects(child.child({ kind: 'case', label: 'too-late' }), /disposing|disposed/);
    })();
    const results = await Promise.allSettled([checks, disposal]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Descendant admission and disposal validation failed');
    assert.deepEqual((await registry(run)).resources, []);
    await run.finish({ status: 'passed' });
});

test('replacement directories retain both the original and the new contents', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'replacement-directory' });
    const owned = await scope.directory('case');
    await fs.writeFile(path.join(owned.path, 'original'), 'owned original');
    const moved = `${owned.path}-original`;
    await fs.rename(owned.path, moved);
    await fs.mkdir(owned.path);
    await fs.writeFile(path.join(owned.path, 'replacement'), bytes);
    await assert.rejects(scope.dispose(), error => error instanceof AggregateError && /boundary changed/.test(error.errors[0].cause.message));
    assert.deepEqual(await fs.readFile(path.join(owned.path, 'replacement')), bytes);
    assert.equal(await fs.readFile(path.join(moved, 'original'), 'utf8'), 'owned original');
    assert.equal((await run.finish({ status: 'passed' })).status, 'failed');
});

test('cleanup continues after failures and retains all resource errors once', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'cleanup-errors' });
    const definition = provider(directoryProvider.allocate, async record => {
        await directoryProvider.dispose(record);
        throw new Error(`release rejected ${record.resourceId}`);
    });
    const a = await acquire(scope, definition);
    const b = await acquire(scope, definition);
    let failure;
    await assert.rejects(scope.dispose(), error => {
        failure = error;
        assert.equal(error.errors.length, 2);
        return true;
    });
    await absent(a.path);
    await absent(b.path);
    await assert.rejects(scope.dispose(), error => error === failure);
    const summary = await run.finish({ status: 'failed', error: failure });
    assert.deepEqual(summary.errors, failure.errors);
    assert.equal(new Set(summary.errors.map(error => error.resource.resourceId)).size, 2);
});

test('registry replacement is surfaced without writing a borrowed target', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'registry-boundary' });
    const owned = await scope.directory('case');
    const originalRegistry = `${run.registryPath}.original`;
    await fs.rename(run.registryPath, originalRegistry);
    await fs.symlink(path.join(input.borrowed, 'original'), run.registryPath);
    const primary = new Error('primary failure before registry publication');
    await assert.rejects(run.finish({ status: 'failed', error: primary }), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primary);
        assert.ok(error.errors.some(item => /Registry file ownership changed/.test(item.message) || /Registry file ownership changed/.test(item.cause?.message)));
        return true;
    });
    await absent(owned.path);
    assert.deepEqual(await fs.readFile(path.join(input.borrowed, 'original')), bytes);
    assert.equal(await fs.readlink(run.registryPath), path.join(input.borrowed, 'original'));
    assert.deepEqual((await fs.readdir(path.dirname(run.registryPath))).sort(), ['data', 'registry.json', 'registry.json.original', 'writer-custody']);
    assert.deepEqual(await fs.readdir(run.registry.custodyBoundary.path), []);
});

test('unregistered allocations and foreign dependencies are rejected before allocation', async t => {
    const input = await fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'registered' });
    let allocated = false;
    await assert.rejects(scope.acquire({ kind: 'unregistered', label: 'invalid', allocate: async () => { allocated = true; }, dispose: async () => {} }), /registered/);
    await assert.rejects(scope.acquire({ ...directoryProvider, label: 'invalid', dependsOn: ['foreign-resource'] }), /dependenc/);
    assert.equal(allocated, false);
    assert.deepEqual((await registry(run)).resources, []);
    await run.finish({ status: 'passed' });
});

test('concurrent runs never dispose another run or its retained registry', async t => {
    const input = await fixture(t);
    const [left, right] = await Promise.all([createRun(options(input.projectRoot)), createRun(options(input.projectRoot))]);
    const a = await (await left.scope({ kind: 'case', label: 'same' })).directory('same');
    const b = await (await right.scope({ kind: 'case', label: 'same' })).directory('same');
    assert.notEqual(left.runId, right.runId);
    await fs.writeFile(path.join(b.path, 'active'), bytes);
    await left.finish({ status: 'passed' });
    await absent(a.path);
    assert.deepEqual(await fs.readFile(path.join(b.path, 'active')), bytes);
    assert.equal((await registry(left)).status, 'passed');
    await right.finish({ status: 'passed' });
    await absent(b.path);
    assert.equal((await registry(left)).status, 'passed');
});

// Registry creation must not follow an existing link into borrowed/evidence directories.
test('run admission rejects linked output boundaries without writing their targets', async t => {
    const input = await fixture(t);
    await fs.symlink(input.borrowed, path.join(input.projectRoot, 'test-results'));
    await assert.rejects(createRun(options(input.projectRoot)), /symbolic|boundary|symlink/);
    assert.deepEqual(await fs.readdir(input.borrowed), ['original']);
});

async function nativeChild(t, source, root, arguments_ = []) {
    const runtimePath = path.join(root, 'runtime.json');
    source = nativeSource(source, runtimePath);
    const sourcePath = path.join(root, 'native-consumer.test.mjs');
    await fs.writeFile(sourcePath, source, { flag: 'wx' });
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', ...arguments_, sourcePath], { cwd: path.join(repository, 'tests'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, output }));
    });
    const result = await exited;
    await fs.writeFile(path.join(root, 'native-output.log'), output);
    const runtime = nativeRuntime(runtimePath);
    t.diagnostic(JSON.stringify({ native: { command: [process.execPath, '--test', ...arguments_, sourcePath], cwd: path.join(repository, 'tests'), runtime, source, sourceSHA256: digest(source), ...result } }));
    return result;
}

for (const mode of ['passed', 'assertion', 'acquisition', 'cleanup', 'combined', 'hook', 'subtest']) {
    test(`managed Node entry automatically finalizes ${mode} tests`, async t => {
        const input = await fixture(t);
        const receipt = path.join(input.root, 'receipt.json');
        const entry = new URL('./node.js', import.meta.url).href;
        const providers = new URL('./resources/providers.js', import.meta.url).href;
        const result = await nativeChild(t, `
            import assert from 'node:assert/strict';
            import fs from 'node:fs/promises';
            import { test } from ${JSON.stringify(entry)};
            import { directoryProvider, registerProvider } from ${JSON.stringify(providers)};
            const mode = ${JSON.stringify(mode)};
            test('managed consumer', ${JSON.stringify(options(input.projectRoot))}, async (t, scope, run) => {
                const borrowed = await scope.borrowDirectory(${JSON.stringify(input.borrowed)});
                const definition = {
                    kind: 'native-fault-directory',
                    async allocate(handle) {
                        const owned = await directoryProvider.allocate(handle);
                        await fs.writeFile(${JSON.stringify(receipt)}, JSON.stringify({ path: owned.path, registryPath: run.registryPath, borrowed: borrowed.path }));
                        if (mode === 'acquisition' || mode === 'combined') throw new Error('native primary acquisition failure');
                        return owned;
                    },
                    async dispose(record) {
                        await directoryProvider.dispose(record);
                        if (mode === 'cleanup' || mode === 'combined') throw new Error('native cleanup failure');
                    },
                };
                registerProvider(definition);
                await scope.acquire({ ...definition, label: 'native-fault' });
                if (mode === 'hook') t.after(() => { throw new Error('native primary hook failure'); });
                if (mode === 'subtest') await t.test('native child', () => { assert.fail('native primary child failure'); });
                if (mode === 'assertion') assert.fail('native primary assertion failure');
            });
        `, input.root);
        assert.equal(result.signal, null);
        assert.equal(result.code, mode === 'passed' ? 0 : 1, result.output);
        const actual = JSON.parse(await fs.readFile(receipt, 'utf8'));
        await absent(actual.path);
        assert.deepEqual(await fs.readFile(path.join(actual.borrowed, 'original')), bytes);
        const summary = JSON.parse(await fs.readFile(actual.registryPath, 'utf8'));
        assert.equal(summary.status, mode === 'passed' ? 'passed' : 'failed');
        assert.equal(summary.errors.length, mode === 'passed' ? 0 : mode === 'combined' ? 2 : 1);
        if (mode === 'combined') {
            assert.equal(summary.errors[0].message, 'native primary acquisition failure');
            assert.equal(summary.errors[1].cause.message, 'native cleanup failure');
        }
        t.diagnostic(JSON.stringify({ mode, nativeExit: result.code, path: actual.path, resources: summary.resources.map(item => ({ owner: item.owner, state: item.state })) }));
    });
}

test('module import and unselected native registration do not allocate run resources', async t => {
    const input = await fixture(t);
    const entry = new URL('./node.js', import.meta.url).href;
    const source = `import { test } from ${JSON.stringify(entry)}; test('listed only', ${JSON.stringify(options(input.projectRoot))}, async () => { throw new Error('must not execute'); });`;
    const result = await nativeChild(t, source, input.root, ['--test-name-pattern=not-selected']);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await fs.readdir(input.projectRoot), []);
});

test('managed adapter import alone allocates no run resources', async t => {
    const input = await fixture(t);
    const entry = new URL('./node.js', import.meta.url).href;
    const result = await nativeChild(t, `import ${JSON.stringify(entry)};`, input.root);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.deepEqual(await fs.readdir(input.projectRoot), []);
});
