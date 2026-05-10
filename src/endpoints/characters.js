import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { Buffer } from 'node:buffer';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import yaml from 'yaml';
import _ from 'lodash';
import mime from 'mime-types';
import { Jimp, JimpMime } from '../jimp.js';
import storage from 'node-persist';

import { AVATAR_WIDTH, AVATAR_HEIGHT, DEFAULT_AVATAR_PATH } from '../constants.js';
import { default as validateAvatarUrlMiddleware, getFileNameValidationFunction, forbiddenRegExp } from '../middleware/validateFileName.js';
import { deepMerge, humanizedDateTime, tryParse, tryReadFileSync, MemoryLimitedMap, getConfigValue, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { parse, read, write } from '../character-card-parser.js';
import { readWorldInfoFile } from './worldinfo.js';
import { invalidateThumbnail } from './thumbnails.js';
import { importRisuSprites } from './sprites.js';
import { getUserDirectories } from '../users.js';
import { getChatInfo } from './chats.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { extractCardAppFiles, packCardAppFiles, deleteCardAppFiles } from './card-app.js';

// With 100 MB limit it would take roughly 3000 characters to reach this limit
const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity', '100mb');
const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);
// Some Android devices require tighter memory management
const isAndroid = process.platform === 'android';
// Use shallow character data for the character list
const useShallowCharacters = isAndroid || !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
const useDiskCache = !!getConfigValue('performance.useDiskCache', true, 'boolean');
const CHARACTER_STATE_FILE_PREFIX = '.state.';
const CHARACTER_STATE_FILE_SUFFIX = '.json';

class DiskCache {
    /**
     * @type {string}
     * @readonly
     */
    static DIRECTORY = 'characters';

    /**
     * @type {number}
     * @readonly
     */
    static SYNC_INTERVAL = 5 * 60 * 1000;

    /** @type {import('node-persist').LocalStorage} */
    #instance;

    /** @type {NodeJS.Timeout} */
    #syncInterval;

    /**
     * Queue of user handles to sync.
     * @type {Set<string>}
     * @readonly
     */
    syncQueue = new Set();

    /**
     * Path to the cache directory.
     * @returns {string}
     */
    get cachePath() {
        return path.join(globalThis.DATA_ROOT, '_cache', DiskCache.DIRECTORY);
    }

    /**
     * Returns the list of hashed keys in the cache.
     * @returns {string[]}
     */
    get hashedKeys() {
        return fs.readdirSync(this.cachePath);
    }

    /**
     * Processes the synchronization queue.
     * @returns {Promise<void>}
     */
    async #syncCacheEntries() {
        try {
            if (!useDiskCache || this.syncQueue.size === 0) {
                return;
            }

            const directories = [...this.syncQueue].map(entry => getUserDirectories(entry));
            this.syncQueue.clear();

            await this.verify(directories);
        } catch (error) {
            console.error('Error while synchronizing cache entries:', error);
        }
    }

    /**
     * Gets the disk cache instance.
     * @returns {Promise<import('node-persist').LocalStorage>}
     */
    async instance() {
        if (this.#instance) {
            return this.#instance;
        }

        this.#instance = storage.create({
            dir: this.cachePath,
            ttl: false,
            forgiveParseErrors: true,
            expiredInterval: 0,
            // @ts-ignore
            maxFileDescriptors: 100,
        });
        await this.#instance.init();
        this.#syncInterval = setInterval(this.#syncCacheEntries.bind(this), DiskCache.SYNC_INTERVAL);
        return this.#instance;
    }

    /**
     * Verifies disk cache size and prunes it if necessary.
     * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
     * @returns {Promise<void>}
     */
    async verify(directoriesList) {
        try {
            if (!useDiskCache) {
                return;
            }

            const cache = await this.instance();
            const validKeys = new Set();
            for (const dir of directoriesList) {
                const files = fs.readdirSync(dir.characters, { withFileTypes: true });
                for (const file of files.filter(f => f.isFile() && path.extname(f.name) === '.png')) {
                    const filePath = path.join(dir.characters, file.name);
                    const cacheKey = getCacheKey(filePath);
                    validKeys.add(path.parse(cache.getDatumPath(cacheKey)).base);
                }
            }
            for (const key of this.hashedKeys) {
                if (!validKeys.has(key)) {
                    await cache.removeItem(key);
                }
            }
        } catch (error) {
            console.error('Error while verifying disk cache:', error);
        }
    }

    dispose() {
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
        }
    }
}

export const diskCache = new DiskCache();

/**
 * Gets the cache key for the specified image file.
 * @param {string} inputFile - Path to the image file
 * @returns {string} - Cache key
 */
function getCacheKey(inputFile) {
    if (fs.existsSync(inputFile)) {
        const stat = fs.statSync(inputFile);
        return `${inputFile}-${stat.mtimeMs}`;
    }

    return inputFile;
}

/**
 * Reads the character card from the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {string} inputFormat - 'png'
 * @returns {Promise<string | undefined>} - Character card data
 */
async function readCharacterData(inputFile, inputFormat = 'png') {
    const cacheKey = getCacheKey(inputFile);
    if (memoryCache.has(cacheKey)) {
        return memoryCache.get(cacheKey);
    }
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            const cachedData = await cache.getItem(cacheKey);
            if (cachedData) {
                return cachedData;
            }
        } catch (error) {
            console.warn('Error while reading from disk cache:', error);
        }
    }

    const result = await parse(inputFile, inputFormat);
    !isAndroid && memoryCache.set(cacheKey, result);
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            await cache.setItem(cacheKey, result);
        } catch (error) {
            console.warn('Error while writing to disk cache:', error);
        }
    }
    return result;
}

/**
 * Writes the character card to the specified image file.
 * @param {string|Buffer} inputFile - Path to the image file or image buffer
 * @param {string} data - Character card data
 * @param {string} outputFile - Target image file name
 * @param {import('express').Request} request - Express request obejct
 * @param {Crop|undefined} crop - Crop parameters
 * @returns {Promise<boolean>} - True if the operation was successful
 */
async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined, options = {}) {
    try {
        const {
            allowMissingInputFallback = true,
            requireExistingOutput = false,
        } = options && typeof options === 'object' ? options : {};

        const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);

        // Reset the cache
        for (const key of memoryCache.keys()) {
            if (Buffer.isBuffer(inputFile)) {
                if (key.startsWith(outputImagePath)) {
                    memoryCache.delete(key);
                }
                continue;
            }
            if (key.startsWith(inputFile) || key.startsWith(outputImagePath)) {
                memoryCache.delete(key);
            }
        }
        if (useDiskCache && !Buffer.isBuffer(inputFile)) {
            diskCache.syncQueue.add(request.user.profile.handle);
        }
        /**
         * Read the image, resize, and save it as a PNG into the buffer.
         * @returns {Promise<Buffer>} Image buffer
         */
        async function getInputImage() {
            try {
                if (Buffer.isBuffer(inputFile)) {
                    return await parseImageBuffer(inputFile, crop);
                }

                return await tryReadImage(inputFile, crop);
            } catch (error) {
                const inputPathMissing = !Buffer.isBuffer(inputFile) && !fs.existsSync(inputFile);
                if (inputPathMissing && !allowMissingInputFallback) {
                    throw new Error(`Source character image is missing: ${inputFile}`);
                }
                const message = Buffer.isBuffer(inputFile) ? 'Failed to read image buffer.' : `Failed to read image: ${inputFile}.`;
                console.warn(message, 'Using a fallback image.', error);
                return await fs.promises.readFile(DEFAULT_AVATAR_PATH);
            }
        }

        const inputImage = await getInputImage();
        data = normalizeCharacterCardForStorage(data, request.user.directories);

        // Get the chunks
        const outputImage = write(inputImage, data);
        if (requireExistingOutput && !fs.existsSync(outputImagePath)) {
            throw new Error(`Target character image is missing: ${outputImagePath}`);
        }

        writeFileAtomicSync(outputImagePath, outputImage);

        // Refresh in-memory and disk caches with the newly written character payload.
        const outputCacheKey = getCacheKey(outputImagePath);
        if (outputCacheKey) {
            !isAndroid && memoryCache.set(outputCacheKey, data);
            if (useDiskCache) {
                try {
                    const cache = await diskCache.instance();
                    await cache.setItem(outputCacheKey, data);
                } catch (error) {
                    console.warn('Error while writing output character payload to disk cache:', error);
                }
            }
        }
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

/**
 * @typedef {Object} Crop
 * @property {number} x X-coordinate
 * @property {number} y Y-coordinate
 * @property {number} width Width
 * @property {number} height Height
 * @property {boolean} want_resize Resize the image to the standard avatar size
 */

/**
 * Applies avatar crop and resize operations to an image.
 * I couldn't fix the type issue, so the first argument has {any} type.
 * @param {object} jimp Jimp image instance
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Processed image buffer
 */
export async function applyAvatarCropResize(jimp, crop) {
    if (!(jimp instanceof Jimp)) {
        throw new TypeError('Expected a Jimp instance');
    }

    const image = /** @type {InstanceType<typeof Jimp>} */ (jimp);
    let finalWidth = image.bitmap.width, finalHeight = image.bitmap.height;

    // Apply crop if defined
    if (typeof crop == 'object' && [crop.x, crop.y, crop.width, crop.height].every(x => typeof x === 'number')) {
        image.crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height });
        // Apply standard resize if requested
        if (crop.want_resize) {
            finalWidth = AVATAR_WIDTH;
            finalHeight = AVATAR_HEIGHT;
        } else {
            finalWidth = crop.width;
            finalHeight = crop.height;
        }
    }

    image.cover({ w: finalWidth, h: finalHeight });
    return await image.getBuffer(JimpMime.png);
}

/**
 * Parses an image buffer and applies crop if defined.
 * @param {Buffer} buffer Buffer of the image
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function parseImageBuffer(buffer, crop) {
    const image = await Jimp.fromBuffer(buffer);
    return await applyAvatarCropResize(image, crop);
}

/**
 * Reads an image file and applies crop if defined.
 * @param {string} imgPath Path to the image file
 * @param {Crop|undefined} crop Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function tryReadImage(imgPath, crop) {
    try {
        const rawImg = await Jimp.read(imgPath);
        return await applyAvatarCropResize(rawImg, crop);
    } catch (error) {
        // If it's an unsupported type of image (APNG) - just read the file as buffer
        console.error(`Failed to read image: ${imgPath}`, error);
        return fs.readFileSync(imgPath);
    }
}

/**
 * calculateChatSize - Calculates the total chat size for a given character.
 *
 * @param  {string} charDir The directory where the chats are stored.
 * @return { {chatSize: number, dateLastChat: number} }         The total chat size.
 */
const calculateChatSize = (charDir) => {
    let chatSize = 0;
    let dateLastChat = 0;

    if (fs.existsSync(charDir)) {
        const chats = fs.readdirSync(charDir);
        if (Array.isArray(chats) && chats.length) {
            for (const chat of chats) {
                const chatStat = fs.statSync(path.join(charDir, chat));
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            }
        }
    }

    return { chatSize, dateLastChat };
};

// Calculate the total string length of the data object
const calculateDataSize = (data) => {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
};

/**
 * Only get fields that are used to display the character list.
 * @param {object} character Character object
 * @returns {{shallow: true, [key: string]: any}} Shallow character
 */
const toShallow = (character) => {
    const dedicatedPersonas = _.get(character, 'data.extensions.luker.dedicated_personas', []);
    const normalizedDedicatedPersonas = Array.isArray(dedicatedPersonas)
        ? dedicatedPersonas
            .filter(entry => entry && typeof entry === 'object')
            .map(entry => ({
                avatar: String(entry.avatar ?? '').trim(),
                name: String(entry.name ?? '').trim(),
                description: String(entry.description ?? ''),
                position: Number.isFinite(Number(entry.position)) ? Number(entry.position) : undefined,
                depth: Number.isFinite(Number(entry.depth)) ? Number(entry.depth) : undefined,
                role: Number.isFinite(Number(entry.role)) ? Number(entry.role) : undefined,
                lorebook: String(entry.lorebook ?? ''),
                title: String(entry.title ?? ''),
            }))
            .filter(entry => entry.avatar && entry.name)
        : [];

    return {
        shallow: true,
        name: _.get(character, 'data.name', character.name),
        avatar: character.avatar,
        chat: character.chat,
        fav: _.get(character, 'data.extensions.fav', character.fav),
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: _.get(character, 'data.tags', character.tags),
        data: {
            name: _.get(character, 'data.name', ''),
            character_version: _.get(character, 'data.character_version', ''),
            creator: _.get(character, 'data.creator', ''),
            creator_notes: _.get(character, 'data.creator_notes', ''),
            tags: _.get(character, 'data.tags', []),
            extensions: {
                fav: _.get(character, 'data.extensions.fav', false),
                luker: {
                    dedicated_personas: normalizedDedicatedPersonas,
                },
                world: _.get(character, 'data.extensions.world', ''),
            },
        },
    };
};

/**
 * processCharacter - Process a given character, read its data and calculate its statistics.
 *
 * @param  {string} item The name of the character.
 * @param  {import('../users.js').UserDirectoryList} directories User directories
 * @param  {object} options Options for the character processing
 * @param  {boolean} options.shallow If true, only return the core character's metadata
 * @return {Promise<object>}     A Promise that resolves when the character processing is done.
 */
const processCharacter = async (item, directories, { shallow }) => {
    try {
        const imgFile = path.join(directories.characters, item);
        const imgData = await readCharacterData(imgFile);
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character.json_data = imgData;
        const charStat = fs.statSync(path.join(directories.characters, item));
        character.date_added = charStat.ctimeMs;
        character.create_date = jsonObject.create_date || new Date(Math.round(charStat.ctimeMs)).toISOString();
        const chatsDirectory = path.join(directories.chats, item.replace('.png', ''));

        const { chatSize, dateLastChat } = calculateChatSize(chatsDirectory);
        character.chat_size = chatSize;
        character.date_last_chat = dateLastChat;
        character.data_size = calculateDataSize(jsonObject?.data);
        return shallow ? toShallow(character) : character;
    } catch (err) {
        console.error(`Could not process character: ${item}`);

        if (err instanceof SyntaxError) {
            console.error(`${item} does not contain a valid JSON object.`);
        } else {
            console.error('An unexpected error occurred: ', err);
        }

        return {
            date_added: 0,
            date_last_chat: 0,
            chat_size: 0,
        };
    }
};

/**
 * Maps items with a bounded concurrency level while preserving input order.
 * Android runs the embedded Node runtime in-process, so keeping this low helps
 * avoid large startup memory spikes when a backup restores many character cards.
 *
 * @template TInput, TOutput
 * @param {TInput[]} items Items to process
 * @param {number} concurrency Maximum number of in-flight mapper calls
 * @param {(item: TInput, index: number) => Promise<TOutput>} mapper Async mapper
 * @returns {Promise<TOutput[]>}
 */
async function mapWithConcurrency(items, concurrency, mapper) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const safeConcurrency = Math.max(1, Math.min(Math.trunc(concurrency) || 1, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const currentIndex = nextIndex++;
            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    };

    await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
    return results;
}

export async function getCharactersSnapshot(directories, { useShallowCharacters: callerShallow } = {}) {
    const shallow = callerShallow !== undefined ? callerShallow : useShallowCharacters;
    const files = fs.readdirSync(directories.characters);
    const pngFiles = files.filter(file => file.endsWith('.png'));
    if (!isAndroid) {
        const processingPromises = pngFiles.map(file => processCharacter(file, directories, { shallow }));
        return (await Promise.all(processingPromises)).filter(character => _.get(character, 'data.name', character.name));
    }

    const characters = await mapWithConcurrency(
        pngFiles,
        1,
        (file) => processCharacter(file, directories, { shallow }),
    );
    return characters.filter(character => _.get(character, 'data.name', character.name));
}

/**
 * Convert a character object to stored Spec V2 format.
 * @param {object} jsonObject Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {boolean} hoistDate Will set the chat and create_date fields to the current date if they are missing
 * @returns {object} Character object in stored Spec V2 format
 */
function getStoredCharaCardV2(jsonObject, directories, hoistDate = true) {
    if (jsonObject.spec === undefined) {
        jsonObject = convertToV2(jsonObject, directories);

        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = new Date().toISOString();
        }
    } else {
        jsonObject = toStoredV2Character(jsonObject);
        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = new Date().toISOString();
        }
    }
    return jsonObject;
}

/**
 * Convert a character object to runtime Spec V2 format with legacy root-field projections.
 * @param {object} jsonObject Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {boolean} hoistDate Will set the chat and create_date fields to the current date if they are missing
 * @returns {object} Character object in runtime Spec V2 format
 */
function getCharaCardV2(jsonObject, directories, hoistDate = true) {
    return projectRuntimeCharacterFields(getStoredCharaCardV2(jsonObject, directories, hoistDate));
}

/**
 * Convert a character object to Spec V2 format.
 * @param {object} char Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object} Character object in Spec V2 format
 */
function convertToV2(char, directories) {
    // Simulate incoming data from frontend form
    const result = charaFormatData({
        json_data: JSON.stringify(char),
        ch_name: _.get(char, 'data.name', char.name),
        description: _.get(char, 'data.description', char.description),
        personality: _.get(char, 'data.personality', char.personality),
        scenario: _.get(char, 'data.scenario', char.scenario),
        first_mes: _.get(char, 'data.first_mes', char.first_mes),
        mes_example: _.get(char, 'data.mes_example', char.mes_example),
        creator_notes: _.get(char, 'data.creator_notes', char.creatorcomment),
        talkativeness: _.get(char, 'data.extensions.talkativeness', char.talkativeness),
        fav: _.get(char, 'data.extensions.fav', char.fav),
        creator: _.get(char, 'data.creator', char.creator),
        tags: _.get(char, 'data.tags', char.tags),
        depth_prompt_prompt: _.get(char, 'data.extensions.depth_prompt.prompt', char.depth_prompt_prompt),
        depth_prompt_depth: _.get(char, 'data.extensions.depth_prompt.depth', char.depth_prompt_depth),
        depth_prompt_role: _.get(char, 'data.extensions.depth_prompt.role', char.depth_prompt_role),
    }, directories);

    result.chat = char.chat ?? `${_.get(result, 'data.name', _.get(char, 'data.name', char.name) || 'Unnamed')} - ${humanizedDateTime()}`;
    result.create_date = char.create_date;

    return result;
}

/**
 * Removes fields that are not meant to be shared.
 */
function unsetPrivateFields(char) {
    _.unset(char, 'fav');
    _.set(char, 'data.extensions.fav', false);
    _.unset(char, 'chat');
}

function projectRuntimeCharacterFields(char) {
    if (_.isUndefined(char.data)) {
        console.warn(`Char ${char.name} has Spec v2 data missing`);
        return char;
    }

    // If 'json_data' was already saved, don't let it propagate
    _.unset(char, 'json_data');

    const fieldMappings = {
        name: 'name',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        first_mes: 'first_mes',
        mes_example: 'mes_example',
        talkativeness: 'extensions.talkativeness',
        fav: 'extensions.fav',
        tags: 'tags',
    };

    _.forEach(fieldMappings, (v2Path, charField) => {
        const v2Value = _.get(char.data, v2Path);
        if (!_.isUndefined(v2Value)) {
            char[charField] = v2Value;
            return;
        }

        switch (v2Path) {
            case 'extensions.talkativeness':
                char[charField] = 0.5;
                return;
            case 'extensions.fav':
                char[charField] = false;
                return;
            case 'tags':
                char[charField] = [];
                return;
            default:
                char[charField] = '';
                return;
        }
    });

    const runtimeName = _.get(char, 'data.name', char.name) || 'Unnamed';
    char.chat = char.chat ?? `${runtimeName} - ${humanizedDateTime()}`;

    return char;
}

/**
 * Legacy root-field to canonical V2 storage mappings.
 */
const legacyCharacterStorageFieldSpecs = Object.freeze({
    name: { path: 'data.name', normalize: value => String(value ?? '') },
    description: { path: 'data.description', normalize: value => String(value ?? '') },
    personality: { path: 'data.personality', normalize: value => String(value ?? '') },
    scenario: { path: 'data.scenario', normalize: value => String(value ?? '') },
    first_mes: { path: 'data.first_mes', normalize: value => String(value ?? '') },
    mes_example: { path: 'data.mes_example', normalize: value => String(value ?? '') },
    creatorcomment: { path: 'data.creator_notes', normalize: value => String(value ?? '') },
    creator_notes: { path: 'data.creator_notes', normalize: value => String(value ?? '') },
    system_prompt: { path: 'data.system_prompt', normalize: value => String(value ?? '') },
    post_history_instructions: { path: 'data.post_history_instructions', normalize: value => String(value ?? '') },
    tags: {
        path: 'data.tags',
        normalize: value => Array.isArray(value)
            ? value.map(tag => String(tag ?? '').trim()).filter(Boolean)
            : String(value ?? '').split(',').map(tag => tag.trim()).filter(Boolean),
    },
    creator: { path: 'data.creator', normalize: value => String(value ?? '') },
    character_version: { path: 'data.character_version', normalize: value => String(value ?? '') },
    alternate_greetings: {
        path: 'data.alternate_greetings',
        normalize: value => Array.isArray(value)
            ? value.map(item => String(item ?? ''))
            : (typeof value === 'string' ? [value] : []),
    },
    talkativeness: {
        path: 'data.extensions.talkativeness',
        normalize: value => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : 0.5;
        },
    },
    fav: {
        path: 'data.extensions.fav',
        normalize: value => {
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true') return true;
                if (normalized === 'false' || normalized === '') return false;
            }
            return Boolean(value);
        },
    },
    world: { path: 'data.extensions.world', normalize: value => String(value ?? '') },
    depth_prompt_prompt: { path: 'data.extensions.depth_prompt.prompt', normalize: value => String(value ?? '') },
    depth_prompt_depth: {
        path: 'data.extensions.depth_prompt.depth',
        normalize: value => {
            const numericValue = Number(value);
            return Number.isFinite(numericValue) ? numericValue : 4;
        },
    },
    depth_prompt_role: { path: 'data.extensions.depth_prompt.role', normalize: value => String(value ?? 'system') || 'system' },
});

const legacyCharacterStorageRootFields = Object.freeze([
    ...Object.keys(legacyCharacterStorageFieldSpecs),
    'extensions',
]);

function normalizeCharacterCardForStorage(data, directories) {
    if (typeof data !== 'string' || data.length === 0) {
        return data;
    }

    const parsed = tryParse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return data;
    }

    const character = parsed.spec === undefined
        ? convertToV2(parsed, directories)
        : parsed;

    return JSON.stringify(toStoredV2Character(character));
}

function toStoredV2Character(character) {
    if (!character || typeof character !== 'object' || Array.isArray(character)) {
        return character;
    }

    _.unset(character, 'json_data');

    if (!_.isPlainObject(character.data)) {
        character.data = {};
    }

    if (!_.isPlainObject(character.data.extensions)) {
        character.data.extensions = {};
    }

    if (_.isPlainObject(character.data.character_book)) {
        if (!Array.isArray(character.data.character_book.entries)) {
            character.data.character_book.entries = [];
        }
        if (!_.isPlainObject(character.data.character_book.extensions)) {
            character.data.character_book.extensions = {};
        }
    }

    for (const [field, spec] of Object.entries(legacyCharacterStorageFieldSpecs)) {
        if (!Object.prototype.hasOwnProperty.call(character, field)) {
            continue;
        }

        _.set(character, spec.path, spec.normalize(character[field]));
    }

    if (_.isPlainObject(character.extensions)) {
        character.data.extensions = deepMerge(character.data.extensions, character.extensions);
    }

    for (const field of legacyCharacterStorageRootFields) {
        _.unset(character, field);
    }

    return character;
}

function resolveCharacterEditFieldPath(field) {
    const normalizedField = String(field ?? '').trim();
    if (!normalizedField) {
        return '';
    }

    if (legacyCharacterStorageFieldSpecs[normalizedField]) {
        return legacyCharacterStorageFieldSpecs[normalizedField].path;
    }

    if (normalizedField === 'extensions') {
        return 'data.extensions';
    }

    if (normalizedField.startsWith('data.')) {
        return normalizedField;
    }

    return normalizedField;
}

/**
 * Format character data to Spec V2 format.
 * @param {object} data Character data
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns
 */
function charaFormatData(data, directories) {
    // This is supposed to save all the foreign keys that ST doesn't care about
    const char = tryParse(data.json_data) || {};

    // Prevent erroneous 'json_data' recursive saving
    _.unset(char, 'json_data');

    // Checks if data.alternate_greetings is an array, a string, or neither, and acts accordingly. (expected to be an array of strings)
    const getAlternateGreetings = data => {
        if (Array.isArray(data.alternate_greetings)) return data.alternate_greetings;
        if (typeof data.alternate_greetings === 'string') return [data.alternate_greetings];
        return [];
    };

    _.set(char, 'avatar', 'none');
    _.set(char, 'chat', data.ch_name + ' - ' + humanizedDateTime());

    // Spec V2 fields
    _.set(char, 'spec', 'chara_card_v2');
    _.set(char, 'spec_version', '2.0');
    _.set(char, 'data.name', data.ch_name);
    _.set(char, 'data.description', data.description || '');
    _.set(char, 'data.personality', data.personality || '');
    _.set(char, 'data.scenario', data.scenario || '');
    _.set(char, 'data.first_mes', data.first_mes || '');
    _.set(char, 'data.mes_example', data.mes_example || '');

    // New V2 fields
    _.set(char, 'data.creator_notes', data.creator_notes || '');
    _.set(char, 'data.system_prompt', data.system_prompt || '');
    _.set(char, 'data.post_history_instructions', data.post_history_instructions || '');
    _.set(char, 'data.tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);
    _.set(char, 'data.creator', data.creator || '');
    _.set(char, 'data.character_version', data.character_version || '');
    _.set(char, 'data.alternate_greetings', getAlternateGreetings(data));

    // Merge the extensions snapshot first so the dedicated form fields below
    // can override any stale values that round-tripped through the JSON.
    if (data.extensions) {
        try {
            const extensions = JSON.parse(data.extensions);
            _.set(char, 'data.extensions', deepMerge(char.data.extensions, extensions));
        } catch {
            console.warn(`Failed to parse extensions JSON: ${data.extensions}`);
        }
    }

    // ST extension fields to V2 object
    _.set(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
    _.set(char, 'data.extensions.fav', data.fav == 'true');
    _.set(char, 'data.extensions.world', data.world || '');

    // Spec extension: depth prompt
    const depth_default = 4;
    const role_default = 'system';
    const depth_value = !isNaN(Number(data.depth_prompt_depth)) ? Number(data.depth_prompt_depth) : depth_default;
    const role_value = data.depth_prompt_role ?? role_default;
    _.set(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
    _.set(char, 'data.extensions.depth_prompt.depth', depth_value);
    _.set(char, 'data.extensions.depth_prompt.role', role_value);

    syncCharacterBookFromWorldInfo(char, directories, data.world);

    return toStoredV2Character(char);
}

/**
 * Refreshes the embedded character book from the currently linked world info.
 * Current world info entries are authoritative. Preserve originalData only as a fallback
 * for malformed/legacy files that no longer expose an entries object.
 * @param {object} char Character payload being saved
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Linked world info name
 */
function syncCharacterBookFromWorldInfo(char, directories, worldInfoName) {
    const normalizedWorldInfoName = String(worldInfoName || '').trim();
    if (!normalizedWorldInfoName) {
        return;
    }

    try {
        const file = readWorldInfoFile(directories, normalizedWorldInfoName, false);

        if (file && _.isObjectLike(file.entries) && !Array.isArray(file.entries)) {
            _.set(char, 'data.character_book', convertWorldInfoToCharacterBook(normalizedWorldInfoName, file.entries));
            return;
        }

        if (file?.originalData && Array.isArray(file.originalData.entries)) {
            const fallbackCharacterBook = JSON.parse(JSON.stringify(file.originalData));
            fallbackCharacterBook.name = String(fallbackCharacterBook.name || normalizedWorldInfoName);
            _.set(char, 'data.character_book', fallbackCharacterBook);
        }
    } catch {
        console.warn(`Failed to read world info file: ${normalizedWorldInfoName}. Character book will not be available.`);
    }
}

/**
 * @param {string} name Name of World Info file
 * @param {object} entries Entries object
 */
function convertWorldInfoToCharacterBook(name, entries) {
    /** @type {{ entries: object[]; name: string; extensions: object }} */
    const result = { entries: [], name, extensions: {} };

    for (const index in entries) {
        const entry = entries[index];

        const originalEntry = {
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        };

        result.entries.push(originalEntry);
    }

    return result;
}

/**
 * Import a character from a YAML file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromYaml(uploadPath, context, preservedFileName) {
    const fileText = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);
    const yamlData = yaml.parse(fileText);
    console.info('Importing from YAML');
    yamlData.name = sanitize(yamlData.name);
    const fileName = preservedFileName || getPngName(yamlData.name, context.request.user.directories);
    let char = convertToV2({
        'name': yamlData.name,
        'description': yamlData.context ?? '',
        'first_mes': yamlData.greeting ?? '',
        'create_date': new Date().toISOString(),
        'chat': `${yamlData.name} - ${humanizedDateTime()}`,
        'personality': '',
        'creatorcomment': '',
        'avatar': 'none',
        'mes_example': '',
        'scenario': '',
        'talkativeness': 0.5,
        'creator': '',
        'tags': '',
    }, context.request.user.directories);
    const result = await writeCharacterData(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request);
    return result ? fileName : '';
}

/**
 * Imports a character card from CharX (ZIP) file.
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromCharX(uploadPath, { request }, preservedFileName) {
    const fileBuffer = fs.readFileSync(uploadPath);
    // Create a properly-sized ArrayBuffer (Node's buffer pool can cause oversized .buffer)
    const data = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
    fs.unlinkSync(uploadPath);

    const parser = new CharXParser(data);
    const { card, avatar, auxiliaryAssets, extractedBuffers } = await parser.parse();

    // Apply standard character transformations
    let processedCard = getStoredCharaCardV2(card, request.user.directories);
    unsetPrivateFields(processedCard);
    processedCard.create_date = new Date().toISOString();
    _.set(processedCard, 'data.name', sanitize(_.get(processedCard, 'data.name', processedCard.name)));

    const processedCardName = _.get(processedCard, 'data.name', 'Unnamed');
    const fileName = preservedFileName || getPngName(processedCardName, request.user.directories);
    // Use the actual character name for asset folders, not the unique filename
    // ST's sprite system looks up by character name, not PNG filename
    const characterFolder = processedCardName;

    if (auxiliaryAssets.length > 0) {
        try {
            const summary = persistCharXAssets(auxiliaryAssets, extractedBuffers, request.user.directories, characterFolder);
            if (summary.sprites || summary.backgrounds || summary.misc) {
                console.log(`CharX: Imported ${summary.sprites} sprite(s), ${summary.backgrounds} background(s), ${summary.misc} misc asset(s) for ${characterFolder}`);
            }
        } catch (error) {
            console.warn(`CharX: Failed to persist auxiliary assets for ${characterFolder}`, error);
        }
    }

    const result = await writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request);
    return result ? fileName : '';
}

async function importFromByaf(uploadPath, { request }, preservedFileName) {
    const data = (await fsPromises.readFile(uploadPath)).buffer;
    await fsPromises.unlink(uploadPath);
    console.info('Importing from BYAF');

    const byafData = await new ByafParser(data).parse();
    const card = getStoredCharaCardV2(byafData.card, request.user.directories);
    const cardName = String(_.get(card, 'data.name', card.name) || '');
    const fileName = preservedFileName || getPngName(sanitize(byafData.character.displayName || cardName, { replacement: sanitizeSafeCharacterReplacements }), request.user.directories);

    // Don't import chats and images if the character is being replaced or updated, instead of newly imported.
    if (!preservedFileName) {
        /**
         * @param {Partial<ByafScenario>} scenario
        */
        const createChatAsCurrentPersona = (scenario) => {
            const chatName = sanitize(`${scenario.title || cardName} - ${humanizedDateTime()} imported.jsonl`, { replacement: sanitizeSafeCharacterReplacements });
            const filePath = path.join(request.user.directories.chats, path.basename(fileName), chatName);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            writeFileAtomicSync(filePath, ByafParser.getChatFromScenario(scenario, request.body.user_name, cardName, byafData.chatBackgrounds), 'utf8');
            console.log(`Created ${chatName} chat from BYAF import`);
            return chatName;
        };

        // Upload backgrounds
        for (const bg of byafData.chatBackgrounds) {
            const extension = path.extname(bg.paths?.[0]) || '.png';
            const baseName = `${path.basename(fileName)}_bg`;
            const filePath = path.join(request.user.directories.userImages, fileName);
            if (!fs.existsSync(filePath)) fs.mkdirSync(filePath, { recursive: true });
            const file = getUniqueName(baseName, (name) => fs.existsSync(path.join(filePath, `${name}${extension}`)));
            if (Buffer.isBuffer(bg.data)) {
                const newFile = `${file}${extension}`;
                writeFileAtomicSync(path.join(filePath, newFile), bg.data);
                bg.name = clientRelativePath(request.user.directories.root, path.join(filePath, newFile)); // Update background name to the new file
                console.log(`Created ${newFile} background from BYAF import`);
            }
        }

        const chats = [];
        // Create chats for each scenario
        if (Array.isArray(byafData.scenarios)) {
            for (const scenario of byafData.scenarios) {
                chats.push(createChatAsCurrentPersona(scenario));
            }
        }

        // Update the default chat if there are any so we open to an existing chat instead of creating a new one and opening that.
        if (chats.length > 0) {
            card.chat = path.basename(chats[0], path.extname(chats[0]));
        }

        // Save alternate icons for the character.
        for (const icon of byafData.images.slice(1)) {
            // BYAF does not support character expressions, so using the same structure will not result in conflicts,
            // even if the expression system did not tolerate additional icons that are not mapped to expressions.
            // This will not yet allow changing icons within the UI but at least the icons will be available for manual selection, rather than being lost.
            const altImagesFolder = path.join(request.user.directories.characters, sanitize(cardName));
            if (!fs.existsSync(altImagesFolder)) fs.mkdirSync(altImagesFolder, { recursive: true });
            const extension = path.extname(icon.filename) || '.png';
            const file = getUniqueName(`${sanitize(icon.label, { replacement: sanitizeSafeCharacterReplacements }) || 'alt'}`, (name) => fs.existsSync(path.join(altImagesFolder, `${name}${extension}`)));
            if (Buffer.isBuffer(icon.image)) {
                writeFileAtomicSync(path.join(altImagesFolder, `${file}${extension}`), icon.image);
                console.log(`Created ${file}${extension} alternate icon from BYAF import`);
            }
        }
    }

    const result = await writeCharacterData(byafData.images[0].image, JSON.stringify(card), fileName, request);

    return result ? fileName : '';
}

/**
 * Import a character from a JSON file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromJson(uploadPath, { request }, preservedFileName) {
    const data = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);

    let jsonData = JSON.parse(data);

    if (jsonData.spec !== undefined) {
        console.info(`Importing from ${jsonData.spec} json`);
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        jsonData = getStoredCharaCardV2(jsonData, request.user.directories);
        jsonData.create_date = new Date().toISOString();
        const pngName = preservedFileName || getPngName(jsonData.data?.name || jsonData.name, request.user.directories);
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, char, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        console.info('Importing from v1 json');
        jsonData.name = sanitize(jsonData.name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        let charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.char_name !== undefined) {
        //json Pygmalion notepad
        console.info('Importing from gradio json');
        jsonData.char_name = sanitize(jsonData.char_name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.char_name, request.user.directories);
        let char = {
            'name': jsonData.char_name,
            'description': jsonData.char_persona ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': '',
            'first_mes': jsonData.char_greeting ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.example_dialogue ?? '',
            'scenario': jsonData.world_scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    }

    return '';
}

/**
 * Import a character from a PNG file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromPng(uploadPath, { request }, preservedFileName) {
    const imgData = await readCharacterData(uploadPath);
    if (imgData === undefined) throw new Error('Failed to read character data');

    let jsonData = JSON.parse(imgData);

    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
    const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);

    if (jsonData.spec !== undefined) {
        console.info(`Found a ${jsonData.spec} character file.`);
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        jsonData = getStoredCharaCardV2(jsonData, request.user.directories);
        jsonData.create_date = new Date().toISOString();
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(uploadPath, char, pngName, request);
        fs.unlinkSync(uploadPath);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        console.info('Found a v1 character file.');

        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }

        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(uploadPath, charJSON, pngName, request);
        fs.unlinkSync(uploadPath);
        return result ? pngName : '';
    }

    return '';
}

export const router = express.Router();

router.post('/create', getFileNameValidationFunction('file_name'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        request.body.ch_name = sanitize(request.body.ch_name);

        const char = JSON.stringify(charaFormatData(request.body, request.user.directories));
        const internalName = request.body.file_name || getPngName(request.body.ch_name, request.user.directories);
        const avatarName = `${internalName}.png`;
        const chatsPath = path.join(request.user.directories.chats, internalName);

        if (!fs.existsSync(chatsPath)) fs.mkdirSync(chatsPath);

        if (!request.file) {
            await writeCharacterData(DEFAULT_AVATAR_PATH, char, internalName, request);
            return response.send(avatarName);
        } else {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            await writeCharacterData(uploadPath, char, internalName, request, crop);
            fs.unlinkSync(uploadPath);
            return response.send(avatarName);
        }
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const oldAvatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);
    const oldInternalName = path.parse(request.body.avatar_url).name;
    const newInternalName = getPngName(newName, request.user.directories, { excludeInternalName: oldInternalName });
    const newAvatarName = `${newInternalName}.png`;

    const oldAvatarPath = path.join(request.user.directories.characters, oldAvatarName);
    const newAvatarPath = path.join(request.user.directories.characters, newAvatarName);

    const oldChatsPath = path.join(request.user.directories.chats, oldInternalName);
    const newChatsPath = path.join(request.user.directories.chats, newInternalName);

    try {
        // Read old file, replace name int it
        const rawOldData = await readCharacterData(oldAvatarPath);
        if (rawOldData === undefined) throw new Error('Failed to read character file');

        const oldData = getStoredCharaCardV2(JSON.parse(rawOldData), request.user.directories);
        _.set(oldData, 'data.name', newName);
        const newData = JSON.stringify(oldData);

        // Write data to new location
        await writeCharacterData(oldAvatarPath, newData, newInternalName, request);

        // Rename chats folder
        if (fs.existsSync(oldChatsPath) && !fs.existsSync(newChatsPath)) {
            fs.cpSync(oldChatsPath, newChatsPath, { recursive: true });
            fs.rmSync(oldChatsPath, { recursive: true, force: true });
        }

        renameAllCharacterStateSidecars(oldAvatarPath, newAvatarPath);

        // Remove the old character file
        fs.unlinkSync(oldAvatarPath);

        // Return new avatar name to ST
        return response.send({ avatar: newAvatarName });
    } catch (err) {
        console.error(err);
        return response.sendStatus(500);
    }
});

router.post('/edit', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) {
        console.warn('Error: no response body detected');
        response.status(400).send('Error: no response body detected');
        return;
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        response.status(400).send('Error: invalid name.');
        return;
    }

    const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
    let char = charaFormatData(request.body, request.user.directories);
    let targetFile = (request.body.avatar_url).replace('.png', '');

    try {
        // Preserve unknown/extended fields (e.g. data.extensions.luker.dedicated_personas)
        // when editing a character through the legacy form endpoint.
        const existingRaw = await readCharacterData(avatarPath);
        if (typeof existingRaw === 'string' && existingRaw.length > 0) {
            try {
                const existingChar = getStoredCharaCardV2(JSON.parse(existingRaw), request.user.directories, false);
                char = toStoredV2Character(deepMerge(existingChar, char));
            } catch (error) {
                console.warn('Failed to parse existing character while preserving extension fields in /edit', error);
            }
        }

        char.chat = request.body.chat;
        char.create_date = request.body.create_date;
        const serialized = JSON.stringify(char);

        if (!request.file) {
            const writeOk = await writeCharacterData(
                avatarPath,
                serialized,
                targetFile,
                request,
                undefined,
                { allowMissingInputFallback: false, requireExistingOutput: true },
            );
            if (!writeOk) {
                return response.status(500).send('Error: failed to persist character data');
            }
        } else {
            const crop = tryParse(request.query.crop);
            const newAvatarPath = path.join(request.file.destination, request.file.filename);
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
            await writeCharacterData(newAvatarPath, serialized, targetFile, request, crop);
            fs.unlinkSync(newAvatarPath);

            // Bust cache to reload the new avatar
            cacheBuster.bust(request, response);
        }

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    }
});

router.post('/edit-avatar', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.file) {
            return response.status(400).send('Error: no file uploaded');
        }

        if (!request.body || !request.body.avatar_url) {
            return response.status(400).send('Error: no avatar_url in request body');
        }

        const uploadPath = path.join(request.file.destination, request.file.filename);
        if (!fs.existsSync(uploadPath)) {
            return response.status(400).send('Error: uploaded file does not exist');
        }
        const characterPath = path.join(request.user.directories.characters, request.body.avatar_url);
        if (!fs.existsSync(characterPath)) {
            return response.status(400).send('Error: character file does not exist');
        }
        const data = await readCharacterData(characterPath);
        if (!data) {
            return response.status(400).send('Error: failed to read character data');
        }

        const crop = tryParse(request.query.crop);
        const fileName = request.body.avatar_url.replace('.png', '');
        await writeCharacterData(uploadPath, data, fileName, request, crop);

        // Remove uploaded temp file
        fs.unlinkSync(uploadPath);

        // Reset images caches
        cacheBuster.bust(request, response);
        invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred while editing avatar', err);
        return response.sendStatus(500);
    }
});

/**
 * Handle a POST request to edit a character attribute.
 *
 * This function reads the character data from a file, updates the specified attribute,
 * and writes the updated data back to the file.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 * @returns {void}
 */
router.post('/edit-attribute', validateAvatarUrlMiddleware, async function (request, response) {
    console.debug(request.body);
    if (!request.body) {
        console.warn('Error: no response body detected');
        return response.status(400).send('Error: no response body detected');
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        return response.status(400).send('Error: invalid name.');
    }

    if (request.body.field === 'json_data') {
        console.warn('Error: cannot edit json_data field.');
        return response.status(400).send('Error: cannot edit json_data field.');
    }

    try {
        const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
        const charJSON = await readCharacterData(avatarPath);
        if (typeof charJSON !== 'string') throw new Error('Failed to read character file');

        const char = JSON.parse(charJSON);
        const targetPath = resolveCharacterEditFieldPath(request.body.field);
        //check if the field exists
        if (!targetPath || _.get(char, targetPath) === undefined) {
            console.warn('Error: invalid field.');
            response.status(400).send('Error: invalid field.');
            return;
        }
        _.set(char, targetPath, request.body.value);
        const newCharJSON = JSON.stringify(getStoredCharaCardV2(char, request.user.directories, false));
        const targetFile = (request.body.avatar_url).replace('.png', '');
        const writeOk = await writeCharacterData(
            avatarPath,
            newCharJSON,
            targetFile,
            request,
            undefined,
            { allowMissingInputFallback: false, requireExistingOutput: true },
        );
        if (!writeOk) {
            console.error('Failed to persist character after edit-attribute.');
            return response.status(500).send('Error: failed to persist character data');
        }
        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    }
});

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Use this in
 * the merge payload wherever a key should be deleted.
 *
 * Both the server and the frontend share this constant so that callers can
 * explicitly opt into deletion without overloading `null`.
 * @type {string}
 */
const UNSET_SENTINEL = '__@@UNSET@@__';

/** Maximum number of characters processed in parallel during bulk merge */
const BULK_MERGE_CONCURRENCY = 10;

/**
 * Recursively walks `source` and removes any key from `target` whose
 * corresponding value in `source` equals the {@link UNSET_SENTINEL}.
 * Called after {@link deepMerge} so that the sentinel gets replaced by
 * an actual key deletion.
 * @param {object} target The merged character object to clean up
 * @param {object} source The original update payload (pre-merge clone)
 */
function processUnsetSentinels(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] === UNSET_SENTINEL) {
            _.unset(target, key);
        } else if (_.isPlainObject(source[key]) && _.isPlainObject(target[key])) {
            processUnsetSentinels(target[key], source[key]);
        }
    }
}

/**
 * Reads a character card, applies a merge update (with sentinel-based
 * unsetting), validates the result, and writes it back.
 * @param {string} avatarPath Full path to the character PNG
 * @param {string} avatar     Avatar filename (e.g. "char.png")
 * @param {object} updateData The merge payload to apply
 * @param {import("express").Request} request Express request object
 * @param {((data: any) => boolean) | null} [shouldSkip] Optional function to determine if a character should be skipped based on its original data (used for bulk merge filtering)
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean}>} Result of the merge operation, including any validation error
 */
async function mergeCharacterUpdate(avatarPath, avatar, updateData, request, shouldSkip = null) {
    const pngStringData = await readCharacterData(avatarPath);
    if (!pngStringData) {
        return { ok: false, error: 'Invalid character file' };
    }

    let character = JSON.parse(pngStringData);

    if (typeof shouldSkip === 'function' && shouldSkip(character)) {
        return { ok: false, skipped: true };
    }

    const update = _.cloneDeep(updateData);
    _.unset(update, 'json_data');
    _.unset(character, 'json_data');

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);

    const validator = new TavernCardValidator(character);
    //Accept either V1 or V2.
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const targetImg = avatar.replace('.png', '');
    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request);
    return { ok: true };
}

/**
 * Handle a POST request to edit character properties.
 *
 * Operates in two modes depending on the request body:
 *
 * **Single mode** (default behavior) — when `avatar` (string) is present:
 *   Merges the request body with the selected character and validates the
 *   result against TavernCard V2 specification.
 *
 * **Bulk mode** — when `avatars` (array) is present:
 *   Applies the same merge to multiple characters in parallel. Supports:
 *   - An explicit list of avatars, or all characters when the array is empty
 *   - An optional server-side `filter` so only characters where a given
 *     JSON path exists and is non-null are updated
 *
 * In both modes, any value equal to the sentinel `__@@UNSET@@__` will cause
 * that key to be **deleted** from the character card instead of being set.
 *
 * @param {import("express").Request} request - The HTTP request object
 * @param {import("express").Response} response - The HTTP response object
 * @returns {void}
 */
router.post('/merge-attributes', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        // ── Bulk mode: avatars array is present ──────────────────
        if (Array.isArray(request.body.avatars)) {
            const { avatars, data, filter } = request.body;

            if (!_.isPlainObject(data)) {
                return response.status(400).send({ message: 'No valid update data provided.' });
            }

            // Determine which avatar files to process
            let targetAvatars;
            if (avatars.length > 0) {
                for (const avatar of avatars) {
                    if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar) || path.extname(avatar).toLowerCase() !== '.png') {
                        return response.status(400).send({ message: `Invalid avatar filename: ${avatar}` });
                    }
                }
                targetAvatars = avatars;
            } else {
                // Empty array → scan all characters in the directory
                const files = fs.readdirSync(request.user.directories.characters);
                targetAvatars = files.filter(file => path.extname(file).toLowerCase() === '.png');
            }

            const updated = [];
            const skipped = [];
            const failed = [];

            /**
             * Process a single character in bulk: read, filter, merge, validate, write.
             * @param {string} avatar Avatar filename
             */
            const processOne = async (avatar) => {
                const avatarPath = path.join(request.user.directories.characters, avatar);

                try {
                    /** @type {(character: object) => boolean} */
                    let shouldSkip = () => false;

                    // Apply optional server-side filter before updating the card
                    if (filter && typeof filter.path === 'string') {
                        shouldSkip = (character) => {
                            const value = _.get(character, filter.path);
                            return value === undefined;
                        };
                    }

                    const result = await mergeCharacterUpdate(avatarPath, avatar, data, request, shouldSkip);
                    if (result.ok) {
                        updated.push(avatar);
                    } else if (result.skipped) {
                        skipped.push(avatar);
                    } else {
                        console.warn(`Bulk merge failed for ${avatar}:`, result.error);
                        failed.push(avatar);
                    }
                } catch (error) {
                    console.error(`Bulk merge failed for ${avatar}:`, error);
                    failed.push(avatar);
                }
            };

            // Process in parallel with a concurrency limit
            for (let i = 0; i < targetAvatars.length; i += BULK_MERGE_CONCURRENCY) {
                const batch = targetAvatars.slice(i, i + BULK_MERGE_CONCURRENCY);
                await Promise.allSettled(batch.map(processOne));
            }

            return response.send({ updated, skipped, failed });
        }

        // ── Single mode (default behavior) ───────────────────────
        const update = request.body;
        const avatarPath = path.join(request.user.directories.characters, update.avatar);

        const pngStringData = await readCharacterData(avatarPath);

        if (!pngStringData) {
            console.error('Error: invalid character file.');
            return response.status(400).send('Error: invalid character file.');
        }

        let character = JSON.parse(pngStringData);

        _.unset(update, 'json_data');
        _.unset(character, 'json_data');

        character = getStoredCharaCardV2(deepMerge(character, update), request.user.directories, false);

        const validator = new TavernCardValidator(character);
        const targetImg = (update.avatar).replace('.png', '');

        //Accept either V1 or V2.
        if (validator.validate()) {
            const writeOk = await writeCharacterData(
                avatarPath,
                JSON.stringify(character),
                targetImg,
                request,
                undefined,
                { allowMissingInputFallback: false, requireExistingOutput: true },
            );
            if (!writeOk) {
                console.error('Failed to persist character after merge-attributes.');
                return response.status(500).send({ message: 'Failed to persist character card.' });
            }
            response.sendStatus(200);
        } else {
            response.status(400).send({ message: `Validation failed for ${_.get(character, 'data.name', character.name)}`, error: validator.lastValidationError });
        }
    } catch (exception) {
        response.status(500).send({ message: 'Unexpected error while saving character.', error: exception.toString() });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body || !request.body.avatar_url) {
        return response.sendStatus(400);
    }

    if (request.body.avatar_url !== sanitize(request.body.avatar_url)) {
        console.error('Malicious filename prevented');
        return response.sendStatus(403);
    }

    const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
    if (!fs.existsSync(avatarPath)) {
        return response.sendStatus(400);
    }

    deleteAllCharacterStateSidecars(avatarPath);
    fs.unlinkSync(avatarPath);
    invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
    let dir_name = (request.body.avatar_url.replace('.png', ''));

    if (!dir_name.length) {
        console.error('Malicious dirname prevented');
        return response.sendStatus(403);
    }

    if (request.body.delete_chats == true) {
        try {
            await fs.promises.rm(path.join(request.user.directories.chats, sanitize(dir_name)), { recursive: true, force: true });
        } catch (err) {
            console.error(err);
            return response.sendStatus(500);
        }
    }

    // Clean up CardApp files
    deleteCardAppFiles(dir_name, request.user.directories.cardApps);

    return response.sendStatus(200);
});

/**
 * HTTP POST endpoint for the "/api/characters/all" route.
 *
 * This endpoint is responsible for reading character files from the `charactersPath` directory,
 * parsing character data, calculating stats for each character and responding with the data.
 * Stats are calculated only on the first run, on subsequent runs the stats are fetched from
 * the `charStats` variable.
 * The stats are calculated by the `calculateStats` function.
 * The characters are processed by the `processCharacter` function.
 *
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/all', async function (request, response) {
    try {
        return response.send(await getCharactersSnapshot(request.user.directories));
    } catch (err) {
        console.error(err);
        const isRangeError = err instanceof RangeError;
        response.status(500).send({ overflow: isRangeError, error: true });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        const item = request.body.avatar_url;
        const filePath = path.join(request.user.directories.characters, item);

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        const data = await processCharacter(item, request.user.directories, { shallow: false });

        return response.send(data);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/snapshot', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Expected body.avatar_url string.' });
        }

        const characterPath = path.join(request.user.directories.characters, avatarUrl);
        if (!fs.existsSync(characterPath)) {
            return response.sendStatus(404);
        }

        const card = fs.readFileSync(characterPath).toString('base64');
        const parsedCharacterPath = path.parse(characterPath);
        const sidecarPrefix = `${parsedCharacterPath.name}${CHARACTER_STATE_FILE_PREFIX}`;
        const states = getAllCharacterStateSidecarPaths(characterPath)
            .map(sidecarPath => {
                const raw = tryReadFileSync(sidecarPath);
                if (!raw) {
                    return null;
                }

                const data = tryParse(raw);
                if (!_.isObjectLike(data) || Array.isArray(data)) {
                    console.warn(`Invalid character state sidecar JSON: ${sidecarPath}`);
                    return null;
                }

                const fileName = path.basename(sidecarPath);
                const namespace = fileName.slice(sidecarPrefix.length, -CHARACTER_STATE_FILE_SUFFIX.length);
                if (!namespace) {
                    return null;
                }

                return { namespace, data };
            })
            .filter(Boolean);

        return response.send({ ok: true, avatar_url: avatarUrl, card, states });
    } catch (error) {
        console.error('Error creating character snapshot:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/get', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
        const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Expected body.avatar_url string.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const characterPath = path.join(request.user.directories.characters, avatarUrl);
        const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
        if (!stateFilePath || !fs.existsSync(stateFilePath)) {
            return response.send({ ok: true, data: null });
        }

        const raw = tryReadFileSync(stateFilePath);
        if (!raw) {
            return response.send({ ok: true, data: null });
        }

        const parsed = tryParse(raw);
        if (!_.isObjectLike(parsed) || Array.isArray(parsed)) {
            console.warn(`Invalid character state sidecar JSON: ${stateFilePath}`);
            return response.send({ ok: true, data: null });
        }

        return response.send({ ok: true, data: parsed });
    } catch (error) {
        console.error('Error reading character state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/set', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
        const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
        const state = request.body?.data;
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Expected body.avatar_url string.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        if (!_.isObjectLike(state) || Array.isArray(state)) {
            return response.status(400).send({ error: 'Expected body.data object.' });
        }

        const characterPath = path.join(request.user.directories.characters, avatarUrl);
        if (!fs.existsSync(characterPath)) {
            return response.status(404).send({ error: 'Character not found.' });
        }
        const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
        if (!stateFilePath) {
            return response.status(400).send({ error: 'Invalid namespace for state sidecar path.' });
        }

        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        writeFileAtomicSync(stateFilePath, JSON.stringify(state), 'utf8');
        return response.send({ ok: true });
    } catch (error) {
        console.error('Error writing character state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/delete', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const avatarUrl = sanitize(String(request.body?.avatar_url || '').trim());
        const namespace = normalizeCharacterStateNamespace(request.body?.namespace);
        if (!avatarUrl) {
            return response.status(400).send({ error: 'Expected body.avatar_url string.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const characterPath = path.join(request.user.directories.characters, avatarUrl);
        const stateFilePath = getCharacterStateSidecarPath(characterPath, namespace);
        if (!stateFilePath || !fs.existsSync(stateFilePath)) {
            return response.send({ ok: true, deleted: false });
        }

        fs.unlinkSync(stateFilePath);
        return response.send({ ok: true, deleted: true });
    } catch (error) {
        console.error('Error deleting character state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/chats', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const characterDirectory = (request.body.avatar_url).replace('.png', '');
        const chatsDirectory = path.join(request.user.directories.chats, characterDirectory);

        if (!fs.existsSync(chatsDirectory)) {
            return response.send({ error: true });
        }

        const files = fs.readdirSync(chatsDirectory, { withFileTypes: true });
        const jsonFiles = files.filter(file => file.isFile() && path.extname(file.name) === '.jsonl').map(file => file.name);

        if (jsonFiles.length === 0) {
            return response.send([]);
        }

        if (request.body.simple) {
            return response.send(jsonFiles.map(file => ({ file_name: file, file_id: path.parse(file).name })));
        }

        const jsonFilesPromise = jsonFiles.map((file) => {
            const withMetadata = !!request.body.metadata;
            const pathToFile = path.join(request.user.directories.chats, characterDirectory, file);
            return getChatInfo(pathToFile, {}, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

/**
 * Gets the name for the uploaded PNG file.
 * @param {string} file File name
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {{ excludeInternalName?: string }} [options] Options
 * @returns {string} - The name for the uploaded PNG file
 */
function getPngName(file, directories, options = {}) {
    const excludedName = String(options.excludeInternalName || '').trim();
    const internalNameExists = (name) => {
        if (!name) {
            return false;
        }
        if (excludedName && name === excludedName) {
            return false;
        }

        const avatarPath = path.join(directories.characters, `${name}.png`);
        const chatsPath = path.join(directories.chats, name);
        return fs.existsSync(avatarPath) || fs.existsSync(chatsPath);
    };

    let i = 1;
    const baseName = file;
    while (internalNameExists(file)) {
        file = baseName + i;
        i++;
    }
    return file;
}

function normalizeCharacterStateNamespace(namespace) {
    const raw = String(namespace || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    return raw.replace(/[^a-z0-9._-]/g, '_').slice(0, 96);
}

function getCharacterStateSidecarPath(characterFilePath, namespace) {
    const safeNamespace = normalizeCharacterStateNamespace(namespace);
    if (!safeNamespace) {
        return '';
    }
    const parsed = path.parse(characterFilePath);
    return path.join(parsed.dir, `${parsed.name}${CHARACTER_STATE_FILE_PREFIX}${safeNamespace}${CHARACTER_STATE_FILE_SUFFIX}`);
}

function getAllCharacterStateSidecarPaths(characterFilePath) {
    const parsed = path.parse(characterFilePath);
    if (!fs.existsSync(parsed.dir)) {
        return [];
    }
    const prefix = `${parsed.name}${CHARACTER_STATE_FILE_PREFIX}`;
    const files = fs.readdirSync(parsed.dir, { withFileTypes: true });
    return files
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(fileName => fileName.startsWith(prefix) && fileName.endsWith(CHARACTER_STATE_FILE_SUFFIX))
        .map(fileName => path.join(parsed.dir, fileName));
}

function renameAllCharacterStateSidecars(sourceCharacterPath, targetCharacterPath) {
    const sourceParsed = path.parse(sourceCharacterPath);
    const targetParsed = path.parse(targetCharacterPath);
    const sourcePrefix = `${sourceParsed.name}${CHARACTER_STATE_FILE_PREFIX}`;
    const targetPrefix = `${targetParsed.name}${CHARACTER_STATE_FILE_PREFIX}`;
    const sourceFiles = getAllCharacterStateSidecarPaths(sourceCharacterPath);
    if (sourceFiles.length === 0) {
        return;
    }

    for (const sourceFilePath of sourceFiles) {
        const sourceName = path.basename(sourceFilePath);
        const namespaceWithSuffix = sourceName.slice(sourcePrefix.length);
        const targetName = `${targetPrefix}${namespaceWithSuffix}`;
        const targetFilePath = path.join(targetParsed.dir, targetName);
        if (fs.existsSync(targetFilePath)) {
            throw new Error(`Character state sidecar rename collision: ${targetFilePath}`);
        }
        fs.copyFileSync(sourceFilePath, targetFilePath);
        fs.unlinkSync(sourceFilePath);
    }
}

function deleteAllCharacterStateSidecars(characterFilePath) {
    const sidecars = getAllCharacterStateSidecarPaths(characterFilePath);
    for (const sidecarPath of sidecars) {
        try {
            fs.unlinkSync(sidecarPath);
        } catch (error) {
            console.warn('Failed to delete character state sidecar:', sidecarPath, error);
        }
    }
}

/**
 * Gets the preserved name for the uploaded file if the request is valid.
 * @param {import("express").Request} request - Express request object
 * @returns {string | undefined} - The preserved name if the request is valid, otherwise undefined
 */
function getPreservedName(request) {
    return typeof request.body.preserved_name === 'string' && request.body.preserved_name.length > 0
        ? path.parse(request.body.preserved_name).name
        : undefined;
}

router.post('/import', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = request.body.file_type;
    const preservedFileName = getPreservedName(request);

    const formatImportFunctions = {
        'yaml': importFromYaml,
        'yml': importFromYaml,
        'json': importFromJson,
        'png': importFromPng,
        'charx': importFromCharX,
        'byaf': importFromByaf,
    };

    try {
        const importFunction = formatImportFunctions[format];

        if (!importFunction) {
            throw new Error(`Unsupported format: ${format}`);
        }

        const fileName = await importFunction(uploadPath, { request, response }, preservedFileName);

        if (!fileName) {
            console.warn('Failed to import character');
            return response.sendStatus(400);
        }

        if (preservedFileName) {
            invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);
        }

        // Extract CardApp files from character data to independent directory
        try {
            const charId = fileName.replace('.png', '');
            const charFilePath = path.join(request.user.directories.characters, `${fileName}.png`);
            const rawData = await readCharacterData(charFilePath);
            if (rawData) {
                const charData = JSON.parse(rawData);
                if (extractCardAppFiles(charData, charId, request.user.directories.cardApps)) {
                    // Re-write character data without the embedded files
                    await writeCharacterData(charFilePath, JSON.stringify(charData), charId, request, undefined, { requireExistingOutput: true });
                }
            }
        } catch (cardAppErr) {
            console.warn('[card-app] Failed to extract CardApp files during import:', cardAppErr);
        }

        response.send({ file_name: fileName });
    } catch (err) {
        console.error(err);
        response.send({ error: true });
    }
});

router.post('/duplicate', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.avatar_url) {
            console.warn('avatar URL not found in request body');
            console.debug(request.body);
            return response.sendStatus(400);
        }
        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));
        if (!fs.existsSync(filename)) {
            console.error('file for dupe not found', filename);
            return response.sendStatus(404);
        }
        const nameParts = path.basename(filename, path.extname(filename)).split('_');
        const lastPart = nameParts[nameParts.length - 1];
        const ext = path.extname(filename);
        const baseName = !isNaN(Number(lastPart)) && nameParts.length > 1
            ? nameParts.slice(0, -1).join('_')
            : nameParts.join('_');
        let suffix = !isNaN(Number(lastPart)) && nameParts.length > 1
            ? parseInt(lastPart) + 1
            : 1;
        let duplicateBaseName = `${baseName}_${suffix}`;

        while (getPngName(duplicateBaseName, request.user.directories) !== duplicateBaseName) {
            suffix++;
            duplicateBaseName = `${baseName}_${suffix}`;
        }

        const newFilename = path.join(request.user.directories.characters, `${duplicateBaseName}${ext}`);

        fs.copyFileSync(filename, newFilename);
        console.info(`${filename} was copied to ${newFilename}`);
        response.send({ path: path.parse(newFilename).base });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.format || !request.body.avatar_url) {
            return response.sendStatus(400);
        }

        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));

        if (!fs.existsSync(filename)) {
            return response.sendStatus(404);
        }

        switch (request.body.format) {
            case 'png': {
                const rawBuffer = await fsPromises.readFile(filename);
                const rawData = read(rawBuffer);
                const jsonObject = getStoredCharaCardV2(JSON.parse(rawData), request.user.directories);
                syncCharacterBookFromWorldInfo(jsonObject, request.user.directories, _.get(jsonObject, 'data.extensions.world'));
                unsetPrivateFields(jsonObject);
                // Pack CardApp files into export data
                const exportCharId = sanitize(request.body.avatar_url).replace('.png', '');
                packCardAppFiles(jsonObject, exportCharId, request.user.directories.cardApps);
                const mutatedBuffer = write(rawBuffer, JSON.stringify(toStoredV2Character(jsonObject)));
                const contentType = mime.lookup(filename) || 'image/png';
                response.setHeader('Content-Type', contentType);
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(path.basename(filename))}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                try {
                    const json = await readCharacterData(filename);
                    if (json === undefined) return response.sendStatus(400);
                    const jsonObject = getStoredCharaCardV2(JSON.parse(json), request.user.directories);
                    syncCharacterBookFromWorldInfo(jsonObject, request.user.directories, _.get(jsonObject, 'data.extensions.world'));
                    unsetPrivateFields(jsonObject);
                    // Pack CardApp files into export data
                    const exportCharIdJson = sanitize(request.body.avatar_url).replace('.png', '');
                    packCardAppFiles(jsonObject, exportCharIdJson, request.user.directories.cardApps);
                    return response.type('json').send(JSON.stringify(toStoredV2Character(jsonObject), null, 4));
                } catch {
                    return response.sendStatus(400);
                }
            }
        }

        return response.sendStatus(400);
    } catch (err) {
        console.error('Character export failed', err);
        response.sendStatus(500);
    }
});
