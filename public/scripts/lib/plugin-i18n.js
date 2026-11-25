// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Scoped translator for a Luker plugin's own tables.
 *
 *   createPluginI18n(tables) → { t, translate, format, has }
 *
 * Resolves `Luker.getContext().createScopedI18n(tables)` on the first lookup
 * that finds the factory and keeps that translator, so a plugin module can
 * create it at import time. While the factory is unavailable (before the
 * context exists, unit tests with a partial context) lookups return the
 * source text and the next lookup tries again.
 */

import { buildScopedI18n } from './scoped-i18n.js';

function untranslated(text) {
    return text ?? '';
}

const UNTRANSLATED = buildScopedI18n({ tables: {}, loadOrder: [], fallback: untranslated });

export function createPluginI18n(tables) {
    let scoped = null;
    const resolve = () => {
        if (scoped) return scoped;
        const context = globalThis.Luker?.getContext?.();
        if (typeof context?.createScopedI18n !== 'function') return UNTRANSLATED;
        scoped = context.createScopedI18n(tables);
        return scoped;
    };
    return Object.freeze({
        t: (strings, ...values) => resolve().t(strings, ...values),
        translate: (text, key = null) => resolve().translate(text, key),
        format: (template, ...values) => resolve().format(template, ...values),
        has: key => resolve().has(key),
    });
}
