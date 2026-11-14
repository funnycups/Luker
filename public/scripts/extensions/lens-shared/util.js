// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DOM and formatting helpers shared by the lens workspaces. All text goes
// through textContent; nothing here assigns untrusted strings to innerHTML
// (node content is LLM output).

const i18n = (text) => Luker.getContext().translate(text);
const i18nFormat = (key, ...values) => i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));

export function h(tag, props = null, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'class') el.className = value;
            else if (key === 'text') el.textContent = String(value);
            else if (key === 'dataset') Object.assign(el.dataset, value);
            else if (key === 'style' && typeof value === 'object') {
                for (const [prop, styleValue] of Object.entries(value)) {
                    if (prop.startsWith('--')) el.style.setProperty(prop, String(styleValue));
                    else el.style[prop] = styleValue;
                }
            } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
            else if (value === true) el.setAttribute(key, '');
            else el.setAttribute(key, String(value));
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(el, child);
        else if (child instanceof Node) el.appendChild(child);
        else el.appendChild(document.createTextNode(String(child)));
    }
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

/**
 * Null-safe append. Native Element.append() stringifies null/undefined
 * into literal "null" text nodes; this skips them (and flattens arrays).
 */
export function put(el, ...children) {
    append(el, children);
    return el;
}

export function debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

export function truncate(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

/** Stable 32-bit FNV-1a hash, used for deterministic colors and layout jitter. */
export function hashString(text) {
    let hash = 0x811c9dc5;
    const value = String(text ?? '');
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/** First visible glyph of a name, upper-cased for Latin scripts. */
export function initialOf(text) {
    const value = String(text ?? '').trim();
    if (!value) return '?';
    const first = Array.from(value)[0];
    return first.toUpperCase();
}

/**
 * @param {Date|number|string} date
 * @param {{ seconds?: boolean }} [options] seconds: false renders HH:MM
 */
export function formatTime(date, { seconds = true } = {}) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return seconds ? `${clock}:${pad(d.getSeconds())}` : clock;
}

/** "just now" / "12 min ago" / "yesterday 23:40" / "3 days ago". */
export function relativeTime(at, now = Date.now()) {
    const t = Number(at) || 0;
    if (!t) return '';
    const diff = Math.max(0, now - t);
    if (diff < 60e3) return i18n('just now');
    if (diff < 3600e3) return i18nFormat('${0} min ago', Math.floor(diff / 60e3));
    const d = new Date(t);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (t >= today.getTime()) return i18nFormat('${0} hr ago', Math.floor(diff / 3600e3));
    if (t >= today.getTime() - 86400e3) return i18nFormat('yesterday ${0}', formatTime(d, { seconds: false }));
    const days = Math.ceil((today.getTime() - t) / 86400e3);
    return days < 7 ? i18nFormat('${0} days ago', days) : i18nFormat('${0}/${1}', d.getMonth() + 1, d.getDate());
}

/** 1234 -> "1.2k", 15300 -> "15k". */
export function formatTokens(n) {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (v < 1000) return String(v);
    if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    if (v < 1000000) return `${Math.round(v / 1000)}k`;
    return `${(v / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatDuration(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v < 1000) return `${Math.round(v)}ms`;
    return `${(v / 1000).toFixed(1)}s`;
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(String(text));
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = String(text);
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        area.remove();
        return ok;
    }
}

export function prefersReducedMotion() {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}
