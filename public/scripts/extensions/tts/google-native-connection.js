// SPDX-License-Identifier: AGPL-3.0-or-later

export const MAKERSUITE_PROFILE_APIS = Object.freeze(new Set(['makersuite', 'google']));

/**
 * Fallback URL validator for environments without browser utils (e.g. unit tests).
 * @param {unknown} value
 * @returns {boolean}
 */
function defaultIsValidUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return false;
    }
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Whether a Connection Manager profile targets Google AI Studio (MakerSuite).
 * @param {any} profile
 * @returns {boolean}
 */
export function isMakerSuiteConnectionProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        return false;
    }
    const mode = String(profile.mode || 'cc').trim();
    if (mode !== 'cc') {
        return false;
    }
    const api = String(profile.api || '').trim().toLowerCase();
    return MAKERSUITE_PROFILE_APIS.has(api);
}

/**
 * List sorted Google AI Studio (MakerSuite) connection profiles.
 * @param {any[]} [profiles=[]]
 * @returns {any[]}
 */
export function listGoogleNativeTtsConnectionProfiles(profiles = []) {
    if (!Array.isArray(profiles)) {
        return [];
    }
    return profiles
        .filter(profile => isMakerSuiteConnectionProfile(profile) && String(profile?.name || '').trim())
        .map(profile => ({ ...profile, name: String(profile.name).trim() }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract a display-safe hostname from an endpoint URL.
 * Never returns credentials, paths, query strings, or full URLs.
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function extractEndpointHost(rawUrl) {
    const trimmed = String(rawUrl ?? '').trim();
    if (!trimmed) {
        return '';
    }
    try {
        return new URL(trimmed).hostname || 'configured';
    } catch {
        return 'configured';
    }
}

/**
 * Create a typed connection-binding error.
 * @param {'profile_not_found' | 'profile_incompatible' | 'profile_missing_secret'} code
 * @param {string} profileName
 * @param {string} message
 * @returns {Error & { code: string, profileName: string }}
 */
function createConnectionError(code, profileName, message) {
    const error = /** @type {Error & { code: string, profileName: string }} */ (new Error(message));
    error.code = code;
    error.profileName = profileName;
    return error;
}

/**
 * Resolve connection fields for `/api/google/generate-native-tts`.
 *
 * - Empty `profileName`: follows the active global chat connection.
 * - Named `profileName`: resolves that Google AI Studio (MakerSuite) connection profile
 *   and sets `strict_secret_id: true` so the backend never silently falls back to the
 *   globally active API key. Missing, incompatible, or keyless direct profiles throw.
 *
 * @param {object} [options]
 * @param {string} [options.profileName='']
 * @param {any[]} [options.profiles=[]]
 * @param {any[]} [options.proxies=[]]
 * @param {Record<string, any>} [options.oaiSettings={}]
 * @param {(url: string) => boolean} [options.isValidUrl]
 * @returns {{
 *   mode: 'global' | 'profile',
 *   profileName: string,
 *   hasBoundSecret: boolean,
 *   endpointHost: string,
 *   requestFields: {
 *     reverse_proxy: string,
 *     proxy_password: string,
 *     base_url: string,
 *     secret_id: string,
 *     strict_secret_id: boolean,
 *   },
 * }}
 */
export function resolveGoogleNativeTtsConnection({
    profileName = '',
    profiles = [],
    proxies = [],
    oaiSettings = {},
    isValidUrl = defaultIsValidUrl,
} = {}) {
    const name = String(profileName ?? '').trim();
    if (!name) {
        const useReverseProxy = Boolean(oaiSettings?.reverse_proxy) && isValidUrl(oaiSettings.reverse_proxy);
        const isGlobalMakerSuite = String(oaiSettings?.chat_completion_source || '').trim().toLowerCase() === 'makersuite';
        const useBaseUrl = isGlobalMakerSuite && Boolean(oaiSettings?.base_url) && isValidUrl(oaiSettings.base_url);
        return {
            mode: 'global',
            profileName: '',
            hasBoundSecret: false,
            endpointHost: '',
            requestFields: {
                reverse_proxy: useReverseProxy ? String(oaiSettings.reverse_proxy) : '',
                proxy_password: useReverseProxy ? String(oaiSettings.proxy_password || '') : '',
                base_url: useBaseUrl ? String(oaiSettings.base_url) : '',
                secret_id: '',
                strict_secret_id: false,
            },
        };
    }

    const list = Array.isArray(profiles) ? profiles : [];
    const profile = list.find(item => item && typeof item === 'object' && String(item.name || '').trim() === name) || null;
    if (!profile) {
        throw createConnectionError(
            'profile_not_found',
            name,
            `Connection profile "${name}" was not found. TTS request aborted.`,
        );
    }
    if (!isMakerSuiteConnectionProfile(profile)) {
        throw createConnectionError(
            'profile_incompatible',
            name,
            `Connection profile "${name}" is not Google AI Studio (MakerSuite). TTS request aborted.`,
        );
    }

    const baseUrl = String(profile['base-url'] ?? '').trim();
    const proxyName = String(profile.proxy ?? '').trim();
    const proxyPreset = proxyName && Array.isArray(proxies)
        ? proxies.find(item => String(item?.name || '') === proxyName)
        : null;
    const reverseProxy = proxyPreset
        ? String(proxyPreset.url ?? '').trim()
        : String(profile['proxy-url'] ?? '').trim();
    const proxyPassword = proxyPreset
        ? String(proxyPreset.password ?? '')
        : String(profile['proxy-password'] ?? '');
    const secretId = String(profile['secret-id'] ?? '').trim();

    if (!secretId && !proxyPassword && !baseUrl && !reverseProxy) {
        throw createConnectionError(
            'profile_missing_secret',
            name,
            `Connection profile "${name}" has no saved API key. TTS request aborted.`,
        );
    }

    const effectiveEndpoint = reverseProxy || baseUrl;

    return {
        mode: 'profile',
        profileName: name,
        hasBoundSecret: Boolean(secretId || proxyPassword),
        endpointHost: extractEndpointHost(effectiveEndpoint),
        requestFields: {
            reverse_proxy: reverseProxy,
            proxy_password: proxyPassword,
            base_url: baseUrl,
            secret_id: secretId,
            strict_secret_id: true,
        },
    };
}
