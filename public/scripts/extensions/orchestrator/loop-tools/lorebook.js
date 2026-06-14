/**
 * loop-tools/lorebook.js — lorebook (World Info) tools for loop mode.
 *
 * Two tools cover discovery and verbatim retrieval over the chat's
 * enabled lorebooks:
 *
 *   - lorebook_search({ pattern, flags?, book? }) regex-scans entry
 *     content across all enabled entries, **excluding entries already
 *     activated this turn** (those have already been injected into the
 *     main model via main-flow World Info, so the agent rediscovering
 *     them wastes a round). The activated set rides on the run context
 *     at `context.__lukerRun.activatedEntryKeys`, populated by the
 *     orchestrator's `onWorldInfoFinalized` hook. Emits grep -n style
 *     output: one matched line per result as
 *     `[{book}] {entry_name}:{lineno}: {line_content}`.
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
import { gatherGrepMatches } from '../grep-tool.js';

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
    const getSorted = Luker.getContext().worldInfoEntry?.getSorted;
    if (typeof getSorted !== 'function') return [];
    const entries = await getSorted();
    return Array.isArray(entries) ? entries : [];
}

function entryDisplayName(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key.map(String).filter(Boolean) : [];
    if (keys.length > 0) return keys.join('|');
    return `uid:${entry?.uid ?? '?'}`;
}

/**
 * Regex search across all enabled lorebook entries (content). Emits grep -n
 * style output with "[{book}] {entry_name}" prefix. Skips entries already
 * activated this turn (those are already in the main model context).
 *
 * @param {{ pattern: string, flags?: string, book?: string }} args
 * @param {object} context — run context (carries `__lukerRun` + loader hook)
 * @returns {Promise<{ok: true, output: string} | {ok: false, error: string}>}
 */
export async function execLorebookSearch(args, context) {
    const pattern = String(args?.pattern ?? '');
    if (!pattern) {
        throw new ToolError(
            'lorebook_search: pattern must be non-empty.',
            'LOREBOOK_PATTERN_EMPTY',
            'Provide a non-empty regex pattern. To match literal text, escape regex metacharacters.',
        );
    }
    const flags = typeof args?.flags === 'string' && args.flags.length > 0 ? args.flags : 'gm';
    const bookFilter = String(args?.book ?? '').trim();

    const entries = await loadAllEnabledEntries(context);
    const activated = context?.__lukerRun?.activatedEntryKeys instanceof Set
        ? context.__lukerRun.activatedEntryKeys
        : new Set();

    function* corpus() {
        for (const entry of entries) {
            if (!entry) continue;
            if (activated.has(entryActivationKey(entry))) continue;
            const book = String(entry.world || '');
            if (bookFilter && book !== bookFilter) continue;
            yield {
                prefix: `[${book}] ${entryDisplayName(entry)}`,
                content: String(entry.content || ''),
            };
        }
    }

    return gatherGrepMatches(corpus(), pattern, flags);
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
