import path from 'node:path';

import { isPathUnderParent } from './util.js';

// Format-agnostic: any local image a chat can render must appear as this
// path prefix somewhere in the raw JSONL (message body HTML, extra.*,
// metadata, or HTML comments authored by extensions).
// Quoted occurrences (JSON string values or escaped `\"` inside one) treat
// spaces as part of the filename until the closing quote; unquoted matches
// stop at whitespace or markup characters. The negative lookbehind keeps
// `/user/images/...` substrings of external URLs out of the results.
const LOCAL_IMAGE_PATTERN = /(?:(?<=["'])\/user\/images\/[^\\"']+)|(?<![\w./-])\/user\/images\/[^\s"'<>\\]+/g;
const TRAILING_PUNCTUATION_PATTERN = /[),;!?>]+$/;

/**
 * Extracts unique client-relative media paths from raw chat text.
 * @param {string} rawText Raw JSONL content (or any text containing references)
 * @returns {string[]} Client-relative paths starting with /user/images/
 */
export function extractLocalMediaPaths(rawText) {
    if (typeof rawText !== 'string' || !rawText) {
        return [];
    }
    const found = new Set();
    for (const match of rawText.matchAll(LOCAL_IMAGE_PATTERN)) {
        let candidate = match[0].replace(TRAILING_PUNCTUATION_PATTERN, '');
        try {
            candidate = decodeURIComponent(candidate);
        } catch { /* keep the raw form when it is not valid percent-encoding */ }
        if (!candidate.startsWith('/user/images/')) {
            continue;
        }
        found.add(candidate);
    }
    return [...found];
}

/**
 * Resolves a client-relative path to its absolute disk path, refusing
 * anything that escapes the user's images directory.
 * @param {string} userRoot Absolute user root directory
 * @param {string} clientPath Client-relative path (e.g. /user/images/x/y.png)
 * @returns {string|null}
 */
export function resolveUserImagePath(userRoot, clientPath) {
    if (typeof clientPath !== 'string' || !clientPath.startsWith('/user/images/')) {
        return null;
    }
    const diskPath = path.normalize(path.join(userRoot, clientPath));
    if (!isPathUnderParent(path.join(userRoot, 'user', 'images'), diskPath)) {
        return null;
    }
    return diskPath;
}
