import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import writeFileAtomic from 'write-file-atomic';
import { failpoint } from './pipeline/failpoints.js';

/**
 * Staging for writes that are prepared slowly (network downloads, git
 * clones) and then moved into synced data in one short step. A staging
 * directory is a hidden sibling of its final target, so every rename stays
 * inside one directory and never crosses filesystems. Snapshot and
 * reconcile skip entries with this prefix, so staged data is never synced.
 */
export const STAGING_PREFIX = '.luker-staging-';

/**
 * Wall-clock start of this process. A staging entry older than this was
 * left by an earlier process that was killed before it finished; a newer
 * one may belong to a transfer still running in this process.
 */
const PROCESS_STARTED_AT_MS = performance.timeOrigin;
const SWAP_LOCKS = new Map();
const ACTIVE_SWAPS = new Set();
const SWAP_JOURNAL_PREFIX = `${STAGING_PREFIX}swap-`;

export async function recoverStagedSwaps(parentDir) {
    let entries;
    try { entries = await fs.promises.readdir(parentDir); } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    for (const name of entries) {
        if (!name.startsWith(SWAP_JOURNAL_PREFIX) || !name.endsWith('.json')) continue;
        const journal = path.join(parentDir, name);
        if (ACTIVE_SWAPS.has(journal)) continue;
        let raw;
        try {
            raw = await fs.promises.readFile(journal, 'utf8');
        } catch (error) {
            // A concurrent recovery may have consumed this journal between
            // the readdir above and this read.
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        const { target, parked } = JSON.parse(raw);
        if (typeof target !== 'string' || target !== path.basename(target) || target === '.' || target === '..'
            || typeof parked !== 'string' || parked !== path.basename(parked) || !parked.startsWith(`${STAGING_PREFIX}replaced-`)) {
            throw new Error(`Invalid staging recovery journal: ${journal}`);
        }
        const live = path.join(parentDir, target);
        const old = path.join(parentDir, parked);
        try {
            await fs.promises.lstat(live);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            try { await fs.promises.rename(old, live); } catch (restoreError) {
                if (restoreError.code !== 'ENOENT') throw restoreError;
            }
        }
        await fs.promises.rm(old, { recursive: true, force: true });
        try { await fs.promises.unlink(journal); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isStagingEntryName(name) {
    return typeof name === 'string' && name.startsWith(STAGING_PREFIX);
}

/** Exclusion migration for the former insert-only chat publisher's exact reserved filename. */
export function isChatPublicationArtifactPath(directories, relPath) {
    const parts = relPath.split('/');
    if (!/^\.chat-create-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(parts.at(-1))) return false;
    return [['chats', 2], ['groupChats', 1]].some(([key, depth]) => {
        if (typeof directories[key] !== 'string') return false;
        const prefix = path.relative(directories.root, directories[key]).split(path.sep).join('/');
        return relPath.startsWith(`${prefix}/`) && relPath.slice(prefix.length + 1).split('/').length === depth;
    });
}

/**
 * Remove staging entries of `parentDir` left by an earlier process.
 *
 * @param {string} parentDir
 * @returns {Promise<string[]>} removed entry names
 */
export async function sweepStaleStaging(parentDir) {
    await recoverStagedSwaps(parentDir);
    let entries;
    try {
        entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const removed = [];
    for (const entry of entries) {
        if (!isStagingEntryName(entry.name)) continue;
        // Parked live data is never disposable transfer staging, including
        // legacy copies without journals and active replacements.
        if (entry.name.startsWith(`${STAGING_PREFIX}replaced-`) || ACTIVE_SWAPS.has(path.join(parentDir, entry.name))) continue;
        const abs = path.join(parentDir, entry.name);
        let stat;
        try {
            stat = await fs.promises.lstat(abs);
        } catch (error) {
            // A concurrent operation may have consumed its staging entry
            // between the readdir above and this lstat.
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        if (stat.mtimeMs >= PROCESS_STARTED_AT_MS) continue;
        await fs.promises.rm(abs, { recursive: true, force: true });
        removed.push(entry.name);
    }
    return removed;
}

/**
 * Create a fresh staging directory next to `targetPath`, after sweeping
 * stale staging entries from the same parent.
 *
 * @param {string} targetPath the file or directory the staged data will become
 * @param {string} label
 * @returns {Promise<string>}
 */
export async function makeStagingPath(targetPath, label) {
    const parent = path.dirname(path.resolve(targetPath));
    await fs.promises.mkdir(parent, { recursive: true });
    await sweepStaleStaging(parent);
    const dir = path.join(parent, `${STAGING_PREFIX}${label}-${crypto.randomBytes(8).toString('hex')}`);
    await fs.promises.mkdir(dir);
    return dir;
}

/**
 * Put the prepared directory `source` (a staging sibling of `target`) at
 * `target`. An existing `target` is first renamed to a staging sibling and
 * removed afterwards, so the target path always holds a complete directory.
 *
 * @param {string} source
 * @param {string} target
 */
export async function swapDirectoryInto(source, target, { expectedFingerprint } = {}) {
    const key = path.resolve(target);
    const previous = SWAP_LOCKS.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
        if (expectedFingerprint !== undefined && await fingerprintDirectory(target) !== expectedFingerprint) {
            throw Object.assign(new Error('The extension directory changed during the update.'), { code: 'EXTENSION_CHANGED_DURING_UPDATE' });
        }
        await performSwap(source, target);
    });
    SWAP_LOCKS.set(key, work);
    try { await work; } finally { if (SWAP_LOCKS.get(key) === work) SWAP_LOCKS.delete(key); }
}

async function performSwap(source, target) {
    const parent = path.dirname(path.resolve(target));
    const parked = path.join(parent, `${STAGING_PREFIX}replaced-${crypto.randomBytes(8).toString('hex')}`);
    const journal = path.join(parent, `${SWAP_JOURNAL_PREFIX}${crypto.randomBytes(8).toString('hex')}.json`);
    ACTIVE_SWAPS.add(journal);
    let hadTarget = false;
    try {
        await writeFileAtomic(journal, JSON.stringify({ target: path.basename(target), parked: path.basename(parked) }), { mode: 0o600 });
        try {
            await fs.promises.rename(target, parked);
            hadTarget = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        failpoint('staging-after-park');
        try { await fs.promises.rename(source, target); } catch (error) {
            if (hadTarget) await fs.promises.rename(parked, target);
            throw error;
        }
        if (hadTarget) await fs.promises.rm(parked, { recursive: true, force: true });
        await fs.promises.unlink(journal);
    } finally {
        ACTIVE_SWAPS.delete(journal);
        // Recovery also cleans a rolled-back journal, but never discards the old copy.
        await recoverStagedSwaps(parent);
    }
}

/**
 * Content fingerprint used to detect that a directory changed between two
 * points in time. Nested `.git` and staging entries are skipped because
 * sync never writes them.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function fingerprintDirectory(dir) {
    const hash = crypto.createHash('sha1');
    const walk = async (abs, rel) => {
        const entries = (await fs.promises.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (entry.name === '.git' || isStagingEntryName(entry.name)) continue;
            const childAbs = path.join(abs, entry.name);
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                hash.update(`d\0${childRel}\n`);
                await walk(childAbs, childRel);
            } else if (entry.isSymbolicLink()) {
                hash.update(`l\0${childRel}\0${await fs.promises.readlink(childAbs)}\n`);
            } else {
                const stat = await fs.promises.stat(childAbs);
                hash.update(`f\0${childRel}\0${stat.size}\0${stat.mtimeMs}\n`);
            }
        }
    };
    try {
        await walk(dir, '');
    } catch (error) {
        if (error.code === 'ENOENT') return 'absent';
        throw error;
    }
    return hash.digest('hex');
}
