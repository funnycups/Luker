import assert from 'node:assert/strict';
import { property } from './failure-graph.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { nativeRuntime, nativeSource } from './native-runtime.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const scratch = path.join(repository, 'test-results', 'resource-native-outcomes');
const entry = new URL('../node.js', import.meta.url).href;
const providers = new URL('../resources/providers.js', import.meta.url).href;
const bytes = Buffer.from('original native outcome fixture\n\0\xff', 'latin1');
const sha = value => createHash('sha256').update(value).digest('hex');

function inventory(root) {
    return fs.readdirSync(root, { withFileTypes: true }).map(entry => {
        const target = path.join(root, entry.name);
        const stat = fs.lstatSync(target);
        const record = { name: entry.name, dev: stat.dev, ino: stat.ino };
        if (entry.isSymbolicLink()) record.link = fs.readlinkSync(target);
        else if (entry.isDirectory()) record.children = inventory(target);
        else {
            const value = fs.readFileSync(target);
            record.sha256 = sha(value);
            if (entry.name.endsWith('.json')) record.content = JSON.parse(value);
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
    const project = path.join(root, 'project');
    const borrowed = path.join(root, 'borrowed');
    fs.mkdirSync(project);
    fs.mkdirSync(borrowed);
    fs.writeFileSync(path.join(borrowed, 'original'), bytes);
    t.after(() => {
        const actual = fs.lstatSync(root);
        assert.equal(actual.dev, identity.dev);
        assert.equal(actual.ino, identity.ino);
        assert.equal(fs.realpathSync(root), root);
        assert.deepEqual(fs.readFileSync(path.join(borrowed, 'original')), bytes);
        t.diagnostic(JSON.stringify({ fixture: root, dev: actual.dev, ino: actual.ino, borrowedSHA256: sha(bytes), beforeOuterTeardown: inventory(root) }));
        for (const run of fs.readdirSync(path.join(project, 'test-results/harness/runs'))) {
            const directory = path.join(project, 'test-results/harness/runs', run);
            const stat = fs.lstatSync(directory);
            assert.equal(stat.isDirectory(), true);
            assert.equal(fs.realpathSync(directory), directory);
            fs.chmodSync(directory, 0o700);
        }
        fs.rmSync(root, { recursive: true });
        assert.equal(fs.existsSync(root), false);
    });
    return { root, project, borrowed };
}

async function native(t, fixture, body) {
    const runtimePath = path.join(fixture.root, 'runtime.json');
    const source = nativeSource(`
        import fs from 'node:fs';
        import path from 'node:path';
        import { test, after } from ${JSON.stringify(entry)};
        const input = ${JSON.stringify(fixture)};
        const options = { projectRoot: input.project, profile: 'resource-native-outcomes', command: [process.execPath, '--test', 'native.test.mjs'], source: 'exact-owned-native-outcome-fixture' };
        ${body}
    `, runtimePath);
    const filename = path.join(fixture.root, 'native.test.mjs');
    fs.writeFileSync(filename, source, { flag: 'wx' });
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const command = [process.execPath, '--test', filename];
    const child = spawn(command[0], command.slice(1), { cwd: path.join(repository, 'tests'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    fs.writeFileSync(path.join(fixture.root, 'native-output.log'), output);
    const runtime = nativeRuntime(runtimePath);
    t.diagnostic(JSON.stringify({ native: { command, cwd: path.join(repository, 'tests'), runtime, source, sourceSHA256: sha(source), output, ...result } }));
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, output);
    return output;
}

function errorNodes(error) {
    if (error?.type !== 'error') return [];
    return [error, ...(error.errors ?? []).flatMap(errorNodes), ...errorNodes(error.cause)];
}

test('Fix2 equal primitive body and managed hook failures retain distinct origins', async t => {
    const input = fixture(t);
    await native(t, input, `
        const callbacks = [];
        test('equal primitive failures', options, async (context, scope, run) => {
            await scope.borrowDirectory(input.borrowed);
            const owned = await scope.directory('equal-primitives');
            fs.writeFileSync(owned.path + '/payload', 'real equal-primitive payload');
            fs.writeFileSync(input.root + '/allocation.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath }));
            after(context, () => {
                callbacks.push('hook');
                fs.writeFileSync(input.root + '/callbacks.json', JSON.stringify(callbacks));
                throw 'same rejection';
            });
            callbacks.push('body');
            fs.writeFileSync(input.root + '/callbacks.json', JSON.stringify(callbacks));
            throw 'same rejection';
        });
    `);
    const receipt = JSON.parse(fs.readFileSync(path.join(input.root, 'allocation.json')));
    assert.equal(fs.existsSync(receipt.path), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(input.root, 'callbacks.json'))), ['body', 'hook']);
    const durable = JSON.parse(fs.readFileSync(receipt.registryPath));
    assert.equal(durable.status, 'failed');
    assert.deepEqual(durable.errors.map(error => ({ message: error.message, cause: error.cause })), [
        { message: 'Native test equal primitive failures rejected', cause: 'same rejection' },
        { message: 'Native hook for equal primitive failures rejected', cause: 'same rejection' },
    ]);
    assert.equal(durable.resources.find(resource => resource.owner === 'owned').state, 'disposed');
});

for (const stage of ['pre-publication', 'post-publication']) {
    test(`Fix2 native ${stage} persistence fault fails the command after cleanup`, async t => {
        const input = fixture(t);
        const output = await native(t, input, `
            import { createHook } from 'node:async_hooks';
            import { execFileSync } from 'node:child_process';
            import { registerProvider, directoryProvider } from ${JSON.stringify(providers)};
            import { serializeFailure } from ${JSON.stringify(new URL('../resources/errors.js', import.meta.url).href)};
            const stage = ${JSON.stringify(stage)};
            const primary = new Error('original native persistence failure');
            const cleanup = new Error('original native cleanup failure');
            let registryRoot;
            let hook;
            let injected;
            let injectionError;
            function descriptors() {
                return execFileSync('lsof', ['-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' });
            }
            function descriptorRecords(output) {
                let fd;
                const records = [];
                for (const line of output.split('\\n')) {
                    if (line.startsWith('f')) fd = line.slice(1);
                    if (line.startsWith('n')) records.push({ fd, path: line.slice(1) });
                }
                return records;
            }
            const completion = test('native persistence fault', options, async (context, scope, run) => {
                await scope.borrowDirectory(input.borrowed);
                const definition = { kind: 'native-persistence-directory', allocate: directoryProvider.allocate, async dispose(record) {
                    await directoryProvider.dispose(record);
                    if (stage === 'pre-publication') fs.chmodSync(registryRoot, 0o500);
                    throw cleanup;
                } };
                registerProvider(definition);
                const owned = await scope.acquire({ ...definition, label: 'native-persistence' });
                registryRoot = path.dirname(run.registryPath);
                fs.writeFileSync(owned.path + '/payload', 'real persistence payload');
                fs.writeFileSync(input.root + '/allocation.json', JSON.stringify({ path: owned.path, registryPath: run.registryPath, primary: serializeFailure(primary), cleanup: serializeFailure(cleanup) }));
                fs.writeFileSync(input.root + '/before-registry.json', fs.readFileSync(run.registryPath));
                fs.writeFileSync(input.root + '/before-lsof.log', descriptors());
                if (stage === 'post-publication') {
                    hook = createHook({ init(id, type) {
                        if (injected || !type.startsWith('FSREQ')) return;
                        const stack = new Error('actual owned directory fsync dispatch').stack;
                        if (!stack.includes('fsync') || !stack.includes('/resources/registry.js:')) return;
                        try {
                            const descriptor = descriptorRecords(descriptors()).find(item => item.path === registryRoot && /^\\d+$/.test(item.fd));
                            if (!descriptor) throw new Error('Owned directory descriptor was absent at actual fsync dispatch');
                            const actual = fs.fstatSync(Number(descriptor.fd));
                            const expected = fs.lstatSync(registryRoot);
                            if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Owned directory descriptor identity differs from registered root');
                            injected = { descriptor, dev: actual.dev, ino: actual.ino, stack, publishedRegistry: JSON.parse(fs.readFileSync(run.registryPath)) };
                            fs.closeSync(Number(descriptor.fd));
                        } catch (error) { injectionError = error; }
                    } });
                    hook.enable();
                }
                throw primary;
            });
            function observed(status, value) {
                hook?.disable();
                const after = descriptors();
                fs.writeFileSync(input.root + '/after-lsof.log', after);
                fs.writeFileSync(input.root + '/completion.json', JSON.stringify({ status, value: serializeFailure(value), injected, injectionError: injectionError && serializeFailure(injectionError), ownedDescriptors: descriptorRecords(after).filter(item => item.path.startsWith(input.root + path.sep)) }));
            }
            // This observer records the original finalization promise; the adapter's
            // native final hook still receives its rejection and fails the command.
            completion.then(value => observed('fulfilled', value), error => observed('rejected', error));
        `);
        const allocation = JSON.parse(fs.readFileSync(path.join(input.root, 'allocation.json')));
        const completion = JSON.parse(fs.readFileSync(path.join(input.root, 'completion.json')));
        const before = fs.readFileSync(path.join(input.root, 'before-registry.json'));
        const after = fs.readFileSync(allocation.registryPath);
        const durable = JSON.parse(after);
        const errors = [completion.value, ...durable.errors].flatMap(errorNodes);
        assert.equal(completion.status, 'rejected');
        assert.equal(completion.injectionError, undefined);
        assert.deepEqual(completion.ownedDescriptors, []);
        assert.equal(fs.existsSync(allocation.path), false);
        assert.deepEqual(fs.readdirSync(path.dirname(allocation.path)), []);
        assert.deepEqual(fs.readdirSync(path.dirname(allocation.registryPath)).filter(name => name.endsWith('.tmp')), []);
        for (const original of [allocation.primary, allocation.cleanup]) {
            const actual = errors.find(error => error.message === original.message);
            assert.ok(actual, original.message);
            assert.equal(actual.stack, original.stack);
        }
        assert.ok(output.includes('Managed native resource finalization failed'), output);
        if (stage === 'pre-publication') {
            assert.deepEqual(after, before);
            assert.equal(durable.status, 'running');
            assert.ok(errors.some(error => property(error.publication, 'stage') === 'prepare' && property(error.publication, 'published') === false));
            assert.ok(errors.some(error => error.code === 'EACCES'));
        } else {
            assert.notEqual(sha(after), sha(before));
            assert.equal(durable.status, 'failed');
            assert.ok(completion.injected);
            assert.ok(errors.some(error => property(error.publication, 'stage') === 'durability' && property(error.publication, 'published') === true));
            assert.ok(errors.some(error => error.code === 'EBADF'));
        }
        t.diagnostic(JSON.stringify({ stage, beforeRegistrySHA256: sha(before), afterRegistrySHA256: sha(after), completion, durable }));
    });
}
