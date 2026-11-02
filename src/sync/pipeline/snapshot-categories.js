import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { getShadowPaths } from '../shadow.js';

/**
 * Which categories the last snapshot for a backend covered, and per
 * category the last `main` commit live data was known to equal while that
 * category was enabled. A category in the current selection but not in
 * `categories` was enabled since then; its sync point is the base for
 * bringing its live files forward to `main`. A version 1 record predates
 * sync points and reads with none, so a category it lists as disabled
 * seeds from a null base once, the first time it is enabled again; the
 * snapshot that follows gives it a sync point.
 */
export const SNAPSHOT_CATEGORIES_FILENAME = 'snapshot-categories.json';
const RECORD_VERSION = 2;
const RECORD_VERSION_WITHOUT_SYNC_POINTS = 1;
const OID_PATTERN = /^[a-f0-9]{40}$/;

/** @typedef {{ categories: string[], syncedAt: Record<string, string> }} SnapshotCategoryRecord */

const isCategoryList = value => Array.isArray(value) && value.every(id => typeof id === 'string');
const isSyncPointMap = value => !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(oid => OID_PATTERN.test(String(oid)));

/**
 * @param {{ userRoot: string, backendId: string }} args
 * @returns {string}
 */
export function snapshotCategoriesPath({ userRoot, backendId }) {
    return path.join(getShadowPaths({ userRoot, peerId: backendId }).peerDir, SNAPSHOT_CATEGORIES_FILENAME);
}

/**
 * @param {{ userRoot: string, backendId: string }} args
 * @returns {SnapshotCategoryRecord | null}
 */
export function readSnapshotCategories({ userRoot, backendId }) {
    const file = snapshotCategoriesPath({ userRoot, backendId });
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const parsed = JSON.parse(raw);
    const legacy = parsed?.version === RECORD_VERSION_WITHOUT_SYNC_POINTS;
    const syncPointsOk = legacy || (parsed?.version === RECORD_VERSION && isSyncPointMap(parsed.syncedAt));
    if (!parsed || !syncPointsOk || !isCategoryList(parsed.categories)) {
        throw new Error(`snapshot category record at ${file} has an unexpected shape`);
    }
    return { categories: parsed.categories, syncedAt: legacy ? {} : { ...parsed.syncedAt } };
}

/**
 * @param {{ userRoot: string, backendId: string, categories: string[], syncedAt: Record<string, string> }} args
 */
export async function writeSnapshotCategories({ userRoot, backendId, categories, syncedAt }) {
    if (!isCategoryList(categories)) throw new TypeError(`snapshot category record: invalid categories ${JSON.stringify(categories)}`);
    if (!isSyncPointMap(syncedAt)) throw new TypeError(`snapshot category record: invalid sync points ${JSON.stringify(syncedAt)}`);
    const file = snapshotCategoriesPath({ userRoot, backendId });
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const body = { version: RECORD_VERSION, categories: [...categories], syncedAt: { ...syncedAt } };
    await writeFileAtomic(file, JSON.stringify(body), { encoding: 'utf8' });
}

/**
 * Set the sync point of `categories` to `oid`. Without a record there is
 * no snapshot to compare a later selection against, so nothing is written.
 *
 * @param {{ userRoot: string, backendId: string, categories: string[], oid: string }} args
 */
export async function markCategoriesSynced({ userRoot, backendId, categories, oid }) {
    const record = readSnapshotCategories({ userRoot, backendId });
    if (!record) return;
    const syncedAt = { ...record.syncedAt };
    for (const id of categories) syncedAt[id] = oid;
    await writeSnapshotCategories({ userRoot, backendId, categories: record.categories, syncedAt });
}
