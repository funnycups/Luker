import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import writeFileAtomic from 'write-file-atomic';

import { SYNC_CATEGORIES, resolveCategoryPaths } from '../categories.js';
import {
    isSqlBackedCategory,
    describeSqlRecordPath,
    readSqlRecordValue,
    listSqlSubRecordNamespaces,
    parseSqlRecordBlob,
    writeSqlRecordValue,
} from '../materialize.js';
import { withReadOnlyBypass } from '../../storage/read-only-mode.js';
import { readCommitEntries, isRejectedPath, readBlobBytes, blobOidOf, resolveTreePathUnder, SYNC_METADATA_DIR } from './git-tree.js';
import { failpoint, FAILPOINTS, throwpoint, THROWPOINTS } from './failpoints.js';
import { isChatPublicationArtifactPath, isStagingEntryName } from '../staging.js';
import { assertConfinedPath } from '../../storage/path-confinement.js';
import { assertDistinctFsDestinations } from './path-identity.js';
import { buildPresetIdentityViews, decodePresetRecordPath } from '../preset-projection.js';
import { readPresetInventory, readPresetEntry } from '../../storage/preset-inventory.js';
import { encodePresetRecordRelativePath, presetRecordIdentity } from '../../storage/preset-paths.js';

/**
 * @typedef {{ written: string[], deleted: string[], alreadyApplied: string[], skipped: string[], ignored: string[] }} ReconcileReport
 */

/** @returns {ReconcileReport} */
export function emptyReconcileReport() {
    return { written: [], deleted: [], alreadyApplied: [], skipped: [], ignored: [] };
}

const SUB_RECORD_KINDS = new Set(['preset-state', 'chat-state']);

function toPosix(p) {
    return p.split(path.sep).join('/');
}

function enabledTargets(directories, categories) {
    const enabled = new Set(categories || []);
    const targets = [];
    for (const category of SYNC_CATEGORIES) {
        if (!enabled.has(category.id)) continue;
        for (const resolved of resolveCategoryPaths(category, directories)) {
            targets.push({
                categoryId: category.id,
                kind: resolved.kind,
                rel: toPosix(path.relative(directories.root, resolved.absolutePath)),
                absolutePath: resolved.absolutePath,
            });
        }
    }
    return targets;
}

function owningTarget(targets, relPath) {
    return targets.find(t => (t.kind === 'file' ? relPath === t.rel : relPath.startsWith(`${t.rel}/`))) ?? null;
}

function isExcludedPath(directories, relPath) {
    const segments = relPath.split('/');
    return segments[0] === SYNC_METADATA_DIR || segments.includes('.git') || segments.some(isStagingEntryName) || isChatPublicationArtifactPath(directories, relPath);
}

/**
 * Bring live data from commit `base` to commit `target`, one path at a
 * time, touching only paths whose live state still equals `base`. A live
 * path that already equals `target` counts as applied, which makes a
 * re-run over the same pair (crash recovery) converge. The caller holds
 * the user's write gate.
 *
 * @param {{
 *   gitdir: string,
 *   directories: import('../../users.js').UserDirectoryList,
 *   handle: string,
 *   categories: string[],
 *   engine: { kind: string, withTransaction: Function },
 *   base: string | null,
 *   target: string,
 * }} args
 * @returns {Promise<ReconcileReport>}
 */
export async function reconcileLiveCas({ gitdir, directories, handle, categories, engine, base, target }) {
    const sides = await Promise.all([
        readCommitEntries({ gitdir, commitOid: base }),
        readCommitEntries({ gitdir, commitOid: target }),
    ]);
    const [baseSide, targetSide] = buildPresetIdentityViews({ directories, sides });
    const targets = enabledTargets(directories, categories);
    const report = emptyReconcileReport();
    const fsChanges = [];
    const sqlChanges = [];
    const presetInventories = new Map();
    const presetInventory = record => {
        if (!presetInventories.has(record.dirKey)) presetInventories.set(record.dirKey, readPresetInventory({ folder: directories[record.dirKey], dirKey: record.dirKey, boundary: directories.root }));
        return presetInventories.get(record.dirKey);
    };
    for (const [label, side] of [['base', baseSide], ['target', targetSide]]) {
        const destinations = [];
        const inventories = new Set();
        for (const relPath of side.files.keys()) {
            const owner = owningTarget(targets, relPath);
            if (!owner || isExcludedPath(directories, relPath) || isRejectedPath(baseSide.rejected, relPath) || isRejectedPath(targetSide.rejected, relPath) || (engine.kind !== 'fs' && isSqlBackedCategory(owner.categoryId))) continue;
            const record = decodePresetRecordPath(directories, relPath);
            const inventory = record ? presetInventory(record) : null;
            if (inventory) inventories.add(inventory);
            const entry = inventory?.entries.get(presetRecordIdentity(record));
            const absolutePath = record ? entry?.absolutePath ?? path.join(directories[record.dirKey], ...encodePresetRecordRelativePath(record).split('/')) : resolveTreePathUnder(directories.root, relPath);
            try { assertConfinedPath({ boundary: directories.root, absolutePath }); } catch (error) {
                if (error.code === 'SYNC_UNSAFE_LIVE_PATH') continue;
                throw error;
            }
            destinations.push({ treePath: relPath, absolutePath, logicalIdentity: record ? presetRecordIdentity(record) : relPath, kind: 'file' });
        }
        for (const inventory of inventories) for (const entry of inventory.entries.values()) destinations.push({ treePath: entry.relativePath, absolutePath: entry.absolutePath, logicalIdentity: presetRecordIdentity(entry.record), kind: 'file' });
        try {
            await assertDistinctFsDestinations({ boundary: directories.root, destinations, operation: `reconcile ${label}` });
        } catch (error) {
            if (error.code !== 'SYNC_FS_PATH_OBSTRUCTED') throw error;
            if (report.skipped.length === 0) report.skipped.push(...destinations.map(entry => entry.treePath));
        }
    }
    if (report.skipped.length > 0) return report;
    const allPaths = new Set([
        ...baseSide.files.keys(), ...baseSide.rejected.keys(),
        ...targetSide.files.keys(), ...targetSide.rejected.keys(),
    ]);
    for (const relPath of allPaths) {
        const baseRejected = baseSide.rejected.has(relPath);
        const targetRejected = targetSide.rejected.has(relPath);
        const baseEntry = baseRejected ? baseSide.rejected.get(relPath) : baseSide.files.get(relPath);
        const targetEntry = targetRejected ? targetSide.rejected.get(relPath) : targetSide.files.get(relPath);
        const unchanged = baseEntry?.oid === targetEntry?.oid && baseRejected === targetRejected && (!baseRejected || baseEntry.mode === targetEntry.mode);
        if (unchanged || isExcludedPath(directories, relPath)) continue;
        const owner = owningTarget(targets, relPath);
        if (!owner) continue;
        // A rejected entry on either side, at this path or above it, is
        // never written and never read as a deletion.
        if (isRejectedPath(baseSide.rejected, relPath) || isRejectedPath(targetSide.rejected, relPath)) {
            report.ignored.push(relPath);
            continue;
        }
        const change = { relPath, baseOid: baseEntry?.oid ?? null, targetOid: targetEntry?.oid ?? null, owner };
        if ((engine.kind !== 'fs' && isSqlBackedCategory(owner.categoryId)) || decodePresetRecordPath(directories, relPath)) sqlChanges.push(change);
        else fsChanges.push(change);
    }

    let applied = false;
    const markApplied = () => {
        if (applied) return;
        applied = true;
        failpoint(FAILPOINTS.RECONCILE_AFTER_FIRST_WRITE);
    };
    const ordered = [...fsChanges.filter(c => c.targetOid === null), ...fsChanges.filter(c => c.targetOid !== null)];
    for (const change of ordered) {
        await applyFsChange({ change, gitdir, directories, report, markApplied });
    }
    if (sqlChanges.length > 0) {
        await applySqlChanges({ changes: sqlChanges, gitdir, directories, handle, engine, report, markApplied, presetInventories });
    }
    return report;
}

async function inspectLivePath(absPath) {
    let stat;
    try {
        stat = await fs.promises.lstat(absPath);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'absent', oid: null };
        throw error;
    }
    if (!stat.isFile()) return { state: 'other', oid: null };
    return { state: 'file', oid: blobOidOf(await fs.promises.readFile(absPath)) };
}

async function pruneEmptyParents(dir, stopAt) {
    const stop = path.resolve(stopAt);
    let current = path.resolve(dir);
    while (current !== stop && current.startsWith(stop + path.sep)) {
        let entries;
        try {
            entries = await fs.promises.readdir(current);
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        if (entries.length > 0) return;
        try {
            await fs.promises.rmdir(current);
        } catch (error) {
            // Something was created in it, or it was removed, since readdir.
            if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST' || error.code === 'ENOENT') return;
            throw error;
        }
        current = path.dirname(current);
    }
}

async function applyFsChange({ change, gitdir, directories, report, markApplied }) {
    const { relPath, baseOid, targetOid, owner } = change;
    let absPath;
    try {
        absPath = resolveTreePathUnder(directories.root, relPath);
    } catch {
        report.ignored.push(relPath);
        return;
    }
    try {
        assertConfinedPath({ boundary: directories.root, absolutePath: absPath });
    } catch (error) {
        if (error.code !== 'SYNC_UNSAFE_LIVE_PATH') throw error;
        report.skipped.push(relPath);
        return;
    }
    const bytes = targetOid === null ? null : await readBlobBytes({ gitdir, oid: targetOid });
    const live = await inspectLivePath(absPath);
    if (live.state === 'other') {
        report.skipped.push(relPath);
        return;
    }
    if (live.oid === targetOid) {
        report.alreadyApplied.push(relPath);
        return;
    }
    if (live.oid !== baseOid) {
        report.skipped.push(relPath);
        return;
    }
    throwpoint(THROWPOINTS.RECONCILE_WRITE, relPath);
    if (targetOid === null) {
        await fs.promises.unlink(absPath);
        if (owner.kind === 'directory') await pruneEmptyParents(path.dirname(absPath), owner.absolutePath);
        report.deleted.push(relPath);
        markApplied();
        return;
    }
    try {
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await writeFileAtomic(absPath, bytes);
    } catch (error) {
        // A live file now sits where the target needs a parent directory.
        if (error.code === 'EEXIST' || error.code === 'ENOTDIR' || error.code === 'EISDIR') {
            report.skipped.push(relPath);
            return;
        }
        throw error;
    }
    report.written.push(relPath);
    markApplied();
}

function compareSqlApplyOrder(a, b) {
    const isWrite = p => (p.targetValue === null ? 0 : 1);
    const depth = p => (SUB_RECORD_KINDS.has(p.record.kind) ? 1 : 0);
    if (isWrite(a) !== isWrite(b)) return isWrite(a) - isWrite(b);
    return isWrite(a) === 0 ? depth(b) - depth(a) : depth(a) - depth(b);
}

async function applySqlChanges({ changes, gitdir, directories, handle, engine, report, markApplied, presetInventories }) {
    const planned = [];
    for (const change of changes) {
        const record = describeSqlRecordPath(directories, change.relPath);
        if (!record) {
            report.skipped.push(change.relPath);
            continue;
        }
        const baseValue = change.baseOid ? parseSqlRecordBlob(record, await readBlobBytes({ gitdir, oid: change.baseOid })) : null;
        const targetValue = change.targetOid ? parseSqlRecordBlob(record, await readBlobBytes({ gitdir, oid: change.targetOid })) : null;
        if (targetValue === undefined) {
            report.skipped.push(change.relPath);
            continue;
        }
        planned.push({ relPath: change.relPath, record, baseValue, targetValue, targetOid: change.targetOid });
    }
    planned.sort(compareSqlApplyOrder);

    const outcome = await withReadOnlyBypass(() => engine.withTransaction(handle, async (tx) => {
        // Rebuilt on every attempt: the engine may retry this callback.
        const local = emptyReconcileReport();
        for (const p of planned) {
            let current;
            let physical;
            let bytes;
            if (engine.kind === 'fs') {
                const inventory = presetInventories.get(p.record.dirKey) ?? readPresetInventory({ folder: directories[p.record.dirKey], dirKey: p.record.dirKey, boundary: directories.root });
                const entry = inventory.entries.get(presetRecordIdentity(p.record));
                physical = entry?.absolutePath ?? path.join(directories[p.record.dirKey], ...encodePresetRecordRelativePath(p.record).split('/'));
                const selected = entry ? readPresetEntry(entry) : null;
                current = selected?.doc ?? null;
                bytes = selected?.bytes ?? null;
            } else current = await readSqlRecordValue(tx, handle, p.record);
            const sameTarget = isDeepStrictEqual(current, p.targetValue);
            if (sameTarget && (engine.kind !== 'fs' || (bytes === null ? p.targetOid === null : blobOidOf(bytes) === p.targetOid))) {
                local.alreadyApplied.push(p.relPath);
                continue;
            }
            // An unparseable base blob has no value live data could match.
            if (p.baseValue === undefined) {
                local.skipped.push(p.relPath);
                continue;
            }
            if (!sameTarget && !isDeepStrictEqual(current, p.baseValue)) {
                local.skipped.push(p.relPath);
                continue;
            }
            // Deleting a parent cascades to its state sub-records. Those the
            // plan deletes are already gone; any left were never checked.
            if (p.targetValue === null && (await listSqlSubRecordNamespaces(tx, handle, p.record)).length > 0) {
                local.skipped.push(p.relPath);
                continue;
            }
            throwpoint(THROWPOINTS.RECONCILE_WRITE, p.relPath);
            try {
                if (engine.kind === 'fs' && p.targetValue !== null) {
                    assertConfinedPath({ boundary: directories.root, absolutePath: physical });
                    await fs.promises.mkdir(path.dirname(physical), { recursive: true });
                    await writeFileAtomic(physical, await readBlobBytes({ gitdir, oid: p.targetOid }));
                } else await writeSqlRecordValue(tx, handle, p.record, p.targetValue);
            } catch (error) {
                // A sub-record whose parent record is absent.
                if (error?.name === 'NotFoundError') {
                    local.skipped.push(p.relPath);
                    continue;
                }
                throw error;
            }
            (p.targetValue === null ? local.deleted : local.written).push(p.relPath);
        }
        return local;
    }));
    for (const key of Object.keys(outcome)) report[key].push(...outcome[key]);
    if (outcome.written.length + outcome.deleted.length > 0) markApplied();
}
