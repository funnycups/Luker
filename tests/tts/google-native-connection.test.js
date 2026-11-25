import { describe, test, expect } from '@jest/globals';
import {
    extractEndpointHost,
    isMakerSuiteConnectionProfile,
    listGoogleNativeTtsConnectionProfiles,
    resolveGoogleNativeTtsConnection,
} from '../../public/scripts/extensions/tts/google-native-connection.js';

describe('google-native-connection', () => {
    const sampleProfiles = [
        {
            name: 'Zeta Direct',
            mode: 'cc',
            api: 'makersuite',
            'secret-id': 'sec-zeta',
        },
        {
            name: 'Alpha BaseUrl',
            mode: 'cc',
            api: 'makersuite',
            'base-url': 'https://gemini.proxy.example/v1beta?token=should-not-leak',
            'secret-id': 'sec-alpha',
        },
        {
            name: 'Beta Google Alias',
            mode: 'cc',
            api: 'google',
            'secret-id': 'sec-beta',
        },
        {
            name: 'Legacy Proxy Preset',
            mode: 'cc',
            api: 'makersuite',
            proxy: 'Corp Proxy',
        },
        {
            name: 'Legacy Proxy Snapshot',
            mode: 'cc',
            api: 'makersuite',
            'proxy-url': 'https://legacy.example/custom',
            'proxy-password': 'legacy-secret-password',
        },
        {
            name: 'Keyless Custom Gateway',
            mode: 'cc',
            api: 'makersuite',
            'base-url': 'https://gateway.local:8443/gemini',
            'secret-id': '',
        },
        {
            name: 'Direct Keyless Broken',
            mode: 'cc',
            api: 'makersuite',
            'secret-id': '',
        },
        {
            name: 'OpenRouter Main',
            mode: 'cc',
            api: 'openrouter',
            'secret-id': 'sec-or',
        },
        {
            name: 'Embedding Profile',
            mode: 'embed',
            api: 'makersuite',
            'secret-id': 'sec-embed',
        },
    ];

    const sampleProxies = [
        {
            name: 'Corp Proxy',
            url: 'https://user:pass@corp-proxy.example/v1',
            password: 'preset-password',
        },
    ];

    test('lists only chat-completion MakerSuite profiles sorted by name', () => {
        const listed = listGoogleNativeTtsConnectionProfiles(sampleProfiles);
        expect(listed.map(p => p.name)).toEqual([
            'Alpha BaseUrl',
            'Beta Google Alias',
            'Direct Keyless Broken',
            'Keyless Custom Gateway',
            'Legacy Proxy Preset',
            'Legacy Proxy Snapshot',
            'Zeta Direct',
        ]);
        expect(isMakerSuiteConnectionProfile({ mode: 'cc', api: 'makersuite' })).toBe(true);
        expect(isMakerSuiteConnectionProfile({ mode: 'cc', api: 'google' })).toBe(true);
        expect(isMakerSuiteConnectionProfile({ mode: 'embed', api: 'makersuite' })).toBe(false);
        expect(isMakerSuiteConnectionProfile({ mode: 'cc', api: 'vertexai' })).toBe(false);
    });

    test('extractEndpointHost returns only hostname and never leaks paths, queries, or credentials', () => {
        expect(extractEndpointHost('')).toBe('');
        expect(extractEndpointHost('https://user:secret@proxy.example:8443/v1beta?key=abc')).toBe('proxy.example');
        expect(extractEndpointHost('not-a-valid-url')).toBe('configured');
    });

    test('follows global connection when no profile is selected and avoids cross-source base_url bleed', () => {
        const claudeGlobal = resolveGoogleNativeTtsConnection({
            profileName: '',
            profiles: sampleProfiles,
            oaiSettings: {
                chat_completion_source: 'claude',
                base_url: 'https://claude-relay.example/v1',
                reverse_proxy: '',
                proxy_password: '',
            },
        });
        expect(claudeGlobal).toEqual({
            mode: 'global',
            profileName: '',
            hasBoundSecret: false,
            endpointHost: '',
            requestFields: {
                reverse_proxy: '',
                proxy_password: '',
                base_url: '',
                secret_id: '',
                strict_secret_id: false,
            },
        });

        const makersuiteGlobal = resolveGoogleNativeTtsConnection({
            profileName: '',
            profiles: sampleProfiles,
            oaiSettings: {
                chat_completion_source: 'makersuite',
                base_url: 'https://direct-global.example/v1beta',
                reverse_proxy: '',
                proxy_password: '',
            },
        });
        expect(makersuiteGlobal.requestFields).toEqual({
            reverse_proxy: '',
            proxy_password: '',
            base_url: 'https://direct-global.example/v1beta',
            secret_id: '',
            strict_secret_id: false,
        });

        const legacyGlobal = resolveGoogleNativeTtsConnection({
            profileName: '',
            profiles: sampleProfiles,
            oaiSettings: {
                chat_completion_source: 'openai',
                reverse_proxy: 'https://legacy-global.example',
                proxy_password: 'pw',
            },
        });
        expect(legacyGlobal.requestFields).toEqual({
            reverse_proxy: 'https://legacy-global.example',
            proxy_password: 'pw',
            base_url: '',
            secret_id: '',
            strict_secret_id: false,
        });
    });

    test('resolves modern base-url + secret-id profile and reports hostname only', () => {
        const resolved = resolveGoogleNativeTtsConnection({
            profileName: 'Alpha BaseUrl',
            profiles: sampleProfiles,
            proxies: sampleProxies,
        });
        expect(resolved).toEqual({
            mode: 'profile',
            profileName: 'Alpha BaseUrl',
            hasBoundSecret: true,
            endpointHost: 'gemini.proxy.example',
            requestFields: {
                reverse_proxy: '',
                proxy_password: '',
                base_url: 'https://gemini.proxy.example/v1beta?token=should-not-leak',
                secret_id: 'sec-alpha',
                strict_secret_id: true,
            },
        });
    });

    test('resolves direct profile and google alias with empty endpointHost and strict_secret_id', () => {
        const resolved = resolveGoogleNativeTtsConnection({
            profileName: 'Beta Google Alias',
            profiles: sampleProfiles,
        });
        expect(resolved.hasBoundSecret).toBe(true);
        expect(resolved.endpointHost).toBe('');
        expect(resolved.requestFields).toEqual({
            reverse_proxy: '',
            proxy_password: '',
            base_url: '',
            secret_id: 'sec-beta',
            strict_secret_id: true,
        });
    });

    test('resolves legacy proxy preset and snapshot profiles', () => {
        const fromPreset = resolveGoogleNativeTtsConnection({
            profileName: 'Legacy Proxy Preset',
            profiles: sampleProfiles,
            proxies: sampleProxies,
        });
        expect(fromPreset.hasBoundSecret).toBe(true);
        expect(fromPreset.endpointHost).toBe('corp-proxy.example');
        expect(fromPreset.requestFields).toEqual({
            reverse_proxy: 'https://user:pass@corp-proxy.example/v1',
            proxy_password: 'preset-password',
            base_url: '',
            secret_id: '',
            strict_secret_id: true,
        });

        const fromSnapshot = resolveGoogleNativeTtsConnection({
            profileName: 'Legacy Proxy Snapshot',
            profiles: sampleProfiles,
            proxies: sampleProxies,
        });
        expect(fromSnapshot.hasBoundSecret).toBe(true);
        expect(fromSnapshot.endpointHost).toBe('legacy.example');
        expect(fromSnapshot.requestFields).toEqual({
            reverse_proxy: 'https://legacy.example/custom',
            proxy_password: 'legacy-secret-password',
            base_url: '',
            secret_id: '',
            strict_secret_id: true,
        });
    });

    test('allows keyless custom gateway profile with strict_secret_id enabled', () => {
        const resolved = resolveGoogleNativeTtsConnection({
            profileName: 'Keyless Custom Gateway',
            profiles: sampleProfiles,
        });
        expect(resolved.hasBoundSecret).toBe(false);
        expect(resolved.endpointHost).toBe('gateway.local');
        expect(resolved.requestFields).toEqual({
            reverse_proxy: '',
            proxy_password: '',
            base_url: 'https://gateway.local:8443/gemini',
            secret_id: '',
            strict_secret_id: true,
        });
    });

    test('throws explicit typed errors when profile is missing, incompatible, or keyless direct', () => {
        expect(() => resolveGoogleNativeTtsConnection({
            profileName: 'Deleted Profile',
            profiles: sampleProfiles,
        })).toThrow(expect.objectContaining({ code: 'profile_not_found', profileName: 'Deleted Profile' }));

        expect(() => resolveGoogleNativeTtsConnection({
            profileName: 'OpenRouter Main',
            profiles: sampleProfiles,
        })).toThrow(expect.objectContaining({ code: 'profile_incompatible', profileName: 'OpenRouter Main' }));

        expect(() => resolveGoogleNativeTtsConnection({
            profileName: 'Embedding Profile',
            profiles: sampleProfiles,
        })).toThrow(expect.objectContaining({ code: 'profile_incompatible', profileName: 'Embedding Profile' }));

        expect(() => resolveGoogleNativeTtsConnection({
            profileName: 'Direct Keyless Broken',
            profiles: sampleProfiles,
        })).toThrow(expect.objectContaining({ code: 'profile_missing_secret', profileName: 'Direct Keyless Broken' }));
    });
});
