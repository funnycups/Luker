import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from './node.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const harness = new URL('./', import.meta.url);
const options = {
    projectRoot: repository, profile: 'jest-lifecycle-observer',
    command: [process.execPath, '--test', 'harness/jest-lifecycle.test.mjs'],
    source: 'tests/harness/jest-lifecycle.test.mjs',
};

for (const mode of ['passed', 'resource-error', 'undefined-rejection', 'native-assertion', 'repeated-resource-error']) {
    test(`Jest lifecycle preserves ${mode} through its native command outcome`, options, async (t, scope) => {
        const directory = await scope.directory(`Jest ${mode}`);
        const receipt = path.join(directory.path, 'receipt.jsonl');
        const observed = path.join(directory.path, 'native-outcome.jsonl');
        const resultPath = path.join(directory.path, 'jest-result.json');
        const environmentPath = path.join(directory.path, 'observing-environment.mjs');
        fs.writeFileSync(environmentPath, `
            import fs from 'node:fs';
            import ManagedEnvironment from ${JSON.stringify(new URL('jest-environment.js', harness).href)};
            export default class extends ManagedEnvironment {
                async handleTestEvent(event, state) {
                    if (event.name === 'test_done') fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ errors: event.test.errors.length }) + '\\n');
                    return super.handleTestEvent(event, state);
                }
            }
        `);
        const config = path.join(directory.path, 'jest.config.json');
        fs.writeFileSync(config, JSON.stringify({
            rootDir: directory.path, transform: {}, testEnvironment: environmentPath,
            testEnvironmentOptions: { resourceProjectRoot: directory.path },
            setupFilesAfterEnv: [fileURLToPath(new URL('jest-run.js', harness))],
            testMatch: ['**/case*.test.mjs'],
        }));
        const fixture = `
            import fs from 'node:fs';
            import assert from 'node:assert/strict';
            import { testWithResources } from ${JSON.stringify(new URL('jest.js', harness).href)};
            import { ensureRun } from ${JSON.stringify(new URL('jest-run.js', harness).href)};
            import { directoryProvider, registerProvider } from ${JSON.stringify(new URL('resources/providers.js', harness).href)};
            testWithResources('actual managed callback', async scope => {
                const run = await ensureRun();
                const owned = await scope.directory('observed owned directory');
                fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ registryPath: run.registryPath, ownedPath: owned.path }) + '\\n');
                if (${JSON.stringify(['resource-error', 'repeated-resource-error'].includes(mode))}) {
                    const definition = {
                        kind: 'jest-native-acquisition-failure',
                        async allocate(handle) { await directoryProvider.allocate(handle); throw new Error('actual registered acquisition rejection'); },
                        dispose: directoryProvider.dispose,
                    };
                    registerProvider(definition);
                    await expect(scope.acquire({ ...definition, label: 'rejected directory' })).rejects.toThrow('actual registered acquisition rejection');
                }
                if (${JSON.stringify(mode)} === 'undefined-rejection') throw undefined;
                if (${JSON.stringify(mode)} === 'native-assertion') assert.equal('actual', 'expected', 'actual native assertion must be retained');
                expect(fs.statSync(owned.path).isDirectory()).toBe(true);
            });
        `;
        const fixtures = mode === 'repeated-resource-error' ? ['case.test.mjs', 'case-again.test.mjs'] : ['case.test.mjs'];
        for (const file of fixtures) fs.writeFileSync(path.join(directory.path, file), fixture);
        const cli = path.join(repository, 'tests/node_modules/jest/bin/jest.js');
        const environment = { ...process.env, LUKER_TEST_PROFILE: 'jest-lifecycle-fixture' };
        delete environment.NODE_TEST_CONTEXT;
        let child;
        let closed;
        await scope.onFinalize({
            label: `actual Jest ${mode}`, stage: 'drain',
            callback: async () => {
                if (!child) return;
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
                await closed;
            },
        });
        child = spawn(process.execPath, ['--experimental-vm-modules', cli, '--config', config, '--runInBand', '--json', '--outputFile', resultPath], {
            cwd: directory.path, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.on('data', bytes => { output += bytes; });
        closed = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
        const exit = await closed;
        t.diagnostic(JSON.stringify({ mode, exit, output }));
        assert.equal(exit.signal, null, output);
        assert.equal(exit.code, mode === 'passed' ? 0 : 1, output);
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const nativeFailure = ['undefined-rejection', 'native-assertion'].includes(mode);
        assert.equal(result.numTotalTests, fixtures.length, output);
        assert.equal(result.numFailedTests, nativeFailure ? fixtures.length : 0, output);
        assert.equal(result.numPassedTests, nativeFailure ? 0 : fixtures.length, output);
        assert.equal(result.testResults.length, fixtures.length);
        for (const suite of result.testResults) {
            assert.equal(suite.assertionResults.length, 1);
            const actualTest = suite.assertionResults[0];
            assert.equal(actualTest.title, 'actual managed callback');
            assert.equal(actualTest.status, nativeFailure ? 'failed' : 'passed');
            if (mode === 'native-assertion') assert.match(actualTest.failureMessages.join('\n'), /actual native assertion must be retained/);
        }
        const actual = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const native = fs.readFileSync(observed, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(actual.length, fixtures.length);
        assert.equal(native.length, fixtures.length);
        for (const observation of native) assert.equal(observation.errors, ['undefined-rejection', 'native-assertion'].includes(mode) ? 1 : 0);
        const registries = actual.map(receipt => {
            assert.equal(fs.existsSync(receipt.ownedPath), false);
            return JSON.parse(fs.readFileSync(receipt.registryPath, 'utf8'));
        });
        for (const registry of registries) {
            assert.equal(registry.status, mode === 'passed' ? 'passed' : 'failed');
            assert.ok(registry.resources.every(resource => resource.state === 'disposed'));
            if (['resource-error', 'repeated-resource-error'].includes(mode)) assert.deepEqual(registry.errors.map(error => error.message), ['actual registered acquisition rejection']);
            if (mode === 'undefined-rejection') {
                assert.ok(registry.errors.length > 0);
                assert.ok(registry.errors.every(error => error.cause?.type === 'undefined'), JSON.stringify(registry.errors));
            }
            if (mode === 'native-assertion') {
                assert.match(JSON.stringify(registry.errors), /actual native assertion must be retained/);
                assert.doesNotMatch(output, /\.for is not iterable/);
            }
        }
        if (mode === 'repeated-resource-error') {
            assert.deepEqual(registries[0].owner.native, registries[1].owner.native);
            assert.notEqual(registries[0].owner.executionId, registries[1].owner.executionId);
        }
    });
}
