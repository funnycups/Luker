import { isDeepStrictEqual } from 'node:util';
import git from 'isomorphic-git';

import { atomicFs } from './atomic-fs.js';
import { isUnsafeTreePath, readBlobBytes, SYNC_METADATA_DIR } from './git-tree.js';

export const CONFLICTS_PATH = `${SYNC_METADATA_DIR}/conflicts.json`;
export const NOTICES_PATH = `${SYNC_METADATA_DIR}/notices.json`;

/** @typedef {import('./git-tree.js').TreeFile} TreeFile */

/**
 * @typedef {object} ConflictRecord
 * @property {string | null} kept
 * @property {string | null} ours
 * @property {string | null} theirs
 * @property {string} oursDevice
 * @property {string} theirsDevice
 * @property {string[]} mergeParents
 * @property {string} createdAt
 */

/** @typedef {{ kind: 'character', avatar: string, name: string } | { kind: 'group', groupId: string | null, name: string }} NoticeTarget */

/**
 * A branch chat holding the other side of a chat conflict, keyed by the
 * branch path. A notice without a `kind` reads as a fork.
 *
 * @typedef {object} ForkNotice
 * @property {'fork'} kind
 * @property {string} chat
 * @property {string} device
 * @property {string} createdAt
 * @property {NoticeTarget} target
 */

/**
 * A chat one side of a merge deleted that the merge kept with the other
 * side's content, keyed by the chat path.
 *
 * @typedef {object} RestoredNotice
 * @property {'restored'} kind
 * @property {string} device the device that kept the chat
 * @property {string} [deletedBy] the device that deleted the chat; absent in older notices
 * @property {string} createdAt
 * @property {NoticeTarget} target
 */

const OID_PATTERN = /^[0-9a-f]{40}$/;

const isOid = value => typeof value === 'string' && OID_PATTERN.test(value);
const isOidOrNull = value => value === null || isOid(value);
const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function isRecordPath(value) {
    return isString(value) && !isUnsafeTreePath(value) && value.split('/')[0] !== SYNC_METADATA_DIR;
}

function ownValue(map, key) {
    return Object.hasOwn(map, key) ? map[key] : undefined;
}

function conflictRecordFrom(value) {
    if (!isObject(value)) return null;
    const { kept, ours, theirs, oursDevice, theirsDevice, mergeParents, createdAt } = value;
    if (![kept, ours, theirs].every(isOidOrNull)) return null;
    if (![oursDevice, theirsDevice, createdAt].every(isString)) return null;
    if (!Array.isArray(mergeParents) || !mergeParents.every(isOid)) return null;
    return { kept, ours, theirs, oursDevice, theirsDevice, mergeParents: [...mergeParents], createdAt };
}

function noticeTargetFrom(target) {
    if (!isObject(target)) return null;
    if (target.kind === 'character') {
        return isString(target.avatar) && isString(target.name) ? { kind: 'character', avatar: target.avatar, name: target.name } : null;
    }
    if (target.kind === 'group') {
        return (target.groupId === null || isString(target.groupId)) && isString(target.name)
            ? { kind: 'group', groupId: target.groupId, name: target.name }
            : null;
    }
    return null;
}

function noticeFrom(value) {
    if (!isObject(value)) return null;
    const { kind = 'fork', chat, device, createdAt } = value;
    if (!isString(device) || !isString(createdAt)) return null;
    const target = noticeTargetFrom(value.target);
    if (!target) return null;
    if (kind === 'fork') return isRecordPath(chat) ? { kind, chat, device, createdAt, target } : null;
    if (kind === 'restored') {
        if (value.deletedBy === undefined) return { kind, device, createdAt, target };
        return isString(value.deletedBy) ? { kind, device, deletedBy: value.deletedBy, createdAt, target } : null;
    }
    return null;
}

const ENTRY_VALIDATORS = { conflicts: conflictRecordFrom, notices: noticeFrom };

/**
 * Entries of a record file. Only absent bytes read as no entries;
 * an entry whose key is not a safe user-data path or whose value does not
 * match `kind` is dropped. An unknown `kind` throws.
 *
 * @param {Buffer | null} bytes
 * @param {'conflicts' | 'notices'} kind
 * @param {{ path?: string, oid?: string }} [context]
 * @returns {Record<string, object>}
 */
export function parseEntries(bytes, kind, context = {}) {
    if (!Object.hasOwn(ENTRY_VALIDATORS, kind)) throw new Error(`unknown sync record kind: ${kind}`);
    const validate = ENTRY_VALIDATORS[kind];
    if (bytes == null) return {};
    const invalid = detail => Object.assign(new Error(`Invalid ${kind} envelope at ${context.path ?? (kind === 'conflicts' ? CONFLICTS_PATH : NOTICES_PATH)}${context.oid ? ` object ${context.oid}` : ''}: ${detail}; restore the pending document before retrying`), { code: 'PENDING_DOCUMENT_INVALID' });
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
        throw invalid('malformed JSON');
    }
    if (!isObject(parsed) || !isObject(parsed.entries)) {
        throw invalid('expected an object containing an entries object');
    }
    const kept = [];
    let dropped = 0;
    for (const [key, value] of Object.entries(parsed.entries)) {
        const entry = isRecordPath(key) ? validate(value) : null;
        if (entry) kept.push([key, entry]);
        else dropped++;
    }
    if (dropped > 0) console.warn(`[sync] dropped ${dropped} invalid ${kind} record entr${dropped === 1 ? 'y' : 'ies'}`);
    return Object.fromEntries(kept);
}

/**
 * @param {Record<string, object>} entries
 * @returns {Buffer}
 */
export function serializeEntries(entries) {
    const sorted = Object.fromEntries(Object.keys(entries).sort().map(key => [key, entries[key]]));
    return Buffer.from(`${JSON.stringify({ entries: sorted }, null, 2)}\n`);
}

/**
 * Three-way merge of entry maps. An entry removed on either side is
 * removed. An entry changed on one side takes that side; changed or added
 * on both sides with different content, the later `createdAt` wins and
 * ours wins a tie.
 *
 * @param {Record<string, object>} base
 * @param {Record<string, object>} ours
 * @param {Record<string, object>} theirs
 * @returns {Record<string, object>}
 */
export function mergeEntryMaps(base, ours, theirs) {
    const out = [];
    const later = (o, t) => (String(t.createdAt) > String(o.createdAt) ? t : o);
    for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
        const b = ownValue(base, key);
        const o = ownValue(ours, key);
        const t = ownValue(theirs, key);
        if (b !== undefined) {
            if (o === undefined || t === undefined) continue;
            out.push([key, isDeepStrictEqual(o, b) ? t : isDeepStrictEqual(t, b) ? o : later(o, t)]);
        } else if (o !== undefined && t !== undefined) {
            out.push([key, isDeepStrictEqual(o, t) ? o : later(o, t)]);
        } else {
            out.push([key, o ?? t]);
        }
    }
    return Object.fromEntries(out);
}

/**
 * @param {{ gitdir: string, files: Map<string, TreeFile>, path: string, kind: 'conflicts' | 'notices' }} args
 * @returns {Promise<Record<string, object>>}
 */
export async function readEntries({ gitdir, files, path, kind }) {
    const file = files.get(path);
    return parseEntries(file ? await readBlobBytes({ gitdir, oid: file.oid }) : null, kind, { path, oid: file?.oid });
}

/**
 * Store `entries` at `path` in `files`, or remove `path` when empty.
 *
 * @param {{ gitdir: string, files: Map<string, TreeFile>, path: string, entries: Record<string, object> }} args
 */
export async function writeEntries({ gitdir, files, path, entries }) {
    if (Object.keys(entries).length === 0) {
        files.delete(path);
        return;
    }
    const oid = await git.writeBlob({ fs: atomicFs, gitdir, blob: serializeEntries(entries) });
    files.set(path, { oid, mode: '100644' });
}
