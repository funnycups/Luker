import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const testsDir = path.join(repository, 'tests');
const runnerPath = path.join(testsDir, 'harness/run.js');
const jestBin = path.join(testsDir, 'node_modules/jest/bin/jest.js');
const jestConfig = path.join(testsDir, 'jest.config.json');

function listRunIds(projectRoot = repository) {
    const dir = path.join(projectRoot, 'test-results/harness/runs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort();
}

function readRunRegistry(runId, projectRoot = repository) {
    const filename = path.join(projectRoot, 'test-results/harness/runs', runId, 'registry.json');
    try {
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function matchesTargetFile(reg, targetSuffix) {
    if (!reg) return false;
    if (String(reg.source || '').replace(/\\/g, '/').endsWith(targetSuffix)) return true;
    return Array.isArray(reg.command) && reg.command.some(arg => String(arg).replace(/\\/g, '/').includes(targetSuffix));
}

function runCommand(command, args, { cwd = testsDir, env = process.env, onData } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            const text = chunk.toString('utf8');
            stdout += text;
            onData?.('stdout', text, child);
        });
        child.stderr.on('data', chunk => {
            const text = chunk.toString('utf8');
            stderr += text;
            onData?.('stderr', text, child);
        });
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid }));
    });
}

test('--list across profiles is deterministic and allocates zero runtime resources', async () => {
    const before = new Set(listRunIds());
    const spawnedPids = new Set();
    const profiles = ['unit', 'storage-local', 'storage-sql', 'e2e', 'frontend', 'skills-ui', 'desktop', 'desktop-packaged', 'compatibility'];

    for (const profile of profiles) {
        const res = await runCommand(process.execPath, [runnerPath, '--profile', profile, '--list', '--json']);
        if (res.pid) spawnedPids.add(res.pid);
        assert.equal(res.code, 0, `Listing ${profile} failed: ${res.stderr}`);
        const listed = JSON.parse(res.stdout);
        assert.equal(listed.profile, profile);
        assert.equal(listed.diagnosticSlot, profile);
        assert.ok(Array.isArray(listed.files));
        assert.ok(Array.isArray(listed.frameworks));
        assert.ok(Array.isArray(listed.backends));
    }

    // Filtered listing preserves the profile diagnostic slot.
    const filtered = await runCommand(process.execPath, [
        runnerPath, '--profile', 'unit', '--file', 'tests/browser-module-context.test.js', '--list', '--json',
    ]);
    if (filtered.pid) spawnedPids.add(filtered.pid);
    assert.equal(filtered.code, 0, filtered.stderr);
    const parsedFiltered = JSON.parse(filtered.stdout);
    assert.equal(parsedFiltered.diagnosticSlot, 'unit');
    assert.deepEqual(parsedFiltered.files, ['tests/browser-module-context.test.js']);
    assert.deepEqual(parsedFiltered.frameworks, ['jest']);

    const listAllocated = listRunIds()
        .filter(id => !before.has(id))
        .map(id => ({ id, reg: readRunRegistry(id) }))
        .filter(({ reg }) => reg && (
            spawnedPids.has(reg.owner?.pid)
            || (Array.isArray(reg.command) && reg.command.includes('--list'))
        ));
    assert.deepEqual(listAllocated, [], '--list must not allocate any managed run directories');
});

test('standard runner and direct native Jest entry produce matching executed cases and backend pairs while preserving diagnostic slot', async () => {
    const targetFile = 'tests/storage/engines/fs-engine-list.test.js';
    const targetSuffix = 'storage/engines/fs-engine-list.test.js';
    const beforeRuns = new Set(listRunIds());

    const standard = await runCommand(process.execPath, [
        runnerPath, '--profile', 'storage-local', '--file', targetFile, '--', '--json',
    ]);
    assert.equal(standard.code, 0, `${standard.stdout}\n${standard.stderr}`);
    const standardJson = JSON.parse(standard.stdout.slice(standard.stdout.indexOf('{')));

    const afterStandardRuns = listRunIds()
        .filter(id => !beforeRuns.has(id))
        .map(id => ({ id, reg: readRunRegistry(id) }))
        .filter(({ reg }) => matchesTargetFile(reg, targetSuffix));
    assert.ok(afterStandardRuns.length >= 1, 'Standard run must register a managed run');
    for (const { reg } of afterStandardRuns) {
        assert.equal(reg.profile, 'storage-local', 'Filtered execution must keep the profile diagnostic slot');
        assert.equal(reg.status, 'passed');
        assert.ok(reg.resources.every(r => ['disposed', 'released'].includes(r.state)));
    }

    const native = await runCommand(process.execPath, [
        '--experimental-vm-modules', jestBin, '--config', jestConfig,
        '--selectProjects', 'storage-local', '--runTestsByPath', 'storage/engines/fs-engine-list.test.js', '--json',
    ]);
    assert.equal(native.code, 0, `${native.stdout}\n${native.stderr}`);
    const nativeJson = JSON.parse(native.stdout.slice(native.stdout.indexOf('{')));

    const summarize = report => report.testResults.flatMap(suite =>
        suite.assertionResults.map(a => ({ fullName: a.fullName, status: a.status })),
    ).sort((a, b) => a.fullName.localeCompare(b.fullName));

    const standardCases = summarize(standardJson);
    const nativeCases = summarize(nativeJson);
    assert.ok(standardCases.length > 0);
    assert.deepEqual(nativeCases, standardCases);
});

test('unavailable required databases, missing compatibility input, missing packaged artifact, and missing framework coverage exit non-zero', async () => {
    const badDbEnv = {
        ...process.env,
        LUKER_TEST_MYSQL_ROOT_URL: 'mysql://root:bad@127.0.0.1:1',
        LUKER_TEST_POSTGRES_URL: 'postgresql://luker:bad@127.0.0.1:1/missing',
    };
    const dbFailure = await runCommand(process.execPath, [runnerPath, '--profile', 'storage-sql'], { env: badDbEnv });
    assert.notEqual(dbFailure.code, 0, 'Unavailable required database must fail non-zero');
    assert.match(dbFailure.stderr + dbFailure.stdout, /mysql|postgres|database|preflight|ECONNREFUSED/i);

    const missingInput = await runCommand(process.execPath, [runnerPath, '--profile', 'compatibility']);
    assert.notEqual(missingInput.code, 0, 'compatibility without --input must fail non-zero');
    assert.match(missingInput.stderr + missingInput.stdout, /--input|directory/i);

    const missingSkillsUi = await runCommand(process.execPath, [runnerPath, '--profile', 'skills-ui']);
    assert.notEqual(missingSkillsUi.code, 0, 'skills-ui with missing playwright framework coverage must fail non-zero');
    assert.match(missingSkillsUi.stderr + missingSkillsUi.stdout, /playwright|missing/i);

    const missingPackaged = await runCommand(process.execPath, [runnerPath, '--profile', 'desktop-packaged'], {
        env: { ...process.env, LUKER_DESKTOP_ARTIFACT_DIR: path.join(repository, 'tests/harness/nonexistent-packaged-dist') },
    });
    assert.notEqual(missingPackaged.code, 0, 'desktop-packaged with missing artifact must fail non-zero');
    assert.match(missingPackaged.stderr + missingPackaged.stdout, /packaged desktop artifact/i);
});

test('--export-environment writes an explicit owned-environment-v1 archive and rejects relative or existing destinations', async (t) => {
    const relReject = await runCommand(process.execPath, [
        runnerPath, '--profile', 'unit', '--file', 'tests/browser-module-context.test.js', '--export-environment', 'relative-env',
    ]);
    assert.notEqual(relReject.code, 0);
    assert.match(relReject.stderr + relReject.stdout, /absolute/i);

    const exportParent = path.join(repository, 'test-results', `entrypoints-export-${randomUUID()}`);
    fs.mkdirSync(exportParent, { recursive: true });
    t.after(() => fs.rmSync(exportParent, { recursive: true, force: true }));

    const existingTarget = path.join(exportParent, 'already-exists');
    fs.mkdirSync(existingTarget);
    const existReject = await runCommand(process.execPath, [
        runnerPath, '--profile', 'unit', '--file', 'tests/browser-module-context.test.js', '--export-environment', existingTarget,
    ]);
    assert.notEqual(existReject.code, 0);
    assert.match(existReject.stderr + existReject.stdout, /exist/i);

    const archiveDest = path.join(exportParent, 'exported-env');
    const exported = await runCommand(process.execPath, [
        runnerPath, '--profile', 'unit', '--file', 'tests/browser-module-context.test.js', '--export-environment', archiveDest,
    ]);
    assert.equal(exported.code, 0, `${exported.stdout}\n${exported.stderr}`);
    const manifestPath = path.join(archiveDest, 'environment.json');
    assert.equal(fs.existsSync(manifestPath), true, 'Exported environment must contain environment.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.format, 'owned-environment-v1');
    assert.equal(manifest.profile, 'unit');
});

test('SIGINT cancellation during standard runner cleans up active child execution', async () => {
    const targetFile = 'tests/storage/engines/sqlite-restore-validate.test.js';
    const targetSuffix = 'storage/engines/sqlite-restore-validate.test.js';
    const beforeRuns = new Set(listRunIds());
    const child = spawn(process.execPath, [
        runnerPath, '--profile', 'storage-local', '--file', targetFile,
    ], { cwd: testsDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let signaled = false;
    let output = '';
    const onChunk = chunk => {
        output += chunk.toString('utf8');
        if (!signaled && output.length > 0) {
            signaled = true;
            child.kill('SIGINT');
        }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    const [code, signal] = await once(child, 'close');
    if (!signaled) {
        // Test finished faster than first output chunk; rerun still must have exited cleanly.
        assert.equal(code, 0);
    } else {
        assert.ok(code !== 0 || signal !== null, `Cancelled run must exit non-zero (got code=${code}, signal=${signal})`);
    }

    // Subsequent managed startup recovery cleanly settles any interrupted runs.
    const { recoverBeforeRun } = await import('./startup.js');
    await recoverBeforeRun({ projectRoot: repository, profiles: ['storage-local'] });
    const newRuns = listRunIds()
        .filter(id => !beforeRuns.has(id))
        .map(id => ({ id, reg: readRunRegistry(id) }))
        .filter(({ reg }) => matchesTargetFile(reg, targetSuffix));
    for (const { id: runId, reg } of newRuns) {
        assert.ok(reg.resources.every(r => ['disposed', 'released'].includes(r.state)), `Run ${runId} left undisposed resources`);
    }
});

test('tests/package.json enforces managed runner commands without --forceExit', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(testsDir, 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(pkg.scripts)) {
        assert.equal(script.includes('--forceExit'), false, `Script ${name} must not use --forceExit`);
    }
    assert.match(pkg.scripts['test:unit'], /harness\/run\.js\s+--profile\s+unit/);
    assert.match(pkg.scripts['test:unit:serial'], /harness\/run\.js\s+--profile\s+unit/);
    assert.match(pkg.scripts['test:storage:local'], /harness\/run\.js\s+--profile\s+storage-local/);
    assert.match(pkg.scripts['test:storage:sql'], /harness\/run\.js\s+--profile\s+storage-sql/);
    assert.match(pkg.scripts['test:e2e'], /harness\/run\.js\s+--profile\s+e2e/);
    assert.match(pkg.scripts['test:e2e:desktop'], /harness\/run\.js\s+--profile\s+desktop/);
    assert.match(pkg.scripts['test:e2e:desktop:packaged'], /harness\/run\.js\s+--profile\s+desktop-packaged/);
    assert.match(pkg.scripts['test:compatibility'], /harness\/run\.js\s+--profile\s+compatibility/);
    assert.match(pkg.scripts.test, /test:unit.*test:storage:local.*test:storage:sql.*test:e2e/);
    assert.match(pkg.scripts['test:all'], /test:e2e:desktop.*test:e2e:desktop:packaged/);
});

test('pure in-memory unit suites allocate zero managed runs and recoverBeforeRun prunes completed passed runs', async (t) => {
    const before = new Set(listRunIds());
    const pureRun = await runCommand(process.execPath, [
        runnerPath, '--profile', 'unit', '--file', 'tests/browser-module-context.test.js', '--', '--json',
    ]);
    assert.equal(pureRun.code, 0, `${pureRun.stdout}\n${pureRun.stderr}`);
    const afterPure = listRunIds()
        .filter(id => !before.has(id))
        .map(id => ({ id, reg: readRunRegistry(id) }))
        .filter(({ reg }) => matchesTargetFile(reg, 'browser-module-context.test.js'));
    assert.deepEqual(afterPure, [], 'Pure in-memory unit suite should not allocate a managed run');

    // Prune behavior on an isolated temp projectRoot: keeps active and failed runs, removes ended passed runs.
    const { createRun } = await import('./resources/run.js');
    const { pruneCompletedRuns } = await import('./startup.js');
    const isolatedRoot = path.join(repository, 'test-results', `prune-test-${randomUUID()}`);
    fs.mkdirSync(isolatedRoot, { recursive: true });
    t.after(() => fs.rmSync(isolatedRoot, { recursive: true, force: true }));

    // Create a completed failed run in a child process so its owner process has actually exited,
    // verifying retention is driven by status !== 'passed' rather than active PID custody.
    const failedChildCode = `
        import { createRun } from ${JSON.stringify(new URL('./resources/run.js', import.meta.url).href)};
        const run = await createRun({
            projectRoot: ${JSON.stringify(isolatedRoot)},
            profile: 'unit',
            command: [process.execPath, 'prune-failed-child'],
            source: 'prune-failed',
        });
        await run.finish({ status: 'failed', error: new Error('retained failure') });
        process.stdout.write(run.runId);
    `;
    const failedChildRes = await runCommand(process.execPath, ['--input-type=module', '-e', failedChildCode]);
    assert.equal(failedChildRes.code, 0, failedChildRes.stderr);
    const failedRunId = failedChildRes.stdout.trim();
    const failedRegistryPath = path.join(isolatedRoot, 'test-results/harness/runs', failedRunId, 'registry.json');
    assert.ok(fs.existsSync(failedRegistryPath));

    const activeRun = await createRun({
        projectRoot: isolatedRoot,
        profile: 'unit',
        command: [process.execPath, 'prune-test'],
        source: 'prune-active',
    });
    try {
        // Create a completed passed run in a child process so its owner process has actually exited.
        const childCode = `
            import { createRun } from ${JSON.stringify(new URL('./resources/run.js', import.meta.url).href)};
            const run = await createRun({
                projectRoot: ${JSON.stringify(isolatedRoot)},
                profile: 'unit',
                command: [process.execPath, 'prune-child'],
                source: 'prune-passed-child',
            });
            const scope = await run.scope({ kind: 'case', label: 'child' });
            await scope.directory('temp');
            await run.finish({ status: 'passed' });
            process.stdout.write(run.runId);
        `;
        const childRes = await runCommand(process.execPath, ['--input-type=module', '-e', childCode]);
        assert.equal(childRes.code, 0, childRes.stderr);
        const passedRunId = childRes.stdout.trim();
        assert.ok(fs.existsSync(path.join(isolatedRoot, 'test-results/harness/runs', passedRunId, 'registry.json')));

        const pruned = await pruneCompletedRuns({ projectRoot: isolatedRoot, profiles: ['unit'] });
        assert.equal(pruned, 1);
        assert.equal(fs.existsSync(path.join(isolatedRoot, 'test-results/harness/runs', passedRunId)), false);
        assert.equal(fs.existsSync(failedRegistryPath), true);
        assert.equal(fs.existsSync(activeRun.registryPath), true);
    } finally {
        await activeRun.finish({ status: 'passed' });
    }
});
