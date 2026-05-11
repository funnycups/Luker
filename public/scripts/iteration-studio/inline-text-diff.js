/**
 * IterationStudio — inline text diff renderer.
 *
 * Side-by-side word/line-level diff renderer used by the shell as the
 * default `renderTextDiff` for all adapters. Adapters that opt into the
 * default get the full UX (line numbers, splitter, expand-to-fullscreen,
 * collapsible long-diff `<details>`) without writing any rendering code.
 *
 * Originated from `extensions/orchestrator/line-diff.js`; class names are
 * left as `luker_orch_line_diff_*` for stability across the orchestrator's
 * existing runtime-trace consumer and the existing CSS migrations. They
 * are no longer orchestrator-specific despite the prefix.
 *
 * Pairs with `iteration-studio/zoom-overlay.js` (DOM event handlers for the
 * Expand / Esc / Splitter affordances) which the shell binds once per popup
 * via the standard onOpen hook.
 */

import { i18n, i18nFormat } from './i18n.js';

const LINE_DIFF_LONG_CHAR_THRESHOLD = 900;
const LINE_DIFF_LONG_LINE_THRESHOLD = 18;
const LINE_DIFF_LCS_MAX_CELLS = 240000;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

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
                chunks.push(`<span class="luker_orch_line_diff_word_del">${tokenText}</span>`);
            }
            continue;
        }
        if (type === 'insert') {
            if (mode === 'new') {
                chunks.push(`<span class="luker_orch_line_diff_word_add">${tokenText}</span>`);
            }
        }
    }
    return chunks.length > 0 ? chunks.join('') : '&nbsp;';
}

function buildIterationLineDiffVisualRows(operations) {
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
            const insertLines = Array.isArray(nextOperation?.lines) ? nextOperation.lines : [];
            const pairCount = Math.min(lines.length, insertLines.length);
            for (let i = 0; i < pairCount; i++) {
                const beforeLine = String(lines[i] ?? '');
                const afterLine = String(insertLines[i] ?? '');
                appendRow(
                    'luker_orch_line_diff_row_mod',
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
                appendRow('luker_orch_line_diff_row_del', String(beforeLineNo), text, '', '&nbsp;');
                beforeLineNo += 1;
            }
            for (let i = pairCount; i < insertLines.length; i++) {
                const text = escapeHtml(String(insertLines[i] ?? '')) || '&nbsp;';
                appendRow('luker_orch_line_diff_row_add', '', '&nbsp;', String(afterLineNo), text);
                afterLineNo += 1;
            }
            index += 1;
            continue;
        }
        for (const rawLine of lines) {
            const text = String(rawLine ?? '');
            const escapedText = text.length > 0 ? escapeHtml(text) : '&nbsp;';
            if (type === 'insert') {
                appendRow('luker_orch_line_diff_row_add', '', '&nbsp;', String(afterLineNo), escapedText);
                afterLineNo += 1;
                continue;
            }
            if (type === 'delete') {
                appendRow('luker_orch_line_diff_row_del', String(beforeLineNo), escapedText, '', '&nbsp;');
                beforeLineNo += 1;
                continue;
            }
            appendRow('luker_orch_line_diff_row_eq', String(beforeLineNo), escapedText, String(afterLineNo), escapedText);
            beforeLineNo += 1;
            afterLineNo += 1;
        }
    }
    if (rows.length === 0) {
        appendRow('luker_orch_line_diff_row_eq', '', '&nbsp;', '', '&nbsp;');
    }
    return rows;
}

function renderIterationLineDiffSideRowsHtml(rows, side = 'old') {
    const safeRows = Array.isArray(rows) ? rows : [];
    const isOldSide = side !== 'new';
    return safeRows.map((row) => `
<tr class="luker_orch_line_diff_row ${escapeHtml(String(row?.rowType || ''))}">
    <td class="luker_orch_line_diff_ln ${isOldSide ? 'old' : 'new'}">${isOldSide ? escapeHtml(String(row?.oldLine || '')) : escapeHtml(String(row?.newLine || ''))}</td>
    <td class="luker_orch_line_diff_text ${isOldSide ? 'old' : 'new'}"><div class="luker_orch_line_diff_text_inner">${isOldSide ? String(row?.oldHtml || '&nbsp;') : String(row?.newHtml || '&nbsp;')}</div></td>
</tr>`).join('');
}

export function renderInlineTextDiffHtml(beforeValue, afterValue, fileLabel = 'field') {
    const payload = buildLineDiffRows(
        sanitizeDiffPlaceholderValue(beforeValue),
        sanitizeDiffPlaceholderValue(afterValue),
    );
    const summary = i18nFormat('Line diff (+${0} -${1})', payload.added, payload.removed);
    const safeLabel = escapeHtml(String(fileLabel || 'field'));
    const renderedRows = buildIterationLineDiffVisualRows(payload.operations);
    const expandLabel = escapeHtml(i18n('Expand diff'));
    const resizeLabel = escapeHtml(i18n('Resize diff columns'));
    return `
<details class="luker_orch_line_diff"${payload.openByDefault ? ' open' : ''}>
    <summary>
        <span class="luker_orch_line_diff_summary_main">
            <span>${escapeHtml(summary)}</span>
            <span class="luker_orch_line_diff_meta">=${escapeHtml(String(payload.unchanged))}</span>
        </span>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_expand_btn" data-luker-orch-action="expand-line-diff" title="${expandLabel}" aria-label="${expandLabel}">
            <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
        </button>
    </summary>
    <div class="luker_orch_line_diff_pre" data-luker-orch-diff-label="${safeLabel}">
        <div class="luker_orch_line_diff_dual" role="group">
            <div class="luker_orch_line_diff_side old">
                <div class="luker_orch_line_diff_side_scroll">
                    <table class="luker_orch_line_diff_table old" role="grid">
                        <tbody>${renderIterationLineDiffSideRowsHtml(renderedRows, 'old')}</tbody>
                    </table>
                </div>
            </div>
            <div class="luker_orch_line_diff_splitter" role="separator" aria-orientation="vertical" aria-label="${resizeLabel}" title="${resizeLabel}"></div>
            <div class="luker_orch_line_diff_side new">
                <div class="luker_orch_line_diff_side_scroll">
                    <table class="luker_orch_line_diff_table new" role="grid">
                        <tbody>${renderIterationLineDiffSideRowsHtml(renderedRows, 'new')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</details>`;
}
