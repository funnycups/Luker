// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Plugin-agnostic helpers backing iteration-library's lorebook read & write
 * tools. Owns the parsing, normalization, range/limit logic, and content
 * search used by `lorebook-reads.js` and `lorebook-writes.js`.
 *
 * Originated in `character-editor-assistant/main.js`. Lifted here so any
 * iter popup (orchestrator, memory-graph schema, CEA editor, CPA — present
 * or future) can run lorebook tools without `getExtensionApi('character-
 * editor-assistant')` and without re-implementing the parse/match logic.
 */

const QUERY_LIMIT_DEFAULT = 10;
const QUERY_LIMIT_MAX = 20;
const DETAIL_LIMIT_MAX = 10;
const MATCH_EXCERPT_RADIUS = 70;

const SEARCH_MODE = Object.freeze({
    ANY: 'any',
    ACTIVATION: 'activation',
});

const SELECTIVE_LOGIC_LABELS = Object.freeze({
    0: 'AND_ANY',
    1: 'NOT_ALL',
    2: 'NOT_ANY',
    3: 'AND_ALL',
});

function asFiniteInteger(value, fallback = null) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.floor(num);
}

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clipText(value, maxLength = 80) {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}…`;
}

function normalizeSearchMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === SEARCH_MODE.ACTIVATION ? SEARCH_MODE.ACTIVATION : SEARCH_MODE.ANY;
}

function normalizeQueryLimit(value, fallback = QUERY_LIMIT_DEFAULT) {
    const numeric = asFiniteInteger(value, fallback);
    if (!Number.isInteger(numeric)) return fallback;
    return Math.max(1, Math.min(QUERY_LIMIT_MAX, numeric));
}

function normalizeUidRange(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;

    const exact = text.match(/^(\d+)$/);
    if (exact) {
        const uid = asFiniteInteger(exact[1], null);
        if (!Number.isInteger(uid) || uid < 0) {
            throw new Error(`Invalid lorebook range: ${text}`);
        }
        return { start: uid, end: uid };
    }

    const rangeMatch = text.match(/^(\d+)?\s*(?:~|-|:|\.\.)\s*(\d+)?$/);
    if (!rangeMatch) {
        throw new Error(`Invalid lorebook range: ${text}. Use formats like 0~100, 50~, or ~100.`);
    }

    const startText = String(rangeMatch[1] ?? '').trim();
    const endText = String(rangeMatch[2] ?? '').trim();
    const start = startText ? asFiniteInteger(startText, null) : 0;
    const end = endText ? asFiniteInteger(endText, null) : Number.MAX_SAFE_INTEGER;

    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
        throw new Error(`Invalid lorebook range: ${text}`);
    }
    if (start > end) {
        throw new Error(`Invalid lorebook range: ${text}. Range start must be <= end.`);
    }
    return { start, end };
}

function normalizeDetailUids(value) {
    const source = Array.isArray(value) ? value : [];
    const unique = [];
    const seen = new Set();
    for (const item of source) {
        const uid = asFiniteInteger(item, null);
        if (!Number.isInteger(uid) || uid < 0 || seen.has(uid)) continue;
        seen.add(uid);
        unique.push(uid);
        if (unique.length >= DETAIL_LIMIT_MAX) break;
    }
    return unique;
}

function collectEntryUids(entries) {
    const output = new Set();
    for (const [rawUid, entry] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
        const uid = asFiniteInteger(rawUid, asFiniteInteger(entry?.uid, null));
        if (Number.isInteger(uid) && uid >= 0) output.add(uid);
    }
    return output;
}

function getEntryByUid(entries, uid) {
    if (!entries || typeof entries !== 'object') return null;
    if (Object.hasOwn(entries, uid)) return entries[uid] ?? null;
    const key = String(uid);
    if (Object.hasOwn(entries, key)) return entries[key] ?? null;
    return null;
}

function getSelectiveLogicLabel(value) {
    const numeric = asFiniteInteger(value, 0);
    return SELECTIVE_LOGIC_LABELS[numeric] || SELECTIVE_LOGIC_LABELS[0];
}

function normalizeLineEndings(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeEntryForSync(entry, uid) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const normalizedUid = Number.isInteger(asFiniteInteger(uid, null))
        ? Number(asFiniteInteger(uid, 0))
        : Number(asFiniteInteger(source.uid, 0) || 0);
    const rawDelay = source.delayUntilRecursion;
    let delayUntilRecursion;
    if (typeof rawDelay === 'number' && Number.isFinite(rawDelay)) {
        delayUntilRecursion = Math.max(0, Math.trunc(rawDelay));
    } else if (rawDelay === true) {
        delayUntilRecursion = 1;
    } else {
        delayUntilRecursion = 0;
    }
    return {
        uid: normalizedUid,
        comment: normalizeLineEndings(source.comment ?? ''),
        content: normalizeLineEndings(source.content ?? ''),
        key: Array.isArray(source.key) ? source.key.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        keysecondary: Array.isArray(source.keysecondary) ? source.keysecondary.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        selectiveLogic: asFiniteInteger(source.selectiveLogic, 0) ?? 0,
        order: asFiniteInteger(source.order, 0) ?? 0,
        position: asFiniteInteger(source.position, 0) ?? 0,
        depth: asFiniteInteger(source.depth, 0) ?? 0,
        disable: Boolean(source.disable),
        constant: Boolean(source.constant),
        excludeRecursion: Boolean(source.excludeRecursion),
        preventRecursion: Boolean(source.preventRecursion),
        delayUntilRecursion,
    };
}

function normalizeToolEntry(entry, uid, { includeContent = false, includeLayout = false } = {}) {
    const normalized = normalizeEntryForSync(entry, uid);
    const output = {
        uid: Number(normalized.uid),
        comment: String(normalized.comment || ''),
        key: Array.isArray(normalized.key) ? normalized.key.slice() : [],
        keysecondary: Array.isArray(normalized.keysecondary) ? normalized.keysecondary.slice() : [],
        selective_logic: getSelectiveLogicLabel(normalized.selectiveLogic),
        constant: Boolean(normalized.constant),
        enabled: !normalized.disable,
    };
    if (includeLayout) {
        output.order = Number(normalized.order);
        output.position = Number(normalized.position);
        output.depth = Number(normalized.depth);
        output.exclude_recursion = Boolean(normalized.excludeRecursion);
        output.prevent_recursion = Boolean(normalized.preventRecursion);
        output.delay_until_recursion = Number(normalized.delayUntilRecursion);
    }
    if (includeContent) {
        output.content = String(normalized.content || '');
    }
    return output;
}

function summarizeListEntry(entry, uid) {
    const normalized = normalizeToolEntry(entry, uid);
    const name = clipText(normalized.comment, 120).trim()
        || clipText(normalized.key[0] || '', 120).trim()
        || `#${normalized.uid}`;
    return { uid: normalized.uid, name, enabled: normalized.enabled };
}

function buildContentExcerpt(text, query) {
    const rawText = String(text ?? '');
    const rawQuery = String(query ?? '').trim();
    if (!rawText || !rawQuery) return null;
    const haystack = rawText.toLocaleLowerCase();
    const needle = rawQuery.toLocaleLowerCase();
    const index = haystack.indexOf(needle);
    if (index < 0) return null;
    const start = Math.max(0, index - MATCH_EXCERPT_RADIUS);
    const end = Math.min(rawText.length, index + rawQuery.length + MATCH_EXCERPT_RADIUS);
    let excerpt = rawText.slice(start, end).replace(/\s+/g, ' ').trim();
    if (!excerpt) return null;
    if (start > 0) excerpt = `…${excerpt}`;
    if (end < rawText.length) excerpt = `${excerpt}…`;
    return excerpt;
}

function buildEntryMatch(entry, query, searchMode) {
    const text = String(query || '').trim();
    if (!text) {
        return { matched: true, score: 0, matchFields: [], matchedExcerpt: null };
    }
    const queryLower = text.toLocaleLowerCase();
    const normalizedMode = normalizeSearchMode(searchMode);
    const matchFields = [];
    let score = 0;
    let matchedExcerpt = null;
    const includeField = (value) => String(value ?? '').toLocaleLowerCase().includes(queryLower);
    const keyMatches = Array.isArray(entry?.key) && entry.key.some(includeField);
    const secondaryMatches = Array.isArray(entry?.keysecondary) && entry.keysecondary.some(includeField);
    if (normalizedMode === SEARCH_MODE.ANY && includeField(entry?.comment)) {
        matchFields.push('comment');
        score += 400;
    }
    if (keyMatches) {
        matchFields.push('key');
        score += 320;
    }
    if (secondaryMatches) {
        matchFields.push('keysecondary');
        score += 280;
    }
    if (normalizedMode === SEARCH_MODE.ANY && includeField(entry?.content)) {
        matchFields.push('content');
        score += 120;
        matchedExcerpt = buildContentExcerpt(entry?.content, text);
    }
    return { matched: matchFields.length > 0, score, matchFields, matchedExcerpt };
}

async function loadBookByName(context, bookName) {
    const trimmed = String(bookName || '').trim();
    if (!trimmed) {
        throw new Error('book_name is required.');
    }
    const allBooks = typeof context?.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : [];
    if (Array.isArray(allBooks) && allBooks.length > 0 && !allBooks.includes(trimmed)) {
        throw new Error(`World book "${trimmed}" not found.`);
    }
    const data = await context.loadWorldInfo(trimmed);
    const lorebookData = (data && typeof data === 'object')
        ? (data.entries && typeof data.entries === 'object' ? data : { ...data, entries: {} })
        : { entries: {} };
    return { bookName: trimmed, lorebookData };
}

function resolveCharacterByAvatar(context, avatar) {
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const preferredAvatar = String(avatar || '').trim();
    if (preferredAvatar) {
        return characters.find(item => String(item?.avatar || '').trim() === preferredAvatar) || null;
    }
    return characters[context?.characterId] || null;
}

export const lorebookHelpers = Object.freeze({
    QUERY_LIMIT_MAX,
    DETAIL_LIMIT_MAX,
    SEARCH_MODE,
    asFiniteInteger,
    normalizeText,
    normalizeSearchMode,
    normalizeQueryLimit,
    normalizeUidRange,
    normalizeDetailUids,
    collectEntryUids,
    getEntryByUid,
    normalizeToolEntry,
    normalizeEntryForSync,
    summarizeListEntry,
    buildEntryMatch,
    loadBookByName,
    resolveCharacterByAvatar,
});
