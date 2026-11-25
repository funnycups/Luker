// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * HTML escaping for strings interpolated into template-string markup.
 *
 *   escapeHtml(value)      element content and quoted attribute values
 *                          (& < > " ').
 *   escapeHtmlText(value)  element content only (& < >). Quotes stay
 *                          readable, so it must never feed an attribute.
 *
 * Both coerce with `String(value ?? '')`. Import-free so every layer
 * (lib, iteration-library, skills, plugins) can use it.
 */

const HTML_ESCAPE_MAP = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
});

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

export function escapeHtmlText(value) {
    return String(value ?? '').replace(/[&<>]/g, (c) => HTML_ESCAPE_MAP[c]);
}
