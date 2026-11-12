#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUNTIME_TREE_VERSION_FILE = '.runtime-tree-version';

const TOP_LEVEL_ITEMS = [
    'server.js',
    'webpack.config.js',
    'package.json',
    'package-lock.json',
    'plugins.js',
    'src',
];

const GIT_DERIVED_SHIPPABLE_ROOTS = ['public', 'default', 'plugins'];

const PREBUILT_BUNDLES = [
    'lib.core.bundle.js',
    'lib.optional.bundle.js',
    'codemirror.bundle.js',
];

function resolvePrebuiltBundlesDir(repoRoot) {
    const distRoot = path.join(repoRoot, 'dist');
    const webpackRoot = path.join(distRoot, '_webpack');
    if (fs.existsSync(webpackRoot)) {
        const candidates = fs.readdirSync(webpackRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(webpackRoot, entry.name, 'output'));
        const complete = candidates.find(dir =>
            PREBUILT_BUNDLES.every(bundle => fs.existsSync(path.join(dir, bundle))),
        );
        if (complete) {
            return complete;
        }
    }
    if (PREBUILT_BUNDLES.every(bundle => fs.existsSync(path.join(distRoot, bundle)))) {
        return distRoot;
    }
    throw new Error(
        `Missing prebuilt webpack bundles under ${distRoot}; expected ${PREBUILT_BUNDLES.join(', ')}`,
    );
}

const PRUNED_NODE_MODULES_DIR_NAMES = new Set([
    '__tests__',
    '__mocks__',
    'coverage',
    '.github',
    '.git',
    '.vscode',
    '.idea',
]);

const PRUNED_NODE_MODULES_FILE_EXTENSIONS = [
    '.d.ts.map',
    '.d.mts.map',
    '.d.cts.map',
    '.d.ts',
    '.d.mts',
    '.d.cts',
    '.js.map',
    '.mjs.map',
    '.cjs.map',
    '.ts.map',
    '.css.map',
    '.map',
    '.md',
    '.markdown',
    '.mkd',
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.gyp',
    '.gypi',
    '.o',
    '.obj',
    '.a',
    '.lib',
    '.pdb',
    '.exp',
    '.flow',
];

const PRUNED_NODE_MODULES_EXACT_NAMES = new Set([
    'binding.gyp',
    'tsconfig.json',
    'jsconfig.json',
    'makefile',
    'cmakelists.txt',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.json',
    '.npmignore',
    '.travis.yml',
    '.editorconfig',
    '.jshintrc',
    'gulpfile.js',
    'gruntfile.js',
    'rollup.config.js',
    'karma.conf.js',
]);

const PRUNED_NODE_MODULES_PREFIXES = [
    'readme',
    'changelog',
    'history',
    'authors',
    'contributors',
    'maintainers',
    'security',
    'code_of_conduct',
    'contributing',
];

const PRESERVED_COMPLIANCE_PREFIXES = [
    'license',
    'licence',
    'copying',
    'notice',
    'patents',
];

/**
 * Determine whether an entry inside `node_modules/` (given its path relative to `node_modules/`)
 * should be pruned from mobile runtime bundles.
 *
 * @param {string} relativePath Relative path inside `node_modules` using forward slashes
 * @param {boolean} isDirectory Whether the entry is a directory
 * @returns {boolean}
 */
export function shouldPruneNodeModulesEntry(relativePath, isDirectory) {
    const normalized = relativePath.replaceAll(path.sep, '/');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) {
        return false;
    }

    for (let i = 0; i < segments.length - 1; i++) {
        if (PRUNED_NODE_MODULES_DIR_NAMES.has(segments[i].toLowerCase())) {
            return true;
        }
    }

    const baseName = segments[segments.length - 1];
    const lowerBase = baseName.toLowerCase();

    if (isDirectory) {
        return PRUNED_NODE_MODULES_DIR_NAMES.has(lowerBase);
    }

    for (const prefix of PRESERVED_COMPLIANCE_PREFIXES) {
        if (
            lowerBase === prefix ||
            lowerBase.startsWith(`${prefix}.`) ||
            lowerBase.startsWith(`${prefix}-`) ||
            lowerBase.startsWith(`${prefix}_`)
        ) {
            return false;
        }
    }

    if (PRUNED_NODE_MODULES_EXACT_NAMES.has(lowerBase)) {
        return true;
    }

    for (const prefix of PRUNED_NODE_MODULES_PREFIXES) {
        if (
            lowerBase === prefix ||
            lowerBase.startsWith(`${prefix}.`) ||
            lowerBase.startsWith(`${prefix}-`) ||
            lowerBase.startsWith(`${prefix}_`)
        ) {
            return true;
        }
    }

    for (const ext of PRUNED_NODE_MODULES_FILE_EXTENSIONS) {
        if (lowerBase.endsWith(ext)) {
            return true;
        }
    }

    return false;
}

/**
 * Return the set of dev-only package prefixes under `node_modules/` from `package-lock.json`.
 *
 * @param {string} repoRoot
 * @returns {Set<string>} Set of relative paths under `node_modules` (e.g. `eslint`, `@types/node`)
 */
export function collectDevOnlyNodeModulePrefixes(repoRoot) {
    const lockPath = path.join(repoRoot, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
        return new Set();
    }

    const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const packages = lockData?.packages;
    if (!packages || typeof packages !== 'object') {
        return new Set();
    }

    const devPrefixes = new Set();
    for (const [pkgPath, meta] of Object.entries(packages)) {
        if (!pkgPath.startsWith('node_modules/') || !meta || typeof meta !== 'object') {
            continue;
        }
        if (meta.dev === true) {
            devPrefixes.add(pkgPath.slice('node_modules/'.length));
        }
    }
    return devPrefixes;
}

function isUnderDevOnlyPackage(relToNodeModules, devPrefixes) {
    if (devPrefixes.size === 0) {
        return false;
    }
    const normalized = relToNodeModules.replaceAll(path.sep, '/');
    return devPrefixes.has(normalized);
}

export function listGitShippableFiles(repoRoot, relativeRoot, execFileSyncImpl = execFileSync) {
    const output = execFileSyncImpl(
        'git',
        ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', relativeRoot],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    return output
        .split('\0')
        .map(entry => entry.trim())
        .filter(Boolean);
}

/**
 * Deterministically hash the staged runtime directory contents.
 *
 * @param {string} rootDir
 * @returns {string}
 */
export function computeRuntimeTreeVersion(rootDir) {
    const hash = crypto.createHash('sha256');
    hash.update('luker-runtime-tree-v2\n');

    function walk(currentDir, relativePrefix) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
            .filter(entry => !(relativePrefix === '' && entry.name === RUNTIME_TREE_VERSION_FILE))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        for (const entry of entries) {
            const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
            const fullPath = path.join(currentDir, entry.name);
            const lstat = fs.lstatSync(fullPath);

            if (lstat.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(fullPath);
                hash.update(`L:${relPath}->${linkTarget}\n`);
            } else if (lstat.isDirectory()) {
                hash.update(`D:${relPath}\n`);
                walk(fullPath, relPath);
            } else if (lstat.isFile()) {
                hash.update(`F:${relPath}:${lstat.size}:`);
                hash.update(fs.readFileSync(fullPath));
                hash.update('\n');
            }
        }
    }

    walk(rootDir, '');
    return `sha256-${hash.digest('hex')}`;
}

export function writeRuntimeTreeVersionFile(rootDir, explicitFilePath = null) {
    const version = computeRuntimeTreeVersion(rootDir);
    const targetPath = path.join(rootDir, RUNTIME_TREE_VERSION_FILE);
    fs.writeFileSync(targetPath, `${version}\n`, 'utf8');
    if (explicitFilePath && path.resolve(explicitFilePath) !== path.resolve(targetPath)) {
        fs.mkdirSync(path.dirname(explicitFilePath), { recursive: true });
        fs.writeFileSync(explicitFilePath, `${version}\n`, 'utf8');
    }
    return version;
}

function encodeOctalField(value, length) {
    const octal = Math.max(0, Math.floor(value)).toString(8);
    const padded = octal.padStart(length - 1, '0');
    return `${padded}\0`;
}

function writeStringField(buffer, offset, length, str) {
    buffer.fill(0, offset, offset + length);
    buffer.write(str, offset, Math.min(length, Buffer.byteLength(str, 'utf8')), 'utf8');
}

function createUstarHeader({ name, mode, size, mtimeSec, typeflag, prefix = '' }) {
    const header = Buffer.alloc(512, 0);
    writeStringField(header, 0, 100, name);
    writeStringField(header, 100, 8, encodeOctalField(mode & 0o7777, 8));
    writeStringField(header, 108, 8, encodeOctalField(0, 8));
    writeStringField(header, 116, 8, encodeOctalField(0, 8));
    writeStringField(header, 124, 12, encodeOctalField(size, 12));
    writeStringField(header, 136, 12, encodeOctalField(mtimeSec, 12));
    // Checksum placeholder: 8 spaces
    header.fill(0x20, 148, 156);
    header[156] = typeflag.charCodeAt(0);
    writeStringField(header, 257, 6, 'ustar\0');
    writeStringField(header, 263, 2, '00');
    writeStringField(header, 345, 155, prefix);

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
        checksum += header[i];
    }
    const checksumOctal = Math.max(0, checksum).toString(8).padStart(6, '0');
    header.write(checksumOctal, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function createPaxRecord(key, value) {
    const body = `${key}=${value}\n`;
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    let totalLen = bodyBytes + 3;
    while (true) {
        const lenStr = `${totalLen} `;
        const actual = Buffer.byteLength(lenStr, 'utf8') + bodyBytes;
        if (actual === totalLen) {
            return Buffer.from(`${lenStr}${body}`, 'utf8');
        }
        totalLen = actual;
    }
}

/**
 * Write a deterministic uncompressed POSIX USTAR/PAX `.tar` archive of `sourceDir`.
 *
 * @param {string} sourceDir
 * @param {string} tarFilePath
 * @returns {{ entryCount: number, totalBytes: number }}
 */
export function writeDeterministicTar(sourceDir, tarFilePath) {
    fs.mkdirSync(path.dirname(tarFilePath), { recursive: true });
    const fd = fs.openSync(tarFilePath, 'w');
    let entryCount = 0;
    let totalBytes = 0;

    function writeBlockPadded(buffer) {
        fs.writeSync(fd, buffer);
        totalBytes += buffer.length;
        const remainder = buffer.length % 512;
        if (remainder !== 0) {
            const pad = Buffer.alloc(512 - remainder, 0);
            fs.writeSync(fd, pad);
            totalBytes += pad.length;
        }
    }

    function emitEntry(relPath, fullPath, stat) {
        const isDir = stat.isDirectory();
        const tarPath = isDir ? `${relPath}/` : relPath;
        const pathBytes = Buffer.byteLength(tarPath, 'utf8');
        const mtimeSec = Math.floor(stat.mtimeMs / 1000) || 1700000000;
        const mode = isDir ? 0o755 : (stat.mode & 0o111 ? 0o755 : 0o644);
        const size = isDir ? 0 : stat.size;
        const typeflag = isDir ? '5' : '0';

        if (pathBytes > 100) {
            const paxPayload = createPaxRecord('path', tarPath);
            const paxHeader = createUstarHeader({
                name: `PaxHeader/${path.basename(relPath).slice(0, 80)}`,
                mode: 0o644,
                size: paxPayload.length,
                mtimeSec,
                typeflag: 'x',
            });
            fs.writeSync(fd, paxHeader);
            totalBytes += 512;
            writeBlockPadded(paxPayload);
        }

        const header = createUstarHeader({
            name: pathBytes > 100 ? tarPath.slice(0, 100) : tarPath,
            mode,
            size,
            mtimeSec,
            typeflag,
        });
        fs.writeSync(fd, header);
        totalBytes += 512;

        if (!isDir && size > 0) {
            const content = fs.readFileSync(fullPath);
            writeBlockPadded(content);
        }
        entryCount += 1;
    }

    try {
        function walk(currentDir, relativePrefix) {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true })
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

            for (const entry of entries) {
                const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
                const fullPath = path.join(currentDir, entry.name);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    emitEntry(relPath, fullPath, stat);
                    walk(fullPath, relPath);
                } else if (stat.isFile()) {
                    emitEntry(relPath, fullPath, stat);
                }
            }
        }

        walk(sourceDir, '');
        // End-of-archive marker: two 512-byte zero blocks
        const eofBlocks = Buffer.alloc(1024, 0);
        fs.writeSync(fd, eofBlocks);
        totalBytes += eofBlocks.length;
    } finally {
        fs.closeSync(fd);
    }

    return { entryCount, totalBytes };
}

/**
 * Stage the mobile Node.js runtime into `outputDir` (and optionally create `tarPath`).
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.outputDir
 * @param {string} [options.bootstrapPath]
 * @param {string} [options.tarPath]
 * @param {string} [options.versionFilePath]
 * @param {Function} [options.execFileSyncImpl]
 */
export function stageMobileRuntime({
    repoRoot,
    outputDir,
    bootstrapPath = null,
    tarPath = null,
    versionFilePath = null,
    execFileSyncImpl = execFileSync,
}) {
    if (!repoRoot || !outputDir) {
        throw new Error('stageMobileRuntime requires repoRoot and outputDir');
    }

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    let fileCount = 0;
    let prunedCount = 0;

    function copyFileCounted(src, dest) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        fileCount += 1;
    }

    function copyDirRecursive(srcDir, destDir) {
        fs.mkdirSync(destDir, { recursive: true });
        for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
            const srcPath = path.join(srcDir, entry.name);
            const destPath = path.join(destDir, entry.name);
            const stat = fs.statSync(srcPath);
            if (stat.isDirectory()) {
                copyDirRecursive(srcPath, destPath);
            } else if (stat.isFile()) {
                copyFileCounted(srcPath, destPath);
            }
        }
    }

    for (const item of TOP_LEVEL_ITEMS) {
        const src = path.join(repoRoot, item);
        if (!fs.existsSync(src)) {
            throw new Error(`Missing required runtime item: ${src}`);
        }
        const dst = path.join(outputDir, item);
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
            copyDirRecursive(src, dst);
        } else {
            copyFileCounted(src, dst);
        }
    }

    for (const relativeRoot of GIT_DERIVED_SHIPPABLE_ROOTS) {
        const rootSrc = path.join(repoRoot, relativeRoot);
        if (!fs.existsSync(rootSrc)) {
            throw new Error(`Missing required runtime directory: ${rootSrc}`);
        }
        const trackedFiles = listGitShippableFiles(repoRoot, relativeRoot, execFileSyncImpl);
        if (trackedFiles.length === 0) {
            throw new Error(`No git-shippable files found under ${relativeRoot}`);
        }
        for (const relFile of trackedFiles) {
            const srcFile = path.join(repoRoot, relFile);
            let stat;
            try {
                stat = fs.statSync(srcFile);
            } catch {
                continue;
            }
            if (!stat.isFile()) {
                continue;
            }
            copyFileCounted(srcFile, path.join(outputDir, relFile));
        }
    }

    const defaultConfigPath = path.join(repoRoot, 'default', 'config.yaml');
    if (fs.existsSync(defaultConfigPath)) {
        copyFileCounted(defaultConfigPath, path.join(outputDir, 'config.yaml'));
    }

    const distBundleDir = resolvePrebuiltBundlesDir(repoRoot);
    const prebuiltRoot = path.join(outputDir, '_prebuilt-bundles');
    fs.mkdirSync(prebuiltRoot, { recursive: true });
    for (const bundleName of PREBUILT_BUNDLES) {
        copyFileCounted(path.join(distBundleDir, bundleName), path.join(prebuiltRoot, bundleName));
    }

    if (bootstrapPath) {
        if (!fs.existsSync(bootstrapPath)) {
            throw new Error(`Missing bootstrap script: ${bootstrapPath}`);
        }
        copyFileCounted(bootstrapPath, path.join(outputDir, 'bootstrap.js'));
    }

    const nodeModulesSrc = path.join(repoRoot, 'node_modules');
    if (!fs.existsSync(nodeModulesSrc)) {
        throw new Error(`Missing node_modules directory: ${nodeModulesSrc}`);
    }
    const devPrefixes = collectDevOnlyNodeModulePrefixes(repoRoot);
    const nodeModulesDst = path.join(outputDir, 'node_modules');

    function copyPrunedNodeModules(currentSrc, currentDst, relPrefix) {
        for (const entry of fs.readdirSync(currentSrc, { withFileTypes: true })) {
            if (relPrefix === '' && entry.name === '.bin') {
                prunedCount += 1;
                continue;
            }
            if (relPrefix === '' && entry.name === '.package-lock.json') {
                prunedCount += 1;
                continue;
            }

            const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (isUnderDevOnlyPackage(relPath, devPrefixes)) {
                prunedCount += 1;
                continue;
            }

            const fullSrc = path.join(currentSrc, entry.name);
            let stat;
            try {
                // Follow symlinks (`statSync`) so dereferenced files/dirs are staged cleanly
                stat = fs.statSync(fullSrc);
            } catch {
                // Broken symlink inside node_modules: skip
                prunedCount += 1;
                continue;
            }

            const isDir = stat.isDirectory();
            if (shouldPruneNodeModulesEntry(relPath, isDir)) {
                prunedCount += 1;
                continue;
            }

            const fullDst = path.join(currentDst, entry.name);
            if (isDir) {
                copyPrunedNodeModules(fullSrc, fullDst, relPath);
            } else if (stat.isFile()) {
                copyFileCounted(fullSrc, fullDst);
            }
        }
    }

    copyPrunedNodeModules(nodeModulesSrc, nodeModulesDst, '');

    const treeVersion = writeRuntimeTreeVersionFile(outputDir, versionFilePath);
    let tarBytes = 0;
    if (tarPath) {
        const tarStats = writeDeterministicTar(outputDir, tarPath);
        tarBytes = tarStats.totalBytes;
    }

    return {
        fileCount,
        prunedCount,
        treeVersion,
        tarBytes,
    };
}

function parseCliArgs(argv) {
    const parsed = {
        repoRoot: null,
        outputDir: null,
        bootstrapPath: null,
        tarPath: null,
        versionFilePath: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--repo-root') {
            parsed.repoRoot = argv[++i];
        } else if (arg === '--output-dir') {
            parsed.outputDir = argv[++i];
        } else if (arg === '--bootstrap') {
            parsed.bootstrapPath = argv[++i];
        } else if (arg === '--tar') {
            parsed.tarPath = argv[++i];
        } else if (arg === '--version-file') {
            parsed.versionFilePath = argv[++i];
        }
    }
    return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const cli = parseCliArgs(process.argv.slice(2));
    const repoRoot = path.resolve(cli.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
    if (!cli.outputDir) {
        console.error(
            'Usage: node scripts/stage-mobile-runtime.mjs --output-dir <dir> [--repo-root <dir>] [--bootstrap <file>] [--tar <file>] [--version-file <file>]',
        );
        process.exit(1);
    }
    const stats = stageMobileRuntime({
        repoRoot,
        outputDir: path.resolve(cli.outputDir),
        bootstrapPath: cli.bootstrapPath ? path.resolve(cli.bootstrapPath) : null,
        tarPath: cli.tarPath ? path.resolve(cli.tarPath) : null,
        versionFilePath: cli.versionFilePath ? path.resolve(cli.versionFilePath) : null,
    });
    console.log(
        `Staged mobile runtime: files=${stats.fileCount} pruned=${stats.prunedCount} version=${stats.treeVersion}` +
            (stats.tarBytes ? ` tarBytes=${stats.tarBytes}` : ''),
    );
}
