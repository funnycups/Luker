// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure policy classification, viewport clamping, and layout geometry helpers
// for Luker's modern toast engine. Zero side effects and zero app imports.

/** Minimum pointer movement in px before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 6;

/** Minimum inset from viewport edges when clamping free-floating toasts. */
export const VIEWPORT_EDGE_MARGIN_PX = 8;

/** Corner parking horizontal margin for dock-origin minimized capsules. */
export const CAPSULE_PARKING_EDGE_PX = 12;

/** Vertical peek offset between cards in a collapsed docked deck. */
export const DECK_COLLAPSE_GAP_PX = 10;

/** Vertical gap between cards when the docked deck is expanded. */
export const DECK_EXPANDED_GAP_PX = 8;

/** Vertical gap between vertically stacked parked capsules. */
export const CAPSULE_STACK_GAP_PX = 8;

/** Base z-index ceiling for the docked deck (newest gets this value). */
const DECK_TOP_Z_INDEX = 100;

/** Collapsible deck visual steps for index 0, 1, 2, and 3+. */
const COLLAPSED_DECK_STEPS = [
    { offset: 0, scale: 1, opacity: 1, pointerEvents: 'auto' },
    { offset: DECK_COLLAPSE_GAP_PX, scale: 0.95, opacity: 0.92, pointerEvents: 'auto' },
    { offset: DECK_COLLAPSE_GAP_PX * 2, scale: 0.9, opacity: 0.82, pointerEvents: 'auto' },
    { offset: 26, scale: 0.86, opacity: 0, pointerEvents: 'none' },
];

/** Selectors excluded when extracting single-line text for minimized capsules. */
const CAPSULE_EXCLUDED_SELECTOR = 'button, .action-loader-stop, .luker-toast-stop-button, .prompt-manager-toggle-undo-button';

/**
 * Classifies toast persistence, closability, and minimizability from resolved
 * options plus the caller's raw optionsOverride.
 *
 * Inherited global `extendedTimeOut` (e.g. 10000 in script.js) must not turn a
 * `{ timeOut: 0 }` toast into a hover-dismissing toast unless the caller
 * explicitly passed a positive `extendedTimeOut` in `optionsOverride`.
 *
 * @param {Record<string, any>} resolvedOptions
 * @param {Record<string, any> | null | undefined} optionsOverride
 * @returns {{ rawTimeOut: number, effectiveExtendedTimeOut: number, isPersistent: boolean, isClosable: boolean, isMinimizable: boolean, canTapToDismiss: boolean }}
 */
export function resolveToastPolicy(resolvedOptions = {}, optionsOverride = null) {
    const rawTimeOut = Math.max(0, Number(resolvedOptions.timeOut) || 0);
    const hasExplicitPositiveExtended = Boolean(
        optionsOverride
        && Object.prototype.hasOwnProperty.call(optionsOverride, 'extendedTimeOut')
        && Number(optionsOverride.extendedTimeOut) > 0,
    );
    const effectiveExtendedTimeOut = rawTimeOut === 0 && !hasExplicitPositiveExtended
        ? 0
        : Math.max(0, Number(resolvedOptions.extendedTimeOut) || 0);

    const isPersistent = rawTimeOut === 0 && effectiveExtendedTimeOut === 0;
    const isClosable = typeof resolvedOptions.closable === 'boolean'
        ? resolvedOptions.closable
        : (!isPersistent
            ? true
            : (resolvedOptions.closeButton === true || resolvedOptions.tapToDismiss !== false));

    const isMinimizable = typeof resolvedOptions.minimizable === 'boolean'
        ? resolvedOptions.minimizable
        : isPersistent;

    const canTapToDismiss = isClosable && resolvedOptions.tapToDismiss !== false;

    return {
        rawTimeOut,
        effectiveExtendedTimeOut,
        isPersistent,
        isClosable,
        isMinimizable,
        canTapToDismiss,
    };
}

/**
 * Clamps a floating toast's top-left viewport coordinates so it stays reachable
 * inside the visible viewport and below any fixed top bar.
 *
 * @param {{ x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, topSafeInset?: number, edgeMargin?: number }} params
 * @returns {{ x: number, y: number }}
 */
export function clampToastPosition({
    x,
    y,
    width,
    height,
    viewportWidth,
    viewportHeight,
    topSafeInset = VIEWPORT_EDGE_MARGIN_PX,
    edgeMargin = VIEWPORT_EDGE_MARGIN_PX,
}) {
    const margin = Math.max(0, Number(edgeMargin) || 0);
    const minX = margin;
    const maxX = Math.max(minX, viewportWidth - width - margin);
    const minY = Math.max(margin, Number(topSafeInset) || 0);
    const maxY = Math.max(minY, viewportHeight - height - margin);

    const safeX = Number.isFinite(x) ? x : minX;
    const safeY = Number.isFinite(y) ? y : minY;

    return {
        x: Math.round(Math.min(Math.max(safeX, minX), maxX)),
        y: Math.round(Math.min(Math.max(safeY, minY), maxY)),
    };
}

/**
 * Picks the horizontal corner where dock-origin minimized capsules park so
 * they stay clear of the active dock anchor.
 *
 * @param {string} positionClass
 * @returns {'left' | 'right'}
 */
export function resolveCapsuleParkingSide(positionClass) {
    return String(positionClass || '').includes('toast-top-right') ? 'left' : 'right';
}

/**
 * @param {{ left: number, top: number, right: number, bottom: number }} a
 * @param {{ left: number, top: number, right: number, bottom: number }} b
 * @returns {boolean}
 */
function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Places dock-origin minimized capsules in a non-overlapping vertical column
 * at the corner opposite/clear of the active dock, stepping past any
 * user-dragged capsule occupying a candidate slot.
 *
 * @param {{ capsules: Array<{ id: number, width: number, height: number }>, positionClass: string, viewportWidth: number, viewportHeight: number, topSafeInset?: number, occupiedRects?: Array<{ left: number, top: number, right: number, bottom: number }> }} params
 * @returns {Array<{ id: number, x: number, y: number }>}
 */
export function computeParkedCapsulePositions({
    capsules,
    positionClass,
    viewportWidth,
    viewportHeight,
    topSafeInset = VIEWPORT_EDGE_MARGIN_PX,
    occupiedRects = [],
}) {
    const side = resolveCapsuleParkingSide(positionClass);
    const taken = occupiedRects.map(r => ({ ...r }));
    const results = [];
    const baseTop = Math.max(VIEWPORT_EDGE_MARGIN_PX, Number(topSafeInset) || 0);

    let cursorY = baseTop;
    for (const cap of capsules) {
        const width = Math.max(1, Number(cap.width) || 160);
        const height = Math.max(1, Number(cap.height) || 32);
        const rawX = side === 'left'
            ? CAPSULE_PARKING_EDGE_PX
            : viewportWidth - width - CAPSULE_PARKING_EDGE_PX;

        let candidateY = cursorY;
        const maxY = Math.max(baseTop, viewportHeight - height - VIEWPORT_EDGE_MARGIN_PX);

        // Step downward past any occupied custom-dragged capsule rect without
        // exceeding viewport bounds.
        for (let guard = 0; guard < 64; guard++) {
            const clamped = clampToastPosition({
                x: rawX,
                y: candidateY,
                width,
                height,
                viewportWidth,
                viewportHeight,
                topSafeInset: baseTop,
            });
            const box = {
                left: clamped.x,
                top: clamped.y,
                right: clamped.x + width,
                bottom: clamped.y + height,
            };
            const hit = taken.find(other => rectsOverlap(box, other));
            if (!hit || clamped.y >= maxY) {
                results.push({ id: cap.id, x: clamped.x, y: clamped.y });
                taken.push(box);
                cursorY = clamped.y + height + CAPSULE_STACK_GAP_PX;
                break;
            }
            candidateY = Math.max(candidateY + height + CAPSULE_STACK_GAP_PX, hit.bottom + CAPSULE_STACK_GAP_PX);
        }
    }

    return results;
}

/**
 * Anchors a minimized or expanded detached toast to the nearest horizontal
 * edge of its previous bounding box so controls don't jump across the screen.
 *
 * @param {{ anchorRect: { left: number, top: number, right: number, bottom: number }, targetWidth: number, targetHeight: number, viewportWidth: number, viewportHeight: number, topSafeInset?: number }} params
 * @returns {{ x: number, y: number }}
 */
export function computeAnchoredRect({
    anchorRect,
    targetWidth,
    targetHeight,
    viewportWidth,
    viewportHeight,
    topSafeInset = VIEWPORT_EDGE_MARGIN_PX,
}) {
    const distLeft = Math.max(0, anchorRect.left);
    const distRight = Math.max(0, viewportWidth - anchorRect.right);
    const rawX = distRight < distLeft
        ? anchorRect.right - targetWidth
        : anchorRect.left;

    return clampToastPosition({
        x: rawX,
        y: anchorRect.top,
        width: targetWidth,
        height: targetHeight,
        viewportWidth,
        viewportHeight,
        topSafeInset,
    });
}

/**
 * Computes per-card vertical offset, scale, opacity, stacking z-index, pointer
 * interactivity, and optional height clipping for docked toasts.
 *
 * @param {{ items: Array<{ id: number, height: number }>, expanded: boolean, positionClass: string }} params
 * @returns {Array<{ id: number, index: number, offsetY: number, scale: number, opacity: number, zIndex: number, pointerEvents: 'auto' | 'none', clipHeight: number | null }>}
 */
export function computeDeckLayout({ items, expanded, positionClass }) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const isBottom = String(positionClass || '').includes('toast-bottom');
    const dir = isBottom ? -1 : 1;
    const frontHeight = Math.max(1, Number(items[0]?.height) || 56);

    if (expanded) {
        let cumulative = 0;
        return items.map((item, index) => {
            const offsetY = cumulative === 0 ? 0 : cumulative * dir;
            cumulative += Math.max(1, Number(item.height) || 56) + DECK_EXPANDED_GAP_PX;
            return {
                id: item.id,
                index,
                offsetY,
                scale: 1,
                opacity: 1,
                zIndex: Math.max(1, DECK_TOP_Z_INDEX - index),
                pointerEvents: 'auto',
                clipHeight: null,
            };
        });
    }

    return items.map((item, index) => {
        const step = COLLAPSED_DECK_STEPS[Math.min(index, COLLAPSED_DECK_STEPS.length - 1)];
        return {
            id: item.id,
            index,
            offsetY: step.offset === 0 ? 0 : step.offset * dir,
            scale: step.scale,
            opacity: step.opacity,
            zIndex: Math.max(1, DECK_TOP_Z_INDEX - index),
            pointerEvents: step.pointerEvents,
            clipHeight: index === 0 ? null : frontHeight,
        };
    });
}

/**
 * Extracts normalized single-line text from a DOM subtree while skipping
 * interactive button controls (e.g. Stop / Undo buttons).
 *
 * @param {Element | null | undefined} root
 * @returns {string}
 */
function readNonInteractiveText(root) {
    if (!root) {
        return '';
    }
    const parts = [];
    const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) { // TEXT_NODE
            if (node.nodeValue) parts.push(node.nodeValue);
            return;
        }
        if (node.nodeType === 1) { // ELEMENT_NODE
            const el = /** @type {Element} */ (node);
            if (typeof el.matches === 'function' && el.matches(CAPSULE_EXCLUDED_SELECTOR)) {
                return;
            }
            for (let child = el.firstChild; child; child = child.nextSibling) {
                walk(child);
            }
        }
    };
    walk(root);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Computes the single-line summary label displayed inside a minimized capsule.
 * Prefers `.toast-message` text (excluding buttons), falling back to
 * `.toast-title`, then `fallbackLabel`.
 *
 * @param {{ titleEl?: Element | null, messageEl?: Element | null, fallbackLabel?: string }} params
 * @returns {string}
 */
export function extractCapsuleLabel({ titleEl = null, messageEl = null, fallbackLabel = '' } = {}) {
    const msgText = readNonInteractiveText(messageEl);
    if (msgText) {
        return msgText;
    }
    const titleText = readNonInteractiveText(titleEl);
    if (titleText) {
        return titleText;
    }
    return String(fallbackLabel || '').replace(/\s+/g, ' ').trim();
}
