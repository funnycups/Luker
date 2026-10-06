import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sync as commandExistsSync } from 'command-exists';

import { sanitizeServerPluginFolderName, resolveServerPluginPath } from './plugin-loader.js';

/**
 * @param {string} pluginPath
 * @returns {{ hasDependencies: boolean, declared: string[], missing: string[], needsInstall: boolean }}
 */
export function getPluginDependencyStatus(pluginPath) {
    const empty = { hasDependencies: false, declared: [], missing: [], needsInstall: false };
    try {
        const packageJsonPath = path.join(pluginPath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return empty;
        }

        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const declared = Object.keys(packageJson?.dependencies || {}).sort();
        if (declared.length === 0) {
            return empty;
        }

        const missing = declared.filter((name) => !fs.existsSync(path.join(pluginPath, 'node_modules', name, 'package.json')));

        return { hasDependencies: true, declared, missing, needsInstall: missing.length > 0 };
    } catch {
        return empty;
    }
}

/**
 * @param {string} pluginPath
 * @returns {Promise<void>}
 */
function installWithNpm(pluginPath) {
    return new Promise((resolve, reject) => {
        const child = spawn('npm', ['install', '--omit=dev'], { cwd: pluginPath, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`npm install exited with code ${code}: ${stderr.slice(-500)}`));
            }
        });
    });
}

/**
 * @param {string} pluginPath
 * @returns {Promise<void>}
 */
async function installWithArborist(pluginPath) {
    const { default: Arborist } = await import('@npmcli/arborist');
    const cacheRoot = path.join(globalThis.DATA_ROOT || os.tmpdir(), '_cache', 'npm');
    const cache = path.join(cacheRoot, 'cache');
    const tmp = path.join(cacheRoot, 'tmp');
    fs.mkdirSync(cache, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    const arborist = new Arborist({ path: pluginPath, cache, tmp, binLinks: false, ignoreScripts: true });
    await arborist.reify({ omit: ['dev'] });
}

/**
 * @param {string} pluginsPath
 * @param {string} directory
 * @param {{ forceManager?: 'arborist' }} [options]
 * @returns {Promise<{ directory: string, path: string, manager: 'npm'|'arborist'|null, installed: boolean }>}
 */
export async function installPluginDependencies(pluginsPath, directory, options = {}) {
    const requestedName = String(directory || '').trim();
    if (!requestedName) {
        const error = new Error('Missing server plugin directory name');
        error.statusCode = 400;
        throw error;
    }

    const folderName = sanitizeServerPluginFolderName(requestedName);

    if (folderName === '.') {
        const error = new Error('Invalid server plugin directory name');
        error.statusCode = 400;
        throw error;
    }

    let targetPath;
    try {
        targetPath = resolveServerPluginPath(pluginsPath, folderName);
    } catch (error) {
        error.statusCode = 400;
        throw error;
    }

    if (!fs.existsSync(targetPath)) {
        const error = new Error(`Plugin directory does not exist at ${folderName}`);
        error.statusCode = 404;
        throw error;
    }

    const status = getPluginDependencyStatus(targetPath);
    if (!status.needsInstall) {
        return { directory: folderName, path: targetPath, manager: null, installed: false };
    }

    try {
        const useNpm = options.forceManager !== 'arborist' && process.platform !== 'android' && commandExistsSync('npm');
        if (useNpm) {
            try {
                await installWithNpm(targetPath);
                return { directory: folderName, path: targetPath, manager: 'npm', installed: true };
            } catch (error) {
                console.warn(`[Plugin Loader] npm install failed, falling back to arborist: ${error.message}`);
            }
        }

        await installWithArborist(targetPath);
        return { directory: folderName, path: targetPath, manager: 'arborist', installed: true };
    } catch (error) {
        const wrapped = new Error(`Failed to install dependencies for ${folderName}: ${error.message}`);
        wrapped.statusCode = 500;
        throw wrapped;
    }
}
