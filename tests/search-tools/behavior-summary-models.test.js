/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import {
    mountBehaviorSummary,
    renderTemplateParts,
} from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildSearchToolsLorebookSummary,
    buildSearchToolsMainSummary,
} from '../../public/scripts/extensions/search-tools/behavior-summary-models.js';
import { createSearchToolsSettingsUi } from '../../public/scripts/extensions/search-tools/settings-ui.js';
import {
    SEARCH_PROVIDERS,
    getSearchProviderDefinition,
    normalizeFieldValue,
    normalizeProviderConfig,
} from '../../public/scripts/extensions/search-tools/providers.js';

const POSITIONS = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
};

const ROLES = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

function makeState(overrides = {}) {
    return {
        enabled: false,
        preRequestEnabled: false,
        provider: 'ddg',
        hasApiKey: true,
        baseUrl: '',
        defaultMaxResults: 8,
        defaultVisitMaxChars: 4000,
        agentApiPresetName: '',
        agentPresetName: '',
        includeWorldInfoWithPreset: true,
        toolCallRetryMax: 2,
        agentSystemPrompt: 'Research prompt',
        lorebookPosition: POSITIONS.atDepth,
        lorebookDepth: 9999,
        lorebookRole: ROLES.SYSTEM,
        lorebookEntryOrder: 9800,
        positions: POSITIONS,
        roles: ROLES,
        ...overrides,
    };
}

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
    return {
        rowTexts,
        warningTexts,
        fullText,
    };
}

function tokenFieldKeys(model) {
    const keys = new Set();
    for (const row of model?.rows || []) {
        for (const tok of Object.values(row.tokens || {})) {
            if (Array.isArray(tok?.field)) tok.field.forEach((k) => keys.add(k));
            else if (tok?.field) keys.add(tok.field);
        }
    }
    for (const warn of model?.warnings || []) {
        for (const tok of Object.values(warn.tokens || {})) {
            if (Array.isArray(tok?.field)) tok.field.forEach((k) => keys.add(k));
            else if (tok?.field) keys.add(tok.field);
        }
    }
    return keys;
}

/**
 * Minimal jQuery subset sufficient for Search Tools `settings-ui.js` inside jsdom.
 */
function installMinimalJQuery() {
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
            toggle(show) {
                for (const el of list) el.style.display = show ? '' : 'none';
                return api;
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
    delete globalThis.Luker;
});

describe('buildSearchToolsMainSummary (2x2 matrix + warnings)', () => {
    test('quadrant 1 (both off): dormant tone, notes Orchestrator/other plugins can still call provider, dims agent fields', () => {
        const model = buildSearchToolsMainSummary(makeState({
            enabled: false,
            preRequestEnabled: false,
            provider: 'ddg',
            defaultMaxResults: 8,
            defaultVisitMaxChars: 4000,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(expect.arrayContaining([
            'agentApiPresetName',
            'agentPresetName',
            'includeWorldInfoWithPreset',
            'toolCallRetryMax',
            'agentSystemPrompt',
        ]));
        expect(model.dormantFields).not.toContain('provider');
        expect(model.dormantFields).not.toContain('defaultMaxResults');
        expect(model.dormantFields).not.toContain('defaultVisitMaxChars');

        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('DuckDuckGo (no login)');
        expect(rendered.fullText).toMatch(/Orchestrator|other plugins/i);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.rowTexts[1].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'enabled',
            'preRequestEnabled',
            'provider',
            'defaultMaxResults',
            'defaultVisitMaxChars',
        ]));
    });

    test('quadrant 2 (enabled only): main model active, pre-request agent off & dimmed', () => {
        const model = buildSearchToolsMainSummary(makeState({
            enabled: true,
            preRequestEnabled: false,
            defaultMaxResults: 10,
            defaultVisitMaxChars: 0,
        }));
        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(expect.arrayContaining([
            'agentApiPresetName',
            'agentPresetName',
            'includeWorldInfoWithPreset',
            'toolCallRetryMax',
            'agentSystemPrompt',
        ]));

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).not.toBe('off');
        expect(rendered.rowTexts[1].tone).toBe('off');
        expect(rendered.fullText).toContain('10');
        expect(rendered.fullText).toContain('no truncation');
        expect(rendered.fullText).not.toMatch(/when main toggles are off/i);
    });

    test('quadrant 3 (preRequestEnabled only): main model off, pre-request agent active, no dormant fields', () => {
        const model = buildSearchToolsMainSummary(makeState({
            enabled: false,
            preRequestEnabled: true,
            agentApiPresetName: 'FastConn',
            agentPresetName: 'plugin-only',
            includeWorldInfoWithPreset: false,
            toolCallRetryMax: 3,
            agentSystemPrompt: 'Do research.',
        }));
        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.rowTexts[1].tone).not.toBe('off');
        expect(rendered.fullText).toContain('FastConn');
        expect(rendered.fullText).toContain('plugin-only');
        expect(rendered.fullText).toContain('without world info');
        expect(rendered.fullText).toContain('3');
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'enabled',
            'preRequestEnabled',
            'agentApiPresetName',
            'agentPresetName',
            'includeWorldInfoWithPreset',
            'toolCallRetryMax',
            'provider',
            'defaultMaxResults',
            'defaultVisitMaxChars',
        ]));
    });

    test('quadrant 4 (both on): both active, shows current fallbacks when agent presets are blank', () => {
        const model = buildSearchToolsMainSummary(makeState({
            enabled: true,
            preRequestEnabled: true,
            agentApiPresetName: '',
            agentPresetName: '',
            includeWorldInfoWithPreset: true,
            toolCallRetryMax: 0,
            agentSystemPrompt: 'Valid prompt',
        }));
        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).not.toBe('off');
        expect(rendered.rowTexts[1].tone).not.toBe('off');
        expect(rendered.fullText).toContain('(Current API config)');
        expect(rendered.fullText).toContain('(Current preset)');
        expect(rendered.fullText).toContain('with world info');
    });

    test('missing secret on keyed provider emits danger warning linking provider; configured secret clears it', () => {
        const missing = buildSearchToolsMainSummary(makeState({
            enabled: true,
            provider: 'brave',
            hasApiKey: false,
        }));
        expect(missing.tone).toBe('danger');
        expect(missing.warnings).toHaveLength(1);
        expect(missing.warnings[0].severity).toBe('danger');
        expect(tokenFieldKeys(missing).has('provider')).toBe(true);
        const renderedMissing = renderModel(missing);
        expect(renderedMissing.warningTexts[0].text).toContain('Brave Search (API key)');

        const configured = buildSearchToolsMainSummary(makeState({
            enabled: true,
            provider: 'brave',
            hasApiKey: true,
        }));
        expect(configured.tone).toBe('active');
        expect(configured.warnings).toEqual([]);

        // Keyless provider never triggers missing secret even if hasApiKey is false
        const ddg = buildSearchToolsMainSummary(makeState({
            enabled: true,
            provider: 'ddg',
            hasApiKey: false,
        }));
        expect(ddg.warnings).toEqual([]);
    });

    test('searxng with empty baseUrl emits danger warning linking provider and baseUrl; non-empty clears it', () => {
        const emptyUrl = buildSearchToolsMainSummary(makeState({
            enabled: false,
            preRequestEnabled: false,
            provider: 'searxng',
            baseUrl: '   ',
        }));
        expect(emptyUrl.tone).toBe('danger');
        expect(emptyUrl.warnings).toHaveLength(1);
        expect(emptyUrl.warnings[0].severity).toBe('danger');
        expect(tokenFieldKeys(emptyUrl).has('provider')).toBe(true);
        expect(tokenFieldKeys(emptyUrl).has('searxngBaseUrl')).toBe(true);
        renderModel(emptyUrl);

        const validUrl = buildSearchToolsMainSummary(makeState({
            enabled: false,
            preRequestEnabled: false,
            provider: 'searxng',
            baseUrl: 'https://search.example.org',
        }));
        expect(validUrl.tone).toBe('dormant');
        expect(validUrl.warnings).toEqual([]);
    });

    test('preRequestEnabled with empty agentSystemPrompt emits danger warning linking agentSystemPrompt', () => {
        const emptyPrompt = buildSearchToolsMainSummary(makeState({
            enabled: false,
            preRequestEnabled: true,
            agentSystemPrompt: '   \n  ',
        }));
        expect(emptyPrompt.tone).toBe('danger');
        expect(emptyPrompt.warnings).toHaveLength(1);
        expect(emptyPrompt.warnings[0].severity).toBe('danger');
        expect(tokenFieldKeys(emptyPrompt).has('agentSystemPrompt')).toBe(true);
        renderModel(emptyPrompt);

        // When preRequestEnabled is false, empty agentSystemPrompt does NOT emit danger warning
        const offEmptyPrompt = buildSearchToolsMainSummary(makeState({
            enabled: true,
            preRequestEnabled: false,
            agentSystemPrompt: '',
        }));
        expect(offEmptyPrompt.tone).toBe('active');
        expect(offEmptyPrompt.warnings).toEqual([]);
    });
});

describe('buildSearchToolsLorebookSummary (2x2 matrix + positions)', () => {
    test('both off: dormant tone and marks lorebook fields dormant', () => {
        const model = buildSearchToolsLorebookSummary(makeState({
            enabled: false,
            preRequestEnabled: false,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.dormantFields).toEqual(expect.arrayContaining([
            'lorebookPosition',
            'lorebookDepth',
            'lorebookRole',
            'lorebookEntryOrder',
        ]));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/inactive/i);
    });

    test('enabled only: active, notes existing stored entries stay injected while no new automatic entries are written', () => {
        const model = buildSearchToolsLorebookSummary(makeState({
            enabled: true,
            preRequestEnabled: false,
            lorebookPosition: POSITIONS.atDepth,
            lorebookDepth: 4,
            lorebookRole: ROLES.USER,
            lorebookEntryOrder: 9500,
        }));
        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/existing stored entries stay injected/i);
        expect(rendered.fullText).toMatch(/no new automatic entries/i);
        expect(rendered.fullText).toContain('At Chat Depth');
        expect(rendered.fullText).toContain('4');
        expect(rendered.fullText).toContain('User');
        expect(rendered.fullText).toContain('9500');
    });

    test('preRequestEnabled active: writes & injects at atDepth (shows depth + role) vs non-atDepth (omits depth + role)', () => {
        const atDepthModel = buildSearchToolsLorebookSummary(makeState({
            enabled: false,
            preRequestEnabled: true,
            lorebookPosition: POSITIONS.atDepth,
            lorebookDepth: 2,
            lorebookRole: ROLES.ASSISTANT,
            lorebookEntryOrder: 9800,
        }));
        expect(atDepthModel.tone).toBe('active');
        expect(atDepthModel.dormantFields).toEqual([]);
        expect(tokenFieldKeys(atDepthModel)).toEqual(new Set([
            'lorebookPosition',
            'lorebookDepth',
            'lorebookRole',
            'lorebookEntryOrder',
        ]));
        const atDepthText = renderModel(atDepthModel).fullText;
        expect(atDepthText).toContain('At Chat Depth');
        expect(atDepthText).toContain('2');
        expect(atDepthText).toContain('Assistant');
        expect(atDepthText).toContain('9800');

        const afterModel = buildSearchToolsLorebookSummary(makeState({
            enabled: true,
            preRequestEnabled: true,
            lorebookPosition: POSITIONS.after,
            lorebookDepth: 99,
            lorebookRole: ROLES.ASSISTANT,
            lorebookEntryOrder: 777,
        }));
        expect(afterModel.tone).toBe('active');
        expect(tokenFieldKeys(afterModel)).toEqual(new Set([
            'lorebookPosition',
            'lorebookEntryOrder',
        ]));
        const afterText = renderModel(afterModel).fullText;
        expect(afterText).toContain('After Character Definitions');
        expect(afterText).toContain('777');
        expect(afterText).not.toContain('99');
        expect(afterText).not.toContain('Assistant');
    });
});

describe('DOM mounting via mountBehaviorSummary & createSearchToolsSettingsUi', () => {
    test('mounts 2 summary cards, updates live on events/provider switch/reset, and preserves typing focus', async () => {
        const $ = installMinimalJQuery();
        const host = document.createElement('div');
        host.id = 'extensions_settings2';
        document.body.appendChild(host);

        const secrets = { api_key_brave_search: '' };
        const settings = {
            enabled: false,
            preRequestEnabled: false,
            provider: 'ddg',
            defaultMaxResults: 8,
            defaultVisitMaxChars: 4000,
            safeSearch: 'moderate',
            providers: {
                ddg: { safeSearch: 'moderate' },
                searxng: { baseUrl: '', safeSearch: 'moderate' },
                brave: { safeSearch: 'moderate' },
            },
            agentApiPresetName: '',
            agentPresetName: '',
            includeWorldInfoWithPreset: true,
            agentSystemPrompt: 'Default search instructions',
            toolCallRetryMax: 2,
            lorebookPosition: POSITIONS.atDepth,
            lorebookDepth: 9999,
            lorebookRole: ROLES.SYSTEM,
            lorebookEntryOrder: 9800,
        };

        const ui = createSearchToolsSettingsUi({
            DEFAULT_SETTINGS: { ...settings, agentSystemPrompt: 'Default search instructions' },
            MODULE_NAME: 'search_tools',
            STATUS_ID: 'search_tools_status',
            STYLE_ID: 'search_tools_style',
            UI_BLOCK_ID: 'search_tools_settings',
            clampInteger: (v, min, max, fb) => {
                const n = Number.parseInt(String(v ?? ''), 10);
                return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb;
            },
            ensureSharedLorebook: async () => null,
            escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
            extension_prompt_roles: ROLES,
            getAvailableSearchProviders: () => SEARCH_PROVIDERS,
            getConnectionProfileOptions: () => '<option value="">(Current API config)</option>',
            getContext: () => ({
                runPanel: {
                    getRunDockPrefs: () => ({ autoOpen: true, defaultSize: 'small' }),
                    subscribeRunDockPrefs: () => () => {},
                },
            }),
            getOpenAIPresetOptions: () => '<option value="">(Current preset)</option>',
            getProviderDefinition: getSearchProviderDefinition,
            getProviderSettings: (s, id) => normalizeProviderConfig(id || s.provider, s.providers?.[id || s.provider]),
            getSettings: () => settings,
            hasConfiguredSecret: (key) => Boolean(secrets[key]),
            i18n: (s) => String(s ?? ''),
            listManagedEntries: () => [],
            manuallyDeleteManagedEntries: async () => {},
            manuallyResetManagedEntries: async () => {},
            getManagedEntriesSnapshot: () => [],
            POPUP_TYPE: { DISPLAY: 1 },
            Popup: class {},
            normalizeFieldValue,
            normalizeLorebookPosition: (v) => Number(v),
            normalizeLorebookRole: (v) => Number(v),
            normalizeProvider: (v) => getSearchProviderDefinition(v).id,
            normalizeWhitespace: (s) => String(s ?? '').trim(),
            saveSettingsDebounced: jest.fn(),
            showRunPanel: jest.fn(),
            syncSharedLorebookForCurrentChat: async () => {},
            syncSharedLorebookForLoadedChat: async () => {},
            world_info_position: POSITIONS,
        });

        ui.ensureUi();

        const drawerContent = document.querySelector('#search_tools_settings .inline-drawer-content');
        const mainCard = drawerContent.querySelector('.luker-bsum[data-bsum-id="search-tools-main"]');
        const lorebookLabel = drawerContent.querySelector('label[for="search_tools_lorebook_position"]');
        const lorebookCard = drawerContent.querySelector('.luker-bsum[data-bsum-id="search-tools-lorebook"]');

        expect(mainCard).toBeTruthy();
        expect(drawerContent.firstElementChild).toBe(mainCard);
        expect(lorebookCard).toBeTruthy();
        expect(lorebookCard.nextElementSibling).toBe(lorebookLabel);

        // Initially both off -> dormant cards & dimmed controls
        expect(mainCard.classList.contains('is-dormant')).toBe(true);
        expect(lorebookCard.classList.contains('is-dormant')).toBe(true);
        expect(document.querySelector('#search_tools_agent_preset_name').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(document.querySelector('#search_tools_lorebook_position').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Enable pre-request agent -> clears dormancy, updates both cards
        const preReqCheck = document.querySelector('#search_tools_pre_request_enabled');
        preReqCheck.checked = true;
        preReqCheck.dispatchEvent(new Event('input', { bubbles: true }));
        expect(mainCard.classList.contains('is-active')).toBe(true);
        expect(lorebookCard.classList.contains('is-active')).toBe(true);
        expect(document.querySelector('#search_tools_agent_preset_name').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(document.querySelector('#search_tools_lorebook_position').classList.contains('luker-bsum-field-dormant')).toBe(false);

        // Switch provider to brave without key -> danger warning on Card 1
        const providerSelect = document.querySelector('#search_tools_provider');
        providerSelect.value = 'brave';
        providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(mainCard.classList.contains('is-danger')).toBe(true);
        expect(mainCard.textContent).toContain('Brave Search (API key)');

        // Secret updated + ensureUi() -> warning clears
        secrets.api_key_brave_search = 'sk-test';
        ui.ensureUi();
        expect(mainCard.classList.contains('is-active')).toBe(true);

        // Switch provider to searxng with empty baseUrl -> danger warning, then fill baseUrl -> clears
        providerSelect.value = 'searxng';
        providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(mainCard.classList.contains('is-danger')).toBe(true);
        const baseUrlInput = document.querySelector('#search_tools_field_baseUrl');
        expect(baseUrlInput).toBeTruthy();
        baseUrlInput.value = 'https://searx.local';
        baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(mainCard.classList.contains('is-active')).toBe(true);

        // Clear agent system prompt while typing -> danger warning and focus preserved
        const promptArea = document.querySelector('#search_tools_agent_system_prompt');
        promptArea.focus();
        promptArea.value = '';
        promptArea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(promptArea);
        expect(mainCard.classList.contains('is-danger')).toBe(true);

        // Reset agent prompt button clears prompt warning
        const prevConfirm = window.confirm;
        window.confirm = () => true;
        try {
            document.querySelector('#search_tools_reset_agent_prompt').click();
        } finally {
            window.confirm = prevConfirm;
        }
        expect(mainCard.classList.contains('is-active')).toBe(true);

        // Switch lorebook position away from atDepth -> Card 2 drops depth/role
        const posSelect = document.querySelector('#search_tools_lorebook_position');
        posSelect.value = String(POSITIONS.before);
        posSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(lorebookCard.textContent).toContain('Before Character Definitions');
        expect(lorebookCard.textContent).not.toContain('9999');

        // Clicking a token focuses and pulses the target control
        const maxResultsTok = mainCard.querySelector('button[data-bsum-fields="defaultMaxResults"]');
        expect(maxResultsTok).toBeTruthy();
        maxResultsTok.click();
        expect(document.activeElement).toBe(document.querySelector('#search_tools_default_max_results'));
        expect(document.querySelector('#search_tools_default_max_results').classList.contains('luker-bsum-field-pulse')).toBe(true);

        // Standalone mountBehaviorSummary sanity check
        const standalone = mountBehaviorSummary({
            id: 'standalone-check',
            root: drawerContent,
            anchor: drawerContent,
            position: 'append',
            readState: () => makeState(),
            build: (st) => buildSearchToolsMainSummary(st),
        });
        expect(standalone.el.dataset.bsumId).toBe('standalone-check');
        standalone.destroy();

        ui.destroy();
        expect($('.luker-bsum').length).toBe(0);
    });
});
