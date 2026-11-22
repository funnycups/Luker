// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest, beforeEach } from '@jest/globals';


describe('search-tools provider capabilities, extension API, and orchestrator image tools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('SEARCH_PROVIDERS marks supportsImageSearch accurately across all 9 providers', async () => {
        const { SEARCH_PROVIDERS } = await import('../public/scripts/extensions/search-tools/providers.js');
        const imageCapable = SEARCH_PROVIDERS.filter(p => p.supportsImageSearch === true).map(p => p.id).sort();
        const textOnly = SEARCH_PROVIDERS.filter(p => p.supportsImageSearch === false).map(p => p.id).sort();

        expect(imageCapable).toEqual(['brave', 'ddg', 'searxng', 'serpapi', 'serper', 'tavily']);
        expect(textOnly).toEqual(['deepseek', 'exa', 'zai']);
    });

    test('registers search-tools extension API on context and exposes searchImages, extractPageImages, and getActiveProviderCapabilities', async () => {
        const extensionApis = new Map();
        const fetchCalls = [];
        globalThis.fetch = jest.fn(async (url, init = {}) => {
            fetchCalls.push({ url, body: init.body ? JSON.parse(init.body) : null });
            if (url === '/api/search/images') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        provider: 'serper',
                        query: 'character portrait',
                        result_count: 1,
                        results: [{
                            title: 'Portrait',
                            imageUrl: 'https://cdn.example.org/p.png',
                            thumbnailUrl: 'https://cdn.example.org/p_s.png',
                            pageUrl: 'https://wiki.example.org/p',
                            width: 800,
                            height: 1200,
                            source: 'serper',
                        }],
                    }),
                };
            }
            if (url === '/api/search/page-images') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        pageTitle: 'Wiki Character',
                        pageUrl: 'https://wiki.example.org/p',
                        images: [{ imageUrl: 'https://cdn.example.org/p.png', alt: 'Full Art', caption: 'Default' }],
                    }),
                };
            }
            throw new Error(`Unexpected fetch URL: ${url}`);
        });

        let readyCallback = null;
        globalThis.jQuery = (fn) => {
            if (typeof fn === 'function') readyCallback = fn;
            return {
                empty: () => {},
                append: () => {},
                find: () => ({ length: 0, on: () => {} }),
                on: () => {},
                length: 0,
            };
        };
        globalThis.$ = globalThis.jQuery;

        const extensionSettings = {
            search_tools: {
                enabled: true,
                provider: 'serper',
                defaultMaxResults: 6,
                safeSearch: 'moderate',
                providers: { serper: { region: 'jp', language: 'ja' } },
            },
        };

        const mockContext = {
            eventSource: { on: jest.fn() },
            eventTypes: { APP_READY: 'app_ready' },
            constants: {
                promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
                wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 4 },
            },
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettings: jest.fn(),
            saveSettingsDebounced: jest.fn(),
            extensionSettings,
            addLocaleData: jest.fn(),
            translate: s => s,
            secrets: { KEYS: {}, state: {} },
            escapeHtml: s => String(s),
            getStringHash: s => String(s).length,
            worldInfoEntry: { template: {}, setGlobalSelection: jest.fn() },
            POPUP_TYPE: { TEXT: 1 },
            Popup: class {},
            registerFunctionTool: jest.fn(),
            unregisterFunctionTool: jest.fn(),
            registerExtensionApi: (name, api) => extensionApis.set(name, api),
            getExtensionApi: (name) => extensionApis.get(name) || null,
            runPanel: { createStore: () => ({ getCurrentRun: () => null, finishRun: jest.fn() }), attachDock: jest.fn() },
        };
        globalThis.Luker = { getContext: () => mockContext };

        await import('../public/scripts/extensions/search-tools/main.js');
        expect(typeof readyCallback).toBe('function');
        readyCallback();

        const api = mockContext.getExtensionApi('search-tools');
        expect(api).toBeTruthy();
        expect(typeof api.search).toBe('function');
        expect(typeof api.visit).toBe('function');
        expect(typeof api.searchImages).toBe('function');
        expect(typeof api.extractPageImages).toBe('function');
        expect(typeof api.getActiveProviderCapabilities).toBe('function');

        expect(api.getActiveProviderCapabilities()).toEqual({
            provider: 'serper',
            supportsWebSearch: true,
            supportsImageSearch: true,
        });

        extensionSettings.search_tools.provider = 'exa';
        expect(api.getActiveProviderCapabilities()).toEqual({
            provider: 'exa',
            supportsWebSearch: true,
            supportsImageSearch: false,
        });

        extensionSettings.search_tools.provider = 'serper';
        const imgOut = await api.searchImages({ query: 'character portrait' });
        expect(imgOut.results).toHaveLength(1);
        expect(fetchCalls[0]).toMatchObject({
            url: '/api/search/images',
            body: {
                provider: 'serper',
                query: 'character portrait',
                max_results: 6,
            },
        });

        const pageOut = await api.extractPageImages({ url: 'https://wiki.example.org/p' });
        expect(pageOut.images).toHaveLength(1);
        expect(fetchCalls[1]).toEqual({
            url: '/api/search/page-images',
            body: { url: 'https://wiki.example.org/p' },
        });

        await api.searchImages({ query: 'camelCase maxResults', maxResults: 9 });
        expect(fetchCalls[2].body.max_results).toBe(9);

        // Regression: bfcache pagehide (persisted: true) must NOT tear down settings UI listeners,
        // while non-persisted pagehide (persisted: false) tears down cleanly.
        const pagehideListeners = [];
        const unsubDockPrefs = jest.fn();
        const offSpy = jest.fn();
        const fakeSettingsRoot = {
            length: 1,
            find: () => ({ length: 0, html: () => {}, text: () => {}, prop: () => {}, val: () => '0', toggle: () => {} }),
            off: offSpy,
            on: () => {},
        };
        const fakeHost = { length: 1, append: () => {} };
        mockContext.runPanel.getRunDockPrefs = () => ({ autoOpen: true, defaultSize: 'small' });
        mockContext.runPanel.subscribeRunDockPrefs = jest.fn(() => unsubDockPrefs);
        const prevWindow = globalThis.window;
        const prevJQuery = globalThis.jQuery;
        globalThis.window = {
            addEventListener: (type, fn, opts) => {
                if (type === 'pagehide') pagehideListeners.push({ fn, once: Boolean(opts?.once) });
            },
        };
        const dispatchPagehide = (event) => {
            for (const entry of [...pagehideListeners]) {
                if (entry.once) {
                    const idx = pagehideListeners.indexOf(entry);
                    if (idx !== -1) pagehideListeners.splice(idx, 1);
                }
                entry.fn(event);
            }
        };
        globalThis.jQuery = (sel) => {
            if (sel === '#extensions_settings2') return fakeHost;
            if (sel === '#search_tools_settings') return fakeSettingsRoot;
            return { length: 0, empty: () => {}, append: () => {}, find: () => ({ length: 0, on: () => {} }), on: () => {} };
        };
        globalThis.$ = globalThis.jQuery;
        try {
            readyCallback();
            expect(pagehideListeners).toHaveLength(1);
            expect(pagehideListeners[0].once).toBe(false);
            expect(mockContext.runPanel.subscribeRunDockPrefs).toHaveBeenCalledTimes(1);
            offSpy.mockClear();

            dispatchPagehide({ persisted: true });
            expect(unsubDockPrefs).not.toHaveBeenCalled();
            expect(offSpy).not.toHaveBeenCalled();

            dispatchPagehide({ persisted: false });
            expect(unsubDockPrefs).toHaveBeenCalledTimes(1);
            expect(offSpy).toHaveBeenCalledWith('.searchTools');
        } finally {
            if (prevWindow === undefined) delete globalThis.window;
            else globalThis.window = prevWindow;
            globalThis.jQuery = prevJQuery;
            globalThis.$ = prevJQuery;
        }
    });

    test('orchestrator-tools registers luker_web_image_search and luker_web_page_images as read tools', async () => {
        const registered = new Map();
        globalThis.Luker = {
            getContext: () => ({
                getExtensionApi: (name) => {
                    if (name === 'orchestrator') {
                        return {
                            registerOrchestrationTool: (spec) => registered.set(spec.name, spec),
                            unregisterOrchestrationTool: (toolName) => registered.delete(toolName),
                        };
                    }
                    return null;
                },
            }),
        };

        const {
            registerSearchToolsOrchestrationTools,
            unregisterSearchToolsOrchestrationTools,
            SEARCH_TOOL_NAMES,
        } = await import('../public/scripts/extensions/search-tools/orchestrator-tools.js');

        expect(SEARCH_TOOL_NAMES).toEqual(['search_search', 'search_visit']);
        registerSearchToolsOrchestrationTools();
        expect(registered.get('luker_web_image_search')?.mode).toBe('read');
        expect(registered.get('luker_web_page_images')?.mode).toBe('read');

        const adapter = {
            searchImages: jest.fn(async (args) => ({ results: [{ imageUrl: 'https://a.test/1.png', query: args.query }] })),
            extractPageImages: jest.fn(async (args) => ({ images: [{ imageUrl: 'https://a.test/2.png', page: args.url }] })),
        };
        const imgRes = await registered.get('luker_web_image_search').exec({ query: 'hero' }, { __searchAdapter: adapter });
        expect(imgRes.results[0].query).toBe('hero');
        const pageRes = await registered.get('luker_web_page_images').exec({ url: 'https://a.test/page' }, { __searchAdapter: adapter });
        expect(pageRes.images[0].page).toBe('https://a.test/page');

        unregisterSearchToolsOrchestrationTools();
        expect(registered.has('luker_web_image_search')).toBe(false);
        expect(registered.has('luker_web_page_images')).toBe(false);
    });
});
