import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import sanitize from 'sanitize-filename';

import { parse } from './character-card-parser.js';

/**
 * Resolves the sanitized display name a character files its owned assets
 * under (chat images in user/images/<name>, expression sprites in
 * characters/<name>). Returns '' when the card cannot be read or the name
 * sanitizes to nothing.
 *
 * @param {string} characterFilePath Absolute path to the character card
 * @returns {Promise<string>}
 */
export async function readCharacterFolderName(characterFilePath) {
    try {
        const rawData = await parse(characterFilePath, 'png');
        const cardData = rawData ? JSON.parse(rawData) : null;
        const name = String(cardData?.data?.name ?? cardData?.name ?? '').trim();
        const folderName = sanitize(name);
        if (!folderName || folderName === '.' || folderName === '..') {
            return '';
        }
        return folderName;
    } catch (error) {
        console.warn('Failed to resolve character folder name:', error);
        return '';
    }
}

/**
 * Whether any remaining card resolves to the same sanitized folder name.
 * @param {string} charactersDir The user's characters directory
 * @param {string} folderName Sanitized folder name to check
 * @param {{ excludeAvatars?: string[] }} [options] Card filenames to ignore
 * @returns {Promise<boolean>}
 */
export async function isCharacterFolderNameShared(charactersDir, folderName, { excludeAvatars = [] } = {}) {
    if (!folderName) {
        return false;
    }
    const excluded = new Set(excludeAvatars.map(avatar => String(avatar)));
    let entries;
    try {
        entries = await fsPromises.readdir(charactersDir, { withFileTypes: true });
    } catch (error) {
        console.warn('Failed to list character cards while checking folder name sharing:', error);
        return true;
    }
    for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png' || excluded.has(entry.name)) {
            continue;
        }
        const otherFolder = await readCharacterFolderName(path.join(charactersDir, entry.name));
        if (otherFolder && otherFolder === folderName) {
            return true;
        }
        if (!otherFolder) {
            console.warn(`Skipping asset cascade for "${folderName}": card "${entry.name}" could not be read, so its folder ownership is unknown.`);
            return true;
        }
    }
    return false;
}
