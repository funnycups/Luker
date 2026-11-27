// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Import-free cyrb53 string hash shared by `utils.js`, `lib/`, plugins, and
 * the iteration library. Hash outputs are persisted (anchor hashes, vector
 * item hashes), so the implementation is canonical across the codebase.
 *
 * cyrb53 (c) 2018 bryc ({@link https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js|github.com/bryc})
 * License: Public domain (or MIT if needed). Attribution appreciated.
 * @param {string} str The string to hash.
 * @param {number} [seed=0] The seed to use for the hash.
 * @returns {number} The hash code.
 */
export function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') {
        return 0;
    }

    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
