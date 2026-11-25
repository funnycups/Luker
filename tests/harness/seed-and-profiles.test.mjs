import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test as nativeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { test as managedTest } from './node.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const options = { projectRoot: repository, profile: 'seed-profiles', command: [process.execPath, '--test', 'harness/seed-and-profiles.test.mjs'], source: 'seed-profile-contract' };
const allocatedSeeds = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const catalog = () => JSON.parse(fs.readFileSync(new URL('./coverage-map.json', import.meta.url), 'utf8'));
const pendingRuns = () => {
    const directory = path.join(repository, 'test-results/harness/runs');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => {
        const registry = path.join(directory, name, 'registry.json');
        return fs.existsSync(registry) && JSON.parse(fs.readFileSync(registry, 'utf8')).owner.native.pid === process.pid;
    }).sort();
};

function testEntries(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) return testEntries(filename);
        return /(?:\.test\.(?:js|mjs)|\.e2e\.js)$/.test(filename) ? [{ path: path.relative(repository, filename) }] : [];
    });
}

async function inputs(scope) {
    const source = await scope.directory('explicit seed inputs');
    const defaultsRoot = path.join(source.path, 'default');
    fs.mkdirSync(path.join(defaultsRoot, 'content'), { recursive: true });
    fs.writeFileSync(path.join(defaultsRoot, 'config.yaml'), 'dataRoot: ./data\nstorage:\n  mode: fs\n  retries:\n    transient: 3\n  mysql:\n    poolSize: 10\nlistenAddress:\n  ipv4: 127.0.0.1\n  ipv6: "::1"\n');
    fs.writeFileSync(path.join(defaultsRoot, 'content/settings.json'), JSON.stringify({ firstRun: true, power_user: { retained: 'original' }, tools: ['literal_tool_name'], sequence: [1, 2] }));
    const binary = path.join(source.path, 'selected.bin');
    fs.writeFileSync(binary, Buffer.from([0, 255, 13, 10, 42]));
    return { source: source.path, defaultsRoot, binary };
}

nativeTest('profile import and selection allocate no runtime resources', async () => {
    const before = pendingRuns();
    const allocations = [];
    const watched = new Set(['PROCESSWRAP', 'TCPSERVERWRAP', 'TCPWRAP', 'UDPSENDWRAP', 'UDPWRAP']);
    const hook = createHook({ init(id, type) { if (watched.has(type)) allocations.push(type); } });
    hook.enable();
    let profiles;
    try {
        profiles = await import('./profiles.js?inert-profile-contract');
        for (const name of Object.keys(catalog().profiles)) assert.equal(profiles.getProfile(name).name, name);
    } finally { hook.disable(); }
    assert.deepEqual(allocations, []);
    assert.deepEqual(pendingRuns(), before);
});

nativeTest('stable profiles retain required databases, native coverage and distinct browser scopes', async () => {
    const { getProfile } = await import('./profiles.js');
    const names = ['unit', 'storage-local', 'storage-sql', 'e2e', 'frontend', 'skills-ui', 'desktop', 'desktop-packaged', 'compatibility'];
    for (const name of names) {
        const profile = getProfile(name);
        assert.equal(profile.diagnosticSlot, name);
        assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.files));
        if (profile.files.length) {
            const selected = getProfile(name, { files: [profile.files[0]] });
            assert.deepEqual(selected.files, [profile.files[0]]);
            assert.equal(selected.diagnosticSlot, name);
        }
    }
    assert.deepEqual(getProfile('storage-sql').requiredDatabases, ['mysql', 'postgres']);
    assert.deepEqual(getProfile('storage-sql').frameworks, ['node', 'jest']);
    assert.deepEqual(getProfile('storage-sql').missingFrameworks, []);
    assert.deepEqual(getProfile('unit').requiredDatabases, []);
    for (const filename of ['database-lifecycle.test.mjs', 'database-recovery.test.mjs', 'runner-recovery.test.mjs']) {
        assert.ok(getProfile('storage-sql').files.includes(`tests/harness/${filename}`));
        assert.ok(!getProfile('unit').files.includes(`tests/harness/${filename}`));
    }
    assert.ok(getProfile('unit').files.includes('tests/harness/jest-lifecycle.test.mjs'));
    assert.deepEqual(getProfile('storage-local').backends, ['fs', 'sqlite']);
    assert.deepEqual(getProfile('storage-local').requiredDatabases, []);
    assert.ok(getProfile('unit').files.includes('tests/harness/resource-scope.test.mjs'));
    assert.ok(getProfile('unit').files.includes('tests/skills-ui/bundled-browser.test.js'));
    assert.ok(getProfile('frontend').files.every(name => name.startsWith('tests/frontend/')));
    assert.deepEqual(getProfile('skills-ui').missingFrameworks, ['playwright']);
    assert.deepEqual(getProfile('compatibility').input, { kind: 'explicit-directory', required: true });
    assert.throws(() => getProfile('not-a-profile'), /Unknown.*profile/);
    assert.throws(() => getProfile('unit', { files: [] }), /empty.*selection/i);
    assert.throws(() => getProfile('unit', { files: ['tests/not-declared.test.js'] }), /not.*unit|not.*declared/i);
    assert.throws(() => getProfile('unit', { workers: 2 }), /Unknown.*option/);
});

nativeTest('coverage inventory preserves backend and behavior contracts', async () => {
    const { validateCoverageMap } = await import('./profiles.js');
    const mapping = catalog();
    const observed = testEntries(path.join(repository, 'tests'));
    const complete = validateCoverageMap(observed, mapping);
    assert.equal(complete.valid, true, JSON.stringify(complete.errors));
    assert.equal(complete.files, observed.length);
    const sqlSource = mapping.files.find(entry => entry.path === 'tests/storage/endpoints/cross-mode-restore.parity.test.js');
    assert.deepEqual(sqlSource.backends, ['fs', 'sqlite', 'mysql', 'postgres']);
    assert.ok(mapping.files.find(entry => entry.path === 'tests/sync/materialize-cross-engine.test.js').backendMatrix);
    assert.deepEqual(mapping.files.find(entry => entry.path === 'tests/sync/integration/full-flow.test.js').backends, ['fs']);
    assert.ok(mapping.files.find(entry => entry.path === 'tests/e2e/memorygraph/73-crawl-mode-extract-nonstream.e2e.js').behaviors.length);
    const first = mapping.files[0];
    const sample = { ...mapping, files: [{ ...first, backends: ['fs', 'sqlite'], resources: ['directory'], behaviors: ['write then read', 'failed write preserves state'] }] };
    const expected = [{ path: first.path, backends: ['fs', 'sqlite'], resources: ['directory'], behaviors: [...sample.files[0].behaviors] }];
    assert.equal(validateCoverageMap(expected, sample).valid, true);
    for (const [change, message] of [
        [value => { value.files = []; }, /unmapped/i],
        [value => { value.files.push({ ...value.files[0] }); }, /duplicate/i],
        [value => { value.files[0].backends = ['fs']; }, /sqlite/],
        [value => { value.files[0].resources = []; }, /directory/],
        [value => { value.files[0].behaviors.pop(); }, /failed write preserves state/],
        [value => { value.profiles = []; }, /profiles/i],
    ]) {
        const changed = structuredClone(sample);
        change(changed);
        const report = validateCoverageMap(expected, changed);
        assert.equal(report.valid, false);
        assert.match(JSON.stringify(report.errors), message);
    }
});

managedTest('seed uses declared defaults and structured overrides without local runtime data', options, async (t, scope) => {
    const { materializeSeed } = await import('./seed.js');
    const input = await inputs(scope);
    const personal = path.join(input.source, 'data');
    fs.mkdirSync(personal);
    fs.writeFileSync(path.join(personal, 'must-not-copy'), 'unselected local input');
    fs.chmodSync(personal, 0o000);
    await scope.onFinalize({ label: 'restore selected fixture permissions', stage: 'drain', callback: () => fs.chmodSync(personal, 0o700) });
    const originalConfig = fs.readFileSync(path.join(input.defaultsRoot, 'config.yaml'));
    const originalSettings = fs.readFileSync(path.join(input.defaultsRoot, 'content/settings.json'));
    const seed = await materializeSeed(scope, {
        fixture: { kind: 'defaults', defaultsRoot: input.defaultsRoot, files: [{ source: input.binary, path: 'default-user/files/selected.bin' }] },
        configOverrides: { storage: { mode: 'sqlite', retries: { transient: 0 } }, listenAddress: { ipv4: '127.0.0.2' } },
        settingsOverrides: { firstRun: false, power_user: { frontend_debug_logging: true }, sequence: [7], ...JSON.parse('{"__proto__":{"literal":true}}') },
    });
    allocatedSeeds.push(path.dirname(seed.configPath));
    const config = parseYaml(fs.readFileSync(seed.configPath, 'utf8'));
    assert.equal(config.dataRoot, seed.dataRoot);
    assert.deepEqual(config.storage, { mode: 'sqlite', retries: { transient: 0 }, mysql: { poolSize: 10 } });
    assert.deepEqual(config.listenAddress, { ipv4: '127.0.0.2', ipv6: '::1' });
    const settings = JSON.parse(fs.readFileSync(path.join(seed.dataRoot, 'default-user/settings.json'), 'utf8'));
    assert.deepEqual(settings.power_user, { retained: 'original', frontend_debug_logging: true });
    assert.deepEqual(settings.sequence, [7]);
    assert.deepEqual(settings.tools, ['literal_tool_name']);
    assert.equal(settings.firstRun, false);
    assert.deepEqual(Object.getOwnPropertyDescriptor(settings, '__proto__').value, { literal: true });
    assert.equal({}.literal, undefined);
    assert.deepEqual(fs.readFileSync(path.join(seed.dataRoot, 'default-user/files/selected.bin')), fs.readFileSync(input.binary));
    assert.equal(fs.existsSync(path.join(seed.dataRoot, 'must-not-copy')), false);
    assert.deepEqual(fs.readFileSync(path.join(input.defaultsRoot, 'config.yaml')), originalConfig);
    assert.deepEqual(fs.readFileSync(path.join(input.defaultsRoot, 'content/settings.json')), originalSettings);
    const manifest = JSON.parse(fs.readFileSync(seed.manifestPath, 'utf8'));
    assert.equal(manifest.format, 'test-seed-v1');
    for (const source of manifest.sources) assert.equal(sha(fs.readFileSync(source.path)), source.sha256);
    for (const output of manifest.outputs) assert.equal(sha(fs.readFileSync(path.join(path.dirname(seed.configPath), output.path))), output.sha256);
    assert.equal(manifest.sources.some(source => source.path.startsWith(personal + path.sep)), false);
    const changing = materializeSeed(scope, { fixture: { kind: 'defaults', defaultsRoot: input.defaultsRoot } });
    fs.appendFileSync(path.join(input.defaultsRoot, 'config.yaml'), '\nchanged: true\n');
    await assert.rejects(changing, /source changed.*config\.yaml/i);
});

managedTest('seed targets are isolated and default inputs are versioned', options, async (t, scope) => {
    const { materializeSeed } = await import('./seed.js');
    const [left, right] = await Promise.all([materializeSeed(scope, {}), materializeSeed(scope, {})]);
    allocatedSeeds.push(path.dirname(left.configPath), path.dirname(right.configPath));
    assert.notEqual(left.dataRoot, right.dataRoot);
    assert.deepEqual(fs.readFileSync(path.join(left.dataRoot, 'default-user/settings.json')), fs.readFileSync(path.join(right.dataRoot, 'default-user/settings.json')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(left.dataRoot, 'default-user/settings.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(repository, 'default/content/settings.json'), 'utf8')));
    fs.writeFileSync(path.join(left.dataRoot, 'only-left'), 'isolated');
    assert.equal(fs.existsSync(path.join(right.dataRoot, 'only-left')), false);
});

managedTest('compatibility seed requires explicit readonly input and preserves complete selected bytes', options, async (t, scope) => {
    const { materializeSeed } = await import('./seed.js');
    const input = await inputs(scope);
    const source = path.join(input.source, 'compatibility');
    fs.mkdirSync(path.join(source, 'default-user/empty'), { recursive: true });
    const original = Buffer.from('{"prompt":"retained explicit input","firstRun":false}\n');
    fs.writeFileSync(path.join(source, 'default-user/settings.json'), original);
    fs.writeFileSync(path.join(source, 'default-user/selected.bin'), Buffer.from([0, 255, 13]));
    const seed = await materializeSeed(scope, { fixture: { kind: 'compatibility', root: source, defaultsRoot: input.defaultsRoot } });
    allocatedSeeds.push(path.dirname(seed.configPath));
    assert.deepEqual(fs.readFileSync(path.join(seed.dataRoot, 'default-user/settings.json')), original);
    assert.deepEqual(fs.readFileSync(path.join(seed.dataRoot, 'default-user/selected.bin')), Buffer.from([0, 255, 13]));
    assert.ok(fs.statSync(path.join(seed.dataRoot, 'default-user/empty')).isDirectory());
    assert.deepEqual(fs.readFileSync(path.join(source, 'default-user/settings.json')), original);
    await assert.rejects(materializeSeed(scope, { fixture: { kind: 'compatibility' } }), /explicit.*root|root.*explicit/i);
});

managedTest('seed refuses a replaced acquired directory before writing foreign bytes', options, async (t, scope, run) => {
    const { materializeSeed } = await import('./seed.js');
    const input = await inputs(scope);
    const foreign = path.join(input.source, 'other-owned-data');
    fs.mkdirSync(foreign);
    const original = Buffer.from([0, 255, 41]);
    fs.writeFileSync(path.join(foreign, 'original.bin'), original);
    let replacement;
    const hook = createHook({ init(id, type) {
        if (type !== 'FSREQCALLBACK' || !new Error().stack.includes('/resources/registry.js:')) return;
        const record = run.registry.resources.find(resource => resource.label === 'materialized seed' && resource.state === 'ready');
        if (!record) return;
        hook.disable();
        replacement = { path: record.locator.path, retained: record.locator.path + '-registered', dev: record.locator.dev, ino: record.locator.ino };
        fs.renameSync(replacement.path, replacement.retained);
        fs.renameSync(foreign, replacement.path);
    } });
    hook.enable();
    let result, names, bytes;
    try {
        [result] = await Promise.allSettled([materializeSeed(scope, { fixture: { kind: 'defaults', defaultsRoot: input.defaultsRoot } })]);
        assert.ok(replacement, 'The native acquisition publication boundary must execute');
        allocatedSeeds.push(replacement.path);
        names = fs.readdirSync(replacement.path);
        bytes = fs.readFileSync(path.join(replacement.path, 'original.bin'));
    } finally {
        hook.disable();
        if (replacement) {
            fs.renameSync(replacement.path, foreign);
            fs.renameSync(replacement.retained, replacement.path);
        }
    }
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /target ownership changed|identity changed/i);
    assert.deepEqual(names, ['original.bin']);
    assert.deepEqual(bytes, original);
});

managedTest('invalid seed inputs refuse before target allocation with actionable paths', options, async (t, scope, run) => {
    const { materializeSeed } = await import('./seed.js');
    const input = await inputs(scope);
    const count = run.registry.resources.length;
    const ordinary = { kind: 'defaults', defaultsRoot: input.defaultsRoot };
    for (const [request, message] of [
        [{ fixture: { ...ordinary, files: [{ source: input.binary, path: '../outside' }] } }, /outside|relative/i],
        [{ fixture: { ...ordinary, files: [{ source: input.binary, path: 'default-user/settings.json' }] } }, /settings/i],
        [{ fixture: { ...ordinary, defaultsRoot: path.join(input.source, 'absent') } }, /absent/],
        [{ fixture: ordinary, configOverrides: { dataRoot: input.source } }, /dataRoot/],
        [{ fixture: ordinary, settingsOverrides: { invalid: Infinity } }, /invalid|finite/i],
        [{ fixture: ordinary, settings: {} }, /Unknown.*settings/i],
        [{ fixture: { ...ordinary, root: input.source } }, /Unknown.*root/i],
    ]) {
        await assert.rejects(materializeSeed(scope, request), message);
        assert.equal(run.registry.resources.length, count);
    }
    const link = path.join(input.source, 'linked.bin');
    fs.symlinkSync(input.binary, link);
    await assert.rejects(materializeSeed(scope, { fixture: { ...ordinary, files: [{ source: link, path: 'linked.bin' }] } }), /symbolic|symlink/i);
    for (const text of ['storage: {mode: fs}\nstorage: {mode: sqlite}\n', 'storage: !unresolved fs\n', '? [invalid, key]\n: value\n']) {
        fs.writeFileSync(path.join(input.defaultsRoot, 'config.yaml'), text);
        await assert.rejects(materializeSeed(scope, { fixture: ordinary }), /config\.yaml/);
        assert.equal(run.registry.resources.length, count);
    }
    const { parseYamlConfigDocument } = await import('./seed.js');
    for (const text of ['a: 1\na: 2\n', 'x: !unknown 1\n', '? [bad\n: 1\n']) {
        assert.throws(() => parseYamlConfigDocument(text, 'restart config'), /Invalid restart config/);
    }
});

after(() => {
    for (const directory of allocatedSeeds) assert.equal(fs.existsSync(directory), false, `Managed seed was not released: ${directory}`);
});
