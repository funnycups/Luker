// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Lorebook read tools shared by iter popups (orchestrator iter-studio,
 * memory-graph schema iter, CEA editor, etc).
 *
 * Why shared: each popup needs the AI to read the active character's world
 * books while shaping its artifact — orchestrator agents that reference
 * specific facts, schema fields that mirror existing lorebook columns,
 * etc. The wire format is identical across popups; only the system prompt
 * around the tools is popup-specific.
 *
 * Architecture: plugin-agnostic. `runLorebookReadTool` only needs the
 * SillyTavern context (for `loadWorldInfo` / `getWorldInfoNames` /
 * `getCharaAuxWorlds` / `chatWorldInfo`) and an optional avatar — no
 * helper-api injection, no cross-plugin dispatcher.
 *
 * Exports:
 *   - LOREBOOK_READ_TOOL_NAMES — short canonical names. The legacy
 *     `luker_card_*` wire names are an implementation detail of CEA,
 *     not part of this shared surface.
 *   - isLorebookReadTool(name): boolean — runtime predicate.
 *   - LOREBOOK_READ_TOOL_DEFS — OpenAI-style function definitions ready
 *     to splice into a popup's tool catalog.
 *   - runLorebookReadTool(call, { context, avatar }): runs one tool call.
 *     Returns `{ ok: true, result }` or `{ ok: false, error }` so the
 *     popup can persist a tool_result either way.
 */

import { lorebookHelpers as H } from './_lorebook-helpers.js';

const TOOL_NAMES = Object.freeze({
    WORLD_BOOK_LIST: 'world_book_list',
    LOREBOOK_LIST: 'lorebook_list',
    LOREBOOK_QUERY: 'lorebook_query',
    LOREBOOK_GET: 'lorebook_get',
});

export const LOREBOOK_READ_TOOL_NAMES = Object.freeze(Object.values(TOOL_NAMES));

const NAME_SET = new Set(LOREBOOK_READ_TOOL_NAMES);

export function isLorebookReadTool(name) {
    return NAME_SET.has(String(name || ''));
}

export const LOREBOOK_READ_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: TOOL_NAMES.WORLD_BOOK_LIST,
            description: 'List world book names visible to the character being designed, tagged with their scope (character, character_aux, chat, global). Call before lorebook_list / lorebook_query / lorebook_get to know which book names exist.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_NAMES.LOREBOOK_LIST,
            description: 'List compact lorebook entry index rows (uid, name, enabled) for a world book. Optional range narrows the inclusive UID window, for example 0~100.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    range: { type: 'string', description: 'Optional inclusive UID range such as 0~100, 50~, ~100, or a single uid like 42.' },
                },
                required: ['book_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_NAMES.LOREBOOK_QUERY,
            description: 'Search a world book and return lightweight matching entries. Use this before lorebook_get to narrow candidates.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    text: { type: 'string' },
                    search_mode: { type: 'string', enum: ['any', 'activation'] },
                    constant: { type: 'boolean' },
                    enabled: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 1, maximum: H.QUERY_LIMIT_MAX },
                },
                required: ['book_name'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: TOOL_NAMES.LOREBOOK_GET,
            description: 'Fetch full lorebook entries from a world book by uid after narrowing candidates with lorebook_query.',
            parameters: {
                type: 'object',
                properties: {
                    book_name: { type: 'string', description: 'Required. Target world book.' },
                    uids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: H.DETAIL_LIMIT_MAX },
                },
                required: ['book_name', 'uids'],
                additionalProperties: false,
            },
        },
    },
];

async function listWorldBooks(context, avatar) {
    const character = H.resolveCharacterByAvatar(context, avatar);
    const books = [];
    const sources = {};
    const push = (name, source) => {
        const trimmed = String(name || '').trim();
        if (!trimmed || sources[trimmed]) return;
        sources[trimmed] = source;
        books.push(trimmed);
    };

    push(character?.data?.extensions?.world, 'character');

    const ctxRoot = (typeof Luker !== 'undefined' && Luker.getContext) ? Luker.getContext() : null;
    const getCharaFilename = ctxRoot?.getCharaFilename;
    const getCharaAuxWorlds = ctxRoot?.getCharaAuxWorlds;
    const getChatWorldInfoNames = ctxRoot?.chatWorldInfo?.getNames;
    const globalSelection = ctxRoot?.chatWorldInfo?.globalSelection;

    if (typeof getCharaFilename === 'function' && typeof getCharaAuxWorlds === 'function' && character?.avatar) {
        const fileName = getCharaFilename(null, { manualAvatarKey: character.avatar });
        for (const name of getCharaAuxWorlds(fileName) || []) push(name, 'character_aux');
    }
    if (typeof getChatWorldInfoNames === 'function') {
        try {
            for (const name of getChatWorldInfoNames(context?.chatMetadata) || []) push(name, 'chat');
        } catch { /* chat metadata may be unavailable */ }
    }
    if (Array.isArray(globalSelection)) {
        for (const name of globalSelection) push(name, 'global');
    }
    return { books, sources };
}

async function listEntries(context, args) {
    const range = H.normalizeUidRange(args?.range);
    const state = await H.loadBookByName(context, args?.book_name);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};
    const uids = Array.from(H.collectEntryUids(entries).values()).sort((a, b) => a - b);
    const filteredUids = range ? uids.filter(uid => uid >= range.start && uid <= range.end) : uids;
    return {
        book_name: state.bookName,
        total_entries: uids.length,
        returned_entries: filteredUids.length,
        range: range ? { start_uid: range.start, end_uid: range.end } : null,
        entries: filteredUids.map((uid) => H.summarizeListEntry(H.getEntryByUid(entries, uid), uid)),
    };
}

async function queryEntries(context, args) {
    const queryText = H.normalizeText(args?.text ?? '');
    const searchMode = H.normalizeSearchMode(args?.search_mode);
    const hasConstantFilter = typeof args?.constant === 'boolean';
    const hasEnabledFilter = typeof args?.enabled === 'boolean';
    if (!queryText && !hasConstantFilter && !hasEnabledFilter) {
        throw new Error('lorebook_query requires text, constant, or enabled.');
    }
    const limit = H.normalizeQueryLimit(args?.limit);
    const state = await H.loadBookByName(context, args?.book_name);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};

    const hits = [];
    const uids = Array.from(H.collectEntryUids(entries).values()).sort((a, b) => a - b);
    for (const uid of uids) {
        const rawEntry = H.getEntryByUid(entries, uid);
        const normalizedEntry = H.normalizeToolEntry(rawEntry, uid, { includeContent: true });
        if (hasConstantFilter && normalizedEntry.constant !== Boolean(args.constant)) continue;
        if (hasEnabledFilter && normalizedEntry.enabled !== Boolean(args.enabled)) continue;
        const match = H.buildEntryMatch(normalizedEntry, queryText, searchMode);
        if (queryText && !match.matched) continue;
        hits.push({
            uid: normalizedEntry.uid,
            comment: normalizedEntry.comment,
            key: normalizedEntry.key,
            keysecondary: normalizedEntry.keysecondary,
            selective_logic: normalizedEntry.selective_logic,
            constant: normalizedEntry.constant,
            enabled: normalizedEntry.enabled,
            match_fields: match.matchFields,
            matched_excerpt: match.matchedExcerpt,
            _score: match.score,
        });
    }
    hits.sort((a, b) => {
        if (queryText && b._score !== a._score) return b._score - a._score;
        const aEntry = H.getEntryByUid(entries, a.uid);
        const bEntry = H.getEntryByUid(entries, b.uid);
        const aOrder = H.asFiniteInteger(aEntry?.order, 0) ?? 0;
        const bOrder = H.asFiniteInteger(bEntry?.order, 0) ?? 0;
        if (bOrder !== aOrder) return bOrder - aOrder;
        return a.uid - b.uid;
    });
    return {
        book_name: state.bookName,
        total_hits: hits.length,
        entries: hits.slice(0, limit).map(({ _score, ...entry }) => entry),
    };
}

async function getEntries(context, args) {
    const uids = H.normalizeDetailUids(args?.uids);
    if (uids.length === 0) {
        throw new Error('lorebook_get requires one or more valid uids.');
    }
    const state = await H.loadBookByName(context, args?.book_name);
    const entries = state?.lorebookData?.entries && typeof state.lorebookData.entries === 'object'
        ? state.lorebookData.entries
        : {};
    const output = [];
    const missing = [];
    for (const uid of uids) {
        const rawEntry = H.getEntryByUid(entries, uid);
        if (!rawEntry) { missing.push(uid); continue; }
        output.push(H.normalizeToolEntry(rawEntry, uid, { includeContent: true, includeLayout: true }));
    }
    return {
        book_name: state.bookName,
        entries: output,
        missing_uids: missing,
    };
}

/**
 * Execute one lorebook read tool. Plugin-agnostic — the caller passes the
 * SillyTavern context (for loadWorldInfo / getCharaAuxWorlds / etc) plus
 * an optional avatar that scopes world_book_list to a specific character.
 *
 * @param {object} call — `{ id, name, args }` from the runner
 * @param {object} ctx
 * @param {object} ctx.context — SillyTavern context (from `Luker.getContext()`)
 * @param {string} [ctx.avatar] — character avatar; required only by `world_book_list`
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export async function runLorebookReadTool(call, { context, avatar = '' } = {}) {
    const name = String(call?.name || '');
    if (!isLorebookReadTool(name)) {
        return { ok: false, error: `Not a lorebook read tool: ${name || '(empty)'}` };
    }
    if (!context || typeof context !== 'object') {
        return { ok: false, error: 'runLorebookReadTool: ctx.context is required' };
    }
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    try {
        let result;
        if (name === TOOL_NAMES.WORLD_BOOK_LIST) {
            result = await listWorldBooks(context, avatar);
        } else if (name === TOOL_NAMES.LOREBOOK_LIST) {
            result = await listEntries(context, args);
        } else if (name === TOOL_NAMES.LOREBOOK_QUERY) {
            result = await queryEntries(context, args);
        } else if (name === TOOL_NAMES.LOREBOOK_GET) {
            result = await getEntries(context, args);
        } else {
            return { ok: false, error: `Unhandled lorebook read tool: ${name}` };
        }
        return { ok: true, result };
    } catch (err) {
        return { ok: false, error: String(err?.message || err || 'unknown error') };
    }
}
