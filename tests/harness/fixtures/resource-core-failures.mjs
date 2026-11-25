import assert from 'node:assert/strict';
import { property } from './failure-graph.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { spawn, execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRun } from '../resources/run.js';
import { directoryProvider, registerProvider } from '../resources/providers.js';
import { nativeRuntime, nativeSource } from './native-runtime.mjs';

const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const scratch = path.join(repository, 'test-results', 'resource-core-fix1');
const borrowedBytes = Buffer.from('exact borrowed fault fixture\n\0\xff', 'latin1');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const options = projectRoot => ({ projectRoot, profile: 'resource-core-failures', command: [process.execPath, '--test', 'harness/resource-scope.test.mjs'], source: 'owned-failure-fixture' });
const readRegistry = run => JSON.parse(fs.readFileSync(run.registryPath, 'utf8'));
const exists = target => fs.existsSync(target);

function inventory(root) {
    return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
        const location = path.join(root, entry.name);
        const stat = fs.lstatSync(location);
        const item = { name: entry.name, dev: stat.dev, ino: stat.ino };
        if (entry.isSymbolicLink()) item.link = fs.readlinkSync(location);
        else if (entry.isDirectory()) item.children = inventory(location);
        else {
            const bytes = fs.readFileSync(location);
            item.sha256 = sha(bytes);
            if (entry.name === 'registry.json') {
                try { item.registry = JSON.parse(bytes); }
                catch (error) { item.registryReadError = error.message; item.bytesBase64 = bytes.toString('base64'); }
            }
        }
        return item;
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
        t.diagnostic(JSON.stringify({ fixture: root, dev: identity.dev, ino: identity.ino, beforeOuterTeardown: inventory(root), borrowedSHA256: sha(borrowedBytes) }));
        fs.rmSync(root, { recursive: true });
        assert.equal(exists(root), false);
    });
    return { root, projectRoot, borrowed };
}

function faultProvider(allocate, dispose = directoryProvider.dispose) {
    const definition = { kind: `failure-directory-${randomUUID()}`, allocate, dispose };
    registerProvider(definition);
    return definition;
}

async function caught(operation) {
    try {
        await operation;
    } catch (error) {
        return error;
    }
    return undefined;
}

function messages(error) {
    return [error?.message, ...(error?.errors ?? []).flatMap(messages), ...(error?.cause instanceof Error ? messages(error.cause) : [])].filter(value => value !== undefined);
}

async function child(source, root, t) {
    const runtimePath = path.join(root, 'runtime.json');
    source = nativeSource(source, runtimePath);
    const sourcePath = path.join(root, 'native-failure.test.mjs');
    fs.writeFileSync(sourcePath, source, { flag: 'wx' });
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const process_ = spawn(process.execPath, ['--test', sourcePath], { cwd: path.join(repository, 'tests'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    process_.stdout.setEncoding('utf8');
    process_.stderr.setEncoding('utf8');
    process_.stdout.on('data', chunk => { output += chunk; });
    process_.stderr.on('data', chunk => { output += chunk; });
    const result = await new Promise((resolve, reject) => {
        process_.once('error', reject);
        process_.once('close', (code, signal) => resolve({ code, signal, output }));
    });
    fs.writeFileSync(path.join(root, 'native-output.log'), output);
    const runtime = nativeRuntime(runtimePath);
    t.diagnostic(JSON.stringify({ native: { command: [process.execPath, '--test', sourcePath], cwd: path.join(repository, 'tests'), runtime, source, sourceSHA256: sha(Buffer.from(source)), ...result } }));
    return result;
}

const entry = new URL('../node.js', import.meta.url).href;
const providers = new URL('../resources/providers.js', import.meta.url).href;

for (const [name, expression, original] of [
    ['string', '\'body failure\'', 'body failure'],
    ['object', '({ detail: \'object body failure\', code: \'E_BODY\' })', 'object body failure'],
    ['undefined', 'undefined', 'undefined'],
    ['null', 'null', 'null'],
    ['number', '17', '17'],
    ['boolean', 'false', 'false'],
    ['bigint', '123n', '123'],
    ['symbol', 'Symbol(\'symbol body failure\')', 'symbol body failure'],
    ['NaN', 'NaN', 'NaN'],
    ['infinity', 'Infinity', 'Infinity'],
    ['negative zero', '-0', '-0'],
    ['function', 'function rejectedFunction() {}', 'rejectedFunction'],
    ['cyclic object', '(() => { const value = { detail: \'cyclic body failure\' }; value.self = value; return value; })()', 'cyclic body failure'],
]) {
    test(`Fix1 native ${name} rejection finalizes its payload and registered peer`, async t => {
        const input = fixture(t);
        const receipts = path.join(input.root, 'receipts.json');
        const result = await child(`
            import fs from 'node:fs';
            import { test } from ${JSON.stringify(entry)};
            const receipts = [];
            const options = ${JSON.stringify(options(input.projectRoot))};
            for (const name of ['failed', 'peer']) test(name, options, async (t, scope, run) => {
                const owned = await scope.directory(name);
                fs.writeFileSync(owned.path + '/data', name);
                receipts.push({ name, path: owned.path, registryPath: run.registryPath });
                fs.writeFileSync(${JSON.stringify(receipts)}, JSON.stringify(receipts));
                if (name === 'failed') throw ${expression};
            });
        `, input.root, t);
        assert.equal(result.signal, null);
        assert.equal(result.code, 1, result.output);
        const actual = JSON.parse(fs.readFileSync(receipts));
        assert.deepEqual(actual.map(item => item.name), ['failed', 'peer']);
        for (const item of actual) assert.equal(exists(item.path), false, `${item.name} retained ${item.path}`);
        const failed = JSON.parse(fs.readFileSync(actual[0].registryPath));
        assert.equal(failed.status, 'failed');
        assert.ok(JSON.stringify(failed.errors).includes(original), JSON.stringify(failed.errors));
        assert.equal(JSON.parse(fs.readFileSync(actual[1].registryPath)).status, 'passed');
    });
}

test('Fix1 created but unpublished directories retain truthful unresolved ownership', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'unpublished' });
    const primary = new Error('failed before identity publication');
    let directory;
    const definition = faultProvider(async handle => {
        directory = handle.directoryPath;
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'partial'), 'created without publication');
        throw primary;
    });
    const acquisition = await caught(scope.acquire({ ...definition, label: 'unpublished' }));
    const first = await caught(scope.dispose());
    const second = await caught(scope.dispose());
    const summary = await run.finish({ status: 'passed' });
    t.diagnostic(JSON.stringify({ acquisitionMessages: messages(acquisition), cleanupMessages: messages(first), diskExists: exists(directory), durable: readRegistry(run) }));
    assert.equal(summary.status, 'failed');
    if (exists(directory)) {
        assert.equal(summary.resources[0].state, 'cleanup-failed');
        assert.equal(summary.resources[0].locator.path, directory);
        assert.ok(first instanceof AggregateError);
        assert.equal(second, first);
        assert.ok(messages(acquisition).includes(primary.message));
        assert.ok(messages(first).some(message => /ownership|unpublished|identity/.test(message)));
        assert.equal(fs.readFileSync(path.join(directory, 'partial'), 'utf8'), 'created without publication');
    } else {
        assert.equal(summary.resources[0].state, 'disposed');
    }
});

test('Fix1 actual identity-publication failure cannot claim an unreleased allocation disposed', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'publication-failure' });
    let directory;
    let dataRoot;
    const definition = faultProvider(async handle => {
        directory = handle.directoryPath;
        dataRoot = path.dirname(directory);
        return directoryProvider.allocate({ ...handle, publish: async locator => {
            fs.chmodSync(dataRoot, 0o000);
            return handle.publish(locator);
        } });
    });
    let acquisition;
    try {
        acquisition = await caught(scope.acquire({ ...definition, label: 'publication-failure' }));
    } finally {
        fs.chmodSync(dataRoot, 0o700);
    }
    const disposal = await caught(scope.dispose());
    const summary = await run.finish({ status: 'passed' });
    assert.ok(messages(acquisition).some(message => /EACCES/.test(message)), messages(acquisition).join('\n'));
    assert.equal(exists(directory), true);
    assert.equal(summary.resources[0].state, 'cleanup-failed');
    assert.equal(summary.resources[0].locator.path, directory);
    assert.ok(disposal instanceof AggregateError);
    assert.equal(await caught(scope.dispose()), disposal);
});

test('Fix1 original empty aggregate acquisition remains a failed event when caught', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'empty-aggregate' });
    const original = new AggregateError([], 'original empty aggregate', { cause: new Error('aggregate root cause') });
    const definition = faultProvider(async handle => {
        await directoryProvider.allocate(handle);
        throw original;
    });
    assert.equal(await caught(scope.acquire({ ...definition, label: 'empty-aggregate' })), original);
    const summary = await run.finish({ status: 'passed' });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.errors, [original]);
    const durable = readRegistry(run).errors[0];
    assert.equal(durable.message, original.message);
    assert.equal(durable.stack, original.stack);
    assert.deepEqual(durable.errors, []);
    assert.equal(durable.cause.message, 'aggregate root cause');
});

test('Fix1 nested and distinct aggregate contexts sharing a leaf are preserved', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const leaf = new Error('shared leaf');
    const a = new AggregateError([new AggregateError([leaf], 'nested context')], 'context A', { cause: 'A cause' });
    const b = new AggregateError([leaf], 'context B', { cause: null });
    run.recordError(a);
    run.recordError(b);
    run.recordError(a);
    const summary = await run.finish({ status: 'failed', error: a });
    assert.deepEqual(summary.errors, [a, b]);
    const durable = readRegistry(run);
    assert.equal(durable.errors[0].message, 'context A');
    assert.equal(durable.errors[0].errors[0].message, 'nested context');
    assert.equal(durable.errors[0].errors[0].errors[0].message, 'shared leaf');
    assert.equal(durable.errors[1].message, 'context B');
    assert.equal(durable.errors[1].cause, null);
});

for (const cause of [null, 'literal cause', 37, false, new Error('error cause')]) {
    test(`Fix1 durable Error cause ${String(cause)} coexists with cleanup failure`, async t => {
        const input = fixture(t);
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: 'error-cause' });
        const primary = new Error('primary with explicit cause', { cause });
        const cleanup = new Error('distinct cleanup with null cause', { cause: null });
        const definition = faultProvider(directoryProvider.allocate, async record => {
            await directoryProvider.dispose(record);
            throw cleanup;
        });
        const owned = await scope.acquire({ ...definition, label: 'error-cause' });
        const summary = await run.finish({ status: 'failed', error: primary });
        assert.equal(exists(owned.path), false);
        assert.equal(summary.errors[0], primary);
        assert.equal(summary.errors[1].cause, cleanup);
        const durable = readRegistry(run);
        assert.equal(durable.status, 'failed');
        if (cause instanceof Error) {
            assert.equal(durable.errors[0].cause.name, cause.name);
            assert.equal(durable.errors[0].cause.message, cause.message);
            assert.equal(durable.errors[0].cause.stack, cause.stack);
        } else assert.deepEqual(durable.errors[0].cause, cause);
        assert.equal(durable.errors[1].cause.message, cleanup.message);
        assert.equal(durable.errors[1].cause.cause, null);
    });
}

for (const mode of ['children', 'body-hook-cleanup']) {
    test(`Fix1 native original ${mode} content survives automatic finalization`, async t => {
        const input = fixture(t);
        const receipt = path.join(input.root, 'receipt.json');
        const origins = path.join(input.root, 'original-errors.json');
        const result = await child(`
            import fs from 'node:fs';
            import assert from 'node:assert/strict';
            import { test, after, subtest } from ${JSON.stringify(entry)};
            import { registerProvider, directoryProvider } from ${JSON.stringify(providers)};
            const mode = ${JSON.stringify(mode)};
            const originals = [];
            function original(message) {
                const error = new Error(message);
                originals.push({ name: error.name, message: error.message, stack: error.stack });
                fs.writeFileSync(${JSON.stringify(origins)}, JSON.stringify(originals));
                return error;
            }
            test('original failures', ${JSON.stringify(options(input.projectRoot))}, async (t, scope, run) => {
                const definition = { kind: 'native-originals', allocate: directoryProvider.allocate, async dispose(record) {
                    await directoryProvider.dispose(record);
                    if (mode === 'body-hook-cleanup') throw original('original cleanup failure');
                } };
                registerProvider(definition);
                const owned = await scope.acquire({ ...definition, label: 'native-originals' });
                fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
                if (mode === 'children') {
                    await subtest(t, 'child A', function (actual) {
                        assert.equal(this, actual);
                        assert.notEqual(actual, t);
                        assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(t));
                        assert.equal(actual.name, 'child A');
                        throw original('original child A failure');
                    });
                    await subtest(t, 'child B', function (actual) {
                        assert.equal(this, actual);
                        assert.notEqual(actual, t);
                        assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(t));
                        assert.equal(actual.name, 'child B');
                        throw original('original child B failure');
                    });
                } else {
                    after(t, function (actual) {
                        assert.equal(actual, t);
                        assert.equal(this, t);
                        throw original('original hook failure');
                    });
                    throw original('original body failure');
                }
            });
        `, input.root, t);
        assert.equal(result.code, 1, result.output);
        assert.equal(result.signal, null);
        const actual = JSON.parse(fs.readFileSync(receipt));
        assert.equal(exists(actual.path), false);
        const durable = JSON.parse(fs.readFileSync(actual.registryPath));
        const expected = mode === 'children' ? ['original child A failure', 'original child B failure'] : ['original body failure', 'original hook failure', 'original cleanup failure'];
        for (const message of expected) {
            assert.ok(JSON.stringify(durable.errors).includes(message), JSON.stringify(durable.errors));
            assert.ok(JSON.stringify(durable.errors).includes('native-failure.test.mjs'), JSON.stringify(durable.errors));
        }
        const originalErrors = JSON.parse(fs.readFileSync(origins));
        function errorNodes(error) {
            return [error, ...(error.errors ?? []).flatMap(errorNodes), ...(error.cause?.type === 'error' ? errorNodes(error.cause) : [])];
        }
        const stored = durable.errors.flatMap(errorNodes);
        for (const original of originalErrors) {
            const actual = stored.find(error => error.message === original.message);
            assert.ok(actual, original.message);
            assert.equal(actual.name, original.name);
            assert.equal(actual.stack, original.stack);
        }
        assert.equal(durable.status, 'failed');
    });
}

async function interleave(t, matches, mutation, operation) {
    let admitted = false;
    let callbackError;
    let stack;
    const hook = createHook({ init(id, type) {
        if (admitted || !type.startsWith('FSREQ')) return;
        const actual = new Error('actual mutation scheduling boundary').stack;
        if (!matches(actual)) return;
        admitted = true;
        stack = actual;
        try { mutation(); } catch (error) { callbackError = error; }
    } });
    hook.enable();
    let result;
    try { result = await caught(operation()); } finally { hook.disable(); }
    t.diagnostic(JSON.stringify({ actualInterleavingAdmitted: admitted, stack, callbackError: callbackError?.stack, operationError: messages(result) }));
    if (callbackError) throw callbackError;
    return { admitted, error: result };
}

test('Fix1 actual allocation scheduling cannot write through a replaced ancestor', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'allocate-race' });
    const data = path.join(path.dirname(run.registryPath), 'data');
    const moved = `${data}-original`;
    const result = await interleave(t, stack => stack.includes('at Object.mkdir (') && stack.includes('/resources/providers.js:'), () => {
        fs.renameSync(data, moved);
        fs.symlinkSync(input.borrowed, data);
    }, () => scope.directory('race'));
    const borrowedEntries = fs.readdirSync(input.borrowed).sort();
    if (result.admitted) {
        fs.unlinkSync(data);
        fs.renameSync(moved, data);
    }
    await run.finish({ status: result.error ? 'failed' : 'passed', ...(result.error ? { error: result.error } : {}) });
    assert.deepEqual(borrowedEntries, ['original']);
    assert.deepEqual(fs.readFileSync(path.join(input.borrowed, 'original')), borrowedBytes);
});

test('Fix1 actual recursive removal scheduling preserves a replacement directory', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'remove-race' });
    const owned = await scope.directory('race');
    fs.writeFileSync(path.join(owned.path, 'owned-original'), 'owned original bytes');
    const moved = `${owned.path}-original`;
    const replacement = path.join(input.root, 'replacement');
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, 'replacement-bytes'), borrowedBytes);
    const result = await interleave(t, stack => stack.includes('at Object.rm (') && stack.includes('/resources/providers.js:'), () => {
        fs.renameSync(owned.path, moved);
        fs.renameSync(replacement, owned.path);
    }, () => scope.dispose());
    await run.finish({ status: result.error ? 'failed' : 'passed', ...(result.error ? { error: result.error } : {}) });
    const protectedPath = result.admitted ? owned.path : replacement;
    assert.deepEqual(fs.readFileSync(path.join(protectedPath, 'replacement-bytes')), borrowedBytes);
    if (result.admitted) {
        assert.equal(fs.readFileSync(path.join(moved, 'owned-original'), 'utf8'), 'owned original bytes');
        assert.equal(readRegistry(run).resources[0].state, 'cleanup-failed');
    } else assert.equal(exists(owned.path), false);
});

test('Fix1 registry publication scheduling preserves a replaced destination', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const original = fs.readFileSync(run.registryPath);
    const moved = `${run.registryPath}-original`;
    const replacement = path.join(input.root, 'replacement-registry');
    fs.writeFileSync(replacement, borrowedBytes);
    const result = await interleave(t, stack => stack.includes('writeFileHandle') && stack.includes('/resources/registry.js:'), () => {
        fs.renameSync(run.registryPath, moved);
        fs.renameSync(replacement, run.registryPath);
    }, () => run.finish({ status: 'passed' }));
    assert.deepEqual(fs.readFileSync(result.admitted ? run.registryPath : replacement), borrowedBytes);
    if (result.admitted) {
        assert.deepEqual(fs.readFileSync(moved), original);
        assert.ok(result.error instanceof AggregateError);
    } else assert.equal(readRegistry(run).status, 'passed');
});

test('Fix1 strict Outcome validation remains resource-free until a valid finish', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'strict-outcome' });
    const owned = await scope.directory('case');
    await assert.rejects(run.finish({ status: 'failed', error: 'not an Error' }), TypeError);
    assert.equal(exists(owned.path), true);
    await run.finish({ status: 'passed' });
    assert.equal(exists(owned.path), false);
});

function openDescriptors() {
    const output = execFileSync('lsof', ['-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
    let fd;
    const records = [];
    for (const line of output.split('\n')) {
        if (line.startsWith('f')) fd = line.slice(1);
        if (line.startsWith('n')) records.push({ fd, path: line.slice(1) });
    }
    return records;
}

function publicationContexts(error) {
    return [
        ...(error?.publication ? [error.publication] : []),
        ...(error?.errors ?? []).flatMap(publicationContexts),
        ...(error?.cause instanceof Error ? publicationContexts(error.cause) : []),
    ];
}

for (const stage of ['pre-publication', 'post-publication']) {
    test(`Fix1 real ${stage} I/O retains primary cleanup and persistence evidence`, async t => {
        const input = fixture(t);
        const run = await createRun(options(input.projectRoot));
        const scope = await run.scope({ kind: 'case', label: stage });
        const registryRoot = path.dirname(run.registryPath);
        const primary = new Error(`original ${stage} failure`);
        const cleanup = new Error(`cleanup ${stage} failure`);
        const definition = faultProvider(directoryProvider.allocate, async record => {
            await directoryProvider.dispose(record);
            if (stage === 'pre-publication') fs.chmodSync(registryRoot, 0o500);
            throw cleanup;
        });
        const owned = await scope.acquire({ ...definition, label: stage });
        const before = fs.readFileSync(run.registryPath);
        const descriptorsBefore = openDescriptors();
        let injected;
        const hook = createHook({ init(id, type) {
            if (stage !== 'post-publication' || injected || !type.startsWith('FSREQ')) return;
            const stack = new Error('real directory fsync dispatch').stack;
            if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
            const descriptor = openDescriptors().find(item => item.path === registryRoot && /^\d+$/.test(item.fd));
            if (!descriptor) return;
            const actual = fs.fstatSync(Number(descriptor.fd));
            const expected = fs.lstatSync(registryRoot);
            assert.equal(actual.dev, expected.dev);
            assert.equal(actual.ino, expected.ino);
            injected = { descriptor, dev: actual.dev, ino: actual.ino, stack, currentRegistry: JSON.parse(fs.readFileSync(run.registryPath)) };
            fs.closeSync(Number(descriptor.fd));
        } });
        let summary;
        let failure;
        hook.enable();
        try {
            try { summary = await run.finish({ status: 'failed', error: primary }); }
            catch (error) { failure = error; }
        } finally {
            hook.disable();
            fs.chmodSync(registryRoot, 0o700);
        }
        const after = fs.readFileSync(run.registryPath);
        const descriptorsAfter = openDescriptors();
        const errors = summary?.errors ?? failure.errors;
        const allMessages = errors.flatMap(messages);
        const contexts = errors.flatMap(publicationContexts);
        t.diagnostic(JSON.stringify({ stage, beforeSHA256: sha(before), afterSHA256: sha(after), injected, errors: allMessages, contexts, descriptorsBefore, descriptorsAfter, durableAfter: JSON.parse(after), payloadExists: exists(owned.path) }));
        assert.equal(exists(owned.path), false);
        assert.ok(allMessages.includes(primary.message), allMessages.join('\n'));
        assert.ok(allMessages.includes(cleanup.message), allMessages.join('\n'));
        assert.deepEqual(descriptorsAfter.filter(item => item.path.startsWith(input.root + path.sep)), []);
        assert.deepEqual(fs.readdirSync(registryRoot).filter(name => name.endsWith('.tmp')), []);
        if (stage === 'pre-publication') {
            assert.ok(failure instanceof AggregateError);
            assert.deepEqual(after, before);
            assert.ok(allMessages.some(message => /EACCES/.test(message)));
            assert.ok(contexts.some(context => context.published === false));
        } else {
            assert.ok(injected, 'the real directory fsync descriptor was not observed');
            assert.equal(summary.status, 'failed');
            assert.notEqual(sha(before), sha(after));
            assert.equal(JSON.parse(after).status, 'failed');
            assert.ok(allMessages.some(message => /EBADF/.test(message)));
            assert.ok(contexts.some(context => context.published === true && context.stage === 'durability'));
        }
    });
}

test('Fix1 concurrent managed native peers finalize independently while cleanup is delayed', async t => {
    const input = fixture(t);
    const receipt = path.join(input.root, 'concurrent.json');
    const result = await child(`
        import fs from 'node:fs';
        import assert from 'node:assert/strict';
        import { test as nativeTest } from 'node:test';
        import { test } from ${JSON.stringify(entry)};
        import { directoryProvider, registerProvider } from ${JSON.stringify(providers)};
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const receipts = [];
        const options = ${JSON.stringify(options(input.projectRoot))};
        const delayedProvider = { kind: 'delayed-native-directory', allocate: directoryProvider.allocate, async dispose(record) {
            entered.resolve();
            await release.promise;
            await directoryProvider.dispose(record);
        } };
        registerProvider(delayedProvider);
        nativeTest('concurrent native parent', { concurrency: true }, async () => {
            const results = ['delayed', 'failed', 'passed'].map(name => test(name, options, async (context, scope, run) => {
                const owned = name === 'delayed' ? await scope.acquire({ ...delayedProvider, label: name }) : await scope.directory(name);
                receipts.push({ name, path: owned.path, registryPath: run.registryPath });
                fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ receipts }));
                if (name === 'failed') throw new Error('concurrent original failure');
            }));
            await entered.promise;
            try {
                const [failed, passed] = await Promise.all([results[1], results[2]]);
                assert.equal(failed.status, 'failed');
                assert.equal(failed.errors[0].message, 'concurrent original failure');
                assert.equal(passed.status, 'passed');
                assert.ok(fs.existsSync(receipts.find(item => item.name === 'delayed').path));
                assert.ok(!fs.existsSync(receipts.find(item => item.name === 'failed').path));
                assert.ok(!fs.existsSync(receipts.find(item => item.name === 'passed').path));
                fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ receipts, checkpoint: 'peers finalized while delayed cleanup remained owned' }));
            } finally {
                release.resolve();
            }
            assert.equal((await results[0]).status, 'passed');
        });
    `, input.root, t);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null);
    const actual = JSON.parse(fs.readFileSync(receipt));
    assert.equal(actual.checkpoint, 'peers finalized while delayed cleanup remained owned');
    const receipts = actual.receipts;
    assert.equal(new Set(receipts.map(item => item.path)).size, 3);
    assert.equal(new Set(receipts.map(item => item.registryPath)).size, 3);
    for (const item of receipts) {
        assert.equal(exists(item.path), false);
        const durable = JSON.parse(fs.readFileSync(item.registryPath));
        assert.equal(durable.status, item.name === 'failed' ? 'failed' : 'passed');
        if (item.name === 'failed') assert.equal(durable.errors[0].message, 'concurrent original failure');
    }
});

for (const mode of ['structured rejection', 'Error cause']) {
    test(`Fix2 literal own __proto__ survives ${mode} publication`, async t => {
        const input = fixture(t);
        const result = await child(`
            import fs from 'node:fs';
            import { test } from ${JSON.stringify(entry)};
            const input = ${JSON.stringify(input)};
            test('literal own-property failure', ${JSON.stringify(options(input.projectRoot))}, async (context, scope, run) => {
                await scope.borrowDirectory(input.borrowed);
                const owned = await scope.directory('own-property');
                fs.writeFileSync(owned.path + '/payload', 'real own-property payload');
                const value = JSON.parse('{"__proto__":{"detail":"original cause data"},"ordinary":"ordinary cause data"}');
                value.self = value;
                const error = ${JSON.stringify(mode)} === 'Error cause' ? new Error('original structured cause', { cause: value }) : value;
                if (error instanceof Error) Object.defineProperty(error, '__proto__', { value: { detail: 'original error data' }, enumerable: true });
                fs.writeFileSync(input.root + '/allocation.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath, keys: Object.keys(value), originalStack: error.stack }));
                throw error;
            });
        `, input.root, t);
        assert.equal(result.code, 1, result.output);
        assert.equal(result.signal, null);
        const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'allocation.json')));
        assert.equal(fs.existsSync(receipt.path), false);
        assert.deepEqual(receipt.keys, ['__proto__', 'ordinary', 'self']);
        const durable = JSON.parse(fs.readFileSync(receipt.registryPath));
        assert.equal(durable.status, 'failed');
        const original = durable.errors[0];
        const cause = original.cause;
        assert.equal(cause.type, 'object');
        assert.ok(cause.properties.some(entry => entry.name === '__proto__'));
        assert.deepEqual(cause.properties.map(entry => entry.name), ['__proto__', 'ordinary', 'self']);
        assert.equal(property(property(cause, '__proto__'), 'detail'), 'original cause data');
        assert.equal(property(cause, 'ordinary'), 'ordinary cause data');
        assert.deepEqual(property(cause, 'self'), { type: 'reference', ref: cause.id });
        if (mode === 'Error cause') {
            assert.equal(original.stack, receipt.originalStack);
            assert.ok(original.properties.some(entry => entry.name === '__proto__'));
            assert.equal(property(property(original, '__proto__'), 'detail'), 'original error data');
        }
    });
}

test('Fix3 rejected borrow publication remains registered for scope release', async t => {
    const input = fixture(t);
    const run = await createRun(options(input.projectRoot));
    const scope = await run.scope({ kind: 'case', label: 'borrow-publication' });
    const registryRoot = path.dirname(run.registryPath);
    const before = fs.readFileSync(run.registryPath);
    let publication;
    try {
        fs.chmodSync(registryRoot, 0o500);
        publication = await caught(scope.borrowDirectory(input.borrowed));
    } finally {
        fs.chmodSync(registryRoot, 0o700);
    }
    assert.ok(publication instanceof AggregateError);
    assert.ok(messages(publication).some(message => message.includes('EACCES')));
    assert.deepEqual(fs.readFileSync(run.registryPath), before);
    const summary = await run.finish({ status: 'passed' });
    const durable = readRegistry(run);
    t.diagnostic(JSON.stringify({ beforeSHA256: sha(before), afterSHA256: sha(fs.readFileSync(run.registryPath)), publication: messages(publication), durable }));
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.errors, [publication]);
    assert.equal(durable.errors[0].message, publication.message);
    assert.equal(durable.errors[0].stack, publication.stack);
    assert.deepEqual(durable.resources.map(record => ({ owner: record.owner, state: record.state, path: record.locator.path })), [
        { owner: 'borrowed', state: 'released', path: input.borrowed },
    ]);
    assert.deepEqual(fs.readFileSync(path.join(input.borrowed, 'original')), borrowedBytes);
});
