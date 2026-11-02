import git from 'isomorphic-git';

import { getShadowPaths } from '../shadow.js';
import { atomicFs } from './atomic-fs.js';
import { CONFLICTS_PATH, NOTICES_PATH, readEntries } from './conflict-records.js';
import { MAIN_REF } from './cycle.js';
import { blobOidOf, readCommitFiles } from './git-tree.js';
import { buildPresetIdentityView, resolvePresetChoicePath } from '../preset-projection.js';

export const conflictRecordVersion = record => blobOidOf(Buffer.from(JSON.stringify(record)));

/**
 * @typedef {object} PendingConflict
 * @property {string} path
 * @property {string} backendId backend of the newest `createdAt`
 * @property {string[]} backends every backend that records the path
 * @property {string | null} kept
 * @property {string | null} ours
 * @property {string | null} theirs
 * @property {string | null} current blob of the path at HEAD of `backendId`
 * @property {Record<string, string>} recordVersions record fingerprint per reporting backend
 * @property {Record<string, string | null>} currentVersions current blob per reporting backend
 * @property {boolean} stale true when HEAD of any reporting backend no longer holds its `kept`
 * @property {string} oursDevice
 * @property {string} theirsDevice
 * @property {string} createdAt
 */

/**
 * @typedef {object} PendingNotice
 * @property {string} path
 * @property {string} backendId
 * @property {string[]} backends
 * @property {'fork' | 'restored'} kind
 * @property {string} [chat] the chat a fork branched from
 * @property {string} device
 * @property {string} [deletedBy] the device that deleted a restored chat
 * @property {string} createdAt
 * @property {import('./conflict-records.js').NoticeTarget} target
 */

async function mainFilesOf(ctx) {
    const { gitDir } = getShadowPaths({ userRoot: ctx.userRoot, peerId: ctx.backendId });
    let main = null;
    try {
        main = await git.resolveRef({ fs: atomicFs, gitdir: gitDir, ref: MAIN_REF });
    } catch (error) {
        if (error.code !== 'NotFoundError') throw error;
    }
    return { gitdir: gitDir, files: main ? await readCommitFiles({ gitdir: gitDir, commitOid: main }) : new Map() };
}

function group(target, backendId, item) {
    const existing = target.get(item.path);
    if (!existing) {
        target.set(item.path, { ...item, backendId, backends: [backendId] });
        return;
    }
    existing.backends.push(backendId);
    const recordVersions = { ...existing.recordVersions, ...item.recordVersions };
    const currentVersions = { ...existing.currentVersions, ...item.currentVersions };
    const stale = Boolean(existing.stale || item.stale);
    if (String(item.createdAt) > String(existing.createdAt)) Object.assign(existing, item, { backendId, backends: existing.backends });
    if ('stale' in existing) existing.stale = stale;
    if (item.recordVersions) existing.recordVersions = recordVersions;
    if (item.currentVersions) existing.currentVersions = currentVersions;
}

/**
 * Conflict records and notices on main of every backend of one owner,
 * one entry per path, each sorted by path. A backend whose main cannot be
 * read reports an error while readable backends remain available.
 *
 * @param {Map<string, Omit<import('./cycle.js').CycleContext, 'backend'>>} ctxByBackend
 * @returns {Promise<{ conflicts: PendingConflict[], notices: PendingNotice[], errors: object, conflictSources: Map<string, Map<string, { record: object, current: string | null }>> }>}
 */
export async function readPendingState(ctxByBackend) {
    const conflicts = new Map();
    const notices = new Map();
    const conflictSources = new Map();
    const errors = {};
    for (const [backendId, ctx] of ctxByBackend) {
        let side;
        let records;
        let pending;
        let rows;
        try {
            const read = async () => {
                side = await mainFilesOf(ctx);
                records = await readEntries({ gitdir: side.gitdir, files: side.files, path: CONFLICTS_PATH, kind: 'conflicts' });
                pending = await readEntries({ gitdir: side.gitdir, files: side.files, path: NOTICES_PATH, kind: 'notices' });
                const view = buildPresetIdentityView({ directories: ctx.directories, files: side.files });
                rows = Object.entries(records).map(([relPath, record]) => ({ relPath, record, current: side.files.get(resolvePresetChoicePath({ directories: ctx.directories, files: side.files, recordPath: relPath, view }))?.oid ?? null }));
            };
            if (ctx.withRead) await ctx.withRead(read);
            else await read();
        } catch (error) {
            console.warn(`[sync] could not read pending records of ${backendId}`, error);
            errors[backendId] = { code: 'PENDING_READ_FAILED', message: 'Could not read pending sync records.' };
            continue;
        }
        conflictSources.set(backendId, new Map(rows.map(({ relPath, record, current }) => [relPath, { record, current }])));
        for (const { relPath, record, current } of rows) {
            const { kept, ours, theirs, oursDevice, theirsDevice, createdAt } = record;
            group(conflicts, backendId, { path: relPath, kept, ours, theirs, current, stale: current !== kept, oursDevice, theirsDevice, createdAt, recordVersions: { [backendId]: conflictRecordVersion(record) }, currentVersions: { [backendId]: current } });
        }
        for (const [relPath, entry] of Object.entries(pending)) group(notices, backendId, { path: relPath, ...entry });
    }
    const byPath = (a, b) => a.path.localeCompare(b.path);
    return { conflicts: [...conflicts.values()].sort(byPath), notices: [...notices.values()].sort(byPath), errors, conflictSources };
}
