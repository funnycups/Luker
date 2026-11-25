/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function makeScript(id, name) {
    return {
        id,
        scriptName: name,
        findRegex: '/a/g',
        replaceString: 'b',
        trimStrings: [],
        placement: [1],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        pluginLanes: [],
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

function installJQuery(doc) {
    const dataStore = new WeakMap();
    const listeners = new WeakMap();
    const readyCallbacks = [];

    const getDataMap = (el) => {
        if (!dataStore.has(el)) dataStore.set(el, new Map());
        return dataStore.get(el);
    };

    const wrap = (input) => {
        let els = [];
        if (input == null) {
            els = [];
        } else if (typeof input === 'function') {
            readyCallbacks.push(input);
            return {};
        } else if (input === doc || input === window) {
            els = [input];
        } else if (typeof input === 'string') {
            const trimmed = input.trim();
            if (trimmed.startsWith('<')) {
                const tpl = doc.createElement('template');
                tpl.innerHTML = trimmed;
                els = [...tpl.content.childNodes];
            } else if (trimmed.startsWith('div:has(> #regex_debugger_rules)')) {
                const rules = doc.querySelector('#regex_debugger_rules');
                els = rules?.parentElement ? [rules.parentElement] : [];
            } else {
                els = [...doc.querySelectorAll(trimmed)];
            }
        } else if (input?._isMiniJq) {
            return input;
        } else if (input instanceof Node || input instanceof DocumentFragment) {
            els = [input];
        } else if (Array.isArray(input) || input instanceof NodeList || input instanceof HTMLCollection) {
            els = [...input];
        }

        const api = {
            _isMiniJq: true,
            get length() { return els.length; },
            get(idx) { return idx === undefined ? els.slice() : els[idx]; },
            children(sel) {
                const out = [];
                for (const el of els) {
                    if (!el.children) continue;
                    for (const child of [...el.children]) {
                        if (!sel || child.matches(sel)) out.push(child);
                    }
                }
                return wrap(out);
            },
            find(sel) {
                const out = [];
                for (const el of els) {
                    if (typeof el.querySelectorAll === 'function') {
                        out.push(...el.querySelectorAll(sel));
                    }
                }
                return wrap(out);
            },
            html(val) {
                if (val === undefined) return els[0]?.innerHTML ?? '';
                for (const el of els) el.innerHTML = String(val);
                return api;
            },
            text(val) {
                if (val === undefined) return els[0]?.textContent ?? '';
                for (const el of els) el.textContent = String(val);
                return api;
            },
            val(v) {
                if (v === undefined) return els[0]?.value ?? '';
                for (const el of els) el.value = v;
                return api;
            },
            attr(name, val) {
                if (val === undefined) return els[0]?.getAttribute?.(name);
                for (const el of els) el.setAttribute?.(name, String(val));
                return api;
            },
            prop(name, val) {
                if (val === undefined) return els[0]?.[name];
                for (const el of els) el[name] = val;
                return api;
            },
            data(key, val) {
                const first = els[0];
                if (!first) return val === undefined ? undefined : api;
                if (val === undefined) {
                    const map = getDataMap(first);
                    if (map.has(key)) return map.get(key);
                    return first.getAttribute?.(`data-${key}`);
                }
                for (const el of els) getDataMap(el).set(key, val);
                return api;
            },
            empty() {
                for (const el of els) {
                    if ('innerHTML' in el) el.innerHTML = '';
                }
                return api;
            },
            clone() {
                return wrap(els.map(el => el.cloneNode(true)));
            },
            append(child) {
                const childNodes = typeof child === 'string'
                    ? wrap(child).get()
                    : (child?._isMiniJq ? child.get() : [child]);
                for (const el of els) {
                    for (const node of childNodes) {
                        if (node) el.appendChild(node);
                    }
                }
                return api;
            },
            on(eventName, selectorOrFn, maybeFn) {
                const handler = typeof selectorOrFn === 'function' ? selectorOrFn : maybeFn;
                const selector = typeof selectorOrFn === 'string' ? selectorOrFn : null;
                for (const el of els) {
                    const wrapped = (evt) => {
                        if (selector) {
                            const matched = evt.target?.closest?.(selector);
                            if (matched) handler.call(matched, evt);
                        } else {
                            handler.call(el, evt);
                        }
                    };
                    if (!listeners.has(el)) listeners.set(el, []);
                    listeners.get(el).push({ eventName, wrapped });
                    el.addEventListener?.(eventName, wrapped);
                }
                return api;
            },
            off() { return api; },
            map(fn) {
                const results = els.map((el, i) => fn(i, el));
                return { get: () => results };
            },
            sortable() { return api; },
            disableSelection() { return api; },
            addClass() { return api; },
            removeClass() { return api; },
            toggleClass() { return api; },
            toggle() { return api; },
            show() { return api; },
            hide() { return api; },
            trigger(evt) {
                for (const el of els) el.dispatchEvent?.(new Event(evt, { bubbles: true }));
                return api;
            },
            each(fn) { els.forEach((el, i) => fn.call(el, i, el)); return api; },
            closest(sel) { return wrap(els[0]?.closest?.(sel) ?? null); },
            parent() { return wrap(els[0]?.parentElement ?? null); },
            is() { return false; },
        };
        return api;
    };

    globalThis.$ = wrap;
    globalThis.jQuery = wrap;
    return { readyCallbacks };
}

describe('regex debugger pinned async targets and serialized scoped order save', () => {
    let orig$;
    let origJQuery;
    let origToastr;
    let jqControl;

    beforeEach(() => {
        jest.resetModules();
        orig$ = globalThis.$;
        origJQuery = globalThis.jQuery;
        origToastr = globalThis.toastr;
        document.body.innerHTML = '<button id="open_regex_debugger"></button><div id="saved_regex_scripts"></div><div id="saved_scoped_scripts"></div><div id="saved_preset_scripts"></div><div id="regex_container"></div>';
        jqControl = installJQuery(document);
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };
    });

    afterEach(() => {
        globalThis.$ = orig$;
        globalThis.jQuery = origJQuery;
        globalThis.toastr = origToastr;
    });

    test('pins scoped and preset targets across async template render and saves scoped order via updateScopedRegexScripts', async () => {
        const debuggerTemplateHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/regex/debugger.html'),
            'utf8',
        );

        const charA = {
            avatar: 'alice.png',
            data: { extensions: { regex_scripts: [makeScript('a-1', 'Alice 1'), makeScript('a-2', 'Alice 2')] } },
        };
        const charB = {
            avatar: 'bob.png',
            data: { extensions: { regex_scripts: [makeScript('b-1', 'Bob 1')] } },
        };
        const characters = [charA, charB];
        let activeChid = 0;
        let currentPresetName = 'PresetA';
        const presetScriptsByName = {
            PresetA: [makeScript('pa-1', 'PresetA 1')],
            PresetB: [makeScript('pb-1', 'PresetB 1')],
        };
        const extensionSettings = {
            disabledExtensions: [],
            regex: [makeScript('g-1', 'Global 1')],
            character_allowed_regex: ['alice.png', 'bob.png'],
            preset_allowed_regex: { openai: ['PresetA', 'PresetB'] },
        };

        let resolveTemplate;
        const templateGate = new Promise((res) => { resolveTemplate = res; });

        const renderExtensionTemplateAsync = jest.fn(async (_ext, name) => {
            if (name === 'debugger') {
                await templateGate;
                return debuggerTemplateHtml;
            }
            return '<div></div>';
        });

        let mountedPopupHost = null;
        const callGenericPopup = jest.fn(async (content) => {
            mountedPopupHost = document.createElement('div');
            const nodes = content?._isMiniJq ? content.get() : [content];
            for (const node of nodes) {
                if (node) mountedPopupHost.appendChild(node);
            }
            document.body.appendChild(mountedPopupHost);
            return 1;
        });

        const updateScopedSpy = jest.fn();
        const saveScriptsByTypeSpy = jest.fn();

        jest.unstable_mockModule('../../public/script.js', () => ({
            characters,
            get this_chid() { return activeChid; },
            chatElement: { find: () => ({ length: 0 }) },
            eventSource: { on: jest.fn(), emit: jest.fn(async () => {}) },
            event_types: { CHAT_CHANGED: 'chat_changed', PRESET_CHANGED: 'preset_changed', OAI_PRESET_IMPORT_READY: 'oai_import', OAI_PRESET_EXPORT_READY: 'oai_export' },
            getCurrentChatId: () => 'chat-1',
            messageFormatting: (s) => s,
            redisplayChat: jest.fn(),
            reloadCurrentChat: jest.fn(async () => {}),
            saveSettings: jest.fn(async () => ({ ok: true, status: 'saved' })),
            saveSettingsDebounced: jest.fn(),
            unshallowCharacter: jest.fn(async () => {}),
            substituteParams: (s) => s,
            substituteParamsExtended: (s) => s,
        }));

        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            renderExtensionTemplateAsync,
            writeExtensionField: async (characterId, key, value) => {
                const card = characters[characterId];
                if (!card) return false;
                const next = typeof value === 'function'
                    ? await value(structuredClone(card.data.extensions[key]))
                    : structuredClone(value);
                card.data.extensions[key] = next;
                return true;
            },
        }));

        jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({ selected_group: null }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup,
            POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
            Popup: { show: { confirm: jest.fn(), input: jest.fn() } },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: { fromProps: (x) => x } }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'boolean' },
            SlashCommandArgument: class { static fromProps(x) { return x; } },
            SlashCommandNamedArgument: { fromProps: (x) => x },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
            commonEnumProviders: { boolean: () => () => [] },
            enumIcons: { getStateIcon: () => '', preset: '' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum', name: 'name', variable: 'variable' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
            SlashCommandParser: { addCommandObject: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            download: jest.fn(),
            equalsIgnoreCaseAndAccents: (a, b) => a === b,
            escapeHtml: (s) => String(s ?? ''),
            getFileText: jest.fn(),
            getSortableDelay: () => 0,
            isFalseBoolean: () => false,
            isTrueBoolean: () => false,
            regexFromString: (input) => new RegExp(input),
            setInfoBlock: jest.fn(),
            uuidv4: () => 'uuid-1',
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            getCurrentLocale: () => 'en',
            t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
            translate: (s) => String(s ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/util/AccountStorage.js', () => ({
            accountStorage: { getItem: () => null, setItem: jest.fn(), removeItem: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/preset-manager.js', () => ({
            getPresetManager: () => ({
                apiId: 'openai',
                getSelectedPresetName: () => currentPresetName,
                readPresetExtensionField: ({ name } = {}) => presetScriptsByName[name || currentPresetName] ?? [],
                writePresetExtensionField: async ({ name, value }) => {
                    presetScriptsByName[name || currentPresetName] = structuredClone(value);
                },
            }),
        }));

        jest.unstable_mockModule('fflate', () => ({
            gzipSync: (data) => data,
            gzip: (data, cb) => cb(null, data),
        }));

        const realEngine = await import('../../public/scripts/extensions/regex/engine.js');
        jest.unstable_mockModule('../../public/scripts/extensions/regex/engine.js', () => ({
            ...realEngine,
            saveScriptsByType: async (...args) => {
                saveScriptsByTypeSpy(...args);
                return realEngine.saveScriptsByType(...args);
            },
            updateScopedRegexScripts: async (...args) => {
                updateScopedSpy(...args);
                return realEngine.updateScopedRegexScripts(...args);
            },
        }));

        const regexExt = await import('../../public/scripts/extensions/regex/index.js');
        await regexExt.init();
        for (const cb of jqControl.readyCallbacks) {
            await cb();
        }

        // Open debugger while Alice (chid 0) & PresetA are active
        document.getElementById('open_regex_debugger').click();
        await Promise.resolve();

        // While template fetch is still pending, switch active character to Bob (chid 1) and preset to PresetB!
        activeChid = 1;
        currentPresetName = 'PresetB';
        resolveTemplate();
        await new Promise(r => setTimeout(r, 10));

        // Debugger MUST render Alice's scoped rules and PresetA's rules (pinned before async await), NOT Bob / PresetB
        const scopedItems = [...mountedPopupHost.querySelectorAll('#regex_debugger_rules_scoped li')].map(li => li.getAttribute('data-id'));
        const presetItems = [...mountedPopupHost.querySelectorAll('#regex_debugger_rules_preset li')].map(li => li.getAttribute('data-id'));
        expect(scopedItems).toEqual(['a-1', 'a-2']);
        expect(presetItems).toEqual(['pa-1']);

        // Reorder Alice's scoped rules in DOM: [a-2, a-1]
        const scopedListEl = mountedPopupHost.querySelector('#regex_debugger_rules_scoped');
        const [liA1, liA2] = [...scopedListEl.children];
        scopedListEl.insertBefore(liA2, liA1);

        // Concurrent edit adds a-3 onto Alice BEFORE Save Order runs its scoped update
        charA.data.extensions.regex_scripts.push(makeScript('a-3', 'Alice 3 Concurrent'));

        // Click Save Order -> scoped save MUST go through updateScopedRegexScripts and preserve a-3!
        saveScriptsByTypeSpy.mockClear();
        updateScopedSpy.mockClear();
        mountedPopupHost.querySelector('#regex_debugger_save_order').click();
        await new Promise(r => setTimeout(r, 10));

        expect(updateScopedSpy).toHaveBeenCalledTimes(1);
        expect(saveScriptsByTypeSpy.mock.calls.filter(c => c[1] === realEngine.SCRIPT_TYPES.SCOPED)).toHaveLength(0);
        expect(charA.data.extensions.regex_scripts.map(s => s.id)).toEqual(['a-2', 'a-1', 'a-3']);
        expect(charB.data.extensions.regex_scripts.map(s => s.id)).toEqual(['b-1']);
    });
});
