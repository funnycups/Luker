// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * `${N}` placeholder filling for i18n templates.
 *
 *   formatTemplate(template, ...values)
 *     Replaces every `${N}` with `String(values[N] ?? '')`.
 *
 *   formatWithI18n(i18n, template, ...values)
 *     For callers handed either a plain lookup `t(s)` or a formatter
 *     `tf(s, ...values)`: calls `i18n(template, ...values)`, falls back to
 *     the source template when the result is empty or not a string, then
 *     fills any placeholders still present.
 *
 * Import-free.
 */

const PLACEHOLDER_RE = /\$\{(\d+)\}/g;

export function formatTemplate(template, ...values) {
    return String(template ?? '').replace(PLACEHOLDER_RE, (_, idx) => String(values[Number(idx)] ?? ''));
}

export function formatWithI18n(i18n, template, ...values) {
    if (typeof i18n !== 'function') {
        return formatTemplate(template, ...values);
    }
    const translated = i18n(template, ...values);
    const base = (typeof translated === 'string' && translated.length > 0) ? translated : String(template ?? '');
    return formatTemplate(base, ...values);
}
