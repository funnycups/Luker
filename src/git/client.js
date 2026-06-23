import fs from 'node:fs';
import path from 'node:path';

import { sync as commandExistsSync } from 'command-exists';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import simpleGit from 'simple-git';

/** @type {{ AUTO: 'auto', SYSTEM: 'system', BUILTIN: 'builtin' }} */
export const GIT_BACKENDS = {
    AUTO: 'auto',
    SYSTEM: 'system',
    BUILTIN: 'builtin',
};

/**
 * @param {string | undefined | null} preferredBackend
 * @returns {'system' | 'builtin'}
 */
function resolveBackend(preferredBackend) {
    const normalized = typeof preferredBackend === 'string' ? preferredBackend.trim().toLowerCase() : GIT_BACKENDS.AUTO;
    const backend = normalized === GIT_BACKENDS.SYSTEM
        ? GIT_BACKENDS.SYSTEM
        : normalized === GIT_BACKENDS.BUILTIN
            ? GIT_BACKENDS.BUILTIN
            : GIT_BACKENDS.AUTO;
    const systemGitAvailable = commandExistsSync('git');

    if (backend === GIT_BACKENDS.SYSTEM && !systemGitAvailable) {
        throw new Error('System git backend is configured, but no git binary was found in PATH.');
    }

    if (backend === GIT_BACKENDS.SYSTEM || (backend === GIT_BACKENDS.AUTO && systemGitAvailable)) {
        return GIT_BACKENDS.SYSTEM;
    }

    return GIT_BACKENDS.BUILTIN;
}

/**
 * @typedef {object} GitCloneOptions
 * @property {number} [depth]
 * @property {string} [branch]
 */

const SUPPORTED_CLONE_OPTIONS = new Set(['depth', 'branch']);

/**
 * @param {GitCloneOptions} [options]
 * @returns {{ depth?: number, branch?: string }}
 */
function normalizeCloneOptions(options = {}) {
    for (const key of Object.keys(options)) {
        if (!SUPPORTED_CLONE_OPTIONS.has(key)) {
            throw new Error(`Unsupported clone option: ${key}`);
        }
    }
    return { depth: options.depth, branch: options.branch };
}

/**
 * @typedef {object} GitCommitInfo
 * @property {string} hash - Short hash (7 chars)
 * @property {string} fullHash - Full hash
 * @property {string} message - Commit message
 * @property {string} date - ISO date string
 */

/**
 * @typedef {object} GitClient
 * @property {'system' | 'builtin'} backend
 * @property {(url: string, localPath: string, options?: GitCloneOptions) => Promise<void>} clone
 * @property {(dir: string) => Promise<void>} init
 * @property {(dir: string, key: string, value: string) => Promise<void>} setConfig
 * @property {(dir: string) => Promise<void>} addAll
 * @property {(dir: string, message: string, author?: {name: string, email: string}) => Promise<boolean>} commitIfChanged
 * @property {(dir: string, maxCount?: number) => Promise<GitCommitInfo[]>} log
 * @property {(dir: string, hash: string) => Promise<void>} resetHard
 * @property {(dir: string, hash: string) => Promise<string>} diff
 */

const DEFAULT_AUTHOR = { name: 'CardApp Studio', email: 'studio@luker.local' };

/**
 * Recursively enumerate every regular file inside a working directory, skipping
 * the `.git` directory. Returns POSIX-style paths relative to `dir`, matching
 * how isomorphic-git addresses filepaths.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listWorkdirFiles(dir) {
    const out = [];
    async function walk(absDir, relPrefix) {
        const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.git') continue;
            const absChild = path.join(absDir, entry.name);
            const relChild = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(absChild, relChild);
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                out.push(relChild);
            }
        }
    }
    await walk(dir, '');
    return out;
}

/**
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function resolveHeadOidOrNull(dir) {
    try {
        return await git.resolveRef({ fs, dir, ref: 'HEAD' });
    } catch {
        return null;
    }
}

/**
 * @param {{ backend?: string }} [options]
 * @returns {GitClient}
 */
export function createGitClient(options = {}) {
    const backend = resolveBackend(options.backend);
    if (backend === GIT_BACKENDS.SYSTEM) {
        return new SimpleGitClient();
    }

    return new IsomorphicGitClient();
}

/**
 * @implements {GitClient}
 */
class SimpleGitClient {
    constructor() {
        this.backend = GIT_BACKENDS.SYSTEM;
        this.git = simpleGit();
    }

    /**
     * @param {string} url
     * @param {string} localPath
     * @param {GitCloneOptions} [options]
     * @returns {Promise<void>}
     */
    async clone(url, localPath, options = {}) {
        const { depth, branch } = normalizeCloneOptions(options);
        /** @type {Record<string, any>} */
        const cloneOptions = {};

        if (depth !== undefined) {
            cloneOptions['--depth'] = depth;
        }

        if (branch) {
            cloneOptions['--branch'] = branch;
        }

        await this.git.clone(url, localPath, cloneOptions);
    }

    /** @param {string} dir */
    async init(dir) {
        await simpleGit({ baseDir: dir }).init();
    }

    /** @param {string} dir @param {string} key @param {string} value */
    async setConfig(dir, key, value) {
        await simpleGit({ baseDir: dir }).addConfig(key, value);
    }

    /** @param {string} dir */
    async addAll(dir) {
        await simpleGit({ baseDir: dir }).add('-A');
    }

    /**
     * Stage all changes and commit if there are any.
     * @param {string} dir
     * @param {string} message
     * @returns {Promise<boolean>} Whether a commit was made
     */
    async commitIfChanged(dir, message) {
        const sg = simpleGit({ baseDir: dir });
        await sg.add('-A');
        const status = await sg.status();
        if (status.files.length === 0) return false;
        await sg.commit(message);
        return true;
    }

    /**
     * @param {string} dir
     * @param {number} [maxCount=50]
     * @returns {Promise<GitCommitInfo[]>}
     */
    async log(dir, maxCount = 50) {
        const sg = simpleGit({ baseDir: dir });
        const log = await sg.log({ maxCount });
        return log.all.map(entry => ({
            hash: entry.hash.substring(0, 7),
            fullHash: entry.hash,
            message: entry.message,
            date: entry.date,
        }));
    }

    /** @param {string} dir @param {string} hash */
    async resetHard(dir, hash) {
        await simpleGit({ baseDir: dir }).reset(['--hard', hash]);
    }

    /**
     * @param {string} dir
     * @param {string} hash
     * @returns {Promise<string>}
     */
    async diff(dir, hash) {
        const sg = simpleGit({ baseDir: dir });
        return await sg.diff([`${hash}~1`, hash]).catch(() => sg.diff([hash]));
    }
}

/**
 * @implements {GitClient}
 */
class IsomorphicGitClient {
    constructor() {
        this.backend = GIT_BACKENDS.BUILTIN;
    }

    /**
     * @param {string} url
     * @param {string} localPath
     * @param {GitCloneOptions} [options]
     * @returns {Promise<void>}
     */
    async clone(url, localPath, options = {}) {
        const { depth, branch } = normalizeCloneOptions(options);

        await git.clone({
            fs,
            http,
            dir: localPath,
            url,
            depth,
            ref: branch,
            singleBranch: depth !== undefined || Boolean(branch),
        });
    }

    /** @param {string} dir */
    async init(dir) {
        await git.init({ fs, dir });
    }

    /** @param {string} dir @param {string} key @param {string} value */
    async setConfig(dir, key, value) {
        await git.setConfig({ fs, dir, path: key, value });
    }

    /** @param {string} dir */
    async addAll(dir) {
        // git.statusMatrix follows the "racy git" optimization and may report a
        // file as unchanged when its size and second-precision mtime match the
        // index entry, even if the contents differ. Walk the workdir ourselves
        // and stage everything we find through git.add, then sweep the index for
        // entries whose backing file no longer exists.
        const tracked = new Set();
        for (const filepath of await listWorkdirFiles(dir)) {
            await git.add({ fs, dir, filepath });
            tracked.add(filepath);
        }
        for (const filepath of await git.listFiles({ fs, dir })) {
            if (!tracked.has(filepath)) {
                await git.remove({ fs, dir, filepath });
            }
        }
    }

    /**
     * @param {string} dir
     * @param {string} message
     * @param {{ name: string, email: string }} [author]
     * @returns {Promise<boolean>}
     */
    async commitIfChanged(dir, message, author = DEFAULT_AUTHOR) {
        await this.addAll(dir);

        // statusMatrix is unreliable for change detection (see addAll above) so
        // we go directly to the source of truth — the git object database. Make
        // a real commit, then compare its tree against HEAD's prior tree. If
        // they match the index produced no semantic change; roll the branch
        // pointer back to the previous commit and leave the orphan object for
        // git gc to reclaim.
        const previousHeadOid = await resolveHeadOidOrNull(dir);
        const previousTreeOid = previousHeadOid
            ? (await git.readCommit({ fs, dir, oid: previousHeadOid })).commit.tree
            : null;

        const newOid = await git.commit({ fs, dir, message, author });
        const newCommit = await git.readCommit({ fs, dir, oid: newOid });
        if (previousTreeOid !== null && newCommit.commit.tree === previousTreeOid) {
            const branch = await git.currentBranch({ fs, dir, fullname: true });
            if (branch && previousHeadOid) {
                await git.writeRef({ fs, dir, ref: branch, value: previousHeadOid, force: true });
            }
            return false;
        }

        return true;
    }

    /**
     * @param {string} dir
     * @param {number} [maxCount=50]
     * @returns {Promise<GitCommitInfo[]>}
     */
    async log(dir, maxCount = 50) {
        const commits = await git.log({ fs, dir, depth: maxCount });
        return commits.map(entry => ({
            hash: entry.oid.substring(0, 7),
            fullHash: entry.oid,
            message: entry.commit.message.trim(),
            date: new Date(entry.commit.author.timestamp * 1000).toISOString(),
        }));
    }

    /** @param {string} dir @param {string} hash */
    async resetHard(dir, hash) {
        await git.checkout({ fs, dir, ref: hash, force: true });
        await git.writeRef({ fs, dir, ref: 'refs/heads/master', value: hash, force: true });
    }

    /**
     * @param {string} dir
     * @param {string} hash
     * @returns {Promise<string>}
     */
    async diff(dir, hash) {
        try {
            const commit = await git.readCommit({ fs, dir, oid: hash });
            const parentOid = commit.commit.parent[0];
            if (!parentOid) return '(initial commit)';
            const currentFiles = await git.listFiles({ fs, dir, ref: hash });
            const parentFiles = await git.listFiles({ fs, dir, ref: parentOid });
            const allFiles = new Set([...currentFiles, ...parentFiles]);
            const changes = [];
            for (const filepath of allFiles) {
                const curBlob = currentFiles.includes(filepath)
                    ? await git.readBlob({ fs, dir, oid: hash, filepath }).catch(() => null)
                    : null;
                const parBlob = parentFiles.includes(filepath)
                    ? await git.readBlob({ fs, dir, oid: parentOid, filepath }).catch(() => null)
                    : null;
                const curContent = curBlob ? new TextDecoder().decode(curBlob.blob) : '';
                const parContent = parBlob ? new TextDecoder().decode(parBlob.blob) : '';
                if (curContent !== parContent) {
                    if (!parBlob) changes.push(`+++ new file: ${filepath}`);
                    else if (!curBlob) changes.push(`--- deleted: ${filepath}`);
                    else changes.push(`~~~ modified: ${filepath}`);
                }
            }
            return changes.join('\n') || '(no changes)';
        } catch {
            return '(diff unavailable)';
        }
    }
}
