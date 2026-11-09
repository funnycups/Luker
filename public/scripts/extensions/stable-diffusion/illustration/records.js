import { buildFailedTag, buildImageTag, insertTagsAtAnchors } from './message.js';

export function createIllustrationRecord({
    id,
    prompt,
    imageUrl = '',
    status = 'ready',
    error = '',
    parentId = null,
    anchorAfter = '',
    anchorBefore = '',
    createdAt = Date.now(),
}) {
    return {
        id: String(id),
        prompt: String(prompt || ''),
        imageUrl: String(imageUrl || ''),
        status: status === 'failed' ? 'failed' : 'ready',
        error: String(error || ''),
        parentId: parentId ? String(parentId) : null,
        anchorAfter: String(anchorAfter || ''),
        anchorBefore: String(anchorBefore || ''),
        createdAt,
    };
}

function listRecords(message) {
    return Array.isArray(message?.extra?.illustrations) ? message.extra.illustrations : [];
}

export function getIllustrationRecord(message, id) {
    const target = String(id || '');
    return listRecords(message).find(record => record.id === target) || null;
}

export function appendIllustrationRecords(message, records) {
    if (!message.extra) {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.illustrations)) {
        message.extra.illustrations = [];
    }
    for (const record of Array.isArray(records) ? records : []) {
        message.extra.illustrations.push(record);
    }
}

export function removeIllustrationRecord(message, id) {
    const target = String(id || '');
    const records = listRecords(message);
    if (!target || !records.some(record => record.id === target)) {
        return [];
    }
    const removed = [];
    const pending = [target];
    while (pending.length > 0) {
        const current = pending.shift();
        const index = records.findIndex(record => record.id === current);
        if (index < 0) {
            continue;
        }
        removed.push(records[index]);
        records.splice(index, 1);
        for (const record of records) {
            if (record.parentId === current) {
                pending.push(record.id);
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
 * Drop records copied into a freshly generated swipe slot. Core seeds a new
 * swipe's extra from the active one, so the previous swipe's records would
 * otherwise suppress illustration work on the new swipe. The pending swipe
 * slot is not materialized yet, so this must not write into the swipes array.
 * @param {object} message
 * @returns {Array<object>} removed records
 */
export function clearSwipeIllustrationRecords(message) {
    const records = listRecords(message);
    if (records.length === 0) {
        return [];
    }
    const removed = records.splice(0, records.length);
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
    failedLabel,
}) {
    const placements = (Array.isArray(records) ? records : []).map(record => {
        const html = record.status === 'failed'
            ? buildFailedTag({ id: record.id, prompt: record.prompt, error: record.error, label: failedLabel })
            : buildImageTag({
                id: record.id,
                imageUrl: record.imageUrl,
                prompt: record.prompt,
                width: imageDisplayWidth,
            });
        return {
            id: record.id,
            html,
            insertAfter: record.anchorAfter,
            insertBefore: record.anchorBefore,
        };
    });

    const result = insertTagsAtAnchors(String(message.mes || ''), placements);
    message.mes = result.text;
    appendIllustrationRecords(message, records);
    syncMessageSwipeData(message, ensureSwipes);
    return result;
}
