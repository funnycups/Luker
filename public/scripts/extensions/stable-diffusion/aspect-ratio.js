// SPDX-License-Identifier: AGPL-3.0-or-later

export const SUPPORTED_ASPECT_RATIOS = Object.freeze([
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '9:16',
    '16:9',
]);

export function parseAspectRatio(aspectRatio) {
    const text = String(aspectRatio ?? '').trim();
    const match = /^([1-9]\d*):([1-9]\d*)$/.exec(text);
    if (!match) {
        throw new Error(`Invalid aspect ratio "${aspectRatio}"; expected "<w>:<h>" such as "2:3" or "16:9".`);
    }
    const w = Number(match[1]);
    const h = Number(match[2]);
    return { w, h, normalized: `${w}:${h}` };
}

function alignDimension(value, align) {
    const step = Math.max(1, Math.round(Number(align) || 64));
    return Math.max(step, Math.round(value / step) * step);
}

/**
 * Resolves width and height from an optional aspectRatio while preserving approximate pixel area.
 */
export function resolveAspectRatioDimensions({
    aspectRatio = '',
    width = 1024,
    height = 1024,
    align = 64,
    novelOpusFree = false,
} = {}) {
    const baseWidth = Math.max(64, Math.round(Number(width) || 1024));
    const baseHeight = Math.max(64, Math.round(Number(height) || 1024));
    const trimmed = String(aspectRatio ?? '').trim();
    if (!trimmed) {
        const inferredRatio = `${baseWidth}:${baseHeight}`;
        return { width: baseWidth, height: baseHeight, aspectRatio: inferredRatio };
    }

    const { w, h, normalized } = parseAspectRatio(trimmed);
    const ratio = w / h;

    if (novelOpusFree) {
        if (Math.abs(ratio - 1) <= 0.08) {
            return { width: 1024, height: 1024, aspectRatio: normalized };
        }
        if (ratio < 1) {
            return { width: 832, height: 1216, aspectRatio: normalized };
        }
        return { width: 1216, height: 832, aspectRatio: normalized };
    }

    const area = baseWidth * baseHeight;
    const rawWidth = Math.sqrt(area * ratio);
    const rawHeight = Math.sqrt(area / ratio);
    return {
        width: alignDimension(rawWidth, align),
        height: alignDimension(rawHeight, align),
        aspectRatio: normalized,
    };
}
