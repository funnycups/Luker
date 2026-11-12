import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME_LAYOUT_VERSION = '5';
const RUNTIME_VERSION_FILE = '.runtime-version';
const RUNTIME_TREE_VERSION_FILE = '.runtime-tree-version';
const SERVER_PLUGINS_ALIAS = '_server-plugins';
const RUNTIME_ROOT_LOCAL_NAMES = new Set([
    RUNTIME_VERSION_FILE,
    'whitelist.txt',
    'bootstrap.log',
    SERVER_PLUGINS_ALIAS,
    'data',
]);

function isSymbolicLink(targetPath) {
    try {
        return fs.lstatSync(targetPath).isSymbolicLink();
    } catch {
        return false;
    }
}

function pathExistsOrSymlink(targetPath) {
    try {
        fs.lstatSync(targetPath);
        return true;
    } catch {
        return false;
    }
}

function detachServerPluginsAlias(runtimeRoot) {
    const aliasPath = path.join(runtimeRoot, SERVER_PLUGINS_ALIAS);
    if (!pathExistsOrSymlink(aliasPath)) {
        return;
    }
    if (isSymbolicLink(aliasPath)) {
        fs.unlinkSync(aliasPath);
        return;
    }
    throw new Error(`Server plugin runtime alias is occupied by a non-symlink: ${aliasPath}`);
}

function prepareServerPluginsAlias(runtimeRoot, serverPluginsRoot) {
    detachServerPluginsAlias(runtimeRoot);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(serverPluginsRoot, { recursive: true });
    const pkgPath = path.join(serverPluginsRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(
            pkgPath,
            JSON.stringify({ name: 'sillytavern-plugins', type: 'commonjs' }),
            'utf8',
        );
    }
    fs.symlinkSync(serverPluginsRoot, path.join(runtimeRoot, SERVER_PLUGINS_ALIAS), 'dir');
}

function copyDirectoryChildrenIfMissing(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir)) {
        return;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const srcChild = path.join(sourceDir, entry.name);
        const dstChild = path.join(targetDir, entry.name);
        if (fs.existsSync(dstChild)) {
            continue;
        }
        fs.cpSync(srcChild, dstChild, { recursive: true, dereference: false });
    }
}

function migrateLegacyHarmonyPaths({ runtimeRoot, dataRoot, serverPluginsRoot, globalExtensionsRoot, configPath }) {
    if (!fs.existsSync(runtimeRoot)) {
        return;
    }

    const legacyConfig = path.join(runtimeRoot, 'config.yaml');
    if (!fs.existsSync(configPath) && !isSymbolicLink(legacyConfig) && fs.existsSync(legacyConfig)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.copyFileSync(legacyConfig, configPath);
    }

    const legacyPluginsDir = path.join(runtimeRoot, 'plugins');
    if (!isSymbolicLink(legacyPluginsDir) && fs.existsSync(legacyPluginsDir)) {
        copyDirectoryChildrenIfMissing(legacyPluginsDir, serverPluginsRoot);
    }

    const legacyPublicDir = path.join(runtimeRoot, 'public');
    const legacyExtensionsDir = path.join(runtimeRoot, 'public', 'scripts', 'extensions', 'third-party');
    if (!isSymbolicLink(legacyPublicDir) && fs.existsSync(legacyExtensionsDir)) {
        copyDirectoryChildrenIfMissing(legacyExtensionsDir, globalExtensionsRoot);
    }
}

function readRuntimeTreeVersion(sourceRoot) {
    const versionFile = path.join(sourceRoot, RUNTIME_TREE_VERSION_FILE);
    try {
        const value = fs.readFileSync(versionFile, 'utf8').trim();
        if (value) {
            return value;
        }
    } catch {
        // Fallback when running from an unstaged checkout
    }
    return 'unstaged';
}

/**
 * Prepare the HarmonyOS writable `luker-runtime` directory using zero-copy
 * top-level symlinks into `sourceRoot` (`resfile/luker`) and persistent user
 * directories under `dataRoot`.
 *
 * @param {object} options
 * @param {string} options.sourceRoot
 * @param {string} options.runtimeRoot
 * @param {string} options.dataRoot
 * @param {string} [options.port='8000']
 * @param {Function} [options.log]
 */
export function prepareHarmonyRuntime({
    sourceRoot,
    runtimeRoot,
    dataRoot,
    port = '8000',
    log = () => {},
}) {
    const resolvedSource = path.resolve(sourceRoot);
    const resolvedRuntime = path.resolve(runtimeRoot);
    const resolvedData = path.resolve(dataRoot);
    const serverPluginsRoot = path.join(resolvedData, 'plugins');
    const globalExtensionsRoot = path.join(resolvedData, 'extensions', 'third-party');
    const backupsRoot = path.join(resolvedData, 'backups');
    const configPath = path.join(resolvedData, 'config.yaml');

    fs.mkdirSync(resolvedData, { recursive: true });
    fs.mkdirSync(path.dirname(resolvedRuntime), { recursive: true });

    detachServerPluginsAlias(resolvedRuntime);
    migrateLegacyHarmonyPaths({
        runtimeRoot: resolvedRuntime,
        dataRoot: resolvedData,
        serverPluginsRoot,
        globalExtensionsRoot,
        configPath,
    });

    fs.mkdirSync(resolvedRuntime, { recursive: true });
    fs.mkdirSync(serverPluginsRoot, { recursive: true });
    fs.mkdirSync(globalExtensionsRoot, { recursive: true });
    fs.mkdirSync(backupsRoot, { recursive: true });

    const treeVersion = readRuntimeTreeVersion(resolvedSource);
    const markerValue = `layout=${RUNTIME_LAYOUT_VERSION};tree=${treeVersion};source=${resolvedSource}`;
    const sourceEntries = fs.readdirSync(resolvedSource, { withFileTypes: true })
        .filter(entry => entry.name !== RUNTIME_TREE_VERSION_FILE);

    const sourceNames = new Set();
    let linkedCount = 0;
    let skippedCount = 0;

    for (const entry of sourceEntries) {
        sourceNames.add(entry.name);
        const srcPath = path.join(resolvedSource, entry.name);
        const dstPath = path.join(resolvedRuntime, entry.name);

        if (isSymbolicLink(dstPath)) {
            const currentTarget = fs.readlinkSync(dstPath);
            if (currentTarget === srcPath && fs.existsSync(dstPath)) {
                skippedCount += 1;
                continue;
            }
            fs.unlinkSync(dstPath);
        } else if (pathExistsOrSymlink(dstPath)) {
            fs.rmSync(dstPath, { recursive: true, force: true });
        }

        const srcStat = fs.statSync(srcPath);
        fs.symlinkSync(srcPath, dstPath, srcStat.isDirectory() ? 'dir' : 'file');
        linkedCount += 1;
    }

    for (const existing of fs.readdirSync(resolvedRuntime, { withFileTypes: true })) {
        if (RUNTIME_ROOT_LOCAL_NAMES.has(existing.name) || sourceNames.has(existing.name)) {
            continue;
        }
        const fullExisting = path.join(resolvedRuntime, existing.name);
        if (isSymbolicLink(fullExisting)) {
            fs.unlinkSync(fullExisting);
        } else {
            fs.rmSync(fullExisting, { recursive: true, force: true });
        }
    }

    fs.writeFileSync(path.join(resolvedRuntime, RUNTIME_VERSION_FILE), `${markerValue}\n`, 'utf8');
    prepareServerPluginsAlias(resolvedRuntime, serverPluginsRoot);
    log('BOOT', `runtime links ready linked=${linkedCount} skipped=${skippedCount} marker=${markerValue}`);

    const prebuiltCandidate = path.join(resolvedRuntime, '_prebuilt-bundles');
    const prebuiltBundlesDir = fs.existsSync(prebuiltCandidate) ? prebuiltCandidate : null;

    const cliArgs = [
        '--port', String(port),
        '--dataRoot', resolvedData,
        '--serverPluginsPath', serverPluginsRoot,
        '--globalExtensionsPath', globalExtensionsRoot,
        '--configPath', configPath,
        '--backupsPath', backupsRoot,
    ];

    return {
        runtimeRoot: resolvedRuntime,
        dataRoot: resolvedData,
        serverPluginsRoot,
        globalExtensionsRoot,
        configPath,
        backupsRoot,
        prebuiltBundlesDir,
        cliArgs,
    };
}

async function runMain() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const sourceRoot = path.resolve(__dirname);
    const dataRoot = process.env.LUKER_DATA_ROOT || path.join(sourceRoot, 'data');
    const runtimeRoot = process.env.LUKER_RUNTIME_ROOT || path.join(path.dirname(dataRoot), 'luker-runtime');
    const port = process.env.PORT || '8000';

    fs.mkdirSync(dataRoot, { recursive: true });
    const logFile = path.join(dataRoot, 'bootstrap.log');

    const appendLog = (level, ...args) => {
        const timestamp = new Date().toISOString();
        const text = args
            .map(item => (item instanceof Error ? (item.stack || item.message) : String(item)))
            .join(' ');
        try {
            fs.appendFileSync(logFile, `[${timestamp}] [${level}] ${text}\n`, 'utf8');
        } catch {
            // logging must never affect startup
        }
    };

    process.on('uncaughtException', error => appendLog('UNCAUGHT_EXCEPTION', error));
    process.on('unhandledRejection', reason => appendLog('UNHANDLED_REJECTION', reason));

    const startedAt = Date.now();
    const prepared = prepareHarmonyRuntime({
        sourceRoot,
        runtimeRoot,
        dataRoot,
        port,
        log: appendLog,
    });
    appendLog('BOOT', `prepareHarmonyRuntime completed in ${Date.now() - startedAt}ms`);

    if (prepared.prebuiltBundlesDir && !process.env.LUKER_PREBUILT_BUNDLES_DIR) {
        process.env.LUKER_PREBUILT_BUNDLES_DIR = prepared.prebuiltBundlesDir;
    }
    process.env.LUKER_SERVER_PLUGINS_LOAD_PATH = path.join(prepared.runtimeRoot, SERVER_PLUGINS_ALIAS);

    process.chdir(prepared.runtimeRoot);
    appendLog('BOOT', `sourceRoot=${sourceRoot}`);
    appendLog('BOOT', `runtimeRoot=${prepared.runtimeRoot}`);
    appendLog('BOOT', `dataRoot=${prepared.dataRoot}`);
    appendLog('BOOT', `prebuilt=${process.env.LUKER_PREBUILT_BUNDLES_DIR || '<none>'}`);

    for (let i = 0; i < prepared.cliArgs.length; i += 2) {
        const flag = prepared.cliArgs[i];
        const value = prepared.cliArgs[i + 1];
        if (!process.argv.includes(flag)) {
            process.argv.push(flag, value);
        }
    }

    appendLog('BOOT', `argv=${JSON.stringify(process.argv)}`);
    const serverEntryUrl = pathToFileURL(path.join(prepared.runtimeRoot, 'server.js')).href;
    appendLog('BOOT', `importing ${serverEntryUrl}`);
    await import(serverEntryUrl);
    appendLog('BOOT', 'server.js import resolved');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    await runMain();
}
