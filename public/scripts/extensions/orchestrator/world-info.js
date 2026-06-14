/**
 * World-info payload helpers for the orchestrator.
 *
 * Pure utilities — no chat-state, no `extension_settings`. Two distinct
 * concerns share this module because they both shape the world-info
 * portion of a generation payload:
 *
 *   1. Append helpers used while assembling the runtime payload that
 *      goes to the LLM (`normalizeWorldInfoEntries`,
 *      `ensureWorldInfoEntries`, `appendUniqueWorldInfoBlock`,
 *      `appendUniqueNoteEntry`, `appendUniqueWorldInfoExample`). They
 *      enforce de-duplication so the same entry is never injected twice.
 *
 *   2. Runtime world-info snapshot helpers used by the orchestration
 *      simulation pipeline (`normalizeRuntimeWorldInfo`,
 *      `hasEffectiveRuntimeWorldInfo`, `buildRuntimeWorldInfoFromPayload`,
 *      `normalizeWorldInfoResolverMessages`, `rewriteDepthWorldInfoToAfter`).
 *      The depth→after rewrite collapses depth-positioned entries into
 *      after-anchor entries so callers that don't honor depth still see
 *      the content.
 *
 * The capsule-injection counterpart (`injectCapsuleToPayload`) lives in
 * `capsule-injection.js` and consumes the append helpers from this
 * module by import.
 */

const wi_anchor_position = Luker.getContext().constants.wiAnchor;

export function normalizeWorldInfoEntries(rawEntries) {
    return Array.isArray(rawEntries)
        ? rawEntries.map(entry => String(entry ?? '').trim()).filter(Boolean)
        : [];
}

export function ensureWorldInfoEntries(payload, field) {
    const entryField = `${field}Entries`;
    const entries = normalizeWorldInfoEntries(payload?.[entryField]);
    payload[entryField] = entries;
    return entries;
}

export function appendUniqueWorldInfoBlock(payload, field, block) {
    const incoming = String(block || '').trim();
    if (!incoming) {
        return false;
    }

    const entries = ensureWorldInfoEntries(payload, field);
    if (entries.includes(incoming)) {
        return false;
    }

    entries.push(incoming);
    return true;
}

export function appendUniqueNoteEntry(targetList, block) {
    const incoming = String(block || '').trim();
    if (!incoming || !Array.isArray(targetList)) {
        return false;
    }
    if (targetList.includes(incoming)) {
        return false;
    }
    targetList.push(incoming);
    return true;
}

export function appendUniqueWorldInfoExample(payload, anchorPosition, block) {
    const incoming = String(block || '').trim();
    if (!incoming) {
        return false;
    }
    if (!Array.isArray(payload.worldInfoExamples)) {
        payload.worldInfoExamples = [];
    }
    const normalizedPosition = Number(anchorPosition) === Number(wi_anchor_position.before)
        ? wi_anchor_position.before
        : wi_anchor_position.after;
    if (payload.worldInfoExamples.some((entry) => (
        Number(entry?.position) === Number(normalizedPosition)
        && String(entry?.content || '').trim() === incoming
    ))) {
        return false;
    }
    payload.worldInfoExamples.push({
        position: normalizedPosition,
        content: incoming,
    });
    return true;
}

export function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
}

export function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (content) {
                blocks.push(content);
            }
        }
    }

    payload.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    for (const block of blocks) {
        appendUniqueWorldInfoBlock(payload, 'worldInfoAfter', block);
    }
    return payload;
}

export function normalizeRuntimeWorldInfo(runtimeWorldInfo = null) {
    const source = runtimeWorldInfo && typeof runtimeWorldInfo === 'object' ? runtimeWorldInfo : {};
    return {
        worldInfoBeforeEntries: normalizeWorldInfoEntries(source.worldInfoBeforeEntries),
        worldInfoAfterEntries: normalizeWorldInfoEntries(source.worldInfoAfterEntries),
        worldInfoDepth: Array.isArray(source.worldInfoDepth) ? source.worldInfoDepth : [],
        outletEntries: source.outletEntries && typeof source.outletEntries === 'object' ? source.outletEntries : {},
        worldInfoExamples: Array.isArray(source.worldInfoExamples) ? source.worldInfoExamples : [],
        anBefore: Array.isArray(source.anBefore) ? source.anBefore : [],
        anAfter: Array.isArray(source.anAfter) ? source.anAfter : [],
    };
}

export function hasEffectiveRuntimeWorldInfo(runtimeWorldInfo = null) {
    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    if (normalized.worldInfoBeforeEntries.length > 0 || normalized.worldInfoAfterEntries.length > 0) {
        return true;
    }
    if (normalized.worldInfoDepth.length > 0 || normalized.worldInfoExamples.length > 0) {
        return true;
    }
    if (normalized.anBefore.length > 0 || normalized.anAfter.length > 0) {
        return true;
    }
    return Object.keys(normalized.outletEntries).length > 0;
}

export function buildRuntimeWorldInfoFromPayload(payload = null) {
    const candidate = normalizeRuntimeWorldInfo({
        worldInfoBeforeEntries: Array.isArray(payload?.worldInfoBeforeEntries) ? payload.worldInfoBeforeEntries : [],
        worldInfoAfterEntries: Array.isArray(payload?.worldInfoAfterEntries) ? payload.worldInfoAfterEntries : [],
        worldInfoDepth: Array.isArray(payload?.worldInfoDepth) ? payload.worldInfoDepth : [],
        outletEntries: payload?.outletEntries && typeof payload.outletEntries === 'object' ? payload.outletEntries : {},
        worldInfoExamples: Array.isArray(payload?.worldInfoExamples) ? payload.worldInfoExamples : [],
        anBefore: Array.isArray(payload?.anBefore) ? payload.anBefore : [],
        anAfter: Array.isArray(payload?.anAfter) ? payload.anAfter : [],
    });
    const rewritten = normalizeRuntimeWorldInfo(rewriteDepthWorldInfoToAfter({
        ...candidate,
        worldInfoDepth: Array.isArray(candidate.worldInfoDepth)
            ? candidate.worldInfoDepth.map(entry => ({
                ...entry,
                entries: Array.isArray(entry?.entries) ? entry.entries.slice() : [],
            }))
            : [],
    }));
    return hasEffectiveRuntimeWorldInfo(rewritten) ? rewritten : null;
}
