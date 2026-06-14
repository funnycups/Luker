import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.resolve(__dirname, '../config.yaml');

if (!getConfigFilePath()) {
    setConfigFilePath(configPath);
    reloadConfigCache();
}

// Mirror what server.js sets so middleware that reads files under
// `globalThis.DATA_ROOT` (e.g. basicAuth's unauthorized.html lookup) does not
// blow up under jest. Resolves to the repo's bundled default data dir.
if (!globalThis.DATA_ROOT) {
    globalThis.DATA_ROOT = path.resolve(__dirname, '../public');
}

if (typeof globalThis.Luker === 'undefined') {
    // ---------------------------------------------------------------------
    // Luker / SillyTavern / st global stub.
    //
    // Browser-side modules in public/scripts/extensions/** capture references
    // at module-load time via `const x = Luker.getContext().y;`.
    // public/script.js binds `globalThis.{Luker,st,SillyTavern}` to the same
    // object so all three are user-facing aliases. Under jest (Node ESM) none
    // of those globals exist, so the import-time evaluation throws
    // ReferenceError and the entire test suite fails to load.
    //
    // We install a recursive Proxy that synthesizes any accessed field as a
    // callable no-op (or as a nested proxy when accessed as an object).
    // Behavioural tests that need a specific shape override the global with
    // their own stub before importing the module under test — Proxy access
    // patterns play nicely with normal object assignment.
    //
    // `getExtensionApi(name)` is special-cased: when the orchestrator
    // extension is requested we hand back a tiny adapter that delegates
    // register / unregister to the real `register-custom-tool.js` module via
    // its globally exposed registry. This is what lets memory-graph /
    // search-tools `register*OrchestrationTools()` populate the same
    // registry the tests then introspect via `__getExtensionRegistryForTest`.
    // ---------------------------------------------------------------------
    const SENTINEL = Symbol('jest-setup:luker-stub');
    const cache = new WeakMap();
    function makeProxy() {
        const target = function () {};
        target[SENTINEL] = true;
        const proxy = new Proxy(target, {
            get(t, prop) {
                if (prop === SENTINEL) return true;
                if (prop === 'then') return undefined; // never look thenable
                if (prop === Symbol.toPrimitive) return () => 'luker-stub';
                if (prop === Symbol.iterator) return undefined;
                if (!cache.has(t)) cache.set(t, new Map());
                const memo = cache.get(t);
                if (!memo.has(prop)) memo.set(prop, makeProxy());
                return memo.get(prop);
            },
            apply() { return makeProxy(); },
            construct() { return makeProxy(); },
        });
        return proxy;
    }

    // Known extension APIs. We pre-load the orchestrator's
    // register-custom-tool module so register() / unregister() can run
    // synchronously — memory-graph + search-tools call them inside a
    // synchronous for-loop, so an async adapter would defer the actual
    // mutation past `await register*OrchestrationTools()` and the test
    // would read an empty registry.
    const orchestratorMod = await import('../public/scripts/extensions/orchestrator/register-custom-tool.js');
    const extensionApis = {
        orchestrator: {
            registerOrchestrationTool: orchestratorMod.registerOrchestrationTool,
            unregisterOrchestrationTool: orchestratorMod.unregisterOrchestrationTool,
            listExtensionTools: orchestratorMod.listExtensionTools,
            bridgeSillyTavernTool: orchestratorMod.bridgeSillyTavernTool,
            unbridgeSillyTavernTool: orchestratorMod.unbridgeSillyTavernTool,
        },
    };
    function getExtensionApi(name) {
        return extensionApis[name] || null;
    }

    function makeContextProxy() {
        // Common ctx fields where production code does `c?.fn || fallback`
        // for capability detection. The Proxy default is truthy, so without
        // explicit identity / null defaults the fallback never fires and
        // tests get the Proxy stringified to "luker-stub" in
        // unexpected places (i18n strings, lib helpers, etc.). Override
        // any of these in a test by assigning a new globalThis.Luker.
        const base = {
            getExtensionApi,
            // i18n helpers (e.g. orchestrator/i18n.js)
            translate: (s) => String(s ?? ''),
            addLocaleData: () => {},
            // capability detection sentinels
            createMessageEditorHandle: null,
            registerExtensionApi: () => {},
        };
        return new Proxy(base, {
            get(t, prop) {
                if (prop in t) return t[prop];
                if (prop === 'then') return undefined;
                if (prop === Symbol.toPrimitive) return () => 'luker-ctx-stub';
                if (prop === Symbol.iterator) return undefined;
                if (!cache.has(t)) cache.set(t, new Map());
                const memo = cache.get(t);
                if (!memo.has(prop)) memo.set(prop, makeProxy());
                return memo.get(prop);
            },
        });
    }

    const stub = {
        getContext: () => makeContextProxy(),
    };
    // Mirror public/script.js:338-340 — Luker / st / SillyTavern are all
    // aliases for the same plugin-facing API object. Plugin and test code
    // consumes `Luker.getContext()`; the SillyTavern / st aliases remain
    // for compatibility with any third-party extension that still expects
    // them, so the stub installs all three.
    globalThis.Luker = stub;
    globalThis.st = stub;
    globalThis.SillyTavern = stub;
}

// ---------------------------------------------------------------------------
// public/lib.js — the real module eagerly imports browser-only UMD bundles
// (notably @iconfu/svg-inject which calls document.createElement at load
// time). We don't stub document/window globally because some node libraries
// (e.g. @agnai/web-tokenizers) inspect their presence to pick a runtime
// branch. Instead we redirect `public/lib.js` through moduleNameMapper to
// the source bundle entry — see jest.config.json. That gives tests real
// lodash/Fuse/yaml/etc. without dragging the DOM-touching scripts in.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// jQuery stub. Several browser-side modules eagerly do `jQuery(() => ...)`
// at module-load time as a DOM-ready guard. Provide a no-op shim so the
// import-time evaluation doesn't ReferenceError. Tests that drive DOM
// behaviour should switch to `@jest-environment jsdom` and import jQuery
// proper.
// ---------------------------------------------------------------------------
if (typeof globalThis.jQuery === 'undefined') {
    const jQueryStub = Object.assign(
        function (selectorOrFn) {
            if (typeof selectorOrFn === 'function') {
                // DOM-ready handler — swallow under node.
                return;
            }
            return jQueryStub.__chain;
        },
        {
            __chain: new Proxy(function () {}, {
                get(_, prop) {
                    if (prop === 'then') return undefined;
                    return () => jQueryStub.__chain;
                },
                apply() { return jQueryStub.__chain; },
            }),
            ajax: () => Promise.resolve({}),
            extend: Object.assign,
            fn: {},
            noConflict: () => jQueryStub,
        },
    );
    globalThis.jQuery = jQueryStub;
    globalThis.$ = jQueryStub;
}

