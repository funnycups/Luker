// SPDX-License-Identifier: AGPL-3.0-or-later

const COMPATIBLE_PROFILE_APIS_BY_SOURCE = Object.freeze({
    google: new Set(['makersuite', 'vertexai']),
    openai: new Set(['openai', 'custom']),
    openrouter: new Set(['openrouter']),
    xai: new Set(['xai', 'custom']),
    zai: new Set(['zai', 'custom']),
    nanogpt: new Set(['nanogpt', 'custom']),
    chutes: new Set(['chutes', 'custom']),
    electronhub: new Set(['electronhub', 'custom']),
    aimlapi: new Set(['aimlapi', 'custom']),
    pollinations: new Set(['pollinations', 'custom']),
    chat_image: new Set([
        'openai',
        'custom',
        'openrouter',
        'makersuite',
        'vertexai',
        'xai',
        'zai',
        'nanogpt',
        'chutes',
        'electronhub',
        'aimlapi',
        'pollinations',
        'cometapi',
        'siliconflow',
        'fireworks',
        'groq',
        'mistralai',
        'deepseek',
        'moonshot',
        'perplexity',
    ]),
});

export const CONNECTION_PROFILE_CAPABLE_SOURCES = Object.freeze(
    new Set(Object.keys(COMPATIBLE_PROFILE_APIS_BY_SOURCE)),
);

const KEYLESS_ALLOWED_SOURCES = new Set(['pollinations']);

export function DIRECT_SECRET_KEY_BY_SOURCE(source, sd = {}) {
    const normalized = String(source || '').trim();
    switch (normalized) {
        case 'google':
            return String(sd?.google_api || 'makersuite') === 'vertexai'
                ? 'api_key_vertexai'
                : 'api_key_makersuite';
        case 'openai':
            return 'api_key_openai';
        case 'openrouter':
            return 'api_key_openrouter';
        case 'xai':
            return 'api_key_xai';
        case 'zai':
            return 'api_key_zai';
        case 'nanogpt':
            return 'api_key_nanogpt';
        case 'chutes':
            return 'api_key_chutes';
        case 'electronhub':
            return 'api_key_electronhub';
        case 'aimlapi':
            return 'api_key_aimlapi';
        case 'pollinations':
            return 'api_key_pollinations';
        case 'chat_image':
            return 'api_key_custom';
        case 'novel':
            return 'api_key_novel';
        case 'huggingface':
            return 'api_key_huggingface';
        case 'horde':
            return 'api_key_horde';
        case 'togetherai':
            return 'api_key_togetherai';
        case 'stability':
            return 'api_key_stability';
        case 'bfl':
            return 'api_key_bfl';
        case 'falai':
            return 'api_key_falai';
        case 'workersai':
            return 'api_key_workers_ai';
        case 'comfy':
            return 'api_key_comfy_runpod';
        default:
            return '';
    }
}

export function isProfileCompatibleWithSource(source, profile) {
    const allowed = COMPATIBLE_PROFILE_APIS_BY_SOURCE[String(source || '').trim()];
    if (!allowed || !profile || typeof profile !== 'object') {
        return false;
    }
    const mode = String(profile.mode || 'cc').trim();
    if (mode !== 'cc') {
        return false;
    }
    const api = String(profile.api || '').trim().toLowerCase();
    return allowed.has(api);
}

export function listCompatibleConnectionProfiles(source, profiles = []) {
    if (!Array.isArray(profiles)) {
        return [];
    }
    return profiles
        .filter(profile => isProfileCompatibleWithSource(source, profile) && String(profile?.name || '').trim())
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function extractProfileEndpointUrl(profile) {
    return String(
        profile?.['api-url']
        || profile?.['base-url']
        || profile?.['proxy-url']
        || '',
    ).trim();
}

/**
 * Resolves credentials, endpoint URL, and network proxy for an SD settings object.
 * Never mutates `sd.model` and never falls back to global keys when a named profile is broken.
 */
export function resolveSdConnectionBinding(sd = {}, context = null) {
    const source = String(sd?.source || '').trim();
    const profileName = CONNECTION_PROFILE_CAPABLE_SOURCES.has(source)
        ? String(sd?.connection_profile || '').trim()
        : '';

    if (!profileName) {
        return {
            mode: 'direct',
            profileName: '',
            secretId: '',
            apiUrl: '',
            networkProxy: '',
            googleApi: '',
        };
    }

    const profiles = context?.connectionProfiles?.list?.() || [];
    const found = Array.isArray(profiles)
        ? profiles.find(profile => String(profile?.name || '').trim() === profileName)
        : null;

    if (!found) {
        throw new Error(`Connection profile "${profileName}" does not exist. Select a valid profile or switch to direct API key mode.`);
    }

    if (!isProfileCompatibleWithSource(source, found)) {
        throw new Error(`Connection profile "${profileName}" (api: ${found.api || 'unknown'}) is not compatible with image source "${source}".`);
    }

    const secretId = String(found['secret-id'] || '').trim();
    if (!secretId && !KEYLESS_ALLOWED_SOURCES.has(source)) {
        throw new Error(`Connection profile "${profileName}" has no saved API key (secret_id is empty).`);
    }

    const profileApi = String(found.api || '').trim().toLowerCase();
    const googleApi = source === 'google' && (profileApi === 'makersuite' || profileApi === 'vertexai')
        ? profileApi
        : '';

    return {
        mode: 'profile',
        profileName,
        secretId,
        apiUrl: extractProfileEndpointUrl(found),
        networkProxy: String(found['network-proxy'] || '').trim(),
        googleApi,
    };
}

/**
 * Validates any bound connection_profile when refreshing model lists, including sources
 * whose model catalogs are static client lists (google, openai, xai, zai).
 */
export function validateBoundProfileForModelRefresh(sd = {}, context = null) {
    const source = String(sd?.source || '').trim();
    if (!CONNECTION_PROFILE_CAPABLE_SOURCES.has(source)) {
        return null;
    }
    if (!String(sd?.connection_profile || '').trim()) {
        return null;
    }
    return resolveSdConnectionBinding(sd, context);
}
