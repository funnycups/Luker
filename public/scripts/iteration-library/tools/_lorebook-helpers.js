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

import { STATE_ERROR_REASONS } from '../../lib/state-errors.js';

/**
 * Structured error thrown by lorebook helpers, reads, and writes. Carries
 * a `reason` from `STATE_ERROR_REASONS` plus a short human-readable `hint`
 * so the proposal bus's parkConflict path can route directly to the right
 * UI affordance (arg fixer vs target-missing vs commit conflict) instead
 * of regex-matching the message text.
 *
 * Helpers shared between propose-time validation and apply-time commit
 * (e.g. `loadBookByName`, `computeUpdate`, `computeStrReplace`) accept an
 * optional `{ missingReason }` argument so the same "not found" lookup
 * can be tagged VALIDATION_TARGET when the AI's tool call references a
 * missing target, or CONFLICT when a target that existed at propose time
 * has since vanished on the apply path.
 */
export class LorebookError extends Error {
    constructor({ reason, hint, code = '' }) {
        super(`[lorebook] ${reason}: ${hint}`);
        this.name = 'LorebookError';
        this.reason = reason;
        this.hint = String(hint || '').slice(0, 120);
        // Optional machine-readable discriminator for callers that map a
        // helper failure onto their own error contract.
        if (code) this.code = String(code);
    }
}

// Algorithmic half-window around a query substring match for excerpt rendering.
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

function normalizeSearchMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === SEARCH_MODE.ACTIVATION ? SEARCH_MODE.ACTIVATION : SEARCH_MODE.ANY;
}

function normalizeQueryLimit(value) {
    if (value === undefined || value === null || value === '') return null;
    const numeric = asFiniteInteger(value, null);
    if (!Number.isInteger(numeric) || numeric < 1) return null;
    return numeric;
}

function normalizeUidRange(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;

    const exact = text.match(/^(\d+)$/);
    if (exact) {
        const uid = asFiniteInteger(exact[1], null);
        if (!Number.isInteger(uid) || uid < 0) {
            throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: `Invalid lorebook range: ${text}` });
        }
        return { start: uid, end: uid };
    }

    const rangeMatch = text.match(/^(\d+)?\s*(?:~|-|:|\.\.)\s*(\d+)?$/);
    if (!rangeMatch) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: `Invalid lorebook range: ${text}. Use formats like 0~100, 50~, or ~100.` });
    }

    const startText = String(rangeMatch[1] ?? '').trim();
    const endText = String(rangeMatch[2] ?? '').trim();
    const start = startText ? asFiniteInteger(startText, null) : 0;
    const end = endText ? asFiniteInteger(endText, null) : Number.MAX_SAFE_INTEGER;

    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: `Invalid lorebook range: ${text}` });
    }
    if (start > end) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: `Invalid lorebook range: ${text}. Range start must be <= end.`, code: 'RANGE_REVERSED' });
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
    const name = String(normalized.comment || '').trim()
        || String(normalized.key[0] || '').trim()
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

async function loadBookByName(context, bookName, { missingReason = STATE_ERROR_REASONS.VALIDATION_TARGET } = {}) {
    const trimmed = String(bookName || '').trim();
    if (!trimmed) {
        throw new LorebookError({ reason: STATE_ERROR_REASONS.VALIDATION_ARGS, hint: 'book_name is required' });
    }
    const allBooks = typeof context?.getWorldInfoNames === 'function' ? context.getWorldInfoNames() : [];
    if (Array.isArray(allBooks) && allBooks.length > 0 && !allBooks.includes(trimmed)) {
        throw new LorebookError({ reason: missingReason, hint: `World book "${trimmed}" not found` });
    }
    const data = await context.loadWorldInfo(trimmed);
    if (!data || typeof data !== 'object') {
        throw new LorebookError({ reason: missingReason, hint: `World book "${trimmed}" not found` });
    }
    const lorebookData = data.entries && typeof data.entries === 'object' ? data : { ...data, entries: {} };
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

/**
 * World books visible to `character`, in binding-strength order
 * (character → character_aux → chat → global). A book bound at several
 * scopes is tagged by the first. `ctxRoot` is the Luker context (may
 * be null); `chatMetadata` is the caller's chat metadata.
 *
 * @returns {Array<[string, 'character' | 'character_aux' | 'chat' | 'global']>}
 */
function collectWorldBookSources(ctxRoot, character, chatMetadata) {
    const out = [];
    const seen = new Set();
    const push = (name, scope) => {
        const trimmed = String(name || '').trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push([trimmed, scope]);
    };

    push(character?.data?.extensions?.world, 'character');

    if (character?.avatar && typeof ctxRoot?.getCharaFilename === 'function' && typeof ctxRoot?.getCharaAuxWorlds === 'function') {
        const fileName = ctxRoot.getCharaFilename(null, { manualAvatarKey: character.avatar });
        for (const name of ctxRoot.getCharaAuxWorlds(fileName) || []) push(name, 'character_aux');
    }

    const getChatNames = ctxRoot?.chatWorldInfo?.getNames;
    if (typeof getChatNames === 'function') {
        for (const name of getChatNames(chatMetadata) || []) push(name, 'chat');
    }

    const globalSelection = ctxRoot?.chatWorldInfo?.globalSelection;
    if (Array.isArray(globalSelection)) {
        for (const name of globalSelection) push(name, 'global');
    }
    return out;
}

export const lorebookHelpers = Object.freeze({
    MATCH_EXCERPT_RADIUS,
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
    collectWorldBookSources,
});
