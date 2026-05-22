/**
 * iteration-library — inline text diff renderer.
 *
 * Side-by-side word/line-level LCS diff renderer. Plugin-owned popups
 * (CEA Character / CPA / MG Schema / Orchestrator) call
 * `renderInlineTextDiffHtml(before, after, options)` to surface
 * context-rich diffs for string-shape edits — they no longer have to
 * write any rendering code to get line numbers, splitter, expand-to-
 * fullscreen, and collapsible long-diff `<details>`.
 *
 * Originated in `extensions/orchestrator/line-diff.js`, lifted into the
 * iteration-studio shell as `inline-text-diff.js`, then deleted with the
 * shell in Stage 6 of the library overhaul. Re-introduced here as a
 * generic, i18n-injectable building block — no shell coupling, no
 * sibling `i18n.js` dependency. Pairs with `zoom-overlay.js`, which
 * popups call once via `attachZoomOverlay(popupRoot)`.
 *
 * CSS class prefix `luker_lib_diff_*` (renamed from `luker_iter_diff_*`
 * to make clear this is library-owned, not shell-owned). Class names and
 * data attributes were s/luker_iter_diff/luker_lib_diff/g across the
 * board; the CSS var `--luker-iter-split-left` became `--luker-lib-split-left`.
 */

const LINE_DIFF_LONG_CHAR_THRESHOLD = 900;
const LINE_DIFF_LONG_LINE_THRESHOLD = 18;
const LINE_DIFF_LCS_MAX_CELLS = 240000;

export const STYLESHEET_ID = 'luker_lib_diff_stylesheet';
export const STYLESHEET_HREF = '/scripts/iteration-library/text-diff.css';

/**
 * Lazily inject the text-diff stylesheet into `<head>`. Idempotent —
 * safe to call from every popup mount and from `renderInlineTextDiffHtml`
 * directly. No-ops in non-DOM environments (jest jsdom skips the inject
 * in `describe`-only blocks; tests that exercise the renderer get a real
 * jsdom document via the harness).
 */
export function ensureStylesheetInjected() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

/**
 * Coerce common "no value yet" placeholders to an empty string so a
 * `Not set` → `actual content` edit registers as an add-only diff rather
 * than a paired delete+insert with junk text on the left.
 */
export function sanitizeDiffPlaceholderValue(value) {
    const text = String(value ?? '');
    const normalized = text.trim();
    if (!normalized) {
        return '';
    }
    const notSetTokens = new Set([
        'Not set',
        '未设置',
        '未設定',
    ]);
    return notSetTokens.has(normalized) ? '' : text;
}

/** Backwards-compat alias kept exported for symmetry with the shell era. */
export function formatDiffValue(value) {
    return sanitizeDiffPlaceholderValue(value);
}

function splitLineDiffText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    return normalized.length > 0 ? normalized.split('\n') : [];
}

function buildLineDiffOperations(beforeLines, afterLines) {
    const a = Array.isArray(beforeLines) ? beforeLines : [];
    const b = Array.isArray(afterLines) ? afterLines : [];
    if (a.length === 0 && b.length === 0) {
        return [];
    }
    if (a.length === 0) {
        return [{ type: 'insert', lines: b.slice() }];
    }
    if (b.length === 0) {
        return [{ type: 'delete', lines: a.slice() }];
    }
    if ((a.length * b.length) > LINE_DIFF_LCS_MAX_CELLS) {
        // Inputs are too big for an O(n*m) LCS table; fall back to a
        // whole-side replace rather than blowing the heap.
        return [
            { type: 'delete', lines: a.slice() },
            { type: 'insert', lines: b.slice() },
        ];
    }

    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? (dp[i + 1][j + 1] + 1)
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const operations = [];
    const push = (type, line) => {
        const last = operations[operations.length - 1];
        if (last && last.type === type) {
            last.lines.push(line);
            return;
        }
        operations.push({ type, lines: [line] });
    };

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('equal', a[i]);
            i += 1;
            j += 1;
            continue;
        }
        if (dp[i + 1][j] >= dp[i][j + 1]) {
            push('delete', a[i]);
            i += 1;
            continue;
        }
        push('insert', b[j]);
        j += 1;
    }
    while (i < a.length) {
        push('delete', a[i]);
        i += 1;
    }
    while (j < b.length) {
        push('insert', b[j]);
        j += 1;
    }
    return operations;
}

function buildLineDiffRows(beforeValue, afterValue) {
    const beforeText = String(beforeValue ?? '');
    const afterText = String(afterValue ?? '');
    const operations = buildLineDiffOperations(splitLineDiffText(beforeText), splitLineDiffText(afterText));
    const stats = { added: 0, removed: 0, unchanged: 0 };

    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        for (const line of lines) {
            void line;
            if (type === 'insert') {
                stats.added += 1;
                continue;
            }
            if (type === 'delete') {
                stats.removed += 1;
                continue;
            }
            stats.unchanged += 1;
        }
    }

    const maxChars = Math.max(beforeText.length, afterText.length);
    const lineCount = stats.added + stats.removed + stats.unchanged;
    const isLong = lineCount > LINE_DIFF_LONG_LINE_THRESHOLD || maxChars > LINE_DIFF_LONG_CHAR_THRESHOLD;

    return {
        operations,
        added: stats.added,
        removed: stats.removed,
        unchanged: stats.unchanged,
        openByDefault: !isLong,
    };
}

function splitInlineDiffTokens(text) {
    const source = String(text ?? '');
    return source.length > 0 ? (source.match(/\s+|[^\s]+/g) || []) : [];
}

function renderInlineDiffHtml(beforeText, afterText, mode = 'old') {
    const beforeTokens = splitInlineDiffTokens(beforeText);
    const afterTokens = splitInlineDiffTokens(afterText);
    if (beforeTokens.length === 0 && afterTokens.length === 0) {
        return '&nbsp;';
    }
    if ((beforeTokens.length * afterTokens.length) > LINE_DIFF_LCS_MAX_CELLS) {
        const fallback = escapeHtml(mode === 'new' ? String(afterText ?? '') : String(beforeText ?? ''));
        return fallback.length > 0 ? fallback : '&nbsp;';
    }
    const operations = buildLineDiffOperations(beforeTokens, afterTokens);
    const chunks = [];
    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const tokenText = escapeHtml(String((Array.isArray(operation?.lines) ? operation.lines : []).join('')));
        if (!tokenText) {
            continue;
        }
        if (type === 'equal') {
            chunks.push(tokenText);
            continue;
        }
        if (type === 'delete') {
            if (mode === 'old') {
                chunks.push(`<span class="luker_lib_diff_word_del">${tokenText}</span>`);
            }
            continue;
        }
        if (type === 'insert') {
            if (mode === 'new') {
                chunks.push(`<span class="luker_lib_diff_word_add">${tokenText}</span>`);
            }
        }
    }
    return chunks.length > 0 ? chunks.join('') : '&nbsp;';
}

function buildLineDiffVisualRows(operations) {
    const rows = [];
    let beforeLineNo = 1;
    let afterLineNo = 1;
    const appendRow = (rowType, oldLine, oldHtml, newLine, newHtml) => {
        rows.push({
            rowType: String(rowType || ''),
            oldLine: String(oldLine || ''),
            oldHtml: String(oldHtml || '&nbsp;'),
            newLine: String(newLine || ''),
            newHtml: String(newHtml || '&nbsp;'),
        });
    };

    const safeOperations = Array.isArray(operations) ? operations : [];
    for (let index = 0; index < safeOperations.length; index++) {
        const operation = safeOperations[index];
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        const nextOperation = safeOperations[index + 1];
        if (type === 'delete' && String(nextOperation?.type || '') === 'insert') {
            // Coalesce paired delete+insert into mod rows so the user sees
            // before/after side-by-side rather than two stacked blocks.
            const insertLines = Array.isArray(nextOperation?.lines) ? nextOperation.lines : [];
            const pairCount = Math.min(lines.length, insertLines.length);
            for (let i = 0; i < pairCount; i++) {
                const beforeLine = String(lines[i] ?? '');
                const afterLine = String(insertLines[i] ?? '');
                appendRow(
                    'luker_lib_diff_row_mod',
                    String(beforeLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'old'),
                    String(afterLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'new'),
                );
                beforeLineNo += 1;
                afterLineNo += 1;
            }
            for (let i = pairCount; i < lines.length; i++) {
                const text = escapeHtml(String(lines[i] ?? '')) || '&nbsp;';
                appendRow('luker_lib_diff_row_del', String(beforeLineNo), text, '', '&nbsp;');
                beforeLineNo += 1;
            }
            for (let i = pairCount; i < insertLines.length; i++) {
                const text = escapeHtml(String(insertLines[i] ?? '')) || '&nbsp;';
                appendRow('luker_lib_diff_row_add', '', '&nbsp;', String(afterLineNo), text);
                afterLineNo += 1;
            }
            index += 1;
            continue;
        }
        for (const rawLine of lines) {
            const text = String(rawLine ?? '');
            const escapedText = text.length > 0 ? escapeHtml(text) : '&nbsp;';
            if (type === 'insert') {
                appendRow('luker_lib_diff_row_add', '', '&nbsp;', String(afterLineNo), escapedText);
                afterLineNo += 1;
                continue;
            }
            if (type === 'delete') {
                appendRow('luker_lib_diff_row_del', String(beforeLineNo), escapedText, '', '&nbsp;');
                beforeLineNo += 1;
                continue;
            }
            appendRow('luker_lib_diff_row_eq', String(beforeLineNo), escapedText, String(afterLineNo), escapedText);
            beforeLineNo += 1;
            afterLineNo += 1;
        }
    }
    if (rows.length === 0) {
        appendRow('luker_lib_diff_row_eq', '', '&nbsp;', '', '&nbsp;');
    }
    return rows;
}

function renderLineDiffSideRowsHtml(rows, side = 'old') {
    const safeRows = Array.isArray(rows) ? rows : [];
    const isOldSide = side !== 'new';
    return safeRows.map((row) => `
<tr class="luker_lib_diff_row ${escapeHtml(String(row?.rowType || ''))}">
    <td class="luker_lib_diff_ln ${isOldSide ? 'old' : 'new'}">${isOldSide ? escapeHtml(String(row?.oldLine || '')) : escapeHtml(String(row?.newLine || ''))}</td>
    <td class="luker_lib_diff_text ${isOldSide ? 'old' : 'new'}"><div class="luker_lib_diff_text_inner">${isOldSide ? String(row?.oldHtml || '&nbsp;') : String(row?.newHtml || '&nbsp;')}</div></td>
</tr>`).join('');
}

function defaultI18n(s) {
    return String(s ?? '');
}

function applyI18nFormat(template, ...values) {
    return String(template ?? '').replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

/**
 * Render an HTML `<details>` block containing a side-by-side word/line
 * LCS diff of `beforeValue` vs `afterValue`. The returned markup is safe
 * to embed via `innerHTML`; all user-provided text is HTML-escaped.
 *
 * @param {string|*} beforeValue  Text-coerced before-value.
 * @param {string|*} afterValue   Text-coerced after-value.
 * @param {Object|string} [optionsOrLabel]
 *   When an object: `{ fileLabel, i18n, expandAffordance }`.
 *   - `fileLabel` (default `'field'`) — surfaces in the zoom-overlay title
 *     and lands in `data-luker-lib-diff-label` for downstream tooling.
 *   - `i18n` (default identity) — `(s) => translated` lookup.
 *   - `expandAffordance` (default true) — when false, the summary's
 *     Expand button is omitted (still wires through zoom-overlay when
 *     present, so popups don't have to do anything special).
 *   - `forceOpen` (default false) — when true, the `<details>` is rendered
 *     `open` regardless of input length. Pending-preview callers want this
 *     so the user sees the diff inline; runtime-trace callers leave it
 *     false so long histories don't blow out vertically.
 *   When a string: treated as `fileLabel` for backward compatibility.
 */
export function renderInlineTextDiffHtml(beforeValue, afterValue, optionsOrLabel = {}) {
    ensureStylesheetInjected();
    const options = (typeof optionsOrLabel === 'string')
        ? { fileLabel: optionsOrLabel }
        : (optionsOrLabel && typeof optionsOrLabel === 'object' ? optionsOrLabel : {});
    const fileLabel = options.fileLabel || 'field';
    const i18n = typeof options.i18n === 'function' ? options.i18n : defaultI18n;
    const expandAffordance = options.expandAffordance !== false;
    const forceOpen = options.forceOpen === true;

    const payload = buildLineDiffRows(
        sanitizeDiffPlaceholderValue(beforeValue),
        sanitizeDiffPlaceholderValue(afterValue),
    );
    const summary = applyI18nFormat(i18n('Line diff (+${0} -${1})'), payload.added, payload.removed);
    const safeLabel = escapeHtml(String(fileLabel));
    const renderedRows = buildLineDiffVisualRows(payload.operations);
    const expandLabel = escapeHtml(i18n('Expand diff'));
    const resizeLabel = escapeHtml(i18n('Resize diff columns'));
    const expandBtnHtml = expandAffordance
        ? `<button type="button" class="menu_button menu_button_small luker_lib_diff_expand_btn" data-luker-lib-action="expand-line-diff" title="${expandLabel}" aria-label="${expandLabel}">
            <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
        </button>`
        : '';
    return `
<details class="luker_lib_diff"${(forceOpen || payload.openByDefault) ? ' open' : ''}>
    <summary>
        <span class="luker_lib_diff_summary_main">
            <span>${escapeHtml(summary)}</span>
            <span class="luker_lib_diff_meta">=${escapeHtml(String(payload.unchanged))}</span>
        </span>
        ${expandBtnHtml}
    </summary>
    <div class="luker_lib_diff_pre" data-luker-lib-diff-label="${safeLabel}">
        <div class="luker_lib_diff_dual" role="group">
            <div class="luker_lib_diff_side old">
                <div class="luker_lib_diff_side_scroll">
                    <table class="luker_lib_diff_table old" role="grid">
                        <tbody>${renderLineDiffSideRowsHtml(renderedRows, 'old')}</tbody>
                    </table>
                </div>
            </div>
            <div class="luker_lib_diff_splitter" role="separator" aria-orientation="vertical" aria-label="${resizeLabel}" title="${resizeLabel}"></div>
            <div class="luker_lib_diff_side new">
                <div class="luker_lib_diff_side_scroll">
                    <table class="luker_lib_diff_table new" role="grid">
                        <tbody>${renderLineDiffSideRowsHtml(renderedRows, 'new')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</details>`;
}
