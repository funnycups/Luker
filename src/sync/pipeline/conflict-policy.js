import git from 'isomorphic-git';

import { splitSidecarFilename } from '../../storage/engines/sidecar-naming.js';
import { atomicFs } from './atomic-fs.js';
import { chatIdsByRecency, chooseChatId, mergeCharacterCards, mergeGroupDocuments } from './bookkeeping-merge.js';
import { chatNoticeTarget, chatTreeLayout, classifyChatPath, forkChat, listChatOnOwningGroup } from './chat-fork.js';
import { CONFLICTS_PATH, NOTICES_PATH, mergeEntryMaps, readEntries, writeEntries } from './conflict-records.js';
import { readBlobBytes, readCommitFiles } from './git-tree.js';
import { mergeStatsDocuments, STATS_PATH } from './stats-merge.js';
import { IMAGE_METADATA_PATH, mergeImageMetadataDocuments } from './image-metadata-merge.js';
import { serializeImageMetadataIndex } from '../../image-metadata-index.js';
import { deviceLabelForCommit } from './commit-provenance.js';
import { buildPresetIdentityView } from '../preset-projection.js';

/** @typedef {import('./git-tree.js').TreeFile} TreeFile */
/** @typedef {import('../conflicts.js').ConflictEntry} ConflictEntry */

/**
 * @callback OnConflictsHook
 * @param {{ gitdir: string, base: string | null, ours: string, theirs: string, files: Map<string, TreeFile>, conflicts: ConflictEntry[], oursIsLocal?: boolean }} args
 * @returns {Promise<{ files: Map<string, TreeFile>, conflicts: ConflictEntry[] }>}
 */

/**
 * Resolve the conflicts of a tree merge in place. Conflicting record
 * files merge entry by entry and stats.json merges by counter; neither is
 * reported. Group files and character cards both sides changed merge
 * their bookkeeping fields (see `bookkeeping-merge.js`), and
 * image-metadata.json merges by image and folder
 * (see `image-metadata-merge.js`); each is reported only when a field
 * both sides changed conflicts. A chat one side deleted that the
 * other side kept is kept whole from the keeping side, with its state
 * companions and a listing in its group, and gets a restored notice; a
 * group the other side deleted with it is kept from the keeping side
 * without a record. Any other conflict on a chat or one of its state
 * companions forks theirs' chat into a branch chat with a notice; when
 * theirs lacks the chat, its conflicts are recorded like any other. Every other conflict keeps the
 * merged entry and gets a conflict record whose `kept` is the final blob,
 * after forks and restores have rewritten group files.
 *
 * Records and branch names carry the label of the device each side came
 * from and, unless `now` is given, the time of the newer side's commit,
 * so two devices resolving the same merge write the same files.
 *
 * @param {{ directories: Record<string, string>, now?: () => Date }} args
 * @returns {OnConflictsHook} the returned `conflicts` lists only the entries that received a record
 */
export function createConflictPolicy({ directories, now }) {
    const layout = chatTreeLayout(directories);
    return async function applyConflictPolicy({ gitdir, base, ours, theirs, files, conflicts }) {
        const [oursDevice, theirsDevice] = await Promise.all([ours, theirs].map(oid => deviceLabelForCommit({ gitdir, oid })));
        const date = now ? now() : await newerCommitDate(gitdir, [ours, theirs]);
        const createdAt = date.toISOString();
        const isRecordFile = c => c.filepath === CONFLICTS_PATH || c.filepath === NOTICES_PATH;
        const isStats = c => c.filepath === STATS_PATH;
        const userFacing = conflicts.filter(c => !isRecordFile(c) && !isStats(c));
        const chatConflicts = userFacing.filter(c => classifyChatPath(layout, c.filepath));
        const [baseFiles, oursFiles, theirsFiles] = await Promise.all(
            [base, ours, theirs].map(async commitOid => buildPresetIdentityView({ directories, files: await readCommitFiles({ gitdir, commitOid }) }).files),
        );

        const entriesFor = async (recordPath, kind) => {
            if (!conflicts.some(c => c.filepath === recordPath)) return readEntries({ gitdir, files, path: recordPath, kind });
            const [b, o, t] = await Promise.all([baseFiles, oursFiles, theirsFiles].map(side => readEntries({ gitdir, files: side, path: recordPath, kind })));
            return mergeEntryMaps(b, o, t);
        };
        const records = await entriesFor(CONFLICTS_PATH, 'conflicts');
        const notices = await entriesFor(NOTICES_PATH, 'notices');

        if (conflicts.some(isStats)) {
            const docOf = async side => {
                const entry = side.get(STATS_PATH);
                if (!entry) return null;
                try {
                    return JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8'));
                } catch {
                    return null;
                }
            };
            const merged = mergeStatsDocuments(await docOf(baseFiles), await docOf(oursFiles), await docOf(theirsFiles));
            const oid = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(JSON.stringify(merged, null, 4)) });
            files.set(STATS_PATH, { oid, mode: '100644' });
        }

        const bytesOf = async (side, relPath) => {
            const entry = side.get(relPath);
            return entry ? readBlobBytes({ gitdir, oid: entry.oid }) : null;
        };
        const parseJson = bytes => {
            try {
                return bytes ? JSON.parse(bytes.toString('utf8')) : null;
            } catch {
                return null;
            }
        };
        /** Merge the bookkeeping of a conflict; true when no field remains in conflict. */
        const mergeBookkeeping = async ({ filepath }) => {
            const sides = await Promise.all([baseFiles, oursFiles, theirsFiles].map(side => bytesOf(side, filepath)));
            let merged = null;
            if (isGroupDocumentPath(layout, filepath)) {
                const doc = mergeGroupDocuments(...sides.map(parseJson));
                if (doc) merged = { bytes: Buffer.from(JSON.stringify(doc.value, null, 4)), conflicted: doc.conflicted };
            } else if (isCharacterCardPath(layout, filepath)) {
                merged = mergeCharacterCards(...sides);
            } else if (filepath === IMAGE_METADATA_PATH) {
                const doc = mergeImageMetadataDocuments(...sides.map(parseJson));
                if (doc) merged = { bytes: Buffer.from(serializeImageMetadataIndex(doc.value)), conflicted: doc.conflicted };
            }
            if (!merged) return false;
            files.set(filepath, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: merged.bytes }), mode: oursFiles.get(filepath).mode });
            return !merged.conflicted;
        };
        const recorded = [];
        for (const conflict of userFacing.filter(c => !classifyChatPath(layout, c.filepath))) {
            if (conflict.kind === 'bothModified' && await mergeBookkeeping(conflict)) continue;
            recorded.push(conflict);
        }

        const handled = new Set();
        const restoredGroups = new Set();
        /** Group file path → ids of the chats restored onto it. */
        const restoredChats = new Map();
        for (const conflict of chatConflicts) {
            const chat = classifyChatPath(layout, conflict.filepath);
            if (handled.has(chat.chatPath)) continue;
            handled.add(chat.chatPath);
            const oursKept = oursFiles.has(chat.chatPath);
            if (baseFiles.has(chat.chatPath) && oursKept !== theirsFiles.has(chat.chatPath)) {
                const [keeperFiles, deleterFiles] = oursKept ? [oursFiles, theirsFiles] : [theirsFiles, oursFiles];
                keepChatWhole(files, keeperFiles, chat);
                if (chat.kind === 'group') {
                    const group = await listChatOnOwningGroup({ gitdir, layout, files, ownerFiles: keeperFiles, baseFiles, deleterFiles, chatId: chat.base });
                    if (group?.deleted) restoredGroups.add(group.path);
                    if (group) restoredChats.set(group.path, [...(restoredChats.get(group.path) ?? []), chat.base]);
                }
                const [device, deletedBy] = oursKept ? [oursDevice, theirsDevice] : [theirsDevice, oursDevice];
                notices[chat.chatPath] = { kind: 'restored', device, deletedBy, createdAt, target: await chatNoticeTarget({ gitdir, layout, files, chat }) };
                continue;
            }
            const result = await forkChat({ gitdir, layout, files, theirsFiles, chat, deviceLabel: theirsDevice, date });
            if (!result) {
                recorded.push(...chatConflicts.filter(c => classifyChatPath(layout, c.filepath).chatPath === chat.chatPath));
                continue;
            }
            notices[result.branchPath] = result.notice;
        }

        await settleGroupChats({ gitdir, layout, files, baseFiles, oursFiles, theirsFiles, restoredChats });

        // Restoring a chat undoes the deletion of the group it was deleted with.
        const toRecord = recorded.filter(c => !restoredGroups.has(c.filepath));
        for (const conflict of toRecord) {
            records[conflict.filepath] = {
                kept: files.get(conflict.filepath)?.oid ?? null,
                ours: conflict.oursOid,
                theirs: conflict.theirsOid,
                oursDevice,
                theirsDevice,
                mergeParents: [ours, theirs],
                createdAt,
            };
        }
        await writeEntries({ gitdir, files, path: CONFLICTS_PATH, entries: records });
        await writeEntries({ gitdir, files, path: NOTICES_PATH, entries: notices });
        return { files, conflicts: toRecord };
    };
}

/**
 * @param {string} gitdir
 * @param {Array<string | null>} oids
 * @returns {Promise<Date>} committer time of the newest commit among `oids`
 */
async function newerCommitDate(gitdir, oids) {
    const commits = await Promise.all(oids.filter(Boolean).map(oid => git.readCommit({ fs: atomicFs, gitdir, oid })));
    return new Date(Math.max(...commits.map(({ commit }) => commit.committer.timestamp)) * 1000);
}

/**
 * Every group file this merge wrote or put back drops the chats whose
 * file base, ours or theirs held and the merged tree lacks; a chat never
 * saved stays listed, since a new group and a new group chat list their
 * chat before its file exists. Its `chat_id` is then chosen again against
 * that list: the chat of the side that chatted later, then of the other
 * side, then a chat restored onto it, then the last listed chat. Without
 * this a group could list a chat deleted with it and open as an empty
 * greeting chat; a SQL engine stores only the group chats a group lists.
 */
async function settleGroupChats({ gitdir, layout, files, baseFiles, oursFiles, theirsFiles, restoredChats }) {
    const docOf = async entry => {
        if (!entry) return null;
        try {
            return JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8'));
        } catch {
            return null;
        }
    };
    for (const [key, entry] of [...files]) {
        if (!isGroupDocumentPath(layout, key)) continue;
        const fromSide = entry.oid === oursFiles.get(key)?.oid || entry.oid === theirsFiles.get(key)?.oid;
        if (fromSide && !restoredChats.has(key)) continue;
        const doc = await docOf(entry);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.chats)) continue;
        const chatPath = id => `${layout.groupChatsDir}/${id}.jsonl`;
        const everSaved = id => [baseFiles, oursFiles, theirsFiles].some(side => side.has(chatPath(id)));
        const chats = doc.chats.filter(id => files.has(chatPath(id)) || !everSaved(id));
        const byRecency = chatIdsByRecency(await docOf(oursFiles.get(key)), await docOf(theirsFiles.get(key)));
        const chatId = chooseChatId([...(byRecency ?? [doc.chat_id]), ...(restoredChats.get(key) ?? []), doc.chat_id], chats);
        if (chatId === doc.chat_id && chats.length === doc.chats.length) continue;
        const settled = { ...doc, chats };
        if (chatId === undefined) delete settled.chat_id;
        else settled.chat_id = chatId;
        files.set(key, { oid: await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(JSON.stringify(settled, null, 4)) }), mode: entry.mode });
    }
}

const directChild = (dir, relPath) => relPath.startsWith(`${dir}/`) && !relPath.slice(dir.length + 1).includes('/');

/** @param {import('./chat-fork.js').ChatLayout} layout */
function isGroupDocumentPath(layout, relPath) {
    return directChild(layout.groupsDir, relPath) && relPath.endsWith('.json');
}

/** @param {import('./chat-fork.js').ChatLayout} layout */
function isCharacterCardPath(layout, relPath) {
    return directChild(layout.charactersDir, relPath) && relPath.toLowerCase().endsWith('.png');
}

/**
 * Put the chat file and every state companion of `chat` from
 * `keeperFiles` into `files`, so the chat is kept as that side has it.
 */
function keepChatWhole(files, keeperFiles, chat) {
    for (const [key, entry] of keeperFiles) {
        if (!directChild(chat.dir, key)) continue;
        if (key === chat.chatPath || splitSidecarFilename(key.slice(chat.dir.length + 1))?.base === chat.base) files.set(key, entry);
    }
}
