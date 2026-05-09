import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

import { sync as commandExistsSync } from 'command-exists';
import { CheckRepoActions, default as simpleGit } from 'simple-git';
import { serverDirectory } from './server-directory.js';

const MAX_LOG_ENTRIES = 1000;
const DEFAULT_LOG_LIMIT = 400;
const NPM_EXECUTABLE = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * @typedef {'idle'|'running'|'succeeded'|'failed'} GitUpdateStatus
 */

/**
 * @typedef {{ id: number; timestamp: number; level: 'info'|'warn'|'error'; message: string }} UpdateLogEntry
 */

const gitUpdateState = {
    runId: 0,
    running: false,
    status: /** @type {GitUpdateStatus} */ ('idle'),
    startedAt: null,
    finishedAt: null,
    updated: false,
    restartRecommended: false,
    lastError: null,
    /** @type {UpdateLogEntry[]} */
    logs: [],
    nextLogId: 1,
};

const require = createRequire(import.meta.url);
const packageJson = require(path.join(serverDirectory, 'package.json'));
const githubRepository = parseGitHubRepository(packageJson?.repository);

function parseGitHubRepository(repositoryField) {
    const raw = typeof repositoryField === 'string'
        ? repositoryField
        : String(repositoryField?.url || '').trim();
    if (!raw) {
        return null;
    }

    const normalized = raw.replace(/^git\+/, '').replace(/\.git$/i, '');
    const regexMatch = normalized.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
    if (regexMatch) {
        return { owner: regexMatch[1], repo: regexMatch[2] };
    }

    try {
        const url = new URL(normalized);
        if (!/github\.com$/i.test(url.hostname)) {
            return null;
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2) {
            return null;
        }
        return { owner: parts[0], repo: parts[1] };
    } catch {
        return null;
    }
}

function resetGitUpdateStateForRun() {
    gitUpdateState.runId += 1;
    gitUpdateState.running = true;
    gitUpdateState.status = 'running';
    gitUpdateState.startedAt = Date.now();
    gitUpdateState.finishedAt = null;
    gitUpdateState.updated = false;
    gitUpdateState.restartRecommended = false;
    gitUpdateState.lastError = null;
    gitUpdateState.logs = [];
    gitUpdateState.nextLogId = 1;
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 */
function appendGitUpdateLog(level, message) {
    const lines = String(message ?? '')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trimEnd());

    for (const line of lines) {
        if (!line) {
            continue;
        }
        gitUpdateState.logs.push({
            id: gitUpdateState.nextLogId++,
            timestamp: Date.now(),
            level,
            message: line,
        });
    }

    if (gitUpdateState.logs.length > MAX_LOG_ENTRIES) {
        gitUpdateState.logs.splice(0, gitUpdateState.logs.length - MAX_LOG_ENTRIES);
    }
}

/**
 * @param {number | undefined} sinceId
 * @param {number | undefined} limit
 * @returns {UpdateLogEntry[]}
 */
function sliceGitUpdateLogs(sinceId, limit) {
    const normalizedSinceId = Number.isFinite(Number(sinceId)) ? Math.max(0, Math.floor(Number(sinceId))) : 0;
    const normalizedLimit = Number.isFinite(Number(limit))
        ? Math.min(MAX_LOG_ENTRIES, Math.max(1, Math.floor(Number(limit))))
        : DEFAULT_LOG_LIMIT;

    let logs = gitUpdateState.logs;
    if (normalizedSinceId > 0) {
        logs = logs.filter(entry => entry.id > normalizedSinceId);
    }

    if (logs.length > normalizedLimit) {
        logs = logs.slice(logs.length - normalizedLimit);
    }

    return logs.map(entry => ({ ...entry }));
}

/**
 * @param {Error} error
 */
function finishGitUpdateWithError(error) {
    gitUpdateState.running = false;
    gitUpdateState.status = 'failed';
    gitUpdateState.finishedAt = Date.now();
    gitUpdateState.lastError = String(error?.message || error || 'Unknown update error');
    appendGitUpdateLog('error', gitUpdateState.lastError);
}

/**
 * @param {{ updated: boolean; restartRecommended: boolean }} result
 */
function finishGitUpdateWithSuccess(result) {
    gitUpdateState.running = false;
    gitUpdateState.status = 'succeeded';
    gitUpdateState.finishedAt = Date.now();
    gitUpdateState.updated = !!result.updated;
    gitUpdateState.restartRecommended = !!result.restartRecommended;
    gitUpdateState.lastError = null;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runCommandWithLogs(command, args) {
    return new Promise((resolve, reject) => {
        const processHandle = spawn(command, args, {
            cwd: serverDirectory,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        processHandle.stdout?.on('data', data => {
            appendGitUpdateLog('info', String(data));
        });
        processHandle.stderr?.on('data', data => {
            appendGitUpdateLog('warn', String(data));
        });

        processHandle.on('error', error => reject(error));
        processHandle.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} exited with code ${code}`));
        });
    });
}

/**
 * @param {number} runId
 */
async function runGitUpdateFlow(runId) {
    try {
        if (!commandExistsSync('git')) {
            throw new Error('Git is not installed on this server.');
        }

        const repo = simpleGit({ baseDir: serverDirectory });
        const isRepoRoot = await repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (!isRepoRoot) {
            throw new Error('Current deployment is not a git repository.');
        }

        const branch = (await repo.revparse(['--abbrev-ref', 'HEAD'])).trim();
        appendGitUpdateLog('info', `Branch: ${branch}`);

        let status = await repo.status();

        // A previous interrupted rebase/merge leaves the index with unmerged
        // paths. `git stash` (and therefore `git pull --autostash`) refuses to
        // operate while unmerged paths exist, so clear that state first.
        if (status.conflicted.length > 0) {
            appendGitUpdateLog('warn', `Detected ${status.conflicted.length} unmerged file(s) from a previous interrupted operation; clearing before continuing.`);

            let cleared = false;
            try {
                await repo.raw(['rebase', '--abort']);
                appendGitUpdateLog('info', 'Aborted in-progress rebase.');
                cleared = true;
            } catch {
                /* no rebase in progress */
            }
            if (!cleared) {
                try {
                    await repo.raw(['merge', '--abort']);
                    appendGitUpdateLog('info', 'Aborted in-progress merge.');
                    cleared = true;
                } catch {
                    /* no merge in progress */
                }
            }
            if (!cleared) {
                try {
                    await repo.raw(['reset', 'HEAD', '--', ...status.conflicted]);
                    appendGitUpdateLog('info', 'Cleared conflicted index entries.');
                } catch (resetErr) {
                    appendGitUpdateLog('warn', `Could not clear conflicted entries: ${resetErr?.message || resetErr}`);
                }
            }

            status = await repo.status();
            if (status.conflicted.length > 0) {
                throw new Error(`Could not clear ${status.conflicted.length} unmerged file(s); please resolve them manually before retrying the update.`);
            }
        }

        const hasLocalChanges = status.files.length > 0;
        if (hasLocalChanges) {
            appendGitUpdateLog('warn', `Working tree has ${status.files.length} local change(s); will auto-stash during update.`);
            const preview = status.files.slice(0, 20);
            for (const file of preview) {
                const flags = `${file.index || ' '}${file.working_dir || ' '}`;
                appendGitUpdateLog('warn', `  [${flags}] ${file.path}`);
            }
            if (status.files.length > preview.length) {
                appendGitUpdateLog('warn', `  ... and ${status.files.length - preview.length} more file(s)`);
            }
        }

        let trackingBranch = '';
        try {
            trackingBranch = (await repo.revparse(['--abbrev-ref', '@{u}'])).trim();
        } catch {
            throw new Error(`Branch '${branch}' has no upstream tracking branch.`);
        }
        appendGitUpdateLog('info', `Upstream: ${trackingBranch}`);

        const previousHead = (await repo.revparse(['HEAD'])).trim();
        appendGitUpdateLog('info', `Current commit: ${previousHead.slice(0, 12)}`);

        appendGitUpdateLog('info', 'Fetching remote updates...');
        await repo.fetch(['--tags', '--prune']);

        const divergenceRaw = (await repo.raw(['rev-list', '--left-right', '--count', `HEAD...${trackingBranch}`])).trim();
        const divergenceMatch = divergenceRaw.match(/(\d+)\s+(\d+)/);
        const aheadCount = Number(divergenceMatch?.[1] ?? 0);
        const behindCount = Number(divergenceMatch?.[2] ?? 0);
        appendGitUpdateLog('info', `Ahead: ${aheadCount}, behind: ${behindCount}`);

        if (behindCount === 0) {
            appendGitUpdateLog('info', 'Repository is already up to date.');
            finishGitUpdateWithSuccess({ updated: false, restartRecommended: false });
            return;
        }

        appendGitUpdateLog('info', 'Pulling latest commits...');
        const pullArgs = hasLocalChanges
            ? ['--rebase', '--autostash', '--tags']
            : ['--ff-only', '--tags'];
        await repo.pull(pullArgs);

        const currentHead = (await repo.revparse(['HEAD'])).trim();
        const updated = previousHead !== currentHead;
        appendGitUpdateLog('info', `Updated commit: ${currentHead.slice(0, 12)}`);

        const changedFiles = updated
            ? (await repo.diff(['--name-only', `${previousHead}..${currentHead}`]))
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
            : [];
        const requiresDependencyInstall = changedFiles.some(file => file === 'package.json' || file === 'package-lock.json');

        if (requiresDependencyInstall) {
            appendGitUpdateLog('info', 'Dependency manifest changed. Running npm install...');
            await runCommandWithLogs(NPM_EXECUTABLE, ['install', '--no-audit', '--no-fund', '--omit=dev']);
        }

        if (runId !== gitUpdateState.runId) {
            return;
        }

        finishGitUpdateWithSuccess({
            updated,
            restartRecommended: updated,
        });
        appendGitUpdateLog('info', updated ? 'Update completed successfully.' : 'No update was applied.');
    } catch (error) {
        if (runId !== gitUpdateState.runId) {
            return;
        }
        finishGitUpdateWithError(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * @param {{ sinceId?: number; limit?: number }} [options]
 */
export function getGitUpdateStatus(options = {}) {
    const logs = sliceGitUpdateLogs(options.sinceId, options.limit);
    return {
        runId: gitUpdateState.runId,
        running: gitUpdateState.running,
        status: gitUpdateState.status,
        startedAt: gitUpdateState.startedAt,
        finishedAt: gitUpdateState.finishedAt,
        updated: gitUpdateState.updated,
        restartRecommended: gitUpdateState.restartRecommended,
        lastError: gitUpdateState.lastError,
        logs,
        latestLogId: gitUpdateState.logs.length > 0 ? gitUpdateState.logs[gitUpdateState.logs.length - 1].id : 0,
    };
}

export function startGitUpdate() {
    if (gitUpdateState.running) {
        return {
            started: false,
            reason: 'already_running',
            runId: gitUpdateState.runId,
        };
    }

    resetGitUpdateStateForRun();
    appendGitUpdateLog('info', 'Git update requested.');

    const runId = gitUpdateState.runId;
    void runGitUpdateFlow(runId);

    return {
        started: true,
        runId,
    };
}

export async function fetchLatestApkReleaseInfo() {
    if (!githubRepository) {
        throw new Error('GitHub repository metadata is unavailable.');
    }

    const { owner, repo } = githubRepository;
    const releaseApiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const response = await fetch(releaseApiUrl, {
        method: 'GET',
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Luker-Updater',
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to query latest GitHub release (${response.status}).`);
    }

    const payload = await response.json();
    const assets = Array.isArray(payload?.assets) ? payload.assets : [];
    const apkAsset = assets.find(asset =>
        typeof asset?.name === 'string'
        && typeof asset?.browser_download_url === 'string'
        && asset.name.toLowerCase().endsWith('.apk'));

    if (!apkAsset) {
        throw new Error('Latest release does not contain an APK asset.');
    }

    return {
        tagName: String(payload.tag_name || ''),
        name: String(payload.name || ''),
        htmlUrl: String(payload.html_url || ''),
        publishedAt: payload.published_at || null,
        apk: {
            name: String(apkAsset.name || ''),
            url: String(apkAsset.browser_download_url || ''),
            size: Number(apkAsset.size) || 0,
        },
    };
}
