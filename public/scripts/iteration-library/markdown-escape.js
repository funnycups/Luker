// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Helpers for safely interpolating raw literals into strings that will
 * later be rendered through a markdown engine (showdown/marked) — e.g.
 * the iter-studio chat bubble renderer in `ui/message.js`, which feeds
 * `role: 'system'` bodies straight through `renderMessageMarkdown`.
 *
 * Without escaping, dynamic values like `system_prompt`, `__proto__`,
 * `lorebook:My_Book`, file paths with underscores, or backend error
 * messages containing backticks (`` `model_not_found` ``) get
 * reinterpreted as italic / bold / inline code spans — the surrounding
 * characters disappear and the rest of the bubble can switch into the
 * wrong typeface mid-sentence.
 *
 * Plugins should wrap any dynamic value at the call site BEFORE it is
 * passed into a `tf('Apply failed (${0}): ${1}', target, err.message)`
 * style template, since the template itself interpolates as a plain
 * string before reaching the markdown pass.
 */

/**
 * Wrap a literal value in markdown inline code so the bubble renderer
 * preserves every character verbatim. Picks a backtick fence longer
 * than any backtick run already in the text so internal backticks
 * survive; pads with a single space when content starts or ends with
 * a backtick (GFM requirement).
 *
 * Empty / null / undefined input renders as `` `(empty)` `` so callers
 * never produce an unterminated code span by accident.
 *
 * @param {*} text
 * @returns {string}
 */
export function mdLiteral(text) {
    const s = String(text ?? '');
    if (!s) return '`(empty)`';
    let max = 0, cur = 0;
    for (const c of s) {
        if (c === '`') { cur++; if (cur > max) max = cur; } else cur = 0;
    }
    const fence = '`'.repeat(max + 1);
    const needsPad = s.startsWith('`') || s.endsWith('`');
    return needsPad ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}
