import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const jqueryElement = {
    append: jest.fn(function () { return this; }),
    children: jest.fn(() => ({ each: jest.fn() })),
    detach: jest.fn(function () { return this; }),
    empty: jest.fn(function () { return this; }),
    find: jest.fn(function () { return this; }),
    on: jest.fn(function () { return this; }),
    prop: jest.fn(function () { return this; }),
    trigger: jest.fn(function () { return this; }),
    val: jest.fn(function () { return this; }),
};

global.$ = jest.fn(() => jqueryElement);

jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: { signal: undefined },
    ensureFullSettingsLoaded: jest.fn(),
    event_types: {},
    eventSource: { emit: jest.fn() },
    getRequestHeaders: jest.fn(),
    getStoppingStrings: jest.fn(),
    resultCheckStatus: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    setGenerationParamsFromPreset: jest.fn(),
    setOnlineStatus: jest.fn(),
    startStatusLoading: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    MAX_CONTEXT_DEFAULT: 8192,
    MAX_RESPONSE_DEFAULT: 150,
    power_user: {},
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTextTokens: jest.fn(),
    tokenizers: { NONE: 0, NERD: 1, NERD2: 2, LLAMA3: 3 },
}));
jest.unstable_mockModule('../public/scripts/sse-stream.js', () => ({ getEventSourceStream: jest.fn() }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    buildPresetNameIndexMap: jest.fn(() => new Map()),
    getOrderedPresetNames: jest.fn(() => []),
    getSortableDelay: jest.fn(),
    getStringHash: jest.fn(),
    onlyUnique: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/logit-bias.js', () => ({
    BIAS_CACHE: new Map(),
    createNewLogitBiasEntry: jest.fn(),
    displayLogitBias: jest.fn(),
    getLogitBiasListResult: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings) => Array.isArray(strings) ? strings[0] : String(strings),
}));
jest.unstable_mockModule('../public/scripts/extensions/connection-manager/profile-retry.js', () => ({
    withProfileRetry: async (fn) => await fn(),
}));

let naiModule;
let ensureNovelPresetHydrated;
let loadNovelPreset;
let loadNovelSettings;
let naiSettings;

beforeAll(async () => {
    naiModule = await import('../public/scripts/nai-settings.js');
    ({
        ensureNovelPresetHydrated,
        loadNovelPreset,
        loadNovelSettings,
        nai_settings: naiSettings,
    } = naiModule);
});

describe('NovelAI settings', () => {
    test('preserves a zero Math1 temperature when loading settings', () => {
        loadNovelSettings(
            { novelai_setting_names: [], novelai_settings: [] },
            { ...naiSettings, math1_temp: 0 },
        );
        expect(naiSettings.math1_temp).toBe(0);

        naiSettings.math1_temp = 1;
        loadNovelPreset({ ...naiSettings, genamt: 150, math1_temp: 0 });
        expect(naiSettings.math1_temp).toBe(0);
    });

    test('hydrates a single unhydrated NovelAI preset on demand without fetching sibling presets', async () => {
        const origFetch = globalThis.fetch;
        const requestedUrls = [];
        globalThis.fetch = jest.fn(async (url) => {
            const urlText = String(url);
            requestedUrls.push(urlText);
            if (urlText.startsWith('/api/bootstrap/metadata')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({ account: 'default-user' }),
                };
            }
            if (urlText.includes('/api/presets/get?') && urlText.includes('apiId=novel') && urlText.includes('name=ColdNovel')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ temperature: 1.15, top_p: 0.9 }),
                };
            }
            throw new Error(`Unexpected fetch: ${urlText}`);
        });

        try {
            loadNovelSettings(
                { novelai_setting_names: ['ColdNovel', 'SiblingNovel'], novelai_settings: [null, null] },
                { ...naiSettings },
            );
            const hydrated = await ensureNovelPresetHydrated('ColdNovel');
            expect(hydrated).toEqual({ temperature: 1.15, top_p: 0.9 });
            expect(naiModule.novelai_settings[0]).toEqual({ temperature: 1.15, top_p: 0.9 });
            expect(naiModule.novelai_settings[1]).toBeNull();
            expect(requestedUrls.filter(url => url.includes('/api/presets/'))).toHaveLength(1);
            expect(requestedUrls.some(url => url.includes('SiblingNovel'))).toBe(false);
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
