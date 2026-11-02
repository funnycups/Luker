import { isDeepStrictEqual } from 'node:util';
import git from 'isomorphic-git';

import { atomicFs } from './atomic-fs.js';
import { isRejectedPath, readBlobBytes, readCommitEntries, writeTreeFromFiles } from './git-tree.js';

export const SYNC_AUTHOR = Object.freeze({ name: 'Luker Sync', email: 'sync@luker.local' });

/** @typedef {import('./git-tree.js').TreeFile} TreeFile */
/** @typedef {import('../conflicts.js').ConflictEntry} ConflictEntry */

function sameEntry(a, b) {
    if (a === undefined || b === undefined) return a === b;
    return a.oid === b.oid && a.mode === b.mode;
}

/**
 * Entry comparison of one merge. Two blobs of a path `parseRecord` knows
 * also count as the same when both parse to deep-equal values: MySQL and
 * Postgres reorder JSON object keys, so engines write the same record with
 * different bytes. Blobs that do not parse compare by oid. Values compare
 * as `JSON.parse` returns them, so integer literals above 2^53 that parse
 * to the same number count as equal, as in every JSON reader in Luker.
 */
function entryComparer(gitdir, parseRecord) {
    const values = new Map();
    const valueOf = async (relPath, parse, oid) => {
        const key = `${relPath}\0${oid}`;
        if (!values.has(key)) values.set(key, parse(await readBlobBytes({ gitdir, oid })));
        return values.get(key);
    };
    return async (relPath, a, b) => {
        if (sameEntry(a, b)) return true;
        if (a === undefined || b === undefined || a.mode !== b.mode) return false;
        const parse = parseRecord?.(relPath);
        if (!parse) return false;
        const [av, bv] = await Promise.all([valueOf(relPath, parse, a.oid), valueOf(relPath, parse, b.oid)]);
        return av !== undefined && bv !== undefined && isDeepStrictEqual(av, bv);
    };
}

/**
 * @param {{ gitdir: string, ours: string, theirs: string }} args
 * @returns {Promise<string | null>}
 */
export async function findMergeBaseOrNull({ gitdir, ours, theirs }) {
    const parents = new Map();
    const ancestorsOf = async (head) => {
        const ancestors = new Set();
        const pending = [head];
        while (pending.length) {
            const oid = pending.pop();
            if (ancestors.has(oid)) continue;
            ancestors.add(oid);
            if (!parents.has(oid)) {
                try {
                    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid });
                    parents.set(oid, commit.parent);
                } catch (error) {
                    throw new Error(`Cannot read merge ancestry at commit ${oid}: ${error.message}`, { cause: error });
                }
            }
            for (const parent of parents.get(oid)) pending.push(parent);
        }
        return ancestors;
    };
    const oursHistory = await ancestorsOf(ours);
    const theirsHistory = await ancestorsOf(theirs);
    const common = [...oursHistory].filter(oid => theirsHistory.has(oid));
    const bases = new Set(common);
    // A shared commit's parents are also shared. Removing them leaves only
    // ancestry-maximal common commits, regardless of shortcut merge parents.
    for (const oid of common) {
        for (const parent of parents.get(oid)) bases.delete(parent);
    }
    return bases.size ? [...bases].sort()[0] : null;
}

/**
 * Three-way merge of two commits' trees without touching any workdir,
 * index or ref. Conflicting paths keep the ours entry. An absent base
 * makes every one-sided file a clean add. A path that ours or theirs
 * holds as a rejected entry (see `readCommitEntries`), or lies under one,
 * counts as unchanged on that side: the rejected entry is never merged and
 * never reads as a deletion. It is not reported as a conflict either, since
 * resolving a conflict toward theirs would write the rejected entry. The
 * rejected paths of ours and theirs are appended to `unsafe` when given.
 * `parentOfSubRecord` maps a sub-record path to its parent record path,
 * or null; when given, the parent of every merged sub-record is kept, and
 * a parent kept over theirs' deletion keeps the sub-records theirs deleted.
 * `parseRecord` maps a path to the parser of its blobs, or null; blobs
 * that parse to deep-equal values count as unchanged, and a path both
 * sides hold that way keeps the ours entry.
 *
 * @param {{ gitdir: string, base: string | null, ours: string, theirs: string, unsafe?: string[], parentOfSubRecord?: (relPath: string) => string | null, parseRecord?: (relPath: string) => ((bytes: Buffer) => unknown) | null, normalizeSides?: Function }} args
 * @returns {Promise<{ files: Map<string, TreeFile>, conflicts: ConflictEntry[] }>}
 */
export async function mergeCommitTrees({ gitdir, base, ours, theirs, unsafe, parentOfSubRecord, parseRecord, normalizeSides }) {
    const same = entryComparer(gitdir, parseRecord);
    const sides = await Promise.all([
        readCommitEntries({ gitdir, commitOid: base }),
        readCommitEntries({ gitdir, commitOid: ours }),
        readCommitEntries({ gitdir, commitOid: theirs }),
    ]);
    const [baseSide, oursSide, theirsSide] = normalizeSides ? normalizeSides(sides) : sides;
    if (unsafe) unsafe.push(...oursSide.rejected.keys(), ...theirsSide.rejected.keys());
    const baseFiles = baseSide.files;
    const oursFiles = oursSide.files;
    const theirsFiles = theirsSide.files;
    /** @type {Map<string, TreeFile>} */
    const files = new Map();
    /** @type {ConflictEntry[]} */
    const conflicts = [];
    const fromTheirs = new Set();
    for (const relPath of new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()])) {
        const b = baseFiles.get(relPath);
        const o = isRejectedPath(oursSide.rejected, relPath) ? b : oursFiles.get(relPath);
        const t = isRejectedPath(theirsSide.rejected, relPath) ? b : theirsFiles.get(relPath);
        let picked;
        // A theirs entry equal to base by oid keeps ours whatever the
        // values say: either ours equals theirs, or ours changed alone.
        if (sameEntry(o, t) || sameEntry(t, b)) {
            picked = o;
        } else if (await same(relPath, o, t)) {
            picked = o;
        } else if (await same(relPath, o, b)) {
            picked = t;
            if (t) fromTheirs.add(relPath);
        } else if (await same(relPath, t, b)) {
            picked = o;
        } else {
            picked = o;
            conflicts.push({
                filepath: relPath,
                kind: !o ? 'deleteByUs' : !t ? 'deleteByTheirs' : 'bothModified',
                oursOid: o?.oid ?? null,
                theirsOid: t?.oid ?? null,
            });
        }
        if (picked) files.set(relPath, picked);
    }
    resolvePathCollisions(files, oursFiles, theirsFiles, fromTheirs, conflicts);
    if (parentOfSubRecord) {
        restoreParentsOfSurvivingSubRecords(files, oursFiles, theirsFiles, conflicts, parentOfSubRecord);
        await keepSubRecordsOfParentsKeptOverTheirsDeletion(files, baseFiles, oursFiles, theirsFiles, conflicts, parentOfSubRecord, same);
    }
    return { files, conflicts };
}

/**
 * SQL parent deletion cascades state, while chat state also requires its
 * parent on write. Preset state accepts absent parents. Keep an available parent
 * of every merged sub-record, preferring the ours entry, and reports it.
 * A parent whose path is a directory in the merged tree is not restored.
 */
function restoreParentsOfSurvivingSubRecords(files, oursFiles, theirsFiles, conflicts, parentOfSubRecord) {
    for (const relPath of [...files.keys()]) {
        const parent = parentOfSubRecord(relPath);
        if (!parent || files.has(parent)) continue;
        if ([...files.keys()].some(other => other.startsWith(`${parent}/`))) continue;
        const fromOurs = oursFiles.get(parent);
        const entry = fromOurs ?? theirsFiles.get(parent);
        if (!entry) continue;
        files.set(parent, entry);
        if (conflicts.some(c => c.filepath === parent)) continue;
        conflicts.push({
            filepath: parent,
            kind: fromOurs ? 'deleteByTheirs' : 'deleteByUs',
            oursOid: oursFiles.get(parent)?.oid ?? null,
            theirsOid: theirsFiles.get(parent)?.oid ?? null,
        });
    }
}

/**
 * The converse of `restoreParentsOfSurvivingSubRecords`: a parent ours
 * changed and theirs deleted is kept, so the sub-records of it that theirs
 * deleted unchanged are kept too and reported, instead of leaving the kept
 * parent without its state.
 */
async function keepSubRecordsOfParentsKeptOverTheirsDeletion(files, baseFiles, oursFiles, theirsFiles, conflicts, parentOfSubRecord, same) {
    const keptOverDeletion = new Set(conflicts.filter(c => c.kind === 'deleteByTheirs' && files.has(c.filepath)).map(c => c.filepath));
    if (keptOverDeletion.size === 0) return;
    for (const [relPath, entry] of oursFiles) {
        if (files.has(relPath) || theirsFiles.has(relPath) || !(await same(relPath, entry, baseFiles.get(relPath)))) continue;
        const parent = parentOfSubRecord(relPath);
        if (!parent || !keptOverDeletion.has(parent)) continue;
        if ([...files.keys()].some(other => other.startsWith(`${relPath}/`))) continue;
        files.set(relPath, entry);
        conflicts.push({ filepath: relPath, kind: 'deleteByTheirs', oursOid: entry.oid, theirsOid: null });
    }
}

/**
 * A path cannot be both a file and a directory in one tree. When the
 * merged map holds a file at a prefix of another path, the entry that came
 * from theirs is dropped and reported; otherwise the deeper path is kept
 * and the prefix file is dropped.
 */
function resolvePathCollisions(files, oursFiles, theirsFiles, fromTheirs, conflicts) {
    for (const relPath of [...files.keys()]) {
        if (!files.has(relPath)) continue;
        const parts = relPath.split('/');
        for (let depth = 1; depth < parts.length; depth++) {
            const prefix = parts.slice(0, depth).join('/');
            if (!files.has(prefix)) continue;
            const victim = fromTheirs.has(relPath) ? relPath : prefix;
            files.delete(victim);
            conflicts.push({
                filepath: victim,
                kind: 'deleteByUs',
                oursOid: oursFiles.get(victim)?.oid ?? null,
                theirsOid: theirsFiles.get(victim)?.oid ?? null,
            });
            if (victim === relPath) break;
        }
    }
}

/**
 * Write the merge commit of `parents`. Its parents are sorted and its time
 * is the latest parent's, so two devices that merge the same heads at
 * once write the same commit and agree on the next sync; otherwise each
 * would merge the other's merge without end.
 *
 * @param {{ gitdir: string, files: Map<string, TreeFile>, parents: string[] }} args
 * @returns {Promise<string>} commit oid; no ref is updated
 */
export async function writeMergeCommit({ gitdir, files, parents }) {
    const tree = await writeTreeFromFiles({ gitdir, files });
    const sorted = [...parents].sort();
    const commits = await Promise.all(sorted.map(oid => git.readCommit({ fs: atomicFs, gitdir, oid })));
    const timestamp = Math.max(...commits.map(({ commit }) => commit.committer.timestamp));
    const signature = { ...SYNC_AUTHOR, timestamp, timezoneOffset: 0 };
    return git.commit({
        fs: atomicFs, gitdir, message: `sync merge ${sorted.join(' and ')}`, author: signature, committer: signature, tree, parent: sorted, noUpdateBranch: true,
    });
}
