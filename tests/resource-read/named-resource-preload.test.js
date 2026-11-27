// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
    areLookupNamesEqual,
    findCanonicalIndexInList,
    findCanonicalNameInList,
    normalizeLookupText,
} from '../../public/scripts/util/lookup-name.js';
import {
    loadPresetResources,
    resolveBootstrapSelectedNames,
} from '../../public/scripts/named-resource-read.js';
import {
    activePresetApiId,
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
