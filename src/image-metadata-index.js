/**
 * Format of the synced image metadata index, `image-metadata.json`.
 *
 * The synced file holds only what a user decides: the virtual folders,
 * the folders each image belongs to, and when an image was first added.
 * Everything derived from the local image file lives in a separate
 * device-local cache (`src/endpoints/image-metadata.js`).
 *
 * Version 1 files mixed both; reading one keeps only the synced fields.
 * Serialization is deterministic: image keys sorted, fixed field order,
 * so equal content always gives equal bytes on every device.
 */

export const IMAGE_METADATA_VERSION = 2;

/** Fields of a version 1 entry that belong to the device-local cache. */
export const IMAGE_CACHE_FIELDS = Object.freeze(['hash', 'aspectRatio', 'isAnimated', 'dominantColor', 'thumbnailResolution', 'mtime']);

/**
 * @typedef {{ addedTimestamp?: number, folderIds: string[] }} SyncedImageEntry
 * @typedef {{ id: string, name?: string, thumbnailFile?: string }} SyncedFolder
 * @typedef {{ version: number, images: Record<string, SyncedImageEntry>, folders: SyncedFolder[] }} SyncedImageIndex
 */

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** @returns {SyncedImageIndex} */
export function emptyImageMetadataIndex() {
    return { version: IMAGE_METADATA_VERSION, images: {}, folders: [] };
}

/**
 * @param {unknown} ids
 * @returns {string[]} the string ids, without repeats, sorted
 */
export function normalizeFolderIds(ids) {
    return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))].sort() : [];
}

/**
 * @param {unknown} entry
 * @returns {SyncedImageEntry}
 */
function normalizeEntry(entry) {
    const out = {};
    if (isObject(entry) && Number.isFinite(entry.addedTimestamp)) out.addedTimestamp = entry.addedTimestamp;
    out.folderIds = normalizeFolderIds(isObject(entry) ? entry.folderIds : undefined);
    return out;
}

/**
 * A folder with `id`, `name` and `thumbnailFile` first, then any other
 * field in key order.
 *
 * @param {object} folder
 * @returns {SyncedFolder}
 */
function normalizeFolder(folder) {
    const known = ['id', 'name', 'thumbnailFile'];
    const keys = [...known.filter(key => Object.hasOwn(folder, key)), ...Object.keys(folder).filter(key => !known.includes(key)).sort()];
    return Object.fromEntries(keys.map(key => [key, folder[key]]));
}

/**
 * The synced part of an index of any version. A value that is not an
 * object reads as an empty index.
 *
 * @param {unknown} doc
 * @returns {SyncedImageIndex}
 */
export function normalizeImageMetadataIndex(doc) {
    const out = emptyImageMetadataIndex();
    if (!isObject(doc)) return out;
    if (isObject(doc.images)) {
        out.images = Object.fromEntries(Object.keys(doc.images).sort().map(key => [key, normalizeEntry(doc.images[key])]));
    }
    if (Array.isArray(doc.folders)) {
        const seen = new Set();
        for (const folder of doc.folders) {
            if (!isObject(folder) || typeof folder.id !== 'string' || seen.has(folder.id)) continue;
            seen.add(folder.id);
            out.folders.push(normalizeFolder(folder));
        }
    }
    return out;
}

/**
 * The cache fields a version 1 index stored per image.
 *
 * @param {unknown} doc
 * @returns {Record<string, object>}
 */
export function legacyCacheEntries(doc) {
    const out = {};
    if (!isObject(doc) || !isObject(doc.images)) return out;
    for (const [key, entry] of Object.entries(doc.images)) {
        if (!isObject(entry)) continue;
        const fields = IMAGE_CACHE_FIELDS.filter(field => Object.hasOwn(entry, field));
        if (fields.length > 0) out[key] = Object.fromEntries(fields.map(field => [field, entry[field]]));
    }
    return out;
}

/**
 * @param {unknown} doc
 * @returns {string} the normalized index as written to disk
 */
export function serializeImageMetadataIndex(doc) {
    return JSON.stringify(normalizeImageMetadataIndex(doc), null, 4);
}
