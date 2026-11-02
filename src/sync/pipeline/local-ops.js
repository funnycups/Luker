import git from 'isomorphic-git';

import { syncError } from '../errors.js';
import { subRecordParentPath } from '../materialize.js';
import { getShadowPaths } from '../shadow.js';
import { atomicFs } from './atomic-fs.js';
import { chatTreeLayout } from './chat-fork.js';
import { CONFLICTS_PATH, NOTICES_PATH, readEntries, writeEntries } from './conflict-records.js';
import { clearUndoPoint, commitLocalEdit, readUndoPoint } from './cycle.js';
import { readBlobBytes, readCommitFiles } from './git-tree.js';
import { conflictRecordVersion, readPendingState } from './pending-status.js';
import { pausepoint, PAUSEPOINTS } from './failpoints.js';
import { buildPresetIdentityView, resolvePresetChoicePath } from '../preset-projection.js';

/** @typedef {Omit<import('./cycle.js').CycleContext, 'backend'>} LocalContext */

const gitdirOf = ctx => getShadowPaths({ userRoot: ctx.userRoot, peerId: ctx.backendId }).gitDir;

const CHOICES = new Set(['current', 'ours', 'theirs']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isOid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isBlob = value => value === null || isOid(value);

/** Mandatory evidence of the displayed preview and every acknowledged current version. */
export function isConflictChoiceList(body) {
    return Array.isArray(body) && body.length > 0 && body.every(item => {
        if (!isObject(item) || Object.keys(item).some(key => !['path', 'choice', 'review'].includes(key))
            || typeof item.path !== 'string' || !item.path || !CHOICES.has(item.choice)) return false;
        const review = item.review;
        if (!isObject(review) || Object.keys(review).some(key => !['backendId', 'selectedOid', 'recordVersions', 'currentVersions'].includes(key))
            || typeof review.backendId !== 'string' || !isBlob(review.selectedOid)
            || !isObject(review.recordVersions) || !isObject(review.currentVersions)) return false;
        const ids = Object.keys(review.recordVersions);
        return ids.length > 0 && ids.includes(review.backendId) && ids.length === Object.keys(review.currentVersions).length
            && ids.every(id => id && isOid(review.recordVersions[id]) && Object.hasOwn(review.currentVersions, id) && isBlob(review.currentVersions[id]))
            && (item.choice !== 'current' || review.selectedOid === review.currentVersions[review.backendId]);
    }) && new Set(body.map(item => item.path)).size === body.length;
}

/**
 * A conflict record of a group file holds the parents' own group files,
 * which lack the branch chats a fork appended; every chat id of the
 * current group file whose chat file exists stays listed.
 */
async function keepGroupChats({ gitdir, files, next, relPath, layout }) {
    const parse = async entry => {
        if (!entry) return null;
        try {
            return JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8'));
        } catch {
            return null;
        }
    };
    const current = await parse(files.get(relPath));
    const chosen = await parse(next.get(relPath));
    if (!chosen || !Array.isArray(chosen.chats) || !Array.isArray(current?.chats)) return;
    const missing = current.chats.filter(id => !chosen.chats.includes(id) && next.has(`${layout.groupChatsDir}/${id}.jsonl`));
    if (missing.length === 0) return;
    const blob = Buffer.from(JSON.stringify({ ...chosen, chats: [...chosen.chats, ...missing] }, null, 4));
    next.set(relPath, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob }), mode: next.get(relPath).mode });
}

/**
 * Restore an available companion parent from the selected side. SQL chat
 * state requires its chat; preset state also accepts an absent parent.
 */
async function restoreParentOfCompanion({ gitdir, next, relPath, directories, sideCommit }) {
    const parent = subRecordParentPath(directories, relPath);
    if (!parent || next.has(parent) || !sideCommit) return;
    if ([...next.keys()].some(other => other.startsWith(`${parent}/`))) return;
    const entry = buildPresetIdentityView({ directories, files: await readCommitFiles({ gitdir, commitOid: sideCommit }) }).files.get(parent);
    if (entry) next.set(parent, entry);
}

/**
 * Resolve pending conflicts. `current` keeps HEAD, `ours` and `theirs`
 * write that side's blob, or delete the path when the side deleted it.
 * Each choice is one local commit on every backend that records the path;
 * the path stays pending on a backend whose commit a live change skipped.
 *
 * @param {Map<string, LocalContext>} ctxByBackend
 * @param {Array<{ path: string, choice: 'current' | 'ours' | 'theirs', review: { backendId: string, selectedOid: string | null, recordVersions: Record<string, string>, currentVersions: Record<string, string | null> } }>} choices
 * @returns {Promise<Array<{ path: string, backends: string[], committedBackends: string[], applied: boolean }>>}
 */
export async function applyConflictChoices(ctxByBackend, choices) {
    const unleased = [...ctxByBackend.values()].find(ctx => ctx.withMutationContexts && !ctx.lease);
    if (unleased) return unleased.withMutationContexts([...ctxByBackend.keys()], contexts => applyConflictChoices(contexts, choices), { allowPreparationErrors: true });
    const invalid = choices.find(c => !CHOICES.has(c?.choice));
    if (invalid) throw syncError('INVALID_CHOICE', `unknown conflict choice ${JSON.stringify(invalid?.choice)}`);
    if (!isConflictChoiceList(choices)) throw syncError('INVALID_CHOICES', 'Conflict choices require the displayed record and current-version evidence. Refresh pending records before choosing.');
    const { conflicts, errors: readErrors, conflictSources } = await readPendingState(ctxByBackend);
    await pausepoint(PAUSEPOINTS.CONFLICT_CHOICES_AFTER_READ);
    const results = [];
    for (const { path: relPath, choice, review } of choices) {
        const entry = conflicts.find(c => c.path === relPath);
        const errors = { ...readErrors };
        if (!entry) {
            results.push({ path: relPath, backends: [], committedBackends: [], applied: false, ...(Object.keys(errors).length ? { errors } : {}) });
            continue;
        }
        const committedBackends = [];
        const resultForPath = () => ({ path: relPath, backends: [...entry.backends], committedBackends, applied: committedBackends.length === entry.backends.length && Object.keys(errors).length === 0, ...(Object.keys(errors).length ? { errors } : {}) });
        const source = conflictSources.get(review.backendId)?.get(relPath);
        if (choice !== 'current' && (!source || conflictRecordVersion(source.record) !== review.recordVersions[review.backendId]
            || source.record[choice] !== review.selectedOid)) {
            results.push(resultForPath());
            continue;
        }
        const chosen = review.selectedOid;
        let bytes = null;
        if (choice !== 'current' && chosen !== null) {
            try {
                bytes = await readBlobBytes({ gitdir: gitdirOf(ctxByBackend.get(review.backendId)), oid: chosen });
            } catch (error) {
                console.error(`[sync] selected conflict blob for ${relPath} on ${review.backendId} could not be read`, error);
                errors[review.backendId] = { code: 'CONFLICT_BLOB_READ_FAILED', message: `Could not read the selected version of ${relPath} on ${review.backendId}. Recover this backend and refresh the conflict before retrying.` };
                results.push(resultForPath());
                continue;
            }
        }
        let appliedCurrent;
        for (const backendId of entry.backends) {
            const ctx = ctxByBackend.get(backendId);
            const layout = chatTreeLayout(ctx.directories);
            let targetCurrent;
            try {
                const result = await commitLocalEdit(ctx, async ({ gitdir, files }) => {
                    const next = new Map(files);
                    const records = await readEntries({ gitdir, files, path: CONFLICTS_PATH, kind: 'conflicts' });
                    if (!records[relPath] || conflictRecordVersion(records[relPath]) !== review.recordVersions[backendId]) return null;
                    const targetPath = resolvePresetChoicePath({ directories: ctx.directories, files, recordPath: relPath });
                    const current = files.get(targetPath)?.oid ?? null;
                    // Backends share live data: the displayed source's current and this decision's prior publication are also acknowledged identities.
                    if (current !== review.currentVersions[backendId] && current !== review.currentVersions[review.backendId] && current !== appliedCurrent) return null;
                    const sideCommit = records[relPath]?.mergeParents[choice === 'ours' ? 0 : 1];
                    delete records[relPath];
                    if (choice !== 'current' && chosen === null) {
                        next.delete(targetPath);
                        // A SQL engine does not delete a parent record that still has state companions.
                        for (const key of [...next.keys()]) {
                            if (subRecordParentPath(ctx.directories, key) === targetPath) {
                                next.delete(key);
                                for (const recordPath of Object.keys(records)) if (resolvePresetChoicePath({ directories: ctx.directories, files, recordPath }) === key) delete records[recordPath];
                            }
                        }
                    }
                    if (choice !== 'current' && chosen) {
                        next.set(targetPath, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: bytes }), mode: files.get(targetPath)?.mode ?? '100644' });
                        await restoreParentOfCompanion({ gitdir, next, relPath: targetPath, directories: ctx.directories, sideCommit });
                        if (targetPath.startsWith(`${layout.groupsDir}/`)) await keepGroupChats({ gitdir, files, next, relPath: targetPath, layout });
                    }
                    await writeEntries({ gitdir, files: next, path: CONFLICTS_PATH, entries: records });
                    targetCurrent = next.get(targetPath)?.oid ?? null;
                    return { files: next, message: `resolve sync conflict ${relPath}` };
                });
                if (result.committed) {
                    committedBackends.push(backendId);
                    if (choice !== 'current') appliedCurrent = targetCurrent;
                }
            } catch (error) {
                console.error(`[sync] conflict choice for ${relPath} on ${backendId} failed`, error);
                errors[backendId] = { code: 'CONFLICT_COMMIT_FAILED', message: `Could not commit the choice for ${relPath} on ${backendId}. Recover this backend and refresh pending records before retrying.` };
            }
        }
        results.push(resultForPath());
    }
    return results;
}

/**
 * @param {Map<string, LocalContext>} ctxByBackend
 * @param {string[]} paths
 * @returns {Promise<Array<{ path: string, backends: string[], committedBackends: string[], applied: boolean, errors?: object }>>}
 */
export async function dismissNotices(ctxByBackend, paths) {
    const unleased = [...ctxByBackend.values()].find(ctx => ctx.withMutationContexts && !ctx.lease);
    if (unleased) return unleased.withMutationContexts([...ctxByBackend.keys()], contexts => dismissNotices(contexts, paths), { allowPreparationErrors: true });
    const { notices, errors: readErrors } = await readPendingState(ctxByBackend);
    const results = [];
    for (const relPath of paths) {
        const entry = notices.find(n => n.path === relPath);
        const backends = entry ? [...entry.backends] : [];
        const committedBackends = [];
        const errors = { ...readErrors };
        for (const backendId of backends) {
            try {
                const result = await commitLocalEdit(ctxByBackend.get(backendId), async ({ gitdir, files }) => {
                    const next = new Map(files);
                    const entries = await readEntries({ gitdir, files, path: NOTICES_PATH, kind: 'notices' });
                    if (!entries[relPath]) return null;
                    delete entries[relPath];
                    await writeEntries({ gitdir, files: next, path: NOTICES_PATH, entries });
                    return { files: next, message: `dismiss sync notice ${relPath}` };
                });
                if (result.committed) committedBackends.push(backendId);
                else errors[backendId] = { code: 'NOTICE_NOT_COMMITTED', message: `Notice dismissal on ${backendId} was not committed. Refresh pending records before retrying.` };
            } catch (error) {
                console.error(`[sync] notice dismissal on ${backendId} failed`, error);
                errors[backendId] = { code: 'NOTICE_DISMISS_FAILED', message: `Could not dismiss the notice on ${backendId}. Recover this backend before retrying.` };
            }
        }
        results.push({ path: relPath, backends, committedBackends, applied: committedBackends.length === backends.length && Object.keys(errors).length === 0, ...(Object.keys(errors).length ? { errors } : {}) });
    }
    return results;
}

/**
 * Chat state requires its parent. Preserve existing preset parents too,
 * because deleting a preset explicitly cascades its state in SQL engines.
 * A parent the undo would delete under a companion that stays is kept,
 * and a companion the undo would restore under a parent deleted since the
 * sync stays as it is; both move from `reverted` to `keptEdited`.
 */
function keepCompanionsWithParents({ directories, files, next, reverted, keptEdited }) {
    const keep = (relPath) => {
        const entry = files.get(relPath);
        if (entry) next.set(relPath, entry);
        else next.delete(relPath);
        reverted.splice(reverted.indexOf(relPath), 1);
        keptEdited.push(relPath);
    };
    for (const relPath of [...next.keys()]) {
        const parent = subRecordParentPath(directories, relPath);
        if (!parent || next.has(parent) || [...next.keys()].some(other => other.startsWith(`${parent}/`))) continue;
        if (reverted.includes(parent)) keep(parent);
        else if (reverted.includes(relPath)) keep(relPath);
    }
}

async function keepEditedGroupChatOwnership({ gitdir, directories, files, next, reverted, keptEdited }) {
    const layout = chatTreeLayout(directories);
    const retained = new Set(keptEdited.filter(p => p.startsWith(`${layout.groupChatsDir}/`) && p.endsWith('.jsonl') && next.has(p))
        .map(p => p.slice(layout.groupChatsDir.length + 1, -6)));
    if (retained.size === 0) return;
    for (const [relPath, entry] of files) {
        if (!relPath.startsWith(`${layout.groupsDir}/`) || !relPath.endsWith('.json')) continue;
        const current = JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8'));
        const owned = current.chats?.filter(id => retained.has(id)) ?? [];
        if (owned.length === 0) continue;
        const selected = next.get(relPath);
        const restored = selected ? JSON.parse((await readBlobBytes({ gitdir, oid: selected.oid })).toString('utf8')) : { ...current, chats: [] };
        const chats = [...(restored.chats ?? [])];
        for (const id of owned) if (!chats.includes(id)) chats.push(id);
        const chat_id = owned.includes(current.chat_id) ? current.chat_id : chats.includes(restored.chat_id) ? restored.chat_id : chats.at(-1);
        const blob = Buffer.from(JSON.stringify({ ...restored, chats, chat_id }, null, 4));
        next.set(relPath, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob }), mode: entry.mode });
        if (reverted.includes(relPath)) {
            reverted.splice(reverted.indexOf(relPath), 1);
            if (!keptEdited.includes(relPath)) keptEdited.push(relPath);
        }
    }
}

/**
 * Revert what the last reconciling sync changed, as a forward commit.
 * Only paths still equal to what that sync wrote are reverted; the others
 * are reported in `keptEdited`. The undo point is read under the shadow
 * lock and cleared once the revert is committed, so a sync is undone at
 * most once; it is kept when a newer sync replaced it meanwhile.
 *
 * @param {LocalContext} ctx
 * @returns {Promise<{ restoredTag: string, head: string | null, committed: boolean, reverted: string[], keptEdited: string[] }>}
 */
export async function undoLastSync(ctx) {
    if (ctx.withMutation && !ctx.lease) return ctx.withMutation(leased => undoLastSync(leased));
    const lockShadow = ctx.lease ? fn => ctx.lease.withLocal(fn) : (ctx.lockShadow ?? (fn => fn()));
    let point = null;
    const reverted = [];
    const keptEdited = [];
    const result = await commitLocalEdit(ctx, async ({ gitdir, files }) => {
        point = await readUndoPoint(gitdir);
        if (!point) throw syncError('NO_BACKUP_TAG', 'There is no sync to undo');
        const [before, after] = await Promise.all([
            readCommitFiles({ gitdir, commitOid: point.base }),
            readCommitFiles({ gitdir, commitOid: point.target }),
        ].map(async promise => buildPresetIdentityView({ directories: ctx.directories, files: await promise }).files));
        const next = new Map(files);
        for (const relPath of new Set([...before.keys(), ...after.keys()])) {
            const b = before.get(relPath);
            const a = after.get(relPath);
            if (b?.oid === a?.oid && b?.mode === a?.mode) continue;
            if (files.get(relPath)?.oid !== a?.oid) {
                keptEdited.push(relPath);
                continue;
            }
            if (b) next.set(relPath, b);
            else next.delete(relPath);
            reverted.push(relPath);
        }
        keepCompanionsWithParents({ directories: ctx.directories, files, next, reverted, keptEdited });
        await keepEditedGroupChatOwnership({ gitdir, directories: ctx.directories, files, next, reverted, keptEdited });
        return { files: next, message: `undo sync ${point.tag}` };
    });
    if (result.committed) {
        await pausepoint(PAUSEPOINTS.UNDO_BEFORE_CLEANUP);
        // A sync that reconciled after this undo committed has its own undo point.
        await lockShadow(async () => {
            const current = await readUndoPoint(gitdirOf(ctx));
            if (current?.tag === point.tag && current.target === point.target) await clearUndoPoint(gitdirOf(ctx));
        });
    }
    return { restoredTag: point.tag, head: result.head, committed: result.committed, reverted: result.committed ? reverted.sort() : [], keptEdited: keptEdited.sort() };
}
