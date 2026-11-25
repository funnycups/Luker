// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Post-update "What's New" modal rendered with Workbench / lens-shared styles.
// Builds every DOM node through h() and textContent — never innerHTML.

import { h } from './lens-shared/util.js';
import { button, iconButton, sharedIcon } from './lens-shared/ui.js';
import { fitToViewport } from './lens-shared/viewport.js';
import { loadPrefs } from './workbench/prefs.js';

const TOKENS_CSS_ID = 'luker-lens-shared-tokens-css';
const WHATS_NEW_CSS_ID = 'lw-whats-new-css';
const DOCS_ORIGIN = 'https://luker.cups.moe';

let initialized = false;

/**
 * Resets module initialization guard for unit tests.
 */
export function resetWhatsNewInitForTests() {
    initialized = false;
}

function makeTranslator(translateFn) {
    const fn = typeof translateFn === 'function'
        ? translateFn
        : (key) => globalThis.Luker?.getContext?.()?.translate?.(key) ?? String(key ?? '');
    return (key, ...values) => String(fn(key) ?? key).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

/**
 * Lazy-loads lens-shared tokens and whats-new modal styles once per document.
 * @param {Document} [doc]
 */
export function ensureWhatsNewStyles(doc = globalThis.document) {
    const links = [];
    if (!doc?.head) return links;
    let tokensLink = doc.getElementById(TOKENS_CSS_ID) || doc.querySelector('link[href*="lens-shared/tokens.css"]');
    if (!tokensLink) {
        tokensLink = doc.createElement('link');
        tokensLink.id = TOKENS_CSS_ID;
        tokensLink.rel = 'stylesheet';
        tokensLink.href = new URL('./lens-shared/tokens.css', import.meta.url).href;
        doc.head.appendChild(tokensLink);
    }
    links.push(tokensLink);

    let wnLink = doc.getElementById(WHATS_NEW_CSS_ID) || doc.querySelector('link[href*="css/whats-new.css"]');
    if (!wnLink) {
        wnLink = doc.createElement('link');
        wnLink.id = WHATS_NEW_CSS_ID;
        wnLink.rel = 'stylesheet';
        wnLink.href = new URL('../css/whats-new.css', import.meta.url).href;
        doc.head.appendChild(wnLink);
    }
    links.push(wnLink);
    return links;
}

/**
 * Resolves the light/dark theme matching Workbench preferences and page theme.
 * @returns {'light' | 'dark'}
 */
export function resolveWhatsNewTheme() {
    const prefs = loadPrefs();
    if (prefs.theme === 'light' || prefs.theme === 'dark') {
        return prefs.theme;
    }
    const docTheme = globalThis.document?.documentElement?.dataset?.theme;
    if (docTheme === 'light' || docTheme === 'dark') {
        return docTheme;
    }
    return globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
}

/**
 * Validates and resolves a changelog URL. Root-relative `/...` paths point to
 * Luker's documentation host; any protocol other than `http:` / `https:` is rejected.
 * @param {string} rawHref
 * @returns {string | null}
 */
function resolveSafeHref(rawHref) {
    const trimmed = String(rawHref || '').trim();
    if (!trimmed) return null;
    try {
        const url = trimmed.startsWith('/') && !trimmed.startsWith('//')
            ? new URL(trimmed, DOCS_ORIGIN)
            : new URL(trimmed);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return null;
        }
        return url.href;
    } catch {
        return null;
    }
}

/**
 * Renders inline Markdown tokens (**bold**, `code`, [label](href), and bare https:// URLs)
 * into safe DOM nodes / strings without ever invoking innerHTML.
 * @param {string} text
 * @param {{ allowBold?: boolean }} [options]
 * @returns {Array<string | Node>}
 */
function renderInline(text, { allowBold = true } = {}) {
    const out = [];
    const tokenRe = allowBold
        ? /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:[^()\s]+|\([^()\s]*\))+\)|https?:\/\/[^\s<>]+)/g
        : /(`[^`]+`|\[[^\]]+\]\((?:[^()\s]+|\([^()\s]*\))+\)|https?:\/\/[^\s<>]+)/g;
    let last = 0;
    let match;

    while ((match = tokenRe.exec(text)) !== null) {
        if (match.index > last) {
            out.push(text.slice(last, match.index));
        }
        const token = match[0];
        if (allowBold && token.startsWith('**') && token.endsWith('**')) {
            out.push(h('strong', null, renderInline(token.slice(2, -2), { allowBold: false })));
        } else if (token.startsWith('`') && token.endsWith('`')) {
            out.push(h('code', { text: token.slice(1, -1) }));
        } else if (token.startsWith('[')) {
            const splitIdx = token.indexOf('](');
            const label = token.slice(1, splitIdx);
            const rawHref = token.slice(splitIdx + 2, -1);
            const safeHref = resolveSafeHref(rawHref);
            if (safeHref) {
                out.push(h('a', {
                    class: 'lw-link',
                    href: safeHref,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: label,
                }));
            } else {
                out.push(label);
            }
        } else {
            // Trim trailing sentence punctuation (and unmatched closing parens) from bare URLs.
            let clean = token.replace(/[.,;:!?。，；：！？]+$/, '');
            while (clean.endsWith(')') && (clean.match(/\(/g)?.length || 0) < (clean.match(/\)/g)?.length || 0)) {
                clean = clean.slice(0, -1);
            }
            const trailing = token.slice(clean.length);
            const safeHref = resolveSafeHref(clean);
            if (safeHref) {
                out.push(h('a', {
                    class: 'lw-link',
                    href: safeHref,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    text: clean,
                }));
            } else {
                out.push(clean);
            }
            if (trailing) out.push(trailing);
        }
        last = match.index + token.length;
    }

    if (last < text.length) {
        out.push(text.slice(last));
    }
    return out;
}

const INLINE_OR_VPRE_RE = /`[^`]+`|<span\s+v-pre\s*>|<span(?:\s[^>]*)?>|<\/span\s*>/gi;
const VPRE_OPEN_RE = /^<span\s+v-pre\s*>$/i;

/**
 * Unwraps VitePress `<span v-pre>...</span >` wrappers used to shield `{{...}}`
 * macro literals from Vue template compilation, while preserving inline code
 * spans and all other HTML tags verbatim.
 * @param {string} line
 * @returns {string}
 */
function stripVitePressVPre(line) {
    const str = String(line || '');
    let out = '';
    let last = 0;
    let openTag = null;
    let inner = '';
    let innerSpanDepth = 0;

    for (const match of str.matchAll(INLINE_OR_VPRE_RE)) {
        const token = match[0];
        const idx = match.index ?? 0;
        const between = str.slice(last, idx);

        if (openTag !== null) {
            inner += between;
        } else {
            out += between;
        }

        if (token.startsWith('`')) {
            if (openTag !== null) {
                inner += token;
            } else {
                out += token;
            }
        } else if (token.startsWith('</')) {
            if (openTag !== null) {
                if (innerSpanDepth > 0) {
                    innerSpanDepth -= 1;
                    inner += token;
                } else {
                    out += inner;
                    openTag = null;
                    inner = '';
                }
            } else {
                out += token;
            }
        } else if (VPRE_OPEN_RE.test(token)) {
            if (openTag !== null) {
                out += openTag + inner;
            }
            openTag = token;
            inner = '';
            innerSpanDepth = 0;
        } else if (openTag !== null) {
            innerSpanDepth += 1;
            inner += token;
        } else {
            out += token;
        }

        last = idx + token.length;
    }

    const tail = str.slice(last);
    return openTag !== null ? out + openTag + inner + tail : out + tail;
}

/**
 * Renders a changelog section's Markdown safely into DOM nodes.
 * @param {string} source
 * @returns {HTMLElement}
 */
export function renderChangelogMarkdown(source) {
    const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n').map(stripVitePressVPre);
    const root = h('div', { class: 'wn-md' });
    const listRe = /^\s*([-*•]|\d+[.)、])\s+/;
    const headingRe = /^#{1,4}\s+/;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        if (headingRe.test(line)) {
            root.appendChild(h('h4', null, renderInline(line.replace(headingRe, '').trim())));
            i++;
            continue;
        }
        if (listRe.test(line)) {
            const ordered = /^\s*\d/.test(line);
            const items = [];
            while (i < lines.length && listRe.test(lines[i])) {
                items.push(lines[i++].replace(listRe, ''));
            }
            root.appendChild(h(ordered ? 'ol' : 'ul', null, items.map(item => h('li', null, renderInline(item)))));
            continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() && !headingRe.test(lines[i]) && !listRe.test(lines[i])) {
            para.push(lines[i++].trim());
        }
        root.appendChild(h('p', null, renderInline(para.join(' '))));
    }

    return root;
}

/**
 * Mounts and displays the Workbench-styled post-update modal.
 * Resolves after dismissal and any `onAck` callback finish.
 * @param {Record<string, any>} payload
 * @param {{ onAck?: () => Promise<void> | void, host?: HTMLElement, translate?: (key: string) => string }} [options]
 * @returns {Promise<void>}
 */
export function showWhatsNewModal(payload, { onAck = null, host = document.body, translate = null } = {}) {
    const doc = host?.ownerDocument || document;
    const styleLinks = ensureWhatsNewStyles(doc);
    const tr = makeTranslator(translate);
    const isDev = payload?.kind === 'dev';

    const titleText = isDev
        ? tr('Updated to Luker dev build ${0}', payload.currentRevision || payload.currentVersion)
        : tr('Updated to Luker v${0}', payload.currentVersion);

    const pills = [];
    if (isDev && payload.previousRevision && payload.currentRevision) {
        pills.push(h('span', {
            class: 'lw-pilltag wn-range-pill',
            text: `${payload.previousRevision} → ${payload.currentRevision}`,
        }));
        if (payload.currentVersion) {
            pills.push(h('span', { class: 'lw-pilltag', text: `v${payload.currentVersion}` }));
        }
    } else if (payload.previousVersion && payload.currentVersion) {
        pills.push(h('span', {
            class: 'lw-pilltag wn-range-pill',
            text: `v${payload.previousVersion} → v${payload.currentVersion}`,
        }));
    }

    const sections = Array.isArray(payload?.sections) ? payload.sections : [];
    const bodyChildren = sections.length > 0
        ? sections.map((section) => {
            const headChildren = section.unreleased
                ? [h('span', { class: 'lw-pilltag is-warn', text: tr('Unreleased') })]
                : [
                    h('span', { class: 'wn-version-label', text: `v${section.version}` }),
                    section.date ? h('span', { class: 'wn-version-date', text: section.date }) : null,
                ];
            return h('section', { class: 'wn-version' },
                h('div', { class: 'wn-version-head' }, headChildren),
                renderChangelogMarkdown(section.markdown));
        })
        : [
            h('p', {
                class: 'wn-empty-note',
                text: isDev
                    ? tr('Your Luker installation has been updated to the latest dev build.')
                    : tr('Your Luker installation has been updated to v${0}.', payload.currentVersion),
            }),
        ];

    const footerLinks = [];
    const safeChangelogUrl = resolveSafeHref(payload?.changelogUrl);
    if (safeChangelogUrl) {
        footerLinks.push(h('a', {
            class: 'lw-link wn-changelog-link',
            href: safeChangelogUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: `${tr('View full changelog')} ↗`,
        }));
    }
    const safeCompareUrl = resolveSafeHref(payload?.compareUrl);
    if (safeCompareUrl) {
        footerLinks.push(h('a', {
            class: 'lw-link wn-compare-link',
            href: safeCompareUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: `${tr('View commit diff')} ↗`,
        }));
    }

    const returnFocus = doc.activeElement;
    let settled = false;
    let viewportFit = null;
    const pendingStyleCleanups = [];

    return new Promise((resolve) => {
        const focusableSelector = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

        const onDocumentKeydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                void dismiss();
                return;
            }
            if (event.key === 'Tab') {
                const focusables = Array.from(panel.querySelectorAll(focusableSelector));
                if (focusables.length === 0) {
                    event.preventDefault();
                    panel.focus({ preventScroll: true });
                    return;
                }
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                const active = doc.activeElement;
                if (event.shiftKey) {
                    if (active === first || !panel.contains(active) || active === panel) {
                        event.preventDefault();
                        event.stopPropagation();
                        /** @type {HTMLElement} */ (last).focus({ preventScroll: true });
                    }
                } else if (active === last || !panel.contains(active) || active === panel) {
                    event.preventDefault();
                    event.stopPropagation();
                    /** @type {HTMLElement} */ (first).focus({ preventScroll: true });
                }
            }
        };

        const dismiss = async () => {
            if (settled) return;
            settled = true;
            for (const cleanup of pendingStyleCleanups) cleanup();
            pendingStyleCleanups.length = 0;
            viewportFit?.destroy();
            viewportFit = null;
            doc.removeEventListener('keydown', onDocumentKeydown, true);
            backdrop.remove();
            if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
                returnFocus.focus({ preventScroll: true });
            }
            if (typeof onAck === 'function') {
                try {
                    await onAck();
                } catch (error) {
                    console.error('[whats-new] Failed to acknowledge update notice:', error);
                    if (globalThis.toastr?.error) {
                        globalThis.toastr.error(tr('Failed to save update notice state'), tr('Update Notice'));
                    }
                }
            }
            resolve();
        };

        const closeBtn = iconButton('x', tr('Close'), () => { void dismiss(); });
        const gotItBtn = button(tr('Got it'), () => { void dismiss(); }, { primary: true });

        const panel = h('div', {
            class: 'lw-dialog wn-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': titleText,
            tabIndex: -1,
        },
        h('header', { class: 'lw-dialog-head wn-head' },
            h('span', { class: 'wn-head-badge', 'aria-hidden': 'true' }, sharedIcon('check', { size: 15 })),
            h('div', { class: 'wn-head-main' },
                h('h3', { class: 'lw-dialog-title wn-title', text: titleText }),
                pills.length > 0 ? h('div', { class: 'wn-meta-pills' }, pills) : null),
            closeBtn),
        h('div', { class: 'lw-dialog-body wn-body' }, bodyChildren),
        h('footer', { class: 'lw-dialog-foot wn-foot' },
            h('div', { class: 'wn-foot-links' }, footerLinks),
            gotItBtn));

        const backdrop = h('div', {
            class: 'lw-dialog-backdrop lw-surface wn-backdrop',
            dataset: { theme: resolveWhatsNewTheme() },
            onMousedown: (event) => {
                if (event.target === backdrop) void dismiss();
            },
        }, panel);

        doc.addEventListener('keydown', onDocumentKeydown, true);
        host.appendChild(backdrop);
        if (host === doc.body) {
            backdrop.style.position = 'fixed';
            viewportFit = fitToViewport(backdrop, { resetAnimation: false });
            for (const link of styleLinks) {
                if (!link.sheet) {
                    const onLoad = () => viewportFit?.refresh();
                    link.addEventListener('load', onLoad, { once: true });
                    pendingStyleCleanups.push(() => link.removeEventListener('load', onLoad));
                }
            }
        }
        globalThis.requestAnimationFrame?.(() => panel.focus({ preventScroll: true }));
    });
}

/**
 * Checks whether the running Luker version/revision updated since the user's
 * last visit and displays the post-update modal after critical announcements settle.
 * @param {{ getRequestHeaders: () => Record<string, string>, getLocale: () => string, translate?: (key: string) => string, waitForAnnouncements?: () => Promise<void>, fetchImpl?: typeof fetch }} options
 * @returns {Promise<void>}
 */
export function initWhatsNew({
    getRequestHeaders,
    getLocale,
    translate = null,
    waitForAnnouncements = null,
    fetchImpl = globalThis.fetch,
}) {
    if (initialized) return Promise.resolve();
    initialized = true;

    return (async () => {
        try {
            if (typeof waitForAnnouncements === 'function') {
                await Promise.resolve(waitForAnnouncements()).catch(() => undefined);
            }
            const response = await fetchImpl('/api/users/whats-new', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ locale: getLocale() }),
            });
            if (!response.ok) {
                throw new Error(`/api/users/whats-new -> ${response.status}`);
            }
            const payload = await response.json();
            if (!payload?.show) {
                return;
            }
            await showWhatsNewModal(payload, {
                translate,
                onAck: async () => {
                    const ackResponse = await fetchImpl('/api/users/whats-new/ack', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({
                            version: payload.currentVersion,
                            revision: payload.currentRevision ?? null,
                        }),
                    });
                    if (!ackResponse.ok) {
                        throw new Error(`/api/users/whats-new/ack -> ${ackResponse.status}`);
                    }
                },
            });
        } catch (error) {
            console.error('[whats-new] init failed:', error);
        }
    })();
}
