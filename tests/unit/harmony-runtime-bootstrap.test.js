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

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

describe('HarmonyOS copy-based runtime bootstrap', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
        }
    });

    test('copies top-level bundle entries into a real runtime and points plugin and extension paths at it', () => {
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

        writeFile(path.join(sourceRoot, 'server.js'), 'export default {};\n');
        writeFile(path.join(sourceRoot, 'package.json'), '{"name":"luker","type":"module"}\n');
        writeFile(path.join(sourceRoot, 'config.yaml'), 'port: 8000\n');
        writeFile(path.join(sourceRoot, 'whitelist.txt'), '127.0.0.1\n');
        writeFile(path.join(sourceRoot, 'plugins', 'builtin-plugin.js'), 'module.exports = 1;\n');
        writeFile(path.join(sourceRoot, 'runtime-tree-version.txt'), 'sha256-123456\n');
        writeFile(path.join(sourceRoot, '_prebuilt-bundles', 'lib.core.bundle.js'), '// core\n');

        const result = prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });

        expect(fs.lstatSync(path.join(runtimeRoot, 'server.js')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(runtimeRoot, 'src')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(runtimeRoot, 'node_modules')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(runtimeRoot, 'plugins')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(runtimeRoot, 'public')).isSymbolicLink()).toBe(false);
        expect(fs.existsSync(path.join(runtimeRoot, '_server-plugins'))).toBe(false);

        expect(fs.readFileSync(path.join(runtimeRoot, 'server.js'), 'utf8')).toBe('export default {};\n');
        expect(fs.readFileSync(path.join(runtimeRoot, 'plugins', 'builtin-plugin.js'), 'utf8')).toBe(
            'module.exports = 1;\n',
        );
        expect(fs.readFileSync(path.join(runtimeRoot, 'whitelist.txt'), 'utf8')).toBe('127.0.0.1\n');
        expect(
            fs.readFileSync(path.join(runtimeRoot, '_prebuilt-bundles', 'lib.core.bundle.js'), 'utf8'),
        ).toBe('// core\n');
        expect(fs.readFileSync(path.join(runtimeRoot, '.bundle-tree-version'), 'utf8').trim()).toBe(
            'sha256-123456',
        );

        expect(result.cliArgs).toEqual([
            '--port', '8000',
            '--dataRoot', dataRoot,
            '--serverPluginsPath', path.join(runtimeRoot, 'plugins'),
            '--globalExtensionsPath', path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party'),
            '--configPath', path.join(dataRoot, 'config.yaml'),
            '--backupsPath', path.join(dataRoot, 'backups'),
        ]);
        expect(result.serverPluginsRoot).toBe(path.join(runtimeRoot, 'plugins'));
        expect(result.globalExtensionsRoot).toBe(
            path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party'),
        );
        expect(result.prebuiltBundlesDir).toBe(path.join(runtimeRoot, '_prebuilt-bundles'));
    });

    test('merges a new bundle without deleting user plugins, extensions, whitelist, or migrated config', () => {
        const root = makeTempDir('luker-harmony-update-');
        tempDirs.push(root);

        const sourceRoot = path.join(root, 'resfile', 'luker');
        const dataRoot = path.join(root, 'el2', 'luker-data');
        const runtimeRoot = path.join(root, 'el2', 'luker-runtime');

        fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'plugins'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party', 'builtin-ext'), {
            recursive: true,
        });
        writeFile(path.join(sourceRoot, 'server.js'), '// new bundle\n');
        writeFile(path.join(sourceRoot, 'config.yaml'), 'port: 8000\n');
        writeFile(path.join(sourceRoot, 'whitelist.txt'), '127.0.0.1\n');
        writeFile(path.join(sourceRoot, 'plugins', 'builtin-plugin.js'), 'module.exports = "builtin";\n');
        writeFile(
            path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party', 'builtin-ext', 'manifest.json'),
            '{"display_name":"Builtin Ext"}',
        );
        writeFile(path.join(sourceRoot, 'runtime-tree-version.txt'), 'sha256-two\n');

        // Runtime tree left by the previous copy-based release.
        writeFile(path.join(runtimeRoot, 'server.js'), '// old bundle\n');
        writeFile(path.join(runtimeRoot, 'plugins', 'user-plugin', 'index.js'), 'module.exports = 1;\n');
        writeFile(
            path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party', 'user-ext', 'manifest.json'),
            '{"display_name":"User Ext"}',
        );
        writeFile(path.join(runtimeRoot, 'whitelist.txt'), '127.0.0.1\n192.168.1.5\n');
        writeFile(path.join(runtimeRoot, 'config.yaml'), 'port: 8123 # customized\n');
        writeFile(path.join(runtimeRoot, '.bundle-marker'), 'legacy-signature');

        // Runtime data root written by the zero-copy build before it failed.
        writeFile(path.join(dataRoot, 'plugins', 'data-plugin', 'index.js'), 'module.exports = 2;\n');
        writeFile(
            path.join(dataRoot, 'extensions', 'third-party', 'data-ext', 'manifest.json'),
            '{"display_name":"Data Ext"}',
        );

        const result = prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });

        expect(fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8')).toContain('8123');
        expect(fs.readFileSync(path.join(runtimeRoot, 'server.js'), 'utf8')).toBe('// new bundle\n');
        expect(fs.readFileSync(path.join(runtimeRoot, 'plugins', 'user-plugin', 'index.js'), 'utf8')).toBe(
            'module.exports = 1;\n',
        );
        expect(fs.readFileSync(path.join(runtimeRoot, 'plugins', 'data-plugin', 'index.js'), 'utf8')).toBe(
            'module.exports = 2;\n',
        );
        expect(fs.readFileSync(path.join(runtimeRoot, 'plugins', 'builtin-plugin.js'), 'utf8')).toBe(
            'module.exports = "builtin";\n',
        );
        expect(
            fs.readFileSync(
                path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party', 'user-ext', 'manifest.json'),
                'utf8',
            ),
        ).toContain('User Ext');
        expect(
            fs.readFileSync(
                path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party', 'data-ext', 'manifest.json'),
                'utf8',
            ),
        ).toContain('Data Ext');
        expect(
            fs.readFileSync(
                path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party', 'builtin-ext', 'manifest.json'),
                'utf8',
            ),
        ).toContain('Builtin Ext');
        expect(fs.readFileSync(path.join(runtimeRoot, 'whitelist.txt'), 'utf8')).toContain('192.168.1.5');
        expect(fs.existsSync(path.join(runtimeRoot, '_server-plugins'))).toBe(false);
        expect(fs.readFileSync(path.join(runtimeRoot, '.bundle-tree-version'), 'utf8').trim()).toBe('sha256-two');
        expect(result.cliArgs).toContain(path.join(runtimeRoot, 'plugins'));

        // A second launch with the same bundle version does not touch the runtime tree.
        writeFile(path.join(sourceRoot, 'server.js'), '// newer bundle without a version bump\n');
        writeFile(path.join(runtimeRoot, 'plugins', 'after-first.js'), 'module.exports = 3;\n');
        prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });
        expect(fs.readFileSync(path.join(runtimeRoot, 'server.js'), 'utf8')).toBe('// new bundle\n');
        expect(fs.readFileSync(path.join(runtimeRoot, 'plugins', 'after-first.js'), 'utf8')).toBe(
            'module.exports = 3;\n',
        );
    });

    test('detaches a partially created zero-copy runtime instead of writing through its symlinks', () => {
        const root = makeTempDir('luker-harmony-detach-');
        tempDirs.push(root);

        const sourceRoot = path.join(root, 'resfile', 'luker');
        const dataRoot = path.join(root, 'el2', 'luker-data');
        const runtimeRoot = path.join(root, 'el2', 'luker-runtime');

        fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'), { recursive: true });
        writeFile(path.join(sourceRoot, 'server.js'), '// source server\n');
        writeFile(path.join(sourceRoot, 'src', 'app.js'), '// source app\n');
        writeFile(path.join(sourceRoot, '.runtime-tree-version'), 'sha256-three\n');

        fs.mkdirSync(runtimeRoot, { recursive: true });
        fs.symlinkSync(path.join(sourceRoot, 'server.js'), path.join(runtimeRoot, 'server.js'));
        fs.symlinkSync(path.join(sourceRoot, 'src'), path.join(runtimeRoot, 'src'), 'dir');
        fs.symlinkSync(path.join(sourceRoot, 'public'), path.join(runtimeRoot, 'public'), 'dir');
        fs.symlinkSync(path.join(dataRoot, 'plugins'), path.join(runtimeRoot, '_server-plugins'), 'dir');
        fs.mkdirSync(path.join(dataRoot, 'plugins'), { recursive: true });
        writeFile(path.join(dataRoot, 'plugins', 'migrated.js'), 'module.exports = 4;\n');

        prepareHarmonyRuntime({
            sourceRoot,
            runtimeRoot,
            dataRoot,
            port: '8000',
        });

        expect(fs.lstatSync(path.join(runtimeRoot, 'server.js')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(runtimeRoot, 'src')).isSymbolicLink()).toBe(false);
        expect(fs.lstatSync(path.join(runtimeRoot, 'public')).isSymbolicLink()).toBe(false);
        expect(fs.existsSync(path.join(runtimeRoot, '_server-plugins'))).toBe(false);
        expect(fs.readFileSync(path.join(runtimeRoot, 'server.js'), 'utf8')).toBe('// source server\n');
        expect(fs.readFileSync(path.join(runtimeRoot, 'src', 'app.js'), 'utf8')).toBe('// source app\n');
        expect(fs.readFileSync(path.join(runtimeRoot, 'plugins', 'migrated.js'), 'utf8')).toBe(
            'module.exports = 4;\n',
        );
        expect(fs.readFileSync(path.join(sourceRoot, 'server.js'), 'utf8')).toBe('// source server\n');
    });

    test('node_ctl.c keeps preserve-symlinks flags and Index.ets keeps retry and export on startup failure', () => {
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
        expect(prepareWeb).toContain('--version-file "${RESFILE_DIR}/runtime-tree-version.txt"');
    });
});
