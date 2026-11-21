// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the floating window's box: defaults, clamping to the
// viewport, and persistence shape. No DOM here (unit-tested).

export const MIN_W = 560;
export const MIN_H = 380;
export const MIN_COMPACT_W = 280;
export const MIN_COMPACT_H = 260;
export const COMPACT_BELOW = 640; // viewport width; below this the window uses compact floating layout

/** Default box: centred, up to 960×640, leaving room around it. */
export function defaultBox(vw, vh) {
    const width = Math.min(960, Math.max(MIN_W, vw - 64)); // cap-ok: viewport hardware default window size
    const height = Math.min(640, Math.max(MIN_H, vh - 96)); // cap-ok: viewport hardware default window size
    return { left: Math.round((vw - width) / 2), top: Math.round(Math.max(16, (vh - height) / 2)), width, height };
}

/**
 * Keeps a box usable inside the viewport: never smaller than the minimum
 * (unless the viewport itself is smaller), never larger than the viewport,
 * and the title bar always reachable (at least 120px of it on screen).
 */
export function clampBox(box, vw, vh) {
    const width = Math.round(Math.min(Math.max(Number(box?.width) || 0, Math.min(MIN_W, vw)), vw));
    const height = Math.round(Math.min(Math.max(Number(box?.height) || 0, Math.min(MIN_H, vh)), vh));
    const keep = Math.min(120, width); // cap-ok: viewport hardware grab-handle minimum width
    const left = Math.round(Math.min(Math.max(Number(box?.left) || 0, keep - width), vw - keep));
    const top = Math.round(Math.min(Math.max(Number(box?.top) || 0, 0), vh - 46));
    return { left, top, width, height };
}

/** Maximised box: the viewport with a small margin. */
export function maxBox(vw, vh) {
    const m = 10;
    return { left: m, top: m, width: Math.max(0, vw - m * 2), height: Math.max(0, vh - m * 2) };
}

/** Phone floating window default box: centred with breathing margin around all edges. */
export function compactDefaultBox(vw, vh) {
    const width = Math.max(Math.min(MIN_COMPACT_W, vw), vw - 24);
    const height = Math.min(520, Math.max(Math.min(MIN_COMPACT_H, vh), Math.round(vh * 0.62))); // cap-ok: viewport hardware default compact floating window size
    return {
        left: Math.round((vw - width) / 2),
        top: Math.round(Math.max(16, (vh - height) * 0.42)),
        width,
        height,
    };
}

/** Keeps a compact mobile floating box usable and reachable inside the viewport. */
export function clampCompactBox(box, vw, vh) {
    const minW = Math.min(MIN_COMPACT_W, vw);
    const minH = Math.min(MIN_COMPACT_H, vh);
    const width = Math.round(Math.min(Math.max(Number(box?.width) || 0, minW), vw));
    const height = Math.round(Math.min(Math.max(Number(box?.height) || 0, minH), vh));
    const keep = Math.min(96, width); // cap-ok: viewport hardware grab-handle minimum width
    const left = Math.round(Math.min(Math.max(Number(box?.left) || 0, keep - width), vw - keep));
    const top = Math.round(Math.min(Math.max(Number(box?.top) || 0, 0), Math.max(0, vh - 46)));
    return { left, top, width, height };
}

/** Legacy phone bottom sheet helper (retained for compatibility). */
export function sheetBox(vw, vh) {
    const height = Math.round(vh * 0.88);
    return { left: 0, top: vh - height, width: vw, height };
}

/** Where the entry pill sits by default (bottom-right, above Luker's input bar on phones). */
export function pillPos(vw, vh, compact) {
    return compact ? { right: 12, bottom: 96 } : { right: 18, bottom: 18 };
}

/** Keeps a dragged pill on screen (offsets from the right / bottom edges). */
export function clampPill(pos, vw, vh, size = { width: 200, height: 42 }) {
    const right = Math.round(Math.min(Math.max(Number(pos?.right) || 0, 4), Math.max(4, vw - Math.min(size.width, vw) - 4)));
    const bottom = Math.round(Math.min(Math.max(Number(pos?.bottom) || 0, 4), Math.max(4, vh - size.height - 4)));
    return { right, bottom };
}

export function isCompactWidth(vw) {
    return vw < COMPACT_BELOW;
}

/** Reads a saved box; returns null if missing or malformed. */
export function parseSavedBox(value) {
    if (!value || typeof value !== 'object') return null;
    const keys = ['left', 'top', 'width', 'height'];
    if (!keys.every(k => Number.isFinite(Number(value[k])))) return null;
    return Object.fromEntries(keys.map(k => [k, Math.round(Number(value[k]))]));
}
