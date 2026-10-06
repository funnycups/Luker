import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import express from 'express';
import * as isomorphicGit from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { default as git, CheckRepoActions } from 'simple-git';
import { sync as commandExistsSync } from 'command-exists';
import { getConfigValue, color } from './util.js';

const enableServerPlugins = !!getConfigValue('enableServerPlugins', false, 'boolean');
const enableServerPluginsAutoUpdate = !!getConfigValue('enableServerPluginsAutoUpdate', true, 'boolean');

/**
 * Map of loaded plugins.
 * @type {Map<string, any>}
 */
const loadedPlugins = new Map();

/**
 * @param {string} name
 * @returns {string}
 */
export function sanitizeServerPluginFolderName(name) {
    const base = String(name || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96);

    return base || 'server-plugin';
}

/**
 * @param {string} pluginUrl
 * @returns {string}
 */
export function deriveServerPluginFolderName(pluginUrl) {
    const normalized = String(pluginUrl || '')
        .trim()
        .replace(/[?#].*$/, '')
        .replace(/[\\/]+$/, '');

    const basename = path.posix.basename(normalized).replace(/\.git$/i, '');
    return sanitizeServerPluginFolderName(basename);
}

/**
 * @param {string} pluginsPath
 * @param {string} folderName
 * @returns {string}
 */
export function resolveServerPluginPath(pluginsPath, folderName) {
    const root = path.resolve(pluginsPath);
    const target = path.resolve(path.join(root, folderName));

    if (!(target === root || target.startsWith(root + path.sep))) {
        throw new Error('Resolved plugin path escapes the plugins directory');
    }

    return target;
}

function getErrorCode(error) {
    if (!error) {
        return '';
    }

    return String(error.code || error?.cause?.code || '').toUpperCase();
}

function isGitUnavailableError(error) {
    const code = getErrorCode(error);
    if (code === 'EACCES' || code === 'ENOENT') {
        return true;
    }

    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('spawn git eacces')
        || message.includes('spawn git enoent')
        || message.includes('git is not installed');
}

function isUnprocessableHttpError(error) {
    const code = String(error?.code || error?.data?.statusCode || '');
    if (code === '422') {
        return true;
    }

    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('422') || message.includes('unprocessable entity');
}

function normalizeRepoUrl(remoteUrl) {
    const raw = String(remoteUrl || '').trim();
    const parsed = new URL(raw);
    const normalized = new URL(parsed.toString());
    normalized.search = '';
    normalized.hash = '';

    const segments = normalized.pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex(segment =>
        ['-', 'tree', 'blob', 'commit', 'releases', 'tags', 'branches', 'compare', 'merge_requests'].includes(segment));
    const keepSegments = markerIndex >= 0 ? segments.slice(0, markerIndex) : segments;
    normalized.pathname = `/${keepSegments.join('/')}`.replace(/\/{2,}/g, '/');
    normalized.pathname = normalized.pathname.replace(/\/+$/, '');

    return normalized.toString();
}

function buildCloneUrlCandidates(remoteUrl) {
    const raw = String(remoteUrl || '').trim();
    const candidates = [];
    const pushCandidate = (candidate) => {
        if (candidate && !candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    };

    pushCandidate(raw);

    try {
        const normalized = normalizeRepoUrl(raw);
        pushCandidate(normalized);

        const normalizedUrl = new URL(normalized);
        if (!normalizedUrl.pathname.toLowerCase().endsWith('.git')) {
            const withGit = new URL(normalizedUrl.toString());
            withGit.pathname = `${normalizedUrl.pathname}.git`;
            pushCandidate(withGit.toString());
        }
    } catch {
        if (!raw.toLowerCase().endsWith('.git')) {
            pushCandidate(`${raw.replace(/\/+$/, '')}.git`);
        }
    }

    return candidates;
}

async function getIsomorphicGitAuthor(pluginPath) {
    const configuredName = await isomorphicGit.getConfig({
        fs,
        dir: pluginPath,
        path: 'user.name',
    }).catch(() => '');
    const configuredEmail = await isomorphicGit.getConfig({
        fs,
        dir: pluginPath,
        path: 'user.email',
    }).catch(() => '');

    const name = String(configuredName || '').trim() || 'Luker';
    const email = String(configuredEmail || '').trim() || 'noreply@luker.local';
    return { name, email };
}

async function getPluginRemoteUrlWithIsomorphic(pluginPath) {
    try {
        return await isomorphicGit.getConfig({
            fs,
            dir: pluginPath,
            path: 'remote.origin.url',
        }) || '';
    } catch {
        return '';
    }
}

async function cloneWithIsomorphic({ pluginUrl, pluginPath }) {
    const candidates = buildCloneUrlCandidates(pluginUrl);
    let lastError;

    for (const candidate of candidates) {
        const attempts = [
            { singleBranch: true, depth: 1 },
            { singleBranch: true },
            { singleBranch: false },
        ];

        for (const attempt of attempts) {
            try {
                fs.rmSync(pluginPath, { recursive: true, force: true });
                await isomorphicGit.clone({
                    fs,
                    http,
                    dir: pluginPath,
                    url: candidate,
                    ...attempt,
                });
                return candidate;
            } catch (error) {
                lastError = error;
                if (attempt.depth === 1 && !isUnprocessableHttpError(error)) {
                    break;
                }
            }
        }
    }

    throw lastError;
}

async function getPluginUpdateStatusWithIsomorphic(pluginPath) {
    const remoteUrl = await getPluginRemoteUrlWithIsomorphic(pluginPath);
    const currentBranchName = await isomorphicGit.currentBranch({
        fs,
        dir: pluginPath,
        fullname: false,
    });

    const currentCommitHash = await isomorphicGit.resolveRef({
        fs,
        dir: pluginPath,
        ref: 'HEAD',
    }).catch(() => '');

    if (!currentBranchName) {
        return {
            isUpToDate: true,
            currentBranchName: '',
            currentCommitHash,
            remoteUrl,
        };
    }

    await isomorphicGit.fetch({
        fs,
        http,
        dir: pluginPath,
        remote: 'origin',
        ref: currentBranchName,
        singleBranch: true,
    });

    const remoteCommitHash = await isomorphicGit.resolveRef({
        fs,
        dir: pluginPath,
        ref: `refs/remotes/origin/${currentBranchName}`,
    }).catch(() => '');

    return {
        isUpToDate: !remoteCommitHash || currentCommitHash === remoteCommitHash,
        currentBranchName,
        currentCommitHash,
        remoteUrl,
    };
}

async function updateServerPluginWithIsomorphic(pluginPath) {
    const statusRows = await isomorphicGit.statusMatrix({
        fs,
        dir: pluginPath,
    });
    const dirtyTrackedCount = statusRows.filter(([, head, workdir, stage]) =>
        Number(head) > 0 && (Number(workdir) !== Number(head) || Number(stage) !== Number(head)),
    ).length;

    if (dirtyTrackedCount > 0) {
        const error = new Error(`Plugin repository has ${dirtyTrackedCount} tracked local changes.`);
        // @ts-ignore
        error.statusCode = 409;
        throw error;
    }

    const status = await getPluginUpdateStatusWithIsomorphic(pluginPath);
    if (status.isUpToDate || !status.currentBranchName) {
        return status;
    }

    const author = await getIsomorphicGitAuthor(pluginPath);
    await isomorphicGit.pull({
        fs,
        http,
        dir: pluginPath,
        remote: 'origin',
        ref: status.currentBranchName,
        remoteRef: status.currentBranchName,
        singleBranch: true,
        fastForwardOnly: true,
        author,
    });

    const currentCommitHash = await isomorphicGit.resolveRef({
        fs,
        dir: pluginPath,
        ref: 'HEAD',
    }).catch(() => '');

    return {
        ...status,
        isUpToDate: false,
        currentCommitHash,
    };
}

/**
 * @param {string} pluginPath
 * @returns {Promise<string>}
 */
async function getPluginRemoteUrl(pluginPath) {
    try {
        if (commandExistsSync('git')) {
            const pluginRepo = git(pluginPath);
            const isRepo = await pluginRepo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);

            if (isRepo) {
                const remotes = await pluginRepo.getRemotes(true);
                const origin = remotes.find(remote => remote.name === 'origin');
                return origin?.refs?.fetch || origin?.refs?.push || '';
            }
        }

        return await getPluginRemoteUrlWithIsomorphic(pluginPath);
    } catch {
        return '';
    }
}

/**
 * @param {string} pluginPath
 * @returns {{ packageName: string, version: string, description: string }}
 */
function getPluginPackageMetadata(pluginPath) {
    try {
        const packageJsonPath = path.join(pluginPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return { packageName: '', version: '', description: '' };
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return {
            packageName: String(packageJson?.name || ''),
            version: String(packageJson?.version || ''),
            description: String(packageJson?.description || ''),
        };
    } catch {
        return { packageName: '', version: '', description: '' };
    }
}

/**
 * @param {string} pluginsPath
 * @returns {Promise<Array<{directory: string, path: string, remoteUrl: string, packageName: string, version: string, description: string}>>}
 */
export async function listInstalledServerPlugins(pluginsPath) {
    const root = path.resolve(pluginsPath);

    if (!fs.existsSync(root)) {
        return [];
    }

    const directories = fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .filter(entry => !entry.name.startsWith('.'));

    const plugins = await Promise.all(directories.map(async (entry) => {
        const pluginPath = path.join(root, entry.name);
        const metadata = getPluginPackageMetadata(pluginPath);
        const remoteUrl = await getPluginRemoteUrl(pluginPath);

        return {
            directory: entry.name,
            path: pluginPath,
            remoteUrl,
            ...metadata,
        };
    }));

    plugins.sort((left, right) => left.directory.localeCompare(right.directory));
    return plugins;
}

/**
 * @param {string} pluginsPath
 * @param {string} pluginUrl
 * @returns {Promise<{directory: string, path: string, remoteUrl: string, packageName: string, version: string, description: string}>}
 */
export async function installServerPlugin(pluginsPath, pluginUrl) {
    const remoteUrl = String(pluginUrl || '').trim();

    if (!remoteUrl) {
        const error = new Error('Missing plugin repository URL');
        // @ts-ignore
        error.statusCode = 400;
        throw error;
    }

    const root = path.resolve(pluginsPath);
    fs.mkdirSync(root, { recursive: true });

    const directory = deriveServerPluginFolderName(remoteUrl);
    const targetPath = resolveServerPluginPath(root, directory);

    if (fs.existsSync(targetPath)) {
        const error = new Error(`A plugin directory already exists at ${directory}`);
        // @ts-ignore
        error.statusCode = 409;
        throw error;
    }

    try {
        try {
            if (!commandExistsSync('git')) {
                throw new Error('Git is not installed on the server');
            }

            await git().clone(remoteUrl, targetPath, { '--depth': 1 });
        } catch (error) {
            if (!isGitUnavailableError(error)) {
                throw error;
            }

            await cloneWithIsomorphic({
                pluginUrl: remoteUrl,
                pluginPath: targetPath,
            });
        }

        const metadata = getPluginPackageMetadata(targetPath);
        const resolvedRemoteUrl = await getPluginRemoteUrl(targetPath);

        return {
            directory,
            path: targetPath,
            remoteUrl: resolvedRemoteUrl || remoteUrl,
            ...metadata,
        };
    } catch (error) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        throw error;
    }
}

/**
 * @param {string} pluginsPath
 * @param {string} directory
 * @returns {Promise<{directory: string, path: string, remoteUrl: string, packageName: string, version: string, description: string, currentCommitHash: string, isUpToDate: boolean}>}
 */
export async function updateServerPlugin(pluginsPath, directory) {
    const folderName = sanitizeServerPluginFolderName(directory);

    if (!folderName) {
        const error = new Error('Missing server plugin directory name');
        // @ts-ignore
        error.statusCode = 400;
        throw error;
    }

    const targetPath = resolveServerPluginPath(pluginsPath, folderName);
    if (!fs.existsSync(targetPath)) {
        const error = new Error(`Plugin directory does not exist at ${folderName}`);
        // @ts-ignore
        error.statusCode = 404;
        throw error;
    }

    let remoteUrl = '';
    let currentCommitHash = '';
    let isUpToDate = true;

    try {
        if (!commandExistsSync('git')) {
            throw new Error('Git is not installed on the server');
        }

        const pluginRepo = git(targetPath);
        const isRepo = await pluginRepo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (!isRepo) {
            const error = new Error(`Directory is not a Git repository at ${folderName}`);
            // @ts-ignore
            error.statusCode = 409;
            throw error;
        }

        remoteUrl = await getPluginRemoteUrl(targetPath);
        if (!remoteUrl) {
            const error = new Error(`No git remote detected for ${folderName}`);
            // @ts-ignore
            error.statusCode = 409;
            throw error;
        }

        await pluginRepo.fetch();
        const previousCommitHash = await pluginRepo.revparse(['HEAD']);

        let trackingBranch = '';
        try {
            trackingBranch = await pluginRepo.revparse(['--abbrev-ref', '@{u}']);
        } catch {
            const error = new Error(`Plugin repository does not track an upstream branch at ${folderName}`);
            // @ts-ignore
            error.statusCode = 409;
            throw error;
        }

        const log = await pluginRepo.log({
            from: previousCommitHash,
            to: trackingBranch,
        });

        isUpToDate = log.total === 0;
        if (!isUpToDate) {
            const currentBranch = await pluginRepo.branch();
            await pluginRepo.pull('origin', currentBranch.current);
        }

        currentCommitHash = await pluginRepo.revparse(['HEAD']);
    } catch (error) {
        if (!isGitUnavailableError(error)) {
            throw error;
        }

        const result = await updateServerPluginWithIsomorphic(targetPath);
        remoteUrl = String(result.remoteUrl || '').trim();
        currentCommitHash = String(result.currentCommitHash || '').trim();
        isUpToDate = result.isUpToDate;
    }

    const metadata = getPluginPackageMetadata(targetPath);

    return {
        directory: folderName,
        path: targetPath,
        remoteUrl,
        currentCommitHash,
        isUpToDate,
        ...metadata,
    };
}

/**
 * @param {string} pluginsPath
 * @param {string} directory
 * @returns {Promise<{directory: string, path: string}>}
 */
export async function removeServerPlugin(pluginsPath, directory) {
    const folderName = sanitizeServerPluginFolderName(directory);

    if (!folderName) {
        const error = new Error('Missing server plugin directory name');
        // @ts-ignore
        error.statusCode = 400;
        throw error;
    }

    const targetPath = resolveServerPluginPath(pluginsPath, folderName);
    if (!fs.existsSync(targetPath)) {
        const error = new Error(`Plugin directory does not exist at ${folderName}`);
        // @ts-ignore
        error.statusCode = 404;
        throw error;
    }

    await fs.promises.rm(targetPath, { recursive: true, force: true });

    if (fs.existsSync(targetPath)) {
        const error = new Error(`Plugin directory still exists at ${folderName}`);
        // @ts-ignore
        error.statusCode = 409;
        throw error;
    }

    return {
        directory: folderName,
        path: targetPath,
    };
}

/**
 * Determine if a file is a CommonJS module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is a CommonJS module
 */
const isCommonJS = (file) => path.extname(file) === '.js' || path.extname(file) === '.cjs';

/**
 * Determine if a file is an ECMAScript module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is an ECMAScript module
 */
const isESModule = (file) => path.extname(file) === '.mjs';

/**
 * Load and initialize server plugins from a directory if they are enabled.
 * @param {import('express').Express} app Express app
 * @param {string} pluginsPath Path to plugins directory
 * @returns {Promise<Function>} Promise that resolves when all plugins are loaded. Resolves to a "cleanup" function to
 * be called before the server shuts down.
 */
export async function loadPlugins(app, pluginsPath) {
    try {
        const exitHooks = [];
        const emptyFn = () => { };

        // Server plugins are disabled.
        if (!enableServerPlugins) {
            return emptyFn;
        }

        // Plugins directory does not exist.
        if (!fs.existsSync(pluginsPath)) {
            return emptyFn;
        }

        const files = fs.readdirSync(pluginsPath);

        // No plugins to load.
        if (files.length === 0) {
            return emptyFn;
        }

        await updatePlugins(pluginsPath);

        for (const file of files) {
            const pluginFilePath = path.join(pluginsPath, file);

            if (fs.statSync(pluginFilePath).isDirectory()) {
                await loadFromDirectory(app, pluginFilePath, exitHooks);
                continue;
            }

            // Not a JavaScript file.
            if (!isCommonJS(file) && !isESModule(file)) {
                continue;
            }

            await loadFromFile(app, pluginFilePath, exitHooks);
        }

        if (loadedPlugins.size > 0) {
            console.log(`${loadedPlugins.size} server plugin(s) are currently loaded. Make sure you know exactly what they do, and only install plugins from trusted sources!`);
        }

        // Call all plugin "exit" functions at once and wait for them to finish
        return () => Promise.all(exitHooks.map(exitFn => exitFn()));
    } catch (error) {
        console.error('Plugin loading failed.', error);
        return () => { };
    }
}

async function loadFromDirectory(app, pluginDirectoryPath, exitHooks) {
    const files = fs.readdirSync(pluginDirectoryPath);

    // No plugins to load.
    if (files.length === 0) {
        return;
    }

    // Plugin is an npm package.
    const packageJsonFilePath = path.join(pluginDirectoryPath, 'package.json');
    if (fs.existsSync(packageJsonFilePath)) {
        if (await loadFromPackage(app, packageJsonFilePath, exitHooks)) {
            return;
        }
    }

    // Plugin is a module file.
    const fileTypes = ['index.js', 'index.cjs', 'index.mjs'];

    for (const fileType of fileTypes) {
        const filePath = path.join(pluginDirectoryPath, fileType);
        if (fs.existsSync(filePath)) {
            if (await loadFromFile(app, filePath, exitHooks)) {
                return;
            }
        }
    }
}

/**
 * Loads and initializes a plugin from an npm package.
 * @param {import('express').Express} app Express app
 * @param {string} packageJsonPath Path to package.json file
 * @param {Array<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromPackage(app, packageJsonPath, exitHooks) {
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.main) {
            const pluginFilePath = path.join(path.dirname(packageJsonPath), packageJson.main);
            return await loadFromFile(app, pluginFilePath, exitHooks);
        }
    } catch (error) {
        console.error(`Failed to load plugin from ${packageJsonPath}: ${error}`);
    }
    return false;
}

/**
 * Loads and initializes a plugin from a file.
 * @param {import('express').Express} app Express app
 * @param {string} pluginFilePath Path to plugin directory
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromFile(app, pluginFilePath, exitHooks) {
    try {
        const fileUrl = url.pathToFileURL(pluginFilePath).toString();
        const plugin = await import(fileUrl);
        console.log(`Initializing plugin from ${pluginFilePath}`);
        return await initPlugin(app, plugin, exitHooks);
    } catch (error) {
        console.error(`Failed to load plugin from ${pluginFilePath}: ${error}`);
        return false;
    }
}

/**
 * Check whether a plugin ID is valid (only lowercase alphanumeric, hyphens, and underscores).
 * @param {string} id The plugin ID to check
 * @returns {boolean} True if the plugin ID is valid.
 */
function isValidPluginID(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Initializes a plugin module.
 * @param {import('express').Express} app Express app
 * @param {any} plugin Plugin module
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was initialized successfully
 */
async function initPlugin(app, plugin, exitHooks) {
    const info = plugin.info || plugin.default?.info;
    if (typeof info !== 'object') {
        console.error('Failed to load plugin module; plugin info not found');
        return false;
    }

    // We don't currently use "name" or "description" but it would be nice to have a UI for listing server plugins, so
    // require them now just to be safe
    for (const field of ['id', 'name', 'description']) {
        if (typeof info[field] !== 'string') {
            console.error(`Failed to load plugin module; plugin info missing field '${field}'`);
            return false;
        }
    }

    const init = plugin.init || plugin.default?.init;
    if (typeof init !== 'function') {
        console.error('Failed to load plugin module; no init function');
        return false;
    }

    const { id } = info;

    if (!isValidPluginID(id)) {
        console.error(`Failed to load plugin module; invalid plugin ID '${id}'`);
        return false;
    }

    if (loadedPlugins.has(id)) {
        console.error(`Failed to load plugin module; plugin ID '${id}' is already in use`);
        return false;
    }

    // Allow the plugin to register API routes under /api/plugins/[plugin ID] via a router
    const router = express.Router();

    await init(router);

    loadedPlugins.set(id, plugin);

    // Add API routes to the app if the plugin registered any
    if (router.stack.length > 0) {
        app.use(`/api/plugins/${id}`, router);
    }

    const exit = plugin.exit || plugin.default?.exit;
    if (typeof exit === 'function') {
        exitHooks.push(exit);
    }

    return true;
}

/**
 * Automatically update all git plugins in the ./plugins directory
 * @param {string} pluginsPath Path to plugins directory
 */
async function updatePlugins(pluginsPath) {
    if (!enableServerPluginsAutoUpdate) {
        return;
    }

    const directories = fs.readdirSync(pluginsPath)
        .filter(file => !file.startsWith('.'))
        .filter(file => fs.statSync(path.join(pluginsPath, file)).isDirectory());

    if (directories.length === 0) {
        return;
    }

    console.log(color.blue('Auto-updating server plugins... Set'), color.yellow('enableServerPluginsAutoUpdate: false'), color.blue('in config.yaml to disable this feature.'));

    let pluginsToUpdate = 0;

    for (const directory of directories) {
        try {
            const pluginPath = path.join(pluginsPath, directory);
            try {
                if (!commandExistsSync('git')) {
                    throw new Error('Git is not installed on the server');
                }

                const pluginRepo = git(pluginPath);
                const isRepo = await pluginRepo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
                if (!isRepo) {
                    continue;
                }

                await pluginRepo.fetch();
                const commitHash = await pluginRepo.revparse(['HEAD']);
                const trackingBranch = await pluginRepo.revparse(['--abbrev-ref', '@{u}']);
                const log = await pluginRepo.log({
                    from: commitHash,
                    to: trackingBranch,
                });

                if (log.total === 0) {
                    continue;
                }

                pluginsToUpdate++;
                await pluginRepo.pull();
                const latestCommit = await pluginRepo.revparse(['HEAD']);
                console.log(`Plugin ${color.green(directory)} updated to commit ${color.cyan(latestCommit)}`);
            } catch (error) {
                if (!isGitUnavailableError(error)) {
                    throw error;
                }

                const result = await updateServerPluginWithIsomorphic(pluginPath);
                if (result.isUpToDate) {
                    continue;
                }

                pluginsToUpdate++;
                console.log(`Plugin ${color.green(directory)} updated with isomorphic-git to commit ${color.cyan(result.currentCommitHash)}`);
            }
        } catch (error) {
            console.error(color.red(`Failed to update plugin ${directory}: ${error.message}`));
        }
    }

    if (pluginsToUpdate === 0) {
        console.log('All plugins are up to date.');
    }
}
