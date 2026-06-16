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
 * Fetch a single lorebook entry by uid OR entry_key (exactly one). Optional
 * `book` narrows by `entry.world` for cases where the same handle appears
 * in multiple books. Output always includes both `uid` and `name`
 * regardless of which addressing form the caller used. Does NOT dedup
 * against `activatedEntryKeys` — quoting an injected entry verbatim is a
 * legitimate use case.
 *
 * @param {{ uid?: number, entry_key?: string, book?: string }} args
 * @param {object} context
 * @returns {Promise<{book: string, uid: number, name: string, key: string[], content: string}>}
 */
export async function execLorebookGet(args, context) {
    const entryKeyRaw = args?.entry_key;
    const uidRaw = args?.uid;
    const hasKey = typeof entryKeyRaw === 'string' && entryKeyRaw.trim() !== '';
    const hasUid = uidRaw !== undefined && uidRaw !== null
        && Number.isFinite(Number(uidRaw));
    if (hasKey && hasUid) {
        throw new ToolError(
            'lorebook_get: pass exactly one of {entry_key, uid}, not both.',
            'LOREBOOK_ADDRESSING_AMBIGUOUS',
            'Drop one. Use uid for a stable handle from lorebook_list output; use entry_key for human-readable lookup.',
        );
    }
    if (!hasKey && !hasUid) {
        throw new ToolError(
            'lorebook_get: pass exactly one of {entry_key, uid}.',
            'LOREBOOK_ADDRESSING_MISSING',
            'Call lorebook_list to discover uids, or use entry_key directly.',
        );
    }
    const book = String(args?.book ?? '').trim();
    const entries = await loadAllEnabledEntries(context);

    const target = entries.find(e => {
        if (!e) return false;
        if (hasUid && Number(e.uid) !== Number(uidRaw)) return false;
        if (hasKey) {
            const keys = Array.isArray(e.key) ? e.key.map(String) : [];
            if (!keys.includes(entryKeyRaw.trim())) return false;
        }
        if (book && String(e.world || '') !== book) return false;
        return true;
    });
    if (!target) {
        const handle = hasUid ? `uid ${uidRaw}` : `'${entryKeyRaw.trim()}'`;
        throw new ToolError(
            `lorebook_get: entry ${handle} not found${book ? ` in book '${book}'` : ''}.`,
            'LOREBOOK_NOT_FOUND',
            'Verify the handle (uid via lorebook_list, key is case-sensitive) and that the lorebook is enabled.',
        );
    }
    return {
        book: String(target.world || ''),
        uid: Number(target.uid),
        name: String(target.comment || ''),
        key: Array.isArray(target.key) ? target.key.map(String) : [],
        content: String(target.content || ''),
    };
}

/**
 * Build a `Map<bookName, scope>` of books visible to the current chat,
 * mirroring iter-studio's `listWorldBooks` (lorebook-reads.js). Sources
 * resolve in priority order — character primary, character_aux, chat,
 * global — and the first writer wins so a book bound at multiple scopes
 * is tagged by its strongest binding.
 *
 * Production reads everything off `Luker.getContext()`. Tests inject
 * `context.__getWorldScopesFn` to bypass the global, matching the
 * `__getSortedEntriesFn` seam used by `loadAllEnabledEntries`. When
 * Luker is unavailable (or fields throw), the map is returned as-is
 * and per-book lookups gracefully fall back to `unknown`.
 */
async function loadWorldBookScopes(context) {
    if (typeof context?.__getWorldScopesFn === 'function') {
        const injected = await context.__getWorldScopesFn();
        if (injected instanceof Map) return injected;
        if (injected && typeof injected === 'object') return new Map(Object.entries(injected));
        return new Map();
    }
    const scopes = new Map();
    if (typeof Luker === 'undefined' || typeof Luker.getContext !== 'function') return scopes;
    const ctx = Luker.getContext();
    if (!ctx) return scopes;

    const push = (name, scope) => {
        const trimmed = String(name || '').trim();
        if (!trimmed || scopes.has(trimmed)) return;
        scopes.set(trimmed, scope);
    };

    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const character = characters[ctx.characterId] || null;

    push(character?.data?.extensions?.world, 'character');

    if (character?.avatar && typeof ctx.getCharaFilename === 'function' && typeof ctx.getCharaAuxWorlds === 'function') {
        try {
            const fileName = ctx.getCharaFilename(null, { manualAvatarKey: character.avatar });
            for (const name of ctx.getCharaAuxWorlds(fileName) || []) push(name, 'character_aux');
        } catch { /* character resolution may fail in odd states */ }
    }

    const getChatNames = ctx.chatWorldInfo?.getNames;
    if (typeof getChatNames === 'function') {
        try {
            for (const name of getChatNames(ctx.chatMetadata) || []) push(name, 'chat');
        } catch { /* chat metadata may be unavailable */ }
    }

    const globalSelection = ctx.chatWorldInfo?.globalSelection;
    if (Array.isArray(globalSelection)) {
        for (const name of globalSelection) push(name, 'global');
    }
    return scopes;
}

/**
 * List visible world books with their entry counts. Books with at least
 * one enabled entry are emitted grep-style as `[{scope}] {book} ({n}
 * entr{y|ies})`. Scope tags (character / character_aux / chat / global)
 * are resolved via `loadWorldBookScopes` for parity with iter-studio's
 * `world_book_list`. Books that have entries but no resolvable scope
 * (stale binding, exotic setup) fall back to `[unknown]` per book —
 * not for the whole listing.
 *
 * @param {object} context
 * @returns {Promise<{ok: true, output: string}>}
 */
export async function execWorldBookList(_args, context) {
    const entries = await loadAllEnabledEntries(context);
    const counts = new Map();
    for (const entry of entries) {
        if (!entry) continue;
        const book = String(entry.world || '');
        if (!book) continue;
        counts.set(book, (counts.get(book) || 0) + 1);
    }
    const scopes = await loadWorldBookScopes(context);
    const lines = [];
    for (const [book, n] of counts) {
        const scope = scopes.get(book) || 'unknown';
        const unit = n === 1 ? 'entry' : 'entries';
        lines.push(`[${scope}] ${book} (${n} ${unit})`);
    }
    return { ok: true, output: lines.join('\n') };
}

/**
 * Parse a range string into `{start, end}` inclusive bounds, mirroring
 * iter-studio's `normalizeUidRange` (`_lorebook-helpers.js`) so the runtime
 * tool and the iter-studio popup tools share validation muscle memory.
 *
 * Accepts:
 *   - empty / missing input → `null` (caller treats as "no range filter")
 *   - `n` → `{start: n, end: n}` (single uid)
 *   - `lo~hi` / `lo-hi` / `lo:hi` / `lo..hi` → bounded range
 *   - `lo~` (and `-`/`:`/`..` variants) → `{start: lo, end: MAX_SAFE_INTEGER}`
 *   - `~hi` (and variants) → `{start: 0, end: hi}`
 *
 * Throws `ToolError(LOREBOOK_RANGE_INVALID)` on malformed input, negative
 * endpoints, non-integer endpoints, or reversed bounds (`start > end`).
 *
 * @param {string} input
 * @returns {{start: number, end: number} | null}
 */
function parseUidRange(input) {
    const text = String(input ?? '').trim();
    if (!text) return null;

    const invalidHint = 'Use formats like 0~100, 50~, or ~100 (separators ~, -, :, .. also accepted).';

    const exact = text.match(/^(\d+)$/);
    if (exact) {
        const uid = Number.parseInt(exact[1], 10);
        if (!Number.isInteger(uid) || uid < 0) {
            throw new ToolError(
                `lorebook_list: invalid range '${text}'.`,
                'LOREBOOK_RANGE_INVALID',
                invalidHint,
            );
        }
        return { start: uid, end: uid };
    }

    const rangeMatch = text.match(/^(\d+)?\s*(?:~|-|:|\.\.)\s*(\d+)?$/);
    if (!rangeMatch) {
        throw new ToolError(
            `lorebook_list: invalid range '${text}'.`,
            'LOREBOOK_RANGE_INVALID',
            invalidHint,
        );
    }

    const startText = String(rangeMatch[1] ?? '').trim();
    const endText = String(rangeMatch[2] ?? '').trim();
    const start = startText ? Number.parseInt(startText, 10) : 0;
    const end = endText ? Number.parseInt(endText, 10) : Number.MAX_SAFE_INTEGER;

    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < 0) {
        throw new ToolError(
            `lorebook_list: invalid range '${text}'.`,
            'LOREBOOK_RANGE_INVALID',
            invalidHint,
        );
    }
    if (start > end) {
        throw new ToolError(
            `lorebook_list: invalid range '${text}' — start must be <= end.`,
            'LOREBOOK_RANGE_INVALID',
            invalidHint,
        );
    }
    return { start, end };
}

/**
 * List entry index rows for one world book. Excludes entries already
 * activated this turn (the agent already sees their content in the main
 * context). Output is grep-style:
 *
 *   [{book}] uid={n} name={comment} key={k1|k2|...}
 *
 * @param {{book_name: string, range?: string}} args
 * @param {object} context
 * @returns {Promise<{ok: true, output: string}>}
 */
export async function execLorebookList(args, context) {
    const bookName = String(args?.book_name ?? '').trim();
    if (!bookName) {
        throw new ToolError(
            'lorebook_list: book_name must be non-empty.',
            'LOREBOOK_BOOK_REQUIRED',
            'Pass a book_name; call world_book_list to discover available books.',
        );
    }
    const range = parseUidRange(args?.range);

    const entries = await loadAllEnabledEntries(context);
    const activated = context?.__lukerRun?.activatedEntryKeys instanceof Set
        ? context.__lukerRun.activatedEntryKeys
        : new Set();

    const lines = [];
    for (const entry of entries) {
        if (!entry) continue;
        if (String(entry.world || '') !== bookName) continue;
        if (activated.has(entryActivationKey(entry))) continue;
        const uid = Number(entry.uid);
        if (!Number.isFinite(uid)) continue;
        if (range && (uid < range.start || uid > range.end)) continue;
        const name = String(entry.comment || '');
        const keys = Array.isArray(entry.key) ? entry.key.map(String).filter(Boolean) : [];
        lines.push(`[${bookName}] uid=${uid} name=${name} key=${keys.join('|')}`);
    }
    return { ok: true, output: lines.join('\n') };
}
