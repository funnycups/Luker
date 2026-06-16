import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import { acknowledgeGenerationJobsForPersistTarget, acknowledgeGenerationJobsForRequest } from './backends/luker-generation.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    readFirstLine,
    isPathUnderParent,
} from '../util.js';
import { applyPatch as applyJsonPatch } from '../../public/scripts/util/fast-json-patch.js';
import { getChatRepo, getStorageEngine } from '../storage/index.js';
import { ConflictError, NotFoundError } from '../storage/errors.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';
const CHAT_STATE_FILE_PREFIX = '.luker-state.';
const CHAT_STATE_FILE_SUFFIX = '.json';
const CHAT_SYNC_NAMESPACE = 'chat_sync';
const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX) {
    try {
        if (!isBackupEnabled) { return; }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
        }
        // replace non-alphanumeric characters with underscores
        name = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();

        const backupFile = path.join(directory, `${backupPrefix}${name}_${generateTimestamp()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        removeOldBackups(directory, `${backupPrefix}${name}_`);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        removeOldBackups(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

/**
 * Gets a backup function for a user.
 * @param {string} handle User handle
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle) {
    if (!backupFunctions.has(handle)) {
        backupFunctions.set(handle, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(handle) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

function normalizeRecentChatSortTime(timestamp, fallback = 0) {
    if (!timestamp) {
        return fallback;
    }

    if (timestamp instanceof Date) {
        return Number.isFinite(timestamp.getTime()) ? timestamp.getTime() : fallback;
    }

    if (typeof timestamp === 'number' || /^\d+$/.test(String(timestamp))) {
        const unixTime = Number(timestamp);
        return Number.isFinite(unixTime) && !Number.isNaN(unixTime) && unixTime >= 0 ? unixTime : fallback;
    }

    const normalizedTimestamp = String(timestamp).trim();
    const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
    if (isoPattern.test(normalizedTimestamp)) {
        const parsedIsoTime = new Date(normalizedTimestamp).getTime();
        return Number.isFinite(parsedIsoTime) ? parsedIsoTime : fallback;
    }

    const meridiemMatch = normalizedTimestamp.match(/(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i);
    if (meridiemMatch) {
        const [, month, day, year, hour, minute, meridiem] = meridiemMatch;
        const monthNum = monthNames.indexOf(month) + 1;
        if (monthNum > 0) {
            const hour24 = meridiem.toLowerCase() === 'pm' ? (parseInt(hour, 10) % 12) + 12 : parseInt(hour, 10) % 12;
            const isoTimestamp = `${year}-${monthNum.toString().padStart(2, '0')}-${day.padStart(2, '0')}T${hour24.toString().padStart(2, '0')}:${minute.padStart(2, '0')}:00`;
            const parsedMeridiemTime = new Date(isoTimestamp).getTime();
            if (Number.isFinite(parsedMeridiemTime)) {
                return parsedMeridiemTime;
            }
        }
    }

    const humanizedFormats = [
        /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms/,
        /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/,
        /(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/,
    ];

    for (const format of humanizedFormats) {
        const match = normalizedTimestamp.match(format);
        if (!match) {
            continue;
        }

        const [, year, month, day, hour, minute, second, millisecond = ''] = match;
        const fractional = millisecond ? `.${millisecond.padStart(3, '0')}` : '';
        const isoTimestamp = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}${fractional}Z`;
        const parsedHumanizedTime = new Date(isoTimestamp).getTime();
        if (Number.isFinite(parsedHumanizedTime)) {
            return parsedHumanizedTime;
        }
    }

    const parsedTime = new Date(normalizedTimestamp).getTime();
    return Number.isFinite(parsedTime) ? parsedTime : fallback;
}

function getRecentChatSortTime(chatInfo) {
    return normalizeRecentChatSortTime(chatInfo?.sort_time ?? chatInfo?.last_mes, 0);
}

/**
 * @typedef {{ filePath: string, avatar?: string, group?: string }} RecentChatDescriptor
 */

/**
 * @typedef {{ entries: Map<string, object>|null, buildPromise: Promise<Map<string, object>>|null }} RecentChatIndexState
 */

/** @type {Map<string, RecentChatIndexState>} */
const recentChatIndexCache = new Map();

function getRecentChatIndexKey(request) {
    const handle = String(request?.user?.profile?.handle || '').trim();
    const chatsDirectory = String(request?.user?.directories?.chats || '');
    const groupChatsDirectory = String(request?.user?.directories?.groupChats || '');
    return `${handle}::${chatsDirectory}::${groupChatsDirectory}`;
}

function getOrCreateRecentChatIndexState(request) {
    const key = getRecentChatIndexKey(request);
    let state = recentChatIndexCache.get(key);
    if (!state) {
        state = { entries: null, buildPromise: null };
        recentChatIndexCache.set(key, state);
    }
    return state;
}

async function getReadyRecentChatIndexState(request) {
    const key = getRecentChatIndexKey(request);
    const state = recentChatIndexCache.get(key);
    if (!state) {
        return null;
    }

    if (state.buildPromise) {
        await state.buildPromise;
    }

    return state.entries ? state : null;
}

/**
 * Builds the list of chat files eligible for the recent-chat index.
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<RecentChatDescriptor[]>}
 */
async function listRecentChatDescriptors(directories) {
    /** @type {RecentChatDescriptor[]} */
    const allChatFiles = [];

    const getCharacterChatFiles = async () => {
        const pngDirents = await fs.promises.readdir(directories.characters, { withFileTypes: true });
        const pngFiles = pngDirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.png').map(entry => entry.name);

        for (const pngFile of pngFiles) {
            const chatsDirectory = pngFile.replace('.png', '');
            const pathToChats = path.join(directories.chats, chatsDirectory);
            if (!fs.existsSync(pathToChats)) {
                continue;
            }

            const pathStats = await fs.promises.stat(pathToChats);
            if (!pathStats.isDirectory()) {
                continue;
            }

            const chatFiles = await fs.promises.readdir(pathToChats);
            const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

            for (const file of jsonlFiles) {
                allChatFiles.push({
                    avatar: pngFile,
                    filePath: path.join(pathToChats, file),
                });
            }
        }
    };

    const getGroupChatFiles = async () => {
        const groupDirents = await fs.promises.readdir(directories.groups, { withFileTypes: true });
        const groups = groupDirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.json').map(entry => entry.name);

        for (const groupFileName of groups) {
            try {
                const groupPath = path.join(directories.groups, groupFileName);
                const groupContents = await fs.promises.readFile(groupPath, 'utf8');
                const groupData = JSON.parse(groupContents);

                if (!Array.isArray(groupData.chats)) {
                    continue;
                }

                for (const chatId of groupData.chats) {
                    const filePath = path.join(directories.groupChats, `${chatId}.jsonl`);
                    if (!fs.existsSync(filePath)) {
                        continue;
                    }

                    allChatFiles.push({
                        group: String(groupData.id || ''),
                        filePath,
                    });
                }
            } catch {
                continue;
            }
        }
    };

    const getRootChatFiles = async () => {
        const dirents = await fs.promises.readdir(directories.chats, { withFileTypes: true });
        const chatFiles = dirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.jsonl').map(entry => entry.name);

        for (const file of chatFiles) {
            allChatFiles.push({
                filePath: path.join(directories.chats, file),
            });
        }
    };

    await Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);
    return allChatFiles;
}

async function buildRecentChatIndexEntries(request) {
    const descriptors = await listRecentChatDescriptors(request.user.directories);
    const entries = new Map();
    const infoResults = await Promise.allSettled(descriptors.map((descriptor) => getChatInfo(descriptor.filePath, {
        ...(descriptor.avatar ? { avatar: descriptor.avatar } : {}),
        ...(descriptor.group ? { group: descriptor.group } : {}),
    })));

    infoResults.forEach((result, index) => {
        if (result.status !== 'fulfilled' || !result.value?.file_name) {
            return;
        }

        const descriptor = descriptors[index];
        entries.set(path.resolve(descriptor.filePath), result.value);
    });

    return entries;
}

async function ensureRecentChatIndex(request) {
    const state = getOrCreateRecentChatIndexState(request);
    if (state.entries) {
        return state.entries;
    }

    if (!state.buildPromise) {
        state.buildPromise = buildRecentChatIndexEntries(request)
            .then((entries) => {
                state.entries = entries;
                return entries;
            })
            .finally(() => {
                state.buildPromise = null;
            });
    }

    return await state.buildPromise;
}

async function resolveGroupIdForChatId(directories, chatId) {
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChatId) {
        return '';
    }

    const groupDirents = await fs.promises.readdir(directories.groups, { withFileTypes: true });
    const groupFiles = groupDirents.filter(entry => entry.isFile() && path.extname(entry.name) === '.json').map(entry => entry.name);

    for (const groupFileName of groupFiles) {
        try {
            const groupPath = path.join(directories.groups, groupFileName);
            const groupContents = await fs.promises.readFile(groupPath, 'utf8');
            const groupData = JSON.parse(groupContents);
            const chats = Array.isArray(groupData?.chats) ? groupData.chats.map(chat => String(chat || '')) : [];
            if (chats.includes(normalizedChatId) || String(groupData?.chat_id || '') === normalizedChatId) {
                return String(groupData?.id || '');
            }
        } catch {
            continue;
        }
    }

    return '';
}

function inferRecentChatDescriptor(directories, filePath, overrides = {}) {
    const resolvedFilePath = path.resolve(String(filePath || ''));
    if (!resolvedFilePath) {
        return null;
    }

    if (overrides.avatar) {
        return { filePath: resolvedFilePath, avatar: String(overrides.avatar) };
    }

    if (overrides.group) {
        return { filePath: resolvedFilePath, group: String(overrides.group) };
    }

    const chatsDirectory = path.resolve(String(directories.chats || ''));
    const relativeChatPath = path.relative(chatsDirectory, resolvedFilePath);
    if (relativeChatPath && !relativeChatPath.startsWith('..') && !path.isAbsolute(relativeChatPath)) {
        const segments = relativeChatPath.split(path.sep).filter(Boolean);
        if (segments.length >= 2) {
            return { filePath: resolvedFilePath, avatar: `${segments[0]}.png` };
        }
        return { filePath: resolvedFilePath };
    }

    return { filePath: resolvedFilePath };
}

async function buildRecentChatDescriptor(request, filePath, overrides = {}) {
    const resolvedFilePath = path.resolve(String(filePath || ''));
    const descriptor = inferRecentChatDescriptor(request.user.directories, resolvedFilePath, overrides);
    if (!descriptor) {
        return null;
    }

    const groupChatsDirectory = path.resolve(String(request.user.directories.groupChats || ''));
    const relativeGroupPath = path.relative(groupChatsDirectory, resolvedFilePath);
    const isGroupChatFile = relativeGroupPath && !relativeGroupPath.startsWith('..') && !path.isAbsolute(relativeGroupPath);

    if (!isGroupChatFile || descriptor.group) {
        return descriptor;
    }

    const state = await getReadyRecentChatIndexState(request);
    const cachedEntry = state?.entries?.get(resolvedFilePath);
    if (cachedEntry?.group) {
        return { ...descriptor, group: String(cachedEntry.group) };
    }

    const chatId = path.parse(path.basename(resolvedFilePath)).name;
    const groupId = await resolveGroupIdForChatId(request.user.directories, chatId);
    return groupId ? { ...descriptor, group: groupId } : descriptor;
}

async function refreshRecentChatIndexEntry(request, filePath, overrides = {}) {
    const state = await getReadyRecentChatIndexState(request);
    if (!state?.entries) {
        return;
    }

    const descriptor = await buildRecentChatDescriptor(request, filePath, overrides);
    if (!descriptor?.filePath || !fs.existsSync(descriptor.filePath)) {
        state.entries.delete(path.resolve(String(filePath || '')));
        return;
    }

    const entry = await getChatInfo(descriptor.filePath, {
        ...(descriptor.avatar ? { avatar: descriptor.avatar } : {}),
        ...(descriptor.group ? { group: descriptor.group } : {}),
    });

    if (entry?.file_name) {
        state.entries.set(path.resolve(descriptor.filePath), entry);
    } else {
        state.entries.delete(path.resolve(descriptor.filePath));
    }
}

async function deleteRecentChatIndexEntry(request, filePath) {
    const state = await getReadyRecentChatIndexState(request);
    if (!state?.entries) {
        return;
    }

    state.entries.delete(path.resolve(String(filePath || '')));
}

/**
 * Forces the next /api/chats/recent call to rebuild the index from disk.
 * Used after bulk file system changes that move entries to new keys
 * (e.g. character rename copies chats into a new directory) or any
 * operation where targeted per-file invalidation is impractical.
 * @param {import('express').Request} request
 */
export async function invalidateRecentChatIndex(request) {
    const state = await getReadyRecentChatIndexState(request);
    if (state) {
        state.entries = null;
    }
}

/**
 * Drops every recent-chat index entry whose file lives under `directoryPath`.
 * Called after bulk filesystem removals (e.g. character deletion with `delete_chats`)
 * so that the cached index does not surface entries pointing at gone files.
 * @param {import('express').Request} request
 * @param {string} directoryPath Absolute path of the removed chats directory.
 */
export async function deleteRecentChatIndexEntriesUnderDirectory(request, directoryPath) {
    const state = await getReadyRecentChatIndexState(request);
    if (!state?.entries) {
        return;
    }

    const normalized = path.resolve(String(directoryPath || ''));
    if (!normalized) {
        return;
    }

    for (const key of state.entries.keys()) {
        if (isPathUnderDirectory(key, normalized)) {
            state.entries.delete(key);
        }
    }
}

/**
 * Returns true if `candidatePath` is the directory itself or any descendant of it.
 * Uses `path.sep` boundary so `/chats/Alice` does not match `/chats/Alice1/...`.
 * Both inputs are expected to be already normalized via `path.resolve`.
 * @param {string} candidatePath
 * @param {string} directoryPath
 * @returns {boolean}
 */
export function isPathUnderDirectory(candidatePath, directoryPath) {
    if (!candidatePath || !directoryPath) {
        return false;
    }
    if (candidatePath === directoryPath) {
        return true;
    }
    const prefix = directoryPath.endsWith(path.sep) ? directoryPath : directoryPath + path.sep;
    return candidatePath.startsWith(prefix);
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date().toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date().toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date().toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    const newChats = (jsonData.histories.histories ?? []).map(history => newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date().toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? Date.now())).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

function readChatHeaderIntegrity(filePath) {
    if (!fs.existsSync(filePath)) {
        return '';
    }

    const firstLine = tryReadFileSync(filePath)?.split('\n')[0] ?? '';
    const header = tryParse(firstLine);
    const integrity = typeof header?.chat_metadata?.integrity === 'string'
        ? header.chat_metadata.integrity.trim()
        : '';
    return integrity;
}

function getChatSyncSidecarPath(chatFilePath) {
    return getChatStateSidecarPath(chatFilePath, CHAT_SYNC_NAMESPACE);
}

function readChatSyncState(chatFilePath) {
    const sidecarPath = getChatSyncSidecarPath(chatFilePath);
    if (!sidecarPath || !fs.existsSync(sidecarPath)) {
        return {};
    }

    const parsed = tryParse(tryReadFileSync(sidecarPath) ?? '');
    if (!_.isObjectLike(parsed) || Array.isArray(parsed)) {
        return {};
    }
    return parsed;
}

function writeChatSyncState(chatFilePath, state) {
    const sidecarPath = getChatSyncSidecarPath(chatFilePath);
    if (!sidecarPath) {
        return;
    }

    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    tryWriteFileSync(sidecarPath, JSON.stringify(state));
}

/**
 * In-memory map of "last seen generation id" per chat file. Used for
 * retry-dedup at append time without ever touching disk. The token is a
 * protocol-layer concern (request correlation for retries) — persisting
 * it across server restarts buys nothing the content-based dedup
 * (`_.isEqual` on the last stored message) doesn't already cover for
 * the rare cross-restart retry.
 *
 * Entries self-expire after LAST_GENERATION_ID_TTL_MS via setTimeout, so
 * one-shot chats don't accumulate forever. Every write replaces the
 * entry and resets the timer; reads do not extend the TTL (the retry
 * window starts ticking from the write, not from each lookup).
 */
const LAST_GENERATION_ID_TTL_MS = 60_000;
const lastChatGenerationIdByPath = new Map();

function readLastChatGenerationId(chatFilePath) {
    const key = path.resolve(String(chatFilePath || ''));
    if (!key) return '';
    const entry = lastChatGenerationIdByPath.get(key);
    return entry && typeof entry.value === 'string' ? entry.value : '';
}

function writeLastChatGenerationId(chatFilePath, generationId) {
    const safeId = typeof generationId === 'string' ? generationId.trim() : '';
    if (!safeId) return;
    const key = path.resolve(String(chatFilePath || ''));
    if (!key) return;
    const previous = lastChatGenerationIdByPath.get(key);
    if (previous?.timer) {
        clearTimeout(previous.timer);
    }
    const timer = setTimeout(() => {
        const current = lastChatGenerationIdByPath.get(key);
        // Only delete if this is still the same entry (a later write may have
        // already replaced it; that newer write owns its own timer).
        if (current && current.timer === timer) {
            lastChatGenerationIdByPath.delete(key);
        }
    }, LAST_GENERATION_ID_TTL_MS);
    // Node's setTimeout returns a Timeout object; .unref() so a stale entry
    // does not keep the process alive past its actual work.
    if (typeof timer.unref === 'function') timer.unref();
    lastChatGenerationIdByPath.set(key, { value: safeId, timer });
}

/**
 * Removes the protocol-layer luker_generation_id from a message's extra
 * before persisting / returning it. The field is a one-shot ack/dedup
 * token; the data layer never needs to carry it. Mutates the message in
 * place (callers pass freshly parsed or deep-cloned values).
 */
function stripLukerGenerationIdFromMessage(message) {
    if (_.isObjectLike(message) && _.isObjectLike(message.extra) && 'luker_generation_id' in message.extra) {
        delete message.extra.luker_generation_id;
    }
    return message;
}

function getCurrentChatIntegrity(chatFilePath) {
    const syncState = readChatSyncState(chatFilePath);
    const stateIntegrity = typeof syncState.integrity === 'string' ? syncState.integrity.trim() : '';
    if (stateIntegrity) {
        return stateIntegrity;
    }

    const headerIntegrity = readChatHeaderIntegrity(chatFilePath);
    if (headerIntegrity) {
        writeChatSyncState(chatFilePath, { integrity: headerIntegrity, updated_at: Date.now() });
    }
    return headerIntegrity;
}

function rotateChatIntegrity(chatFilePath) {
    const integrity = randomUUID();
    writeChatSyncState(chatFilePath, { integrity, updated_at: Date.now() });
    return integrity;
}

function applyIntegrityToMetadata(metadata, integrity) {
    const base = _.isObjectLike(metadata) && !Array.isArray(metadata) ? { ...metadata } : {};
    if (integrity) {
        base.integrity = integrity;
    }
    return base;
}

function attachCurrentIntegrityToChatData(chatData, chatFilePath) {
    if (!Array.isArray(chatData) || chatData.length === 0) {
        return chatData;
    }

    const header = chatData[0];
    if (!_.isObjectLike(header) || !Object.hasOwn(header, 'chat_metadata')) {
        return chatData;
    }

    const currentIntegrity = getCurrentChatIntegrity(chatFilePath);
    if (!currentIntegrity) {
        return chatData;
    }

    header.chat_metadata = applyIntegrityToMetadata(header.chat_metadata, currentIntegrity);
    return chatData;
}

/**
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} filePath Path to the chat file.
 * @param {string} integritySlug Integrity slug from client.
 * @returns {Promise<boolean>} Whether the integrity matches.
 */
async function checkChatIntegrity(filePath, integritySlug) {
    if (!fs.existsSync(filePath)) {
        return true;
    }

    const expectedIntegrity = String(integritySlug || '').trim();
    if (!expectedIntegrity) {
        return true;
    }

    const currentIntegrity = getCurrentChatIntegrity(filePath);
    if (!currentIntegrity) {
        return true;
    }

    return currentIntegrity === expectedIntegrity;
}

function createIntegrityMismatchError(filePath, expectedIntegrity) {
    const error = new IntegrityMismatchError(
        `Chat integrity check failed for "${filePath}". The expected integrity slug was "${expectedIntegrity}".`,
    );
    error.currentIntegrity = getCurrentChatIntegrity(filePath);
    error.expectedIntegrity = String(expectedIntegrity || '');
    return error;
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file in a human-readable format
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {string} [mes] - The last message in the chat
 * @property {number|string} [last_mes] - The timestamp of the last message
 * @property {number} [sort_time] - Normalized numeric timestamp used for sorting
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads the information from a chat file.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null) {
    return new Promise(async (res) => {
        const parsedPath = path.parse(pathToFile);
        const stats = await fs.promises.stat(pathToFile);
        const hasMatcher = (typeof matcher === 'function');

        const chatData = {
            match: false,
            file_id: parsedPath.name,
            file_name: parsedPath.base,
            file_size: formatBytes(stats.size),
            chat_items: 0,
            mes: '[The chat is empty]',
            last_mes: stats.mtimeMs,
            sort_time: stats.mtimeMs,
            ...additionalData,
        };

        if (stats.size === 0) {
            res(chatData);
            return;
        }

        const fileStream = fs.createReadStream(pathToFile);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        let lastLine;
        let itemCounter = 0;
        let hasAnyMatch = false;
        let matchBuffer = [];
        rl.on('line', (line) => {
            if (withMetadata && itemCounter === 0) {
                const jsonData = tryParse(line);
                if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                    chatData.chat_metadata = jsonData.chat_metadata;
                }
            }
            // Skip matching if any match was already found
            if (hasMatcher && !hasAnyMatch && itemCounter > 0) {
                const jsonData = tryParse(line);
                if (jsonData) {
                    matchBuffer.push(jsonData.mes || '');
                    if (matcher(matchBuffer)) {
                        hasAnyMatch = true;
                        matchBuffer = [];
                    }
                }
            }
            itemCounter++;
            lastLine = line;
        });
        rl.on('close', () => {
            rl.close();

            if (lastLine) {
                const jsonData = tryParse(lastLine);
                if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                    chatData.chat_items = (itemCounter - 1);
                    chatData.mes = jsonData.mes || '[The message is empty]';
                    chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                    chatData.sort_time = normalizeRecentChatSortTime(chatData.last_mes, stats.mtimeMs);
                    chatData.match = hasMatcher ? hasAnyMatch : true;

                    res(chatData);
                } else {
                    console.warn('Found an invalid or corrupted chat file:', pathToFile);
                    res({});
                }
            }
        });
    });
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

function sendIntegrityConflict(response, error) {
    console.warn(error.message);
    return response.status(409).send({
        error: 'integrity',
        current_integrity: typeof error?.currentIntegrity === 'string' ? error.currentIntegrity : '',
    });
}

function sendRepoIntegrityConflict(response, error) {
    console.warn(error.message);
    const actual = typeof error?.details?.actual === 'string' ? error.details.actual : '';
    return response.status(409).send({
        error: 'integrity',
        current_integrity: actual,
    });
}

/**
 * Creates a chat header object.
 * @param {object} [metadata] Chat metadata.
 * @returns {object} Chat header.
 */
function createChatHeader(metadata = {}) {
    return {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };
}

/**
 * Ensures chat file name uses .jsonl extension.
 * @param {string} fileName Raw file name.
 * @returns {string} Sanitized file name with extension.
 */
function normalizeJsonlFileName(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) {
        return '';
    }
    const withExt = path.extname(raw) ? raw : `${raw}.jsonl`;
    return sanitize(withExt);
}

/**
 * Resolves avatar directory name from avatar url.
 * @param {string} avatarUrl Avatar url.
 * @returns {string} Sanitized avatar directory name.
 */
function resolveAvatarDirectoryName(avatarUrl) {
    return path.basename(String(avatarUrl || '').replace('.png', ''));
}

function normalizeChatStateNamespace(namespace) {
    const raw = String(namespace || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    return raw.replace(/[^a-z0-9._-]/g, '_').slice(0, 96);
}

/**
 * Resolves a file path constrained to a base directory.
 * @param {string} baseDirectory Base directory path.
 * @param {string} requestedFileName Requested file name (possibly unsafe).
 * @returns {string} Safe resolved file path or empty string.
 */
function resolvePathInsideDirectory(baseDirectory, requestedFileName) {
    const base = path.resolve(String(baseDirectory || ''));
    const safeName = sanitize(path.basename(String(requestedFileName || '').trim()));
    if (!base || !safeName) {
        return '';
    }

    const resolved = path.resolve(base, safeName);
    const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
    if (resolved !== base && !resolved.startsWith(baseWithSep)) {
        return '';
    }
    return resolved;
}

/**
 * Gets chat state sidecar path for a chat jsonl file path and namespace.
 * @param {string} chatFilePath Chat jsonl file path.
 * @param {string} namespace State namespace.
 * @returns {string} Sidecar path.
 */
function getChatStateSidecarPath(chatFilePath, namespace) {
    const parsed = path.parse(chatFilePath);
    const safeNamespace = normalizeChatStateNamespace(namespace);
    if (!safeNamespace) {
        return '';
    }
    return path.join(parsed.dir, `${parsed.name}${CHAT_STATE_FILE_PREFIX}${safeNamespace}${CHAT_STATE_FILE_SUFFIX}`);
}

/**
 * Gets all chat state sidecar paths bound to a chat file.
 * @param {string} chatFilePath Chat jsonl file path.
 * @returns {string[]} Sidecar file paths.
 */
function getAllChatStateSidecarPaths(chatFilePath) {
    const parsed = path.parse(chatFilePath);
    if (!fs.existsSync(parsed.dir)) {
        return [];
    }
    const prefix = `${parsed.name}${CHAT_STATE_FILE_PREFIX}`;
    const files = fs.readdirSync(parsed.dir, { withFileTypes: true });
    return files
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(fileName => fileName.startsWith(prefix) && fileName.endsWith(CHAT_STATE_FILE_SUFFIX))
        .map(fileName => path.join(parsed.dir, fileName));
}

/**
 * Renames all state sidecars from one chat base name to another.
 * @param {string} sourceChatFilePath Source chat file path.
 * @param {string} targetChatFilePath Target chat file path.
 */
function renameAllChatStateSidecars(sourceChatFilePath, targetChatFilePath) {
    const sourceParsed = path.parse(sourceChatFilePath);
    const targetParsed = path.parse(targetChatFilePath);
    const sourcePrefix = `${sourceParsed.name}${CHAT_STATE_FILE_PREFIX}`;
    const targetPrefix = `${targetParsed.name}${CHAT_STATE_FILE_PREFIX}`;
    const sourceFiles = getAllChatStateSidecarPaths(sourceChatFilePath);
    if (sourceFiles.length === 0) {
        return;
    }

    for (const sourceFilePath of sourceFiles) {
        const sourceName = path.basename(sourceFilePath);
        const namespaceWithSuffix = sourceName.slice(sourcePrefix.length);
        const targetName = `${targetPrefix}${namespaceWithSuffix}`;
        const targetFilePath = path.join(targetParsed.dir, targetName);
        if (fs.existsSync(targetFilePath)) {
            throw new Error(`Chat state sidecar rename collision: ${targetFilePath}`);
        }
        fs.copyFileSync(sourceFilePath, targetFilePath);
        fs.unlinkSync(sourceFilePath);
    }
}

/**
 * Deletes all state sidecars bound to a chat file.
 * @param {string} chatFilePath Chat jsonl file path.
 */
function deleteAllChatStateSidecars(chatFilePath) {
    const sidecars = getAllChatStateSidecarPaths(chatFilePath);
    for (const sidecar of sidecars) {
        tryDeleteFile(sidecar);
    }
}

/**
 * Resolves a ChatRepo storage key from a state target payload.
 * Sanitizes avatar_url + file_name (or group id) the same way the legacy
 * direct-file path did, so the storage layer (which does not re-sanitize)
 * inherits the same path-safety guarantees.
 * @param {import('express').Request} request Express request.
 * @param {object} target Target payload.
 * @returns {{handle:string,charDir?:string,name:string,isGroup:boolean,groupId?:string}|null}
 */
function resolveChatStateRepoKey(request, target) {
    const handle = request.user.profile.handle;
    if (target?.is_group) {
        const safeGroupId = sanitize(String(target?.id || '').trim());
        if (!safeGroupId) return null;
        return { handle, isGroup: true, groupId: safeGroupId, name: safeGroupId };
    }
    const avatarDir = resolveAvatarDirectoryName(target?.avatar_url);
    const fileName = normalizeJsonlFileName(target?.file_name);
    if (!avatarDir || !fileName) return null;
    const baseName = path.basename(fileName, '.jsonl');
    if (!baseName) return null;
    return { handle, charDir: avatarDir, name: baseName, isGroup: false };
}

/**
 * Applies patch operations to a chat state object.
 * Uses RFC6902 operations (add/remove/replace/test).
 * @param {object} state Current state object.
 * @param {object[]} operations Patch operations.
 * @returns {{applied:number,state:object}}
 */
function applyChatStatePatch(state, operations) {
    const root = _.isObjectLike(state) && !Array.isArray(state) ? state : {};
    const patchResult = applyJsonPatch(root, operations, true, false);
    return { applied: operations.length, state: patchResult.newDocument };
}

/**
 * Returns true when a JSON patch failure is most likely a concurrent-state conflict.
 * @param {unknown} error
 * @returns {boolean}
 */
function isChatStatePatchConflictError(error) {
    const message = String(error?.message || error || '');
    return message.includes('JSON Patch test failed')
        || message.includes('Invalid JSON Patch replace path.')
        || message.includes('Invalid JSON Patch remove path.')
        || message.includes('Array index out of bounds');
}

/**
 * Returns true when a JSON patch failure is a malformed client payload.
 * @param {unknown} error
 * @returns {boolean}
 */
function isJsonPatchValidationError(error) {
    const message = String(error?.message || error || '');
    return message.includes('JSON Patch operation is missing op.')
        || message.includes('JSON Patch operation must be an object.')
        || message.includes('JSON Patch document must be an array.')
        || message.includes('JSON Patch add operation requires value.')
        || message.includes('JSON Patch replace operation requires value.')
        || message.includes('Invalid JSON Patch path.')
        || message.includes('Unsupported JSON Patch operation:');
}

/**
 * Reads the last non-header message from a JSONL chat file.
 * @param {string} filePath Chat file path.
 * @returns {object|null} Last chat message or null if unavailable.
 */
function getLastChatMessage(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    const raw = tryReadFileSync(filePath);
    if (!raw) {
        return null;
    }

    const lines = String(raw).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) {
            continue;
        }

        const parsed = tryParse(line);
        if (!parsed || typeof parsed !== 'object') {
            continue;
        }

        if (Object.hasOwn(parsed, 'chat_metadata')) {
            continue;
        }

        return parsed;
    }

    return null;
}

/**
 * Returns true when a value looks like a chat message object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isChatMessageLike(value) {
    return _.isObjectLike(value)
        && typeof value.mes === 'string'
        && typeof value.is_user === 'boolean'
        && typeof value.is_system === 'boolean';
}

function collectLukerGenerationIds(value, generationIds = new Set(), depth = 0) {
    if (depth > 8 || value === null || value === undefined) {
        return generationIds;
    }

    const generationId = String(value?.extra?.luker_generation_id || '').trim();
    if (generationId) {
        generationIds.add(generationId);
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectLukerGenerationIds(item, generationIds, depth + 1);
        }
        return generationIds;
    }

    if (!_.isObjectLike(value) || isChatMessageLike(value)) {
        return generationIds;
    }

    for (const nestedValue of Object.values(value)) {
        if (nestedValue && typeof nestedValue === 'object') {
            collectLukerGenerationIds(nestedValue, generationIds, depth + 1);
        }
    }

    return generationIds;
}

function acknowledgeGenerationIdsFromValue(request, value) {
    const generationIds = Array.from(collectLukerGenerationIds(value));
    if (generationIds.length === 0) {
        return [];
    }
    return acknowledgeGenerationJobsForRequest(request, generationIds);
}

function acknowledgeGenerationFromValueOrPersistTarget(request, value, persistTarget) {
    const explicitAcknowledged = acknowledgeGenerationIdsFromValue(request, value);
    if (explicitAcknowledged.length > 0 || !persistTarget || typeof persistTarget !== 'object') {
        return explicitAcknowledged;
    }

    return acknowledgeGenerationJobsForPersistTarget(request, persistTarget, {
        statuses: ['awaiting_ack'],
        maxJobs: 1,
    });
}

function buildCharacterPersistTargetHint(request) {
    const avatarUrl = String(request?.body?.avatar_url || '').trim();
    const fileName = String(request?.body?.file_name || '').trim();
    if (!avatarUrl || !fileName) {
        return null;
    }

    return {
        kind: 'character',
        avatar_url: avatarUrl,
        file_name: fileName,
    };
}

function buildGroupPersistTargetHint(request) {
    const groupId = String(request?.body?.id || '').trim();
    if (!groupId) {
        return null;
    }

    return {
        kind: 'group',
        id: groupId,
    };
}

/**
 * Decodes a single JSON Pointer segment.
 * @param {string} segment
 * @returns {string}
 */
function decodeJsonPointerSegment(segment) {
    return String(segment || '').replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Parses top-level array index from a JSON Patch path.
 * Accepts only `/<index>` message-level paths.
 * @param {unknown} path
 * @returns {number|null}
 */
function getTopLevelMessageIndex(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
        return null;
    }

    const rawSegments = path.split('/');
    if (rawSegments.length !== 2) {
        return null;
    }

    const decoded = decodeJsonPointerSegment(rawSegments[1]);
    if (!decoded || decoded === '-') {
        return null;
    }

    const index = Number(decoded);
    if (!Number.isInteger(index) || index < 0) {
        return null;
    }

    return index;
}

/**
 * Rewrites duplicate top-level `add` message operations to idempotent `test` operations.
 * This prevents duplicate message insertion under race/retry scenarios.
 * @param {object[]} currentMessages
 * @param {object[]} operations
 * @returns {object[]}
 */
function buildIdempotentMessagePatchOperations(currentMessages, operations) {
    const sourceMessages = Array.isArray(currentMessages) ? _.cloneDeep(currentMessages) : [];
    const normalizedOperations = Array.isArray(operations)
        ? operations.filter(op => _.isObjectLike(op))
        : [];

    /** @type {object[]} */
    const rewritten = [];
    let workingMessages = sourceMessages;

    for (const operation of normalizedOperations) {
        let nextOperation = operation;
        const opName = String(operation?.op || '').trim().toLowerCase();
        const index = getTopLevelMessageIndex(operation?.path);

        if (opName === 'add'
            && Number.isInteger(index)
            && index >= 0
            && index < workingMessages.length
            && isChatMessageLike(operation?.value)
            && isChatMessageLike(workingMessages[index])
            && _.isEqual(workingMessages[index], operation.value)) {
            nextOperation = {
                op: 'test',
                path: `/${index}`,
                value: _.cloneDeep(workingMessages[index]),
            };
        }

        rewritten.push(nextOperation);

        try {
            const patchResult = applyJsonPatch(workingMessages, [nextOperation], true, false);
            if (Array.isArray(patchResult?.newDocument)) {
                workingMessages = patchResult.newDocument;
            }
        } catch {
            // Keep operation list intact; validation/conflict handling happens later.
        }
    }

    return rewritten;
}

/**
 * Appends messages to an existing chat file, or creates a new chat file with header.
 * This path intentionally skips backup snapshots to keep append operations fast.
 * @param {object} args Append options.
 * @param {string} args.filePath Target chat file path.
 * @param {object[]} args.messages Messages to append.
 * @param {object} [args.chatMetadata] Metadata used only when creating a new file.
 * @param {string} [args.integritySlug] Integrity slug to validate before appending.
 * @param {boolean} [args.force] Skip integrity mismatch error if true.
 * @param {string} [args.incomingGenerationId] Protocol-layer gen id from the
 *   request body. Used to dedup retries against the sidecar's last_generation_id;
 *   the field is intentionally NOT taken from the messages themselves anymore.
 * @returns {Promise<{appended:number, created:boolean}>}
 */
export async function appendMessagesToChatFile({ filePath, messages, chatMetadata = {}, integritySlug, force = false, incomingGenerationId = '' }) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { appended: 0, created: false, integrity: getCurrentChatIntegrity(filePath) };
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (integritySlug && !force && !await checkChatIntegrity(filePath, integritySlug)) {
        throw createIntegrityMismatchError(filePath, integritySlug);
    }

    // Strip the protocol-layer field from every message before any further
    // processing — sidecar carries the gen id now, not the message data.
    const cleanedMessages = messages.map(m => stripLukerGenerationIdFromMessage(_.cloneDeep(m)));
    const incomingId = String(incomingGenerationId || '').trim();

    const serializedMessages = cleanedMessages.map(message => JSON.stringify(message)).join('\n');
    const fileExists = fs.existsSync(filePath);
    const fileStats = fileExists ? fs.statSync(filePath) : null;
    const hasContent = fileExists && fileStats && fileStats.size > 0;

    if (!hasContent) {
        const nextIntegrity = randomUUID();
        const header = JSON.stringify(createChatHeader(applyIntegrityToMetadata(chatMetadata, nextIntegrity)));
        const initialData = `${header}\n${serializedMessages}`;
        tryWriteFileSync(filePath, initialData);
        writeChatSyncState(filePath, { integrity: nextIntegrity, updated_at: Date.now() });
        if (incomingId) {
            writeLastChatGenerationId(filePath, incomingId);
        }
        return { appended: cleanedMessages.length, created: true, integrity: nextIntegrity };
    }

    const dedupedMessages = cleanedMessages.slice();
    const lastStoredMessage = getLastChatMessage(filePath);
    const sidecarLastGenerationId = readLastChatGenerationId(filePath);
    let matchedExistingGenerationId = false;
    while (dedupedMessages.length > 0) {
        // Content dedup: if the file's last message is byte-identical (post-strip)
        // to the first incoming message, the previous attempt already landed.
        const lastStoredStripped = isChatMessageLike(lastStoredMessage)
            ? stripLukerGenerationIdFromMessage(_.cloneDeep(lastStoredMessage))
            : null;
        if (lastStoredStripped && isChatMessageLike(dedupedMessages[0]) && _.isEqual(lastStoredStripped, dedupedMessages[0])) {
            dedupedMessages.shift();
            continue;
        }

        // Gen-id dedup: server's sidecar remembers the last write's gen id; if
        // the incoming write carries the same id (passed via request body now,
        // not extracted from extras), it's a retry of an already-acked write.
        if (!sidecarLastGenerationId || !incomingId || incomingId !== sidecarLastGenerationId) {
            break;
        }
        matchedExistingGenerationId = true;
        dedupedMessages.shift();
    }

    if (dedupedMessages.length === 0) {
        return {
            appended: 0,
            created: false,
            skipped: cleanedMessages.length,
            matched_existing_generation_id: matchedExistingGenerationId,
            integrity: getCurrentChatIntegrity(filePath),
        };
    }

    const dedupedSerializedMessages = dedupedMessages.map(message => JSON.stringify(message)).join('\n');
    fs.appendFileSync(filePath, `\n${dedupedSerializedMessages}`, 'utf8');
    const nextIntegrity = rotateChatIntegrity(filePath);
    if (incomingId) {
        writeLastChatGenerationId(filePath, incomingId);
    }
    return {
        appended: dedupedMessages.length,
        created: false,
        skipped: cleanedMessages.length - dedupedMessages.length,
        matched_existing_generation_id: matchedExistingGenerationId,
        integrity: nextIntegrity,
    };
}

/**
 * Applies RFC6902 patch operations to chat messages in a chat file.
 * @param {object} args Patch options.
 * @param {string} args.filePath Target chat file path.
 * @param {object[]|object} args.operations RFC6902 operations array.
 * @param {object} [args.chatMetadata] Optional metadata merge for header.
 * @param {string} [args.integritySlug] Integrity slug to validate before patching.
 * @param {boolean} [args.force] Skip integrity mismatch error if true.
 * @param {string} [args.incomingGenerationId] Protocol-layer gen id for ack
 *   tracking. Recorded to the sync sidecar after a successful patch.
 * @returns {Promise<{applied:number,total_messages:number}>}
 */
export async function patchChatMessagesInFile({ filePath, operations, chatMetadata = {}, integritySlug, force = false, incomingGenerationId = '' }) {
    const normalizedOperations = Array.isArray(operations)
        ? operations
        : (_.isObjectLike(operations) ? [operations] : []);
    if (normalizedOperations.length === 0) {
        return { applied: 0, total_messages: 0 };
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (integritySlug && !force && !await checkChatIntegrity(filePath, integritySlug)) {
        throw createIntegrityMismatchError(filePath, integritySlug);
    }

    // Drop any op that targets the protocol-layer luker_generation_id path,
    // and strip the field from message-shaped values inside add/replace ops.
    // Old clients embedding it shouldn't be able to put it back on disk.
    const sanitizedOperations = sanitizeOperationsAgainstLukerGenerationId(normalizedOperations);
    if (sanitizedOperations.length === 0) {
        // All ops were lukgenid bookkeeping; nothing left to do. Still update
        // the sidecar so the ack tracking moves forward.
        const incomingId = String(incomingGenerationId || '').trim();
        if (incomingId) writeLastChatGenerationId(filePath, incomingId);
        return { applied: 0, total_messages: 0, integrity: getCurrentChatIntegrity(filePath) };
    }

    /** @type {object[]} */
    let chatData = fs.existsSync(filePath) ? getChatData(filePath) : [];
    // getChatData may return { new_chat: true } or { corrupted: true } — coerce to array
    if (!Array.isArray(chatData)) {
        chatData = [];
    }
    if (chatData.length === 0) {
        chatData = [createChatHeader(_.isObjectLike(chatMetadata) ? chatMetadata : {})];
    }

    const first = chatData[0];
    const hasHeader = _.isObjectLike(first) && Object.hasOwn(first, 'chat_metadata');
    if (!hasHeader) {
        chatData.unshift(createChatHeader(_.isObjectLike(chatMetadata) ? chatMetadata : {}));
    } else if (_.isObjectLike(chatMetadata) && Object.keys(chatMetadata).length > 0) {
        chatData[0].chat_metadata = {
            ...(_.isObjectLike(chatData[0].chat_metadata) ? chatData[0].chat_metadata : {}),
            ...chatMetadata,
        };
    }

    const currentMessages = chatData.slice(1);
    const idempotentOperations = buildIdempotentMessagePatchOperations(currentMessages, sanitizedOperations);
    const patchResult = applyJsonPatch(currentMessages, idempotentOperations, true, false);
    const patchedMessages = patchResult.newDocument;
    if (!Array.isArray(patchedMessages)) {
        throw new Error('Message patch must produce an array root.');
    }

    const nextIntegrity = randomUUID();
    const header = chatData[0];
    header.chat_metadata = applyIntegrityToMetadata(header.chat_metadata, nextIntegrity);
    const serialized = [header, ...patchedMessages].map(entry => JSON.stringify(entry)).join('\n');
    tryWriteFileSync(filePath, serialized);
    writeChatSyncState(filePath, { integrity: nextIntegrity, updated_at: Date.now() });
    const incomingId = String(incomingGenerationId || '').trim();
    if (incomingId) writeLastChatGenerationId(filePath, incomingId);

    return {
        applied: idempotentOperations.length,
        total_messages: patchedMessages.length,
        integrity: nextIntegrity,
    };
}

/**
 * Drops or sanitizes any patch op that touches the protocol-layer
 * luker_generation_id field. Specifically:
 * - Ops whose path ends in `/extra/luker_generation_id` are removed entirely
 *   (no client should be writing this to disk).
 * - For add/replace ops whose value is a full message or an `extra` object,
 *   the lukgenid is stripped from value before the op gets applied.
 */
function sanitizeOperationsAgainstLukerGenerationId(operations) {
    /** @type {object[]} */
    const result = [];
    for (const op of operations) {
        if (!_.isObjectLike(op) || typeof op.path !== 'string') {
            result.push(op);
            continue;
        }
        if (op.path.endsWith('/extra/luker_generation_id')) {
            continue;
        }
        const opName = String(op.op || '').trim().toLowerCase();
        if ((opName === 'add' || opName === 'replace') && _.isObjectLike(op.value)) {
            const cloned = _.cloneDeep(op);
            // Either it's a whole message at /N, or it's an `extra` blob at /N/extra.
            if (cloned.value && _.isObjectLike(cloned.value.extra) && 'luker_generation_id' in cloned.value.extra) {
                delete cloned.value.extra.luker_generation_id;
            }
            if (op.path.endsWith('/extra') && _.isObjectLike(cloned.value) && 'luker_generation_id' in cloned.value) {
                delete cloned.value.luker_generation_id;
            }
            result.push(cloned);
        } else {
            result.push(op);
        }
    }
    return result;
}

/**
 * Updates only chat metadata header in a chat file.
 * Creates the chat file header when the target file does not exist yet.
 * @param {object} args Update options.
 * @param {string} args.filePath Target chat file path.
 * @param {object} args.chatMetadata Metadata patch to merge into header.
 * @param {string} [args.integritySlug] Integrity slug to validate before updating.
 * @param {boolean} [args.force] Skip integrity mismatch error if true.
 * @returns {Promise<{updated:boolean,total_messages:number,created:boolean}>}
 */
export async function updateChatMetadataInFile({ filePath, chatMetadata = {}, integritySlug, force = false }) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (integritySlug && !force && !await checkChatIntegrity(filePath, integritySlug)) {
        throw createIntegrityMismatchError(filePath, integritySlug);
    }

    /** @type {object[]} */
    let chatData = getChatData(filePath);
    // getChatData may return { new_chat: true } or { corrupted: true } — coerce to array
    if (!Array.isArray(chatData)) {
        chatData = [];
    }
    const created = chatData.length === 0;
    if (created) {
        chatData = [createChatHeader({})];
    }

    const first = chatData[0];
    const hasHeader = _.isObjectLike(first) && Object.hasOwn(first, 'chat_metadata');
    if (!hasHeader) {
        chatData.unshift(createChatHeader({}));
    }

    chatData[0].chat_metadata = {
        ...(_.isObjectLike(chatData[0].chat_metadata) ? chatData[0].chat_metadata : {}),
        ...(_.isObjectLike(chatMetadata) ? chatMetadata : {}),
    };
    const nextIntegrity = randomUUID();
    chatData[0].chat_metadata = applyIntegrityToMetadata(chatData[0].chat_metadata, nextIntegrity);

    const serialized = chatData.map(entry => JSON.stringify(entry)).join('\n');
    tryWriteFileSync(filePath, serialized);
    writeChatSyncState(filePath, { integrity: nextIntegrity, updated_at: Date.now() });

    return {
        updated: true,
        total_messages: Math.max(chatData.length - 1, 0),
        created,
        integrity: nextIntegrity,
    };
}

/**
 * Applies patch operations to chat metadata header in a chat file.
 * Creates the chat file header when the target file does not exist yet.
 * @param {object} args Patch options.
 * @param {string} args.filePath Target chat file path.
 * @param {object[]} args.operations Metadata patch operations.
 * @param {string} [args.integritySlug] Integrity slug to validate before updating.
 * @param {boolean} [args.force] Skip integrity mismatch error if true.
 * @returns {Promise<{applied:number,total_messages:number,created:boolean}>}
 */
export async function patchChatMetadataInFile({ filePath, operations = [], integritySlug, force = false }) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (integritySlug && !force && !await checkChatIntegrity(filePath, integritySlug)) {
        throw createIntegrityMismatchError(filePath, integritySlug);
    }

    /** @type {object[]} */
    let chatData = getChatData(filePath);
    // getChatData may return { new_chat: true } or { corrupted: true } — coerce to array
    if (!Array.isArray(chatData)) {
        chatData = [];
    }
    const created = chatData.length === 0;
    if (created) {
        chatData = [createChatHeader({})];
    }

    const first = chatData[0];
    const hasHeader = _.isObjectLike(first) && Object.hasOwn(first, 'chat_metadata');
    if (!hasHeader) {
        chatData.unshift(createChatHeader({}));
    }

    const currentMetadata = _.isObjectLike(chatData[0].chat_metadata) && !Array.isArray(chatData[0].chat_metadata)
        ? chatData[0].chat_metadata
        : {};
    const result = applyChatStatePatch(currentMetadata, operations);
    const nextIntegrity = randomUUID();
    chatData[0].chat_metadata = applyIntegrityToMetadata(result.state, nextIntegrity);

    const serialized = chatData.map(entry => JSON.stringify(entry)).join('\n');
    tryWriteFileSync(filePath, serialized);
    writeChatSyncState(filePath, { integrity: nextIntegrity, updated_at: Date.now() });

    return {
        applied: result.applied,
        total_messages: Math.max(chatData.length - 1, 0),
        created,
        integrity: nextIntegrity,
    };
}

/**
 * Reads chat file delta by message index.
 * @param {string} chatFilePath Full path to chat file.
 * @param {number} fromIndex Zero-based message index excluding header.
 * @param {number} limit Number of messages to return, <=0 means no limit.
 * @returns {{chat: object[], chat_metadata: object, from_index: number, next_index: number, total_messages: number, has_more: boolean}}
 */
function getChatDataDelta(chatFilePath, fromIndex = 0, limit = 0) {
    const chatData = getChatData(chatFilePath);
    // getChatData may return { new_chat: true } or { corrupted: true } — coerce to array
    if (!Array.isArray(chatData) || chatData.length === 0) {
        return {
            chat: [],
            chat_metadata: {},
            from_index: 0,
            next_index: 0,
            total_messages: 0,
            has_more: false,
        };
    }

    const safeLimit = Number(limit) || 0;
    const header = chatData[0];
    const messages = chatData.slice(1);
    const numericFromIndex = Number(fromIndex) || 0;
    const normalizedFromIndex = numericFromIndex < 0
        ? Math.max(messages.length + numericFromIndex, 0)
        : numericFromIndex;
    const safeFromIndex = Math.min(Math.max(0, normalizedFromIndex), messages.length);
    const sliced = safeLimit > 0
        ? messages.slice(safeFromIndex, safeFromIndex + safeLimit)
        : messages.slice(safeFromIndex);

    return {
        chat: sliced,
        chat_metadata: header?.chat_metadata ?? {},
        from_index: safeFromIndex,
        next_index: safeFromIndex + sliced.length,
        total_messages: messages.length,
        has_more: (safeFromIndex + sliced.length) < messages.length,
    };
}

/**
 * Tries to save the chat data to a file, performing an integrity check if required.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {string} handle The users handle, passed to getBackupFunction.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat.
 * @returns {Promise<string>} The new chat integrity value.
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory) {
    if (!Array.isArray(chatData) || chatData.length === 0) {
        throw new Error('Cannot save empty chat payload.');
    }

    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrity(filePath, chatIntegritySlug)) {
        throw createIntegrityMismatchError(filePath, chatIntegritySlug);
    }

    const nextIntegrity = randomUUID();
    const header = _.isObjectLike(chatData[0]) ? chatData[0] : createChatHeader({});
    header.chat_metadata = applyIntegrityToMetadata(header.chat_metadata, nextIntegrity);
    chatData[0] = header;
    const jsonlData = chatData.map(m => JSON.stringify(m)).join('\n');

    tryWriteFileSync(filePath, jsonlData);
    writeChatSyncState(filePath, { integrity: nextIntegrity, updated_at: Date.now() });
    getBackupFunction(handle)(backupDirectory, cardName, jsonlData);
    return nextIntegrity;
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        if (!Array.isArray(chatData)) {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
        if (chatData.length === 0) {
            throw new Error('Cannot save empty chat payload.');
        }

        const force = Boolean(request.body.force);
        const headerInput = _.isObjectLike(chatData[0]) ? chatData[0] : createChatHeader({});
        const body = chatData.slice(1);

        const doIntegrityCheck = (checkIntegrity && !force);
        const slugFromHeader = doIntegrityCheck
            ? String(headerInput?.chat_metadata?.integrity ?? '').trim()
            : '';
        const expectedIntegrity = slugFromHeader || null;

        let integrity;
        try {
            ({ integrity } = await getChatRepo().save(handle, cardName, String(request.body.file_name), headerInput, body, expectedIntegrity));
        } catch (err) {
            if (err instanceof NotFoundError && expectedIntegrity !== null) {
                // Existing semantic: missing file means no current integrity to mismatch — write succeeds.
                ({ integrity } = await getChatRepo().save(handle, cardName, String(request.body.file_name), headerInput, body, null));
            } else if (err instanceof ConflictError) {
                return sendRepoIntegrityConflict(response, err);
            } else {
                throw err;
            }
        }

        writeChatSyncState(chatFilePath, { integrity, updated_at: Date.now() });
        try {
            const headerWithIntegrity = {
                ...headerInput,
                chat_metadata: applyIntegrityToMetadata(headerInput.chat_metadata, integrity),
            };
            const jsonlData = [headerWithIntegrity, ...body].map(m => JSON.stringify(m)).join('\n');
            getBackupFunction(handle)(request.user.directories.backups, cardName, jsonlData);
        } catch (backupErr) {
            console.error('Chat backup after save failed', backupErr);
        }

        await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
        acknowledgeGenerationFromValueOrPersistTarget(request, chatData, buildCharacterPersistTargetHint(request));
        return response.send({ ok: true, integrity });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/append', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const fileNameRaw = String(request.body.file_name);
        const chatFileName = `${fileNameRaw}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        const chatMetadata = _.isObjectLike(request.body.chat_metadata) ? request.body.chat_metadata : {};
        const force = Boolean(request.body.force);
        const slugRaw = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const incomingId = typeof request.body.luker_generation_id === 'string'
            ? request.body.luker_generation_id.trim()
            : '';
        const messages = Array.isArray(request.body.messages)
            ? request.body.messages
            : (_.isObjectLike(request.body.message) ? [request.body.message] : []);

        if (messages.length === 0) {
            return response.status(400).send({ error: 'No message payload found. Expected body.messages or body.message.' });
        }

        const repo = getChatRepo();
        const existing = await repo.get(handle, cardName, fileNameRaw);

        if (slugRaw && !force && existing && existing.integrity !== slugRaw) {
            throw createIntegrityMismatchError(chatFilePath, slugRaw);
        }

        const cleanedMessages = messages.map(m => stripLukerGenerationIdFromMessage(_.cloneDeep(m)));

        if (!existing) {
            const header = createChatHeader(_.isObjectLike(chatMetadata) ? chatMetadata : {});
            const { integrity: newIntegrity } = await repo.save(handle, cardName, fileNameRaw, header, cleanedMessages, null);
            writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
            if (incomingId) {
                writeLastChatGenerationId(chatFilePath, incomingId);
            }
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
            acknowledgeGenerationFromValueOrPersistTarget(request, messages, buildCharacterPersistTargetHint(request));
            return response.send({ ok: true, appended: cleanedMessages.length, created: true, integrity: newIntegrity });
        }

        const dedupedMessages = cleanedMessages.slice();
        const lastStoredMessage = existing.body.length > 0 ? existing.body[existing.body.length - 1] : null;
        const sidecarLastGenerationId = readLastChatGenerationId(chatFilePath);
        let matchedExistingGenerationId = false;
        while (dedupedMessages.length > 0) {
            const lastStoredStripped = isChatMessageLike(lastStoredMessage)
                ? stripLukerGenerationIdFromMessage(_.cloneDeep(lastStoredMessage))
                : null;
            if (lastStoredStripped && isChatMessageLike(dedupedMessages[0]) && _.isEqual(lastStoredStripped, dedupedMessages[0])) {
                dedupedMessages.shift();
                continue;
            }
            if (!sidecarLastGenerationId || !incomingId || incomingId !== sidecarLastGenerationId) {
                break;
            }
            matchedExistingGenerationId = true;
            dedupedMessages.shift();
        }

        if (dedupedMessages.length === 0) {
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
            acknowledgeGenerationFromValueOrPersistTarget(request, messages, buildCharacterPersistTargetHint(request));
            return response.send({
                ok: true,
                appended: 0,
                created: false,
                skipped: cleanedMessages.length,
                matched_existing_generation_id: matchedExistingGenerationId,
                integrity: existing.integrity,
            });
        }

        const mergedBody = existing.body.concat(dedupedMessages);
        const expectedForSave = (slugRaw && !force) ? slugRaw : null;
        let newIntegrity;
        try {
            ({ integrity: newIntegrity } = await repo.save(handle, cardName, fileNameRaw, existing.header, mergedBody, expectedForSave));
        } catch (err) {
            if (err instanceof ConflictError) {
                return sendRepoIntegrityConflict(response, err);
            }
            throw err;
        }
        writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
        if (incomingId) {
            writeLastChatGenerationId(chatFilePath, incomingId);
        }

        await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
        acknowledgeGenerationFromValueOrPersistTarget(request, messages, buildCharacterPersistTargetHint(request));
        return response.send({
            ok: true,
            appended: dedupedMessages.length,
            created: false,
            skipped: cleanedMessages.length - dedupedMessages.length,
            matched_existing_generation_id: matchedExistingGenerationId,
            integrity: newIntegrity,
        });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/patch', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const fileNameRaw = String(request.body.file_name);
        const chatFileName = `${fileNameRaw}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        const chatMetadata = _.isObjectLike(request.body.chat_metadata) ? request.body.chat_metadata : {};
        const slugRaw = typeof request.body.integrity === 'string' ? request.body.integrity.trim() : '';
        const force = Boolean(request.body.force);
        const incomingId = typeof request.body.luker_generation_id === 'string'
            ? request.body.luker_generation_id.trim()
            : '';
        const operations = Array.isArray(request.body.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body.operations)
                ? [request.body.operations]
                : (_.isObjectLike(request.body.operation) ? [request.body.operation] : []));

        if (operations.length === 0) {
            return response.status(400).send({ error: 'No patch operations found. Expected body.operations or body.operation.' });
        }

        const repo = getChatRepo();
        const existing = await repo.get(handle, cardName, fileNameRaw);

        if (slugRaw && !force && existing && existing.integrity !== slugRaw) {
            throw createIntegrityMismatchError(chatFilePath, slugRaw);
        }

        const sanitizedOperations = sanitizeOperationsAgainstLukerGenerationId(operations);
        if (sanitizedOperations.length === 0) {
            if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);
            const currentIntegrity = existing ? existing.integrity : '';
            await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
            acknowledgeGenerationFromValueOrPersistTarget(request, operations, buildCharacterPersistTargetHint(request));
            return response.send({ ok: true, applied: 0, total_messages: 0, integrity: currentIntegrity });
        }

        const currentHeader = existing?.header
            ? (_.isObjectLike(existing.header) ? existing.header : createChatHeader(chatMetadata))
            : createChatHeader(chatMetadata);
        const currentMessages = existing?.body ? existing.body : [];

        const mergedHeader = (() => {
            const base = _.isObjectLike(currentHeader) ? { ...currentHeader } : createChatHeader(chatMetadata);
            if (_.isObjectLike(chatMetadata) && Object.keys(chatMetadata).length > 0) {
                base.chat_metadata = {
                    ...(_.isObjectLike(base.chat_metadata) ? base.chat_metadata : {}),
                    ...chatMetadata,
                };
            } else if (!_.isObjectLike(base.chat_metadata)) {
                base.chat_metadata = {};
            }
            return base;
        })();

        let patchedMessages;
        let idempotentOperations;
        try {
            idempotentOperations = buildIdempotentMessagePatchOperations(currentMessages, sanitizedOperations);
            const patchResult = applyJsonPatch(currentMessages, idempotentOperations, true, false);
            patchedMessages = patchResult.newDocument;
            if (!Array.isArray(patchedMessages)) {
                throw new Error('Message patch must produce an array root.');
            }
        } catch (error) {
            if (isChatStatePatchConflictError(error)) {
                return response.status(409).send({ error: 'Chat patch conflict.' });
            }
            if (isJsonPatchValidationError(error)) {
                return response.status(400).send({ error: 'Invalid chat patch payload.' });
            }
            throw error;
        }

        const expectedForSave = existing ? ((slugRaw && !force) ? slugRaw : null) : null;
        let newIntegrity;
        try {
            ({ integrity: newIntegrity } = await repo.save(handle, cardName, fileNameRaw, mergedHeader, patchedMessages, expectedForSave));
        } catch (err) {
            if (err instanceof ConflictError) {
                return sendRepoIntegrityConflict(response, err);
            }
            throw err;
        }
        writeChatSyncState(chatFilePath, { integrity: newIntegrity, updated_at: Date.now() });
        if (incomingId) writeLastChatGenerationId(chatFilePath, incomingId);

        await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
        acknowledgeGenerationFromValueOrPersistTarget(request, operations, buildCharacterPersistTargetHint(request));
        return response.send({
            ok: true,
            applied: idempotentOperations.length,
            total_messages: patchedMessages.length,
            integrity: newIntegrity,
        });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/meta', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!_.isObjectLike(request.body?.chat_metadata)) {
            return response.status(400).send({ error: 'Expected body.chat_metadata object.' });
        }
        if (typeof request.body?.file_name !== 'string' || !String(request.body.file_name).trim()) {
            return response.status(400).send({ error: 'Expected body.file_name string.' });
        }

        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        const chatMetadata = request.body.chat_metadata;
        const integritySlug = typeof request.body.integrity === 'string' ? request.body.integrity : undefined;
        const force = Boolean(request.body.force);

        const result = await updateChatMetadataInFile({
            filePath: chatFilePath,
            chatMetadata,
            integritySlug,
            force,
        });

        await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
        return response.send({ ok: true, ...result });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/meta/patch', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (typeof request.body?.file_name !== 'string' || !String(request.body.file_name).trim()) {
            return response.status(400).send({ error: 'Expected body.file_name string.' });
        }
        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body?.operations)
                ? [request.body.operations]
                : (_.isObjectLike(request.body?.operation) ? [request.body.operation] : []));
        if (operations.length === 0) {
            return response.status(400).send({ error: 'No metadata patch operations found. Expected body.operations or body.operation.' });
        }

        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        const integritySlug = typeof request.body.integrity === 'string' ? request.body.integrity : undefined;
        const force = Boolean(request.body.force);

        let result;
        try {
            result = await patchChatMetadataInFile({
                filePath: chatFilePath,
                operations,
                integritySlug,
                force,
            });
        } catch (error) {
            if (isChatStatePatchConflictError(error)) {
                return response.status(409).send({ error: 'Chat metadata patch conflict.' });
            }
            if (isJsonPatchValidationError(error)) {
                return response.status(400).send({ error: 'Invalid metadata patch payload.' });
            }
            throw error;
        }

        await refreshRecentChatIndexEntry(request, chatFilePath, { avatar: String(request.body.avatar_url || '') });
        return response.send({ ok: true, ...result });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Gets the chat as an object.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}} If the chatFilePath cannot be read, this will return [].
 */
export function getChatData(chatFilePath) {
    const chatJSON = tryReadFileSync(chatFilePath);

    // File does not exist → genuinely new chat
    if (chatJSON === null) {
        return { new_chat: true };
    }

    // File exists but is empty → corrupted (a valid chat file always has at least a header line)
    if (chatJSON.length === 0) {
        console.warn(`Chat file is empty (corrupted): ${chatFilePath}`);
        return { corrupted: true };
    }

    const lines = chatJSON.split('\n');
    const chatData = lines.map(line => tryParse(line)).filter(x => x);

    if (chatData.length === 0) {
        console.warn(`Chat file has no valid JSON lines (corrupted): ${chatFilePath}`);
        return { corrupted: true };
    }

    // Strip the protocol-layer luker_generation_id from each message before
    // returning. Old chat files may have it baked into extra; new writes
    // never put it there. Stripping here means clients (and server-internal
    // callers) get a consistent, gen-id-free view regardless of file age.
    for (let i = 1; i < chatData.length; i++) {
        stripLukerGenerationIdFromMessage(chatData[i]);
    }

    return attachCurrentIntegrityToChatData(chatData, chatFilePath);
}

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }
        const chatDirExists = fs.existsSync(directoryPath);

        //if no chat dir for the character is found, make one with the character name
        if (!chatDirExists) {
            fs.mkdirSync(directoryPath);
            return response.send({ new_chat: true });
        }

        if (!request.body.file_name) {
            return response.send({ new_chat: true });
        }

        const handle = request.user.profile.handle;
        const fetched = await getChatRepo().get(handle, dirName, String(request.body.file_name));
        if (!fetched) {
            const chatFilePath = path.join(directoryPath, sanitize(`${String(request.body.file_name)}.jsonl`));
            if (fs.existsSync(chatFilePath)) {
                console.warn(`Chat file is empty or has no valid JSON lines (corrupted): ${chatFilePath}`);
                return response.send({ corrupted: true });
            }
            return response.send({ new_chat: true });
        }
        const headerWithIntegrity = {
            ...fetched.header,
            chat_metadata: {
                ...(fetched.header.chat_metadata ?? {}),
                integrity: fetched.integrity,
            },
        };
        return response.send([headerWithIntegrity, ...fetched.body]);
    } catch (error) {
        console.error(error);
        return response.status(500).send({ corrupted: true });
    }
});

router.post('/get-delta', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        const chatDirExists = fs.existsSync(directoryPath);

        if (!chatDirExists || !request.body.file_name) {
            return response.send({
                chat: [],
                chat_metadata: {},
                from_index: 0,
                next_index: 0,
                total_messages: 0,
                has_more: false,
            });
        }

        const fromIndex = Number(request.body.from_index) || 0;
        const limit = Number(request.body.limit) || 0;
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(directoryPath, sanitize(chatFileName));

        return response.send(getChatDataDelta(chatFilePath, fromIndex, limit));
    } catch (error) {
        console.error(error);
        return response.send({
            chat: [],
            chat_metadata: {},
            from_index: 0,
            next_index: 0,
            total_messages: 0,
            has_more: false,
        });
    }
});

router.post('/state/get', async function (request, response) {
    try {
        const target = request.body || {};
        const repoKey = resolveChatStateRepoKey(request, target);
        const namespace = normalizeChatStateNamespace(target?.namespace);
        if (!repoKey) {
            return response.status(400).send({ error: 'Invalid state target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        const data = await getChatRepo().getState(
            repoKey.handle,
            repoKey.charDir,
            repoKey.name,
            namespace,
            { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
        );
        return response.send({ ok: true, data });
    } catch (error) {
        console.error('Error reading chat state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/get-batch', async function (request, response) {
    try {
        const target = request.body || {};
        const repoKey = resolveChatStateRepoKey(request, target);
        const namespaces = [...new Set((Array.isArray(target?.namespaces) ? target.namespaces : [])
            .map((namespace) => normalizeChatStateNamespace(namespace))
            .filter(Boolean))];
        if (!repoKey) {
            return response.status(400).send({ error: 'Invalid state target payload.' });
        }
        if (!namespaces.length) {
            return response.status(400).send({ error: 'Expected body.namespaces array.' });
        }

        const data = await getChatRepo().getStateBatch(
            repoKey.handle,
            repoKey.charDir,
            repoKey.name,
            namespaces,
            { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
        );

        return response.send({ ok: true, data });
    } catch (error) {
        console.error('Error reading chat state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/patch', async function (request, response) {
    try {
        const target = request.body || {};
        const repoKey = resolveChatStateRepoKey(request, target);
        const namespace = normalizeChatStateNamespace(target?.namespace);
        if (!repoKey) {
            return response.status(400).send({ error: 'Invalid state target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        const operations = Array.isArray(target?.operations)
            ? target.operations
            : (_.isObjectLike(target?.operations)
                ? [target.operations]
                : (_.isObjectLike(target?.operation) ? [target.operation] : []));
        if (operations.length === 0) {
            return response.status(400).send({ error: 'No state patch operations found. Expected body.operations or body.operation.' });
        }

        // Use the storage engine transaction directly: legacy behavior is permissive and
        // allows writing a sidecar even when the parent chat does not exist, which the
        // ChatRepo.setState wrapper guards against with a NotFoundError.
        const engine = getStorageEngine();
        const repoKeyForEngine = {
            kind: 'chat',
            handle: repoKey.handle,
            charDir: repoKey.charDir,
            name: repoKey.name,
            isGroup: repoKey.isGroup,
            groupId: repoKey.groupId,
        };
        const { applied, created } = await engine.withTransaction(repoKey.handle, async (tx) => {
            const existing = await tx.getChatState(repoKeyForEngine, namespace);
            const existed = existing !== null && existing !== undefined;
            const state = (_.isObjectLike(existing) && !Array.isArray(existing)) ? existing : {};
            const result = applyChatStatePatch(state, operations);
            await tx.putChatState(repoKeyForEngine, namespace, result.state);
            return { applied: result.applied, created: !existed };
        });
        return response.send({ ok: true, applied, created });
    } catch (error) {
        if (isChatStatePatchConflictError(error)) {
            return response.status(409).send({ error: 'Chat state patch conflict.' });
        }
        if (isJsonPatchValidationError(error)) {
            return response.status(400).send({ error: 'Invalid chat state patch payload.' });
        }
        console.error('Error patching chat state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/delete', async function (request, response) {
    try {
        const target = request.body || {};
        const repoKey = resolveChatStateRepoKey(request, target);
        const namespace = normalizeChatStateNamespace(target?.namespace);
        if (!repoKey) {
            return response.status(400).send({ error: 'Invalid state target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        // deleteState returns void; report `deleted: true` on success to preserve the
        // legacy contract — the frontend reads `response.ok` only.
        await getChatRepo().deleteState(
            repoKey.handle,
            repoKey.charDir,
            repoKey.name,
            namespace,
            { isGroup: repoKey.isGroup, groupId: repoKey.groupId },
        );
        return response.send({ ok: true, deleted: true });
    } catch (error) {
        console.error('Error deleting chat state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        const isGroup = Boolean(request.body.is_group);
        const charDir = isGroup ? '' : String(request.body.avatar_url).replace('.png', '');
        const pathToFolder = isGroup
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, charDir);
        if (!isGroup && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const safeOriginal = sanitize(String(request.body.original_file));
        const safeRenamed = sanitize(String(request.body.renamed_file));
        const pathToOriginalFile = path.join(pathToFolder, safeOriginal);
        const pathToRenamedFile = path.join(pathToFolder, safeRenamed);
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        console.debug('Old chat name', pathToOriginalFile);
        console.debug('New chat name', pathToRenamedFile);

        if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
            console.error('Either Source or Destination files are not available');
            return response.status(400).send({ error: true });
        }

        const existingIndexState = await getReadyRecentChatIndexState(request);
        const previousRecentEntry = existingIndexState?.entries?.get(path.resolve(pathToOriginalFile)) || null;
        const oldName = path.parse(safeOriginal).name;
        const newName = path.parse(safeRenamed).name;
        try {
            await getChatRepo().rename(handle, charDir, oldName, newName, { isGroup });
        } catch (err) {
            if (err instanceof NotFoundError) {
                return response.status(400).send({ error: true });
            }
            if (err instanceof ConflictError) {
                return response.status(409).send({ error: err.code });
            }
            throw err;
        }
        renameAllChatStateSidecars(pathToOriginalFile, pathToRenamedFile);
        await deleteRecentChatIndexEntry(request, pathToOriginalFile);
        await refreshRecentChatIndexEntry(request, pathToRenamedFile, {
            avatar: isGroup ? '' : String(request.body.avatar_url || ''),
            group: isGroup ? String(previousRecentEntry?.group || '') : '',
        });

        console.info('Successfully renamed chat file.');
        return response.send({ ok: true, sanitizedFileName });
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const handle = request.user.profile.handle;
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.chatfile);
        const safeFileName = sanitize(chatFileName);
        const chatFilePath = path.join(request.user.directories.chats, dirName, safeFileName);
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        if (!fs.existsSync(chatFilePath)) {
            console.error('The chat file was not deleted.');
            return response.sendStatus(400);
        }
        const name = path.parse(safeFileName).name;
        await getChatRepo().delete(handle, dirName, name);
        deleteAllChatStateSidecars(chatFilePath);
        await deleteRecentChatIndexEntry(request, chatFilePath);
        return response.send({ ok: true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = resolvePathInsideDirectory(pathToFolder, request.body.file);
    if (!filename) {
        return response.sendStatus(400);
    }
    let exportfilename = request.body.exportfilename;
    if (!fs.existsSync(filename)) {
        const errorMessage = {
            message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
        };
        console.error(errorMessage.message);
        return response.status(404).json(errorMessage);
    }
    try {
        // Short path for JSONL files
        if (request.body.format === 'jsonl') {
            try {
                const rawFile = fs.readFileSync(filename, 'utf8');
                const successMessage = {
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                };

                console.info(`Chat exported as ${exportfilename}`);
                return response.status(200).json(successMessage);
            } catch (err) {
                console.error(err);
                const errorMessage = {
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                };
                console.error(errorMessage.message);
                return response.status(500).json(errorMessage);
            }
        }

        const readStream = fs.createReadStream(filename);
        const rl = readline.createInterface({
            input: readStream,
        });
        let buffer = '';
        rl.on('line', (line) => {
            const data = JSON.parse(line);
            // Skip non-printable/prompt-hidden messages
            if (data.is_system) {
                return;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        });
        rl.on('close', () => {
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        });
    } catch (err) {
        console.error('chat export failed.', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const pathToNewFile = path.join(request.user.directories.groupChats, `${chatname}.jsonl`);
        fs.copyFileSync(pathToUpload, pathToNewFile);
        fs.unlinkSync(pathToUpload);
        return response.send({ res: chatname });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = path.join(request.user.directories.chats, avatarUrl);
    if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const data = fs.readFileSync(pathToUpload, 'utf8');

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) { // Kobold Lite format
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) { // CAI Tools format
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) { // oobabooga's format
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) { // Agnai's format
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') { // RisuAI format
                importFunc = importRisuChat;
            } else { // Unknown format
                console.error('Incorrect chat format .json');
                return response.send({ error: true });
            }

            const handleChat = (chat) => {
                const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
                const filePath = path.join(directoryPath, fileName);
                fileNames.push(fileName);
                writeFileAtomicSync(filePath, chat, 'utf8');
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                chat.forEach(handleChat);
            } else {
                handleChat(chat);
            }

            await Promise.all(fileNames.map((fileName) => refreshRecentChatIndexEntry(
                request,
                path.join(request.user.directories.chats, avatarUrl, fileName),
                { avatar: `${avatarUrl}.png` },
            )));

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];

            const jsonData = JSON.parse(header);

            if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            // Do a tiny bit of work to import Chub Chat data
            // Processing the entire file is so fast that it's not worth checking if it's a Chub chat first
            let flattenedChat = data;
            try {
                // flattening is unlikely to break, but it's not worth failing to
                // import normal chats in an attempt to import a Chub chat
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
            const filePath = path.join(directoryPath, fileName);
            fileNames.push(fileName);
            if (flattenedChat !== data) {
                writeFileAtomicSync(filePath, flattenedChat, 'utf8');
            } else {
                fs.copyFileSync(pathToUpload, filePath);
            }
            fs.unlinkSync(pathToUpload);
            await refreshRecentChatIndexEntry(request, filePath, { avatar: `${avatarUrl}.png` });
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/group/get', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

    return response.send(getChatData(chatFilePath));
});

router.post('/group/get-delta', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const fromIndex = Number(request.body.from_index) || 0;
    const limit = Number(request.body.limit) || 0;
    const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
    return response.send(getChatDataDelta(chatFilePath, fromIndex, limit));
});

router.post('/group/info', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        const chatInfo = await getChatInfo(chatFilePath);
        return response.send(chatInfo);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/delete', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        //Return success if the file was deleted.
        if (tryDeleteFile(chatFilePath)) {
            deleteAllChatStateSidecars(chatFilePath);
            await deleteRecentChatIndexEntry(request, chatFilePath);
            return response.send({ ok: true });
        } else {
            console.error('The group chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const handle = request.user.profile.handle;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatData = request.body.chat;

        if (Array.isArray(chatData)) {
            const integrity = await trySaveChat(chatData, chatFilePath, request.body.force, handle, String(id), request.user.directories.backups);
            await refreshRecentChatIndexEntry(request, chatFilePath);
            acknowledgeGenerationFromValueOrPersistTarget(request, chatData, buildGroupPersistTargetHint(request));
            return response.send({ ok: true, integrity });
        }
        else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/group/append', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatMetadata = _.isObjectLike(request.body.chat_metadata) ? request.body.chat_metadata : {};
        const integritySlug = typeof request.body.integrity === 'string' ? request.body.integrity : undefined;
        const force = Boolean(request.body.force);
        const messages = Array.isArray(request.body.messages)
            ? request.body.messages
            : (_.isObjectLike(request.body.message) ? [request.body.message] : []);

        if (messages.length === 0) {
            return response.status(400).send({ error: 'No message payload found. Expected body.messages or body.message.' });
        }

        const result = await appendMessagesToChatFile({
            filePath: chatFilePath,
            messages,
            chatMetadata,
            integritySlug,
            force,
            incomingGenerationId: typeof request.body.luker_generation_id === 'string' ? request.body.luker_generation_id : '',
        });

        await refreshRecentChatIndexEntry(request, chatFilePath);
        acknowledgeGenerationFromValueOrPersistTarget(request, messages, buildGroupPersistTargetHint(request));
        return response.send({ ok: true, ...result });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/group/patch', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = String(request.body.id);
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatMetadata = _.isObjectLike(request.body.chat_metadata) ? request.body.chat_metadata : {};
        const integritySlug = typeof request.body.integrity === 'string' ? request.body.integrity : undefined;
        const force = Boolean(request.body.force);
        const operations = Array.isArray(request.body.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body.operations)
                ? [request.body.operations]
                : (_.isObjectLike(request.body.operation) ? [request.body.operation] : []));

        if (operations.length === 0) {
            return response.status(400).send({ error: 'No patch operations found. Expected body.operations or body.operation.' });
        }

        let result;
        try {
            result = await patchChatMessagesInFile({
                filePath: chatFilePath,
                operations,
                chatMetadata,
                integritySlug,
                force,
                incomingGenerationId: typeof request.body.luker_generation_id === 'string' ? request.body.luker_generation_id : '',
            });
        } catch (error) {
            if (isChatStatePatchConflictError(error)) {
                return response.status(409).send({ error: 'Chat patch conflict.' });
            }
            if (isJsonPatchValidationError(error)) {
                return response.status(400).send({ error: 'Invalid chat patch payload.' });
            }
            throw error;
        }

        await refreshRecentChatIndexEntry(request, chatFilePath);
        acknowledgeGenerationFromValueOrPersistTarget(request, operations, buildGroupPersistTargetHint(request));
        return response.send({ ok: true, ...result });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/group/meta', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }
        if (!_.isObjectLike(request.body?.chat_metadata)) {
            return response.status(400).send({ error: 'Expected body.chat_metadata object.' });
        }

        const id = String(request.body.id);
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatMetadata = request.body.chat_metadata;
        const integritySlug = typeof request.body.integrity === 'string' ? request.body.integrity : undefined;
        const force = Boolean(request.body.force);

        const result = await updateChatMetadataInFile({
            filePath: chatFilePath,
            chatMetadata,
            integritySlug,
            force,
        });

        await refreshRecentChatIndexEntry(request, chatFilePath);
        return response.send({ ok: true, ...result });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/group/meta/patch', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }
        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body?.operations)
                ? [request.body.operations]
                : (_.isObjectLike(request.body?.operation) ? [request.body.operation] : []));
        if (operations.length === 0) {
            return response.status(400).send({ error: 'No metadata patch operations found. Expected body.operations or body.operation.' });
        }

        const id = String(request.body.id);
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const integritySlug = typeof request.body.integrity === 'string' ? request.body.integrity : undefined;
        const force = Boolean(request.body.force);

        let result;
        try {
            result = await patchChatMetadataInFile({
                filePath: chatFilePath,
                operations,
                integritySlug,
                force,
            });
        } catch (error) {
            if (isChatStatePatchConflictError(error)) {
                return response.status(409).send({ error: 'Chat metadata patch conflict.' });
            }
            if (isJsonPatchValidationError(error)) {
                return response.status(400).send({ error: 'Invalid metadata patch payload.' });
            }
            throw error;
        }

        await refreshRecentChatIndexEntry(request, chatFilePath);
        return response.send({ ok: true, ...result });
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            return sendIntegrityConflict(response, error);
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;

        /** @type {string[]} */
        let chatFiles = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = fs.readdirSync(groupDir)
                .filter(file => path.extname(file) === '.json');

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(fs.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    console.warn(groupFile, 'group file is corrupted:', error);
                }
            }

            if (!Array.isArray(targetGroup?.chats)) {
                return response.send([]);
            }

            // Find group chat files for given group ID
            const groupChatsDir = path.join(request.user.directories.groupChats);
            chatFiles = targetGroup.chats
                .map(chatId => path.join(groupChatsDir, `${chatId}.jsonl`))
                .filter(fileName => fs.existsSync(fileName));
        } else {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!fs.existsSync(directoryPath)) {
                return response.send([]);
            }

            chatFiles = fs.readdirSync(directoryPath)
                .filter(file => path.extname(file) === '.jsonl')
                .map(fileName => path.join(directoryPath, fileName));
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        const results = [];

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        for (const chatFile of chatFiles) {
            const matcher = query ? hasTextMatch : null;
            const chatInfo = await getChatInfo(chatFile, {}, false, matcher);
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

            // Skip corrupted or invalid chat files
            if (!chatInfo.file_name) {
                continue;
            }

            // Empty chats without a file name match are skipped when searching with a query
            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            // If no search query or a match was found, include the chat in results
            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
            }
        }

        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];
        const requestedMax = Number.parseInt(String(request.body.max ?? ''), 10);
        const requested = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : Number.MAX_SAFE_INTEGER;
        const max = requested + pinnedChats.length;
        const entries = await ensureRecentChatIndex(request);
        const recentChats = Array.from(entries.values());
        const isPinned = (chatFile) => pinnedChats.some(p => p.file_name === chatFile.file_name && (p.avatar === chatFile.avatar || p.group === chatFile.group));
        const sortedChats = recentChats.sort((a, b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return getRecentChatSortTime(b) - getRecentChatSortTime(a);
        }).slice(0, max);
        const validFiles = sortedChats.filter(chatFile => chatFile.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
