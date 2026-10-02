import fs from 'node:fs';
import crypto from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';

const readdir = fs.promises.readdir;

import { getAllUserHandles, getUserDirectories } from '../users.js';
import { getStatsRepo, getChatRepo } from '../storage/index.js';

/**
 * @type {Map<string, Object>} The stats object for each user.
 */
const STATS = new Map();
/**
 * @type {Map<string, number>} The timestamps for each user.
 */
const TIMESTAMPS = new Map();

/**
 * Collects and aggregates stats for all characters under a handle.
 *
 * @param {string} handle - User handle (storage scope).
 * @param {string} charactersPath - The path to the directory containing the character files.
 * @returns {Promise<Object>} The aggregated stats object.
 */
async function collectAndCreateStats(handle, charactersPath) {
    let files = [];
    try {
        files = await readdir(charactersPath);
    } catch {
        // No characters directory yet: produce a timestamp-only stats record.
        return { timestamp: Date.now() };
    }

    const pngFiles = files.filter((file) => file.endsWith('.png'));

    let processingPromises = pngFiles.map((file) =>
        calculateStats(handle, file),
    );
    const statsArr = await Promise.all(processingPromises);

    let finalStats = {};
    for (let stat of statsArr) {
        finalStats = { ...finalStats, ...stat };
    }
    // tag with timestamp on when stats were generated
    finalStats.timestamp = Date.now();
    return finalStats;
}

/**
 * Recreates the stats object for a user.
 * @param {string} handle User handle
 * @param {string} _chatsPath Legacy path (ignored — stats now come from ChatRepo).
 * @param {string} charactersPath Path to the directory containing the character files.
 */
export async function recreateStats(handle, _chatsPath, charactersPath) {
    console.info('Collecting and creating stats for user:', handle);
    const stats = await collectAndCreateStats(handle, charactersPath);
    STATS.set(handle, stats);
    // Persist directly through StatsRepo so a single user can recreate
    // without iterating every user's saved stats (which is what
    // saveStatsToFile does, and which needs node-persist initialized).
    await getStatsRepo().save(handle, stats);
    TIMESTAMPS.set(handle, stats.timestamp || Date.now());
}

/**
 * Loads the stats file into memory. If the file doesn't exist or is invalid,
 * initializes stats by collecting and creating them for each character.
 */
export async function init() {
    try {
        const userHandles = await getAllUserHandles();
        for (const handle of userHandles) {
            const directories = getUserDirectories(handle);
            try {
                const stats = await getStatsRepo().get(handle);
                if (stats == null) {
                    await recreateStats(handle, directories.chats, directories.characters);
                } else {
                    STATS.set(handle, stats);
                }
            } catch (err) {
                console.error(`Failed to initialize stats for user ${handle}:`, err);
            }
        }
    } catch (err) {
        console.error('Failed to initialize stats:', err);
    }
    // Save stats every 5 minutes
    setInterval(saveStatsToFile, 5 * 60 * 1000);
}
/**
 * Saves the current state of charStats to a file, only if the data has changed since the last save.
 */
async function saveStatsToFile() {
    const userHandles = await getAllUserHandles();
    for (const handle of userHandles) {
        if (!STATS.has(handle)) {
            continue;
        }
        const charStats = STATS.get(handle);
        const lastSaveTimestamp = TIMESTAMPS.get(handle) || 0;
        if (charStats.timestamp > lastSaveTimestamp) {
            try {
                await getStatsRepo().save(handle, charStats);
                TIMESTAMPS.set(handle, Date.now());
            } catch (error) {
                console.error('Failed to save stats to file.', error);
            }
        }
    }
}

/**
 * Attempts to save charStats to a file and then terminates the process.
 * If an error occurs during the file write, it logs the error before exiting.
 */
export async function onExit() {
    try {
        await saveStatsToFile();
    } catch (err) {
        console.error('Failed to write stats to file:', err);
    }
}

/**
 * Calculates the time difference between two dates.
 *
 * @param {string} gen_started - The start time in ISO 8601 format.
 * @param {string} gen_finished - The finish time in ISO 8601 format.
 * @returns {number} - The difference in time in milliseconds.
 */
function calculateGenTime(gen_started, gen_finished) {
    let startDate = new Date(gen_started);
    let endDate = new Date(gen_finished);
    return Number(endDate) - Number(startDate);
}

/**
 * Counts the number of words in a string.
 *
 * @param {string} str - The string to count words in.
 * @returns {number} - The number of words in the string.
 */
function countWordsInString(str) {
    const match = str.match(/\b\w+\b/g);
    return match ? match.length : 0;
}

/**
 * calculateStats - Calculate statistics for a given character chat directory.
 *
 * Previously this read jsonl files directly off disk. That path returned
 * empty stats in db modes (the engine holds the chats, the directory is
 * empty), so the boot-time recreate-on-empty-stats path silently overwrote
 * the user's saved stats with zeros.
 *
 * Now drives through ChatRepo so every storage engine returns identical
 * stats. Body messages are pulled from the engine once and walked in-memory
 * to compute genTime/wordCount/swipeCount aggregates.
 *
 * @param  {string} handle  User handle (storage scope).
 * @param  {string} item    Avatar file name with `.png` suffix.
 * @return {Promise<object>} Stats object keyed by sanitized character name.
 */
const calculateStats = async (handle, item) => {
    const charDir = item.replace('.png', '');
    const stats = {
        total_gen_time: 0,
        user_word_count: 0,
        non_user_word_count: 0,
        user_msg_count: 0,
        non_user_msg_count: 0,
        total_swipe_count: 0,
        chat_size: 0,
        date_last_chat: 0,
        date_first_chat: new Date('9999-12-31T23:59:59.999Z').getTime(),
    };
    const uniqueGenStartTimes = new Set();

    let entries;
    try {
        entries = await getChatRepo().listForCharacter(handle, charDir);
    } catch (err) {
        console.warn(`calculateStats: failed to list chats for ${charDir}`, err?.message || err);
        // Strip the unreachable sentinel value before returning to match legacy
        // shape (final stats from collectAndCreateStats omits the unset sentinel).
        if (stats.date_first_chat > Date.now()) stats.date_first_chat = 0;
        return { [sanitize(charDir)]: stats };
    }

    for (const entry of entries) {
        const chatName = entry.key.name;
        let chat;
        try {
            chat = await getChatRepo().get(handle, charDir, chatName);
        } catch {
            continue;
        }
        if (chat == null || !Array.isArray(chat.body)) continue;
        const result = calculateTotalGenTimeAndWordCountFromBody(
            chat.body,
            uniqueGenStartTimes,
        );
        stats.total_gen_time += result.totalGenTime || 0;
        stats.user_word_count += result.userWordCount || 0;
        stats.non_user_word_count += result.nonUserWordCount || 0;
        stats.user_msg_count += result.userMsgCount || 0;
        stats.non_user_msg_count += result.nonUserMsgCount || 0;
        stats.total_swipe_count += result.totalSwipeCount || 0;
        // Engine-provided timestamps are always ms (Date.now() for SQL,
        // Math.floor(mtimeMs) for FS).
        const updatedAtMs = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
        const createdAtMs = typeof entry.createdAt === 'number' ? entry.createdAt : 0;
        if (updatedAtMs > stats.date_last_chat) stats.date_last_chat = updatedAtMs;
        if (createdAtMs > 0 && createdAtMs < stats.date_first_chat) stats.date_first_chat = createdAtMs;
    }
    if (stats.date_first_chat > Date.now()) stats.date_first_chat = 0;
    return { [sanitize(charDir)]: stats };
};

/**
 * In-memory equivalent of the legacy jsonl-streaming calculation that accepts
 * the full body array directly. Keep behavior byte-for-byte identical to the
 * streaming version so stats stay stable across the migration.
 */
function calculateTotalGenTimeAndWordCountFromBody(body, uniqueGenStartTimes) {
    let totalGenTime = 0;
    let userWordCount = 0;
    let nonUserWordCount = 0;
    let nonUserMsgCount = 0;
    let userMsgCount = 0;
    let totalSwipeCount = 0;
    for (const json of body) {
        if (!json || typeof json !== 'object') continue;
        if (json.mes) {
            const hash = crypto.createHash('sha256').update(json.mes).digest('hex');
            if (uniqueGenStartTimes.has(hash)) continue;
            if (hash) uniqueGenStartTimes.add(hash);
        }
        if (json.gen_started && json.gen_finished) {
            const genTime = calculateGenTime(json.gen_started, json.gen_finished);
            totalGenTime += genTime;
            if (json.swipes && !json.swipe_info) {
                totalGenTime += genTime * json.swipes.length;
            }
        }
        if (json.mes) {
            const wordCount = countWordsInString(json.mes);
            json.is_user ? (userWordCount += wordCount) : (nonUserWordCount += wordCount);
            json.is_user ? userMsgCount++ : nonUserMsgCount++;
        }
        if (json.swipes && json.swipes.length > 1) {
            totalSwipeCount += json.swipes.length - 1;
            for (let i = 1; i < json.swipes.length; i++) {
                const wordCount = countWordsInString(json.swipes[i]);
                json.is_user ? (userWordCount += wordCount) : (nonUserWordCount += wordCount);
                json.is_user ? userMsgCount++ : nonUserMsgCount++;
            }
        }
        if (json.swipe_info && json.swipe_info.length > 1) {
            for (let i = 1; i < json.swipe_info.length; i++) {
                const swipe = json.swipe_info[i];
                if (swipe && swipe.gen_started && swipe.gen_finished) {
                    totalGenTime += calculateGenTime(swipe.gen_started, swipe.gen_finished);
                }
            }
        }
    }
    return { totalGenTime, userWordCount, nonUserWordCount, userMsgCount, nonUserMsgCount, totalSwipeCount };
}


/**
 * Sets the current charStats object.
 * @param {string} handle - The user handle.
 * @param {Object} stats - The new charStats object.
 **/
function setCharStats(handle, stats) {
    stats.timestamp = Date.now();
    STATS.set(handle, stats);
}

export const router = express.Router();

/**
 * Handle a POST request to get the stats object
 */
router.post('/get', function (request, response) {
    const stats = STATS.get(request.user.profile.handle) || {};
    response.send(stats);
});

/**
 * Triggers the recreation of statistics from chat files.
 */
router.post('/recreate', async function (request, response) {
    try {
        await recreateStats(request.user.profile.handle, request.user.directories.chats, request.user.directories.characters);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Handle a POST request to update the stats object
*/
router.post('/update', function (request, response) {
    if (!request.body) return response.sendStatus(400);
    setCharStats(request.user.profile.handle, request.body);
    return response.sendStatus(200);
});
