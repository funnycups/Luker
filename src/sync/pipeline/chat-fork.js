import crypto from 'node:crypto';
import path from 'node:path';

import git from 'isomorphic-git';
import sanitize from 'sanitize-filename';

import { buildSidecarFilename, SIDECAR_INFIX, splitSidecarFilename } from '../../storage/engines/sidecar-naming.js';
import { atomicFs } from './atomic-fs.js';
import { readBlobBytes } from './git-tree.js';

/** @typedef {import('./git-tree.js').TreeFile} TreeFile */
/** @typedef {import('./conflict-records.js').ForkNotice} ForkNotice */

export const MAX_CHAT_NAME_CHARS = 128; // cap-ok: SQL `chats.name VARCHAR(128)`, `src/storage/engines/mysql-schema.js:8-13`
export const MAX_CHAT_NAME_BYTES = 128; // cap-ok: `MAX_NAME_LEN` byte limit `assertSafeRepoName` enforces on save, `src/storage/name-validation.js`
export const MAX_FILE_NAME_BYTES = 255; // cap-ok: file name limit of ext4, APFS and NTFS

/**
 * @typedef {object} ChatLayout
 * @property {string} chatsDir
 * @property {string} groupChatsDir
 * @property {string} groupsDir
 * @property {string} charactersDir
 */

/**
 * @typedef {object} ChatPath
 * @property {'character' | 'group'} kind
 * @property {string} dir
 * @property {string} base
 * @property {string} chatPath
 * @property {string | null} avatarDir
 */
/**
 * `normalizeChatStateNamespace` in `src/endpoints/chats.js` keeps 96 ASCII
 * characters, so with a chat name of `MAX_CHAT_NAME_BYTES` every companion
 * the endpoints write fits `MAX_FILE_NAME_BYTES`. A longer namespace in a
 * tree does not shorten the branch name; its companion is skipped when its
 * file name cannot fit.
 */
const MAX_CHAT_STATE_NAMESPACE_BYTES = 96; // cap-ok: namespace length `normalizeChatStateNamespace` keeps, `src/endpoints/chats.js`

/**
 * `CHAT_SYNC_NAMESPACE` of `src/endpoints/chats.js`. Its companion holds
 * the chat integrity, which the fs engine prefers over the header, so a
 * branch starts without one, as a branch made from a bookmark does.
 */
const CHAT_SYNC_NAMESPACE = 'chat_sync';

const pad = value => String(value).padStart(2, '0');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {Date} date
 * @returns {string} local `YYYY-MM-DD HH.mm`
 */
export function formatForkTimestamp(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

/**
 * @param {Record<string, string>} directories
 * @returns {ChatLayout} POSIX paths relative to `directories.root`
 */
export function chatTreeLayout(directories) {
    const rel = abs => path.relative(directories.root, abs).split(path.sep).join('/');
    return { chatsDir: rel(directories.chats), groupChatsDir: rel(directories.groupChats), groupsDir: rel(directories.groups), charactersDir: rel(directories.characters) };
}

function chatBaseOf(fileName) {
    if (fileName.endsWith('.jsonl')) return fileName.slice(0, -'.jsonl'.length) || null;
    return splitSidecarFilename(fileName)?.base ?? null;
}

/**
 * The chat a tree path belongs to: a chat file or one of its state
 * companions, of a character or a group.
 *
 * @param {ChatLayout} layout
 * @param {string} relPath
 * @returns {ChatPath | null}
 */
export function classifyChatPath(layout, relPath) {
    const parts = relPath.split('/');
    const fileName = parts.pop();
    const dir = parts.join('/');
    const base = chatBaseOf(fileName);
    if (!base) return null;
    if (dir === layout.groupChatsDir) {
        return { kind: 'group', dir, base, chatPath: `${dir}/${base}.jsonl`, avatarDir: null };
    }
    const parentDir = parts.slice(0, -1).join('/');
    if (parts.length > 0 && parentDir === layout.chatsDir) {
        return { kind: 'character', dir, base, chatPath: `${dir}/${base}.jsonl`, avatarDir: parts[parts.length - 1] };
    }
    return null;
}

/** Names equal under this key are one file on a case-insensitive file system. */
const nameKey = name => name.normalize('NFC').toLowerCase();

/** A name part with no path separator and no state companion infix. */
function cleanNamePart(value) {
    return sanitize(String(value)).replaceAll(SIDECAR_INFIX, ' ').trim();
}

/**
 * Name of the branch chat holding the other side of a conflict, shortened
 * until the chat name fits the SQL column and the byte limit of the save
 * endpoints, and the chat file and its companion with `longestNamespace`
 * fit a file name.
 *
 * @param {{ base: string, deviceLabel: string, date: Date, taken: Set<string>, longestNamespace?: string }} args
 * @returns {string}
 */
export function branchChatBaseName({ base, deviceLabel, date, taken, longestNamespace = '' }) {
    const fits = name => [...name].length <= MAX_CHAT_NAME_CHARS
        && Buffer.byteLength(name) <= MAX_CHAT_NAME_BYTES
        && Buffer.byteLength(`${name}.jsonl`) <= MAX_FILE_NAME_BYTES
        && Buffer.byteLength(buildSidecarFilename(name, longestNamespace || 'x')) <= MAX_FILE_NAME_BYTES;
    const takenKeys = new Set([...taken].map(nameKey));
    const stamp = formatForkTimestamp(date);
    for (let n = 1; ; n++) {
        const counter = n === 1 ? '' : ` (${n})`;
        const head = [...(cleanNamePart(base) || 'chat')];
        const label = [...(cleanNamePart(deviceLabel) || 'device')];
        const build = () => `${head.join('').trim()} - Sync conflict ${label.join('').trim()} ${stamp}${counter}`;
        while (!fits(build())) {
            if (label.length > 1 && (label.length >= head.length || head.length <= 1)) label.pop();
            else if (head.length > 1) head.pop();
            else break;
        }
        const name = build();
        if (!takenKeys.has(nameKey(name))) return name;
    }
}

/**
 * Write theirs' version of `chat` and its state companions into `files`
 * as a branch chat of the same owner, and list the branch on the owning
 * group for a group chat. The branch names the chat as its main chat
 * only while `files` holds the chat.
 *
 * @param {{ gitdir: string, layout: ChatLayout, files: Map<string, TreeFile>, theirsFiles: Map<string, TreeFile>, chat: ChatPath, deviceLabel: string, date: Date }} args
 * @returns {Promise<{ branchPath: string, notice: ForkNotice } | null>} null when theirs lacks the chat
 */
export async function forkChat({ gitdir, layout, files, theirsFiles, chat, deviceLabel, date }) {
    const theirsChat = theirsFiles.get(chat.chatPath);
    if (!theirsChat) return null;
    const childName = key => (key.startsWith(`${chat.dir}/`) && !key.slice(chat.dir.length + 1).includes('/') ? key.slice(chat.dir.length + 1) : null);

    const taken = new Set();
    for (const key of files.keys()) {
        const name = childName(key);
        const base = name === null ? null : chatBaseOf(name);
        if (base) taken.add(base);
    }
    const companions = [];
    for (const [key, entry] of theirsFiles) {
        const name = childName(key);
        const split = name === null ? null : splitSidecarFilename(name);
        if (split?.base === chat.base && split.namespace !== CHAT_SYNC_NAMESPACE) companions.push({ namespace: split.namespace, entry });
    }
    const longestNamespace = companions
        .filter(c => Buffer.byteLength(c.namespace) <= MAX_CHAT_STATE_NAMESPACE_BYTES)
        .reduce((longest, c) => (Buffer.byteLength(c.namespace) > Buffer.byteLength(longest) ? c.namespace : longest), '');
    const branch = branchChatBaseName({ base: chat.base, deviceLabel, date, taken, longestNamespace });
    const branchPath = `${chat.dir}/${branch}.jsonl`;

    files.set(branchPath, { oid: await writeBranchChatBlob(gitdir, theirsChat.oid, files.has(chat.chatPath) ? chat.base : null, branch), mode: theirsChat.mode });
    for (const { namespace, entry } of companions) {
        const fileName = buildSidecarFilename(branch, namespace);
        if (Buffer.byteLength(fileName) <= MAX_FILE_NAME_BYTES) files.set(`${chat.dir}/${fileName}`, entry);
    }

    const target = chat.kind === 'character'
        ? { kind: 'character', avatar: `${chat.avatarDir}.png`, name: branch }
        : { kind: 'group', groupId: await listBranchOnOwningGroup({ gitdir, layout, files, chatId: chat.base, branch }), name: branch };
    return { branchPath, notice: { kind: 'fork', chat: chat.chatPath, device: deviceLabel, createdAt: date.toISOString(), target } };
}

/**
 * The notice target naming `chat` itself, with the group of `files` that
 * lists a group chat.
 *
 * @param {{ gitdir: string, layout: ChatLayout, files: Map<string, TreeFile>, chat: ChatPath }} args
 * @returns {Promise<import('./conflict-records.js').NoticeTarget>}
 */
export async function chatNoticeTarget({ gitdir, layout, files, chat }) {
    if (chat.kind === 'character') return { kind: 'character', avatar: `${chat.avatarDir}.png`, name: chat.base };
    const owner = await findOwningGroup({ gitdir, layout, files, chatId: chat.base });
    return { kind: 'group', groupId: owner?.id ?? null, name: chat.base };
}

/**
 * A UUID-shaped integrity value derived from `seed`, so two devices
 * forking the same chat into the same branch write the same file.
 *
 * @param {string} seed
 * @returns {string}
 */
function integrityFor(seed) {
    const hex = crypto.createHash('sha256').update(seed).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function writeBranchChatBlob(gitdir, oid, mainChat, branch) {
    const text = (await readBlobBytes({ gitdir, oid })).toString('utf8');
    const newline = text.indexOf('\n');
    const first = newline === -1 ? text : text.slice(0, newline);
    let header;
    try {
        header = JSON.parse(first);
    } catch {
        return oid;
    }
    if (!isObject(header)) return oid;
    const metadata = isObject(header.chat_metadata) ? header.chat_metadata : {};
    header.chat_metadata = { ...metadata, ...(mainChat === null ? {} : { main_chat: mainChat }), integrity: integrityFor(`${oid}\u0000${branch}`) };
    const rest = newline === -1 ? '' : text.slice(newline);
    return git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(`${JSON.stringify(header)}${rest}`) });
}

async function findOwningGroup({ gitdir, layout, files, chatId }) {
    const groups = [];
    for (const [key, entry] of files) {
        if (!key.startsWith(`${layout.groupsDir}/`) || !key.endsWith('.json')) continue;
        const fileName = key.slice(layout.groupsDir.length + 1);
        if (fileName.includes('/')) continue;
        let group;
        try {
            group = JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8'));
        } catch {
            continue;
        }
        if (isObject(group)) groups.push({ key, entry, group, id: typeof group.id === 'string' ? group.id : fileName.slice(0, -'.json'.length) });
    }
    return groups.find(g => Array.isArray(g.group.chats) && g.group.chats.includes(chatId))
        ?? groups.find(g => g.group.chat_id === chatId)
        ?? null;
}

async function listBranchOnOwningGroup({ gitdir, layout, files, chatId, branch }) {
    const owner = await findOwningGroup({ gitdir, layout, files, chatId });
    if (!owner) return null;
    const oid = await writeGroupBlob(gitdir, withChatsListed(owner.group, [branch]));
    files.set(owner.key, { oid, mode: owner.entry.mode });
    return owner.id;
}

/**
 * List `chatId` on the group of `files` that lists it in `ownerFiles`,
 * the side that kept the chat. When `files` lacks that group file, the
 * kept group file is put back: a SQL engine stores only the group chats a
 * group lists, so a restored chat without its group would be dropped.
 * `deleted` tells whether the deleting side deleted the group with the
 * chat, meaning base held the group file and `deleterFiles` lacks it,
 * whichever side the merged tree took it from.
 *
 * @param {{ gitdir: string, layout: ChatLayout, files: Map<string, TreeFile>, ownerFiles: Map<string, TreeFile>, baseFiles: Map<string, TreeFile>, deleterFiles: Map<string, TreeFile>, chatId: string }} args
 * @returns {Promise<{ path: string, deleted: boolean } | null>} the group file, null when no group on the keeping side lists the chat
 */
export async function listChatOnOwningGroup({ gitdir, layout, files, ownerFiles, baseFiles, deleterFiles, chatId }) {
    const owner = await findOwningGroup({ gitdir, layout, files: ownerFiles, chatId });
    if (!owner) return null;
    const result = { path: owner.key, deleted: baseFiles.has(owner.key) && !deleterFiles.has(owner.key) };
    const entry = files.get(owner.key);
    if (!entry) {
        files.set(owner.key, owner.entry);
        return result;
    }
    let group;
    try {
        group = JSON.parse((await readBlobBytes({ gitdir, oid: entry.oid })).toString('utf8'));
    } catch {
        return result;
    }
    if (isObject(group) && !(Array.isArray(group.chats) && group.chats.includes(chatId))) {
        files.set(owner.key, { oid: await writeGroupBlob(gitdir, withChatsListed(group, [chatId])), mode: entry.mode });
    }
    return result;
}

function withChatsListed(group, chatIds) {
    const chats = Array.isArray(group.chats) ? group.chats : [group.chat_id];
    return { ...group, chats: [...chats, ...chatIds.filter(id => !chats.includes(id))] };
}

function writeGroupBlob(gitdir, group) {
    // The fs engine's group document format, `src/storage/engines/fs-engine-transaction.js:318`.
    return git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(JSON.stringify(group, null, 4)) });
}
