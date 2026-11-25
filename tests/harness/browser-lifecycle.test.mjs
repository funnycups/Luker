import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { outcomeFixture, inventory, nodes } from './fixtures/process-native-control.mjs';
import { readDiagnostic } from './resources/diagnostics.js';
import { recoverRuns } from './resources/recovery.js';
import { test as managedTest } from './node.js';
import { materializeSeed } from './seed.js';
import { launchOwnedProcess } from './resources/process-owner.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const harness = new URL('./', import.meta.url);
const cli = path.join(repository, 'tests/node_modules/playwright/cli.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function configuration(input) {
    const config = path.join(input.projectRoot, 'playwright.config.mjs');
    fs.writeFileSync(config, `import { defineManagedConfig } from ${JSON.stringify(fileURLToPath(new URL('playwright-config.js', harness)))};\nexport default defineManagedConfig(${JSON.stringify({
        testDir: fileURLToPath(new URL('./fixtures/browser/', import.meta.url)),
        testMatch: input.mode.startsWith('server-') ? 'server.spec.mjs' : input.mode.startsWith('frontend-') ? 'frontend.spec.mjs' : 'case.spec.mjs',
        outputDir: path.join(input.projectRoot, input.mode === 'output-boundary' ? 'test-results/harness' : 'native-output'),
        workers: ['parallel', 'frontend-parallel'].includes(input.mode) ? 2 : 1,
        fullyParallel: !['scenario', 'frontend-shared', 'frontend-retry'].includes(input.mode),
        retries: ['retry', 'frontend-retry'].includes(input.mode) ? 1 : 0,
        preserveOutput: 'always',
        use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
        projects: input.mode.startsWith('frontend-') ? [{ name: 'frontend' }] : input.mode === 'project-dependency' ? [{ name: 'e2e', dependencies: ['frontend'] }, { name: 'frontend' }] : input.mode === 'variadic-projects' ? [{ name: 'e2e' }, { name: 'frontend' }] : input.mode === 'profile-isolation' ? [{ name: 'e2e' }, { name: 'frontend', testIgnore: ['case.spec.mjs'] }] : [{ name: 'e2e' }],
        metadata: { resourceProjectRoot: input.projectRoot, ...(input.mode === 'report-failure' ? { resourceReportPath: path.join(input.projectRoot, 'report-target') } : input.mode === 'report-boundary' ? { resourceReportPath: path.join(input.projectRoot, 'test-results/harness/registered-evidence.bin') } : {}) },
        globalSetup: fileURLToPath(new URL('playwright-setup.js', harness)),
        globalTeardown: fileURLToPath(new URL('fixtures/browser/teardown.mjs', harness)),
        reporter: [[fileURLToPath(new URL('playwright-reporter.js', harness))], ['line'], ...(input.reporter ? [[input.reporter, input.reporterOptions ?? {}]] : [])],
    })}, import.meta.filename);\n`);
    return config;
}

async function nativeRun(t, input, extra = []) {
    const config = input.repositoryConfig ? path.join(repository, 'tests/playwright.config.js') : configuration(input);
    const command = [process.execPath, cli, 'test', '--config', config, ...extra];
    const environment = { ...process.env, ...input.environment, BROWSER_LIFECYCLE_INPUT: JSON.stringify(input) };
    delete environment.NODE_TEST_CONTEXT;
    const child = spawn(command[0], command.slice(1), { cwd: path.join(repository, 'tests'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let interrupted = false; let startupWatcher; let observedStartup; let controlError; let externalStartupRelease;
    const collect = bytes => {
        output += bytes;
        if (input.mode === 'cancel' && !interrupted && output.includes('BROWSER_LIFECYCLE_READY')) { interrupted = true; child.kill('SIGINT'); }
        if (input.mode === 'frontend-cancel' && !interrupted && output.includes('FRONTEND_LIFECYCLE_READY')) { interrupted = true; child.kill('SIGINT'); }
        if (['startup-cancel', 'startup-worker-exit'].includes(input.mode) && !startupWatcher) {
            const match = /BROWSER_STARTUP_SCOPE ([^\r\n]+)\r?\n/.exec(output);
            if (!match) return;
            try {
                const source = JSON.parse(match[1]);
                const bound = path.join(source.path, 'bound.json');
                const abortStartup = () => {
                    if (!interrupted && fs.existsSync(bound)) {
                        observedStartup = JSON.parse(fs.readFileSync(bound, 'utf8'));
                        interrupted = true;
                        if (input.mode === 'startup-worker-exit') {
                            assert.ok(Number.isSafeInteger(source.workerPid) && source.workerPid > 0 && source.workerPid !== process.pid && source.workerPid !== child.pid);
                            process.kill(source.workerPid, 'SIGKILL');
                        } else child.kill('SIGINT');
                    }
                };
                startupWatcher = fs.watch(source.path, () => {
                    try { abortStartup(); }
                    catch (error) { controlError = error; child.kill('SIGINT'); }
                });
                abortStartup();
            } catch (error) { controlError = error; child.kill('SIGINT'); }
        }
        if (input.mode === 'startup-worker-exit' && !externalStartupRelease) {
            const match = /BROWSER_NATIVE_DISPATCHERS ([^\r\n]+)\r?\n/.exec(output);
            if (match && !JSON.parse(match[1]).admissionClosed) externalStartupRelease = fetch(`http://127.0.0.1:${observedStartup.port}/release-startup`).then(response => { assert.equal(response.status, 200); }).catch(error => { controlError = error; child.kill('SIGINT'); });
        }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT'); await closed; });
    const [code, signal] = await closed;
    await externalStartupRelease;
    startupWatcher?.close();
    assert.equal(controlError, undefined);
    if (input.mode === 'diagnostic') {
        const restore = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const filename = path.join(directory, entry.name);
                if (entry.isDirectory()) restore(filename);
                else if (fs.statSync(filename).mode % 0o1000 === 0) fs.chmodSync(filename, 0o600);
            }
        };
        restore(path.join(input.projectRoot, 'native-output'));
    }
    t.diagnostic(JSON.stringify({ nativeBrowserRun: { command, runtime: process.version, execPath: process.execPath, code, signal, interrupted, output } }));
    return { code, signal, output, interrupted, observedStartup, externalStartupRelease: Boolean(externalStartupRelease) };
}

test('repository browser configuration import allocates no resources or inherited environment', async t => {
    const input = outcomeFixture(t);
    const code = `import fs from 'node:fs';
const before = { names: fs.readdirSync(process.env.TMPDIR), environment: { ...process.env } };
const { default: config } = await import(${JSON.stringify(path.join(repository, 'tests/playwright.config.js'))});
console.log(JSON.stringify({ before, after: { names: fs.readdirSync(process.env.TMPDIR), environment: { ...process.env } }, preserveOutput: config.preserveOutput, globalSetup: config.globalSetup, globalTeardown: config.globalTeardown, reporter: config.reporter, webServer: config.webServer, video: config.use.video, runtime: { version: process.version, execPath: process.execPath } }));`;
    const environment = { ...process.env, TMPDIR: input.projectRoot };
    for (const key of ['ST_BASE_URL', 'PLAYWRIGHT_BASE_URL', 'LUKER_PW_FRONTEND_SCRATCH', 'LUKER_PW_FRONTEND_SERVER', 'NODE_TEST_CONTEXT']) delete environment[key];
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    const closed = once(child, 'close');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT'); await closed; });
    assert.deepEqual(await closed, [0, null], error);
    const actual = JSON.parse(output);
    assert.deepEqual(actual.runtime, { version: process.version, execPath: process.execPath });
    assert.deepEqual(actual.after.names, actual.before.names, 'Configuration import must not allocate frontend scratch');
    assert.deepEqual(actual.after.environment, actual.before.environment, 'Configuration import must not publish execution environment');
    assert.equal(actual.preserveOutput, 'always');
    assert.equal(actual.globalSetup, fileURLToPath(new URL('./playwright-setup.js', harness)));
    assert.equal(actual.globalTeardown, fileURLToPath(new URL('./playwright-teardown.js', harness)));
    assert.ok(actual.reporter.some(([name]) => name === fileURLToPath(new URL('./playwright-reporter.js', harness))));
    assert.equal(actual.webServer, undefined);
    assert.equal(actual.video, 'retain-on-failure');
});

for (const selection of ['file', 'projects']) test(`repository native listing for ${selection} leaves selected project inputs unallocated`, async t => {
    const input = { ...outcomeFixture(t), mode: 'repository-list', repositoryConfig: true };
    const before = fs.readdirSync(input.projectRoot);
    input.environment = { TMPDIR: input.projectRoot, PWTEST_CACHE_DIR: path.join(input.root, 'native-transform-cache'), ...(selection === 'projects' ? { PW_INCLUDE_DESKTOP: '1', PW_INCLUDE_DESKTOP_PACKAGED: '1' } : {}) };
    const result = await nativeRun(t, input, ['--list', ...(selection === 'file' ? ['--project=e2e', 'character/26-replace-world-book-paths'] : []), '--output', path.join(input.projectRoot, 'native-output')]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /post-replace world-book paths actually work/);
    assert.deepEqual(fs.readdirSync(input.projectRoot), before, 'Native listing must not allocate frontend or execution data');
});

for (const mode of ['frontend-shared', 'frontend-retry', 'frontend-parallel', 'frontend-failure', 'frontend-cancel']) test(`selected frontend fixture completes ${mode} with project-owned application state`, async t => {
    const input = { ...outcomeFixture(t), mode, environment: { LUKER_RUNTIME: 'node' } };
    const result = await nativeRun(t, input);
    assert.equal(result.code, mode === 'frontend-failure' ? 1 : mode === 'frontend-cancel' ? 130 : 0, result.output);
    const receipts = fs.readdirSync(input.root).filter(name => /^frontend-(?:write|observe|retry|failure|cancel)-\d+-\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(input.root, name), 'utf8')));
    assert.equal(receipts.length, ['frontend-failure', 'frontend-cancel'].includes(mode) ? 1 : 2);
    assert.equal(new Set(receipts.map(receipt => receipt.pid)).size, 1, 'Native workers must share only the declared project application');
    if (['frontend-retry', 'frontend-parallel'].includes(mode)) assert.equal(new Set(receipts.map(receipt => receipt.workerIndex)).size, 2);
    const report = JSON.parse(fs.readFileSync(path.join(input.projectRoot, 'native-output/managed-run.json'), 'utf8'));
    const summary = JSON.parse(fs.readFileSync(report.projects[0].registryPath, 'utf8'));
    assert.equal(summary.status, mode === 'frontend-cancel' ? 'cancelled' : ['frontend-retry', 'frontend-failure'].includes(mode) ? 'failed' : 'passed');
    assert.equal(summary.resources.filter(resource => resource.kind === 'process').length, 1);
    assert.ok(summary.resources.every(resource => ['disposed', 'released'].includes(resource.state)));
    const artifacts = report.projects[0].events.filter(event => event.type === 'artifacts-complete');
    assert.ok(artifacts.length >= receipts.length);
    assert.ok(artifacts.every(event => event.directories.some(directory => directory.path === receipts[0].owner.path && directory.present)), 'Native artifacts must precede shared project directory disposal');
    for (const receipt of receipts) {
        assert.deepEqual(receipt.runtime, { version: process.version, execPath: process.execPath });
        assert.equal(receipt.frontendDebugLogging, true);
        assert.equal(fs.existsSync(receipt.dataRoot), false);
        assert.throws(() => process.kill(receipt.pid, 0), error => error.code === 'ESRCH');
        await noListener(receipt.port);
    }
    if (mode === 'frontend-retry') assert.ok(report.projects[0].results.some(result => result.retry === 0 && result.status === 'failed'));
    if (mode === 'frontend-failure') assert.ok(nodes(summary.errors).some(error => error.message?.includes('actual frontend failure with project-owned state')));
    if (['frontend-failure', 'frontend-cancel', 'frontend-retry'].includes(mode)) {
        const trace = summary.diagnosticIndex.artifacts.find(ref => ref.name.endsWith('trace.zip'));
        assert.ok(trace);
        const bytes = await readDiagnostic(summary.diagnosticIndex, trace);
        assert.equal(hash(bytes), trace.sha256);
        assert.ok((await zipEntries(bytes)).some(name => name.endsWith('.trace')));
    }
    t.diagnostic(JSON.stringify({ frontendApplicationLifecycle: { mode, receipts, summary, report } }));
});

async function noListener(port) {
    await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); reject(new Error(`Owned application port still accepts connections: ${port}`)); });
        socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    });
}

async function zipEntries(bytes) {
    return [...(await zipContents(bytes)).keys()];
}

async function zipContents(bytes) {
    const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
    const entries = new Map();
    await new Promise((resolve, reject) => {
        zip.once('error', reject); zip.once('end', resolve);
        zip.on('entry', entry => {
            const reading = (async () => {
                const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
                const chunks = [];
                for await (const chunk of stream) chunks.push(chunk);
                const content = Buffer.concat(chunks);
                assert.equal(content.length, entry.uncompressedSize, `Incomplete native ZIP entry: ${entry.fileName}`);
                assert.equal(crc32(content), entry.crc32, `Corrupt native ZIP entry: ${entry.fileName}`);
                entries.set(entry.fileName, content);
                zip.readEntry();
            })();
            reading.catch(error => { zip.close(); reject(error); });
        });
        zip.readEntry();
    });
    return entries;
}

for (const mode of ['success', 'assertion', 'after-hook', 'before-hook', 'after-all', 'before-start', 'startup', 'cancel', 'startup-cancel', 'startup-worker-exit', 'restart', 'parallel', 'scenario', 'scope-kinds', 'retry', 'capture-input', 'diagnostic', 'large-artifact', 'cleanup', 'report-failure']) test(`native browser resources complete ${mode} with truthful artifacts and release`, async t => {
    const input = { ...outcomeFixture(t), mode };
    if (mode === 'report-failure') fs.mkdirSync(path.join(input.projectRoot, 'report-target'));
    const result = await nativeRun(t, input);
    const expected = ['success', 'restart', 'parallel', 'scenario', 'scope-kinds', 'retry'].includes(mode) ? 0 : mode === 'cancel' ? 130 : 1;
    if (mode === 'cleanup') for (const name of fs.readdirSync(input.root).filter(name => /^cleanup-\d+\.json$/.test(name))) fs.chmodSync(JSON.parse(fs.readFileSync(path.join(input.root, name), 'utf8')).owned.path, 0o700);
    assert.equal(result.signal, null, result.output);
    assert.equal(result.code, expected, result.output);
    const receipts = fs.readdirSync(input.root).filter(name => new RegExp(`^${mode === 'parallel' ? '(left|right)' : mode === 'scenario' ? '(scenario-write|scenario-observe)' : mode}-\\d+\\.json$`).test(name)).map(name => JSON.parse(fs.readFileSync(path.join(input.root, name), 'utf8')));
    assert.equal(receipts.length, ['parallel', 'scenario', 'retry'].includes(mode) ? 2 : 1, `Managed native fixture did not admit the declared resources: ${result.output}`);
    if (['startup-cancel', 'startup-worker-exit'].includes(mode)) {
        assert.ok(result.observedStartup && result.interrupted);
        assert.deepEqual(result.observedStartup.runtime, { version: process.version, execPath: process.execPath });
        assert.equal(result.externalStartupRelease, false, 'A dead worker cannot leave final reporting waiting for readiness');
        assert.throws(() => process.kill(result.observedStartup.pid, 0), error => error.code === 'ESRCH');
        await noListener(result.observedStartup.port);
    }
    for (const receipt of receipts) {
        assert.deepEqual(receipt.runtime, { version: process.version, execPath: process.execPath, sourceSHA256: hash(fs.readFileSync(new URL('./fixtures/browser/case.spec.mjs', import.meta.url))) });
        if (receipt.applicationRuntime) assert.deepEqual(receipt.applicationRuntime, { version: process.version, execPath: process.execPath });
        if (mode === 'cleanup') assert.equal(fs.existsSync(receipt.owned.path), true);
        else assert.equal(fs.existsSync(receipt.owned.path), false);
        for (const pid of [receipt.pid, receipt.previousPid].filter(value => value !== undefined)) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
        for (const port of [receipt.port, receipt.previousPort].filter(value => value !== undefined)) await noListener(port);
    }
    if (['parallel', 'retry'].includes(mode)) { assert.notEqual(receipts[0].owned.path, receipts[1].owned.path); assert.notEqual(receipts[0].workerIndex, receipts[1].workerIndex); }
    if (mode === 'scenario') { assert.equal(receipts[0].owned.path, receipts[1].owned.path); assert.equal(receipts[0].workerIndex, receipts[1].workerIndex); }
    const reportPath = path.join(input.projectRoot, 'native-output/managed-run.json');
    if (mode === 'report-failure') {
        const registered = path.join(input.projectRoot, 'test-results/harness/runs');
        const registries = fs.readdirSync(registered).map(name => JSON.parse(fs.readFileSync(path.join(registered, name, 'registry.json'), 'utf8')));
        assert.equal(registries.length, 1);
        assert.equal(registries[0].status, 'failed');
        assert.ok(nodes(registries[0].errors).some(error => error.code === 'EISDIR'));
        assert.deepEqual(fs.readdirSync(path.join(input.projectRoot, 'report-target')), []);
        return;
    }
    assert.ok(fs.existsSync(reportPath), 'Awaited native reporter must publish the lifecycle report');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.nativeTeardownComplete, true);
    assert.equal(report.projects.length, 1);
    const project = { ...report.projects[0], summary: JSON.parse(fs.readFileSync(report.projects[0].registryPath, 'utf8')) };
    assert.equal(project.summary.status, expected === 0 && mode !== 'retry' ? 'passed' : mode === 'cancel' ? 'cancelled' : 'failed');
    if (mode === 'retry') {
        assert.equal(report.nativeOutcomeBeforeResourceFinalization, 'passed');
        assert.deepEqual(project.results.map(attempt => [attempt.retry, attempt.status]), [[0, 'failed'], [1, 'passed']]);
        assert.ok(nodes(project.summary.errors).some(error => error.message?.includes('actual failed attempt before native retry')));
    }
    if (mode === 'cleanup') {
        assert.ok(nodes(project.summary.errors).some(error => ['EACCES', 'ENOTEMPTY'].includes(error.code)));
        const recovered = await recoverRuns({ projectRoot: input.projectRoot, profiles: ['e2e'] });
        assert.deepEqual(recovered.recovered, [project.summary.runId]);
        for (const receipt of receipts) assert.equal(fs.existsSync(receipt.owned.path), false);
        const settled = JSON.parse(fs.readFileSync(project.registryPath, 'utf8'));
        assert.deepEqual(settled.errors.slice(0, project.summary.errors.length), project.summary.errors);
    } else assert.ok(project.summary.resources.every(resource => ['disposed', 'released'].includes(resource.state)));
    if (mode === 'diagnostic') {
        assert.ok(nodes(project.summary.errors).some(error => error.code === 'EACCES'));
        const readable = project.summary.diagnosticIndex.artifacts.find(ref => ref.name.endsWith('actual-state.bin'));
        assert.ok(readable, 'An unreadable native attachment must not discard other complete evidence');
        assert.deepEqual(await readDiagnostic(project.summary.diagnosticIndex, readable), Buffer.from([0, 255, 13, 10]));
    }
    if (['assertion', 'after-hook', 'after-all', 'before-hook', 'cancel', 'startup-cancel', 'retry', 'large-artifact'].includes(mode)) {
        const trace = project.summary.diagnosticIndex.artifacts.find(ref => ref.name.endsWith('trace.zip'));
        assert.ok(trace, 'The final native trace is retained as complete diagnostic bytes');
        const bytes = await readDiagnostic(project.summary.diagnosticIndex, trace);
        assert.equal(hash(bytes), trace.sha256);
        assert.ok((await zipEntries(bytes)).some(name => name.endsWith('.trace')));
        assert.ok(project.events.some(event => event.type === 'artifacts-complete' && event.directories.every(directory => directory.present)));
    }
    if (mode === 'large-artifact') {
        const declaredBrowsers = JSON.parse(fs.readFileSync(path.join(repository, 'tests/node_modules/playwright-core/browsers.json'), 'utf8'));
        assert.equal(receipts[0].browserVersion, declaredBrowsers.browsers.find(browser => browser.name === 'chromium').browserVersion);
        assert.ok(nodes(project.summary.errors).some(error => error.message?.includes('actual failure retaining a complete source artifact')));
        const source = fs.readFileSync(path.join(repository, 'public/script.js'));
        const attachment = project.summary.diagnosticIndex.artifacts.find(ref => ref.name.endsWith('large-source.js'));
        assert.ok(attachment);
        assert.deepEqual(await readDiagnostic(project.summary.diagnosticIndex, attachment), source);
        const trace = project.summary.diagnosticIndex.artifacts.find(ref => ref.name.endsWith('trace.zip'));
        const contents = await zipContents(await readDiagnostic(project.summary.diagnosticIndex, trace));
        assert.ok([...contents.values()].some(content => content.equals(source)), 'Native trace must contain the complete original source bytes');
    }
    t.diagnostic(JSON.stringify({ browserLifecycleProof: { mode, report, receipts } }));
});

test('native global-teardown failure still concludes admitted execution owners', async t => {
    const input = { ...outcomeFixture(t), mode: 'teardown-error' };
    const result = await nativeRun(t, input);
    assert.equal(result.code, 1, result.output);
    const runs = path.join(input.projectRoot, 'test-results/harness/runs');
    const entries = fs.readdirSync(runs).map(name => JSON.parse(fs.readFileSync(path.join(runs, name, 'registry.json'), 'utf8')));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'failed');
    assert.ok(nodes(entries[0].errors).some(error => error.message?.includes('actual browser global-teardown failure')));
    assert.ok(entries[0].resources.every(resource => ['disposed', 'released'].includes(resource.state)));
});

for (const dependencies of [true, false]) test(`native browser selection preserves ${dependencies ? 'requested dependency ownership' : 'explicit dependency exclusion'}`, async t => {
    const input = { ...outcomeFixture(t), mode: 'project-dependency' };
    const result = await nativeRun(t, input, ['--project=E2E', ...(dependencies ? [] : ['--no-deps'])]);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(fs.readFileSync(path.join(input.projectRoot, 'native-output/managed-run.json'), 'utf8'));
    assert.deepEqual(report.projects.map(project => project.name).sort(), dependencies ? ['e2e', 'frontend'] : ['e2e']);
    for (const project of report.projects) {
        const saved = JSON.parse(fs.readFileSync(project.registryPath, 'utf8'));
        assert.equal(saved.status, 'passed');
        assert.ok(saved.resources.every(resource => ['disposed', 'released'].includes(resource.state)));
    }
});

test('native failure does not publish an empty failure for an unexecuted project', async t => {
    const input = { ...outcomeFixture(t), mode: 'profile-isolation' };
    const result = await nativeRun(t, input);
    assert.equal(result.code, 1, result.output);
    const report = JSON.parse(fs.readFileSync(path.join(input.projectRoot, 'native-output/managed-run.json'), 'utf8'));
    const saved = report.projects.map(project => JSON.parse(fs.readFileSync(project.registryPath, 'utf8')));
    assert.equal(saved.find(project => project.profile === 'e2e').status, 'failed');
    const unexecuted = saved.find(project => project.profile === 'frontend');
    assert.equal(unexecuted.status, 'passed');
    assert.equal(unexecuted.diagnosticIndex, null);
    assert.deepEqual(unexecuted.resources, []);
});

test('native variadic project selection preserves all requested owners', async t => {
    const input = { ...outcomeFixture(t), mode: 'variadic-projects' };
    const result = await nativeRun(t, input, ['--project', 'E2E', 'FRONTEND', '--reporter', fileURLToPath(new URL('playwright-reporter.js', harness)) + ',line']);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(fs.readFileSync(path.join(input.projectRoot, 'native-output/managed-run.json'), 'utf8'));
    assert.deepEqual(report.projects.map(project => project.name), ['e2e', 'frontend']);
    for (const project of report.projects) {
        const summary = JSON.parse(fs.readFileSync(project.registryPath, 'utf8'));
        assert.equal(summary.status, 'passed');
        assert.equal(project.results.length, 1);
        assert.ok(summary.resources.every(resource => ['disposed', 'released'].includes(resource.state)));
    }
});

for (const boundary of ['configuration', 'command-line', 'alias', 'report', 'html', 'blob', 'json', 'junit', 'html-environment', 'cli-html-environment']) test(`native ${boundary} output cannot claim the managed resource namespace`, async t => {
    const input = { ...outcomeFixture(t), mode: boundary === 'configuration' ? 'output-boundary' : boundary === 'report' ? 'report-boundary' : 'success' };
    const reserved = path.join(input.projectRoot, 'test-results/harness');
    fs.mkdirSync(reserved, { recursive: true });
    const marker = path.join(reserved, 'registered-evidence.bin');
    const bytes = Buffer.from([0, 255, 37, 13, 10]);
    fs.writeFileSync(marker, bytes);
    if (['html', 'blob', 'json', 'junit'].includes(boundary)) {
        input.reporter = boundary;
        input.reporterOptions = boundary === 'html' ? { outputFolder: reserved, open: 'never' } : boundary === 'blob' ? { outputDir: reserved } : { outputFile: marker };
    }
    if (boundary.endsWith('-environment')) {
        input.environment = { PLAYWRIGHT_HTML_OUTPUT_DIR: reserved, PLAYWRIGHT_HTML_OPEN: 'never' };
        if (boundary === 'html-environment') input.reporter = 'html';
    }
    const selected = boundary === 'alias' ? path.join(input.projectRoot, 'linked-output') : reserved;
    if (boundary === 'alias') fs.symlinkSync(reserved, selected);
    const arguments_ = ['command-line', 'alias'].includes(boundary) ? ['--output', selected] : boundary === 'cli-html-environment' ? ['--reporter', fileURLToPath(new URL('playwright-reporter.js', harness)) + ',html'] : [];
    const result = await nativeRun(t, input, arguments_);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /(?:output|report).*overlap|overlap.*(?:output|report)/i);
    assert.deepEqual(fs.readFileSync(marker), bytes);
    assert.deepEqual(fs.readdirSync(reserved), ['registered-evidence.bin']);
});

test('native reporter replacement refuses before execution ownership is allocated', async t => {
    const input = { ...outcomeFixture(t), mode: 'success' };
    const result = await nativeRun(t, input, ['--reporter', 'line']);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /requires.*managed reporter|managed reporter.*required/i);
    assert.equal(fs.existsSync(path.join(input.projectRoot, 'test-results/harness/runs')), false);
});

test('native infrastructure coverage declares its browser dependency only when selected', async () => {
    const { getProfile } = await import('./profiles.js');
    assert.ok(getProfile('unit', { files: ['tests/harness/browser-lifecycle.test.mjs'] }).requirements.includes('browser'));
    assert.equal(getProfile('unit', { files: ['tests/harness/seed-and-profiles.test.mjs'] }).requirements.includes('browser'), false);
});

test('native browser config and listing acquire no execution resources', async t => {
    const input = { ...outcomeFixture(t), mode: 'success' };
    const before = inventory(input.projectRoot);
    const result = await nativeRun(t, input, ['--list']);
    assert.equal(result.code, 0, result.output);
    assert.equal(fs.existsSync(path.join(input.projectRoot, 'test-results/harness/runs')), false);
    assert.deepEqual(inventory(input.projectRoot).map(entry => entry.name).filter(name => name !== 'playwright.config.mjs'), before.map(entry => entry.name));
});

const producerOptions = { profile: 'server-adapter-contract', source: 'owned-application-producers', command: [process.execPath, '--test', 'harness/browser-lifecycle.test.mjs'] };
const producerProcesses = [];

function producerTest(name, body) {
    test(name, async t => {
        const input = outcomeFixture(t);
        const summary = await managedTest(name, { ...producerOptions, projectRoot: input.projectRoot }, async (context, scope, run) => {
            assert.equal(run.registryPath, path.join(input.projectRoot, 'test-results/harness/runs', run.runId, 'registry.json'));
            await body(context, scope, run);
        });
        assert.equal(summary.status, 'passed');
    });
}

producerTest('compatibility caller requires declared input and preserves copied bytes in the original owned directory', async (t, scope) => {
    const { resolveRealDataRoot, cloneRealDataForSpec } = await import('../e2e/storage/cross-mode-recovery/_lib/real-data.js');
    assert.throws(() => resolveRealDataRoot(''), /explicit absolute directory/);
    assert.throws(() => resolveRealDataRoot('relative-input'), /explicit absolute directory/);
    const source = await scope.directory('explicit compatibility source');
    const user = path.join(source.path, 'default-user');
    fs.mkdirSync(user);
    const bytes = Buffer.from('{"oai_settings":{"prompts":[{"content":"ORCHESTRATOR MODE 世界🌍"}]}}\n');
    fs.writeFileSync(path.join(user, 'settings.json'), bytes);
    fs.writeFileSync(path.join(user, 'secrets.json'), '{"token":"explicit-fixture-token"}\n');
    fs.mkdirSync(path.join(user, '_macros_cache'));
    fs.writeFileSync(path.join(user, '_macros_cache', 'selected.txt'), 'selected fixture bytes\n');
    const before = inventory(source.path);
    const contents = entries => entries.map(entry => ({ name: entry.name, ...(entry.children ? { children: contents(entry.children) } : { bytes: entry.bytes }) }));
    assert.equal(resolveRealDataRoot(source.path), source.path);
    const copied = await cloneRealDataForSpec({ scope, sourceDataRoot: source.path, specId: 'native-owned-copy' });
    assert.deepEqual(await scope.verifyDirectory(copied), copied);
    assert.notEqual(copied.resourceId, source.resourceId);
    assert.deepEqual(fs.readFileSync(path.join(copied.path, 'default-user/settings.json')), bytes);
    assert.deepEqual(contents(inventory(copied.path)), contents(before));
    assert.deepEqual(inventory(source.path), before);
});

producerTest('seed owner receipts describe the original configuration and data boundaries', async (t, scope, run) => {
    const seed = await materializeSeed(scope, {});
    assert.equal(typeof seed.owner?.resourceId, 'string', 'The seed must expose its original configuration owner');
    assert.equal(seed.dataOwner, seed.owner);
    const registered = run.registry.resources.find(resource => resource.resourceId === seed.owner.resourceId);
    assert.deepEqual({ path: seed.owner.path, dev: seed.owner.dev, ino: seed.owner.ino }, registered.locator);
    assert.equal(seed.dataRoot, path.join(seed.dataOwner.path, 'data'));
});

producerTest('directory verification preserves the actual registered ownership receipt', async (t, scope) => {
    const directory = await scope.directory('registered application data');
    assert.equal(typeof scope.verifyDirectory, 'function', 'Scopes must verify their registered directory receipts');
    const verified = await scope.verifyDirectory(directory);
    assert.deepEqual(verified, directory);
    assert.ok(Object.isFrozen(verified));
    const seed = await materializeSeed(scope, { fixture: { kind: 'owned', directory } });
    assert.equal(seed.dataRoot, directory.path);
    assert.deepEqual(seed.dataOwner, directory);
    assert.notEqual(seed.owner.resourceId, directory.resourceId);
    assert.deepEqual(fs.readdirSync(directory.path), []);
});

producerTest('local scope process capability uses the original owned process lifecycle', async (t, scope) => {
    const directory = await scope.directory('local process dependency');
    assert.equal(typeof scope.process, 'function', 'Local and worker scopes must provide the same process capability');
    const lease = await scope.process({ label: 'local process', command: [process.execPath, fileURLToPath(new URL('./fixtures/browser/application.mjs', import.meta.url)), JSON.stringify({ dataRoot: directory.path })], readyLine: 'browser-resource-ready', dependsOn: [directory.resourceId] });
    const bound = JSON.parse(fs.readFileSync(path.join(directory.path, 'bound.json'), 'utf8'));
    producerProcesses.push({ pid: lease.pid, port: bound.port });
    assert.equal(lease.readyLine, 'browser-resource-ready');
    assert.equal(bound.pid, lease.pid);
});

test('readiness normalization preserves visible text after complete terminal title sequences', async () => {
    const { normalizeReadinessLine } = await import('./resources/process-diagnostics.js');
    assert.equal(typeof normalizeReadinessLine, 'function', 'Readiness needs a portable complete-terminal-sequence normalizer');
    const visible = '[2026-11-03T02:13:44.398Z] browser-bound-port 54321';
    for (const [input, expected] of [
        [visible, visible],
        ['\u001b]2;owned application\u001b\\' + visible, visible],
        ['\u001b]0;owned application\u0007\u001b[32m' + visible + '\u001b[0m', visible],
        ['\u009d2;owned application\u009c' + visible, visible],
        ['\u001b]2;owned application\u009c' + visible, visible],
        ['\u001b]2;first\u001b\\first\u001b]2;second\u0007second', 'firstsecond'],
        ['native_tool_name 世界🌍', 'native_tool_name 世界🌍'],
    ]) assert.equal(normalizeReadinessLine(input), expected);
});

producerTest('pattern readiness returns the complete actual matched native line', async (t, scope, run) => {
    const directory = await scope.directory('pattern process dependency');
    const count = run.registry.resources.length;
    for (const readyLine of [{ pattern: '[' }, { pattern: 42 }, { pattern: 'browser-bound-port ', unexpected: true }]) {
        await assert.rejects(launchOwnedProcess(scope, { label: 'invalid readiness pattern', command: [process.execPath], readyLine }), /readiness/i);
        assert.equal(run.registry.resources.length, count);
    }
    const formatted = '\u001b]2;owned application\u001b\\[' + new Date().toISOString() + '] browser-bound-port ';
    const { normalizeReadinessLine } = await import('./resources/process-diagnostics.js');
    assert.equal(normalizeReadinessLine(formatted + '54321'), formatted.slice(formatted.indexOf('[')) + '54321');
    const lease = await launchOwnedProcess(scope, { label: 'pattern process', command: [process.execPath, fileURLToPath(new URL('./fixtures/browser/application.mjs', import.meta.url)), JSON.stringify({ dataRoot: directory.path, readyPrefix: formatted })], readyLine: { pattern: '\\[[^\\]]+\\] browser-bound-port [0-9]+' }, dependsOn: [directory.resourceId] });
    const bound = JSON.parse(fs.readFileSync(path.join(directory.path, 'bound.json'), 'utf8'));
    producerProcesses.push({ pid: lease.pid, port: bound.port });
    assert.equal(lease.readyLine, formatted + bound.port);
});

for (const target of ['data', 'configuration']) producerTest(`application startup refuses a substituted ${target} path before process allocation`, async (t, scope, run) => {
    const { startServer } = await import('./server.js');
    const other = await scope.directory('unselected application data');
    fs.writeFileSync(path.join(other.path, 'original.bin'), Buffer.from([0, 255, 37]));
    let changed;
    const hook = createHook({ promiseResolve() {
        if (changed) return;
        const owner = run.registry.resources.find(resource => resource.kind === 'directory' && resource.label === 'materialized seed' && resource.state === 'ready' && fs.existsSync(path.join(resource.locator.path, 'data')));
        if (!owner) return;
        hook.disable();
        changed = { data: path.join(owner.locator.path, target === 'data' ? 'data' : 'config.yaml'), retained: path.join(owner.locator.path, 'retained-selected-input') };
        fs.renameSync(changed.data, changed.retained);
        const destination = target === 'data' ? other.path : path.join(other.path, 'selected-config.yaml');
        if (target === 'configuration') fs.copyFileSync(changed.retained, destination);
        fs.symlinkSync(destination, changed.data);
    } });
    hook.enable();
    let result, names;
    try {
        [result] = await Promise.allSettled([startServer({ scope, batchKey: 'application', scenarioId: 'substituted data' })]);
        if (result.status === 'fulfilled') {
            producerProcesses.push({ pid: result.value.pid, port: result.value.port });
            await result.value.stop();
        }
        names = fs.readdirSync(other.path);
    } finally {
        hook.disable();
        if (changed) {
            fs.unlinkSync(changed.data);
            fs.renameSync(changed.retained, changed.data);
        }
    }
    assert.ok(changed, 'The actual seed completion boundary must execute');
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, target === 'data' ? /application data.*real directory|application data.*ownership/i : /application configuration.*regular file|application configuration.*ownership/i);
    assert.deepEqual(names.sort(), target === 'data' ? ['original.bin'] : ['original.bin', 'selected-config.yaml']);
    assert.equal(run.registry.resources.some(resource => resource.kind === 'process'), false);
});

for (const mode of ['server-start', 'server-restart', 'server-owned', 'server-borrowed', 'server-conflict', 'server-foreign', 'server-invalid-init', 'server-ipv6']) test(`owned application startup completes ${mode} with actual data and process ownership`, async t => {
    const input = { ...outcomeFixture(t), mode, environment: { LUKER_RUNTIME: 'node' } };
    const result = await nativeRun(t, input);
    const expected = ['server-conflict', 'server-foreign', 'server-invalid-init'].includes(mode) ? 1 : 0;
    assert.equal(result.code, expected, result.output);
    const report = JSON.parse(fs.readFileSync(path.join(input.projectRoot, 'native-output/managed-run.json'), 'utf8'));
    const project = report.projects[0];
    const summary = JSON.parse(fs.readFileSync(project.registryPath, 'utf8'));
    assert.equal(summary.status, expected === 0 ? 'passed' : 'failed');
    assert.ok(summary.resources.every(resource => ['disposed', 'released'].includes(resource.state)));
    if (mode === 'server-conflict') assert.ok(nodes(summary.errors).some(error => error.code === 'EADDRINUSE'), result.output);
    if (mode === 'server-foreign') {
        assert.match(JSON.stringify(summary.errors), /directory receipt.*match.*registered/i);
        assert.equal(summary.resources.some(resource => resource.kind === 'process'), false);
    }
    if (mode === 'server-invalid-init') {
        assert.match(JSON.stringify(summary.errors), /can't disable all internet protocols/i);
        assert.ok(summary.resources.some(resource => resource.kind === 'process'));
    }
    const receipts = fs.readdirSync(input.root).filter(name => /^server-ready-\d+\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(path.join(input.root, name), 'utf8')));
    if (expected === 0 || mode === 'server-conflict') assert.equal(receipts.length, 1, 'Actual product startup must return an owned application handle');
    for (const receipt of receipts) {
        assert.equal(receipt.workerRuntime.version, process.version);
        assert.equal(receipt.workerRuntime.execPath, process.execPath);
        assert.equal(receipt.workerRuntime.sourceSHA256, hash(fs.readFileSync(new URL('./fixtures/browser/server.spec.mjs', import.meta.url))));
        assert.equal(receipt.applicationVersion, process.version);
        assert.ok(receipt.port > 0 && receipt.port <= 65535);
        assert.equal(fs.existsSync(receipt.dataRoot), false);
        assert.equal(fs.existsSync(receipt.configOwner.path), false);
        const processRecord = summary.resources.find(resource => resource.resourceId === receipt.resourceId);
        assert.deepEqual([...processRecord.dependencies].sort(), [...new Set([receipt.configOwner.resourceId, receipt.dataOwner.resourceId])].sort());
        for (const pid of [receipt.pid, receipt.previousPid].filter(value => value !== undefined)) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
        await noListener(receipt.port);
        if (mode === 'server-restart') assert.notEqual(receipt.previousPid, receipt.pid);
    }
    t.diagnostic(JSON.stringify({ ownedServerLifecycle: { mode, report, summary, receipts } }));
});

after(async () => {
    for (const { pid, port } of producerProcesses) {
        assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
        await noListener(port);
    }
});
