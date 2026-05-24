/**
 * iteration-library — zoom + splitter handlers for the inline text diff.
 *
 * The inline text diff (rendered by `text-diff.js`) carries three UI
 * affordances driven by delegated DOM events:
 *
 *   1. `data-luker-lib-action="expand-line-diff"` — open a fullscreen
 *      overlay containing the diff body, layered over the calling popup.
 *   2. `data-luker-lib-action="close-line-diff-zoom"` (+ backdrop click +
 *      Esc key) — close that overlay.
 *   3. `.luker_lib_diff_splitter` pointerdown — drag the central splitter
 *      to resize the before/after columns proportionally.
 *
 * Plugin popups call `attachZoomOverlay(popupRoot, options?)` once after
 * mounting the popup DOM. The returned function unbinds delegation
 * (defensive — jQuery cleans up when the popup root detaches anyway).
 *
 * Lifted from the deleted `iteration-studio/zoom-overlay.js`, with the
 * shell `i18n.js` import dropped (callers pass `i18n` via options) and
 * all `luker_iter_*` selectors / data attrs renamed to `luker_lib_*`.
 */

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function defaultI18n(s) {
    return String(s ?? '');
}

export function closeExpandedDiff(rootElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    if (!(root instanceof HTMLElement)) {
        return;
    }
    root.querySelectorAll('.luker_lib_diff_zoom_overlay').forEach((overlay) => overlay.remove());
}

export function openExpandedDiff(rootElement, triggerElement, options = {}) {
    const root = rootElement instanceof Element ? rootElement : null;
    const trigger = triggerElement instanceof Element ? triggerElement : null;
    const diffRoot = trigger?.closest?.('.luker_lib_diff');
    const diffBody = diffRoot?.querySelector?.('.luker_lib_diff_pre');
    if (!(root instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
        return;
    }

    const i18n = typeof options.i18n === 'function' ? options.i18n : defaultI18n;
    closeExpandedDiff(root);

    const diffLabel = String(diffBody.getAttribute('data-luker-lib-diff-label') || i18n('Line diff'));
    const closeLabel = escapeHtml(i18n('Close expanded diff'));
    const overlay = document.createElement('div');
    overlay.className = 'luker_lib_diff_zoom_overlay';
    overlay.innerHTML = `
<div class="luker_lib_diff_zoom_backdrop" data-luker-lib-action="close-line-diff-zoom"></div>
<div class="luker_lib_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="luker_lib_diff_zoom_header">
        <div class="luker_lib_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small luker_lib_diff_zoom_close" data-luker-lib-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="luker_lib_diff_zoom_body"></div>
</div>`;

    const zoomBody = overlay.querySelector('.luker_lib_diff_zoom_body');
    if (zoomBody instanceof HTMLElement) {
        zoomBody.append(diffBody.cloneNode(true));
    }

    // Narrow-viewport class: below the 720px breakpoint the dialog stacks
    // into a single column with each panel capped at 45vh (see
    // `.luker_lib_diff_zoom_narrow` rules in `text-diff.css`). Sampled at
    // open-time only — if the user resizes after opening, they can close
    // and reopen to re-evaluate (intentional; cheaper than wiring a
    // resize observer).
    const dialog = overlay.querySelector('.luker_lib_diff_zoom_dialog');
    if (dialog instanceof HTMLElement
        && typeof window !== 'undefined'
        && Number.isFinite(window.innerWidth)
        && window.innerWidth < 720) {
        dialog.classList.add('luker_lib_diff_zoom_narrow');
    }

    root.append(overlay);
}

export function beginLineDiffResize(splitterElement, pointerEvent) {
    const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
    const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
    const dual = splitter?.closest?.('.luker_lib_diff_dual');
    if (!(splitter instanceof HTMLElement) || !(pointer instanceof PointerEvent) || !(dual instanceof HTMLElement)) {
        return;
    }

    pointer.preventDefault();
    pointer.stopPropagation();

    const bounds = dual.getBoundingClientRect();
    if (!Number.isFinite(bounds.width) || bounds.width <= 0) {
        return;
    }

    const minPercent = 15;
    const maxPercent = 85;
    const pointerId = pointer.pointerId;

    const applySplitAt = (clientX) => {
        const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
        const clampedPercent = Math.max(minPercent, Math.min(maxPercent, nextPercent));
        dual.style.setProperty('--luker-lib-split-left', `${clampedPercent}%`);
    };

    const cleanup = () => {
        splitter.classList.remove('active');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        try {
            splitter.releasePointerCapture(pointerId);
        } catch {
            // Pointer capture may not have been acquired; ignore.
        }
    };

    const handlePointerMove = (moveEvent) => {
        if (!(moveEvent instanceof PointerEvent) || moveEvent.pointerId !== pointerId) {
            return;
        }
        moveEvent.preventDefault();
        applySplitAt(moveEvent.clientX);
    };

    const handlePointerUp = (upEvent) => {
        if (!(upEvent instanceof PointerEvent) || upEvent.pointerId !== pointerId) {
            return;
        }
        upEvent.preventDefault();
        cleanup();
    };

    splitter.classList.add('active');
    applySplitAt(pointer.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    try {
        splitter.setPointerCapture(pointerId);
    } catch {
        // Pointer capture is optional; ignore browser limitations.
    }
}

/**
 * Bind expand / close / Esc / splitter handlers scoped to `popupRoot`.
 * Returns an unbind function the popup can call on close (defensive —
 * jQuery delegation cleans up when the popup DOM detaches anyway).
 *
 * @param {HTMLElement|jQuery|string} popupRoot
 *   The popup root element. Accepts either an element, a jQuery wrapper,
 *   or a CSS selector string. Selector strings are used unchanged for
 *   delegation; element / jQuery inputs are resolved to a unique
 *   `#<id>` selector when possible, otherwise to `.luker_lib_diff` scope
 *   on the surrounding document.
 * @param {Object} [options]
 *   `namespace` (default `.luker_lib_diff`) — jQuery event namespace
 *   used for delegation. Each popup should pass a distinct namespace
 *   when multiple popups can coexist.
 *   `i18n` (default identity) — overlay header labels.
 */
export function attachZoomOverlay(popupRoot, options = {}) {
    if (typeof jQuery !== 'function') {
        // jQuery not present (jest jsdom path with no jQuery global) —
        // no-op. The renderer's HTML still functions for static viewing;
        // only the expand/splitter affordances need delegation.
        return () => {};
    }
    const namespace = String(options.namespace || '.luker_lib_diff').trim();
    const i18n = typeof options.i18n === 'function' ? options.i18n : defaultI18n;

    let popupSelector;
    if (typeof popupRoot === 'string') {
        popupSelector = popupRoot;
    } else {
        const el = popupRoot instanceof Element
            ? popupRoot
            : (popupRoot && popupRoot.jquery && popupRoot[0] instanceof Element ? popupRoot[0] : null);
        if (!el) return () => {};
        if (el.id) {
            popupSelector = `#${el.id}`;
        } else {
            const fallbackId = `luker_lib_diff_scope_${Math.random().toString(36).slice(2, 10)}`;
            el.id = fallbackId;
            popupSelector = `#${fallbackId}`;
        }
    }

    const ns = namespace.startsWith('.') ? namespace : `.${namespace}`;
    jQuery(document).off(ns);
    jQuery(document).on(`click${ns}`, `${popupSelector} [data-luker-lib-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = jQuery(this).closest(popupSelector)[0];
        openExpandedDiff(rootElement, this, { i18n });
    });
    jQuery(document).on(`click${ns}`, `${popupSelector} [data-luker-lib-action="close-line-diff-zoom"], ${popupSelector} .luker_lib_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = jQuery(this).closest(popupSelector)[0];
        closeExpandedDiff(rootElement);
    });
    jQuery(document).on(`keydown${ns}`, function (event) {
        if (event.key !== 'Escape') return;
        const overlay = document.querySelector(`${popupSelector} .luker_lib_diff_zoom_overlay`);
        if (!(overlay instanceof HTMLElement)) return;
        event.preventDefault();
        event.stopPropagation();
        closeExpandedDiff(overlay.closest(popupSelector));
    });
    jQuery(document).on(`pointerdown${ns}`, `${popupSelector} .luker_lib_diff_splitter`, function (event) {
        beginLineDiffResize(this, event.originalEvent || event);
    });
    return () => jQuery(document).off(ns);
}
