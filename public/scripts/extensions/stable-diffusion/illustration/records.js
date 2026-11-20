import { buildFailedTag, buildImageTag, ILLUSTRATION_ATTRIBUTE, insertTagsAtAnchors, replaceIllustrationMarkup } from './message.js';

const FAILED_RECORDS_KEY = 'failedIllustrations';

function clonePlainArray(value) {
    return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
}

function isFailedRecord(record) {
    return Boolean(record) && record.status === 'failed';
}

/**
 * Failed illustrations are session-only. They live on a non-enumerable
 * property so every clone and persistence path drops them automatically,
 * while the live message keeps enough data to render the failure badge.
 * @param {object} message
 * @param {{ create?: boolean }} [options]
 * @returns {Array<object>|null}
 */
function getFailedStore(message, { create = false } = {}) {
    const extra = message?.extra;
    if (!extra || typeof extra !== 'object') {
        return null;
    }
    if (!Object.prototype.hasOwnProperty.call(extra, FAILED_RECORDS_KEY)) {
        if (!create) {
            return null;
        }
        Object.defineProperty(extra, FAILED_RECORDS_KEY, {
            value: [],
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return Array.isArray(extra[FAILED_RECORDS_KEY]) ? extra[FAILED_RECORDS_KEY] : null;
}

export function getFailedIllustrationRecords(message) {
    return [...(getFailedStore(message) || [])];
}

export function clearFailedIllustrationRecords(message) {
    const extra = message?.extra;
    if (!extra || typeof extra !== 'object' || !Object.prototype.hasOwnProperty.call(extra, FAILED_RECORDS_KEY)) {
        return [];
    }
    const removed = Array.isArray(extra[FAILED_RECORDS_KEY]) ? extra[FAILED_RECORDS_KEY].slice() : [];
    delete extra[FAILED_RECORDS_KEY];
    return removed;
}

export function createIllustrationRecord({
    id,
    prompt,
    negativePrompt = '',
    aspectRatio = '',
    references = [],
    characterPrompts = [],
    locked = false,
    imageUrl = '',
    status = 'ready',
    error = '',
    parentId = null,
    anchorAfter = '',
    anchorBefore = '',
    loras = [],
    createdAt = Date.now(),
}) {
    return {
        id: String(id),
        prompt: String(prompt || ''),
        negativePrompt: String(negativePrompt || ''),
        aspectRatio: String(aspectRatio || ''),
        references: clonePlainArray(references),
        characterPrompts: clonePlainArray(characterPrompts),
        locked: Boolean(locked),
        imageUrl: String(imageUrl || ''),
        status: status === 'failed' ? 'failed' : 'ready',
        error: String(error || ''),
        parentId: parentId ? String(parentId) : null,
        anchorAfter: String(anchorAfter || ''),
        anchorBefore: String(anchorBefore || ''),
        loras: clonePlainArray(loras),
        createdAt,
    };
}

function listRecords(message) {
    const persisted = Array.isArray(message?.extra?.illustrations) ? message.extra.illustrations : [];
    const failed = getFailedStore(message);
    return failed?.length ? [...persisted, ...failed] : persisted;
}

export function getIllustrationRecord(message, id) {
    const target = String(id || '');
    return listRecords(message).find(record => record.id === target) || null;
}

/**
 * Collects the full version tree (ancestors + descendants) belonging to the same slot root as `record`.
 * Ordered chronologically so switching to an earlier version never hides newer versions.
 */
export function collectVersionTree(message, record) {
    const records = listRecords(message).filter(candidate => !isFailedRecord(candidate));
    if (!record || isFailedRecord(record) || records.length === 0) {
        return [];
    }
    const byId = new Map(records.map(r => [r.id, r]));
    let root = record;
    const climbSeen = new Set([root.id]);
    while (root.parentId && byId.has(root.parentId) && !climbSeen.has(root.parentId)) {
        climbSeen.add(root.parentId);
        root = byId.get(root.parentId);
    }

    const collected = [];
    const queue = [root];
    const visited = new Set([root.id]);
    while (queue.length > 0) {
        const current = queue.shift();
        collected.push(current);
        for (const candidate of records) {
            if (candidate.parentId === current.id && !visited.has(candidate.id)) {
                visited.add(candidate.id);
                queue.push(candidate);
            }
        }
    }

    return collected.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
}

export function switchMessageIllustrationVersion({
    message,
    fromId,
    toId,
    imageDisplayWidth,
    ensureSwipes,
}) {
    if (!message || !fromId || !toId) {
        return false;
    }
    const target = getIllustrationRecord(message, toId);
    if (!target || isFailedRecord(target)) {
        return false;
    }
    const html = buildImageTag({
        id: target.id,
        imageUrl: target.imageUrl,
        prompt: target.prompt,
        width: imageDisplayWidth,
    });
    const nextMes = replaceIllustrationMarkup(String(message.mes || ''), fromId, html);
    if (nextMes === message.mes && fromId !== toId) {
        return false;
    }
    message.mes = nextMes;
    syncMessageSwipeData(message, ensureSwipes);
    return true;
}

export function appendIllustrationRecords(message, records) {
    if (!message) {
        return;
    }
    if (!message.extra) {
        message.extra = {};
    }
    for (const record of Array.isArray(records) ? records : []) {
        if (!record) {
            continue;
        }
        if (isFailedRecord(record)) {
            getFailedStore(message, { create: true })?.push(record);
            continue;
        }
        if (!Array.isArray(message.extra.illustrations)) {
            message.extra.illustrations = [];
        }
        message.extra.illustrations.push(record);
    }
}

export function removeIllustrationRecord(message, id) {
    const target = String(id || '');
    if (!target) {
        return [];
    }
    const persisted = Array.isArray(message?.extra?.illustrations) ? message.extra.illustrations : [];
    const failed = getFailedStore(message) || [];
    const stores = [persisted, failed];
    if (!stores.some(store => store.some(record => record.id === target))) {
        return [];
    }
    const removed = [];
    const pending = [target];
    const seen = new Set();
    while (pending.length > 0) {
        const current = pending.shift();
        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        for (const store of stores) {
            const index = store.findIndex(record => record.id === current);
            if (index >= 0) {
                removed.push(store[index]);
                store.splice(index, 1);
            }
        }
        for (const store of stores) {
            for (const record of store) {
                if (record.parentId === current) {
                    pending.push(record.id);
                }
            }
        }
    }
    return removed;
}

export function syncMessageSwipeData(message, ensureSwipes) {
    if (typeof ensureSwipes === 'function') {
        ensureSwipes(message);
    }
    if (Number.isInteger(message?.swipe_id) && Array.isArray(message.swipes) && Array.isArray(message.swipe_info)) {
        message.swipes[message.swipe_id] = message.mes;
        if (message.swipe_info[message.swipe_id]) {
            message.swipe_info[message.swipe_id].extra = JSON.parse(JSON.stringify(message.extra ?? {}));
        }
    }
}

/**
 * Drop records copied into a freshly generated swipe slot.
 * @param {object} message
 * @returns {Array<object>} removed records
 */
export function clearSwipeIllustrationRecords(message) {
    const persisted = Array.isArray(message?.extra?.illustrations) ? message.extra.illustrations.slice() : [];
    const removed = [...persisted, ...clearFailedIllustrationRecords(message)];
    if (removed.length === 0) {
        return [];
    }
    delete message.extra.illustrations;
    const swipeId = message.swipe_id;
    if (Number.isInteger(swipeId) && Array.isArray(message.swipe_info) && message.swipe_info[swipeId]) {
        message.swipe_info[swipeId].extra = JSON.parse(JSON.stringify(message.extra ?? {}));
    }
    return removed;
}

export function applyIllustrationResult({
    message,
    records,
    imageDisplayWidth,
    ensureSwipes,
}) {
    // A fresh batch supersedes failures left over from earlier attempts.
    clearFailedIllustrationRecords(message);
    const list = Array.isArray(records) ? records : [];
    const placements = list.filter(record => !isFailedRecord(record)).map(record => ({
        id: record.id,
        html: buildImageTag({
            id: record.id,
            imageUrl: record.imageUrl,
            prompt: record.prompt,
            width: imageDisplayWidth,
        }),
        insertAfter: record.anchorAfter,
        insertBefore: record.anchorBefore,
    }));

    const result = insertTagsAtAnchors(String(message.mes || ''), placements);
    message.mes = result.text;
    appendIllustrationRecords(message, list);
    syncMessageSwipeData(message, ensureSwipes);
    return result;
}

/**
 * Render session-only failure badges for a message. Used by the formatter
 * hook so failed attempts never enter message text or the chat file.
 * @param {string} mes Rendered message text at the current formatting stage.
 * @param {object} message Live chat message.
 * @param {{ failedLabel?: string }} [options]
 * @returns {string}
 */
export function renderFailedIllustrationMarkup(mes, message, { failedLabel = 'Image generation failed' } = {}) {
    const failed = getFailedStore(message);
    if (!failed || failed.length === 0) {
        return mes;
    }
    const text = String(mes ?? '');
    const placements = [];
    for (const record of failed) {
        if (!record?.id || text.includes(`${ILLUSTRATION_ATTRIBUTE}="${record.id}"`)) {
            continue;
        }
        placements.push({
            id: record.id,
            html: buildFailedTag({
                id: record.id,
                prompt: record.prompt,
                error: record.error,
                label: failedLabel,
            }),
            insertAfter: record.anchorAfter,
            insertBefore: record.anchorBefore,
        });
    }
    if (placements.length === 0) {
        return text;
    }
    return insertTagsAtAnchors(text, placements).text;
}
