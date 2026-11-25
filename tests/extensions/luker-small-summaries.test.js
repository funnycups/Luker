/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    renderTemplateParts,
} from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildCeaSummaryModel,
} from '../../public/scripts/extensions/character-editor-assistant/behavior-summary-model.js';
import {
    buildCpaSummaryModel,
} from '../../public/scripts/extensions/completion-preset-assistant/behavior-summary-model.js';
import {
    buildHookOrderSummaryModel,
} from '../../public/scripts/extensions/hook-order/behavior-summary-model.js';
import {
    buildBaseSystemPrompt,
    buildOrchestratorOptimizeModeBlock,
    buildJailbreakOnlyModeBlock,
} from '../../public/scripts/workbench/targets/preset-prompts.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const DEFAULT_CPA_PROMPTS = Object.freeze({
    iterBaseSystemPrompt: buildBaseSystemPrompt(),
    iterModePromptOrchestratorOptimize: buildOrchestratorOptimizeModeBlock(),
    iterModePromptJailbreakOnly: buildJailbreakOnlyModeBlock(),
});

function renderModel(model) {
    expect(model).toBeTruthy();
    const rowTexts = (model.rows || []).map((row) => {
        const parts = renderTemplateParts(row.template, row.tokens);
        return {
            role: row.role,
            tone: row.tone || '',
            text: parts.map((p) => p.textContent).join(''),
            parts,
        };
    });
    const warningTexts = (model.warnings || []).map((warn) => {
        const parts = renderTemplateParts(warn.template, warn.tokens);
        return {
            severity: warn.severity || 'warn',
            text: parts.map((p) => p.textContent).join(''),
            parts,
        };
    });
    const fullText = [
        ...rowTexts.map((r) => `${r.role}: ${r.text}`),
        ...warningTexts.map((w) => w.text),
    ].join('\n');
    expect(fullText).not.toContain('NaN');
    expect(fullText).not.toContain('undefined');
    return { rowTexts, warningTexts, fullText };
}

function installMinimalJQuery(readyQueue = null) {
    function wrap(elements) {
        const list = Array.from(elements || []).filter(Boolean);
        const api = Object.assign(list, {
            find(selector) {
                const found = [];
                for (const el of list) {
                    if (el.querySelectorAll) {
                        for (const match of el.querySelectorAll(selector)) {
                            if (!found.includes(match)) found.push(match);
                        }
                    }
                }
                return wrap(found);
            },
            closest(selector) {
                const found = [];
                for (const el of list) {
                    const match = el.closest?.(selector);
                    if (match && !found.includes(match)) found.push(match);
                }
                return wrap(found);
            },
            first() {
                return wrap(list.length > 0 ? [list[0]] : []);
            },
            html(value) {
                if (value === undefined) return list[0]?.innerHTML ?? '';
                for (const el of list) el.innerHTML = String(value);
                return api;
            },
            append(value) {
                for (const el of list) {
                    if (typeof value === 'string') el.insertAdjacentHTML('beforeend', value);
                    else if (value) el.appendChild(value);
                }
                return api;
            },
            text(value) {
                if (value === undefined) return list[0]?.textContent ?? '';
                for (const el of list) el.textContent = String(value);
                return api;
            },
            val(value) {
                if (value === undefined) return list[0]?.value ?? '';
                for (const el of list) el.value = String(value);
                return api;
            },
            prop(name, value) {
                if (value === undefined) return list[0]?.[name];
                for (const el of list) el[name] = value;
                return api;
            },
            data(key) {
                const attr = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                return list[0]?.getAttribute(`data-${attr}`) ?? undefined;
            },
            on(events, selectorOrHandler, maybeHandler) {
                const selector = typeof selectorOrHandler === 'string' ? selectorOrHandler : null;
                const handler = selector ? maybeHandler : selectorOrHandler;
                const eventNames = String(events).split(/\s+/).filter(Boolean);
                for (const el of list) {
                    if (!el.__jqHandlers) el.__jqHandlers = [];
                    for (const rawName of eventNames) {
                        const [type, ns = ''] = rawName.split('.');
                        const listener = (event) => {
                            if (selector) {
                                const target = event.target instanceof Element ? event.target.closest(selector) : null;
                                if (!target || !el.contains(target)) return;
                                handler.call(target, event);
                            } else {
                                handler.call(el, event);
                            }
                        };
                        el.addEventListener(type, listener);
                        el.__jqHandlers.push({ type, ns, listener });
                    }
                }
                return api;
            },
            off(namespace) {
                const ns = String(namespace || '').replace(/^\./, '');
                for (const el of list) {
                    if (!el.__jqHandlers) continue;
                    el.__jqHandlers = el.__jqHandlers.filter((entry) => {
                        if (!ns || entry.ns === ns) {
                            el.removeEventListener(entry.type, entry.listener);
                            return false;
                        }
                        return true;
                    });
                }
                return api;
            },
        });
        return api;
    }

    const jq = (input) => {
        if (!input) return wrap([]);
        if (typeof input === 'function') {
            if (Array.isArray(readyQueue)) readyQueue.push(input);
            return wrap([]);
        }
        if (typeof input === 'string') {
            if (input.trim().startsWith('<')) {
                const tpl = document.createElement('template');
                tpl.innerHTML = input.trim();
                return wrap(tpl.content.children);
            }
            return wrap(document.querySelectorAll(input));
        }
        if (input instanceof Element || input === document || input === window) {
            return wrap([input]);
        }
        return wrap([]);
    };
    globalThis.jQuery = jq;
    globalThis.$ = jq;
    return jq;
}

beforeAll(() => {
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
    }
    if (!Element.prototype.scrollIntoView) {
        Element.prototype.scrollIntoView = () => {};
    }
});

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    delete globalThis.jQuery;
    delete globalThis.$;
    delete globalThis.Luker;
    delete globalThis.__stEventListenerOrderConfig;
    jest.restoreAllMocks();
});

describe('buildCeaSummaryModel', () => {
    test('reports current fallback connection/preset, retries, and Workbench Settings precedence', () => {
        const model = buildCeaSummaryModel({
            requestApiPresetName: '',
            requestLlmPresetName: '',
            toolCallRetryMax: 2,
        });

        expect(model.tone).toBe('active');
        expect(model.rows).toHaveLength(1);
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);

        const { fullText } = renderModel(model);
        expect(fullText).toContain('(Current API config)');
        expect(fullText).toContain('(Current preset)');
        expect(fullText).toContain('2');
        expect(fullText).toContain('Workbench → Settings');
    });

    test('reports explicit connection, preset, and clamps retries (0 renders off tone)', () => {
        const zeroModel = buildCeaSummaryModel({
            requestApiPresetName: 'Claude Profile',
            requestLlmPresetName: 'plugin-only',
            toolCallRetryMax: 0,
        });
        expect(zeroModel.rows[0].tokens.requestApiPresetName.text).toBe('Claude Profile');
        expect(zeroModel.rows[0].tokens.requestLlmPresetName.text).toBe('plugin-only');
        expect(zeroModel.rows[0].tokens.toolCallRetryMax.text).toBe('0');
        expect(zeroModel.rows[0].tokens.toolCallRetryMax.tone).toBe('off');

        const uncappedModel = buildCeaSummaryModel({
            requestApiPresetName: 'OpenAI',
            requestLlmPresetName: 'Strict',
            toolCallRetryMax: 99,
        });
        expect(uncappedModel.rows[0].tokens.toolCallRetryMax.text).toBe('99');
        expect(uncappedModel.rows[0].tokens.toolCallRetryMax.tone).toBe('active');

        const negativeModel = buildCeaSummaryModel({
            requestApiPresetName: 'OpenAI',
            requestLlmPresetName: 'Strict',
            toolCallRetryMax: -5,
        });
        expect(negativeModel.rows[0].tokens.toolCallRetryMax.text).toBe('0');
        expect(negativeModel.rows[0].tokens.toolCallRetryMax.tone).toBe('off');
    });

    test('passes i18n translations through cleanly', () => {
        const model = buildCeaSummaryModel({
            requestApiPresetName: '',
            requestLlmPresetName: '',
            toolCallRetryMax: 1,
            i18n: (s) => `[T]${s}`,
        });
        expect(model.rows[0].role).toBe('[T]Fallback AI');
        expect(model.rows[0].template).toMatch(/^\[T\]/);
        expect(model.rows[0].tokens.requestApiPresetName.text).toBe('[T](Current API config)');
        expect(model.rows[0].tokens.requestLlmPresetName.text).toBe('[T](Current preset)');
    });
});

describe('buildCpaSummaryModel', () => {
    test('reports all 3 prompts using defaults and Workbench → Settings note', () => {
        const model = buildCpaSummaryModel({
            ...DEFAULT_CPA_PROMPTS,
            defaultPrompts: DEFAULT_CPA_PROMPTS,
        });

        expect(model.tone).toBe('active');
        expect(model.rows).toHaveLength(1);
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);

        const { fullText } = renderModel(model);
        expect(fullText).toContain('3');
        expect(fullText).toContain('default');
        expect(fullText).toContain('Workbench → Settings');
        expect(model.rows[0].tokens.promptStatus.field).toEqual([
            'iterBaseSystemPrompt',
            'iterModePromptOrchestratorOptimize',
            'iterModePromptJailbreakOnly',
        ]);
    });

    test('reports N/3 custom overrides (including cleared empty prompt) linking only overridden fields', () => {
        const oneCustom = buildCpaSummaryModel({
            iterBaseSystemPrompt: 'Custom base instructions',
            iterModePromptOrchestratorOptimize: DEFAULT_CPA_PROMPTS.iterModePromptOrchestratorOptimize,
            iterModePromptJailbreakOnly: DEFAULT_CPA_PROMPTS.iterModePromptJailbreakOnly,
            defaultPrompts: DEFAULT_CPA_PROMPTS,
        });
        expect(renderModel(oneCustom).fullText).toContain('1/3');
        expect(oneCustom.rows[0].tokens.customCount.field).toEqual(['iterBaseSystemPrompt']);

        const twoCustom = buildCpaSummaryModel({
            iterBaseSystemPrompt: DEFAULT_CPA_PROMPTS.iterBaseSystemPrompt,
            iterModePromptOrchestratorOptimize: '',
            iterModePromptJailbreakOnly: 'Custom JB',
            defaultPrompts: DEFAULT_CPA_PROMPTS,
        });
        expect(renderModel(twoCustom).fullText).toContain('2/3');
        expect(twoCustom.rows[0].tokens.customCount.field).toEqual([
            'iterModePromptOrchestratorOptimize',
            'iterModePromptJailbreakOnly',
        ]);

        const allCustom = buildCpaSummaryModel({
            iterBaseSystemPrompt: 'A',
            iterModePromptOrchestratorOptimize: 'B',
            iterModePromptJailbreakOnly: 'C',
            defaultPrompts: DEFAULT_CPA_PROMPTS,
        });
        expect(renderModel(allCustom).fullText).toContain('3/3');
        expect(allCustom.rows[0].tokens.customCount.field).toEqual([
            'iterBaseSystemPrompt',
            'iterModePromptOrchestratorOptimize',
            'iterModePromptJailbreakOnly',
        ]);
    });
});

describe('buildHookOrderSummaryModel', () => {
    test('zero detected hooks renders dormant state', () => {
        const model = buildHookOrderSummaryModel({
            hooks: [
                { eventName: 'message_sent', discoveredPlugins: [], customOrder: [] },
                { eventName: 'message_received', discoveredPlugins: [], customOrder: [] },
            ],
        });

        expect(model.tone).toBe('dormant');
        expect(model.rows).toHaveLength(1);
        expect(model.rows[0].tone).toBe('off');
        const { fullText } = renderModel(model);
        expect(fullText).toContain('0');
        expect(model.rows[0].tokens.detectedCount.field).toBeNull();
    });

    test('detected hooks with 0 custom orders report detected default order', () => {
        const model = buildHookOrderSummaryModel({
            hooks: [
                { eventName: 'message_sent', discoveredPlugins: ['ext-a', 'ext-b'], customOrder: [] },
                { eventName: 'message_received', discoveredPlugins: ['ext-c'], customOrder: [] },
                { eventName: 'chat_changed', discoveredPlugins: [], customOrder: [] },
            ],
        });

        expect(model.tone).toBe('active');
        expect(model.rows).toHaveLength(1);
        const { fullText } = renderModel(model);
        expect(fullText).toContain('2');
        expect(fullText).toContain('detected default order');
    });

    test('detected hooks with N custom orders report custom vs detected default counts', () => {
        const model = buildHookOrderSummaryModel({
            hooks: [
                { eventName: 'message_sent', discoveredPlugins: ['ext-a', 'ext-b'], customOrder: ['ext-b', 'ext-a'] },
                { eventName: 'message_received', discoveredPlugins: ['ext-c', 'ext-d'], customOrder: ['ext-d', 'ext-c'] },
                { eventName: 'message_edited', discoveredPlugins: ['ext-e'], customOrder: [] },
            ],
        });

        expect(model.tone).toBe('active');
        const { fullText } = renderModel(model);
        expect(fullText).toContain('3');
        expect(fullText).toContain('2');
        expect(fullText).toContain('1');
        expect(model.rows[0].tokens.customCount.text).toBe('2');
        expect(model.rows[0].tokens.defaultCount.text).toBe('1');
    });
});

describe('jsdom mount & interaction verification', () => {
    test('CEA editor-ui mounts 1-row summary below .cea_row, removes .cea_preset_note, and refreshes on change/preset-import/refreshUiState', async () => {
        installMinimalJQuery();
        const host = document.createElement('div');
        host.id = 'extensions_settings2';
        document.body.appendChild(host);

        const settings = {
            requestApiPresetName: '',
            requestLlmPresetName: '',
            toolCallRetryMax: 2,
            editorIterationSystemPrompt: 'Editor prompt',
            cardAppStudioSystemPrompt: 'Studio prompt',
        };
        const defaultSettings = { ...settings };
        const fakeContext = {
            getExtensionApi: () => null,
        };

        jest.unstable_mockModule('../../public/scripts/lens-shared/preset-examples.js', () => ({
            importPresetExample: jest.fn(async () => true),
            openPresetDerivation: jest.fn(async () => {}),
            PRESET_EXAMPLES: { pluginOnly: 'plugin-only' },
        }));

        const { createCharacterEditorUi } = await import('../../public/scripts/extensions/character-editor-assistant/editor-ui.js');
        const ui = createCharacterEditorUi({
            MODULE_NAME: 'character_editor_assistant',
            STYLE_ID: 'character_editor_assistant_style',
            UI_BLOCK_ID: 'character_editor_assistant_settings',
            beginCeaLineDiffResize: () => {},
            closeCeaExpandedDiff: () => {},
            defaultSettings,
            escapeHtml: (s) => String(s ?? ''),
            getContext: () => fakeContext,
            getSettings: () => settings,
            i18n: (s) => String(s ?? ''),
            i18nFormat: (s, ...args) => String(s ?? '').replace(/\$\{(\d+)\}/g, (_, i) => String(args[i] ?? '')),
            loadOperationState: async () => ({ journal: [] }),
            openCeaExpandedDiff: () => {},
            openCharacterEditorPopup: async () => {},
            refreshPresetSelectors: (root, _ctx, cur) => {
                const llm = root.find('#cea_sync_llm_preset');
                llm.html([
                    '<option value="">(Current preset)</option>',
                    '<option value="plugin-only">plugin-only</option>',
                    '<option value="Custom Preset">Custom Preset</option>',
                ].join(''));
                llm.val(cur.requestLlmPresetName || '');
                const api = root.find('#cea_sync_api_preset');
                api.html([
                    '<option value="">(Current API config)</option>',
                    '<option value="My Connection">My Connection</option>',
                ].join(''));
                api.val(cur.requestApiPresetName || '');
            },
            renderJournalItems: () => '',
            saveSettingsDebounced: jest.fn(),
            summarizeCharacterEditorSession: () => '',
        });

        ui.ensureUi();
        await ui.refreshUiState();

        const drawerContent = document.querySelector('#character_editor_assistant_settings .inline-drawer-content');
        expect(drawerContent).not.toBeNull();
        expect(drawerContent.querySelector('.cea_preset_note')).toBeNull();

        const ceaRow = drawerContent.querySelector(':scope > .cea_row');
        const summary = ceaRow.nextElementSibling;
        expect(summary?.classList.contains('luker-bsum')).toBe(true);
        expect(summary.dataset.bsumId).toBe('cea-settings-summary');
        expect(summary.querySelectorAll('.luker-bsum-row')).toHaveLength(1);
        expect(summary.textContent).toContain('(Current API config)');
        expect(summary.textContent).toContain('(Current preset)');

        const apiSelect = document.getElementById('cea_sync_api_preset');
        apiSelect.value = 'My Connection';
        apiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(summary.textContent).toContain('My Connection');

        const retriesInput = document.getElementById('cea_tool_retries');
        retriesInput.value = '4';
        retriesInput.dispatchEvent(new Event('change', { bubbles: true }));
        expect(summary.textContent).toContain('4');

        document.getElementById('cea_import_preset_example').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(summary.textContent).toContain('plugin-only');
    });

    test('CPA mounts 1-row summary below .cpa_row, refreshes on input/reset, and clicking token expands <details>', async () => {
        const readyQueue = [];
        installMinimalJQuery(readyQueue);

        const host = document.createElement('div');
        host.id = 'extensions_settings2';
        document.body.appendChild(host);

        const cpaSettings = {
            requestLlmPresetName: '',
            requestApiPresetName: '',
            includeWorldInfo: false,
            toolCallRetryMax: 2,
            iterBaseSystemPrompt: DEFAULT_CPA_PROMPTS.iterBaseSystemPrompt,
            iterModePromptOrchestratorOptimize: DEFAULT_CPA_PROMPTS.iterModePromptOrchestratorOptimize,
            iterModePromptJailbreakOnly: DEFAULT_CPA_PROMPTS.iterModePromptJailbreakOnly,
            promptDefaultsInitialized: true,
        };

        const fakeContext = {
            extensionSettings: { completion_preset_assistant: cpaSettings },
            addLocaleData: () => {},
            translate: (s) => String(s ?? ''),
            Popup: class {},
            escapeHtml: (s) => String(s ?? ''),
            saveSettingsDebounced: jest.fn(),
            eventSource: { on: () => {} },
            eventTypes: {
                PRESET_CHANGED: 'preset_changed',
                PRESET_RENAMED: 'preset_renamed',
                PRESET_DELETED: 'preset_deleted',
            },
        };
        globalThis.Luker = { getContext: () => fakeContext };

        jest.unstable_mockModule('../../public/scripts/iteration-library/simulation-review/i18n/index.js', () => ({
            ensureSimulationReviewLocaleData: () => {},
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/json-state-journal.js', () => ({
            cloneJsonValue: (v) => JSON.parse(JSON.stringify(v)),
            isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
        }));
        jest.unstable_mockModule('../../public/scripts/skills/skill-manager-panel.js', () => ({
            openSkillManagerPanel: async () => {},
        }));

        await import('../../public/scripts/extensions/completion-preset-assistant/main.js');
        expect(readyQueue).toHaveLength(1);
        await readyQueue[0]();

        const drawerContent = document.querySelector('#completion_preset_assistant_settings .inline-drawer-content');
        expect(drawerContent).not.toBeNull();
        const cpaRow = drawerContent.querySelector(':scope > .cpa_row');
        const summary = cpaRow.nextElementSibling;
        expect(summary?.classList.contains('luker-bsum')).toBe(true);
        expect(summary.dataset.bsumId).toBe('cpa-settings-summary');
        expect(summary.querySelectorAll('.luker-bsum-row')).toHaveLength(1);
        expect(summary.textContent).toContain('All 3 iteration prompts');
        expect(summary.textContent).toContain('Workbench → Settings');

        const details = drawerContent.querySelector('details');
        expect(details.open).toBe(false);

        const orchTextarea = document.getElementById('cpa_iter_mode_orchestrator_prompt');
        orchTextarea.value = 'Custom orchestrator mode instructions';
        orchTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(summary.textContent).toContain('1/3');

        const customToken = summary.querySelector('button.luker-bsum-tok');
        expect(customToken).not.toBeNull();
        expect(customToken.dataset.bsumFields).toBe('iterModePromptOrchestratorOptimize');
        customToken.click();
        expect(details.open).toBe(true);
        expect(document.activeElement).toBe(orchTextarea);

        const resetBtn = document.getElementById('cpa_reset_iter_mode_orchestrator_prompt');
        resetBtn.click();
        expect(summary.textContent).toContain('All 3 iteration prompts');
    });

    test('Hook Order mounts 1-row summary at top, removes static <small>, and refreshes across dormant, move, reset, refresh, CHAT_CHANGED', async () => {
        const readyQueue = [];
        installMinimalJQuery(readyQueue);

        const host = document.createElement('div');
        host.id = 'extensions_settings2';
        document.body.appendChild(host);

        let listenersByEvent = {};
        const eventHandlers = {};
        const fakeSettings = {
            hook_order: {
                orderByEvent: {},
                migratedFromAutoDiscover: true,
            },
        };
        const fakeContext = {
            eventTypes: {
                GENERATION_CONTEXT_READY: 'generation_context_ready',
                MESSAGE_SENT: 'message_sent',
                CHAT_CHANGED: 'chat_changed',
            },
            eventSource: {
                getListenersMeta: (eventName) => listenersByEvent[eventName] || [],
                setOrderConfig: jest.fn(),
                on: (evt, fn) => {
                    eventHandlers[evt] = eventHandlers[evt] || [];
                    eventHandlers[evt].push(fn);
                },
            },
        };

        jest.unstable_mockModule('../../public/script.js', () => ({
            saveSettingsDebounced: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extension_settings: fakeSettings,
            getContext: () => fakeContext,
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            addLocaleData: () => {},
            translate: (s) => String(s ?? ''),
        }));

        await import('../../public/scripts/extensions/hook-order/index.js');
        expect(readyQueue).toHaveLength(1);
        readyQueue[0]();

        const drawerContent = document.querySelector('#hook_order_settings .inline-drawer-content');
        expect(drawerContent).not.toBeNull();
        expect(drawerContent.textContent).not.toContain('Core event ordering for extension listeners.');

        const summary = drawerContent.firstElementChild;
        expect(summary?.classList.contains('luker-bsum')).toBe(true);
        expect(summary.dataset.bsumId).toBe('hook-order-summary');
        expect(summary.classList.contains('is-dormant')).toBe(true);
        expect(summary.querySelectorAll('.luker-bsum-row')).toHaveLength(1);

        // Simulate listeners appearing and firing CHAT_CHANGED.
        listenersByEvent = {
            message_sent: [{ pluginId: 'alpha' }, { pluginId: 'beta' }],
            generation_context_ready: [{ pluginId: 'gamma' }],
        };
        for (const fn of eventHandlers.chat_changed || []) fn();

        expect(summary.classList.contains('is-dormant')).toBe(false);
        expect(summary.classList.contains('is-active')).toBe(true);
        expect(summary.textContent).toContain('2');
        expect(summary.textContent).toContain('detected default order');

        // Reorder a plugin on message_sent -> 1 custom, 1 default.
        const moveDownBtn = drawerContent.querySelector('.luker_hook_order_row[data-event-name="message_sent"][data-plugin-id="alpha"] [data-luker-action="move-down"]');
        moveDownBtn.click();
        expect(summary.textContent).toContain('2');
        expect(summary.textContent).toContain('1 custom execution order');
        expect(summary.textContent).toContain('1 detected default order');

        // Reset message_sent -> back to 0 custom.
        const resetBtn = drawerContent.querySelector('[data-luker-action="reset-event"][data-event-name="message_sent"]');
        resetBtn.click();
        expect(summary.textContent).toContain('detected default order');

        // Refresh button updates when listeners change.
        listenersByEvent = {};
        drawerContent.querySelector('[data-luker-action="refresh"]').click();
        expect(summary.classList.contains('is-dormant')).toBe(true);
    });

    test('all new summary i18n keys exist in zh-cn and zh-tw with matching slots and zero unescaped semicolons', () => {
        const files = [
            'public/scripts/extensions/character-editor-assistant/i18n.js',
            'public/scripts/extensions/completion-preset-assistant/i18n.js',
            'public/scripts/extensions/hook-order/index.js',
        ];
        const modelFiles = [
            'public/scripts/extensions/character-editor-assistant/behavior-summary-model.js',
            'public/scripts/extensions/completion-preset-assistant/behavior-summary-model.js',
            'public/scripts/extensions/hook-order/behavior-summary-model.js',
        ];
        const coreZhCn = readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8');
        const coreZhTw = readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8');

        for (let i = 0; i < files.length; i++) {
            const localeSrc = readFileSync(resolve(REPO_ROOT, files[i]), 'utf8');
            const modelSrc = readFileSync(resolve(REPO_ROOT, modelFiles[i]), 'utf8');
            const keys = new Set();
            for (const m of modelSrc.matchAll(/\bi18n\(\s*'((?:\\'|[^'])+)'\s*\)/g)) {
                const key = m[1].replace(/\\'/g, '\'');
                expect(key).not.toContain(';');
                keys.add(key);
            }
            expect(keys.size).toBeGreaterThan(0);

            const zhCnStart = localeSrc.includes('const ZH_CN =')
                ? localeSrc.indexOf('const ZH_CN =')
                : localeSrc.indexOf('addLocaleData(\'zh-cn\'');
            const zhTwStart = localeSrc.includes('const ZH_TW =')
                ? localeSrc.indexOf('const ZH_TW =')
                : localeSrc.indexOf('addLocaleData(\'zh-tw\'');
            expect(zhCnStart).toBeGreaterThan(-1);
            expect(zhTwStart).toBeGreaterThan(zhCnStart);
            const zhCnBlock = localeSrc.slice(zhCnStart, zhTwStart);
            const zhTwBlock = localeSrc.slice(zhTwStart);

            for (const key of keys) {
                const quoted = `'${key.replace(/'/g, '\\\'')}'`;
                const jsonQuoted = JSON.stringify(key);
                expect(zhCnBlock.includes(quoted) || coreZhCn.includes(jsonQuoted)).toBe(true);
                expect(zhTwBlock.includes(quoted) || coreZhTw.includes(jsonQuoted)).toBe(true);
            }
        }
    });
});
