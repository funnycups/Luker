// SPDX-License-Identifier: AGPL-3.0-or-later

export function normalizeLocalImagePath(imagePath, toolName = 'fetch_reference_image') {
    // Match media-input-loader's single decode before resolving path segments.
    const decoded = decodeURIComponent(imagePath.split(/[?#]/, 1)[0]);
    if (imagePath.startsWith('//') || decoded.includes('\\') || decoded.includes('\0')) {
        throw new Error(`${toolName}: not_allowed — a managed local asset path is required`);
    }
    const segments = [];
    for (const segment of decoded.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!segments.length) throw new Error(`${toolName}: not_allowed — the path escapes managed media`);
            segments.pop();
        } else {
            segments.push(segment);
        }
    }
    return `/${segments.join('/')}`;
}
