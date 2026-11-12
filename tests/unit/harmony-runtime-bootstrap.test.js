import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareHarmonyRuntime } from '../../harmony-app/resfile-src/bootstrap.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE_CTL_C = path.join(REPO_ROOT, 'harmony-app', 'entry', 'src', 'main', 'cpp', 'node_ctl.c');
const INDEX_ETS = path.join(REPO_ROOT, 'harmony-app', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
const PREPARE_WEB_SH = path.join(REPO_ROOT, 'harmony-app', 'scripts', 'prepare-web.sh');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('HarmonyOS zero-copy symlink runtime bootstrap & parity', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    test('prepareHarmonyRuntime links top-level bundle entries, sets up _server-plugins and full CLI paths without copying', () => {
        const root = makeTempDir('luker-harmony-boot-');
        tempDirs.push(root);

        const sourceRoot = path.join(root, 'resfile', 'luker');
        const dataRoot = path.join(root, 'el2', 'luker-data');
        const runtimeRoot = path.join(root, 'el2', 'luker-runtime');

        fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'default'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'plugins'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'node_modules', 'demo'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, '_prebuilt-bundles'), { recursive: true });

        fs.writeFileSync(path.join(sourceRoot, 'server.js'), 'export default {};\n');
        fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"luker","type":"module"}\n');
        fs.writeFileSync(path.join(sourceRoot, 'config.yaml'), 'port: 8000\n');
        fs.writeFileSync(path.join(sourceRoot, '.runtime-tree-version'), 'sha256-123456\n');
        fs.writeFileSync(path.join(sourceRoot, '_prebuilt-bundles', 'lib.core.bundle.js'), '// core\n');

        const result = prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });

        expect(fs.lstatSync(path.join(runtimeRoot, 'server.js')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(runtimeRoot, 'src')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(runtimeRoot, 'node_modules')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(runtimeRoot, '_server-plugins')).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(path.join(runtimeRoot, '_server-plugins'))).toBe(
            fs.realpathSync(path.join(dataRoot, 'plugins')),
        );
        expect(
            JSON.parse(fs.readFileSync(path.join(dataRoot, 'plugins', 'package.json'), 'utf8')),
        ).toEqual({ name: 'sillytavern-plugins', type: 'commonjs' });

        expect(result.cliArgs).toEqual([
            '--port', '8000',
            '--dataRoot', dataRoot,
            '--serverPluginsPath', path.join(dataRoot, 'plugins'),
            '--globalExtensionsPath', path.join(dataRoot, 'extensions', 'third-party'),
            '--configPath', path.join(dataRoot, 'config.yaml'),
            '--backupsPath', path.join(dataRoot, 'backups'),
        ]);
        expect(result.prebuiltBundlesDir).toBe(path.join(runtimeRoot, '_prebuilt-bundles'));
    });

    test('prepareHarmonyRuntime migrates legacy copied runtime plugins, third-party extensions, and config before replacing real directories with symlinks', () => {
        const root = makeTempDir('luker-harmony-migrate-');
        tempDirs.push(root);

        const sourceRoot = path.join(root, 'resfile', 'luker');
        const dataRoot = path.join(root, 'el2', 'luker-data');
        const runtimeRoot = path.join(root, 'el2', 'luker-runtime');

        fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'plugins'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'server.js'), 'export default {};\n');
        fs.writeFileSync(path.join(sourceRoot, 'config.yaml'), 'port: 8000\n');
        fs.writeFileSync(path.join(sourceRoot, '.runtime-tree-version'), 'sha256-abcdef\n');

        // Simulate legacy copied layout in runtimeRoot
        fs.mkdirSync(path.join(runtimeRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'src', 'old.js'), 'old');
        fs.mkdirSync(path.join(runtimeRoot, 'plugins', 'user-plugin'), { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'plugins', 'user-plugin', 'index.js'), 'module.exports = 1;');
        fs.mkdirSync(path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party', 'user-ext'), {
            recursive: true,
        });
        fs.writeFileSync(
            path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party', 'user-ext', 'manifest.json'),
            '{"display_name":"User Ext"}',
        );
        fs.writeFileSync(path.join(runtimeRoot, 'config.yaml'), 'port: 8123 # customized\n');
        fs.writeFileSync(path.join(runtimeRoot, 'whitelist.txt'), '127.0.0.1\n192.168.1.5\n');
        fs.writeFileSync(path.join(runtimeRoot, '.bundle-marker'), 'legacy-signature');

        prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });

        // Legacy user artifacts migrated to dataRoot / preserved in runtimeRoot
        expect(fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8')).toContain('8123');
        expect(
            fs.readFileSync(path.join(dataRoot, 'plugins', 'user-plugin', 'index.js'), 'utf8'),
        ).toBe('module.exports = 1;');
        expect(
            fs.readFileSync(
                path.join(dataRoot, 'extensions', 'third-party', 'user-ext', 'manifest.json'),
                'utf8',
            ),
        ).toContain('User Ext');
        expect(fs.readFileSync(path.join(runtimeRoot, 'whitelist.txt'), 'utf8')).toContain('192.168.1.5');

        // Old real directories replaced by symlinks and .bundle-marker pruned
        expect(fs.lstatSync(path.join(runtimeRoot, 'src')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(runtimeRoot, 'plugins')).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(path.join(runtimeRoot, 'public')).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(path.join(runtimeRoot, '.bundle-marker'))).toBe(false);

        // Subsequent launch does not clobber migrated files or follow symlinks into read-only sourceRoot
        prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });
        expect(
            fs.readFileSync(path.join(dataRoot, 'plugins', 'user-plugin', 'index.js'), 'utf8'),
        ).toBe('module.exports = 1;');
    });

    test('node_ctl.c passes --preserve-symlinks and Index.ets keeps screen on + offers retry/export on startup failure', () => {
        const nodeCtl = fs.readFileSync(NODE_CTL_C, 'utf8');
        expect(nodeCtl).toContain('"--preserve-symlinks"');
        expect(nodeCtl).toContain('"--preserve-symlinks-main"');

        const indexEts = fs.readFileSync(INDEX_ETS, 'utf8');
        expect(indexEts).toContain('setKeepScreenOn(');
        expect(indexEts).toContain('startupFailed');
        expect(indexEts).toContain('endpoint_failure_retry');
        expect(indexEts).toContain('export_diagnostics');

        const prepareWeb = fs.readFileSync(PREPARE_WEB_SH, 'utf8');
        expect(prepareWeb).toContain('scripts/stage-mobile-runtime.mjs');
    });
});
