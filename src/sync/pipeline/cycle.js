/**
 * One sync cycle for one (user, backend) pair:
 *   0. finish a reconcile a previous run left in the journal;
 *   1. snapshot live data into the shadow repo under the user's write
 *      gate, producing local commit L;
 *   2. read the remote head R and fetch its objects;
 *   3. merge inside the shadow repo only; the result M goes to
 *      refs/sync/pending and main does not move;
 *   4. reconcile live data from L to M under the write gate with a
 *      journal and per-file compare-and-swap; main moves to M only when
 *      nothing was skipped, otherwise the caller runs another cycle;
 *   5. push objects and compare-and-swap the remote head.
 * Steps 0–1 form the snapshot section and step 4 the reconcile section;
 * each runs under the caller's shadow lock, and the network steps between
 * them run outside it. Other holders of the shadow lock may move main
 * between the sections; the reconcile section then leaves live data alone
 * and the cycle ends with a `local-moved` rerun.
 * Callers run at most one cycle at a time per (userRoot, backendId).
 */
import git from 'isomorphic-git';

import { ensureShadowRepo, snapshotLiveToShadow } from '../shadow.js';
import { materializeUserDataIntoWorkdir, buildSnapshotPlan, subRecordParentPath, describeSqlRecordPath, parseSqlRecordBlob } from '../materialize.js';
import { withWriterLock } from '../in-progress-gate.js';
import { assertRemoteBackend, assertRemoteHead, assertCasResult } from '../backends/contract.js';
import { atomicFs, sweepStaleAtomicTemps } from './atomic-fs.js';
import { failpoint, FAILPOINTS, pausepoint, PAUSEPOINTS } from './failpoints.js';
import { findMergeBaseOrNull, mergeCommitTrees, writeMergeCommit, SYNC_AUTHOR } from './merge.js';
import { reconcileLiveCas, emptyReconcileReport } from './live-cas.js';
import { readCommitFiles, writeTreeFromFiles } from './git-tree.js';
import { readReconcileJournal, writeReconcileJournal, deleteReconcileJournal } from './reconcile-journal.js';
import { readSnapshotCategories, writeSnapshotCategories, markCategoriesSynced } from './snapshot-categories.js';
import { authorForDevice } from './commit-provenance.js';
import { buildPresetIdentityView, buildPresetIdentityViews } from '../preset-projection.js';

export const MAIN_REF = 'refs/heads/main';
export const PENDING_REF = 'refs/sync/pending';
export const BACKUP_TAG_PREFIX = 'sync-backup-';
export const SEED_THEIRS_REF = 'refs/sync/seed-theirs';
export const UNDO_TARGET_REF = 'refs/sync/backup-target';

/** @typedef {import('./git-tree.js').TreeFile} TreeFile */
/** @typedef {import('../conflicts.js').ConflictEntry} ConflictEntry */
/** @typedef {import('./live-cas.js').ReconcileReport} ReconcileReport */
/** @typedef {import('../backends/contract.js').RemoteBackend} RemoteBackend */

/**
 * @callback OnConflictsHook
 * @param {{ gitdir: string, base: string | null, ours: string, theirs: string, files: Map<string, TreeFile>, conflicts: ConflictEntry[], oursIsLocal?: boolean }} input
 *   ours is the head with the smaller oid; `oursIsLocal` tells whether that is the local head
 * @returns {Promise<Map<string, TreeFile> | { files: Map<string, TreeFile>, conflicts: ConflictEntry[] }>}
 *   tree of the merge commit, with the conflict list the cycle reports when it is returned
 */

/**
 * @typedef {object} CycleContext
 * @property {string} userRoot
 * @property {string} handle
 * @property {import('../../users.js').UserDirectoryList} directories
 * @property {string} backendId
 * @property {string[]} categories
 * @property {{ kind: string, withTransaction: Function }} engine
 * @property {RemoteBackend} backend
 * @property {import('./scheduler.js').OperationLease} [lease] Production admission guarding local mutations.
 * @property {<T>(fn: (ctx: CycleContext) => Promise<T>) => Promise<T>} [withMutation] Admits a fresh context when not already leased.
 * @property {OnConflictsHook} [onConflicts]
 * @property {() => Promise<string>} [getDeviceLabel] Current local label for newly created edits.
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} [lockShadow] runs the snapshot section and the reconcile section; defaults to running them directly
 * @property {() => Promise<void>} [beforeSnapshot] runs before the snapshot section, outside every lock
 * @property {(report: ReconcileReport) => Promise<void>} [onLiveApplied] runs after each reconcile,
 *   recovery included, while the shadow lock and the writer lock are held, so it must not take either
 *   lock. Main has already moved and the journal is deleted, so the report is never reproduced; a
 *   failure is logged and does not fail the cycle.
 */

/** @typedef {'none'|'pairing-pull'|'pairing-push'|'equal'|'fast-forward'|'ahead'|'merged'|'merged-unrelated'} MergeCase */

/** @typedef {{ base: string | null, target: string, reconcile: ReconcileReport }} RecoveryReport */

/**
 * @typedef {object} CycleOutcome
 * @property {'synced' | 'rerun'} status
 * @property {null | 'live-changed' | 'remote-moved' | 'local-moved'} reason
 * @property {MergeCase} mergeCase
 * @property {string | null} localHead shadow main after the cycle
 * @property {string | null} remoteHead remote head as last seen; the pushed oid after a successful CAS
 * @property {string | null} remoteEtag remote head ETag as last seen at the start of the cycle
 * @property {boolean} pushed
 * @property {ConflictEntry[]} conflicts seeding conflicts of newly enabled categories, then merge conflicts
 * @property {ReconcileReport | null} reconcile
 * @property {RecoveryReport | null} recovered
 * @property {ReconcileReport | null} seeded live seeding of categories enabled since the last snapshot
 * @property {string | null} notifyError
 */

/**
 * @param {string} baseOid
 * @param {Date} [now]
 * @returns {string}
 */
export function backupTagName(baseOid, now = new Date()) {
    return `${BACKUP_TAG_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}-${baseOid.slice(0, 8)}`;
}

/** @type {OnConflictsHook} */
export async function keepOursOnConflicts({ files, conflicts }) {
    console.warn(`[sync] kept the provisional version of ${conflicts.length} conflicting path(s): ${conflicts.map(c => c.filepath).join(', ')}`);
    return files;
}

async function resolveRefOrNull(gitdir, ref) {
    try {
        return await git.resolveRef({ fs: atomicFs, gitdir, ref });
    } catch (error) {
        if (error.code === 'NotFoundError') return null;
        throw error;
    }
}

async function tagBackup(gitdir, base, target) {
    let name = null;
    for (const tag of await git.listTags({ fs: atomicFs, gitdir })) {
        if (tag.startsWith(BACKUP_TAG_PREFIX) && await git.resolveRef({ fs: atomicFs, gitdir, ref: tag }) === base) name = tag;
    }
    if (!name) {
        name = backupTagName(base);
        await git.tag({ fs: atomicFs, gitdir, ref: name, object: base });
    }
    failpoint(FAILPOINTS.BACKUP_TAG_BEFORE_TARGET);
    await git.writeRef({ fs: atomicFs, gitdir, ref: UNDO_TARGET_REF, value: target, force: true });
    // Undo reads only the newest tag and its target; every older tagged
    // commit is an ancestor of main, so dropping its tag loses no history,
    // while keeping it would add one ref per sync that this loop reads.
    for (const tag of await git.listTags({ fs: atomicFs, gitdir })) {
        if (tag.startsWith(BACKUP_TAG_PREFIX) && tag !== name) await git.deleteRef({ fs: atomicFs, gitdir, ref: `refs/tags/${tag}` });
    }
}

/**
 * The commit the last reconciling cycle started from and the commit it
 * reconciled live data to: the newest backup tag the target strictly
 * descends from, or null.
 *
 * @param {string} gitdir
 * @returns {Promise<{ tag: string, base: string, target: string } | null>}
 */
export async function readUndoPoint(gitdir) {
    const target = await resolveRefOrNull(gitdir, UNDO_TARGET_REF);
    if (!target) return null;
    const tags = (await git.listTags({ fs: atomicFs, gitdir })).filter(t => t.startsWith(BACKUP_TAG_PREFIX)).sort().reverse();
    // A kill between writing a new tag and its target leaves the previous
    // target, which the new base does not precede; the older tag it was
    // written with is still present, since older tags are deleted last.
    for (const tag of tags) {
        const base = await git.resolveRef({ fs: atomicFs, gitdir, ref: tag });
        if (target !== base && await git.isDescendent({ fs: atomicFs, gitdir, oid: target, ancestor: base })) return { tag, base, target };
    }
    return null;
}

/**
 * @param {string} gitdir
 * @returns {Promise<void>}
 */
export async function clearUndoPoint(gitdir) {
    for (const tag of await git.listTags({ fs: atomicFs, gitdir })) {
        if (tag.startsWith(BACKUP_TAG_PREFIX)) await git.deleteRef({ fs: atomicFs, gitdir, ref: `refs/tags/${tag}` });
    }
    await git.deleteRef({ fs: atomicFs, gitdir, ref: UNDO_TARGET_REF });
}

// Runs after main moved and the journal was deleted, so a failure here
// cannot be retried; it is logged and the cycle goes on.
async function notifyLiveApplied(onLiveApplied, report) {
    if (!onLiveApplied) return;
    try {
        await onLiveApplied(report);
    } catch (error) {
        console.error('[sync] onLiveApplied failed:', error);
    }
}

async function finishReconcile({ userRoot, backendId, gitdir, categories, target, report, advanceOnSkip = false }) {
    if (advanceOnSkip || report.skipped.length === 0) {
        await git.writeRef({ fs: atomicFs, gitdir, ref: MAIN_REF, value: target, force: true });
    }
    // Skips included, every path of these categories now equals target or
    // differs from it the way the next snapshot would commit it: applied
    // paths were written to target, unvisited paths are equal in base and
    // target, and a skipped path never equals target, since that counts
    // as applied.
    await markCategoriesSynced({ userRoot, backendId, categories, oid: target });
    await git.deleteRef({ fs: atomicFs, gitdir, ref: PENDING_REF });
    await deleteReconcileJournal({ userRoot, backendId });
}

/**
 * Re-run an interrupted reconcile recorded in the journal over the
 * categories it recorded. Paths already written equal the target and
 * count as applied, so the run converges. Without a journal it only
 * removes a leftover `refs/sync/pending`.
 *
 * @param {CycleContext} ctx
 * @returns {Promise<RecoveryReport | null>}
 */
export async function recoverReconcile({ userRoot, handle, directories, backendId, categories, engine, onLiveApplied }) {
    const journal = readReconcileJournal({ userRoot, backendId });
    const shadow = await ensureShadowRepo({ userRoot, peerId: backendId });
    if (!journal) {
        // A pending merge is only acted on through the journal; without one
        // the ref is left from a cycle that stopped before reconciling.
        await git.deleteRef({ fs: atomicFs, gitdir: shadow.gitDir, ref: PENDING_REF });
        return null;
    }
    const journaledCategories = journal.categories ?? categories;
    const reconcile = await withWriterLock(userRoot, async () => {
        const report = await reconcileLiveCas({
            gitdir: shadow.gitDir, directories, handle, engine,
            categories: journaledCategories,
            base: journal.base, target: journal.target,
        });
        await finishReconcile({ userRoot, backendId, gitdir: shadow.gitDir, categories: journaledCategories, target: journal.target, report, advanceOnSkip: journal.advanceOnSkip });
        await notifyLiveApplied(onLiveApplied, report);
        return report;
    });
    return { base: journal.base, target: journal.target, reconcile };
}

/**
 * Reconcile each category from its sync point to `target`, one run per
 * distinct sync point.
 *
 * @returns {Promise<{ report: ReconcileReport, skippedBases: Map<string, string | null> }>}
 *   `skippedBases` maps each skipped path to the sync point it was reconciled from
 */
async function seedCategories({ gitdir, directories, handle, engine, categories, syncedAt, target }) {
    const byBase = new Map();
    for (const id of categories) {
        const base = syncedAt[id] ?? null;
        // A sync point equal to the target or descending from it means live
        // data of this category already equals or is past the target, so
        // seeding would only move it back. A recovered reconcile of seed
        // conflict records leaves the sync point there.
        if (base && await findMergeBaseOrNull({ gitdir, ours: base, theirs: target }) === target) continue;
        byBase.set(base, [...(byBase.get(base) ?? []), id]);
    }
    const report = emptyReconcileReport();
    const skippedBases = new Map();
    for (const [base, ids] of byBase) {
        const part = await reconcileLiveCas({ gitdir, directories, handle, categories: ids, engine, base, target });
        for (const key of Object.keys(report)) report[key].push(...part[key]);
        for (const relPath of part.skipped) skippedBases.set(relPath, base);
    }
    return { report, skippedBases };
}

/**
 * Seed-skipped paths whose snapshotted content differs from both their
 * sync point and main: edited on both sides while the category was
 * disabled. The snapshot already committed the local content as ours.
 *
 * @returns {Promise<ConflictEntry[]>}
 */
async function seedConflicts({ gitdir, directories, skippedBases, ours, theirs }) {
    const filesOf = async commitOid => buildPresetIdentityView({ directories, files: commitOid ? await readCommitFiles({ gitdir, commitOid }) : new Map() }).files;
    const [oursFiles, theirsFiles] = await Promise.all([filesOf(ours), filesOf(theirs)]);
    const baseFiles = new Map();
    const conflicts = [];
    for (const [relPath, base] of skippedBases) {
        if (!baseFiles.has(base)) baseFiles.set(base, await filesOf(base));
        const oursOid = oursFiles.get(relPath)?.oid ?? null;
        const theirsOid = theirsFiles.get(relPath)?.oid ?? null;
        const baseOid = baseFiles.get(base).get(relPath)?.oid ?? null;
        if (oursOid === baseOid || oursOid === theirsOid) continue;
        const kind = oursOid === null ? 'deleteByUs' : theirsOid === null ? 'deleteByTheirs' : 'bothModified';
        conflicts.push({ filepath: relPath, kind, oursOid, theirsOid });
    }
    return conflicts;
}

/**
 * @returns {Promise<{ mergeCase: MergeCase, target: string | null, conflicts: ConflictEntry[], reconcile: boolean, push: boolean }>}
 */
async function planMerge({ gitdir, directories, localHead, remoteHead, onConflicts }) {
    const plan = (mergeCase, target, reconcile, push, conflicts = []) => ({ mergeCase, target, conflicts, reconcile, push });
    if (!localHead && !remoteHead) return plan('none', null, false, false);
    if (!localHead) return plan('pairing-pull', remoteHead, true, false);
    if (!remoteHead) return plan('pairing-push', localHead, false, true);
    if (localHead === remoteHead) return plan('equal', localHead, false, false);
    // The head with the smaller oid is ours on every device, so two devices
    // merging the same heads at once resolve conflicts the same way and
    // write the same merge commit. Live CAS still keeps local live edits.
    const oursIsLocal = localHead < remoteHead;
    const [ours, theirs] = oursIsLocal ? [localHead, remoteHead] : [remoteHead, localHead];
    const base = await findMergeBaseOrNull({ gitdir, ours, theirs });
    if (base === localHead) return plan('fast-forward', remoteHead, true, false);
    if (base === remoteHead) return plan('ahead', localHead, false, true);
    const merged = await mergeCommitTrees({
        gitdir, base, ours, theirs,
        normalizeSides: sides => buildPresetIdentityViews({ directories, sides }),
        parentOfSubRecord: relPath => subRecordParentPath(directories, relPath),
        parseRecord: (relPath) => {
            const record = describeSqlRecordPath(directories, relPath);
            return record ? bytes => parseSqlRecordBlob(record, bytes) : null;
        },
    });
    const result = merged.conflicts.length > 0
        ? await onConflicts({ gitdir, base, ours, theirs, files: merged.files, conflicts: merged.conflicts, oursIsLocal })
        : merged.files;
    const { files, conflicts } = result instanceof Map ? { files: result, conflicts: merged.conflicts } : result;
    const target = await writeMergeCommit({
        gitdir,
        files,
        parents: [localHead, remoteHead],
    });
    return plan(base ? 'merged' : 'merged-unrelated', target, true, true, conflicts);
}

/**
 * Snapshot live data into the shadow repo; the caller holds the writer lock.
 *
 * @param {CycleContext} ctx
 * @param {{ gitDir: string, workdir: string }} shadow
 * @returns {Promise<{ localHead: string | null, seeded: ReconcileReport | null, seededConflicts: ConflictEntry[] }>}
 */
async function snapshotStep(ctx, shadow) {
    const { userRoot, handle, directories, backendId, categories, engine, onConflicts = keepOursOnConflicts } = ctx;
    const gitdir = shadow.gitDir;
    // A category enabled since the last snapshot is first brought
    // forward to main from its sync point, the last main its live files
    // equaled, so remote edits made while it was disabled apply and only
    // files edited locally meanwhile are kept as local edits. A category
    // never synced here has no sync point and is seeded from an empty
    // base. Without this the snapshot would commit stale files over
    // main, or the category's absence as deletions everywhere.
    const record = readSnapshotCategories({ userRoot, backendId });
    const main = await resolveRefOrNull(gitdir, MAIN_REF);
    const pendingSeed = await resolveRefOrNull(gitdir, SEED_THEIRS_REF);
    const newlyEnabled = record && (pendingSeed ?? main) ? categories.filter(id => !record.categories.includes(id)) : [];
    // The snapshot below moves main, so the main these categories are
    // seeded from is kept in a ref until their record is written.
    const currentMain = newlyEnabled.length > 0 ? (pendingSeed ?? main) : main;
    if (newlyEnabled.length > 0 && !pendingSeed) await git.writeRef({ fs: atomicFs, gitdir, ref: SEED_THEIRS_REF, value: currentMain, force: true });
    const seed = newlyEnabled.length > 0
        ? await seedCategories({ gitdir, directories, handle, engine, categories: newlyEnabled, syncedAt: record.syncedAt, target: currentMain })
        : null;
    // Records unchanged since main retain their bytes. Preset identities use
    // the same projection in every engine, independently of physical layout.
    await materializeUserDataIntoWorkdir({
        handle, directories, categories, workdir: shadow.workdir, engine,
        gitdir, referenceOids: [main, currentMain],
    });
    const snapshotPlan = buildSnapshotPlan({ engine, directories, categories, workdir: shadow.workdir });
    await pausepoint(PAUSEPOINTS.INSIDE_SNAPSHOT_LOCK);
    const snapshot = await snapshotLiveToShadow({ userRoot, peerId: backendId, ...snapshotPlan, deviceLabel: await ctx.getDeviceLabel?.() });
    const syncedAt = { ...record?.syncedAt };
    if (snapshot.oid) for (const id of categories) syncedAt[id] = snapshot.oid;
    const recordCategories = async () => {
        await writeSnapshotCategories({ userRoot, backendId, categories, syncedAt });
        await git.deleteRef({ fs: atomicFs, gitdir, ref: SEED_THEIRS_REF });
    };
    const found = seed ? await seedConflicts({ gitdir, directories, skippedBases: seed.skippedBases, ours: snapshot.oid, theirs: currentMain }) : [];
    if (found.length === 0) {
        await recordCategories();
        return { localHead: snapshot.oid, seeded: seed?.report ?? null, seededConflicts: [] };
    }
    const result = await onConflicts({ gitdir, base: null, ours: snapshot.oid, theirs: currentMain, files: await readCommitFiles({ gitdir, commitOid: snapshot.oid }), conflicts: found });
    const { files, conflicts } = result instanceof Map ? { files: result, conflicts: found } : result;
    const tree = await writeTreeFromFiles({ gitdir, files });
    const { commit } = await git.readCommit({ fs: atomicFs, gitdir, oid: snapshot.oid });
    if (tree === commit.tree) {
        await recordCategories();
        return { localHead: snapshot.oid, seeded: seed.report, seededConflicts: conflicts };
    }
    // Until the category record is written the categories stay newly
    // enabled and SEED_THEIRS_REF keeps the main they are seeded from: a
    // kill before the journal makes the next cycle seed against that main
    // again and find the same conflicts; a kill after it is finished by
    // recovery, which moves main to the records and the sync point of
    // these categories past the seed target, so they are not seeded again.
    // Main moves to the records even when paths are skipped, since nothing
    // else references them: a skipped path holds a newer live edit, which
    // the next snapshot commits over the records as a local edit.
    const recorded = await git.commit({ fs: atomicFs, gitdir, message: 'sync conflict records', author: SYNC_AUTHOR, tree, parent: [snapshot.oid], noUpdateBranch: true });
    failpoint(FAILPOINTS.SEED_RECORDS_BEFORE_JOURNAL);
    await writeReconcileJournal({ userRoot, backendId, base: snapshot.oid, target: recorded, categories, advanceOnSkip: true });
    failpoint(FAILPOINTS.SEED_RECORDS_AFTER_JOURNAL);
    await recordCategories();
    const report = await reconcileLiveCas({ gitdir, directories, handle, categories, engine, base: snapshot.oid, target: recorded });
    await finishReconcile({ userRoot, backendId, gitdir, categories, target: recorded, report, advanceOnSkip: true });
    await notifyLiveApplied(ctx.onLiveApplied, report);
    return { localHead: recorded, seeded: seed.report, seededConflicts: conflicts };
}

const SWEEPS = new Map();
const runUnlocked = fn => fn();

export function _sweptGitdirsForTests() {
    return new Set(SWEEPS.keys());
}

// Temp files of this process are still in flight; only an earlier process
// can leave stale ones, so one sweep per repository per process suffices.
// Concurrent first cycles share the sweep; a failed sweep is retried.
function sweepOnce(gitdir) {
    let sweep = SWEEPS.get(gitdir);
    if (!sweep) {
        sweep = sweepStaleAtomicTemps(gitdir).catch(error => {
            SWEEPS.delete(gitdir);
            throw error;
        });
        SWEEPS.set(gitdir, sweep);
    }
    return sweep;
}

/**
 * @param {CycleContext} ctx
 * @returns {Promise<CycleOutcome>}
 */
export async function runSyncCycle(ctx) {
    if (ctx.withMutation && !ctx.lease) return ctx.withMutation(leased => runSyncCycle({ ...leased, backend: ctx.backend }));
    const { userRoot, handle, directories, backendId, categories, engine, backend, onConflicts = keepOursOnConflicts } = ctx;
    const lockShadow = ctx.lease ? fn => ctx.lease.withLocal(fn) : (ctx.lockShadow ?? runUnlocked);
    assertRemoteBackend(backend);
    if (backend.id !== backendId) {
        throw new Error(`runSyncCycle: backend id ${JSON.stringify(backend.id)} does not match backendId ${JSON.stringify(backendId)}`);
    }
    if (ctx.beforeSnapshot) await ctx.beforeSnapshot();
    const shadow = await lockShadow(async () => {
        const shadow = await ensureShadowRepo({ userRoot, peerId: backendId });
        await sweepOnce(shadow.gitDir);
        return shadow;
    });
    const gitdir = shadow.gitDir;

    const { recovered, localHead, seeded, seededConflicts } = await lockShadow(async () => {
        const recoveredReport = await recoverReconcile(ctx);
        const step = await withWriterLock(userRoot, () => snapshotStep(ctx, shadow));
        return { recovered: recoveredReport, ...step };
    });
    await pausepoint(PAUSEPOINTS.AFTER_SNAPSHOT);

    const head = assertRemoteHead(await backend.readHead());
    const remoteHead = head?.oid ?? null;
    if (remoteHead) await backend.fetchInto([remoteHead], localHead ? [localHead] : []);
    if (backend.isLocal !== true) await pausepoint(PAUSEPOINTS.AFTER_REMOTE_HEAD);

    const plan = await lockShadow(() => planMerge({ gitdir, directories, localHead, remoteHead, onConflicts }));
    /** @type {CycleOutcome} */
    const outcome = {
        status: 'synced',
        reason: null,
        mergeCase: plan.mergeCase,
        localHead,
        remoteHead,
        remoteEtag: head?.etag ?? null,
        pushed: false,
        conflicts: [...seededConflicts, ...plan.conflicts],
        reconcile: null,
        recovered,
        seeded,
        notifyError: null,
    };

    if (plan.reconcile) {
        const report = await lockShadow(async () => {
            // Another cycle or a local commit moved main after this snapshot;
            // reconciling from the stale snapshot would drop that commit.
            if (await resolveRefOrNull(gitdir, MAIN_REF) !== localHead) return null;
            await git.writeRef({ fs: atomicFs, gitdir, ref: PENDING_REF, value: plan.target, force: true });
            if (localHead) await tagBackup(gitdir, localHead, plan.target);
            return withWriterLock(userRoot, async () => {
                await writeReconcileJournal({ userRoot, backendId, base: localHead, target: plan.target, categories });
                const applied = await reconcileLiveCas({
                    gitdir, directories, handle, categories, engine,
                    base: localHead, target: plan.target,
                });
                await finishReconcile({ userRoot, backendId, gitdir, categories, target: plan.target, report: applied });
                await notifyLiveApplied(ctx.onLiveApplied, applied);
                return applied;
            });
        });
        if (report === null) return { ...outcome, status: 'rerun', reason: 'local-moved' };
        outcome.reconcile = report;
        if (report.skipped.length > 0) return { ...outcome, status: 'rerun', reason: 'live-changed' };
        outcome.localHead = plan.target;
    }
    if (!plan.push) return outcome;

    await ctx.lease?.assertAlive();
    await backend.pushObjects(plan.target, remoteHead);
    failpoint(FAILPOINTS.PUSH_BEFORE_CAS);
    await ctx.lease?.assertAlive();
    const cas = assertCasResult(await backend.casHead(head?.etag ?? null, plan.target));
    if (!cas.ok) return { ...outcome, status: 'rerun', reason: 'remote-moved' };
    outcome.pushed = true;
    outcome.remoteHead = plan.target;
    if (typeof backend.notifyPeer === 'function') {
        try {
            await backend.notifyPeer();
        } catch (error) {
            outcome.notifyError = String(error?.message || error);
        }
    }
    return outcome;
}

/**
 * Snapshot live data, commit `edit`'s tree on top of the snapshot and
 * reconcile live data to it, all in one shadow lock section. Main moves
 * to the edit only when nothing was skipped.
 *
 * @param {CycleContext} ctx
 * @param {(input: { gitdir: string, head: string | null, files: Map<string, TreeFile> }) => Promise<{ files: Map<string, TreeFile>, message: string } | null>} edit
 * @returns {Promise<{ head: string | null, committed: boolean, reconcile: ReconcileReport | null, seededConflicts: ConflictEntry[] }>}
 */
export async function commitLocalEdit(ctx, edit) {
    if (ctx.withMutation && !ctx.lease) return ctx.withMutation(leased => commitLocalEdit(leased, edit));
    const { userRoot, handle, directories, backendId, categories, engine } = ctx;
    const lockShadow = ctx.lease ? fn => ctx.lease.withLocal(fn) : (ctx.lockShadow ?? runUnlocked);
    return lockShadow(async () => {
        const shadow = await ensureShadowRepo({ userRoot, peerId: backendId });
        const gitdir = shadow.gitDir;
        await sweepOnce(gitdir);
        await recoverReconcile(ctx);
        return withWriterLock(userRoot, async () => {
            const { localHead, seededConflicts } = await snapshotStep(ctx, shadow);
            const files = buildPresetIdentityView({ directories, files: localHead ? await readCommitFiles({ gitdir, commitOid: localHead }) : new Map() }).files;
            const change = await edit({ gitdir, head: localHead, files });
            if (!change) return { head: localHead, committed: false, reconcile: null, seededConflicts };
            const tree = await writeTreeFromFiles({ gitdir, files: change.files });
            const author = authorForDevice(await ctx.getDeviceLabel?.());
            const now = new Date(Date.now());
            const signature = { timestamp: Math.floor(now.getTime() / 1000), timezoneOffset: now.getTimezoneOffset() };
            const target = await git.commit({ fs: atomicFs, gitdir, message: change.message,
                author: { ...author, ...signature }, committer: { ...SYNC_AUTHOR, ...signature },
                tree, parent: localHead ? [localHead] : [], noUpdateBranch: true });
            failpoint(FAILPOINTS.LOCAL_EDIT_BEFORE_JOURNAL);
            await writeReconcileJournal({ userRoot, backendId, base: localHead, target, categories });
            failpoint(FAILPOINTS.LOCAL_EDIT_AFTER_JOURNAL);
            await pausepoint(PAUSEPOINTS.LOCAL_EDIT_BEFORE_RECONCILE);
            const report = await reconcileLiveCas({ gitdir, directories, handle, categories, engine, base: localHead, target });
            await finishReconcile({ userRoot, backendId, gitdir, categories, target, report });
            await notifyLiveApplied(ctx.onLiveApplied, report);
            const committed = report.skipped.length === 0;
            return { head: committed ? target : localHead, committed, reconcile: report, seededConflicts };
        });
    });
}
