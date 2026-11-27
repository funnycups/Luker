import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

const { resetResourceReads } = await import('../../public/scripts/resource-read.js');
const {
    NAMED_RESOURCE_READ_CONCURRENCY,
    loadPresetResources,
} = await import('../../public/scripts/named-resource-read.js');
const { selectedPresetNames } = await import('../../public/scripts/settings-resource-read.js');

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('preset bootstrap selection and bounded preload', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        resetResourceReads();
    });

    afterEach(() => {
        resetResourceReads();
        globalThis.fetch = originalFetch;
    });

    test('selectedPresetNames collects deduplicated OpenAI candidates and falls back to Default only when empty', () => {
        const candidates = selectedPresetNames({
            oai_settings: {
                global_preset_settings_openai: '  GlobalPreset  ',
                preset_settings_openai: 'ActivePreset',
            },
            preset_settings_openai: 'GlobalPreset',
        });

        expect(candidates.openai).toEqual(['GlobalPreset', 'ActivePreset']);
        expect(selectedPresetNames({}).openai).toEqual(['Default']);
    });

    test('bootstrap loadPresetResources hydrates multiple candidates, matches case-insensitively, and falls back to first preset when missing', async () => {
        const lists = {
            novel: [],
            openai: ['Alpha', 'SillyPreset v4', 'ActivePreset'],
            textgenerationwebui: ['FirstTgw', 'SecondTgw'],
            kobold: ['OnlyKobold'],
        };
        const fetchedDocs = [];

        globalThis.fetch = jest.fn(async (input) => {
            const url = new URL(String(input), 'http://127.0.0.1');
            if (url.pathname === '/api/bootstrap/metadata') {
                return jsonResponse({
                    account: 'default-user',
                    enable_extensions: true,
                    enable_extensions_auto_update: false,
                    enable_accounts: false,
                });
            }
            if (url.pathname === '/api/presets/list') {
                const apiId = url.searchParams.get('apiId');
                return jsonResponse({ names: lists[apiId] || [] });
            }
            if (url.pathname === '/api/presets/get') {
                const apiId = url.searchParams.get('apiId');
                const name = url.searchParams.get('name');
                fetchedDocs.push(`${apiId}:${name}`);
                return jsonResponse({ presetName: name });
            }
            return jsonResponse({ error: 'unexpected' }, 404);
        });

        const result = await loadPresetResources({
            selected: {
                openai: ['  sillypreset v4  ', 'ActivePreset'],
                textgenerationwebui: 'DeletedPresetName',
            },
            complete: false,
        });

        expect(result.openai_setting_names).toEqual(['Alpha', 'SillyPreset v4', 'ActivePreset']);
        expect(result.openai_settings).toEqual([
            null,
            JSON.stringify({ presetName: 'SillyPreset v4' }),
            JSON.stringify({ presetName: 'ActivePreset' }),
        ]);

        // Missing saved preset falls back to hydrating index 0; unspecified APIs issue no extra document reads.
        expect(result.textgenerationwebui_presets).toEqual([
            JSON.stringify({ presetName: 'FirstTgw' }),
            null,
        ]);
        expect(result.koboldai_settings).toEqual([null]);
        expect(fetchedDocs).not.toContain('kobold:OnlyKobold');
    });

    test('complete loadPresetResources enforces bounded concurrency and preserves preset order', async () => {
        const openaiNames = Array.from({ length: 20 }, (_, idx) => `Preset-${idx}`);
        let activeGets = 0;
        let peakGets = 0;

        globalThis.fetch = jest.fn(async (input) => {
            const url = new URL(String(input), 'http://127.0.0.1');
            if (url.pathname === '/api/bootstrap/metadata') {
                return jsonResponse({
                    account: 'default-user',
                    enable_extensions: true,
                    enable_extensions_auto_update: false,
                    enable_accounts: false,
                });
            }
            if (url.pathname === '/api/presets/list') {
                const apiId = url.searchParams.get('apiId');
                return jsonResponse({ names: apiId === 'openai' ? openaiNames : [] });
            }
            if (url.pathname === '/api/presets/get') {
                const name = url.searchParams.get('name');
                activeGets += 1;
                peakGets = Math.max(peakGets, activeGets);
                try {
                    await new Promise(resolve => setTimeout(resolve, 8));
                    return jsonResponse({ name });
                } finally {
                    activeGets -= 1;
                }
            }
            return jsonResponse({}, 404);
        });

        const result = await loadPresetResources({
            complete: true,
            skipNames: { openai: ['Preset-3'] },
        });

        expect(peakGets).toBeGreaterThan(1);
        expect(peakGets).toBeLessThanOrEqual(NAMED_RESOURCE_READ_CONCURRENCY);
        expect(result.openai_setting_names).toEqual(openaiNames);
        expect(result.openai_settings[0]).toBe(JSON.stringify({ name: 'Preset-0' }));
        expect(result.openai_settings[3]).toBeNull();
        expect(result.openai_settings[19]).toBe(JSON.stringify({ name: 'Preset-19' }));
    });

    test('aborting complete loadPresetResources stops queued preset reads', async () => {
        const openaiNames = Array.from({ length: 24 }, (_, idx) => `Preset-${idx}`);
        const requestedNames = [];
        let notifyFirstGet;
        const firstGetEntered = new Promise((resolve) => { notifyFirstGet = resolve; });

        globalThis.fetch = jest.fn(async (input, init) => {
            const url = new URL(String(input), 'http://127.0.0.1');
            if (url.pathname === '/api/bootstrap/metadata') {
                return jsonResponse({
                    account: 'default-user',
                    enable_extensions: true,
                    enable_extensions_auto_update: false,
                    enable_accounts: false,
                });
            }
            if (url.pathname === '/api/presets/list') {
                const apiId = url.searchParams.get('apiId');
                return jsonResponse({ names: apiId === 'openai' ? openaiNames : [] });
            }
            if (url.pathname === '/api/presets/get') {
                requestedNames.push(url.searchParams.get('name'));
                notifyFirstGet();
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => resolve(jsonResponse({ ok: true })), 200);
                    init?.signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    }, { once: true });
                });
            }
            return jsonResponse({}, 404);
        });

        const controller = new AbortController();
        const pending = loadPresetResources({ complete: true, signal: controller.signal });
        await firstGetEntered;
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(requestedNames.length).toBeLessThanOrEqual(NAMED_RESOURCE_READ_CONCURRENCY);
    });
});
