/**
 * IterationStudio — zoom + splitter handlers for the inline text diff.
 *
 * The inline text diff (rendered by `inline-text-diff.js`) carries three
 * UI affordances driven by delegated DOM events:
 *
 *   1. `data-luker-orch-action="expand-line-diff"` — open a fullscreen
 *      overlay containing the diff body, layered over the studio popup.
 *   2. `data-luker-orch-action="close-line-diff-zoom"` (+ backdrop click +
 *      Esc key) — close that overlay.
 *   3. `.luker_orch_line_diff_splitter` pointerdown — drag the central
 *      splitter to resize the before/after columns proportionally.
 *
 * `bindZoomOverlayHandlers(popupRoot, namespace)` wires all three at once
 * via jQuery delegation scoped to the popup root. Call once per popup open.
 * Pairs cleanly with `studio.js`'s onOpen hook so adapters don't need to
 * touch any of this.
 */

import { i18n } from './i18n.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

export function closeExpandedDiff(rootElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    if (!(root instanceof HTMLElement)) {
        return;
    }
    root.querySelectorAll('.luker_orch_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());
}

export function openExpandedDiff(rootElement, triggerElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    const trigger = triggerElement instanceof Element ? triggerElement : null;
    const diffRoot = trigger?.closest?.('.luker_orch_line_diff');
    const diffBody = diffRoot?.querySelector?.('.luker_orch_line_diff_pre');
    if (!(root instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
        return;
    }

    closeExpandedDiff(root);

    const diffLabel = String(diffBody.getAttribute('data-luker-orch-diff-label') || i18n('Line diff'));
    const closeLabel = escapeHtml(i18n('Close expanded diff'));
    const overlay = document.createElement('div');
    overlay.className = 'luker_orch_line_diff_zoom_overlay';
    overlay.innerHTML = `
<div class="luker_orch_line_diff_zoom_backdrop" data-luker-orch-action="close-line-diff-zoom"></div>
<div class="luker_orch_line_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="luker_orch_line_diff_zoom_header">
        <div class="luker_orch_line_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_zoom_close" data-luker-orch-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="luker_orch_line_diff_zoom_body"></div>
</div>`;

    const zoomBody = overlay.querySelector('.luker_orch_line_diff_zoom_body');
    if (zoomBody instanceof HTMLElement) {
        zoomBody.append(diffBody.cloneNode(true));
    }

    root.append(overlay);
}

export function beginLineDiffResize(splitterElement, pointerEvent) {
    const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
    const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
    const dual = splitter?.closest?.('.luker_orch_line_diff_dual');
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
        dual.style.setProperty('--luker-orch-split-left', `${clampedPercent}%`);
    };

    const cleanup = () => {
        splitter.classList.remove('active');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        try {
            splitter.releasePointerCapture(pointerId);
        } catch {
            // Ignore release errors when capture was not acquired.
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
        // Pointer capture may fail in some browsers and is optional here.
    }
}

/**
 * Bind expand / close / Esc / splitter handlers to a popup root. Returns
 * an unbind function for cleanup (the studio calls it on popup close, but
 * jQuery delegation also cleans up when the popup DOM is detached so the
 * unbind is mostly defensive).
 */
export function bindZoomOverlayHandlers(popupSelector, namespace) {
    const ns = String(namespace || '.iterStudioZoom').trim();
    jQuery(document).off(ns);
    jQuery(document).on(`click${ns}`, `${popupSelector} [data-luker-orch-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = jQuery(this).closest(popupSelector)[0];
        openExpandedDiff(rootElement, this);
    });
    jQuery(document).on(`click${ns}`, `${popupSelector} [data-luker-orch-action="close-line-diff-zoom"], ${popupSelector} .luker_orch_line_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = jQuery(this).closest(popupSelector)[0];
        closeExpandedDiff(rootElement);
    });
    jQuery(document).on(`keydown${ns}`, function (event) {
        if (event.key !== 'Escape') return;
        const overlay = document.querySelector(`${popupSelector} .luker_orch_line_diff_zoom_overlay`);
        if (!(overlay instanceof HTMLElement)) return;
        event.preventDefault();
        event.stopPropagation();
        closeExpandedDiff(overlay.closest(popupSelector));
    });
    jQuery(document).on(`pointerdown${ns}`, `${popupSelector} .luker_orch_line_diff_splitter`, function (event) {
        beginLineDiffResize(this, event.originalEvent || event);
    });
    return () => jQuery(document).off(ns);
}
