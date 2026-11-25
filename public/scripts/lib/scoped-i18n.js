// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Translators bound to a private translation table.
 *
 *   buildScopedI18n({ tables, loadOrder, fallback }) → { t, translate, format, has }
 *     tables     { [localeId]: Record<string, string> }, copied at creation
 *     loadOrder  locale ids, lowest priority first
 *     fallback   (text, key) => string, used when the table holds no
 *                non-empty entry for the key
 *
 * Import-free apart from the placeholder formatter.
 */

import { formatTemplate } from './template-format.js';

const PLACEHOLDER_RE = /\$\{(\d+)\}/g;

export function buildScopedI18n({ tables, loadOrder, fallback }) {
    const merged = Object.create(null);
    for (const localeId of loadOrder || []) {
        const table = tables?.[localeId];
        if (!table || typeof table !== 'object') continue;
        for (const [key, value] of Object.entries(table)) {
            if (typeof value === 'string') merged[key] = value;
        }
    }

    function translate(text, key = null) {
        const lookupKey = key || text;
        const own = typeof lookupKey === 'string' && Object.hasOwn(merged, lookupKey) ? merged[lookupKey] : '';
        return own || fallback(text, key);
    }

    function t(strings, ...values) {
        const key = strings.reduce((result, string, i) => result + string + (values[i] !== undefined ? `\${${i}}` : ''), '');
        return translate(key).replace(PLACEHOLDER_RE, (match, index) => values[index]);
    }

    function format(template, ...values) {
        return formatTemplate(translate(template), ...values);
    }

    function has(key) {
        return typeof key === 'string' && Object.hasOwn(merged, key) && merged[key] !== '';
    }

    return Object.freeze({ t, translate, format, has });
}
