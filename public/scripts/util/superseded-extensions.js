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

// scp-style SSH remotes, e.g. `git@github.com:owner/repo.git`.
const SCP_REMOTE_RE = /^[\w.-]+@([^:/\s]+):(?!\/\/)(.+)$/;

/**
 * Normalizes a repository home page to `host/owner/repo` (lowercase, no
 * `www.`, `.git`, query, hash or trailing slash). Accepts https / http / ssh
 * URLs, scp-style `git@host:owner/repo(.git)` remotes and scheme-less values,
 * and keeps only the first two path segments so repository sub-paths such as
 * `/tree/main` still match.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHomePage(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    let host = '';
    let pathname = '';
    const scp = raw.match(SCP_REMOTE_RE);
    if (scp) {
        host = scp[1];
        pathname = scp[2];
    } else {
        try {
            const parsed = new URL(raw);
            host = parsed.hostname;
            pathname = parsed.pathname;
        } catch {
            const stripped = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/^[^/@]*@/, '');
            const slash = stripped.indexOf('/');
            host = slash < 0 ? stripped : stripped.slice(0, slash);
            pathname = slash < 0 ? '' : stripped.slice(slash);
        }
    }

    host = host.toLowerCase().replace(/^www\./, '');
    const segments = pathname
        .replace(/[?#].*$/, '')
        .toLowerCase()
        .split('/')
        .filter(Boolean)
        .slice(0, 2);
    if (segments.length > 0) {
        segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/, '');
    }
    return [host, ...segments].filter(Boolean).join('/');
}

/**
 * Returns the superseded descriptor if `name` / `manifest` refers to a legacy
 * third-party extension that is now built into Luker, or `null` otherwise.
 *
 * Matching by folder name is intentionally broad: any `third-party/<folder>`
 * whose folder equals a superseded extension id is blocked regardless of its
 * author, because it would clash with the built-in CSS prefixes / UI anyway.
 * The manifest home page is a fallback for renamed folders.
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

/**
 * Computes the extension-manager toggle state, locking superseded extensions
 * so they can only be disabled (never re-enabled).
 *
 * @param {{ isSuperseded?: boolean, isActive?: boolean, isDisabled?: boolean, canActivate?: boolean }} state
 *   `canActivate` is whether manifest dependencies / client version are satisfied.
 * @returns {{ canActivate: boolean, canBeToggled: boolean, isLocked: boolean }}
 *   `isLocked` is true when a superseded extension is disabled and its toggle is locked.
 */
export function getSupersededUiState({ isSuperseded = false, isActive = false, isDisabled = false, canActivate = false } = {}) {
    const effectiveCanActivate = !isSuperseded && Boolean(canActivate);
    const canBeToggled = isSuperseded
        ? !isDisabled
        : Boolean(isActive || isDisabled || effectiveCanActivate);
    return {
        canActivate: effectiveCanActivate,
        canBeToggled,
        isLocked: Boolean(isSuperseded) && !canBeToggled,
    };
}

/**
 * Whether the bulk "Toggle extensions" action must skip an extension:
 * superseded extensions are never re-enabled in bulk, but may be bulk-disabled.
 *
 * @param {{ enable?: boolean, isSuperseded?: boolean }} options
 * @returns {boolean}
 */
export function shouldSkipToggleAll({ enable = false, isSuperseded = false } = {}) {
    return Boolean(enable) && Boolean(isSuperseded);
}
