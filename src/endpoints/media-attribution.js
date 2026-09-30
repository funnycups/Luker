import { existsSync } from 'node:fs';

import sanitize from 'sanitize-filename';

import { getChatRepo } from '../storage/index.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { resolveUserImagePath } from '../media-references.js';

export const MEDIA_ATTRIBUTION_NAMESPACE = 'media-attribution';

// Uploads for the same chat can overlap; a read-modify-write without a lock
// would drop entries. Locks are per (handle, chat) and in-process.
const attributionLocks = new Map();

function withAttributionLock(key, task) {
    const previous = attributionLocks.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    attributionLocks.set(key, next.then(() => undefined, () => undefined));
    return next;
}

/**
 * @param {object} raw request.body.attribution
 * @returns {{charDir: string, chatName: string, isGroup: boolean, groupId: string|undefined}|null}
 */
export function normalizeAttributionTarget(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const chatName = sanitize(stripJsonlExt(String(raw.chat_name ?? '').trim()));
    if (!chatName) {
        return null;
    }
    const isGroup = Boolean(raw.is_group);
    return {
        charDir: isGroup ? '' : sanitize(String(raw.char_dir ?? '').trim()),
        chatName,
        isGroup,
        groupId: isGroup ? chatName : undefined,
    };
}

/**
 * Appends an uploaded image to the chat's attribution sidecar. Missing
 * chats and malformed attributions are skipped without failing the upload.
 * @returns {Promise<boolean>} whether the entry was recorded
 */
export async function appendMediaAttribution(user, attribution, clientPath, subFolder = '') {
    const target = normalizeAttributionTarget(attribution);
    if (!target || typeof clientPath !== 'string' || !clientPath) {
        return false;
    }
    const handle = user.profile.handle;
    const repo = getChatRepo();
    const lockKey = `${handle}\u0000${target.isGroup ? 'group' : 'char'}\u0000${target.charDir}\u0000${target.chatName}`;
    const options = { isGroup: target.isGroup, groupId: target.groupId };

    return withAttributionLock(lockKey, async () => {
        const existing = await repo.getInfo(handle, target.charDir, target.chatName, options);
        if (!existing) {
            return false;
        }
        const doc = await repo.getState(handle, target.charDir, target.chatName, MEDIA_ATTRIBUTION_NAMESPACE, options);
        const entries = Array.isArray(doc?.entries)
            ? doc.entries.filter(entry => entry && typeof entry.path === 'string')
            : [];
        const kept = entries
            .filter(entry => {
                const diskPath = resolveUserImagePath(user.directories.root, entry.path);
                return diskPath ? existsSync(diskPath) : false;
            })
            .filter(entry => entry.path !== clientPath);
        kept.push({ path: clientPath, ch_name: String(subFolder || ''), ts: Date.now() });
        await repo.setState(handle, target.charDir, target.chatName, MEDIA_ATTRIBUTION_NAMESPACE, { version: 1, entries: kept }, options);
        return true;
    });
}
