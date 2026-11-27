// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
    areLookupNamesEqual,
    findCanonicalIndexInList,
    findCanonicalNameInList,
    normalizeLookupText,
} from '../../public/scripts/util/lookup-name.js';
import {
    isSummaryResourceEntry,
    loadLazyNamedDocumentEntries,
    loadLazyPresetDocumentEntries,
    loadPresetResources,
    resolveBootstrapSelectedNames,
} from '../../public/scripts/named-resource-read.js';
import {
    activePresetApiId,
    loadSettingsEnvelope,
    selectedPresetNames,
} from '../../public/scripts/settings-resource-read.js';
import { resetResourceReads } from '../../public/scripts/resource-read.js';

describe('lookup-name pure helpers', () => {
    test('normalizes whitespace, NFC composition, and variation selectors', () => {
        const decomposed = 'Cafe\u0301\uFE0F';
        const composed = 'Caf\u00E9';
        expect(normalizeLookupText(`  ${decomposed}  `)).toBe(composed);
        expect(areLookupNamesEqual(decomposed, composed)).toBe(true);
        expect(areLookupNamesEqual('Alpha', 'alpha')).toBe(false);
        expect(areLookupNamesEqual('Alpha', 'alpha', { caseInsensitive: true })).toBe(true);
    });

    test('findCanonicalNameInList prefers exact, then normalized, then case-insensitive', () => {
        const list = ['default', 'Default', 'Cafe\u0301'];
        expect(findCanonicalNameInList(list, 'Default', { caseInsensitive: true })).toBe('Default');
        expect(findCanonicalNameInList(list, 'DEFAULT', { caseInsensitive: true })).toBe('default');
        expect(findCanonicalNameInList(list, 'Caf\u00E9', { caseInsensitive: true })).toBe('Cafe\u0301');
        expect(findCanonicalIndexInList(list, 'Caf\u00E9')).toBe(2);
    });
});

describe('bootstrap preset candidate selection', () => {
    test('selectedPresetNames deduplicates OpenAI candidates, defaults to Default, and skips Kobold gui', () => {
        expect(selectedPresetNames({})).toEqual({
            novel: [],
            openai: ['Default'],
            textgenerationwebui: [],
            kobold: [],
        });

        expect(selectedPresetNames({
            main_api: 'openai',
            preset_settings_novel: 'NovelOne',
            preset_settings: 'gui',
            textgenerationwebui_settings: { preset: 'TextOne' },
            oai_settings: {
                global_preset_settings_openai: 'GlobalPreset',
                preset_settings_openai: 'CardSlotPreset',
            },
            preset_settings_openai: 'GlobalPreset',
        })).toEqual({
            novel: ['NovelOne'],
            openai: ['GlobalPreset', 'CardSlotPreset'],
            textgenerationwebui: ['TextOne'],
            kobold: [],
        });

        expect(selectedPresetNames({
            main_api: 'openai',
            preset_settings_novel: 'NovelOne',
            kai_settings: { preset_settings: 'KoboldOne' },
            textgenerationwebui_settings: { preset: 'TextOne' },
            oai_settings: { global_preset_settings_openai: 'ActiveOpenAI' },
        }, { activeApiOnly: true })).toEqual({
            novel: [],
            openai: ['ActiveOpenAI'],
            textgenerationwebui: [],
            kobold: [],
        });

        expect(activePresetApiId({ main_api: 'koboldhorde' })).toBe('kobold');
        expect(activePresetApiId({ main_api: 'novel' })).toBe('novel');
        expect(activePresetApiId({ main_api: 'unknown' })).toBe('openai');
    });

    test('resolveBootstrapSelectedNames matches candidates tolerantly and falls back to names[0] when all candidates are missing', () => {
        expect(resolveBootstrapSelectedNames(['Alpha', 'My Preset'], ['  my preset '])).toEqual(['My Preset']);
        expect(resolveBootstrapSelectedNames(['Alpha', 'Caf\u00E9'], ['Cafe\u0301\uFE0F'])).toEqual(['Caf\u00E9']);
        expect(resolveBootstrapSelectedNames(['Alpha', 'Fallback'], ['DeletedGlobal', 'Fallback'])).toEqual(['Fallback']);
        expect(resolveBootstrapSelectedNames(['FirstOnDisk', 'Second'], ['DeletedGlobal', 'DeletedActive'])).toEqual(['FirstOnDisk']);
        expect(resolveBootstrapSelectedNames(['FirstOnDisk'], [])).toEqual([]);
        expect(resolveBootstrapSelectedNames([], ['Default'])).toEqual([]);
    });
});

describe('loadPresetResources bounded concurrency, scoping, and abort handling', () => {
    const origFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = origFetch;
        resetResourceReads();
    });

    function createPresetFetchMock(catalog, { onGet } = {}) {
        return jest.fn(async (url, init = {}) => {
            const urlText = String(url);
            if (urlText.startsWith('/api/bootstrap/metadata')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({ account: 'default-user' }),
                };
            }
            const parsed = new URL(urlText, 'http://127.0.0.1');
            const apiId = parsed.searchParams.get('apiId');
            if (parsed.pathname === '/api/presets/list') {
                const names = Object.keys(catalog[apiId] || {});
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ names }),
                };
            }
            if (parsed.pathname === '/api/presets/get') {
                const name = parsed.searchParams.get('name');
                if (onGet) {
                    const custom = await onGet({ apiId, name, signal: init.signal });
                    if (custom) return custom;
                }
                const doc = catalog[apiId]?.[name];
                if (!doc) {
                    return {
                        ok: false,
                        status: 404,
                        statusText: 'Not Found',
                        headers: new Headers(),
                        text: async () => '',
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify(doc),
                };
            }
            throw new Error(`Unexpected fetch: ${urlText}`);
        });
    }

    test('hydrates fallback names[0] when saved preset was deleted on disk and supports apiIds scoping', async () => {
        const fetched = [];
        globalThis.fetch = createPresetFetchMock({
            openai: {
                Alpha: { temperature: 0.4 },
                Beta: { temperature: 0.9 },
            },
            novel: {
                NovelA: { temperature: 0.7 },
            },
            textgenerationwebui: {},
            kobold: {},
        }, {
            onGet: ({ apiId, name }) => {
                fetched.push(`${apiId}/${name}`);
            },
        });

        const result = await loadPresetResources({
            selected: { openai: ['DeletedPreset'], novel: [] },
            complete: false,
        });

        expect(fetched).toEqual(['openai/Alpha']);
        expect(result.openai_setting_names).toEqual(['Alpha', 'Beta']);
        expect(result.openai_settings).toEqual([JSON.stringify({ temperature: 0.4 }), null]);
        expect(result.novelai_setting_names).toEqual(['NovelA']);
        expect(result.novelai_settings).toEqual([null]);

        fetched.length = 0;
        const scoped = await loadPresetResources({
            apiIds: ['openai'],
            complete: true,
            skipNames: { openai: ['Alpha'] },
        });
        expect(fetched).toEqual(['openai/Beta']);
        expect(Object.keys(scoped).sort()).toEqual(['openai_setting_names', 'openai_settings']);
        expect(scoped.openai_settings).toEqual([null, JSON.stringify({ temperature: 0.9 })]);
    });

    test('enforces global concurrency across multiple APIs in complete preload', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        globalThis.fetch = createPresetFetchMock({
            openai: { O1: { v: 1 }, O2: { v: 2 }, O3: { v: 3 } },
            novel: { N1: { v: 1 }, N2: { v: 2 }, N3: { v: 3 } },
            textgenerationwebui: { T1: { v: 1 }, T2: { v: 2 } },
            kobold: { K1: { v: 1 }, K2: { v: 2 } },
        }, {
            onGet: async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 4));
                inFlight -= 1;
            },
        });

        const result = await loadPresetResources({ complete: true, concurrency: 2 });
        expect(result.openai_settings).toHaveLength(3);
        expect(result.novelai_settings).toHaveLength(3);
        expect(maxInFlight).toBe(2);
    });

    test('aborts in-flight siblings on fatal HTTP 500 and honors external AbortSignal', async () => {
        let abortedSlow = false;
        const started = [];
        globalThis.fetch = createPresetFetchMock({
            openai: {
                P0: { v: 0 },
                P1: { v: 1 },
                P2: { v: 2 },
                P3: { v: 3 },
            },
        }, {
            onGet: async ({ name, signal }) => {
                started.push(name);
                if (name === 'P0') {
                    return {
                        ok: false,
                        status: 500,
                        statusText: 'Internal Server Error',
                        headers: new Headers(),
                        text: async () => '',
                    };
                }
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => {
                        abortedSlow = true;
                        reject(new DOMException('Aborted', 'AbortError'));
                    }, { once: true });
                });
            },
        });

        await expect(loadPresetResources({
            apiIds: ['openai'],
            complete: true,
            concurrency: 2,
        })).rejects.toMatchObject({ status: 500 });
        expect(abortedSlow).toBe(true);
        expect(started).toEqual(['P0', 'P1']);

        resetResourceReads();
        const controller = new AbortController();
        let externallyAborted = false;
        globalThis.fetch = createPresetFetchMock({
            openai: { SlowOne: { v: 1 } },
        }, {
            onGet: ({ signal }) => new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    externallyAborted = true;
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
                setTimeout(() => controller.abort(), 5);
            }),
        });

        await expect(loadPresetResources({
            apiIds: ['openai'],
            complete: true,
            signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(externallyAborted).toBe(true);
    });
});

describe('lazy advanced formatting and movingUI bootstrap hydration', () => {
    const origFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = origFetch;
        resetResourceReads();
    });

    test('loadSettingsEnvelope({ bootstrap: true }) fetches only active formatting templates, active theme, and active API preset', async () => {
        const fetchedUrls = [];
        const settingsDoc = {
            main_api: 'openai',
            preset_settings_novel: 'NovelUnused',
            oai_settings: {
                global_preset_settings_openai: 'ActiveOpenAI',
                preset_settings_openai: 'ActiveOpenAI',
            },
            power_user: {
                theme: 'NightTheme',
                instruct: { preset: 'ChatML' },
                context: { preset: 'DefaultContext' },
                sysprompt: { name: 'Concise' },
                reasoning: { name: 'Think XML' },
            },
        };
        const presetCatalog = {
            openai: { ActiveOpenAI: { temperature: 0.7 }, ColdOpenAI: { temperature: 1.0 } },
            novel: { NovelUnused: { temperature: 0.8 } },
            textgenerationwebui: { TextUnused: { temp: 0.9 } },
            kobold: { KoboldUnused: { temp: 0.9 } },
            instruct: { ChatML: { input_sequence: '<|im_start|>user\n' }, Alpaca: { input_sequence: '### Instruction:\n' } },
            context: { DefaultContext: { story_string: '{{system}}' }, Roleplay: { story_string: '{{char}}' } },
            sysprompt: { Concise: { content: 'Be brief.' }, Verbose: { content: 'Be thorough.' } },
            reasoning: { 'Think XML': { prefix: '<think>', suffix: '</think>' }, DeepSeek: { prefix: '<thought>', suffix: '</thought>' } },
        };
        const namedCatalog = {
            themes: { NightTheme: { main_text_color: '#fff' }, DayTheme: { main_text_color: '#000' } },
            'moving-ui': { Default: { movingUIState: { a: 1 } }, Compact: { movingUIState: { b: 2 } } },
        };

        globalThis.fetch = jest.fn(async (url) => {
            const urlText = String(url);
            fetchedUrls.push(urlText);
            if (urlText.startsWith('/api/bootstrap/metadata')) {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    json: async () => ({
                        account: 'default-user',
                        enable_extensions: true,
                        enable_extensions_auto_update: false,
                        enable_accounts: false,
                    }),
                };
            }
            const parsed = new URL(urlText, 'http://127.0.0.1');
            if (parsed.pathname === '/api/settings/fields') {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json', etag: 'W/"dir"' }),
                    text: async () => JSON.stringify({
                        containers: [{ path: '', keys: Object.keys(settingsDoc) }],
                        fields: Object.keys(settingsDoc).map(key => ({ path: `/${key}`, etag: `W/"${key}"` })),
                    }),
                };
            }
            if (parsed.pathname === '/api/settings/field') {
                const fieldPath = parsed.searchParams.get('path');
                const key = fieldPath.slice(1);
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json', etag: `W/"${key}"` }),
                    text: async () => JSON.stringify(settingsDoc[key]),
                };
            }
            if (parsed.pathname === '/api/worldinfo/list') {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ names: [] }),
                };
            }
            if (parsed.pathname === '/api/presets/list') {
                const apiId = parsed.searchParams.get('apiId');
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ names: Object.keys(presetCatalog[apiId] || {}) }),
                };
            }
            if (parsed.pathname === '/api/presets/get') {
                const apiId = parsed.searchParams.get('apiId');
                const name = parsed.searchParams.get('name');
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify(presetCatalog[apiId][name]),
                };
            }
            if (parsed.pathname === '/api/themes/list') {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ names: Object.keys(namedCatalog.themes), builtin: ['NightTheme'] }),
                };
            }
            if (parsed.pathname === '/api/themes/get') {
                const name = parsed.searchParams.get('name');
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify(namedCatalog.themes[name]),
                };
            }
            if (parsed.pathname === '/api/moving-ui/list') {
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify({ names: Object.keys(namedCatalog['moving-ui']) }),
                };
            }
            if (parsed.pathname === '/api/moving-ui/get') {
                const name = parsed.searchParams.get('name');
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'application/json' }),
                    text: async () => JSON.stringify(namedCatalog['moving-ui'][name]),
                };
            }
            throw new Error(`Unexpected fetch URL: ${urlText}`);
        });

        const envelope = await loadSettingsEnvelope({ bootstrap: true });

        expect(envelope.movingUIPresets).toEqual([
            { name: 'Default', _summary: true },
            { name: 'Compact', _summary: true },
        ]);
        expect(fetchedUrls.some(url => url.includes('/api/moving-ui/get'))).toBe(false);

        expect(envelope.instruct).toEqual([
            { name: 'ChatML', input_sequence: '<|im_start|>user\n' },
            { name: 'Alpaca', _summary: true },
        ]);
        expect(envelope.context).toEqual([
            { name: 'DefaultContext', story_string: '{{system}}' },
            { name: 'Roleplay', _summary: true },
        ]);
        expect(envelope.sysprompt).toEqual([
            { name: 'Concise', content: 'Be brief.' },
            { name: 'Verbose', _summary: true },
        ]);
        expect(envelope.reasoning).toEqual([
            { name: 'Think XML', prefix: '<think>', suffix: '</think>' },
            { name: 'DeepSeek', _summary: true },
        ]);
        expect(isSummaryResourceEntry(envelope.instruct[0])).toBe(false);
        expect(isSummaryResourceEntry(envelope.instruct[1])).toBe(true);

        const presetGets = fetchedUrls.filter(url => url.includes('/api/presets/get'));
        expect(presetGets).toHaveLength(5);
        expect(presetGets.some(url => url.includes('ColdOpenAI'))).toBe(false);
        expect(presetGets.some(url => url.includes('NovelUnused'))).toBe(false);
        expect(presetGets.some(url => url.includes('Alpaca'))).toBe(false);
        expect(presetGets.some(url => url.includes('Roleplay'))).toBe(false);
        expect(presetGets.some(url => url.includes('Verbose'))).toBe(false);
        expect(presetGets.some(url => url.includes('DeepSeek'))).toBe(false);

        // Direct helpers match case-insensitively without falling back to names[0]
        const lazyMoving = await loadLazyNamedDocumentEntries('movingUI', ['compact']);
        expect(lazyMoving).toEqual([
            { name: 'Default', _summary: true },
            { name: 'Compact', movingUIState: { b: 2 } },
        ]);
        const lazyMissing = await loadLazyPresetDocumentEntries('instruct', ['DoesNotExist']);
        expect(lazyMissing).toEqual([
            { name: 'ChatML', _summary: true },
            { name: 'Alpaca', _summary: true },
        ]);
    });
});
