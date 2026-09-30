import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import express from 'express';
import sanitize from 'sanitize-filename';

import { getChatRepo } from '../storage/index.js';
import { stripJsonlExt } from '../storage/name-validation.js';
import { clientRelativePath, isPathUnderParent } from '../util.js';
import { extractLocalMediaPaths, resolveUserImagePath } from '../media-references.js';
import { readCharacterFolderName, isCharacterFolderNameShared } from '../character-assets.js';
import { MEDIA_ATTRIBUTION_NAMESPACE } from './media-attribution.js';

export const router = express.Router();

const SAME_NAME_NOTE = 'same_name_shared_folder_skipped';

function toRepoOptions(target) {
    return { isGroup: target.isGroup, groupId: target.groupId };
}

/**
 * Client-relative paths referenced by one chat: the upload-time sidecar
 * index plus everything the raw text scanner finds (format-agnostic).
 * @returns {Promise<string[]>}
 */
async function collectChatReferencedClientPaths(handle, target) {
    const repo = getChatRepo();
    const options = toRepoOptions(target);
    const chat = await repo.get(handle, target.charDir, target.chatName, options);
    if (!chat) {
        return [];
    }
    const state = await repo.getState(handle, target.charDir, target.chatName, MEDIA_ATTRIBUTION_NAMESPACE, options);
    const indexed = Array.isArray(state?.entries)
        ? state.entries.map(entry => entry?.path).filter(p => typeof p === 'string' && p)
        : [];
    const lines = [JSON.stringify(chat.header ?? {})];
    for (const message of Array.isArray(chat.body) ? chat.body : []) {
        lines.push(JSON.stringify(message));
    }
    const scanned = extractLocalMediaPaths(lines.join('\n'));
    return [...new Set([...indexed, ...scanned])];
}

/**
 * Normalizes client paths into existing files under user/images.
 * @returns {Promise<Array<{path: string, size: number}>>}
 */
async function toExistingItems(userRoot, clientPaths) {
    const seen = new Set();
    const items = [];
    for (const clientPath of clientPaths) {
        const diskPath = resolveUserImagePath(userRoot, clientPath);
        if (!diskPath || seen.has(diskPath)) {
            continue;
        }
        seen.add(diskPath);
        const stat = await fsPromises.stat(diskPath).catch(() => null);
        if (!stat?.isFile()) {
            continue;
        }
        items.push({ path: clientRelativePath(userRoot, diskPath), size: stat.size });
    }
    return items.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectFilesUnder(dirAbs, out) {
    const entries = await fsPromises.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const entryPath = path.join(dirAbs, entry.name);
        if (entry.isDirectory()) {
            await collectFilesUnder(entryPath, out);
        } else if (entry.isFile()) {
            out.push(entryPath);
        }
    }
    return out;
}

/**
 * Candidate files for a character: its name-keyed gallery + sprite folders
 * (skipped when another card shares the sanitized name) plus every file its
 * chats reference.
 * @returns {Promise<{images: Array<{path: string, size: number}>, sprites: Array<{path: string, size: number}>, notes: string[]}>}
 */
export async function collectCharacterCandidates(user, avatar) {
    const handle = user.profile.handle;
    const dirs = user.directories;
    const userRoot = dirs.root;
    const images = new Map();
    const sprites = new Map();
    const notes = [];

    const avatarFile = sanitize(String(avatar || '').trim());
    const cardPath = path.join(dirs.characters, avatarFile);
    const folderName = path.extname(avatarFile).toLowerCase() === '.png'
        ? await readCharacterFolderName(cardPath)
        : '';
    const shared = folderName
        ? await isCharacterFolderNameShared(dirs.characters, folderName, { excludeAvatars: [avatarFile] })
        : false;

    if (folderName && !shared) {
        const galleryDir = path.join(dirs.userImages, folderName);
        for (const filePath of await collectFilesUnder(galleryDir, [])) {
            images.set(filePath, filePath);
        }
        const spriteDir = path.join(dirs.characters, folderName);
        for (const filePath of await collectFilesUnder(spriteDir, [])) {
            sprites.set(filePath, filePath);
        }
    } else if (shared) {
        notes.push(SAME_NAME_NOTE);
    }

    const charDir = avatarFile.replace(/\.png$/i, '');
    if (charDir) {
        const repo = getChatRepo();
        for (const entry of await repo.listForCharacter(handle, charDir)) {
            const target = { charDir, chatName: entry.key.name, isGroup: false, groupId: undefined };
            for (const clientPath of await collectChatReferencedClientPaths(handle, target)) {
                const diskPath = resolveUserImagePath(userRoot, clientPath);
                if (diskPath) {
                    images.set(diskPath, diskPath);
                }
            }
        }
    }

    const withStats = async (paths) => {
        const items = [];
        for (const diskPath of paths) {
            const stat = await fsPromises.stat(diskPath).catch(() => null);
            if (!stat?.isFile()) {
                continue;
            }
            items.push({ path: clientRelativePath(userRoot, diskPath), size: stat.size });
        }
        return items.sort((a, b) => a.path.localeCompare(b.path));
    };

    const groups = [];
    const imageItems = await withStats([...images.values()]);
    const spriteItems = await withStats([...sprites.values()]);
    if (imageItems.length) groups.push({ kind: 'image', items: imageItems });
    if (spriteItems.length) groups.push({ kind: 'sprite', items: spriteItems });
    return { groups, notes };
}

router.post('/deletion-candidates', async (request, response) => {
    try {
        const scope = String(request.body?.scope || '');
        if (scope === 'chat') {
            const rawCharDir = String(request.body?.char_dir || '').trim();
            const rawChatName = String(request.body?.chat_name || '').trim();
            const isGroup = Boolean(request.body?.is_group);
            if (!rawChatName) {
                return response.status(400).send({ error: 'chat_name is required' });
            }
            const chatName = sanitize(stripJsonlExt(rawChatName));
            const charDir = isGroup ? '' : sanitize(rawCharDir);
            const target = { charDir, chatName, isGroup, groupId: isGroup ? chatName : undefined };
            const clientPaths = await collectChatReferencedClientPaths(request.user.profile.handle, target);
            const items = await toExistingItems(request.user.directories.root, clientPaths);
            return response.send({ groups: items.length ? [{ kind: 'image', items }] : [], notes: [] });
        }

        if (scope === 'character') {
            const result = await collectCharacterCandidates(request.user, request.body?.avatar);
            return response.send({ groups: result.groups, notes: result.notes });
        }

        return response.status(400).send({ error: 'unsupported scope' });
    } catch (error) {
        console.error('Error collecting media deletion candidates:', error);
        return response.status(500).send({ error: true });
    }
});

/**
 * Unlinks the requested client paths that resolve to existing files under the
 * allowed roots. Anything else is skipped; only genuine unlink errors fail.
 * Each distinct normalized target is processed once.
 * @returns {Promise<{deleted: string[], skipped: string[], failed: string[]}>}
 */
async function deleteGuardedMediaFiles(userRoot, allowedRoots, paths) {
    const outcome = { deleted: [], skipped: [], failed: [] };
    const seen = new Set();

    for (const rawPath of paths) {
        if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) {
            outcome.skipped.push(rawPath);
            continue;
        }
        const diskPath = path.normalize(path.join(userRoot, rawPath));
        if (seen.has(diskPath)) {
            continue;
        }
        if (!allowedRoots.some(root => isPathUnderParent(root, diskPath))) {
            outcome.skipped.push(rawPath);
            continue;
        }
        seen.add(diskPath);
        const stat = await fsPromises.stat(diskPath).catch(() => null);
        if (!stat?.isFile()) {
            outcome.skipped.push(rawPath);
            continue;
        }
        try {
            await fsPromises.unlink(diskPath);
            outcome.deleted.push(clientRelativePath(userRoot, diskPath));
        } catch (error) {
            console.warn('Failed to delete media file:', diskPath, error);
            outcome.failed.push(rawPath);
        }
    }

    return outcome;
}

router.post('/delete', async (request, response) => {
    try {
        const paths = Array.isArray(request.body?.paths) ? request.body.paths : null;
        if (!paths) {
            return response.status(400).send({ error: 'paths array is required' });
        }
        const userRoot = request.user.directories.root;
        const allowedRoots = [request.user.directories.userImages, request.user.directories.characters];
        return response.send(await deleteGuardedMediaFiles(userRoot, allowedRoots, paths));
    } catch (error) {
        console.error('Error deleting media files:', error);
        return response.status(500).send({ error: true });
    }
});
