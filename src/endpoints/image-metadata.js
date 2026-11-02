/**
 * Generic image metadata service.
 * Provides on-demand metadata generation with file mtime-based caching.
 * The synced index and the device-local cache are separate files; reads
 * return them combined.
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import express from 'express';
import { Jimp } from '../jimp.js';
import { HAS_WASM } from '../runtime-capabilities.js';
import { getConfigValue, getImages, isPathUnderParent, uuidv4 } from '../util.js';
import { legacyCacheEntries, normalizeImageMetadataIndex, serializeImageMetadataIndex } from '../image-metadata-index.js';

/** The synced index: folders, folder assignments and added times. */
export const METADATA_FILE = 'image-metadata.json';
/**
 * What each image file derives, kept per device: its values depend on the
 * local file, so syncing them would make every device rewrite the synced
 * index. No sync category covers `thumbnails/`.
 */
export const METADATA_CACHE_FILE = path.join('thumbnails', 'image-metadata-cache.json');

/**
 * @typedef {Object} ImageMetadata
 * @property {string} [hash] - SHA-256 hash of the image file.
 * @property {number} [aspectRatio] - Aspect ratio (width / height) of the image.
 * @property {boolean} [isAnimated] - Whether the image is animated.
 * @property {string} [dominantColor] - Dominant color in hex format (e.g., '#RRGGBB').
 * @property {string[]} folderIds - Array of virtual folder IDs the image belongs to.
 * @property {number} [addedTimestamp] - Timestamp when the image was added.
 * @property {number} [thumbnailResolution] - Thumbnail resolution (width * height) for cache invalidation.
 * @property {number} [mtime] - File modification time for cache invalidation (internal use).
 */

/**
 * @typedef {Object} CachedImageMetadata
 * @property {string} hash
 * @property {number} aspectRatio
 * @property {boolean} isAnimated
 * @property {string} dominantColor
 * @property {number} thumbnailResolution
 * @property {number} mtime
 */

/**
 * @typedef {Object} MetadataIndex
 * @property {number} version - Metadata version.
 * @property {Object.<string, ImageMetadata>} images - Mapping of relative paths to their metadata.
 * @property {Array<{id: string, name: string, thumbnailFile: string}>} folders - Virtual folders.
 */

/**
 * @typedef {'bg' | 'avatar' | 'persona'} ThumbnailType
 */

/** @type {Record<string, number[]>} */
export const thumbnailDimensions = {
    'bg': getConfigValue('thumbnails.dimensions.bg', [160, 90]),
    'avatar': getConfigValue('thumbnails.dimensions.avatar', [96, 144]),
    'persona': getConfigValue('thumbnails.dimensions.persona', [96, 144]),
};

/**
 * Gets the configured resolution for a given thumbnail type.
 * @param {ThumbnailType} type Thumbnail type
 * @returns {number} Resolution (width * height)
 */
export function getThumbnailResolution(type) {
    const dims = thumbnailDimensions[type];
    if (Array.isArray(dims) && dims.length >= 2) {
        return Number(dims[0]) * Number(dims[1]);
    }
    return 0;
}

/**
 * Checks if a buffer contains an animated PNG (APNG) by looking for the 'acTL' chunk.
 * @param {Buffer} buffer The file buffer.
 * @returns {boolean}
 */
export function isAnimatedApng(buffer) {
    return buffer.subarray(0, 200).includes('acTL');
}

/**
 * Checks if a WebP buffer is animated by looking for 'ANIM' or 'ANMF' chunks.
 * @param {Buffer} buffer The WebP file buffer (can be full file or header)
 * @returns {boolean} True if the WebP is animated
 */
export function isAnimatedWebP(buffer) {
    const headerBuffer = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;
    return headerBuffer.includes('ANIM') || headerBuffer.includes('ANMF');
}

/**
 * Calculate average color using Jimp.
 * Resizes the image to 1x1 to efficiently get the average color.
 * @param {Buffer} buffer The image buffer.
 * @returns {Promise<string>} The average color as a hex string (e.g., '#RRGGBB').
 */
async function getAverageColorWithJimp(buffer) {
    try {
        const image = await Jimp.read(buffer);
        image.resize({ w: 1, h: 1 });

        const colorInt = image.getPixelColor(0, 0);
        const r = (colorInt >> 24) & 255;
        const g = (colorInt >> 16) & 255;
        const b = (colorInt >> 8) & 255;

        const toHex = (c) => c.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (error) {
        console.warn('[Jimp] Failed to calculate average color:', error.message);
        return '#808080';
    }
}

/**
 * Generates the metadata a single image file derives: everything the
 * device-local cache holds apart from `mtime`.
 * @param {string} filePath - The full path to the image file.
 * @param {ThumbnailType} type - The thumbnail type for resolution calculation.
 * @returns {Promise<Omit<CachedImageMetadata, 'mtime'>>} Throws an error if processing fails.
 */
export async function generateImageMetadata(filePath, type) {
    const buffer = await fs.readFile(filePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const dimensions = imageSize(buffer);

    if (!dimensions || !dimensions.width || !dimensions.height) {
        throw new Error('Could not determine image dimensions.');
    }

    const aspectRatio = dimensions.width / dimensions.height;
    let isAnimated = false;

    switch (dimensions.type) {
        case 'gif':
            isAnimated = true;
            break;
        case 'png':
            isAnimated = isAnimatedApng(buffer);
            break;
        case 'webp':
            isAnimated = isAnimatedWebP(buffer);
            break;
    }

    let dominantColor;
    if (isAnimated || !HAS_WASM) {
        // Animated images have no single frame to sample. On jitless runtimes
        // the WASM image codecs are unavailable, and decoding every image with
        // the pure-JS codec just to average a placeholder color is orders of
        // magnitude slower (a single 1920x1080 background decode takes seconds,
        // and the boot warm-up decodes every background), so the dominant color
        // is skipped and a neutral placeholder is used instead.
        dominantColor = '#808080';
    } else {
        dominantColor = await getAverageColorWithJimp(buffer);
    }

    return {
        hash,
        aspectRatio: parseFloat(aspectRatio.toFixed(4)),
        isAnimated,
        dominantColor,
        thumbnailResolution: getThumbnailResolution(type),
    };
}

const toPosix = relativePath => relativePath.replaceAll(path.sep, path.posix.sep);
const addedTimestampOf = stats => Math.floor(stats.birthtimeMs || stats.mtimeMs);

async function readText(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw Object.assign(new Error(`Cannot read image metadata at ${filePath}: ${error.code}; restore read access before retrying`), { code: 'IMAGE_METADATA_READ_FAILED' });
    }
}

function parseJson(text) {
    try {
        return text === null ? null : JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * `unreadable` is true when the file exists but is not a JSON object; its
 * index then reads as empty.
 * @param {string} userDataRoot
 * @returns {Promise<{ raw: string | null, parsed: unknown, unreadable: boolean, index: import('../image-metadata-index.js').SyncedImageIndex }>}
 */
async function readSyncedIndex(userDataRoot) {
    const raw = await readText(path.join(userDataRoot, METADATA_FILE));
    const parsed = parseJson(raw);
    const unreadable = raw !== null && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed));
    return { raw, parsed, unreadable, index: normalizeImageMetadataIndex(parsed) };
}

function assertReadableIndex(synced, userDataRoot) {
    if (synced.unreadable) throw Object.assign(new Error(`Unreadable synchronized image metadata at ${path.join(userDataRoot, METADATA_FILE)}; restore valid JSON before editing or generating metadata`), { code: 'IMAGE_METADATA_PRESERVED' });
}

/**
 * A write no user action asked for leaves an unreadable synced file as it
 * is, so its folders are not replaced by an empty index on this device and
 * then on every synced one.
 * @returns {boolean} true when the write may go ahead
 */
function mayRewrite(synced, userDataRoot) {
    if (!synced.unreadable) return true;
    console.warn(`[ImageMetadata] ${path.join(userDataRoot, METADATA_FILE)} could not be read and is left as it is.`);
    return false;
}

/**
 * Write the synced index when its bytes change.
 * @param {string} userDataRoot
 * @param {{ raw: string | null, index: import('../image-metadata-index.js').SyncedImageIndex }} synced
 */
async function writeSyncedIndex(userDataRoot, synced) {
    assertReadableIndex(synced, userDataRoot);
    const text = serializeImageMetadataIndex(synced.index);
    if (text === synced.raw) return;
    await writeFileAtomic(path.join(userDataRoot, METADATA_FILE), text, 'utf8');
    synced.raw = text;
}

const serializeCache = images => JSON.stringify({ version: 1, images: Object.fromEntries(Object.keys(images).sort().map(key => [key, images[key]])) }, null, 4);

/**
 * @param {string} userDataRoot
 * @returns {Promise<{ raw: string | null, images: Record<string, CachedImageMetadata> }>}
 */
async function readCache(userDataRoot) {
    const raw = await readText(path.join(userDataRoot, METADATA_CACHE_FILE));
    const parsed = parseJson(raw);
    const images = parsed && typeof parsed.images === 'object' && !Array.isArray(parsed.images) ? Object.fromEntries(Object.entries(parsed.images)) : {};
    return { raw, images };
}

/**
 * Write the cache when its bytes change.
 * @param {string} userDataRoot
 * @param {{ raw: string | null, images: Record<string, CachedImageMetadata> }} cache
 */
async function writeCache(userDataRoot, cache) {
    const text = serializeCache(cache.images);
    if (text === cache.raw) return;
    const cachePath = path.join(userDataRoot, METADATA_CACHE_FILE);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await writeFileAtomic(cachePath, text, 'utf8');
    cache.raw = text;
}

/**
 * Move the cache fields a version 1 synced index holds into the cache for
 * the images the cache lacks. `mtime` still decides whether they are used.
 * Only the startup migration adopts them: a version 1 file that a sync
 * brought from another device holds that device's cache, so reads ignore
 * its cache fields and generate them from the local file.
 */
function adoptLegacyCache(cache, parsedSynced) {
    for (const [key, fields] of Object.entries(legacyCacheEntries(parsedSynced))) {
        if (!Object.hasOwn(cache.images, key)) cache.images[key] = fields;
    }
}

/** @returns {ImageMetadata} */
function combine(cached, entry) {
    const out = { ...cached, folderIds: entry?.folderIds ?? [] };
    if (entry && Number.isFinite(entry.addedTimestamp)) out.addedTimestamp = entry.addedTimestamp;
    return out;
}

/**
 * Reads the metadata index: the synced folders and assignments combined
 * with the device-local cache.
 * @param {string} userDataRoot - Path to the user data directory root
 * @returns {Promise<MetadataIndex>} The metadata index
 */
export async function readMetadataIndex(userDataRoot) {
    const synced = await readSyncedIndex(userDataRoot);
    assertReadableIndex(synced, userDataRoot);
    const cache = await readCache(userDataRoot);
    const keys = [...new Set([...Object.keys(synced.index.images), ...Object.keys(cache.images)])].sort();
    return {
        version: synced.index.version,
        images: Object.fromEntries(keys.map(key => [key, combine(cache.images[key], synced.index.images[key])])),
        folders: synced.index.folders,
    };
}

/**
 * Gets metadata for multiple images, generating on-demand as needed.
 * Uses relative paths from the user data root as keys. The cache is
 * regenerated when the file's mtime changed; the synced index gains an
 * entry only for an image it does not know yet, so the added time stays
 * the one the first device recorded.
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string[]} relativePaths - Array of relative paths from userDataRoot
 * @param {ThumbnailType} type - The thumbnail type for resolution calculation.
 * @returns {Promise<{results: Object.<string, ImageMetadata>, generatedCount: number}>} Results map and count of newly generated
 */
export async function getOrGenerateMetadataBatch(userDataRoot, relativePaths, type) {
    /** @type {Object.<string, ImageMetadata>} */
    const results = {};
    const synced = await readSyncedIndex(userDataRoot);
    assertReadableIndex(synced, userDataRoot);
    const cache = await readCache(userDataRoot);
    let syncedChanged = false;
    let generatedCount = 0;

    for (const relativePath of relativePaths) {
        const posixPath = toPosix(relativePath);
        const fullPath = path.join(userDataRoot, relativePath);

        let stats;
        try {
            stats = await fs.stat(fullPath);
        } catch {
            continue; // File doesn't exist, skip
        }

        let cached = cache.images[posixPath];
        if (!cached || cached.mtime !== stats.mtimeMs) {
            try {
                cached = { ...await generateImageMetadata(fullPath, type), mtime: stats.mtimeMs };
            } catch (error) {
                console.warn(`[ImageMetadata] Failed to generate metadata for ${relativePath}:`, error.message);
                continue;
            }
            cache.images[posixPath] = cached;
            generatedCount++;
        }

        let entry = synced.index.images[posixPath];
        if (!entry || !Number.isFinite(entry.addedTimestamp)) {
            entry = { addedTimestamp: addedTimestampOf(stats), folderIds: entry?.folderIds ?? [] };
            synced.index.images[posixPath] = entry;
            syncedChanged = true;
        }
        results[relativePath] = combine(cached, entry);
    }

    await writeCache(userDataRoot, cache);
    if (syncedChanged && mayRewrite(synced, userDataRoot)) await writeSyncedIndex(userDataRoot, synced);

    return { results, generatedCount };
}

/**
 * Removes metadata for an image from the synced index and the cache.
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string} relativePath - The relative path to remove
 */
export async function removeMetadata(userDataRoot, relativePath) {
    const posixPath = toPosix(relativePath);
    const synced = await readSyncedIndex(userDataRoot);
    assertReadableIndex(synced, userDataRoot);
    if (Object.hasOwn(synced.index.images, posixPath)) {
        delete synced.index.images[posixPath];

        // Clear any folder thumbnailFile references that point to the deleted file
        const deletedFileName = path.posix.basename(posixPath);
        for (const folder of synced.index.folders) {
            if (folder.thumbnailFile === deletedFileName) {
                folder.thumbnailFile = '';
            }
        }

        await writeSyncedIndex(userDataRoot, synced);
    }
    const cache = await readCache(userDataRoot);
    if (Object.hasOwn(cache.images, posixPath)) {
        delete cache.images[posixPath];
        await writeCache(userDataRoot, cache);
    }
}

/**
 * Updates metadata for an image (e.g., after rename).
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string} oldRelativePath - The old relative path
 * @param {string} newRelativePath - The new relative path
 * @returns {Promise<ImageMetadata|null>} The updated metadata
 */
export async function renameMetadata(userDataRoot, oldRelativePath, newRelativePath) {
    const posixOldPath = toPosix(oldRelativePath);
    const posixNewPath = toPosix(newRelativePath);
    const synced = await readSyncedIndex(userDataRoot);
    assertReadableIndex(synced, userDataRoot);
    const cache = await readCache(userDataRoot);
    const entry = synced.index.images[posixOldPath];
    const cached = cache.images[posixOldPath];

    if (!entry && !cached) {
        throw new Error(`Image '${oldRelativePath}' not found in metadata.`);
    }

    if (entry) {
        delete synced.index.images[posixOldPath];
        synced.index.images[posixNewPath] = entry;
    }

    // Update any folder thumbnailFile references that point to the old filename
    const oldFileName = path.posix.basename(posixOldPath);
    const newFileName = path.posix.basename(posixNewPath);
    if (oldFileName !== newFileName) {
        for (const folder of synced.index.folders) {
            if (folder.thumbnailFile === oldFileName) {
                folder.thumbnailFile = newFileName;
            }
        }
    }
    if (mayRewrite(synced, userDataRoot)) await writeSyncedIndex(userDataRoot, synced);

    if (cached) {
        delete cache.images[posixOldPath];
        // The renamed copy has its own mtime, so the next read regenerates it.
        cache.images[posixNewPath] = cached;
    }
    await writeCache(userDataRoot, cache);

    return combine(cached, entry);
}

/**
 * Cleans up orphaned entries from the synced index and the cache.
 * Iterates over all entries and removes those whose files no longer exist.
 * @param {string} userDataRoot - Path to the user data directory root
 * @returns {Promise<string[]>} Array of removed paths
 */
export async function cleanupOrphanedMetadata(userDataRoot) {
    const synced = await readSyncedIndex(userDataRoot);
    const cache = await readCache(userDataRoot);
    const orphanedPaths = [];

    for (const relativePath of [...new Set([...Object.keys(synced.index.images), ...Object.keys(cache.images)])]) {
        const fullPath = path.resolve(userDataRoot, relativePath);
        let orphaned = !isPathUnderParent(userDataRoot, fullPath);
        if (!orphaned) {
            try {
                await fs.access(fullPath);
            } catch {
                orphaned = true;
            }
        }
        if (orphaned) {
            orphanedPaths.push(relativePath);
            delete synced.index.images[relativePath];
            delete cache.images[relativePath];
        }
    }

    if (orphanedPaths.length > 0) {
        if (mayRewrite(synced, userDataRoot)) await writeSyncedIndex(userDataRoot, synced);
        await writeCache(userDataRoot, cache);
        console.log(`[ImageMetadata] Cleaned up ${orphanedPaths.length} orphaned metadata entries`);
    }

    if (synced.unreadable) throw Object.assign(new Error('The unreadable synchronized image metadata was preserved.'), { code: 'IMAGE_METADATA_PRESERVED', removed: orphanedPaths });
    return orphanedPaths;
}

/**
 * Initializes metadata for all images in a directory.
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string} subDirectory - Subdirectory relative to userDataRoot
 * @param {ThumbnailType} type - The thumbnail type for resolution calculation
 * @returns {Promise<number>} Number of images processed
 */
export async function initializeMetadataForDirectory(userDataRoot, subDirectory, type) {
    const fullDir = path.join(userDataRoot, subDirectory);

    let images;
    try {
        images = getImages(fullDir);
    } catch {
        // Directory doesn't exist or can't be read
        return 0;
    }

    // Convert to relative paths from userDataRoot
    const relativePaths = images.map(img => path.join(subDirectory, img));

    // Generate metadata for new images
    const { results, generatedCount } = await getOrGenerateMetadataBatch(userDataRoot, relativePaths, type);

    if (generatedCount > 0) {
        console.log(`[ImageMetadata] Generated metadata for ${generatedCount} new images in ${subDirectory}`);
    }

    return Object.keys(results).length;
}

/**
 * Rewrite a version 1 synced index, which mixed in the cache fields, as a
 * version 2 index and move its cache fields to the cache. Idempotent.
 * @param {string} userDataRoot
 */
export async function migrateMetadataIndex(userDataRoot) {
    const synced = await readSyncedIndex(userDataRoot);
    assertReadableIndex(synced, userDataRoot);
    if (synced.raw === null) return;
    const cache = await readCache(userDataRoot);
    adoptLegacyCache(cache, synced.parsed);
    await writeCache(userDataRoot, cache);
    await writeSyncedIndex(userDataRoot, synced);
}

/**
 * Initializes image metadata for all users' background directories.
 * @param {Array<{root: string}>} userDirectories - List of user directory objects
 * @returns {Promise<void>}
 */
export async function initializeAllUserMetadata(userDirectories) {
    try {
        for (const userDir of userDirectories) {
            await migrateMetadataIndex(userDir.root);
            await initializeMetadataForDirectory(userDir.root, 'backgrounds', 'bg');
        }
    } catch (error) {
        console.error('[ImageMetadata] Failed to initialize background metadata:', error.message);
    }
}

/**
 * Creates a new virtual folder.
 * @param {string} userDataRoot
 * @param {string} name
 * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
 */
export async function createFolder(userDataRoot, name) {
    const synced = await readSyncedIndex(userDataRoot);
    const id = uuidv4();
    const folder = { id, name, thumbnailFile: '' };
    synced.index.folders.push(folder);
    await writeSyncedIndex(userDataRoot, synced);
    return folder;
}

/**
 * Sets thumbnail files for multiple folders in a single atomic read-modify-write.
 * Folders not found in the index are silently skipped.
 * @param {string} userDataRoot
 * @param {{id: string, thumbnailFile: string}[]} updates
 * @returns {Promise<void>}
 */
export async function setFolderThumbnailsBatch(userDataRoot, updates) {
    const synced = await readSyncedIndex(userDataRoot);
    for (const { id, thumbnailFile } of updates) {
        const folder = synced.index.folders.find(f => f.id === id);
        if (folder) {
            folder.thumbnailFile = thumbnailFile;
        }
    }
    await writeSyncedIndex(userDataRoot, synced);
}

/**
 * Renames or updates a virtual folder.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @param {{name?: string, thumbnailFile?: string}} updates
 * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
 */
export async function updateFolder(userDataRoot, folderId, updates) {
    const synced = await readSyncedIndex(userDataRoot);
    const folder = synced.index.folders.find(f => f.id === folderId);
    if (!folder) throw new Error(`Folder '${folderId}' not found.`);
    if (updates.name !== undefined) folder.name = updates.name;
    if (updates.thumbnailFile !== undefined) folder.thumbnailFile = updates.thumbnailFile;
    await writeSyncedIndex(userDataRoot, synced);
    return /** @type {{id: string, name: string, thumbnailFile: string}} */ (folder);
}

/**
 * Deletes a virtual folder and removes its ID from all images.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @returns {Promise<void>}
 */
export async function deleteFolder(userDataRoot, folderId) {
    const synced = await readSyncedIndex(userDataRoot);
    const idx = synced.index.folders.findIndex(f => f.id === folderId);
    if (idx === -1) throw new Error(`Folder '${folderId}' not found.`);
    synced.index.folders.splice(idx, 1);
    for (const entry of Object.values(synced.index.images)) {
        entry.folderIds = entry.folderIds.filter(id => id !== folderId);
    }
    await writeSyncedIndex(userDataRoot, synced);
}

/**
 * Assigns images to a folder.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @param {string[]} relativePaths
 * @returns {Promise<void>}
 */
export async function assignImagesToFolder(userDataRoot, folderId, relativePaths) {
    const synced = await readSyncedIndex(userDataRoot);
    if (!synced.index.folders.some(f => f.id === folderId)) {
        throw new Error(`Folder '${folderId}' not found.`);
    }
    for (const rp of relativePaths) {
        const posixPath = toPosix(rp);

        // Validate: must be a backgrounds/ path, and no path-traversal segments
        const normalized = path.posix.normalize(posixPath);
        if (!normalized.startsWith('backgrounds/') || normalized.split('/').some(seg => seg === '..')) {
            throw new Error(`Invalid background path: '${posixPath}'`);
        }

        // Validate: skip silently on missing files
        const absPath = path.join(userDataRoot, normalized);
        let stats;
        try {
            stats = await fs.stat(absPath);
        } catch {
            console.warn(`[ImageMetadata] Skipping missing background file: '${posixPath}'`);
            continue;
        }

        let entry = synced.index.images[normalized];
        if (!entry) {
            entry = { addedTimestamp: addedTimestampOf(stats), folderIds: [] };
            synced.index.images[normalized] = entry;
        }
        if (!entry.folderIds.includes(folderId)) {
            entry.folderIds.push(folderId);
        }
    }
    await writeSyncedIndex(userDataRoot, synced);
}

/**
 * Unassigns images from a folder.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @param {string[]} relativePaths
 * @returns {Promise<void>}
 */
export async function unassignImagesFromFolder(userDataRoot, folderId, relativePaths) {
    const synced = await readSyncedIndex(userDataRoot);
    for (const rp of relativePaths) {
        const entry = synced.index.images[toPosix(rp)];
        if (!entry) continue;
        entry.folderIds = entry.folderIds.filter(id => id !== folderId);
    }
    await writeSyncedIndex(userDataRoot, synced);
}

export const router = express.Router();

function sendMetadataError(response, error) {
    if (error.code === 'IMAGE_METADATA_PRESERVED' || error.code === 'IMAGE_METADATA_READ_FAILED') return response.status(error.code === 'IMAGE_METADATA_PRESERVED' ? 409 : 500).json({ code: error.code, error: error.message });
    return response.status(500).json({ error: 'Internal server error.' });
}

/**
 * POST /api/image-metadata/folders/get
 * List all virtual folders.
 */
router.post('/folders/get', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        return response.json(index.folders || []);
    } catch (error) {
        console.error('[ImageMetadata] Folders list error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/folders/create
 * Create a new folder. Body: { name: string }
 */
router.post('/folders/create', async function (request, response) {
    try {
        const { name } = request.body;
        if (!name || typeof name !== 'string') {
            return response.status(400).json({ error: '"name" is required.' });
        }
        const folder = await createFolder(request.user.directories.root, name.trim());
        return response.json(folder);
    } catch (error) {
        console.error('[ImageMetadata] Folder create error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/folders/set-thumbnails
 * Batch-set thumbnail files for multiple folders in one write. Body: { updates: [{id, thumbnailFile}] }
 */
router.post('/folders/set-thumbnails', async function (request, response) {
    try {
        const { updates } = request.body;
        if (!Array.isArray(updates) || updates.some(u => !u.id || typeof u.thumbnailFile !== 'string')) {
            return response.status(400).json({ error: '"updates" must be an array of {id, thumbnailFile}.' });
        }
        await setFolderThumbnailsBatch(request.user.directories.root, updates);
        return response.json({ ok: true });
    } catch (error) {
        console.error('[ImageMetadata] Folder set-thumbnails error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/folders/update
 * Update a folder. Body: { id: string, name?: string, thumbnailFile?: string }
 */
router.post('/folders/update', async function (request, response) {
    try {
        const { id, ...updates } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        const folder = await updateFolder(request.user.directories.root, id, updates);
        return response.json(folder);
    } catch (error) {
        if (error.message.includes('not found')) {
            return response.status(404).json({ error: error.message });
        }
        console.error('[ImageMetadata] Folder update error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/folders/delete
 * Delete a folder and unassign all images. Body: { id: string }
 */
router.post('/folders/delete', async function (request, response) {
    try {
        const { id } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        await deleteFolder(request.user.directories.root, id);
        return response.json({ ok: true });
    } catch (error) {
        if (error.message.includes('not found')) {
            return response.status(404).json({ error: error.message });
        }
        console.error('[ImageMetadata] Folder delete error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/folders/assign
 * Assign images to a folder. Body: { id: string, paths: string[] }
 */
router.post('/folders/assign', async function (request, response) {
    try {
        const { id, paths } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        if (!Array.isArray(paths)) {
            return response.status(400).json({ error: '"paths" array is required.' });
        }
        await assignImagesToFolder(request.user.directories.root, id, paths);
        return response.json({ ok: true });
    } catch (error) {
        if (error.message.includes('not found')) {
            return response.status(404).json({ error: error.message });
        }
        console.error('[ImageMetadata] Folder assign error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/folders/unassign
 * Unassign images from a folder. Body: { id: string, paths: string[] }
 */
router.post('/folders/unassign', async function (request, response) {
    try {
        const { id, paths } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        if (!Array.isArray(paths)) {
            return response.status(400).json({ error: '"paths" array is required.' });
        }
        await unassignImagesFromFolder(request.user.directories.root, id, paths);
        return response.json({ ok: true });
    } catch (error) {
        console.error('[ImageMetadata] Folder unassign error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata
 * Get metadata for image(s) by path.
 */
router.post('/', async function (request, response) {
    try {
        const { path: singlePath, paths, type } = request.body;

        if (!singlePath && !paths) {
            return response.status(400).json({ error: 'Either "path" or "paths" is required.' });
        }

        const userDataRoot = request.user.directories.root;

        // Helper to validate a path is under user data directory
        const validatePath = (relativePath) => {
            const fullPath = path.resolve(userDataRoot, relativePath);
            if (!isPathUnderParent(userDataRoot, fullPath)) {
                throw new Error(`Path "${relativePath}" is outside the user data directory.`);
            }
            return relativePath;
        };

        // Handle single path
        if (singlePath && !paths) {
            const relativePath = validatePath(singlePath);
            const fullPath = path.join(userDataRoot, relativePath);

            try {
                await fs.access(fullPath);
            } catch {
                return response.status(404).json({ error: 'File not found.' });
            }

            const { results: metadataResults } = await getOrGenerateMetadataBatch(userDataRoot, [relativePath], type);
            const metadata = metadataResults[relativePath];

            if (!metadata) {
                return response.status(404).json({ error: 'Could not generate metadata for file.' });
            }

            return response.json(metadata);
        }

        // Handle multiple paths
        if (paths && Array.isArray(paths)) {
            /** @type {Object.<string, ImageMetadata|{error: string}>} */
            const results = {};
            const validPaths = [];

            // Validate all paths first
            for (const relativePath of paths) {
                try {
                    validatePath(relativePath);
                    validPaths.push(relativePath);
                } catch (error) {
                    results[relativePath] = { error: error.message };
                }
            }

            // Process all valid paths in a single batch
            const { results: batchMetadata } = await getOrGenerateMetadataBatch(userDataRoot, validPaths, type);

            for (const relativePath of validPaths) {
                if (batchMetadata[relativePath]) {
                    results[relativePath] = batchMetadata[relativePath];
                } else {
                    results[relativePath] = { error: 'File not found or could not process.' };
                }
            }

            return response.json(results);
        }

        return response.status(400).json({ error: 'Invalid request format.' });
    } catch (error) {
        console.error('[ImageMetadata] API error:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/all
 * Get all metadata from the index.
 * @body {string} [prefix] - Optional path prefix to filter results
 */
router.post('/all', async function (request, response) {
    try {
        const userDataRoot = request.user.directories.root;
        const prefix = String(request.body.prefix || '');
        const index = await readMetadataIndex(userDataRoot);

        // If prefix specified, filter to only matching paths
        if (prefix) {
            const filteredImages = {};
            for (const [key, value] of Object.entries(index.images)) {
                if (key.startsWith(prefix)) {
                    filteredImages[key] = value;
                }
            }
            return response.json({ version: index.version, images: filteredImages });
        }

        return response.json(index);
    } catch (error) {
        console.error('[ImageMetadata] Failed to read metadata index:', error);
        return sendMetadataError(response, error);
    }
});

/**
 * POST /api/image-metadata/cleanup
 * Clean up orphaned metadata entries (files that no longer exist).
 */
router.post('/cleanup', async function (request, response) {
    try {
        const userDataRoot = request.user.directories.root;
        const removed = await cleanupOrphanedMetadata(userDataRoot);
        return response.json({ removed, count: removed.length });
    } catch (error) {
        console.error('[ImageMetadata] Cleanup error:', error);
        if (error.code === 'IMAGE_METADATA_PRESERVED') return response.status(409).json({ code: error.code, error: error.message, preserved: true, removed: error.removed });
        return response.status(500).json({ error: 'Internal server error.' });
    }
});
