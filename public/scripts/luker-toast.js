// SPDX-License-Identifier: AGPL-3.0-or-later
// Modern drop-in replacement for window.toastr in Luker.
// Zero external dependencies and zero circular imports from app modules.

import {
    DRAG_THRESHOLD_PX,
    VIEWPORT_EDGE_MARGIN_PX,
    clampToastPosition,
    computeAnchoredRect,
    computeDeckLayout,
    computeParkedCapsulePositions,
    resolveToastPolicy,
    extractCapsuleLabel,
} from './luker-toast-layout.js';

const TOASTR_VERSION = '2.1.4-luker';
const DECK_COLLAPSE_GRACE_MS = 180;
const FLOATING_BASE_Z_INDEX = 200;
const DRAGGING_Z_INDEX = 10000;
const CALLER_FOCUS_HOLD_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const INTERACTIVE_DRAG_EXCLUDE_SELECTOR = 'button, a, input, select, textarea, label, [role="button"], .action-loader-stop, .luker-toast-stop-button, .prompt-manager-toggle-undo-button';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.3 2.3 4.7-4.8"/>',
    warning: '<path d="M12 4 2.5 20h19zM12 10v4.2M12 17.2h.01"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    spinner: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/>',
    minimize: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
};

const KNOWN_POSITION_CLASSES = [
    'toast-top-left',
    'toast-top-center',
    'toast-top-right',
    'toast-bottom-left',
    'toast-bottom-center',
    'toast-bottom-right',
    'toast-top-full-width',
    'toast-bottom-full-width',
];

function getDefaultOptions() {
    return {
        tapToDismiss: true,
        toastClass: 'toast',
        containerId: 'toast-container',
        debug: false,
        showMethod: 'fadeIn',
        showDuration: 250,
        showEasing: 'linear',
        onShown: undefined,
        hideMethod: 'fadeOut',
        hideDuration: 200,
        hideEasing: 'linear',
        onHidden: undefined,
        closeMethod: false,
        closeDuration: false,
        closeEasing: false,
        closeOnHover: true,
        extendedTimeOut: 1000,
        iconClasses: {
            error: 'toast-error',
            info: 'toast-info',
            success: 'toast-success',
            warning: 'toast-warning',
        },
        iconClass: 'toast-info',
        positionClass: 'toast-top-right',
        timeOut: 5000,
        titleClass: 'toast-title',
        messageClass: 'toast-message',
        escapeHtml: false,
        target: 'body',
        closeHtml: '<button type="button">&times;</button>',
        closeClass: 'toast-close-button',
        newestOnTop: true,
        preventDuplicates: false,
        progressBar: false,
        progressClass: 'toast-progress',
        rtl: false,
        onclick: undefined,
        onCloseClick: undefined,
    };
}

/**
 * @param {string} pathMarkup
 * @param {string} className
 * @returns {SVGSVGElement}
 */
function createSvgIcon(pathMarkup, className) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    svg.innerHTML = pathMarkup;
    return svg;
}

/**
 * Wraps an HTMLElement in real jQuery when loaded in the host environment.
 * Falls back to a minimal array-like wrapper only when real jQuery is absent.
 *
 * @param {HTMLElement | null} el
 */
function wrapJQuery(el) {
    const jq = globalThis.jQuery;
    if (typeof jq === 'function' && jq.fn && jq.fn.jquery) {
        return el ? jq(el) : jq();
    }
    return el ? [el] : [];
}

/**
 * Unwraps a jQuery object or raw HTMLElement into an HTMLElement.
 *
 * @param {any} candidate
 * @returns {HTMLElement | null}
 */
function unwrapElement(candidate) {
    if (!candidate) return null;
    if (typeof Element !== 'undefined' && candidate instanceof Element) {
        return /** @type {HTMLElement} */ (candidate);
    }
    if (typeof candidate === 'object' && candidate[0] && typeof Element !== 'undefined' && candidate[0] instanceof Element) {
        return /** @type {HTMLElement} */ (candidate[0]);
    }
    return null;
}

/**
 * Finds the topmost open non-closing `<dialog>` modal in the document.
 *
 * @returns {HTMLElement | null}
 */
function getTopmostOpenDialog() {
    if (typeof document === 'undefined') return null;
    const dialogs = Array.from(document.querySelectorAll('dialog[open]:not([closing])'));
    const top = dialogs.pop();
    return top instanceof HTMLElement ? top : null;
}

/**
 * Reads viewport dimensions using visualViewport when available.
 *
 * @returns {{ width: number, height: number }}
 */
function getViewportSize() {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const width = (vv && Number.isFinite(vv.width) && vv.width > 0)
        ? vv.width
        : (typeof window !== 'undefined' ? window.innerWidth : 1024);
    const height = (vv && Number.isFinite(vv.height) && vv.height > 0)
        ? vv.height
        : (typeof window !== 'undefined' ? window.innerHeight : 768);
    return { width, height };
}

/**
 * Computes the safe top viewport inset below Luker's fixed top bar (and below
 * the centered activity pill on narrow screens).
 *
 * @returns {number}
 */
function getTopSafeInset() {
    let inset = VIEWPORT_EDGE_MARGIN_PX;
    if (typeof document === 'undefined') return inset;

    const topBar = document.querySelector('#top-settings-holder') || document.querySelector('#top-bar');
    if (topBar instanceof HTMLElement) {
        const rect = topBar.getBoundingClientRect?.();
        if (rect && Number.isFinite(rect.bottom) && rect.bottom > 0) {
            inset = Math.max(inset, Math.ceil(rect.bottom) + 6);
        }
    }

    const { width } = getViewportSize();
    if (width <= 720 && document.body?.classList.contains('activity-pill-visible')) {
        const pillHost = document.querySelector('.activity-pill-host');
        if (pillHost instanceof HTMLElement) {
            const pillRect = pillHost.getBoundingClientRect?.();
            if (pillRect && Number.isFinite(pillRect.bottom) && pillRect.bottom > 0) {
                inset = Math.max(inset, Math.ceil(pillRect.bottom) + 8);
            }
        }
    }

    return inset;
}

/**
 * Creates a self-contained modern toast engine instance exposing a drop-in
 * `toastr` object plus lifecycle helpers.
 */
export function createToastEngine() {
    /** @type {Record<string, any>} */
    let userOptions = {};
    /** @type {((args: any) => void) | null} */
    let subscriber = null;
    /** @type {((key: string) => string) | null} */
    let translator = null;

    let toastSeq = 0;
    let floatingZSeq = 0;

    /** @type {Map<HTMLElement, any>} */
    const entries = new Map();
    /** @type {HTMLElement | null} */
    let containerEl = null;
    /** @type {MutationObserver | null} */
    let containerObserver = null;
    /** @type {HTMLButtonElement | null} */
    let stackBadgeEl = null;

    let deckHovered = false;
    let deckPinned = false;
    let lastNonMousePointerAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let collapseGraceTimer = null;

    /** @type {any} */
    let activeDrag = null;
    let resizeListenersBound = false;
    let outsideClickBound = false;
    let resizeRafId = 0;
    let suppressedContainerObserver = false;

    function tr(key) {
        if (typeof translator === 'function') {
            try {
                const localized = translator(key);
                if (typeof localized === 'string' && localized.length > 0) {
                    return localized;
                }
            } catch (err) {
                console.error('[luker-toast] Custom translator threw an error:', err);
            }
        }
        const ctxTranslate = globalThis.Luker?.getContext?.()?.translate;
        if (typeof ctxTranslate === 'function') {
            const localized = ctxTranslate(key);
            if (typeof localized === 'string' && localized.length > 0) {
                return localized;
            }
        }
        return String(key);
    }

    function getResolvedOptions(optionsOverride) {
        const defaults = getDefaultOptions();
        return {
            ...defaults,
            ...userOptions,
            ...(optionsOverride || {}),
            iconClasses: {
                ...defaults.iconClasses,
                ...(userOptions?.iconClasses || {}),
                ...(optionsOverride?.iconClasses || {}),
            },
        };
    }

    function publish(args) {
        if (typeof subscriber === 'function') {
            try {
                subscriber(args);
            } catch (error) {
                console.error('[luker-toast] subscriber error:', error);
            }
        }
    }

    function getActivePositionClass(container) {
        const fromDom = container
            ? KNOWN_POSITION_CLASSES.find(cls => container.classList.contains(cls))
            : null;
        return fromDom || userOptions.positionClass || getDefaultOptions().positionClass;
    }

    function isDeckExpanded() {
        return (deckHovered || deckPinned) && getDockedEntries().length >= 2;
    }

    function getDockedEntries() {
        const list = [];
        for (const entry of entries.values()) {
            if (!entry.exiting && entry.state === 'docked') {
                list.push(entry);
            }
        }
        // Order: newestOnTop puts higher id at index 0; otherwise lower id at index 0.
        const newestOnTop = getResolvedOptions().newestOnTop !== false;
        list.sort((a, b) => (newestOnTop ? b.id - a.id : a.id - b.id));
        return list;
    }

    function hasFloatingEntries() {
        for (const entry of entries.values()) {
            if (!entry.exiting && entry.state !== 'docked') {
                return true;
            }
        }
        return false;
    }

    function syncGlobalListeners() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        const needResize = hasFloatingEntries();
        if (needResize && !resizeListenersBound) {
            window.addEventListener('resize', scheduleResizeClamp);
            window.visualViewport?.addEventListener('resize', scheduleResizeClamp);
            resizeListenersBound = true;
        } else if (!needResize && resizeListenersBound) {
            window.removeEventListener('resize', scheduleResizeClamp);
            window.visualViewport?.removeEventListener('resize', scheduleResizeClamp);
            if (resizeRafId) {
                if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(resizeRafId);
                else clearTimeout(resizeRafId);
                resizeRafId = 0;
            }
            resizeListenersBound = false;
        }

        const needOutside = deckPinned;
        if (needOutside && !outsideClickBound) {
            document.addEventListener('pointerdown', onDocumentPointerDown, true);
            outsideClickBound = true;
        } else if (!needOutside && outsideClickBound) {
            document.removeEventListener('pointerdown', onDocumentPointerDown, true);
            outsideClickBound = false;
        }
    }

    function onDocumentPointerDown(event) {
        if (!deckPinned) return;
        const target = event.target;
        if (containerEl && target instanceof Node && containerEl.contains(target)) {
            return;
        }
        deckPinned = false;
        deckHovered = false;
        refreshLayout();
        resumeDockedTimers();
        syncGlobalListeners();
    }

    function scheduleResizeClamp() {
        if (resizeRafId) return;
        const run = () => {
            resizeRafId = 0;
            reclampFloatingEntries();
            refreshLayout();
        };
        resizeRafId = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(run)
            : setTimeout(run, 16);
    }

    function reclampFloatingEntries() {
        const viewport = getViewportSize();
        const topSafeInset = getTopSafeInset();
        for (const entry of entries.values()) {
            if (entry.exiting || entry.state === 'docked') continue;
            if (entry.state === 'minimized' && !entry.hasCustomPosition) continue;
            const rect = measureElementSize(entry.el, entry.state === 'minimized');
            const clamped = clampToastPosition({
                x: entry.x,
                y: entry.y,
                width: rect.width,
                height: rect.height,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                topSafeInset,
            });
            entry.x = clamped.x;
            entry.y = clamped.y;
            entry.el.style.left = `${clamped.x}px`;
            entry.el.style.top = `${clamped.y}px`;
        }
    }

    function measureElementSize(el, isCapsule) {
        const rect = el.getBoundingClientRect?.();
        const width = (rect && rect.width > 0) ? rect.width : (el.offsetWidth || (isCapsule ? 180 : 320));
        const height = (rect && rect.height > 0) ? rect.height : (el.offsetHeight || (isCapsule ? 32 : 64));
        return { width, height };
    }

    function measureDockedHeight(entry) {
        const el = entry.el;
        const surfaceHeight = entry.surfaceEl?.offsetHeight || 0;
        const cs = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(el) : null;
        const borderY = cs ? ((parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)) : 0;
        const padY = cs ? ((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)) : 0;
        if (el.classList.contains('luker-toast-deck-clipped')) {
            const scrollH = el.scrollHeight || 0;
            const fromScroll = scrollH > 0 ? Math.ceil(scrollH + borderY) : 0;
            const fromSurface = surfaceHeight > 0 ? Math.ceil(surfaceHeight + padY + borderY) : 0;
            if (fromScroll > 0 || fromSurface > 0) {
                return Math.max(fromScroll, fromSurface);
            }
        }
        const elHeight = measureElementSize(el, false).height;
        if (surfaceHeight > 0) {
            return Math.max(elHeight, Math.ceil(surfaceHeight + padY + borderY));
        }
        return elHeight;
    }

    function isTouchHoverSuppressed() {
        return lastNonMousePointerAt > 0 && (Date.now() - lastNonMousePointerAt) < 700;
    }

    function attachContainerObserver(container) {
        if (containerObserver) {
            containerObserver.disconnect();
            containerObserver = null;
        }
        if (typeof MutationObserver !== 'function') return;

        containerObserver = new MutationObserver((mutations) => {
            if (suppressedContainerObserver) return;
            let removedAny = false;
            let classChanged = false;
            for (const m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'class') {
                    classChanged = true;
                }
                if (m.type === 'childList' && m.removedNodes.length > 0) {
                    for (const node of m.removedNodes) {
                        if (node instanceof HTMLElement && entries.has(node)) {
                            const entry = entries.get(node);
                            finalizeRemovedEntry(entry, { alreadyRemovedFromDom: true });
                            removedAny = true;
                        }
                    }
                }
            }
            if (removedAny || classChanged) {
                refreshLayout();
            }
        });
        containerObserver.observe(container, {
            childList: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }

    function splitClassTokens(value) {
        return String(value || '').trim().split(/\s+/).filter(Boolean);
    }

    function ensureContainer(options, create) {
        const containerId = options.containerId || 'toast-container';
        let existing = typeof document !== 'undefined' ? document.getElementById(containerId) : null;

        if (!existing && create && typeof document !== 'undefined') {
            existing = document.createElement('div');
            existing.id = containerId;
            const posTokens = splitClassTokens(options.positionClass);
            if (posTokens.length > 0) {
                existing.classList.add(...posTokens);
            }
            const topDialog = getTopmostOpenDialog();
            const mountTarget = topDialog
                || (typeof options.target === 'string' ? document.querySelector(options.target) : options.target)
                || document.body;
            mountTarget.appendChild(existing);
        }

        if (existing) {
            const posTokens = splitClassTokens(options.positionClass);
            if (posTokens.length > 0) {
                const hasKnown = KNOWN_POSITION_CLASSES.some(cls => existing.classList.contains(cls));
                if (!hasKnown) {
                    existing.classList.add(...posTokens);
                }
            }
            if (containerEl !== existing) {
                containerEl = existing;
                attachContainerObserver(existing);
            }
        }

        return existing;
    }

    function cancelCollapseGraceTimer() {
        if (collapseGraceTimer) {
            clearTimeout(collapseGraceTimer);
            collapseGraceTimer = null;
        }
    }

    function clearEntryTimers(entry) {
        if (entry.hideTimer) {
            clearTimeout(entry.hideTimer);
            entry.hideTimer = null;
        }
        if (entry.progressInterval) {
            clearInterval(entry.progressInterval);
            entry.progressInterval = null;
        }
        if (entry.exitTimer) {
            clearTimeout(entry.exitTimer);
            entry.exitTimer = null;
        }
    }

    function startEntryTimer(entry, durationMs) {
        clearEntryTimers(entry);
        const ms = Math.max(0, Number(durationMs) || 0);
        if (ms <= 0 || entry.exiting) {
            return;
        }
        entry.hideEta = Date.now() + ms;
        entry.maxHideTime = ms;
        entry.hideTimer = setTimeout(() => {
            hideEntry(entry, { forced: false });
        }, ms);

        if (entry.progressEl) {
            entry.progressEl.style.width = '100%';
            entry.progressInterval = setInterval(() => {
                if (!entry.progressEl || entry.exiting) return;
                const remaining = Math.min(entry.maxHideTime, Math.max(0, entry.hideEta - Date.now()));
                const pct = entry.maxHideTime > 0 ? (remaining / entry.maxHideTime) * 100 : 0;
                entry.progressEl.style.width = `${pct}%`;
            }, 30);
        }
    }

    function pauseEntryTimer(entry) {
        if (entry.hideTimer) {
            clearTimeout(entry.hideTimer);
            entry.hideTimer = null;
        }
        if (entry.progressInterval) {
            clearInterval(entry.progressInterval);
            entry.progressInterval = null;
        }
    }

    function pauseDockedTimers() {
        for (const entry of entries.values()) {
            if (!entry.exiting && entry.state === 'docked' && entry.options.closeOnHover !== false) {
                pauseEntryTimer(entry);
            }
        }
    }

    function resumeDockedTimers() {
        if (deckHovered || deckPinned) return;
        for (const entry of entries.values()) {
            if (!entry.exiting && entry.state === 'docked' && !entry.hovered && !entry.policy.isPersistent && !entry.hideTimer) {
                if (entry.policy.effectiveExtendedTimeOut > 0) {
                    startEntryTimer(entry, entry.policy.effectiveExtendedTimeOut);
                } else if (entry.policy.rawTimeOut > 0) {
                    startEntryTimer(entry, entry.policy.rawTimeOut);
                }
            }
        }
    }

    function syncCapsuleLabel(entry) {
        if (!entry.capsuleLabelEl) return;
        const text = extractCapsuleLabel({
            titleEl: entry.titleEl,
            messageEl: entry.messageEl,
            fallbackLabel: entry.type,
        });
        entry.capsuleLabelEl.textContent = text;
        if (entry.capsuleEl) {
            const restoreHint = tr('Restore notification');
            entry.capsuleEl.title = text ? `${text} — ${restoreHint}` : restoreHint;
            entry.capsuleEl.setAttribute('aria-label', text ? `${text}. ${restoreHint}` : restoreHint);
        }
    }

    function attachContentObserver(entry) {
        if (entry.contentObserver || typeof MutationObserver !== 'function' || !entry.bodyEl) return;
        entry.contentObserver = new MutationObserver(() => {
            if (!entry.exiting) {
                syncCapsuleLabel(entry);
                if (entry.state === 'minimized' && !entry.hasCustomPosition) {
                    refreshLayout();
                }
            }
        });
        entry.contentObserver.observe(entry.bodyEl, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    function ensureStackBadge(container, dockedCount, expanded, positionClass) {
        if (dockedCount < 2) {
            if (stackBadgeEl) {
                stackBadgeEl.remove();
                stackBadgeEl = null;
            }
            return;
        }

        if (!stackBadgeEl) {
            stackBadgeEl = document.createElement('button');
            stackBadgeEl.type = 'button';
            stackBadgeEl.className = 'luker-toast-stack-badge';
            stackBadgeEl.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                deckPinned = !deckPinned;
                if (!deckPinned) {
                    deckHovered = false;
                    resumeDockedTimers();
                } else {
                    pauseDockedTimers();
                }
                refreshLayout();
                syncGlobalListeners();
            });
            stackBadgeEl.addEventListener('mouseenter', () => {
                if (isTouchHoverSuppressed()) return;
                onDockPointerEnter();
            });
            stackBadgeEl.addEventListener('mouseleave', onDockPointerLeave);
        }

        if (stackBadgeEl.parentNode !== container) {
            suppressedContainerObserver = true;
            container.appendChild(stackBadgeEl);
            suppressedContainerObserver = false;
        }

        const extraCount = dockedCount - 1;
        const label = expanded ? tr('Collapse notifications') : tr('Expand notifications');
        stackBadgeEl.textContent = expanded ? '−' : `+${extraCount}`;
        stackBadgeEl.title = label;
        stackBadgeEl.setAttribute('aria-label', label);
        stackBadgeEl.setAttribute('aria-expanded', String(expanded));
        stackBadgeEl.dataset.expanded = String(expanded);
        stackBadgeEl.dataset.position = String(positionClass || '');
    }

    function onDockPointerEnter() {
        cancelCollapseGraceTimer();
        if (getDockedEntries().length >= 2) {
            if (!deckHovered) {
                deckHovered = true;
                refreshLayout();
            }
            pauseDockedTimers();
        }
    }

    function onDockPointerLeave(event) {
        if (!deckHovered) return;
        const related = event.relatedTarget;
        if (related instanceof Node) {
            if (stackBadgeEl && stackBadgeEl.contains(related)) return;
            for (const entry of entries.values()) {
                if (!entry.exiting && entry.state === 'docked' && entry.el.contains(related)) {
                    return;
                }
            }
        }
        if (activeDrag) return;
        cancelCollapseGraceTimer();
        collapseGraceTimer = setTimeout(() => {
            collapseGraceTimer = null;
            if (activeDrag) return;
            deckHovered = false;
            refreshLayout();
            resumeDockedTimers();
        }, DECK_COLLAPSE_GRACE_MS);
    }

    function refreshLayout() {
        if (!containerEl) return;

        // Prune any entries whose DOM node was removed externally without MO firing yet.
        for (const entry of Array.from(entries.values())) {
            if (!entry.el.isConnected) {
                finalizeRemovedEntry(entry, { alreadyRemovedFromDom: true });
            }
        }
        if (!containerEl) return;

        const positionClass = getActivePositionClass(containerEl);
        const docked = getDockedEntries();
        if (docked.length < 2) {
            deckHovered = false;
            deckPinned = false;
            cancelCollapseGraceTimer();
        }

        const expanded = isDeckExpanded();
        containerEl.setAttribute('data-deck-expanded', String(expanded));
        containerEl.setAttribute('data-docked-count', String(docked.length));
        containerEl.style.setProperty('--luker-toast-top-offset', `${getTopSafeInset()}px`);

        const deckItems = docked.map(entry => ({
            id: entry.id,
            height: measureDockedHeight(entry),
        }));
        const deckLayout = computeDeckLayout({
            items: deckItems,
            expanded,
            positionClass,
        });
        const layoutById = new Map(deckLayout.map(item => [item.id, item]));

        let deckSpanHeight = 0;
        const isBottom = String(positionClass).includes('toast-bottom');
        for (const entry of docked) {
            const spec = layoutById.get(entry.id);
            if (!spec) continue;
            const el = entry.el;
            el.setAttribute('data-toast-state', 'docked');
            el.setAttribute('data-stack-index', String(spec.index));
            el.style.left = '';
            el.style.top = '';
            el.style.zIndex = String(spec.zIndex);
            el.style.opacity = String(spec.opacity);
            el.style.pointerEvents = spec.pointerEvents;
            if (spec.opacity === 0) {
                el.setAttribute('data-stack-hidden', 'true');
            } else {
                el.removeAttribute('data-stack-hidden');
            }
            el.style.setProperty('--toast-index', String(spec.index));
            el.style.setProperty('--toast-offset-y', `${spec.offsetY}px`);
            el.style.setProperty('--toast-scale', String(spec.scale));
            if (spec.clipHeight !== null) {
                el.style.setProperty('--toast-clip-height', `${spec.clipHeight}px`);
                el.classList.add('luker-toast-deck-clipped');
            } else {
                el.style.removeProperty('--toast-clip-height');
                el.classList.remove('luker-toast-deck-clipped');
            }
            const h = measureDockedHeight(entry);
            const extent = Math.abs(spec.offsetY) + (spec.clipHeight !== null ? spec.clipHeight : h);
            if (spec.opacity > 0 && extent > deckSpanHeight) {
                deckSpanHeight = extent;
            }
        }

        ensureStackBadge(containerEl, docked.length, expanded, positionClass);
        if (stackBadgeEl) {
            const badgeOffset = deckSpanHeight + 6;
            stackBadgeEl.style.setProperty('--deck-badge-offset-y', `${isBottom ? -badgeOffset : badgeOffset}px`);
        }

        // Layout parked dock-origin minimized capsules without colliding with custom floating ones.
        const parkedCapsules = [];
        const occupiedRects = [];
        for (const entry of entries.values()) {
            if (entry.exiting) continue;
            if (entry.state === 'minimized' && !entry.hasCustomPosition) {
                const sz = measureElementSize(entry.el, true);
                parkedCapsules.push({ id: entry.id, width: sz.width, height: sz.height, entry });
            } else if (entry.state === 'minimized' && entry.hasCustomPosition) {
                const sz = measureElementSize(entry.el, true);
                occupiedRects.push({
                    left: entry.x,
                    top: entry.y,
                    right: entry.x + sz.width,
                    bottom: entry.y + sz.height,
                });
            }
        }

        if (parkedCapsules.length > 0) {
            const viewport = getViewportSize();
            const topSafeInset = getTopSafeInset();
            const placed = computeParkedCapsulePositions({
                capsules: parkedCapsules.map(({ id, width, height }) => ({ id, width, height })),
                positionClass,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                topSafeInset,
                occupiedRects,
            });
            const placedById = new Map(placed.map(p => [p.id, p]));
            for (const item of parkedCapsules) {
                const pos = placedById.get(item.id);
                if (!pos) continue;
                item.entry.x = pos.x;
                item.entry.y = pos.y;
                item.entry.el.style.left = `${pos.x}px`;
                item.entry.el.style.top = `${pos.y}px`;
                item.entry.el.style.zIndex = String(FLOATING_BASE_Z_INDEX + item.entry.zOrder);
            }
        }

        syncGlobalListeners();
    }

    /**
     * Moves #toast-container into the topmost open non-closing `<dialog>` modal
     * (including both `.popup` dialogs and `dialog.dw-layer` windows), or rescues
     * it back to `document.body` when no modal dialog remains open.
     */
    function syncContainerForDialogs() {
        if (typeof document === 'undefined') return;
        const containerId = getResolvedOptions().containerId || 'toast-container';
        const existing = document.getElementById(containerId);
        if (!existing) return;

        const topDialog = getTopmostOpenDialog();
        if (topDialog) {
            if (!topDialog.contains(existing)) {
                topDialog.appendChild(existing);
            }
            if (containerEl !== existing) {
                containerEl = existing;
                attachContainerObserver(existing);
            }
            refreshLayout();
            return;
        }

        if (!existing.childNodes.length && entries.size === 0) {
            if (containerObserver) {
                containerObserver.disconnect();
                containerObserver = null;
            }
            existing.remove();
            if (containerEl === existing) {
                containerEl = null;
            }
            return;
        }

        if (existing.parentElement !== document.body) {
            document.body.appendChild(existing);
        }
        const posTokens = splitClassTokens(userOptions.positionClass || getDefaultOptions().positionClass);
        if (posTokens.length > 0) {
            existing.classList.remove(...KNOWN_POSITION_CLASSES);
            existing.classList.add(...posTokens);
        }
        refreshLayout();
    }

    function applyFloatingPosition(entry, x, y) {
        entry.x = x;
        entry.y = y;
        const el = entry.el;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.opacity = '';
        el.style.pointerEvents = '';
        el.style.removeProperty('--toast-offset-y');
        el.style.removeProperty('--toast-scale');
        el.style.removeProperty('--toast-clip-height');
        el.classList.remove('luker-toast-deck-clipped');
        el.removeAttribute('data-stack-index');
        el.removeAttribute('data-stack-hidden');
        el.style.zIndex = String(FLOATING_BASE_Z_INDEX + entry.zOrder);
    }

    function minimizeEntry(entry) {
        if (entry.exiting || !entry.policy.isMinimizable || entry.state === 'minimized') {
            return;
        }
        const el = entry.el;
        const prevState = entry.state;
        const anchorRect = prevState === 'detached'
            ? {
                left: entry.x,
                top: entry.y,
                right: entry.x + measureElementSize(el, false).width,
                bottom: entry.y + measureElementSize(el, false).height,
            }
            : null;

        syncCapsuleLabel(entry);
        entry.state = 'minimized';
        entry.zOrder = ++floatingZSeq;
        el.setAttribute('data-toast-state', 'minimized');
        el.classList.add('luker-toast-minimized');
        el.style.opacity = '';
        el.style.pointerEvents = '';
        el.style.removeProperty('--toast-offset-y');
        el.style.removeProperty('--toast-scale');
        el.style.removeProperty('--toast-clip-height');
        el.classList.remove('luker-toast-deck-clipped');
        el.removeAttribute('data-stack-index');
        el.removeAttribute('data-stack-hidden');

        if (prevState === 'detached' && anchorRect) {
            entry.hasCustomPosition = true;
            const viewport = getViewportSize();
            const capSize = measureElementSize(el, true);
            const pos = computeAnchoredRect({
                anchorRect,
                targetWidth: capSize.width,
                targetHeight: capSize.height,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                topSafeInset: getTopSafeInset(),
            });
            applyFloatingPosition(entry, pos.x, pos.y);
        } else {
            entry.hasCustomPosition = false;
            el.style.zIndex = String(FLOATING_BASE_Z_INDEX + entry.zOrder);
        }

        refreshLayout();
    }

    function expandEntry(entry) {
        if (entry.exiting || entry.state !== 'minimized') {
            return;
        }
        const el = entry.el;
        const capSize = measureElementSize(el, true);
        const anchorRect = {
            left: entry.x,
            top: entry.y,
            right: entry.x + capSize.width,
            bottom: entry.y + capSize.height,
        };

        el.classList.remove('luker-toast-minimized');

        if (!entry.hasCustomPosition) {
            entry.state = 'docked';
            el.setAttribute('data-toast-state', 'docked');
            el.style.left = '';
            el.style.top = '';
        } else {
            entry.state = 'detached';
            entry.zOrder = ++floatingZSeq;
            el.setAttribute('data-toast-state', 'detached');
            const viewport = getViewportSize();
            const cardSize = measureElementSize(el, false);
            const pos = computeAnchoredRect({
                anchorRect,
                targetWidth: cardSize.width,
                targetHeight: cardSize.height,
                viewportWidth: viewport.width,
                viewportHeight: viewport.height,
                topSafeInset: getTopSafeInset(),
            });
            applyFloatingPosition(entry, pos.x, pos.y);
        }

        refreshLayout();
    }

    function isHeldByCallerInputFocus(entry) {
        if (!entry.policy.isClosable) return false;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!(active instanceof HTMLElement)) return false;
        if (!entry.messageEl || !entry.messageEl.contains(active)) return false;
        return active.matches(CALLER_FOCUS_HOLD_SELECTOR);
    }

    function finalizeRemovedEntry(entry, { alreadyRemovedFromDom = false } = {}) {
        if (entry.finalized) return;
        entry.finalized = true;
        entry.exiting = true;

        clearEntryTimers(entry);
        if (entry.contentObserver) {
            entry.contentObserver.disconnect();
            entry.contentObserver = null;
        }
        if (activeDrag && activeDrag.entry === entry) {
            endActiveDrag({ cancelled: true });
        }

        entries.delete(entry.el);

        if (!alreadyRemovedFromDom && entry.el.parentNode) {
            suppressedContainerObserver = true;
            entry.el.remove();
            suppressedContainerObserver = false;
        }

        if (typeof entry.options.onHidden === 'function') {
            try {
                entry.options.onHidden();
            } catch (error) {
                console.error('[luker-toast] onHidden callback failed:', error);
            }
        }

        entry.response.state = 'hidden';
        entry.response.endTime = new Date();
        publish(entry.response);

        refreshLayout();

        if (entries.size === 0 && containerEl && containerEl.childNodes.length === 0) {
            if (containerObserver) {
                containerObserver.disconnect();
                containerObserver = null;
            }
            containerEl.remove();
            containerEl = null;
        }
    }

    function hideEntry(entry, { forced = false, immediate = false } = {}) {
        if (!entry || entry.finalized) return;
        if (!forced && isHeldByCallerInputFocus(entry)) {
            entry.deferredAutoHide = true;
            return;
        }
        entry.deferredAutoHide = false;
        if (entry.exiting && !immediate) return;

        entry.exiting = true;
        clearEntryTimers(entry);

        const reducedMotion = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const rawHideDuration = Math.max(0, Number(entry.options.hideDuration) || 0);
        const exitMs = (immediate || reducedMotion || rawHideDuration <= 0)
            ? 0
            : rawHideDuration;

        if (exitMs <= 0) {
            finalizeRemovedEntry(entry);
            return;
        }

        entry.el.classList.add('luker-toast-leaving');
        refreshLayout();
        entry.exitTimer = setTimeout(() => {
            finalizeRemovedEntry(entry);
        }, exitMs);
    }

    function endActiveDrag({ cancelled = false } = {}) {
        if (!activeDrag) return;
        const drag = activeDrag;
        activeDrag = null;

        if (typeof window !== 'undefined') {
            window.removeEventListener('pointermove', onWindowPointerMove);
            window.removeEventListener('pointerup', onWindowPointerUp);
            window.removeEventListener('pointercancel', onWindowPointerCancel);
        }

        const { entry, dragging, pointerId } = drag;
        if (dragging) {
            try {
                entry.el.releasePointerCapture?.(pointerId);
            } catch {
                // Ignore if capture was already released.
            }
            entry.el.classList.remove('luker-toast-dragging');
            entry.el.style.zIndex = String(FLOATING_BASE_Z_INDEX + entry.zOrder);
            entry.suppressNextClick = true;
            entry.suppressClickUntil = Date.now() + 400;

            if (!cancelled && !entry.exiting && !entry.policy.isPersistent) {
                if (!entry.hovered) {
                    const resumeMs = entry.policy.effectiveExtendedTimeOut > 0
                        ? entry.policy.effectiveExtendedTimeOut
                        : entry.policy.rawTimeOut;
                    if (resumeMs > 0) {
                        startEntryTimer(entry, resumeMs);
                    }
                }
            }

            // Reconcile deckHovered if the dragged toast left the hovered dock
            // so remaining docked toasts do not stay permanently expanded/paused.
            if (deckHovered) {
                let anyDockedHovered = false;
                for (const other of entries.values()) {
                    if (!other.exiting && other.state === 'docked' && other.hovered) {
                        anyDockedHovered = true;
                        break;
                    }
                }
                if (!anyDockedHovered && stackBadgeEl && typeof stackBadgeEl.matches === 'function') {
                    try {
                        anyDockedHovered = stackBadgeEl.matches(':hover');
                    } catch {
                        // Ignore unsupported :hover selector errors in synthetic DOMs.
                    }
                }
                if (!anyDockedHovered) {
                    cancelCollapseGraceTimer();
                    deckHovered = false;
                }
            }

            refreshLayout();
            if (!deckHovered && !deckPinned) {
                resumeDockedTimers();
            }
        }
    }

    function onWindowPointerMove(event) {
        if (!activeDrag) return;
        if (event.pointerId !== undefined && activeDrag.pointerId !== undefined && event.pointerId !== activeDrag.pointerId) {
            return;
        }
        const drag = activeDrag;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;

        if (!drag.dragging) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
                return;
            }
            drag.dragging = true;
            const entry = drag.entry;
            pauseEntryTimer(entry);

            const rect = entry.el.getBoundingClientRect?.() || { left: entry.x || 0, top: entry.y || 0 };
            drag.originLeft = Number.isFinite(rect.left) ? rect.left : (entry.x || 0);
            drag.originTop = Number.isFinite(rect.top) ? rect.top : (entry.y || 0);

            if (entry.state === 'docked') {
                entry.state = 'detached';
                entry.hasCustomPosition = true;
                entry.el.setAttribute('data-toast-state', 'detached');
            } else if (entry.state === 'minimized') {
                entry.hasCustomPosition = true;
            }

            entry.zOrder = ++floatingZSeq;
            entry.el.classList.add('luker-toast-dragging');
            try {
                entry.el.setPointerCapture?.(drag.pointerId);
            } catch {
                // JSDOM or synthetic events may not support capture.
            }
            applyFloatingPosition(entry, drag.originLeft, drag.originTop);
            entry.el.style.zIndex = String(DRAGGING_Z_INDEX);
            refreshLayout();
        }

        const entry = drag.entry;
        const viewport = getViewportSize();
        const size = measureElementSize(entry.el, entry.state === 'minimized');
        const clamped = clampToastPosition({
            x: drag.originLeft + dx,
            y: drag.originTop + dy,
            width: size.width,
            height: size.height,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            topSafeInset: getTopSafeInset(),
        });
        entry.x = clamped.x;
        entry.y = clamped.y;
        entry.el.style.left = `${clamped.x}px`;
        entry.el.style.top = `${clamped.y}px`;
    }

    function onWindowPointerUp(event) {
        if (!activeDrag) return;
        if (event.pointerId !== undefined && activeDrag.pointerId !== undefined && event.pointerId !== activeDrag.pointerId) {
            return;
        }
        endActiveDrag({ cancelled: false });
    }

    function onWindowPointerCancel() {
        endActiveDrag({ cancelled: true });
    }

    function shouldIgnoreDragStart(event, entry) {
        if (typeof event.button === 'number' && event.button !== 0) {
            return true;
        }
        const target = event.target;
        if (!(target instanceof Element)) return false;

        if (entry.state === 'minimized') {
            // Whole capsule is draggable except explicit nested <button> controls if any.
            return Boolean(target.closest('button'));
        }
        return Boolean(target.closest(INTERACTIVE_DRAG_EXCLUDE_SELECTOR));
    }

    function attachToastInteractions(entry) {
        const el = entry.el;

        el.addEventListener('pointerdown', (event) => {
            if (event.pointerType && event.pointerType !== 'mouse') {
                lastNonMousePointerAt = Date.now();
            }
            if (entry.exiting || shouldIgnoreDragStart(event, entry)) return;
            if (entry.state !== 'docked') {
                entry.zOrder = ++floatingZSeq;
                el.style.zIndex = String(FLOATING_BASE_Z_INDEX + entry.zOrder);
            }
            if (activeDrag) {
                endActiveDrag({ cancelled: true });
            }
            activeDrag = {
                entry,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originLeft: 0,
                originTop: 0,
                dragging: false,
            };
            window.addEventListener('pointermove', onWindowPointerMove);
            window.addEventListener('pointerup', onWindowPointerUp);
            window.addEventListener('pointercancel', onWindowPointerCancel);
        });

        // Capture click suppression right after a drag drop so synthetic click
        // never triggers tapToDismiss, onclick, or capsule expand.
        el.addEventListener('click', (event) => {
            if (entry.suppressNextClick) {
                entry.suppressNextClick = false;
                if (Date.now() <= entry.suppressClickUntil) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
            }
        }, true);

        el.addEventListener('mouseenter', () => {
            if (isTouchHoverSuppressed()) return;
            entry.hovered = true;
            if (entry.state === 'docked') {
                onDockPointerEnter();
            }
            if (entry.options.closeOnHover !== false) {
                pauseEntryTimer(entry);
            }
        });

        el.addEventListener('mouseleave', (event) => {
            entry.hovered = false;
            if (entry.state === 'docked') {
                onDockPointerLeave(event);
            }
            if (entry.exiting || entry.policy.isPersistent) return;
            if (entry.state === 'docked' && isDeckExpanded()) return;
            if (activeDrag && activeDrag.entry === entry) return;
            if (entry.options.closeOnHover !== false && entry.policy.effectiveExtendedTimeOut > 0) {
                startEntryTimer(entry, entry.policy.effectiveExtendedTimeOut);
            } else if (entry.policy.rawTimeOut > 0 && !entry.hideTimer) {
                startEntryTimer(entry, entry.policy.rawTimeOut);
            }
        });

        el.addEventListener('focusout', () => {
            if (!entry.deferredAutoHide || entry.exiting || entry.finalized) return;
            queueMicrotask(() => {
                if (!entry.deferredAutoHide || entry.exiting || entry.finalized) return;
                if (isHeldByCallerInputFocus(entry)) return;
                entry.deferredAutoHide = false;
                if (entry.hovered || (entry.state === 'docked' && isDeckExpanded())) return;
                const resumeMs = entry.policy.effectiveExtendedTimeOut > 0
                    ? entry.policy.effectiveExtendedTimeOut
                    : entry.policy.rawTimeOut;
                if (resumeMs > 0) {
                    startEntryTimer(entry, resumeMs);
                } else {
                    hideEntry(entry, { forced: false });
                }
            });
        });

        // Card click handler (dismiss / onclick / peeking behind-card expand).
        el.addEventListener('click', (event) => {
            if (entry.exiting || entry.state === 'minimized') return;
            const target = event.target;
            if (target instanceof Element && target.closest('.luker-toast-actions, .luker-toast-capsule')) {
                return;
            }
            if (target instanceof Element && entry.messageEl?.contains(target) && target.closest(`${CALLER_FOCUS_HOLD_SELECTOR}, label`)) {
                return;
            }

            // Tapping a peeking behind-card in collapsed deck pins expanded view
            // instead of accidentally dismissing a partially obscured toast.
            const stackIndex = Number(el.getAttribute('data-stack-index'));
            if (entry.state === 'docked' && !isDeckExpanded() && Number.isFinite(stackIndex) && stackIndex > 0) {
                deckPinned = true;
                pauseDockedTimers();
                refreshLayout();
                syncGlobalListeners();
                return;
            }

            if (typeof entry.options.onclick === 'function') {
                entry.options.onclick(event);
            }
            if (entry.policy.canTapToDismiss) {
                hideEntry(entry, { forced: true });
            }
        });

        if (entry.minimizeBtn) {
            entry.minimizeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                minimizeEntry(entry);
            });
        }

        if (entry.closeBtn) {
            entry.closeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (typeof entry.options.onCloseClick === 'function') {
                    entry.options.onCloseClick(event);
                }
                hideEntry(entry, { forced: true });
            });
        }

        if (entry.capsuleEl) {
            entry.capsuleEl.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                expandEntry(entry);
            });
            entry.capsuleEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    expandEntry(entry);
                }
            });
        }
    }

    function normalizeMessageFingerprint(message) {
        if (message === null || message === undefined) return '';
        if (typeof message === 'string' || typeof message === 'number') {
            return String(message);
        }
        if (typeof Node !== 'undefined' && message instanceof Node) {
            return String(message.textContent || '');
        }
        if (typeof message === 'object' && message.jquery && typeof message.text === 'function') {
            return String(message.text() || '');
        }
        return String(message);
    }

    function appendContent(targetEl, content, escapeHtml) {
        if (content === null || content === undefined || content === '') {
            return;
        }
        if (typeof Node !== 'undefined' && content instanceof Node) {
            targetEl.appendChild(content);
            return;
        }
        if (typeof content === 'object' && content.jquery && typeof content.get === 'function') {
            const nodes = content.get();
            for (const node of nodes) {
                if (typeof Node !== 'undefined' && node instanceof Node) {
                    targetEl.appendChild(node);
                }
            }
            return;
        }
        if (escapeHtml) {
            targetEl.textContent = String(content);
        } else {
            targetEl.innerHTML = String(content);
        }
    }

    function notify(map) {
        if (typeof document === 'undefined') {
            return wrapJQuery(null);
        }

        const options = getResolvedOptions(map.optionsOverride);
        const policy = resolveToastPolicy(options, map.optionsOverride);
        const fingerprint = `${map.type}\u0000${normalizeMessageFingerprint(map.title)}\u0000${normalizeMessageFingerprint(map.message)}`;

        if (options.preventDuplicates) {
            for (const active of entries.values()) {
                if (!active.exiting && active.fingerprint === fingerprint) {
                    return undefined;
                }
            }
        }

        const container = ensureContainer(options, true);
        const id = ++toastSeq;
        const isOngoingTask = policy.isPersistent && !policy.isClosable;

        const el = document.createElement('div');
        const toastClasses = splitClassTokens(options.toastClass || 'toast');
        const overrideIconClass = map.optionsOverride && typeof map.optionsOverride.iconClass === 'string' && map.optionsOverride.iconClass.trim()
            ? map.optionsOverride.iconClass
            : '';
        const iconClasses = splitClassTokens(overrideIconClass || map.iconClass || options.iconClass || 'toast-info');
        el.classList.add(...toastClasses, ...iconClasses, 'luker-toast');
        if (options.rtl) el.classList.add('rtl');
        if (policy.canTapToDismiss) {
            el.classList.add('interactable');
            el.title = tr('Tap to close');
        } else {
            el.classList.add('toast-non-interactable');
        }
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', map.type === 'error' || map.type === 'warning' ? 'assertive' : 'polite');
        el.setAttribute('data-toast-id', String(id));
        el.setAttribute('data-toast-state', 'docked');
        el.setAttribute('data-toast-type', map.type);

        // Full card surface
        const surfaceEl = document.createElement('div');
        surfaceEl.className = 'luker-toast-surface';

        const iconWrap = document.createElement('span');
        iconWrap.className = 'luker-toast-icon';
        iconWrap.setAttribute('aria-hidden', 'true');
        if (isOngoingTask) {
            iconWrap.appendChild(createSvgIcon(ICON_PATHS.spinner, 'luker-toast-svg luker-toast-task-spinner'));
        } else {
            iconWrap.appendChild(createSvgIcon(ICON_PATHS[map.type] || ICON_PATHS.info, 'luker-toast-svg'));
        }

        const bodyEl = document.createElement('div');
        bodyEl.className = 'luker-toast-body';

        let titleEl = null;
        if (map.title !== undefined && map.title !== null && map.title !== '') {
            titleEl = document.createElement('div');
            titleEl.className = options.titleClass || 'toast-title';
            appendContent(titleEl, map.title, options.escapeHtml);
            bodyEl.appendChild(titleEl);
        }

        const messageEl = document.createElement('div');
        messageEl.className = options.messageClass || 'toast-message';
        appendContent(messageEl, map.message, options.escapeHtml);
        bodyEl.appendChild(messageEl);

        const actionsEl = document.createElement('div');
        actionsEl.className = 'luker-toast-actions';

        let minimizeBtn = null;
        if (policy.isMinimizable) {
            minimizeBtn = document.createElement('button');
            minimizeBtn.type = 'button';
            minimizeBtn.className = 'luker-toast-action-btn luker-toast-minimize-button';
            const minLabel = tr('Minimize notification');
            minimizeBtn.title = minLabel;
            minimizeBtn.setAttribute('aria-label', minLabel);
            minimizeBtn.appendChild(createSvgIcon(ICON_PATHS.minimize, 'luker-toast-action-svg'));
            actionsEl.appendChild(minimizeBtn);
        }

        let closeBtn = null;
        if (policy.isClosable) {
            closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = `luker-toast-action-btn ${options.closeClass || 'toast-close-button'}`;
            const closeLabel = tr('Close notification');
            closeBtn.title = closeLabel;
            closeBtn.setAttribute('aria-label', closeLabel);
            closeBtn.appendChild(createSvgIcon(ICON_PATHS.close, 'luker-toast-action-svg'));
            actionsEl.appendChild(closeBtn);
        }

        surfaceEl.append(iconWrap, bodyEl);
        if (actionsEl.childNodes.length > 0) {
            surfaceEl.appendChild(actionsEl);
        }

        let progressEl = null;
        if (options.progressBar && !policy.isPersistent) {
            progressEl = document.createElement('div');
            progressEl.className = options.progressClass || 'toast-progress';
            surfaceEl.appendChild(progressEl);
        }

        el.appendChild(surfaceEl);

        // Compact minimized capsule view inside the same .toast element
        let capsuleEl = null;
        let capsuleLabelEl = null;
        if (policy.isMinimizable) {
            capsuleEl = document.createElement('div');
            capsuleEl.className = 'luker-toast-capsule';
            capsuleEl.setAttribute('role', 'button');
            capsuleEl.tabIndex = 0;

            const capIconWrap = document.createElement('span');
            capIconWrap.className = 'luker-toast-capsule-icon';
            capIconWrap.setAttribute('aria-hidden', 'true');
            if (isOngoingTask) {
                capIconWrap.appendChild(createSvgIcon(ICON_PATHS.spinner, 'luker-toast-svg luker-toast-task-spinner'));
            } else {
                capIconWrap.appendChild(createSvgIcon(ICON_PATHS[map.type] || ICON_PATHS.info, 'luker-toast-svg'));
            }

            capsuleLabelEl = document.createElement('span');
            capsuleLabelEl.className = 'luker-toast-capsule-label';

            capsuleEl.append(capIconWrap, capsuleLabelEl);
            el.appendChild(capsuleEl);
        }

        const response = {
            toastId: id,
            state: 'visible',
            startTime: new Date(),
            options,
            map,
        };

        const entry = {
            id,
            type: map.type,
            fingerprint,
            options,
            policy,
            response,
            el,
            surfaceEl,
            bodyEl,
            titleEl,
            messageEl,
            minimizeBtn,
            closeBtn,
            progressEl,
            capsuleEl,
            capsuleLabelEl,
            contentObserver: null,
            state: 'docked',
            hasCustomPosition: false,
            x: 0,
            y: 0,
            zOrder: 0,
            hovered: false,
            exiting: false,
            finalized: false,
            hideTimer: null,
            progressInterval: null,
            exitTimer: null,
            hideEta: 0,
            maxHideTime: 0,
            suppressNextClick: false,
            suppressClickUntil: 0,
        };

        entries.set(el, entry);
        if (policy.isMinimizable) {
            syncCapsuleLabel(entry);
            attachContentObserver(entry);
        }
        attachToastInteractions(entry);

        suppressedContainerObserver = true;
        if (options.newestOnTop !== false && container.firstChild) {
            container.insertBefore(el, container.firstChild);
        } else {
            container.appendChild(el);
        }
        suppressedContainerObserver = false;

        refreshLayout();

        if (!policy.isPersistent && policy.rawTimeOut > 0 && !isDeckExpanded()) {
            startEntryTimer(entry, policy.rawTimeOut);
        }

        if (typeof options.onShown === 'function') {
            try {
                options.onShown();
            } catch (error) {
                console.error('[luker-toast] onShown callback failed:', error);
            }
        }
        publish(response);

        return wrapJQuery(el);
    }

    function clear(toastElement, clearOptions) {
        const forced = Boolean(clearOptions && clearOptions.force);
        if (toastElement) {
            const el = unwrapElement(toastElement);
            if (!el) return;
            const entry = entries.get(el);
            if (entry) {
                hideEntry(entry, { forced });
            } else if (el.parentNode) {
                el.remove();
            }
            return;
        }
        for (const entry of Array.from(entries.values())) {
            hideEntry(entry, { forced });
        }
    }

    function remove(toastElement) {
        if (toastElement) {
            const el = unwrapElement(toastElement);
            if (!el) return;
            const entry = entries.get(el);
            if (entry) {
                hideEntry(entry, { forced: true, immediate: true });
            } else if (el.parentNode) {
                el.remove();
            }
            return;
        }
        for (const entry of Array.from(entries.values())) {
            hideEntry(entry, { forced: true, immediate: true });
        }
    }

    function reset() {
        endActiveDrag({ cancelled: true });
        cancelCollapseGraceTimer();
        deckHovered = false;
        deckPinned = false;
        lastNonMousePointerAt = 0;
        for (const entry of Array.from(entries.values())) {
            clearEntryTimers(entry);
            if (entry.contentObserver) {
                entry.contentObserver.disconnect();
                entry.contentObserver = null;
            }
            entry.finalized = true;
            entry.exiting = true;
            if (entry.el.parentNode) {
                entry.el.remove();
            }
        }
        entries.clear();
        if (stackBadgeEl) {
            stackBadgeEl.remove();
            stackBadgeEl = null;
        }
        if (containerObserver) {
            containerObserver.disconnect();
            containerObserver = null;
        }
        if (containerEl && containerEl.parentNode) {
            containerEl.remove();
        }
        containerEl = null;
        subscriber = null;
        userOptions = {};
        toastSeq = 0;
        floatingZSeq = 0;
        syncGlobalListeners();
    }

    const api = {
        get options() {
            return userOptions;
        },
        set options(next) {
            userOptions = next && typeof next === 'object' ? next : {};
        },
        version: TOASTR_VERSION,
        info(message, title, optionsOverride) {
            const opts = getResolvedOptions(optionsOverride);
            return notify({
                type: 'info',
                iconClass: opts.iconClasses.info,
                message,
                title,
                optionsOverride,
            });
        },
        success(message, title, optionsOverride) {
            const opts = getResolvedOptions(optionsOverride);
            return notify({
                type: 'success',
                iconClass: opts.iconClasses.success,
                message,
                title,
                optionsOverride,
            });
        },
        warning(message, title, optionsOverride) {
            const opts = getResolvedOptions(optionsOverride);
            return notify({
                type: 'warning',
                iconClass: opts.iconClasses.warning,
                message,
                title,
                optionsOverride,
            });
        },
        error(message, title, optionsOverride) {
            const opts = getResolvedOptions(optionsOverride);
            return notify({
                type: 'error',
                iconClass: opts.iconClasses.error,
                message,
                title,
                optionsOverride,
            });
        },
        clear,
        remove,
        subscribe(callback) {
            subscriber = typeof callback === 'function' ? callback : null;
        },
        getContainer(options, create) {
            const resolved = getResolvedOptions(options);
            const el = ensureContainer(resolved, Boolean(create));
            return wrapJQuery(el);
        },
    };

    return {
        toastr: api,
        setTranslator(fn) {
            translator = typeof fn === 'function' ? fn : null;
        },
        refreshLayout,
        syncContainerForDialogs,
        reset,
    };
}

const defaultEngine = createToastEngine();

export const toastr = defaultEngine.toastr;
export const setToastTranslator = defaultEngine.setTranslator;
export const refreshToastLayout = defaultEngine.refreshLayout;
export const syncToastContainerForDialogs = defaultEngine.syncContainerForDialogs;

globalThis.toastr = toastr;

export default toastr;
