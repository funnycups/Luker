/**
 * Value presentation for the conflict view.
 *
 * The navigation tree never carries value text. When the user opens one
 * field, this module formats that field and cuts it to a single page.
 * The bounds below are per rendered value, not per file: every change is
 * still listed, and every cut value can continue through the value route.
 */

import DiffMatchPatch from 'diff-match-patch';

export const MAX_CELL_CHARS = 4000; // cap-ok: one wrapped value cell in the conflict popup; the mobile WebView stalls on multi-megabyte wrapped text, so longer values continue page by page

export const MAX_LINE_ROWS = 200; // cap-ok: one line-diff page in the popup; more rows overflow the mobile WebView's layout budget and the next page is one click away

/** Unchanged lines kept on each side of a changed block. */
export const TEXT_CONTEXT_LINES = 3;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function displayValue(value) {
    if (typeof value === 'string') return value;
    if (value === null) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function sideMeta(value) {
    if (value === undefined) return { chars: 0, bytes: 0, missing: true };
    const text = displayValue(value);
    return { chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), missing: false };
}

/**
 * Decide whether a field reads better as a line diff or as two value
 * cells. Only two existing multi-line strings get a line diff; an added
 * or removed field is one value and should not print a line map against
 * an empty side.
 *
 * @param {unknown} before
 * @param {unknown} after
 */
export function valueMeta(before, after) {
    const text = before !== undefined
        && after !== undefined
        && typeof before === 'string'
        && typeof after === 'string'
        && (before.includes('\n') || after.includes('\n'));
    return {
        kind: text ? 'text' : 'scalar',
        before: sideMeta(before),
        after: sideMeta(after),
    };
}

function isHighSurrogate(code) {
    return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Return one page of a value. The offset is a UTF-16 character offset;
 * a boundary in the middle of a surrogate pair moves back so the pair
 * stays readable on one page.
 *
 * @param {string | undefined} text
 * @param {number} offset
 */
export function cellPage(text, offset) {
    if (text === undefined) {
        return { text: '', chars: 0, bytes: 0, missing: true, nextOffset: null };
    }
    const full = String(text);
    const chars = full.length;
    const bytes = Buffer.byteLength(full, 'utf8');
    let start = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
    if (start > chars) start = chars;
    if (start > 0 && start < chars && isLowSurrogate(full.charCodeAt(start)) && isHighSurrogate(full.charCodeAt(start - 1))) {
        start -= 1;
    }
    let end = Math.min(chars, start + MAX_CELL_CHARS);
    if (end > start && end < chars && isHighSurrogate(full.charCodeAt(end - 1)) && isLowSurrogate(full.charCodeAt(end))) {
        end += 1;
    }
    return {
        text: full.slice(start, end),
        chars,
        bytes,
        missing: false,
        nextOffset: end < chars ? end : null,
    };
}

/**
 * Line diff rows with line numbers. Line numbers are 1-based and stay on
 * their own side, so a removed line and an added line can both read "42"
 * when a line was replaced.
 *
 * @param {string} left
 * @param {string} right
 * @returns {Array<{ kind: 'context' | 'removed' | 'added', leftLine?: number, rightLine?: number, text: string }>}
 */
export function lineRows(left, right) {
    const dmp = new DiffMatchPatch();
    const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(left, right);
    const diffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_charsToLines_(diffs, lineArray);

    const rows = [];
    let leftLine = 1;
    let rightLine = 1;
    const append = (kind, text) => {
        const lines = text.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        for (const line of lines) {
            rows.push({
                kind,
                text: line,
                ...(kind !== 'added' ? { leftLine } : {}),
                ...(kind !== 'removed' ? { rightLine } : {}),
            });
            if (kind !== 'added') leftLine += 1;
            if (kind !== 'removed') rightLine += 1;
        }
    };

    for (const [operation, text] of diffs) {
        if (operation === 0) append('context', text);
        else if (operation === -1) append('removed', text);
        else append('added', text);
    }
    return rows;
}

/** Keep changed rows and up to `TEXT_CONTEXT_LINES` unchanged rows around them. */
export function withContext(rows) {
    const changed = rows.map((row, index) => (row.kind === 'context' ? -1 : index)).filter(index => index >= 0);
    if (changed.length === 0) return [];
    const keep = new Set();
    for (const index of changed) {
        const start = Math.max(0, index - TEXT_CONTEXT_LINES);
        const end = Math.min(rows.length - 1, index + TEXT_CONTEXT_LINES);
        for (let cursor = start; cursor <= end; cursor++) keep.add(cursor);
    }
    const result = [];
    let skipped = 0;
    const flushSkipped = () => {
        if (skipped > 0) result.push({ kind: 'skipped', count: skipped });
        skipped = 0;
    };
    for (let index = 0; index < rows.length; index++) {
        if (!keep.has(index)) {
            skipped += 1;
            continue;
        }
        flushSkipped();
        result.push(rows[index]);
    }
    flushSkipped();
    return result;
}

/**
 * Split context-filtered rows into contiguous change blocks. Every block
 * becomes one expandable hunk in the tree.
 *
 * @param {Array<{ kind: string, leftLine?: number, rightLine?: number, text?: string, count?: number }>} rows
 * @returns {Array<{ rows: Array<object>, lines: { from: number, to: number } }>}
 */
export function lineHunks(rows) {
    const hunks = [];
    let current = [];
    const flush = () => {
        if (current.length === 0) return;
        const numbers = current.flatMap(row => [row.leftLine, row.rightLine].filter(number => number !== undefined));
        const from = numbers.length > 0 ? Math.min(...numbers) : 1;
        const to = numbers.length > 0 ? Math.max(...numbers) : from;
        hunks.push({ rows: current, lines: { from, to } });
        current = [];
    };
    for (const row of rows) {
        if (row.kind === 'skipped') {
            flush();
            continue;
        }
        current.push(row);
    }
    flush();
    return hunks;
}

/** Cut an individual line that is wider than one value cell. */
function cutLine(row) {
    const page = cellPage(row.text, 0);
    if (page.nextOffset === null) return { ...row, text: page.text };
    return { ...row, text: page.text, truncated: true, chars: page.chars, bytes: page.bytes };
}

/**
 * Return one page of line rows.
 *
 * @param {Array<object>} rows
 * @param {number} offset
 */
export function pageLines(rows, offset) {
    const start = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
    const page = rows.slice(start, start + MAX_LINE_ROWS).map(cutLine);
    return {
        rows: page,
        rowTotal: rows.length,
        nextOffset: start + MAX_LINE_ROWS < rows.length ? start + MAX_LINE_ROWS : null,
    };
}
