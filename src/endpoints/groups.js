import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import writeFileAtomic from 'write-file-atomic';

import { color, tryParse } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { invalidateRecentChatIndex } from './chats.js';
import { getGroupRepo } from '../storage/index.js';

export const router = express.Router();

/**
 * Warns if group data contains deprecated metadata keys and removes them.
 * @param {object} groupData Group data object
 */
function warnOnGroupMetadata(groupData) {
    if (typeof groupData !== 'object' || groupData === null) {
        return;
    }
    ['chat_metadata', 'past_metadata'].forEach(key => {
        if (Object.hasOwn(groupData, key)) {
            console.warn(color.yellow(`Group JSON data for "${groupData.id}" contains deprecated key "${key}".`));
            delete groupData[key];
        }
    });
}

/**
 * Migrates group metadata to include chat metadata for each group chat instead of the group itself.
 * @param {import('../users.js').UserDirectoryList[]} userDirectories Listing of all users' directories
 */
export async function migrateGroupChatsMetadataFormat(userDirectories) {
    for (const userDirs of userDirectories) {
        try {
            let anyDataMigrated = false;
            const backupPath = path.join(userDirs.backups, '_group_metadata_update');
            const groupFiles = await fsPromises.readdir(userDirs.groups, { withFileTypes: true });
            const groupChatFiles = await fsPromises.readdir(userDirs.groupChats, { withFileTypes: true });
            for (const groupFile of groupFiles) {
                try {
                    const isJsonFile = groupFile.isFile() && path.extname(groupFile.name) === '.json';
                    if (!isJsonFile) {
                        continue;
                    }
                    const groupFilePath = path.join(userDirs.groups, groupFile.name);
                    const groupDataRaw = await fsPromises.readFile(groupFilePath, 'utf8');
                    const groupData = tryParse(groupDataRaw) || {};
                    const needsMigration = ['chat_metadata', 'past_metadata'].some(key => Object.hasOwn(groupData, key));
                    if (!needsMigration) {
                        continue;
                    }
                    if (!fs.existsSync(backupPath)) {
                        await fsPromises.mkdir(backupPath, { recursive: true });
                    }
                    await fsPromises.copyFile(groupFilePath, path.join(backupPath, groupFile.name));
                    const allMetadata = {
                        ...(groupData.past_metadata || {}),
                        [groupData.chat_id]: (groupData.chat_metadata || {}),
                    };
                    if (!Array.isArray(groupData.chats)) {
                        console.warn(color.yellow(`Group ${groupFile.name} has no chats array, skipping migration.`));
                        continue;
                    }
                    for (const chatId of groupData.chats) {
                        try {
                            const chatFileName = sanitize(`${chatId}.jsonl`);
                            const chatFileDirent = groupChatFiles.find(f => f.isFile() && f.name === chatFileName);
                            if (!chatFileDirent) {
                                console.warn(color.yellow(`Group chat file ${chatId} not found, skipping migration.`));
                                continue;
                            }
                            const chatFilePath = path.join(userDirs.groupChats, chatFileName);
                            const chatMetadata = allMetadata[chatId] || {};
                            const chatDataRaw = await fsPromises.readFile(chatFilePath, 'utf8');
                            const chatData = chatDataRaw.split('\n').filter(line => line.trim()).map(line => tryParse(line)).filter(Boolean);
                            const alreadyHasMetadata = chatData.length > 0 && Object.hasOwn(chatData[0], 'chat_metadata');
                            if (alreadyHasMetadata) {
                                console.log(color.yellow(`Group chat ${chatId} already has chat metadata, skipping update.`));
                                continue;
                            }
                            await fsPromises.copyFile(chatFilePath, path.join(backupPath, chatFileName));
                            const chatHeader = { chat_metadata: chatMetadata, user_name: 'unused', character_name: 'unused' };
                            const newChatData = [chatHeader, ...chatData];
                            const newChatDataRaw = newChatData.map(entry => JSON.stringify(entry)).join('\n');
                            await writeFileAtomic(chatFilePath, newChatDataRaw, 'utf8');
                            console.log(`Updated group chat data format for ${chatId}`);
                            anyDataMigrated = true;
                        } catch (chatError) {
                            console.error(color.red(`Could not update existing chat data for ${chatId}`), chatError);
                        }
                    }
                    delete groupData.chat_metadata;
                    delete groupData.past_metadata;
                    await writeFileAtomic(groupFilePath, JSON.stringify(groupData, null, 4), 'utf8');
                    console.log(`Migrated group chats metadata for group: ${groupData.id}`);
                    anyDataMigrated = true;
                } catch (groupError) {
                    console.error(color.red(`Could not process group file ${groupFile.name}`), groupError);
                }
            }
            if (anyDataMigrated) {
                console.log(color.green(`Completed migration of group chats metadata for user at ${userDirs.root}`));
                console.log(color.cyan(`Backups of modified files are located at ${backupPath}`));
            }
        } catch (directoryError) {
            console.error(color.red(`Error migrating group chats metadata for user at ${userDirs.root}`), directoryError);
        }
    }
}

/**
 * Returns a snapshot of all groups for the given user handle, joined with
 * member-chat file stats (chat_size + date_last_chat). Previously a sync
 * function that took the raw directories struct; now async-routed through
 * GroupRepo so the storage engine remains the single source of truth.
 * @param {string} handle User profile handle
 * @returns {Promise<object[]>}
 */
export async function getGroupsSnapshot(handle) {
    return getGroupRepo().listWithChatStats(handle);
}

router.post('/all', async (request, response) => {
    try {
        const groups = await getGroupRepo().listWithChatStats(request.user.profile.handle);
        return response.send(groups);
    } catch (error) {
        console.error('Error listing groups:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    warnOnGroupMetadata(request.body);
    const id = String(Date.now());
    const groupMetadata = {
        id: id,
        name: request.body.name ?? 'New Group',
        members: request.body.members ?? [],
        avatar_url: request.body.avatar_url,
        allow_self_responses: !!request.body.allow_self_responses,
        activation_strategy: request.body.activation_strategy ?? 0,
        generation_mode: request.body.generation_mode ?? 0,
        disabled_members: request.body.disabled_members ?? [],
        fav: request.body.fav,
        chat_id: request.body.chat_id ?? id,
        chats: request.body.chats ?? [id],
        auto_mode_delay: request.body.auto_mode_delay ?? 5,
        generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
        generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
    };

    try {
        await getGroupRepo().save(request.user.profile.handle, id, groupMetadata);
        return response.send(groupMetadata);
    } catch (error) {
        console.error('Error creating group:', error);
        return response.sendStatus(500);
    }
});

router.post('/edit', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }
    warnOnGroupMetadata(request.body);

    try {
        await getGroupRepo().save(request.user.profile.handle, request.body.id, request.body);
        return response.send({ ok: true });
    } catch (error) {
        console.error('Error editing group:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', getFileNameValidationFunction('id'), async (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const handle = request.user.profile.handle;
    const id = request.body.id;
    try {
        const result = await getGroupRepo().delete(handle, id);
        // Recent-chat cache caches absolute group-chat paths that just got unlinked;
        // invalidate so the next /api/chats/recent rebuilds clean.
        if (result.chatsDeleted > 0) {
            await invalidateRecentChatIndex(request);
        }
        return response.send({ ok: true });
    } catch (error) {
        // Cascade failed -> group file still on disk (atomic). Surface the group id and
        // its referenced chats so an operator can clean up the remnants if needed.
        let chatList = [];
        try {
            const group = await getGroupRepo().get(handle, id);
            if (group && Array.isArray(group.chats)) chatList = group.chats;
        } catch {
            // ignore — best-effort diagnostics
        }
        console.error(`Error deleting group ${id}; group file and these chat files may need manual cleanup: ${chatList.join(', ')}`, error);
        return response.sendStatus(500);
    }
});
