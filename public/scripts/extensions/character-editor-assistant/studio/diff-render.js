// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Line-diff renderer for the CardApp Studio adapter.
 *
 * Wraps diff-match-patch's line-mode diff into a small HTML rendering
 * helper. The shell calls this from `renderMessageCard` whenever an
 * applied edit needs an inline before/after preview.
 *
 * Import path mirrors `studio.js:9` — `DiffMatchPatch` is a named export
 * on `lib.js`, not a default export.
 */

import { DiffMatchPatch } from '../../../../lib.js';

const dmp = new DiffMatchPatch();

function escape(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Render a line-mode diff between two text blobs as a self-contained
 * HTML string. Equal regions render as `eq`, insertions as `add`,
 * deletions as `del`.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {string} HTML
 */
export function renderLineDiff(beforeText, afterText) {
    const a = dmp.diff_linesToChars_(beforeText || '', afterText || '');
    const diffs = dmp.diff_main(a.chars1, a.chars2, false);
    dmp.diff_charsToLines_(diffs, a.lineArray);
    let html = '<div class="luker-studio-line-diff">';
    for (const [op, text] of diffs) {
        const cls = op === 1 ? 'add' : op === -1 ? 'del' : 'eq';
        html += `<pre class="luker-studio-line-diff-row luker-studio-line-diff-${cls}">${escape(text)}</pre>`;
    }
    return html + '</div>';
}
