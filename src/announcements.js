// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import crypto from 'node:crypto';

import storage from 'node-persist';

export const ANNOUNCEMENTS_STORAGE_KEY = 'luker:announcements:v1';
export const ANNOUNCEMENT_LEVELS = Object.freeze(['info', 'warning', 'critical']);
export const ANNOUNCEMENT_TITLE_MAX = 200;
export const ANNOUNCEMENT_BODY_MAX = 10000;

/**
 * @typedef {Object} Announcement
 * @property {string} id
 * @property {'info'|'warning'|'critical'} level
 * @property {string} title
 * @property {string} body
 * @property {number} createdAt
 * @property {string} createdBy
 * @property {number} [updatedAt]
 */

/**
 * @typedef {Object} StorageLike
 * @property {(key: string) => Promise<any>} getItem
 * @property {(key: string, value: any) => Promise<any>} setItem
 */

/**
 * @returns {StorageLike}
 */
function defaultStorage() {
    return storage;
}

function isPlainString(value) {
    return typeof value === 'string';
}

function trimToString(value) {
    return isPlainString(value) ? value.trim() : '';
}

function isValidLevel(value) {
    return ANNOUNCEMENT_LEVELS.includes(value);
}

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AnnouncementValidationError';
    }
}

export { ValidationError };

/**
 * Serializes all read-modify-write operations across the announcements storage
 * key to avoid getItem/setItem interleaving when two admin requests race.
 */
let writeQueue = Promise.resolve();

function enqueueWrite(fn) {
    const next = writeQueue.then(fn, fn);
    writeQueue = next.catch(() => undefined);
    return next;
}

async function readItems(store) {
    const stored = await store.getItem(ANNOUNCEMENTS_STORAGE_KEY);
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.items)) {
        return [];
    }
    return stored.items.map((item) => ({ ...item }));
}

async function writeItems(store, items) {
    await store.setItem(ANNOUNCEMENTS_STORAGE_KEY, { items });
}

function validateLevel(level) {
    if (!isValidLevel(level)) {
        throw new ValidationError(`Invalid level: ${String(level)}. Must be one of ${ANNOUNCEMENT_LEVELS.join('/')}.`);
    }
}

function validateTitle(title) {
    const trimmed = trimToString(title);
    if (!trimmed) {
        throw new ValidationError('Title is required and must be non-empty.');
    }
    if (trimmed.length > ANNOUNCEMENT_TITLE_MAX) {
        throw new ValidationError(`Title exceeds ${ANNOUNCEMENT_TITLE_MAX} characters.`);
    }
    return trimmed;
}

function validateBody(body) {
    const trimmed = trimToString(body);
    if (!trimmed) {
        throw new ValidationError('Body is required and must be non-empty.');
    }
    if (trimmed.length > ANNOUNCEMENT_BODY_MAX) {
        throw new ValidationError(`Body exceeds ${ANNOUNCEMENT_BODY_MAX} characters.`);
    }
    return trimmed;
}

/**
 * Lists all announcements, ordered by createdAt desc.
 * @param {{ store?: StorageLike }} [options]
 * @returns {Promise<Announcement[]>}
 */
export async function listAnnouncements({ store = defaultStorage() } = {}) {
    const items = await readItems(store);
    return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Creates a new announcement.
 * @param {{ level: string, title: string, body: string, createdBy: string, store?: StorageLike, now?: () => number, id?: () => string }} input
 * @returns {Promise<Announcement>}
 */
export async function createAnnouncement({
    level,
    title,
    body,
    createdBy,
    store = defaultStorage(),
    now = () => Date.now(),
    id = () => crypto.randomUUID(),
}) {
    validateLevel(level);
    const cleanTitle = validateTitle(title);
    const cleanBody = validateBody(body);
    const cleanCreatedBy = trimToString(createdBy) || 'unknown';

    return enqueueWrite(async () => {
        const items = await readItems(store);
        const item = {
            id: id(),
            level,
            title: cleanTitle,
            body: cleanBody,
            createdAt: now(),
            createdBy: cleanCreatedBy,
        };
        items.push(item);
        await writeItems(store, items);
        return { ...item };
    });
}

/**
 * Updates an existing announcement.
 * Returns null if the id is not found.
 * @param {{ id: string, level?: string, title?: string, body?: string, store?: StorageLike, now?: () => number }} input
 * @returns {Promise<Announcement|null>}
 */
export async function updateAnnouncement({
    id,
    level,
    title,
    body,
    store = defaultStorage(),
    now = () => Date.now(),
}) {
    if (level !== undefined) validateLevel(level);
    const cleanTitle = title !== undefined ? validateTitle(title) : undefined;
    const cleanBody = body !== undefined ? validateBody(body) : undefined;

    return enqueueWrite(async () => {
        const items = await readItems(store);
        const idx = items.findIndex((x) => x.id === id);
        if (idx === -1) return null;
        const next = { ...items[idx] };
        if (level !== undefined) next.level = level;
        if (cleanTitle !== undefined) next.title = cleanTitle;
        if (cleanBody !== undefined) next.body = cleanBody;
        const nowValue = now();
        next.updatedAt = nowValue > (next.createdAt || 0) ? nowValue : (next.createdAt || 0) + 1;
        items[idx] = next;
        await writeItems(store, items);
        return { ...next };
    });
}

/**
 * Deletes an announcement by id. Returns true if removed, false if not found.
 * @param {{ id: string, store?: StorageLike }} input
 * @returns {Promise<boolean>}
 */
export async function deleteAnnouncement({ id, store = defaultStorage() }) {
    return enqueueWrite(async () => {
        const items = await readItems(store);
        const before = items.length;
        const filtered = items.filter((x) => x.id !== id);
        if (filtered.length === before) return false;
        await writeItems(store, filtered);
        return true;
    });
}

/**
 * Returns live announcements + the subset of `readIds` that still reference live items.
 * @param {{ readIds?: string[], store?: StorageLike }} input
 * @returns {Promise<{ items: Announcement[], readIds: string[] }>}
 */
export async function listForUser({ readIds = [], store = defaultStorage() } = {}) {
    const items = await listAnnouncements({ store });
    const liveIds = new Set(items.map((x) => x.id));
    const filtered = (Array.isArray(readIds) ? readIds : []).filter((x) => liveIds.has(x));
    return { items, readIds: filtered };
}

/**
 * Computes the new readAnnouncementIds for a user, given existing ids + ids to mark.
 * Pure function: does not touch user storage. Caller persists the result.
 * @param {{ existing?: string[], ids?: string[] }} input
 * @returns {string[]}
 */
export function mergeReadIds({ existing = [], ids = [] }) {
    const out = new Set(Array.isArray(existing) ? existing : []);
    for (const value of (Array.isArray(ids) ? ids : [])) {
        if (typeof value === 'string' && value) out.add(value);
    }
    return [...out];
}
