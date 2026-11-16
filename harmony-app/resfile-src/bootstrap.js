import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME_TREE_VERSION_FILE = '.runtime-tree-version';
const PACKAGED_RUNTIME_TREE_VERSION_FILE = 'runtime-tree-version.txt';
const RUNTIME_TREE_MARKER_FILE = '.bundle-tree-version';
const SERVER_PLUGINS_ALIAS = '_server-plugins';

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

/**
 * Copies children that do not exist in the target directory. Used for the
 * one-time migration from the dataRoot plugin and extension directories that
 * the zero-copy layout introduced, without overwriting files already present
 * in the runtime tree.
 */
function copyMissingChildren(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir)) {
        return 0;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    let copied = 0;
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourceChild = path.join(sourceDir, entry.name);
        const targetChild = path.join(targetDir, entry.name);
        if (pathExistsOrSymlink(targetChild)) {
            continue;
        }
        fs.cpSync(sourceChild, targetChild, { recursive: true, dereference: true, force: false });
        copied += 1;
    }
    return copied;
}

/**
 * Removes top-level symlinks left by the zero-copy runtime layout. Copying
 * over a symlink would write through it into the read-only bundle.
 */
function detachRuntimeSymlinks(runtimeRoot) {
    if (!fs.existsSync(runtimeRoot)) {
        return;
    }
    for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
            fs.unlinkSync(path.join(runtimeRoot, entry.name));
        }
    }
}

function migrateLegacyConfig({ runtimeRoot, configPath }) {
    const legacyConfig = path.join(runtimeRoot, 'config.yaml');
    if (!fs.existsSync(configPath) && !isSymbolicLink(legacyConfig) && fs.existsSync(legacyConfig)) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.copyFileSync(legacyConfig, configPath);
    }
}

function migrateLegacyServerPlugins({ runtimeRoot, dataRoot, serverPluginsRoot }) {
    const aliasPath = path.join(runtimeRoot, SERVER_PLUGINS_ALIAS);
    if (pathExistsOrSymlink(aliasPath) && !isSymbolicLink(aliasPath)) {
        copyMissingChildren(aliasPath, serverPluginsRoot);
        fs.rmSync(aliasPath, { recursive: true, force: true });
    }
    copyMissingChildren(path.join(dataRoot, 'plugins'), serverPluginsRoot);
}

function migrateLegacyGlobalExtensions({ dataRoot, globalExtensionsRoot }) {
    copyMissingChildren(path.join(dataRoot, 'extensions', 'third-party'), globalExtensionsRoot);
}

function readRuntimeTreeVersion(sourceRoot) {
    // The packaged HAP drops dotfiles, so the HarmonyOS build writes the same
    // version to a plain file name as well.
    for (const name of [PACKAGED_RUNTIME_TREE_VERSION_FILE, RUNTIME_TREE_VERSION_FILE]) {
        try {
            const value = fs.readFileSync(path.join(sourceRoot, name), 'utf8').trim();
            if (value) {
                return value;
            }
        } catch {
            // try the next marker; fall back when running from an unstaged checkout
        }
    }
    return 'unstaged';
}

/**
 * Prepare the HarmonyOS writable runtime directory by copying the read-only
 * bundle into it. HarmonyOS app sandboxes reject symlink creation, so the
 * runtime cannot use the zero-copy layout that works on iOS and Android.
 *
 * The copy is a merge, never a wipe: server plugins, global third-party
 * extensions, whitelist.txt, and any other user-created files stay in the
 * runtime tree across app updates. The bundle tree version marker skips the
 * copy on subsequent launches.
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
    const serverPluginsRoot = path.join(resolvedRuntime, 'plugins');
    const globalExtensionsRoot = path.join(resolvedRuntime, 'public', 'scripts', 'extensions', 'third-party');
    const backupsRoot = path.join(resolvedData, 'backups');
    const configPath = path.join(resolvedData, 'config.yaml');

    fs.mkdirSync(resolvedData, { recursive: true });
    fs.mkdirSync(path.dirname(resolvedRuntime), { recursive: true });
    fs.mkdirSync(resolvedRuntime, { recursive: true });

    // Preserve a config written by the previous copied runtime before the
    // bundle copy can overwrite it. The server reads the dataRoot config.
    migrateLegacyConfig({ runtimeRoot: resolvedRuntime, configPath });

    // Detach any symlinks from the zero-copy layout before copying.
    detachRuntimeSymlinks(resolvedRuntime);

    const treeVersion = readRuntimeTreeVersion(resolvedSource);
    const markerPath = path.join(resolvedRuntime, RUNTIME_TREE_MARKER_FILE);
    let currentMarker = '';
    try {
        currentMarker = fs.readFileSync(markerPath, 'utf8').trim();
    } catch {
        // no marker yet — first launch or an update from the copied layout
    }

    const serverEntry = path.join(resolvedRuntime, 'server.js');
    const copyNeeded = currentMarker !== treeVersion || !fs.existsSync(serverEntry);
    const copiedAt = Date.now();
    if (copyNeeded) {
        log('BOOT', `staging runtime copy ${resolvedSource} -> ${resolvedRuntime} (tree=${treeVersion})`);
        let copiedEntries = 0;
        for (const entry of fs.readdirSync(resolvedSource, { withFileTypes: true })) {
            if (entry.name === RUNTIME_TREE_VERSION_FILE || entry.name === PACKAGED_RUNTIME_TREE_VERSION_FILE) {
                continue;
            }
            const sourceEntry = path.join(resolvedSource, entry.name);
            const targetEntry = path.join(resolvedRuntime, entry.name);
            if (entry.name === 'whitelist.txt' && pathExistsOrSymlink(targetEntry)) {
                continue;
            }
            fs.cpSync(sourceEntry, targetEntry, {
                recursive: true,
                force: true,
                dereference: true,
            });
            copiedEntries += 1;
        }
        fs.writeFileSync(markerPath, `${treeVersion}\n`, 'utf8');
        log('BOOT', `runtime copy done in ${Date.now() - copiedAt}ms entries=${copiedEntries}`);
    } else {
        log('BOOT', 'runtime copy up to date; skipping');
    }

    fs.mkdirSync(serverPluginsRoot, { recursive: true });
    fs.mkdirSync(globalExtensionsRoot, { recursive: true });
    fs.mkdirSync(backupsRoot, { recursive: true });

    // The zero-copy build kept these under dataRoot. Move them into the
    // runtime tree once so the server plugin loader sees the runtime layout.
    migrateLegacyServerPlugins({ runtimeRoot: resolvedRuntime, dataRoot: resolvedData, serverPluginsRoot });
    migrateLegacyGlobalExtensions({ dataRoot: resolvedData, globalExtensionsRoot });

    const pkgPath = path.join(serverPluginsRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(
            pkgPath,
            JSON.stringify({ name: 'sillytavern-plugins', type: 'commonjs' }),
            'utf8',
        );
    }

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
