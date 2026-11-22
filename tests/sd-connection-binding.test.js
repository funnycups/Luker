import {
    CONNECTION_PROFILE_CAPABLE_SOURCES,
    DIRECT_SECRET_KEY_BY_SOURCE,
    listCompatibleConnectionProfiles,
    resolveSdConnectionBinding,
    validateBoundProfileForModelRefresh,
} from '../public/scripts/extensions/stable-diffusion/connection-binding.js';
import {
    prepareGenerationExtraOptions,
} from '../public/scripts/extensions/stable-diffusion/capabilities.js';
import {
    CHARACTER_REFERENCE_MODES,
    GENERATION_CONFIG_KEYS,
    applyGenerationConfig,
    createGenerationPreset,
    normalizeGenerationPreset,
    normalizeGenerationPresets,
    normalizeReferenceSettings,
    pickGenerationConfig,
} from '../public/scripts/extensions/stable-diffusion/generation-presets.js';

describe('sd connection binding and preset isolation', () => {
    const sampleProfiles = [
        {
            id: 'p1',
            name: 'Gemini Proxy',
            mode: 'cc',
            api: 'makersuite',
            model: 'gemini-2.5-pro',
            'secret-id': 'sec-gemini-1',
            'api-url': 'https://gemini.proxy.example',
            'network-proxy': 'http://127.0.0.1:7890',
        },
        {
            id: 'p2',
            name: 'OpenAI Relay',
            mode: 'cc',
            api: 'custom',
            model: 'gpt-4.1',
            'secret-id': 'sec-custom-1',
            'api-url': 'https://relay.example/v1',
            'network-proxy': 'socks5://127.0.0.1:1080',
        },
        {
            id: 'p3',
            name: 'OpenRouter Main',
            mode: 'cc',
            api: 'openrouter',
            model: 'anthropic/claude-sonnet-4',
            'secret-id': 'sec-or-1',
        },
        {
            id: 'p4',
            name: 'Broken Keyless OpenAI',
            mode: 'cc',
            api: 'openai',
            model: 'gpt-4o',
            'secret-id': '',
        },
        {
            id: 'p5',
            name: 'Pollinations Free',
            mode: 'cc',
            api: 'pollinations',
            'secret-id': '',
        },
    ];

    test('lists all connection-profile-capable sources and filters compatible profiles per source', () => {
        expect(CONNECTION_PROFILE_CAPABLE_SOURCES.has('google')).toBe(true);
        expect(CONNECTION_PROFILE_CAPABLE_SOURCES.has('chat_image')).toBe(true);
        expect(CONNECTION_PROFILE_CAPABLE_SOURCES.has('comfy')).toBe(false);

        expect(listCompatibleConnectionProfiles('google', sampleProfiles).map(p => p.name)).toEqual(['Gemini Proxy']);
        expect(listCompatibleConnectionProfiles('openai', sampleProfiles).map(p => p.name)).toEqual([
            'Broken Keyless OpenAI',
            'OpenAI Relay',
        ]);
        expect(listCompatibleConnectionProfiles('chat_image', sampleProfiles).map(p => p.name)).toEqual([
            'Broken Keyless OpenAI',
            'Gemini Proxy',
            'OpenAI Relay',
            'OpenRouter Main',
            'Pollinations Free',
        ]);
    });

    test('returns direct mode when connection_profile is empty', () => {
        const sd = { source: 'google', model: 'gemini-2.5-flash-image', connection_profile: '' };
        const res = resolveSdConnectionBinding(sd, { connectionProfiles: { list: () => sampleProfiles } });
        expect(res).toEqual({
            mode: 'direct',
            profileName: '',
            secretId: '',
            apiUrl: '',
            networkProxy: '',
            googleApi: '',
        });
        expect(DIRECT_SECRET_KEY_BY_SOURCE('google', sd)).toBe('api_key_makersuite');
        expect(DIRECT_SECRET_KEY_BY_SOURCE('google', { google_api: 'vertexai' })).toBe('api_key_vertexai');
        expect(DIRECT_SECRET_KEY_BY_SOURCE('novel', {})).toBe('api_key_novel');
    });

    test('resolves bound connection_profile credentials, endpoint, and proxy without overwriting sd.model', () => {
        const sd = {
            source: 'google',
            model: 'gemini-3-pro-image',
            google_api: 'vertexai',
            connection_profile: 'Gemini Proxy',
        };
        const res = resolveSdConnectionBinding(sd, { connectionProfiles: { list: () => sampleProfiles } });
        expect(res).toEqual({
            mode: 'profile',
            profileName: 'Gemini Proxy',
            secretId: 'sec-gemini-1',
            apiUrl: 'https://gemini.proxy.example',
            networkProxy: 'http://127.0.0.1:7890',
            googleApi: 'makersuite',
        });
        expect(sd.model).toBe('gemini-3-pro-image');
    });

    test('throws explicit errors when selected connection_profile is missing, incompatible, or lacks secret_id', () => {
        const ctx = { connectionProfiles: { list: () => sampleProfiles } };

        expect(() => resolveSdConnectionBinding(
            { source: 'google', connection_profile: 'Deleted Profile' },
            ctx,
        )).toThrow(/Deleted Profile/);

        expect(() => resolveSdConnectionBinding(
            { source: 'google', connection_profile: 'OpenRouter Main' },
            ctx,
        )).toThrow(/OpenRouter Main/);

        expect(() => resolveSdConnectionBinding(
            { source: 'openai', connection_profile: 'Broken Keyless OpenAI' },
            ctx,
        )).toThrow(/Broken Keyless OpenAI/);

        // Pollinations allows keyless public access
        expect(resolveSdConnectionBinding(
            { source: 'pollinations', connection_profile: 'Pollinations Free' },
            ctx,
        ).mode).toBe('profile');
    });

    test('GENERATION_CONFIG_KEYS includes connection/url/style_references and deep-clones style_references across presets', () => {
        expect(GENERATION_CONFIG_KEYS).toEqual(expect.arrayContaining([
            'connection_profile',
            'novel_url',
            'chat_image_url',
            'style_references',
        ]));

        const sd = {
            source: 'novel',
            model: 'nai-diffusion-4-5-full',
            connection_profile: '',
            novel_url: 'https://nai-mirror.example',
            chat_image_url: '',
            style_references: [{ imagePath: '/user/images/_style_references/s1.png', strength: 0.6 }],
        };
        const bucket = normalizeGenerationPresets(undefined, { currentConfig: pickGenerationConfig(sd), now: 1000 });
        const second = createGenerationPreset(bucket, {
            name: 'Alt Style',
            config: pickGenerationConfig(sd),
            now: 1001,
        });

        sd.style_references[0].strength = 0.2;
        expect(bucket.presets[0].config.style_references[0].strength).toBe(0.6);
        expect(second.config.style_references[0].strength).toBe(0.6);

        const targetSd = { style_references: [] };
        applyGenerationConfig(targetSd, second.config);
        targetSd.style_references[0].strength = 0.95;
        expect(second.config.style_references[0].strength).toBe(0.6);
    });

    test('validateBoundProfileForModelRefresh validates static-list sources on model refresh and prepareGenerationExtraOptions honors preset width/height and rejects Comfy RunPod references', () => {
        const ctx = { connectionProfiles: { list: () => sampleProfiles } };
        for (const source of ['google', 'openai', 'xai', 'zai']) {
            expect(() => validateBoundProfileForModelRefresh(
                { source, connection_profile: 'Deleted Static Profile' },
                ctx,
            )).toThrow(/Deleted Static Profile/);
        }

        const { extraOptions } = prepareGenerationExtraOptions(
            { source: 'openai', model: 'gpt-image-1', width: 512, height: 512 },
            { aspectRatio: '16:9' },
        );
        // 512*512 = 262,144 area -> 16:9 aligned to 64 is ~704x384 (strictly below 1024x1024's 1344x768)
        expect(extraOptions.width).toBeLessThan(1000);
        expect(extraOptions.height).toBeLessThan(600);

        expect(() => prepareGenerationExtraOptions(
            { source: 'comfy', comfy_type: 'runpod_serverless', model: 'flux' },
            { references: [{ imagePath: '/user/images/_references/a.png', role: 'character' }] },
        )).toThrow(/does not support character reference images/i);
    });

    test('GENERATION_CONFIG_KEYS includes reference switches and normalize/apply prevent legacy preset state leakage', () => {
        expect(CHARACTER_REFERENCE_MODES).toEqual(['text_only', 'image_only', 'text_and_image']);
        expect(GENERATION_CONFIG_KEYS).toEqual(expect.arrayContaining([
            'character_reference_enabled',
            'character_reference_mode',
            'style_references_enabled',
            'img2img_enabled',
        ]));

        expect(normalizeReferenceSettings(undefined)).toEqual({
            character_reference_enabled: false,
            character_reference_mode: 'text_only',
            style_references_enabled: false,
            img2img_enabled: false,
        });
        expect(normalizeReferenceSettings({
            character_reference_enabled: 1,
            character_reference_mode: 'invalid_mode',
            style_references: [{ imagePath: '/user/images/_style_references/v1.png', strength: 0.6 }],
            img2img_enabled: true,
        })).toEqual({
            character_reference_enabled: true,
            character_reference_mode: 'text_only',
            style_references_enabled: true,
            img2img_enabled: true,
        });
        expect(normalizeReferenceSettings({
            style_references: [{ imagePath: '/user/images/_style_references/v1.png', strength: 0.6 }],
            style_references_enabled: false,
        }).style_references_enabled).toBe(false);

        const legacyWithStyle = normalizeGenerationPreset({
            id: 'gp_legacy_style',
            name: 'Legacy With Style',
            config: {
                source: 'novel',
                model: 'nai-diffusion-4-5-full',
                style_references: [{ imagePath: '/user/images/_style_references/s1.png', strength: 0.6 }],
            },
        }, 1000);
        expect(legacyWithStyle.config).toMatchObject({
            character_reference_enabled: false,
            character_reference_mode: 'text_only',
            style_references_enabled: true,
            img2img_enabled: false,
        });

        const legacyEmptyStyle = normalizeGenerationPreset({
            id: 'gp_legacy_empty',
            name: 'Legacy Empty Style',
            config: {
                source: 'novel',
                model: 'nai-diffusion-4-5-full',
                style_references: [],
            },
        }, 1000);
        expect(legacyEmptyStyle.config).toMatchObject({
            character_reference_enabled: false,
            character_reference_mode: 'text_only',
            style_references_enabled: false,
            img2img_enabled: false,
        });

        const sd = {
            source: 'google',
            model: 'gemini-3-pro-image',
            character_reference_enabled: true,
            character_reference_mode: 'text_and_image',
            style_references_enabled: true,
            img2img_enabled: true,
        };
        applyGenerationConfig(sd, { source: 'pollinations', model: 'flux' });
        expect(sd).toMatchObject({
            source: 'pollinations',
            model: 'flux',
            character_reference_enabled: false,
            character_reference_mode: 'text_only',
            style_references_enabled: false,
            img2img_enabled: false,
        });
    });
});
