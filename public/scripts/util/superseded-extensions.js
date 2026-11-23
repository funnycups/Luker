// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Identifies legacy third-party extensions that were merged into Luker core
// and share identical CSS class prefixes / UI surfaces (.wbench, .mlens,
// .olens). Loading them alongside the built-in modules breaks layout styles
// and duplicates controls, so extension activation skips them cleanly.

const THIRD_PARTY_PREFIX = 'third-party/';

/**
 * Legacy third-party extensions now built into Luker.
 * @type {ReadonlyArray<Readonly<{ id: string, folders: ReadonlyArray<string>, homePages: ReadonlyArray<string> }>>}
 */
export const SUPERSEDED_THIRD_PARTY_EXTENSIONS = Object.freeze([
    Object.freeze({
        id: 'luker-workbench',
        folders: Object.freeze(['luker-workbench']),
        homePages: Object.freeze(['github.com/xzhouzhou758/luker-workbench']),
    }),
    Object.freeze({
        id: 'memory-lens',
        folders: Object.freeze(['memory-lens']),
        homePages: Object.freeze(['github.com/xzhouzhou758/memory-lens']),
    }),
    Object.freeze({
        id: 'orchestra-lens',
        folders: Object.freeze(['orchestra-lens']),
        homePages: Object.freeze(['github.com/xzhouzhou758/orchestra-lens']),
    }),
]);

function normalizeHomePage(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const pathname = parsed.pathname
            .toLowerCase()
            .replace(/\/+$/, '')
            .replace(/\.git$/, '')
            .replace(/\/+$/, '');
        return `${host}${pathname}`;
    } catch {
        return raw
            .toLowerCase()
            .replace(/^https?:\/\/(www\.)?/, '')
            .replace(/[?#].*$/, '')
            .replace(/\/+$/, '')
            .replace(/\.git$/, '')
            .replace(/\/+$/, '');
    }
}

/**
 * Returns the superseded descriptor if `name` / `manifest` refers to a legacy
 * third-party extension that is now built into Luker, or `null` otherwise.
 *
 * @param {string} name Extension identifier (e.g. `third-party/luker-workbench`)
 * @param {object | null | undefined} [manifest] Parsed extension manifest
 * @returns {Readonly<{ id: string, folders: ReadonlyArray<string>, homePages: ReadonlyArray<string> }> | null}
 */
export function findSupersededExtension(name, manifest = null) {
    if (typeof name !== 'string' || !name.toLowerCase().startsWith(THIRD_PARTY_PREFIX)) {
        return null;
    }
    const folder = name.slice(THIRD_PARTY_PREFIX.length).trim().toLowerCase();
    const homePage = normalizeHomePage(manifest?.homePage ?? manifest?.homepage);

    for (const entry of SUPERSEDED_THIRD_PARTY_EXTENSIONS) {
        if (folder && entry.folders.includes(folder)) {
            return entry;
        }
        if (homePage && entry.homePages.includes(homePage)) {
            return entry;
        }
    }
    return null;
}
