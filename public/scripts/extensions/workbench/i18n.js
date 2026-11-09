// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Translation helpers for the workbench. Keys are the English source strings;
// the tables live in locale-data.js.

export const i18n = (text) => Luker.getContext().translate(text);

export const i18nFormat = (key, ...values) => i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));

/** Separator for inline lists: an ideographic comma in Chinese locales. */
export function listSeparator() {
    return String(Luker.getContext().getCurrentLocale() || '').toLowerCase().startsWith('zh') ? '、' : ', ';
}
