import path from 'node:path';
import fs from 'node:fs';

import express from 'express';
import * as isomorphicGit from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import sanitize from 'sanitize-filename';
import { CheckRepoActions, default as simpleGit } from 'simple-git';

import { PUBLIC_DIRECTORIES } from '../constants.js';
import { color, getConfigValue, isValidUrl } from '../util.js';
import {
    GIT_BACKENDS,
    canFallbackToBuiltinGit,
    createGitClient,
    createHardenedSimpleGitOptions,
    isGitUnavailableError,
    shouldUseSystemGit,
} from '../git/client.js';
import { runGatedWrite } from '../sync/in-progress-gate.js';
import { makeStagingPath, swapDirectoryInto, fingerprintDirectory, isStagingEntryName } from '../sync/staging.js';

const getConfiguredGitBackend = () => getConfigValue('git.backend', 'auto');

/**
 * @type {Partial<import('simple-git').SimpleGitOptions>}
 */
const OPTIONS = Object.freeze({ timeout: { block: 5 * 60 * 1000 } });

/**
 * @param {string} baseDir
 */
function createExtensionGit(baseDir) {
    return simpleGit(createHardenedSimpleGitOptions({ baseDir, ...OPTIONS }));
}

async function getIsomorphicGitAuthor(extensionPath) {
    const configuredName = await isomorphicGit.getConfig({
        fs,
        dir: extensionPath,
        path: 'user.name',
    }).catch(() => '');
    const configuredEmail = await isomorphicGit.getConfig({
        fs,
        dir: extensionPath,
        path: 'user.email',
    }).catch(() => '');

    const name = String(configuredName || '').trim() || 'Luker';
    const email = String(configuredEmail || '').trim() || 'noreply@luker.local';
    return { name, email };
}

function getInstallDirectoryNameFromUrl(url) {
    const raw = String(url || '').trim();
    try {
        const parsed = new URL(raw);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const lastSegment = segments.at(-1) || '';
        return sanitize(lastSegment.replace(/\.git$/i, ''));
    } catch {
        return sanitize(path.basename(raw, '.git'));
    }
}

function normalizeRepoUrl(url) {
    const raw = String(url || '').trim();
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

function buildCloneUrlCandidates(url) {
    const raw = String(url || '').trim();
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

function isUnprocessableHttpError(error) {
    const code = String(error?.code || error?.data?.statusCode || '');
    if (code === '422') {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('422') || message.includes('unprocessable entity');
}

function createExtensionUpdateConflictError(message, code = 'UPDATE_CONFLICT') {
    const error = new Error(String(message || 'Extension update conflict.'));
    error.code = code;
    return error;
}

function isExtensionUpdateConflictError(error) {
    const code = String(error?.code || '').toUpperCase();
    if ([
        'UPDATE_CONFLICT',
        'MERGENOTSUPPORTEDERROR',
        'FASTFORWARDERROR',
        'CONFLICT',
    ].includes(code)) {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('merge not supported')
        || message.includes('merge conflict')
        || message.includes('conflict')
        || message.includes('non-fast-forward')
        || message.includes('fast-forward');
}

function toRemoteRefName(branchName) {
    return `refs/remotes/origin/${branchName}`;
}

function toLocalRefName(branchName) {
    return `refs/heads/${branchName}`;
}

async function getRemoteUrlWithIsomorphic(extensionPath) {
    try {
        return await isomorphicGit.getConfig({
            fs,
            dir: extensionPath,
            path: 'remote.origin.url',
        }) || '';
    } catch {
        return '';
    }
}

async function cloneWithIsomorphic({ url, extensionPath, branch, singleBranch = true, depth = 1 }) {
    const cloneOptions = {
        fs,
        http,
        dir: extensionPath,
        url,
        singleBranch,
    };

    if (Number.isInteger(depth) && depth > 0) {
        cloneOptions.depth = depth;
    }

    if (branch) {
        cloneOptions.ref = branch;
    }

    await isomorphicGit.clone(cloneOptions);
}

async function cloneWithIsomorphicRetry({ url, extensionPath, branch }) {
    const candidates = buildCloneUrlCandidates(url);
    let lastError;

    for (const candidate of candidates) {
        const attempts = [
            { singleBranch: true, depth: 1 },
            { singleBranch: true },
            { singleBranch: false },
        ];

        for (const attempt of attempts) {
            try {
                fs.rmSync(extensionPath, { recursive: true, force: true });
                await cloneWithIsomorphic({
                    url: candidate,
                    extensionPath,
                    branch,
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

async function listServerRefsWithCandidates({ remoteUrl, prefix }) {
    const candidates = buildCloneUrlCandidates(remoteUrl);
    let lastError;

    for (const candidate of candidates) {
        try {
            const refs = await isomorphicGit.listServerRefs({
                http,
                url: candidate,
                prefix,
            });
            return { refs, resolvedUrl: candidate };
        } catch (error) {
            lastError = error;
            if (!isUnprocessableHttpError(error)) {
                break;
            }
        }
    }

    throw lastError;
}

async function fetchWithIsomorphicCandidates(extensionPath, options) {
    const remoteUrl = await getRemoteUrlWithIsomorphic(extensionPath);
    const candidates = remoteUrl ? buildCloneUrlCandidates(remoteUrl) : [''];
    let lastError;

    for (const candidate of candidates) {
        try {
            await isomorphicGit.fetch({
                fs,
                http,
                dir: extensionPath,
                remote: 'origin',
                ...(candidate ? { url: candidate } : {}),
                ...options,
            });
            return candidate;
        } catch (error) {
            lastError = error;
            if (!isUnprocessableHttpError(error)) {
                break;
            }
        }
    }

    throw lastError;
}

async function checkIfRepoIsUpToDateWithIsomorphic(extensionPath) {
    const remoteUrl = await getRemoteUrlWithIsomorphic(extensionPath);
    const currentBranch = await isomorphicGit.currentBranch({
        fs,
        dir: extensionPath,
        fullname: false,
    });

    if (!currentBranch) {
        return {
            isUpToDate: true,
            remoteUrl,
            resolvedRemoteUrl: remoteUrl,
            currentBranchName: '',
            currentCommitHash: '',
            remoteCommitHash: '',
        };
    }

    const currentCommitHash = await isomorphicGit.resolveRef({
        fs,
        dir: extensionPath,
        ref: 'HEAD',
    });

    if (!remoteUrl) {
        return {
            isUpToDate: true,
            remoteUrl: '',
            resolvedRemoteUrl: '',
            currentBranchName: currentBranch,
            currentCommitHash,
            remoteCommitHash: '',
        };
    }

    const targetRef = `refs/heads/${currentBranch}`;
    const { refs, resolvedUrl } = await listServerRefsWithCandidates({
        remoteUrl,
        prefix: targetRef,
    });
    const match = refs.find(ref => ref.ref === targetRef);
    const remoteCommitHash = match ? match.oid : '';

    return {
        isUpToDate: !remoteCommitHash || currentCommitHash === remoteCommitHash,
        remoteUrl,
        resolvedRemoteUrl: resolvedUrl || remoteUrl,
        currentBranchName: currentBranch,
        currentCommitHash,
        remoteCommitHash,
    };
}

const EMPTY_EXTENSION_VERSION = Object.freeze({
    currentBranchName: '',
    currentCommitHash: '',
    isUpToDate: true,
    remoteUrl: '',
    remoteCommitHash: '',
});

async function getVersionWithIsomorphic(extensionPath) {
    if (!fs.existsSync(path.join(extensionPath, '.git'))) {
        return { ...EMPTY_EXTENSION_VERSION };
    }

    let currentCommitHash = '';
    try {
        currentCommitHash = await isomorphicGit.resolveRef({
            fs,
            dir: extensionPath,
            ref: 'HEAD',
        });
    } catch {
        return { ...EMPTY_EXTENSION_VERSION };
    }

    const currentBranchName = (await isomorphicGit.currentBranch({
        fs,
        dir: extensionPath,
        fullname: false,
    }).catch(() => '')) || '';
    const remoteUrl = await getRemoteUrlWithIsomorphic(extensionPath);

    if (!currentBranchName || !remoteUrl) {
        return {
            currentBranchName,
            currentCommitHash,
            isUpToDate: true,
            remoteUrl,
            remoteCommitHash: '',
        };
    }

    try {
        const targetRef = `refs/heads/${currentBranchName}`;
        const { refs } = await listServerRefsWithCandidates({
            remoteUrl,
            prefix: targetRef,
        });
        const match = refs.find(ref => ref.ref === targetRef);
        const remoteCommitHash = match ? match.oid : '';
        return {
            currentBranchName,
            currentCommitHash,
            isUpToDate: !remoteCommitHash || currentCommitHash === remoteCommitHash,
            remoteUrl,
            remoteCommitHash,
        };
    } catch (error) {
        console.error(`Failed to query remote refs for extension at ${extensionPath}`, error);
        return {
            currentBranchName,
            currentCommitHash,
            isUpToDate: true,
            remoteUrl,
            remoteCommitHash: '',
        };
    }
}

async function updateWithIsomorphic(extensionPath) {
    const statusRows = await isomorphicGit.statusMatrix({
        fs,
        dir: extensionPath,
    });
    const dirtyTrackedCount = statusRows.filter(([, head, workdir, stage]) =>
        Number(head) > 0 && (Number(workdir) !== Number(head) || Number(stage) !== Number(head)),
    ).length;
    if (dirtyTrackedCount > 0) {
        throw createExtensionUpdateConflictError(`Extension repository has ${dirtyTrackedCount} tracked local changes.`);
    }

    const status = await checkIfRepoIsUpToDateWithIsomorphic(extensionPath);

    if (status.isUpToDate || !status.currentBranchName) {
        return status;
    }

    const author = await getIsomorphicGitAuthor(extensionPath);
    const pullUrl = status.resolvedRemoteUrl || status.remoteUrl;
    try {
        await isomorphicGit.pull({
            fs,
            http,
            dir: extensionPath,
            remote: 'origin',
            ...(pullUrl ? { url: pullUrl } : {}),
            ref: status.currentBranchName,
            remoteRef: status.currentBranchName,
            singleBranch: true,
            fastForwardOnly: true,
            author,
        });
    } catch (error) {
        if (isExtensionUpdateConflictError(error)) {
            throw createExtensionUpdateConflictError('Local extension branch has diverged from remote. Manual reset or reinstall is required.');
        }
        throw error;
    }

    const currentCommitHash = await isomorphicGit.resolveRef({
        fs,
        dir: extensionPath,
        ref: 'HEAD',
    });
    return {
        ...status,
        isUpToDate: false,
        currentCommitHash,
    };
}

async function forceUpdateWithIsomorphic(extensionPath) {
    const remoteUrl = String(await getRemoteUrlWithIsomorphic(extensionPath) || '').trim();
    if (!remoteUrl) {
        throw createExtensionUpdateConflictError('Cannot determine extension remote URL.');
    }

    const currentBranch = String(await isomorphicGit.currentBranch({
        fs,
        dir: extensionPath,
        fullname: false,
    }).catch(() => '') || '').trim();

    fs.rmSync(extensionPath, { recursive: true, force: true });

    let resolvedCloneUrl = '';
    let usedBranch = currentBranch;
    try {
        resolvedCloneUrl = await cloneWithIsomorphicRetry({
            url: remoteUrl,
            extensionPath,
            branch: usedBranch || undefined,
        });
    } catch (error) {
        if (!usedBranch) {
            throw error;
        }
        usedBranch = '';
        resolvedCloneUrl = await cloneWithIsomorphicRetry({
            url: remoteUrl,
            extensionPath,
            branch: undefined,
        });
    }

    const currentCommitHash = await isomorphicGit.resolveRef({
        fs,
        dir: extensionPath,
        ref: 'HEAD',
    }).catch(() => '');

    return {
        isUpToDate: false,
        remoteUrl: resolvedCloneUrl || remoteUrl,
        currentBranchName: usedBranch,
        currentCommitHash,
        forced: true,
    };
}

async function listBranchesWithIsomorphic(extensionPath) {
    await fetchWithIsomorphicCandidates(extensionPath, {
        singleBranch: false,
        depth: 1,
    });

    const currentBranch = await isomorphicGit.currentBranch({
        fs,
        dir: extensionPath,
        fullname: false,
    });
    const localBranches = await isomorphicGit.listBranches({
        fs,
        dir: extensionPath,
    });
    const remoteBranches = (await isomorphicGit.listBranches({
        fs,
        dir: extensionPath,
        remote: 'origin',
    })).filter(branch => branch !== 'HEAD');

    const localRows = await Promise.all(localBranches.map(async (branch) => {
        let commit = '';
        try {
            commit = await isomorphicGit.resolveRef({
                fs,
                dir: extensionPath,
                ref: toLocalRefName(branch),
            });
        } catch {
            commit = '';
        }
        return {
            current: branch === currentBranch,
            commit,
            name: branch,
            label: branch,
        };
    }));

    const remoteRows = await Promise.all(remoteBranches.map(async (branch) => {
        let commit = '';
        try {
            commit = await isomorphicGit.resolveRef({
                fs,
                dir: extensionPath,
                ref: toRemoteRefName(branch),
            });
        } catch {
            commit = '';
        }
        return {
            current: false,
            commit,
            name: `origin/${branch}`,
            label: `origin/${branch}`,
        };
    }));

    return [...localRows, ...remoteRows];
}

async function switchBranchWithIsomorphic(extensionPath, branch) {
    if (String(branch).startsWith('origin/')) {
        const localBranch = branch.replace('origin/', '');
        await isomorphicGit.checkout({
            fs,
            dir: extensionPath,
            ref: localBranch,
            remote: 'origin',
            track: true,
        });
        return;
    }

    const localBranches = await isomorphicGit.listBranches({
        fs,
        dir: extensionPath,
    });
    if (!localBranches.includes(branch)) {
        throw new Error(`Branch ${branch} does not exist locally`);
    }

    await isomorphicGit.checkout({
        fs,
        dir: extensionPath,
        ref: branch,
    });
}

/**
 * This function extracts the extension information from the manifest file.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the manifest data as an object
 */
async function getManifest(extensionPath) {
    const manifestPath = path.join(extensionPath, 'manifest.json');

    // Check if manifest.json exists
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Manifest file not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest;
}

function parseLsRemoteSha(output) {
    const text = String(output || '').trim();
    if (!text) return '';
    const firstLine = text.split('\n')[0].trim();
    const sha = firstLine.split(/\s+/)[0];
    return /^[a-f0-9]{40}$/i.test(sha) ? sha : '';
}

/**
 * This function checks if the local repository is up-to-date with the remote repository.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the extension information as an object
 */
async function checkIfRepoIsUpToDate(extensionPath) {
    const git = createExtensionGit(extensionPath);
    const currentBranch = await git.branch();
    const currentCommitHash = await git.revparse(['HEAD']);
    const branchName = currentBranch.current || '';

    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
        return {
            isUpToDate: true,
            remoteUrl: '',
            remoteCommitHash: '',
        };
    }
    const remoteUrl = remotes[0].refs.fetch;

    if (!branchName) {
        return {
            isUpToDate: true,
            remoteUrl,
            remoteCommitHash: '',
        };
    }

    const lsRemoteOutput = await git.listRemote(['origin', `refs/heads/${branchName}`]);
    const remoteCommitHash = parseLsRemoteSha(lsRemoteOutput);

    return {
        isUpToDate: !remoteCommitHash || remoteCommitHash === currentCommitHash,
        remoteUrl,
        remoteCommitHash,
    };
}

export const router = express.Router();

/**
 * Feature flag guard: don't allow calling any of the endpoints if extensions are disabled
 * @type {import('express').RequestHandler}
 */
export const extensionsEnabledFeatureGuard = (_, response, next) => {
    const enabled = !!getConfigValue('extensions.enabled', true, 'boolean');
    if (!enabled) {
        response.sendStatus(404);
        return;
    }
    next();
};

router.use(extensionsEnabledFeatureGuard);

/**
 * HTTP POST handler function to clone a git repository from a provided URL, read the extension manifest,
 * and return extension information and path.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'url' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/install', async (request, response) => {
    let stagedClonePath = null;
    try {
        const { url, global, branch } = request.body;

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to install global extensions.`);
            return response.status(403).send('Forbidden: No permission to install global extensions.');
        }

        if (!isValidUrl(url)) {
            return response.status(400).send('Bad Request: A valid URL is required in the request body.');
        }

        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return response.status(400).send('Bad Request: Only HTTP and HTTPS protocols are supported for the Extension URL.');
        }

        if (branch !== undefined && branch !== null && branch !== '' && (typeof branch !== 'string' || branch.trim().startsWith('-'))) {
            return response.status(400).send('Bad Request: A valid branch name is required.');
        }

        const configuredBackend = getConfiguredGitBackend();
        const git = createGitClient({ backend: configuredBackend });

        // make sure the third-party directory exists
        if (!fs.existsSync(path.join(request.user.directories.extensions))) {
            fs.mkdirSync(path.join(request.user.directories.extensions));
        }

        if (!fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
            fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions, { recursive: true });
        }

        const replace = request.body.replace;
        const shouldReplace = replace === true;

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionDirName = getInstallDirectoryNameFromUrl(url);
        if (!extensionDirName) {
            return response.status(400).send('Could not determine the extension name from the URL. Please provide a valid git repository URL.');
        }
        const extensionPath = path.join(basePath, extensionDirName);
        const folderName = path.basename(extensionPath);

        if (fs.existsSync(extensionPath) && !shouldReplace) {
            return response.status(409).send(`Directory already exists at ${extensionPath}`);
        }

        // Per-user extensions are synced data: clone into a staging
        // sibling without a write-gate slot, then swap the finished
        // checkout into place under the gate. Global extensions are not synced.
        const synced = !global;
        let clonePath = extensionPath;
        if (synced) {
            stagedClonePath = await makeStagingPath(extensionPath, 'extension');
            await fs.promises.rmdir(stagedClonePath);
            clonePath = stagedClonePath;
        } else {
            if (fs.existsSync(extensionPath)) {
                await fs.promises.rm(extensionPath, { recursive: true, force: true });
            }
        }

        const cloneOptions = { depth: 1 };
        if (branch) {
            cloneOptions.branch = branch;
        }
        if (git.backend === GIT_BACKENDS.BUILTIN) {
            const resolvedCloneUrl = await cloneWithIsomorphicRetry({
                url,
                extensionPath: clonePath,
                branch,
            });
            console.info(`Extension has been cloned with isomorphic-git to ${extensionPath} from ${resolvedCloneUrl} at ${branch || '(default)'} branch`);
        } else {
            try {
                await git.clone(url, clonePath, cloneOptions);
                console.info(`Extension has been cloned to ${extensionPath} from ${url} at ${branch || '(default)'} branch`);
            } catch (error) {
                if (!canFallbackToBuiltinGit(configuredBackend, error)) {
                    throw error;
                }
                const resolvedCloneUrl = await cloneWithIsomorphicRetry({
                    url,
                    extensionPath: clonePath,
                    branch,
                });
                console.info(`Extension has been cloned with isomorphic-git to ${extensionPath} from ${resolvedCloneUrl} at ${branch || '(default)'} branch`);
            }
        }

        let manifest;
        try {
            manifest = await getManifest(clonePath);
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Manifest is not a valid JSON object.');
            }
        } catch (manifestError) {
            await fs.promises.rm(clonePath, { recursive: true, force: true });
            throw manifestError;
        }

        if (synced) {
            const syncOwner = { handle: request.user.profile.handle, userRoot: request.user.directories.root };
            await runGatedWrite(syncOwner, () => swapDirectoryInto(clonePath, extensionPath));
        }
        const { version, author, display_name } = manifest;
        return response.send({ version, author, display_name, extensionPath, folderName });
    } catch (error) {
        // A successful swap consumed the staged clone; on failure it is
        // removed before responding so the client never sees it.
        if (stagedClonePath) {
            await fs.promises.rm(stagedClonePath, { recursive: true, force: true })
                .catch(cleanupError => console.error('Failed to remove extension staging directory', stagedClonePath, cleanupError));
        }
        console.error('Importing extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to pull the latest updates from a git repository
 * based on the extension name provided in the request body. It returns the latest commit hash,
 * the path of the extension, the status of the repository (whether it's up-to-date or not),
 * and the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/update', async (request, response) => {
    let stagedWorkPath = null;
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global, force } = request.body;
        const forceUpdate = force === true;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to update global extensions.`);
            return response.status(403).send('Forbidden: No permission to update global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        // Per-user extensions are synced data. The update runs on a copy in
        // the staging area without a gate slot; the copy is swapped back
        // under the gate only if the live directory did not change meanwhile.
        const synced = !global;
        const syncOwner = { handle: request.user.profile.handle, userRoot: request.user.directories.root };
        let fingerprint = null;
        let workPath = extensionPath;
        if (synced) {
            stagedWorkPath = await makeStagingPath(extensionPath, 'extension');
            await fs.promises.rmdir(stagedWorkPath);
            workPath = stagedWorkPath;
            fingerprint = await runGatedWrite(syncOwner, async () => {
                await fs.promises.cp(extensionPath, workPath, { recursive: true, verbatimSymlinks: true });
                return fingerprintDirectory(extensionPath);
            }, { dirty: false });
        }
        const commit = async () => {
            if (!synced) return;
            await runGatedWrite(syncOwner, async () => {
                if (await fingerprintDirectory(extensionPath) !== fingerprint) {
                    const changed = new Error('The extension directory changed during the update.');
                    changed.code = 'EXTENSION_CHANGED_DURING_UPDATE';
                    throw changed;
                }
                await swapDirectoryInto(workPath, extensionPath, { expectedFingerprint: fingerprint });
            });
        };

        if (forceUpdate) {
            const result = await forceUpdateWithIsomorphic(workPath);
            await commit();
            const shortCommitHash = result.currentCommitHash ? result.currentCommitHash.slice(0, 7) : '';
            console.info(`Extension has been force-updated with isomorphic-git at ${extensionPath}`);
            return response.send({
                shortCommitHash,
                extensionPath,
                isUpToDate: false,
                remoteUrl: result.remoteUrl,
                forced: true,
            });
        }

        const configuredBackend = getConfiguredGitBackend();
        const runIsomorphicUpdate = async () => {
            const result = await updateWithIsomorphic(workPath);
            await commit();
            const shortCommitHash = result.currentCommitHash ? result.currentCommitHash.slice(0, 7) : '';
            if (!result.isUpToDate) {
                console.info(`Extension has been updated with isomorphic-git at ${extensionPath}`);
            } else {
                console.info(`Extension is up to date at ${extensionPath}`);
            }

            return {
                shortCommitHash,
                extensionPath,
                isUpToDate: result.isUpToDate,
                remoteUrl: result.remoteUrl,
            };
        };

        if (!shouldUseSystemGit(configuredBackend)) {
            return response.send(await runIsomorphicUpdate());
        }

        let systemUpdateResult;
        try {
            const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(workPath);
            const git = createExtensionGit(workPath);
            const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                throw new Error(`Directory is not a Git repository at ${extensionPath}`);
            }
            const currentBranch = await git.branch();
            if (!isUpToDate) {
                await git.pull('origin', currentBranch.current);
                console.info(`Extension has been updated at ${extensionPath}`);
            } else {
                console.info(`Extension is up to date at ${extensionPath}`);
            }
            const fullCommitHash = await git.revparse(['HEAD']);
            systemUpdateResult = {
                shortCommitHash: fullCommitHash.slice(0, 7),
                extensionPath,
                isUpToDate,
                remoteUrl,
            };
        } catch (error) {
            if (!canFallbackToBuiltinGit(configuredBackend, error)) {
                throw error;
            }

            return response.send(await runIsomorphicUpdate());
        }

        await commit();
        return response.send(systemUpdateResult);
    } catch (error) {
        // A successful swap consumed the staged copy; on failure it is
        // removed before responding so the client never sees it.
        if (stagedWorkPath) {
            await fs.promises.rm(stagedWorkPath, { recursive: true, force: true })
                .catch(cleanupError => console.error('Failed to remove extension staging directory', stagedWorkPath, cleanupError));
        }
        if (error?.code === 'EXTENSION_CHANGED_DURING_UPDATE') {
            return response.status(409).send('The extension changed while it was updating. Retry the update.');
        }
        if (isExtensionUpdateConflictError(error)) {
            const reason = String(error?.message || 'Local changes or branch divergence detected.');
            return response.status(409).send(`Extension update conflict: ${reason} Reinstall or manually reset this extension, then retry.`);
        }
        console.error('Updating extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/branches', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to list branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to list branches of global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const configuredBackend = getConfiguredGitBackend();
        if (!shouldUseSystemGit(configuredBackend)) {
            const result = await listBranchesWithIsomorphic(extensionPath);
            return response.send(result);
        }

        try {
            const git = createExtensionGit(extensionPath);
            // Unshallow the repository if it is shallow
            const isShallow = await git.revparse(['--is-shallow-repository']) === 'true';
            if (isShallow) {
                console.info(`Unshallowing the repository at ${extensionPath}`);
                await git.fetch('origin', ['--unshallow']);
            }

            // Fetch all branches
            await git.remote(['set-branches', 'origin', '*']);
            await git.fetch('origin');
            const localBranches = await git.branchLocal();
            const remoteBranches = await git.branch(['-r', '--list', 'origin/*']);
            const result = [
                ...Object.values(localBranches.branches),
                ...Object.values(remoteBranches.branches),
            ].map(b => ({ current: b.current, commit: b.commit, name: b.name, label: b.label }));

            return response.send(result);
        } catch (error) {
            if (!canFallbackToBuiltinGit(configuredBackend, error)) {
                throw error;
            }
            const result = await listBranchesWithIsomorphic(extensionPath);
            return response.send(result);
        }
    } catch (error) {
        console.error('Getting branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/switch', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, branch, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized || typeof branch !== 'string' || !branch.trim() || branch.trim().startsWith('-')) {
            return response.status(400).send('Bad Request: A valid extensionName and branch are required in the request body.');
        }

        if (branch.startsWith('origin/') && branch.slice('origin/'.length).startsWith('-')) {
            return response.status(400).send('Bad Request: A valid branch name is required.');
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to switch branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to switch branches of global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const configuredBackend = getConfiguredGitBackend();
        const runIsomorphicSwitch = async () => {
            try {
                await switchBranchWithIsomorphic(extensionPath, branch);
                console.info(`Checked out branch ${branch} with isomorphic-git at ${extensionPath}`);
                return response.sendStatus(204);
            } catch (switchError) {
                if (String(switchError?.message || '').includes('does not exist locally')) {
                    return response.status(404).send(`Branch ${branch} does not exist locally`);
                }
                throw switchError;
            }
        };

        if (!shouldUseSystemGit(configuredBackend)) {
            return await runIsomorphicSwitch();
        }

        try {
            const git = createExtensionGit(extensionPath);
            const branches = await git.branchLocal();

            if (String(branch).startsWith('origin/')) {
                const localBranch = branch.replace('origin/', '');
                if (branches.all.includes(localBranch)) {
                    console.info(`Branch ${localBranch} already exists locally, checking it out`);
                    await git.checkout(localBranch);
                    return response.sendStatus(204);
                }

                console.info(`Branch ${localBranch} does not exist locally, creating it from ${branch}`);
                await git.checkoutBranch(localBranch, branch);
                return response.sendStatus(204);
            }

            if (!branches.all.includes(branch)) {
                console.error(`Branch ${branch} does not exist locally`);
                return response.status(404).send(`Branch ${branch} does not exist locally`);
            }

            // Check if the branch is already checked out
            const currentBranch = await git.branch();
            if (currentBranch.current === branch) {
                console.info(`Branch ${branch} is already checked out`);
                return response.sendStatus(204);
            }

            // Checkout the branch
            await git.checkout(branch);
            console.info(`Checked out branch ${branch} at ${extensionPath}`);

            return response.sendStatus(204);
        } catch (error) {
            if (!canFallbackToBuiltinGit(configuredBackend, error)) {
                throw error;
            }

            return await runIsomorphicSwitch();
        }
    } catch (error) {
        console.error('Switching branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/move', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, source, destination } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized || !source || !destination) {
            return response.status(400).send('Bad Request: A valid extensionName, source, and destination are required in the request body.');
        }

        if (!request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to move extensions.`);
            return response.status(403).send('Forbidden: No permission to move extensions.');
        }

        const sourceDirectory = source === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const destinationDirectory = destination === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const sourcePath = path.join(sourceDirectory, extensionNameSanitized);
        const destinationPath = path.join(destinationDirectory, extensionNameSanitized);

        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
            console.error(`Source directory does not exist at ${sourcePath}`);
            return response.status(404).send('Source directory does not exist.');
        }

        if (fs.existsSync(destinationPath)) {
            console.error(`Destination directory already exists at ${destinationPath}`);
            return response.status(409).send('Destination directory already exists.');
        }

        if (source === destination) {
            console.error('Source and destination directories are the same');
            return response.status(409).send('Source and destination directories are the same.');
        }

        fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
        fs.rmSync(sourcePath, { recursive: true, force: true });
        console.info(`Extension has been moved from ${sourcePath} to ${destinationPath}`);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Moving extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to get the current git commit hash and branch name for a given extension.
 * It checks whether the repository is up-to-date with the remote, and returns the status along with
 * the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/version', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const configuredBackend = getConfiguredGitBackend();
        if (!shouldUseSystemGit(configuredBackend)) {
            return response.send(await getVersionWithIsomorphic(extensionPath));
        }

        const git = createExtensionGit(extensionPath);
        try {
            const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                return response.send({ ...EMPTY_EXTENSION_VERSION });
            }
            const currentCommitHash = await git.revparse(['HEAD']);
            const currentBranch = await git.branch();
            const currentBranchName = currentBranch.current || '';
            const remotes = await git.getRemotes(true);
            const remoteUrl = remotes[0]?.refs?.fetch || '';
            console.debug(extensionName, currentBranchName, currentCommitHash);

            if (!currentBranchName || !remoteUrl) {
                return response.send({
                    currentBranchName,
                    currentCommitHash,
                    isUpToDate: true,
                    remoteUrl,
                    remoteCommitHash: '',
                });
            }

            try {
                const lsRemoteOutput = await git.listRemote(['origin', `refs/heads/${currentBranchName}`]);
                const remoteCommitHash = parseLsRemoteSha(lsRemoteOutput);
                return response.send({
                    currentBranchName,
                    currentCommitHash,
                    isUpToDate: !remoteCommitHash || remoteCommitHash === currentCommitHash,
                    remoteUrl,
                    remoteCommitHash,
                });
            } catch (remoteError) {
                if (isGitUnavailableError(remoteError)) {
                    throw remoteError;
                }
                console.error(`Failed to query remote refs for extension at ${extensionPath}`, remoteError);
                return response.send({
                    currentBranchName,
                    currentCommitHash,
                    isUpToDate: true,
                    remoteUrl,
                    remoteCommitHash: '',
                });
            }
        } catch (error) {
            if (canFallbackToBuiltinGit(configuredBackend, error)) {
                return response.send(await getVersionWithIsomorphic(extensionPath));
            }
            if (isGitUnavailableError(error)) {
                throw error;
            }

            // Directory is a bare repo or has no commits yet (unborn HEAD).
            return response.send({ ...EMPTY_EXTENSION_VERSION });
        }
    } catch (error) {
        console.error('Getting extension version failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to delete a git repository based on the extension name provided in the request body.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/delete', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            console.error(`User ${request.user.profile.handle} does not have permission to delete global extensions.`);
            return response.status(403).send('Forbidden: No permission to delete global extensions.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!fs.existsSync(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await fs.promises.rm(extensionPath, { recursive: true, force: true });
        if (fs.existsSync(extensionPath)) {
            return response.status(409).send(`Directory still exists at ${extensionPath}. It may be locked by another process.`);
        }
        console.info(`Extension has been deleted at ${extensionPath}`);

        return response.send(`Extension has been deleted at ${extensionPath}`);
    } catch (error) {
        console.error('Deleting extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * Discover the extension folders
 * If the folder is called third-party, search for subfolders instead
 */
router.get('/discover', function (request, response) {
    if (!fs.existsSync(path.join(request.user.directories.extensions))) {
        fs.mkdirSync(path.join(request.user.directories.extensions));
    }

    if (!fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
        fs.mkdirSync(PUBLIC_DIRECTORIES.globalExtensions, { recursive: true });
    }

    /**
     * A directory without a manifest.json is not a usable extension: typically a leftover
     * from a manual deletion (e.g. a locked .git directory on Windows). Listing it would
     * make the client report a ghost extension and request its manifest in vain on every load.
     * @param {string} parentDirectory Directory containing extension folders
     * @param {string} folder Extension folder name
     * @returns {boolean} Whether the folder contains a manifest
     */
    const hasManifest = (parentDirectory, folder) => {
        const manifestExists = fs.existsSync(path.join(parentDirectory, folder, 'manifest.json'));
        if (!manifestExists) {
            console.warn(color.yellow(`Extension folder "${path.join(parentDirectory, folder)}" has no manifest.json and was skipped. Remove the folder to get rid of this warning.`));
        }
        return manifestExists;
    };

    // Get all folders in system extensions folder, excluding third-party
    const builtInExtensions = fs
        .readdirSync(PUBLIC_DIRECTORIES.extensions)
        .filter(f => fs.statSync(path.join(PUBLIC_DIRECTORIES.extensions, f)).isDirectory())
        .filter(f => f !== 'third-party')
        .filter(f => hasManifest(PUBLIC_DIRECTORIES.extensions, f))
        .map(f => ({ type: 'system', name: f }));

    // Get all folders in local extensions folder
    const userExtensions = fs
        .readdirSync(path.join(request.user.directories.extensions))
        .filter(f => !isStagingEntryName(f))
        .filter(f => fs.statSync(path.join(request.user.directories.extensions, f)).isDirectory())
        .filter(f => hasManifest(request.user.directories.extensions, f))
        .map(f => ({ type: 'local', name: `third-party/${f}` }));

    // Get all folders in global extensions folder
    // In case of a conflict, the extension will be loaded from the user folder
    const globalExtensions = fs
        .readdirSync(PUBLIC_DIRECTORIES.globalExtensions)
        .filter(f => !isStagingEntryName(f))
        .filter(f => fs.statSync(path.join(PUBLIC_DIRECTORIES.globalExtensions, f)).isDirectory())
        .filter(f => hasManifest(PUBLIC_DIRECTORIES.globalExtensions, f))
        .map(f => ({ type: 'global', name: `third-party/${f}` }))
        .filter(f => !userExtensions.some(e => e.name === f.name));

    // Combine all extensions
    const allExtensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    console.debug('Extensions available for', request.user.profile.handle, allExtensions);

    return response.send(allExtensions);
});
