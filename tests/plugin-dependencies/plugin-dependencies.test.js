import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test } from '@jest/globals';

import { getPluginDependencyStatus, installPluginDependencies } from '../../src/plugin-dependencies.js';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'default/config.yaml');
const UTIL_URL = pathToFileURL(path.join(REPO_ROOT, 'src/util.js')).href;
const PLUGIN_DEPS_URL = pathToFileURL(path.join(REPO_ROOT, 'src/plugin-dependencies.js')).href;
const roots = [];

function makePlugin(packageJson) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-deps-'));
    roots.push(root);
    if (packageJson !== undefined) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
    }
    return root;
}

afterEach(() => {
    while (roots.length) {
        fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
});

describe('getPluginDependencyStatus', () => {
    test('no package.json means no dependencies', () => {
        const root = makePlugin(undefined);
        expect(getPluginDependencyStatus(root)).toEqual({
            hasDependencies: false, declared: [], missing: [], needsInstall: false,
        });
    });

    test('package.json without dependencies needs nothing', () => {
        const root = makePlugin({ name: 'x', version: '1.0.0' });
        expect(getPluginDependencyStatus(root).needsInstall).toBe(false);
    });

    test('declared dependency with no node_modules is missing', () => {
        const root = makePlugin({ dependencies: { dayjs: '^1.11.13' } });
        expect(getPluginDependencyStatus(root)).toEqual({
            hasDependencies: true, declared: ['dayjs'], missing: ['dayjs'], needsInstall: true,
        });
    });

    test('installed dependency is not missing', () => {
        const root = makePlugin({ dependencies: { dayjs: '^1.11.13' } });
        const installed = path.join(root, 'node_modules', 'dayjs');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(path.join(installed, 'package.json'), '{}');
        expect(getPluginDependencyStatus(root)).toEqual({
            hasDependencies: true, declared: ['dayjs'], missing: [], needsInstall: false,
        });
    });

    test('optional-only dependencies expose the install action', () => {
        const root = makePlugin({ optionalDependencies: { 'tiny-dep': '1.0.0' } });
        expect(getPluginDependencyStatus(root)).toEqual({
            hasDependencies: true, declared: ['tiny-dep'], missing: ['tiny-dep'], needsInstall: true,
        });
    });

    test('overlapping declarations count installed optional dependencies once', () => {
        const root = makePlugin({
            dependencies: { required: '1.0.0', shared: '1.0.0' },
            optionalDependencies: { shared: '2.0.0', optional: '1.0.0' },
            devDependencies: { development: '1.0.0' },
        });
        for (const name of ['optional', 'shared']) {
            const installed = path.join(root, 'node_modules', name);
            fs.mkdirSync(installed, { recursive: true });
            fs.writeFileSync(path.join(installed, 'package.json'), '{}');
        }
        expect(getPluginDependencyStatus(root)).toEqual({
            hasDependencies: true, declared: ['optional', 'required', 'shared'], missing: ['required'], needsInstall: true,
        });
    });
});

function makeInstalledFixture(dependencyField = 'dependencies') {
    const pluginsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-install-'));
    roots.push(pluginsPath);
    const dep = path.join(pluginsPath, 'tiny-dep');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'tiny-dep', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = { value: 42 };');

    const plugin = path.join(pluginsPath, 'demo-plugin');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
        name: 'demo-plugin', version: '1.0.0', type: 'commonjs', main: 'index.js',
        [dependencyField]: { 'tiny-dep': `file:${dep}` },
    }));
    fs.writeFileSync(path.join(plugin, 'index.js'), 'module.exports = require("tiny-dep");');
    return pluginsPath;
}

describe('installPluginDependencies', () => {
    test.each([{}, { forceManager: 'arborist' }])('installs optional-only dependencies with %j', async (options) => {
        const pluginsPath = makeInstalledFixture('optionalDependencies');
        const result = await installPluginDependencies(pluginsPath, 'demo-plugin', options);
        expect(result.installed).toBe(true);
        expect(result.manager).toBe(options.forceManager || 'npm');
        expect(getPluginDependencyStatus(result.path)).toEqual({
            hasDependencies: true, declared: ['tiny-dep'], missing: [], needsInstall: false,
        });
        expect(require(path.join(result.path, 'index.js')).value).toBe(42);
    }, 120000);

    test('installs declared dependencies and reports the manager', async () => {
        const pluginsPath = makeInstalledFixture();
        const result = await installPluginDependencies(pluginsPath, 'demo-plugin');
        expect(result.directory).toBe('demo-plugin');
        expect(['npm', 'arborist']).toContain(result.manager);
        expect(result.installed).toBe(true);
        expect(getPluginDependencyStatus(result.path).needsInstall).toBe(false);
        const resolved = require(path.join(result.path, 'node_modules', 'tiny-dep', 'index.js'));
        expect(resolved.value).toBe(42);
    }, 120000);

    test('installs declared dependencies with arborist when npm is unavailable', async () => {
        const pluginsPath = makeInstalledFixture();
        const result = await installPluginDependencies(pluginsPath, 'demo-plugin', { forceManager: 'arborist' });
        expect(result.directory).toBe('demo-plugin');
        expect(result.manager).toBe('arborist');
        expect(result.installed).toBe(true);
        expect(getPluginDependencyStatus(result.path).needsInstall).toBe(false);
        const resolved = require(path.join(result.path, 'node_modules', 'tiny-dep', 'index.js'));
        expect(resolved.value).toBe(42);
    }, 120000);

    test('rejects a directory that escapes the plugins root', async () => {
        const pluginsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-escape-'));
        roots.push(pluginsPath);
        await expect(installPluginDependencies(pluginsPath, '..')).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringMatching(/escapes/),
        });
    });

    test('rejects a dot directory with 400', async () => {
        const pluginsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dot-'));
        roots.push(pluginsPath);
        await expect(installPluginDependencies(pluginsPath, '.')).rejects.toMatchObject({ statusCode: 400 });
    });

    test('rejects a missing plugin directory with 404', async () => {
        const pluginsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-missing-'));
        roots.push(pluginsPath);
        await expect(installPluginDependencies(pluginsPath, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    });

    test('rejects a missing plugin directory name with 400', async () => {
        const pluginsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-noname-'));
        roots.push(pluginsPath);
        await expect(installPluginDependencies(pluginsPath, '   ')).rejects.toMatchObject({ statusCode: 400 });
    });

    test.each(['ios', 'openharmony', 'android'])(
        'skips external npm probing and installs via arborist on mobile runtime (%s)',
        async (platform) => {
            const pluginsPath = makeInstalledFixture();
            const resultFile = path.join(pluginsPath, 'mobile-result.json');
            const child = await new Promise((resolve) => {
                const proc = spawn(process.execPath, ['--input-type=module', '-e', `
                    import childProcess from 'node:child_process';
                    import fs from 'node:fs';
                    import { syncBuiltinESMExports } from 'node:module';

                    const spawnCalls = [];
                    const deny = (cmd) => {
                        spawnCalls.push(String(cmd));
                        throw Object.assign(new Error(\`spawn \${cmd} EPERM\`), { code: 'EPERM', syscall: \`spawn \${cmd}\` });
                    };
                    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
                    childProcess.spawn = deny;
                    childProcess.spawnSync = deny;
                    childProcess.exec = deny;
                    childProcess.execSync = deny;
                    childProcess.execFile = deny;
                    childProcess.execFileSync = deny;
                    syncBuiltinESMExports();

                    globalThis.DATA_ROOT = ${JSON.stringify(pluginsPath)};
                    const { setConfigFilePath } = await import(${JSON.stringify(UTIL_URL)});
                    setConfigFilePath(${JSON.stringify(DEFAULT_CONFIG_PATH)});
                    const { installPluginDependencies } = await import(${JSON.stringify(PLUGIN_DEPS_URL)});
                    const res = await installPluginDependencies(${JSON.stringify(pluginsPath)}, 'demo-plugin');
                    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ spawnCalls, res }));
                `], { cwd: REPO_ROOT });
                let stderr = '';
                proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
                proc.on('close', (status) => resolve({ status, stderr }));
            });

            expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
            const payload = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
            expect(payload.spawnCalls).toEqual([]);
            expect(payload.res).toMatchObject({
                directory: 'demo-plugin',
                manager: 'arborist',
                installed: true,
            });
            expect(require(path.join(payload.res.path, 'node_modules', 'tiny-dep', 'index.js')).value).toBe(42);
        },
        120000,
    );
});
