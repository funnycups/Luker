// public/scripts/extensions/orchestrator/lorebook-filter.js

/**
 * Per-preset world book filter shared by all four orchestrator modes.
 *
 * A filter is `{ bookPattern: string, entryPattern: string }` where each
 * pattern is a newline-separated list of JS regex source strings; a book/
 * entry matches when ANY line in the corresponding dimension matches.
 * `book` is matched against `entry.world`, `entry` against `entry.comment`.
 * The two dimensions combine with OR (either match filters the entry).
 *
 * Exports:
 *  - sanitizeLorebookFilter(input) → coerces to a well-formed filter,
 *    returning `{bookPattern:'', entryPattern:''}` for non-object input.
 *  - compileLorebookFilter(filter) → `{ bookRegexes, entryRegexes, isEmpty,
 *    test(bookName, entryComment) }`. Invalid regex lines are skipped with
 *    a console.warn; empty lines ignored.
 *  - applyProfileWorldInfoFilter(payload, filter) → mutates the six
 *    world-info channels on a chat-completion payload (before/after/depth
 *    buckets/outlet slots/anBefore/anAfter/examples) in place, dropping
 *    entries whose activatedEntries record matches the compiled filter.
 *    Unknown strings (not present in activatedEntries) are preserved
 *    (default-allow) so that non-world content is never accidentally cut.
 *  - applyLorebookFilterPatchArgs(currentFilter, args, {dimension}) →
 *    returns a new filter with `bookPattern` or `entryPattern` replaced by
 *    `args.pattern`. Throws `invalid_args` for missing/non-string pattern,
 *    unknown dimension, or any regex line that fails to compile (with
 *    1-based line number). Throws `noop` when the patch would not change
 *    the current field.
 */

export function sanitizeLorebookFilter(input) {
    if (!input || typeof input !== 'object') {
        return { bookPattern: '', entryPattern: '' };
    }
    return {
        bookPattern: input.bookPattern == null ? '' : String(input.bookPattern),
        entryPattern: input.entryPattern == null ? '' : String(input.entryPattern),
    };
}

function compileRegexList(source) {
    const out = [];
    if (typeof source !== 'string' || source.length === 0) return out;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        try {
            out.push(new RegExp(line));
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[orchestrator/lorebook-filter] skipping invalid regex on line ${i + 1}: ${line} — ${err?.message || err}`);
        }
    }
    return out;
}

export function compileLorebookFilter(filter) {
    const safe = sanitizeLorebookFilter(filter);
    const bookRegexes = compileRegexList(safe.bookPattern);
    const entryRegexes = compileRegexList(safe.entryPattern);
    const isEmpty = bookRegexes.length === 0 && entryRegexes.length === 0;
    return {
        bookRegexes,
        entryRegexes,
        isEmpty,
        test(bookName, entryComment) {
            if (isEmpty) return false;
            const book = String(bookName ?? '');
            const comment = String(entryComment ?? '');
            for (const rx of bookRegexes) { if (rx.test(book)) return true; }
            for (const rx of entryRegexes) { if (rx.test(comment)) return true; }
            return false;
        },
    };
}

function buildEntryLookup(activatedEntries) {
    const map = new Map();
    if (!Array.isArray(activatedEntries)) return map;
    for (const entry of activatedEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const content = String(entry.content ?? '');
        if (!map.has(content)) {
            // First entry wins for duplicate content; downstream filter is
            // OR-based across dimensions so duplicates within one book are
            // safe (same world+comment reads).
            map.set(content, entry);
        }
    }
    return map;
}

function filterStringArrayInPlace(arr, lookup, compiled) {
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i--) {
        const entry = lookup.get(String(arr[i]));
        if (!entry) continue; // default allow — unknown string kept
        if (compiled.test(entry.world, entry.comment)) {
            arr.splice(i, 1);
        }
    }
}

export function applyProfileWorldInfoFilter(payload, filter) {
    if (!payload || typeof payload !== 'object') return;
    const compiled = compileLorebookFilter(filter);
    if (compiled.isEmpty) return;

    const activated = payload.worldInfoResolution?.activatedEntries;
    const lookup = buildEntryLookup(activated);

    filterStringArrayInPlace(payload.worldInfoBeforeEntries, lookup, compiled);
    filterStringArrayInPlace(payload.worldInfoAfterEntries, lookup, compiled);
    filterStringArrayInPlace(payload.anBefore, lookup, compiled);
    filterStringArrayInPlace(payload.anAfter, lookup, compiled);

    if (Array.isArray(payload.worldInfoDepth)) {
        for (const bucket of payload.worldInfoDepth) {
            if (!bucket || !Array.isArray(bucket.entries)) continue;
            filterStringArrayInPlace(bucket.entries, lookup, compiled);
        }
    }

    if (payload.outletEntries && typeof payload.outletEntries === 'object') {
        for (const key of Object.keys(payload.outletEntries)) {
            const arr = payload.outletEntries[key];
            if (Array.isArray(arr)) filterStringArrayInPlace(arr, lookup, compiled);
        }
    }

    if (Array.isArray(payload.worldInfoExamples)) {
        for (let i = payload.worldInfoExamples.length - 1; i >= 0; i--) {
            const item = payload.worldInfoExamples[i];
            const content = item && typeof item === 'object' ? String(item.content ?? '') : String(item ?? '');
            const entry = lookup.get(content);
            if (!entry) continue;
            if (compiled.test(entry.world, entry.comment)) {
                payload.worldInfoExamples.splice(i, 1);
            }
        }
    }
}

function validateRegexLines(source, toolName) {
    if (typeof source !== 'string' || source.length === 0) return;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        try {
            new RegExp(line);
        } catch (err) {
            const e = new Error(`${toolName}: invalid_args — line ${i + 1}: "${line}": ${err?.message || err}`);
            e.code = 'invalid_args';
            throw e;
        }
    }
}

export function applyLorebookFilterPatchArgs(currentFilter, args, opts) {
    const dimension = opts?.dimension;
    if (dimension !== 'book' && dimension !== 'entry') {
        const e = new Error(`applyLorebookFilterPatchArgs: invalid_args — dimension must be 'book' or 'entry', got ${JSON.stringify(dimension)}`);
        e.code = 'invalid_args';
        throw e;
    }
    const toolName = dimension === 'book'
        ? 'luker_orch_set_lorebook_book_filter'
        : 'luker_orch_set_lorebook_entry_filter';
    const patch = args && typeof args === 'object' ? args : {};
    if (!Object.prototype.hasOwnProperty.call(patch, 'pattern')) {
        const e = new Error(`${toolName}: invalid_args — missing 'pattern' argument.`);
        e.code = 'invalid_args';
        throw e;
    }
    if (typeof patch.pattern !== 'string') {
        const e = new Error(`${toolName}: invalid_args — 'pattern' must be a string, got ${typeof patch.pattern}.`);
        e.code = 'invalid_args';
        throw e;
    }
    validateRegexLines(patch.pattern, toolName);

    const current = sanitizeLorebookFilter(currentFilter);
    const field = dimension === 'book' ? 'bookPattern' : 'entryPattern';
    if (current[field] === patch.pattern) {
        const e = new Error(`${toolName}: noop — pattern already matches.`);
        e.code = 'noop';
        throw e;
    }
    return sanitizeLorebookFilter({
        ...current,
        [field]: patch.pattern,
    });
}

/**
 * Extract activated-entry keys from a wiFinalizedPayload for tool dedup.
 *
 * ST core's finalized payload does NOT carry `payload.allActivatedEntries`
 * (only `payload.worldInfoResolution.activatedEntries`). Previous code
 * read the wrong field and always got undefined, silently disabling the
 * `lorebook_search` dedup set. This helper is the single source of truth.
 */
export function buildActivatedEntryKeysFromPayload(payload) {
    const keys = new Set();
    const entries = payload?.worldInfoResolution?.activatedEntries;
    if (!Array.isArray(entries)) return keys;
    for (const entry of entries) {
        if (!entry) continue;
        const uid = entry.uid;
        if (uid === undefined || uid === null) continue;
        const world = String(entry.world || '');
        keys.add(`${world}.${uid}`);
    }
    return keys;
}
