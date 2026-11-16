// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Standalone helper for reading a connection profile's network proxy and for
// validating the URL before it is persisted. Lives outside index.js so core
// request paths can import it without pulling in the connection-manager UI.
import { resolveProfile } from './max-retries.js';

const SUPPORTED_PROXY_PROTOCOLS = new Set([
    'http:',
    'https:',
    'socks:',
    'socks4:',
    'socks4a:',
    'socks5:',
    'socks5h:',
    'pac+data:',
    'pac+file:',
    'pac+ftp:',
    'pac+http:',
    'pac+https:',
]);

/**
 * @param {any} profile
 * @returns {string}
 */
export function getProfileNetworkProxy(profile) {
    return String(profile?.['network-proxy'] ?? '').trim();
}

/**
 * Resolve the network proxy by profile name, falling back to the selected
 * profile. An empty result means the request should use the global proxy.
 * @param {string} [profileName]
 * @returns {string}
 */
export function getNetworkProxy(profileName = '') {
    return getProfileNetworkProxy(resolveProfile(profileName));
}

/**
 * Trim and validate a proxy URL. Throws with an actionable message when the
 * URL is malformed or uses a protocol the server-side proxy agent cannot
 * handle. An empty input is valid and means "use the global proxy".
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeNetworkProxyUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }

    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`Invalid proxy URL: ${raw}`);
    }

    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
    }

    return raw;
}
