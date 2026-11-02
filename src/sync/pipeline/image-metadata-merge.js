import { isDeepStrictEqual } from 'node:util';

import { normalizeFolderIds, normalizeImageMetadataIndex } from '../../image-metadata-index.js';

export const IMAGE_METADATA_PATH = 'image-metadata.json';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** The side that changed a value from base, ours when both agree; `conflicted` when both changed it differently. */
function pick3(b, o, t) {
    if (isDeepStrictEqual(o, t)) return { value: o, conflicted: false };
    if (isDeepStrictEqual(o, b)) return { value: t, conflicted: false };
    if (isDeepStrictEqual(t, b)) return { value: o, conflicted: false };
    return { value: o, conflicted: true };
}

/**
 * Three-way merge of keyed items, `undefined` meaning absent. An item one
 * side removed from base is removed when the other side left it as base
 * had it, by `sameAsBase`; when the other side changed it, the changed
 * item is kept and the merge is `conflicted`. Items both sides hold merge
 * with `mergeBoth`.
 */
function mergeKeyed(keys, b, o, t, mergeBoth, sameAsBase = isDeepStrictEqual) {
    let conflicted = false;
    const out = [];
    for (const key of keys) {
        const [bv, ov, tv] = [b.get(key), o.get(key), t.get(key)];
        if (ov !== undefined && tv !== undefined) {
            const merged = mergeBoth(bv, ov, tv);
            conflicted ||= merged.conflicted;
            out.push([key, merged.value]);
        } else if (bv === undefined) {
            out.push([key, ov ?? tv]);
        } else {
            const kept = ov ?? tv;
            if (kept !== undefined && !sameAsBase(kept, bv)) {
                conflicted = true;
                out.push([key, kept]);
            }
        }
    }
    return { entries: out, conflicted };
}

function mergeFolder(b, o, t) {
    let conflicted = false;
    const out = [];
    for (const key of [...new Set([...Object.keys(o), ...Object.keys(t)])]) {
        const picked = pick3(b?.[key], Object.hasOwn(o, key) ? o[key] : undefined, Object.hasOwn(t, key) ? t[key] : undefined);
        conflicted ||= picked.conflicted;
        if (picked.value !== undefined) out.push([key, picked.value]);
    }
    return { value: Object.fromEntries(out), conflicted };
}

/** An image absent from base counts as added with no folders. */
function mergeImage(b, o, t) {
    const times = [o.addedTimestamp, t.addedTimestamp].filter(Number.isFinite);
    const folderIds = pick3(b?.folderIds ?? [], o.folderIds, t.folderIds);
    const value = times.length > 0 ? { addedTimestamp: Math.min(...times), folderIds: folderIds.value } : { folderIds: folderIds.value };
    return { value, conflicted: folderIds.conflicted };
}

/**
 * Three-way merge of `image-metadata.json`. Each side is read as its
 * synced fields only (`normalizeImageMetadataIndex`), so a version 1 side
 * merges without its device-local cache fields. Images union by path and
 * folders by id, ours' folder order first. `addedTimestamp` takes the
 * earlier value: two devices that each first saw an image record their
 * own time. `folderIds` and every folder field merge three-way; a value
 * both sides changed differently keeps ours and sets `conflicted`, as
 * does an item one side removed and the other changed; for an image only
 * a change of its folders counts. Assignments to a
 * folder the merge removed are dropped. Ours is the side with the smaller
 * head on both devices, so both write the same bytes.
 *
 * @param {unknown} base
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {{ value: import('../../image-metadata-index.js').SyncedImageIndex, conflicted: boolean } | null} null when ours or theirs is not an object
 */
export function mergeImageMetadataDocuments(base, ours, theirs) {
    if (!isObject(ours) || !isObject(theirs)) return null;
    const [b, o, t] = [base, ours, theirs].map(normalizeImageMetadataIndex);
    const foldersOf = doc => new Map(doc.folders.map(folder => [folder.id, folder]));
    const imagesOf = doc => new Map(Object.entries(doc.images));
    const [bf, of, tf] = [b, o, t].map(foldersOf);
    const folders = mergeKeyed([...new Set([...of.keys(), ...tf.keys()])], bf, of, tf, mergeFolder);
    const [bi, oi, ti] = [b, o, t].map(imagesOf);
    // The added time is not a user change, so a removal wins over it.
    const sameFolders = (entry, baseEntry) => isDeepStrictEqual(entry.folderIds, baseEntry.folderIds);
    const images = mergeKeyed([...new Set([...oi.keys(), ...ti.keys()])].sort(), bi, oi, ti, mergeImage, sameFolders);
    const kept = new Set(folders.entries.map(([id]) => id));
    const removed = id => !kept.has(id) && (bf.has(id) || of.has(id) || tf.has(id));
    const value = normalizeImageMetadataIndex({
        images: Object.fromEntries(images.entries.map(([key, entry]) => [key, { ...entry, folderIds: normalizeFolderIds(entry.folderIds).filter(id => !removed(id)) }])),
        folders: folders.entries.map(([, folder]) => folder),
    });
    return { value, conflicted: folders.conflicted || images.conflicted };
}
