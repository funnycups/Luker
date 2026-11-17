// SPDX-License-Identifier: AGPL-3.0-or-later

export function i18n(text) {
    const raw = String(text ?? '');
    if (!raw) return '';
    const translate = globalThis.Luker?.getContext?.()?.translate;
    return typeof translate === 'function' ? String(translate(raw) ?? raw) : raw;
}

export function i18nFormat(key, ...values) {
    return i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}
