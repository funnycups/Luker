import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    shouldPruneNodeModulesEntry,
    stageMobileRuntime,
    writeDeterministicTar,
} from '../../scripts/stage-mobile-runtime.mjs';

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('stage-mobile-runtime', () => {
    const tempDirs = [];

    afterEach(() => {
        while (tempDirs.length > 0) {
            const dir = tempDirs.pop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('shouldPruneNodeModulesEntry prunes non-runtime artifacts and preserves runtime + license files', () => {
        // Pruned files
        expect(shouldPruneNodeModulesEntry('foo/index.d.ts', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/index.d.mts', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/index.d.cts', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/index.js.map', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/README.md', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/CHANGELOG.md', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/CHANGELOG', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/HISTORY.txt', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/tsconfig.json', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/binding.gyp', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/src/native.cc', false)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/src/header.h', false)).toBe(true);

        // Pruned directories
        expect(shouldPruneNodeModulesEntry('foo/__tests__', true)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/__mocks__', true)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/coverage', true)).toBe(true);
        expect(shouldPruneNodeModulesEntry('foo/.github', true)).toBe(true);

        // Preserved runtime and compliance files (including `doc/` runtime folders like `yaml/dist/doc/directives.js`)
        expect(shouldPruneNodeModulesEntry('yaml/dist/doc', true)).toBe(false);
        expect(shouldPruneNodeModulesEntry('yaml/dist/doc/directives.js', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/index.js', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/package.json', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/wasm.wasm', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/addon.node', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/LICENSE', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/LICENSE.md', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/NOTICE.txt', false)).toBe(false);
        expect(shouldPruneNodeModulesEntry('foo/lib', true)).toBe(false);
    });

    test('stageMobileRuntime stages shippable files, excludes devDependencies, prunes node_modules, and writes .runtime-tree-version', () => {
        const repoRoot = makeTempDir('luker-stage-repo-');
        const outputDir = makeTempDir('luker-stage-out-');
        tempDirs.push(repoRoot, outputDir);

        fs.writeFileSync(path.join(repoRoot, 'server.js'), 'console.log("server");\n');
        fs.writeFileSync(path.join(repoRoot, 'webpack.config.js'), 'export default {};\n');
        fs.writeFileSync(path.join(repoRoot, 'plugins.js'), 'export default {};\n');
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'luker', version: '2.9.0' }));
        fs.writeFileSync(
            path.join(repoRoot, 'package-lock.json'),
            JSON.stringify({
                name: 'luker',
                lockfileVersion: 3,
                packages: {
                    '': { name: 'luker' },
                    'node_modules/prod-pkg': { version: '1.0.0' },
                    'node_modules/dev-pkg': { version: '1.0.0', dev: true },
                    'node_modules/@types/node': { version: '20.0.0', dev: true },
                },
            }),
        );

        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'index.js'), 'export const ok = true;\n');

        fs.mkdirSync(path.join(repoRoot, 'default'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'default', 'config.yaml'), 'port: 8000\n');

        fs.mkdirSync(path.join(repoRoot, 'public', 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'public', 'scripts', 'app.js'), 'console.log("app");\n');
        fs.writeFileSync(path.join(repoRoot, 'public', 'untracked-junk.tmp'), 'should-not-copy\n');

        fs.mkdirSync(path.join(repoRoot, 'plugins'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'plugins', 'keep.txt'), 'plugin\n');

        fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'dist', 'lib.core.bundle.js'), '// core\n');
        fs.writeFileSync(path.join(repoRoot, 'dist', 'lib.optional.bundle.js'), '// optional\n');
        fs.writeFileSync(path.join(repoRoot, 'dist', 'codemirror.bundle.js'), '// cm\n');

        // node_modules with prod-pkg, dev-pkg, and __tests__
        fs.mkdirSync(path.join(repoRoot, 'node_modules', 'prod-pkg', '__tests__'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'prod-pkg', 'package.json'), '{"name":"prod-pkg"}');
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'prod-pkg', 'index.js'), 'module.exports = 1;');
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'prod-pkg', 'index.d.ts'), 'export const x: number;');
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'prod-pkg', 'README.md'), '# Readme');
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'prod-pkg', 'LICENSE.md'), 'MIT');
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'prod-pkg', '__tests__', 'spec.js'), 'test()');

        fs.mkdirSync(path.join(repoRoot, 'node_modules', 'dev-pkg'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'node_modules', 'dev-pkg', 'index.js'), 'module.exports = 2;');

        fs.mkdirSync(path.join(repoRoot, 'node_modules', '@types', 'node'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'node_modules', '@types', 'node', 'index.d.ts'), 'declare var process: any;');
        fs.writeFileSync(path.join(repoRoot, 'node_modules', '@types', 'node', 'package.json'), '{"name":"@types/node"}');

        const bootstrapFile = path.join(repoRoot, 'bootstrap.js');
        fs.writeFileSync(bootstrapFile, 'console.log("bootstrap");\n');

        const fakeGitExec = (_cmd, args) => {
            const target = args[args.length - 1];
            if (target === 'public') return 'public/scripts/app.js\0';
            if (target === 'default') return 'default/config.yaml\0';
            if (target === 'plugins') return 'plugins/keep.txt\0';
            return '';
        };

        const result = stageMobileRuntime({
            repoRoot,
            outputDir,
            bootstrapPath: bootstrapFile,
            execFileSyncImpl: fakeGitExec,
        });

        expect(result.treeVersion).toMatch(/^sha256-[0-9a-f]{64}$/);
        expect(fs.readFileSync(path.join(outputDir, '.runtime-tree-version'), 'utf8').trim()).toBe(result.treeVersion);
        expect(fs.existsSync(path.join(outputDir, 'server.js'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'bootstrap.js'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'config.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, '_prebuilt-bundles', 'lib.core.bundle.js'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'public', 'scripts', 'app.js'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'public', 'untracked-junk.tmp'))).toBe(false);

        // prod-pkg kept, pruned artifacts removed, LICENSE.md kept, dev-pkg excluded
        expect(fs.existsSync(path.join(outputDir, 'node_modules', 'prod-pkg', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'node_modules', 'prod-pkg', 'LICENSE.md'))).toBe(true);
        expect(fs.existsSync(path.join(outputDir, 'node_modules', 'prod-pkg', 'index.d.ts'))).toBe(false);
        expect(fs.existsSync(path.join(outputDir, 'node_modules', 'prod-pkg', 'README.md'))).toBe(false);
        expect(fs.existsSync(path.join(outputDir, 'node_modules', 'prod-pkg', '__tests__'))).toBe(false);
        expect(fs.existsSync(path.join(outputDir, 'node_modules', 'dev-pkg'))).toBe(false);
        expect(fs.existsSync(path.join(outputDir, 'node_modules', '@types'))).toBe(false);
    });

    test('writeDeterministicTar creates a POSIX USTAR/PAX tar archive that preserves short and >100 char paths', () => {
        const srcDir = makeTempDir('luker-tar-src-');
        const extractDir = makeTempDir('luker-tar-extract-');
        const tarOut = path.join(makeTempDir('luker-tar-out-'), 'runtime-bundle.tar');
        tempDirs.push(srcDir, extractDir, path.dirname(tarOut));

        fs.writeFileSync(path.join(srcDir, 'server.js'), 'console.log("hello tar");\n');
        const deepRelDir = path.join(
            'node_modules',
            '@scope-with-very-long-organization-name',
            'package-with-a-remarkably-long-descriptive-identifier',
            'dist',
            'nested',
            'deeply',
            'subfolder',
        );
        fs.mkdirSync(path.join(srcDir, deepRelDir), { recursive: true });
        const deepRelFile = path.join(deepRelDir, 'implementation-module-filename.js');
        expect(deepRelFile.length).toBeGreaterThan(110);
        fs.writeFileSync(path.join(srcDir, deepRelFile), 'export const deep = 42;\n');

        const stats = writeDeterministicTar(srcDir, tarOut);
        expect(stats.entryCount).toBeGreaterThanOrEqual(2);
        expect(fs.existsSync(tarOut)).toBe(true);

        execFileSync('tar', ['-xf', tarOut, '-C', extractDir]);
        expect(fs.readFileSync(path.join(extractDir, 'server.js'), 'utf8')).toBe('console.log("hello tar");\n');
        expect(fs.readFileSync(path.join(extractDir, deepRelFile), 'utf8')).toBe('export const deep = 42;\n');
    });
});
