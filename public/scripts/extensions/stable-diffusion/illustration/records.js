import { buildFailedTag, buildImageTag, insertTagsAtAnchors, replaceIllustrationMarkup } from './message.js';

function clonePlainArray(value) {
    return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
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
    return Array.isArray(message?.extra?.illustrations) ? message.extra.illustrations : [];
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
    const records = listRecords(message);
    if (!record || records.length === 0) {
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
    failedLabel = 'Image generation failed',
}) {
    if (!message || !fromId || !toId) {
        return false;
    }
    const target = getIllustrationRecord(message, toId);
    if (!target) {
        return false;
    }
    const html = target.status === 'failed'
        ? buildFailedTag({ id: target.id, prompt: target.prompt, error: target.error, label: failedLabel })
        : buildImageTag({
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
 * Drop records copied into a freshly generated swipe slot.
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
