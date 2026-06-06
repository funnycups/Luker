/**
 * loop-tools/lorebook.js — lorebook (World Info) tools for loop mode.
 *
 * Two tools cover discovery and verbatim retrieval over the chat's
 * enabled lorebooks:
 *
 *   - lorebook_search({ query, limit }) substring-scans content + key
 *     lists across all enabled entries, **excluding entries already
 *     activated this turn** (those have already been injected into the
 *     main model via main-flow World Info, so the agent rediscovering
 *     them wastes a round). The activated set rides on the run context
 *     at `context.__lukerRun.activatedEntryKeys`, populated by the
 *     orchestrator's `onWorldInfoFinalized` hook.
 *   - lorebook_get({ entry_key, book? }) fetches a single entry by key
 *     with full content. Does NOT dedup against the activated set: the
 *     agent may want to quote an injected entry verbatim for
 *     terminology consistency.
 *
 * Production loads entries via `getSortedEntries` from `world-info.js`,
 * which is unsafe to import in the Node test runner because its
 * sibling `lib.js` is a build-only bundle. Tests inject the fixture
 * through `context.__getSortedEntriesFn`; the loader prefers the
 * injected hook and falls back to dynamic import in production.
 */

import { ToolError } from '../loop-runtime.js';

const PREVIEW_LEN = 500;

function preview(text) {
    const s = String(text || '');
    return s.length <= PREVIEW_LEN ? s : s.slice(0, PREVIEW_LEN);
}

function entryActivationKey(entry) {
    if (!entry) return '';
    return `${String(entry.world || '')}.${String(entry.uid ?? '')}`;
}

/**
 * Production: read `getSorted` from ctx.worldInfoEntry. Tests: prefer
 * the injected `context.__getSortedEntriesFn` hook to bypass the
 * build-only `lib.js` chain.
 */
async function loadAllEnabledEntries(context) {
    if (typeof context?.__getSortedEntriesFn === 'function') {
        const result = await context.__getSortedEntriesFn();
        return Array.isArray(result) ? result : [];
    }
    const getSorted = SillyTavern.getContext().worldInfoEntry?.getSorted;
    if (typeof getSorted !== 'function') return [];
    const entries = await getSorted();
    return Array.isArray(entries) ? entries : [];
}

/**
 * Search across all enabled lorebook entries (content + key list).
 * Case-insensitive substring match. Skips entries flagged as already
 * activated this turn so the agent doesn't surface what's already in
 * the main model context.
 *
 * @param {{ query: string, limit?: number }} args
 * @param {object} context — run context (carries `__lukerRun` + loader hook)
 * @returns {Promise<{entries: Array<{book: string, key: string[], preview: string}>, excluded_active_count: number}>}
 */
export async function execLorebookSearch(args, context) {
    const queryRaw = String(args?.query ?? '');
    if (!queryRaw.trim()) {
        throw new ToolError(
            'lorebook_search: query must be non-empty.',
            'LOREBOOK_QUERY_EMPTY',
            'Provide a non-empty query. Try a content keyword or part of an entry key.',
        );
    }
    const limit = Math.max(1, Math.min(50, Math.floor(Number(args?.limit) || 5)));
    const q = queryRaw.toLowerCase();

    const entries = await loadAllEnabledEntries(context);
    const activated = context?.__lukerRun?.activatedEntryKeys instanceof Set
        ? context.__lukerRun.activatedEntryKeys
        : new Set();

    let excluded = 0;
    const matches = [];
    for (const entry of entries) {
        if (!entry) continue;
        if (activated.has(entryActivationKey(entry))) {
            excluded += 1;
            continue;
        }
        const text = String(entry.content || '');
        const keys = Array.isArray(entry.key) ? entry.key.map(String) : [];
        const haystack = `${text}\n${keys.join(' ')}`.toLowerCase();
        if (!haystack.includes(q)) continue;
        matches.push({
            book: String(entry.world || ''),
            key: keys,
            preview: preview(text),
        });
        if (matches.length >= limit) break;
    }
    return { entries: matches, excluded_active_count: excluded };
}

/**
 * Fetch a single lorebook entry by key. Optional `book` narrows by
 * `entry.world` for cases where the same key appears in multiple books.
 * Does NOT dedup against `activatedEntryKeys` — quoting an injected
 * entry verbatim is a legitimate use case.
 *
 * @param {{ entry_key: string, book?: string }} args
 * @param {object} context
 * @returns {Promise<{book: string, key: string[], content: string}>}
 */
export async function execLorebookGet(args, context) {
    const entryKeyRaw = String(args?.entry_key ?? '');
    if (!entryKeyRaw.trim()) {
        throw new ToolError(
            'lorebook_get: entry_key must be non-empty.',
            'LOREBOOK_KEY_EMPTY',
            'Pass a key string that appears in some entry\'s key array.',
        );
    }
    const entryKey = entryKeyRaw.trim();
    const book = String(args?.book ?? '').trim();

    const entries = await loadAllEnabledEntries(context);
    const target = entries.find(e => {
        if (!e) return false;
        const keys = Array.isArray(e.key) ? e.key.map(String) : [];
        if (!keys.includes(entryKey)) return false;
        if (book && String(e.world || '') !== book) return false;
        return true;
    });
    if (!target) {
        throw new ToolError(
            `lorebook_get: entry '${entryKey}' not found${book ? ` in book '${book}'` : ''}.`,
            'LOREBOOK_NOT_FOUND',
            'Verify the entry key (case-sensitive) and that the lorebook is enabled. Try lorebook_search to discover available keys.',
        );
    }
    return {
        book: String(target.world || ''),
        key: Array.isArray(target.key) ? target.key.map(String) : [],
        content: String(target.content || ''),
    };
}
