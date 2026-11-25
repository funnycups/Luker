/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildConnPlainTextFcSummary,
    buildConnReliabilitySummary,
    buildConnClaudeCacheSummary,
    buildConnGeminiCacheSummary,
} from '../../public/scripts/extensions/connection-manager/behavior-summary-models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function makePlainTextFcState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        plainText: false,
        errorRetry: false,
        maxAttempts: 3,
        ...overrides,
    };
}

function makeReliabilityState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        rpmLimit: 0,
        maxRequestRetries: 0,
        retryStatusWhitelist: '',
        requestTimeout: 0,
        networkProxy: '',
        autoContinueOnTruncated: false,
        autoContinueMaxAttempts: 3,
        ...overrides,
    };
}

function makeClaudeCacheState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        source: 'claude',
        enableSystemPromptCache: false,
        extendedTtl: false,
        cachingAtDepth: -1,
        postProcessing: '',
        canActivatePostProcessing: false,
        ...overrides,
    };
}

function makeGeminiCacheState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        enableSystemPromptCache: false,
        enableHistoryCache: false,
        keepRecentTurns: 2,
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
    return { rowTexts, warningTexts, fullText };
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
            data() {
                return undefined;
            },
            toggle(show) {
                for (const el of list) el.style.display = show ? '' : 'none';
                return api;
            },
            trigger(eventName) {
                const name = String(eventName).split('.')[0];
                for (const el of list) {
                    el.dispatchEvent(new Event(name, { bubbles: true }));
                }
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
    globalThis.$ = jq;
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
    delete globalThis.$;
    delete globalThis.jQuery;
    delete globalThis.toastr;
    jest.restoreAllMocks();
});

describe('buildConnPlainTextFcSummary', () => {
    test('non-cc profile (tc) sets dormant tone and dims all 3 plain-text FC fields', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: true,
            profileMode: 'tc',
            plainText: true,
            errorRetry: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['plainText', 'errorRetry', 'maxAttempts']));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/Chat Completion/i);
    });

    test('plainText false sets dormant tone and dims errorRetry and maxAttempts', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: true,
            profileMode: 'cc',
            plainText: false,
            errorRetry: true,
            maxAttempts: 4,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['errorRetry', 'maxAttempts']));
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/native/i);
    });

    test('plainText true with errorRetry false sets active tone and dims only maxAttempts', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            plainText: true,
            errorRetry: false,
            maxAttempts: 5,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual(['maxAttempts']);
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.rowTexts).toHaveLength(2);
        expect(rendered.rowTexts[1].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set(['plainText', 'errorRetry']));
    });

    test('plainText true with errorRetry true renders active retries and clamps invalid attempts safely', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: false,
            plainText: true,
            errorRetry: true,
            maxAttempts: 4,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual([]);
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('4');
        expect(tokenFieldKeys(model)).toEqual(new Set(['plainText', 'errorRetry', 'maxAttempts']));

        const fallbackModel = buildConnPlainTextFcSummary(makePlainTextFcState({
            plainText: true,
            errorRetry: true,
            maxAttempts: 'invalid',
        }));
        expect(renderModel(fallbackModel).fullText).toContain('3');
    });
});

describe('buildConnReliabilitySummary', () => {
    test('no profile selected sets dormant tone, disables/dims all reliability & auto-continue fields', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            hasProfile: false,
            profileMode: '',
            maxRequestRetries: 3,
            autoContinueOnTruncated: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'rpmLimit',
            'maxRequestRetries',
            'retryStatusWhitelist',
            'requestTimeout',
            'networkProxy',
            'autoContinueOnTruncated',
            'autoContinueMaxAttempts',
        ]));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/no connection profile selected/i);
        expect(rendered.fullText).toMatch(/disabled/i);
    });

    test('tc profile puts networkProxy in dormantFields and notes Chat Completion only', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            hasProfile: true,
            profileMode: 'tc',
            networkProxy: 'http://127.0.0.1:7890',
            maxRequestRetries: 2,
            autoContinueOnTruncated: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual(['networkProxy']);
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/Chat Completion/i);
        expect(rendered.fullText).not.toContain('127.0.0.1:7890');
    });

    test('maxRequestRetries === 0 puts retryStatusWhitelist in dormantFields', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            hasProfile: true,
            profileMode: 'cc',
            maxRequestRetries: 0,
            retryStatusWhitelist: '429, 500-504',
            autoContinueOnTruncated: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toContain('retryStatusWhitelist');
        expect(model.dormantFields).not.toContain('autoContinueMaxAttempts');
    });

    test('maxRequestRetries > 0 notes text+image scope, default/custom whitelist, and that streaming responses are not retried once started', () => {
        const defaultWl = buildConnReliabilitySummary(makeReliabilityState({
            rpmLimit: 30,
            maxRequestRetries: 2,
            retryStatusWhitelist: '',
            requestTimeout: 1.5,
            networkProxy: 'socks5://127.0.0.1:1080',
            autoContinueOnTruncated: true,
            autoContinueMaxAttempts: 5,
        }));

        expect(defaultWl.tone).toBe('active');
        expect(defaultWl.dormantFields).toEqual([]);
        const defaultText = renderModel(defaultWl).fullText;
        expect(defaultText).toContain('30');
        expect(defaultText).toContain('2');
        expect(defaultText).toMatch(/429.*5xx/);
        expect(defaultText).toMatch(/text and image/i);
        expect(defaultText).toMatch(/streaming responses are not retried once streaming begins/i);
        expect(defaultText).toContain('1.5');
        expect(defaultText).toContain('socks5://127.0.0.1:1080');
        expect(defaultText).toContain('5');
        expect(defaultText).toMatch(/main-chat only/i);
        expect(defaultText).toMatch(/output cap or safety cutoff/i);

        const customWl = buildConnReliabilitySummary(makeReliabilityState({
            maxRequestRetries: 3,
            retryStatusWhitelist: '429, 502-504',
        }));
        const customText = renderModel(customWl).fullText;
        expect(customText).toContain('429, 502-504');
        expect(customText).toMatch(/streaming responses are not retried once streaming begins/i);
    });

    test('autoContinueOnTruncated false dims autoContinueMaxAttempts', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            maxRequestRetries: 1,
            autoContinueOnTruncated: false,
            autoContinueMaxAttempts: 4,
        }));

        expect(model.dormantFields).toContain('autoContinueMaxAttempts');
        expect(renderModel(model).rowTexts[2].tone).toBe('off');
    });

    test('hostile networkProxy or whitelist renders as literal textContent without child elements', () => {
        const hostile = '<img src=x onerror=1>${rpmLimit}';
        const model = buildConnReliabilitySummary(makeReliabilityState({
            networkProxy: hostile,
        }));
        const parts = renderTemplateParts(model.rows[1].template, model.rows[1].tokens);
        const proxyBtn = parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'networkProxy');
        expect(proxyBtn).toBeTruthy();
        expect(proxyBtn.children.length).toBe(0);
        expect(proxyBtn.textContent).toBe(hostile);
    });
});

describe('buildConnClaudeCacheSummary', () => {
    test('non-cc profile sets dormant tone and dims all 3 Claude cache fields', () => {
        const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
            hasProfile: true,
            profileMode: 'tc',
            enableSystemPromptCache: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(new Set(model.dormantFields)).toEqual(new Set(['enableSystemPromptCache', 'extendedTtl', 'cachingAtDepth']));
    });

    test('extendedTtl is in dormantFields when both system cache off and cachingAtDepth < 0', () => {
        const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
            enableSystemPromptCache: false,
            extendedTtl: true,
            cachingAtDepth: -1,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.dormantFields).toEqual(['extendedTtl']);
        expect(model.warnings).toEqual([]);
    });

    test('active via system cache or cachingAtDepth >= 0 clears dormantFields and formats TTL and costs', () => {
        const depthZero = buildConnClaudeCacheSummary(makeClaudeCacheState({
            enableSystemPromptCache: false,
            extendedTtl: false,
            cachingAtDepth: 0,
        }));
        expect(depthZero.tone).toBe('active');
        expect(depthZero.dormantFields).toEqual([]);
        const depthZeroText = renderModel(depthZero).fullText;
        expect(depthZeroText).toContain('0');
        expect(depthZeroText).toContain('5m');
        expect(depthZeroText).toContain('1.25x');
        expect(depthZeroText).toContain('0.1x');

        const both1h = buildConnClaudeCacheSummary(makeClaudeCacheState({
            enableSystemPromptCache: true,
            extendedTtl: true,
            cachingAtDepth: 4,
        }));
        expect(both1h.tone).toBe('active');
        expect(both1h.dormantFields).toEqual([]);
        const both1hText = renderModel(both1h).fullText;
        expect(both1hText).toContain('4');
        expect(both1hText).toContain('1h');
        expect(both1hText).toContain('2x');
        expect(both1hText).toContain('0.1x');
    });

    test('source === claude with active caching emits danger warning for single and warn for strict or semi', () => {
        const single = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'claude',
            enableSystemPromptCache: true,
            postProcessing: 'single',
        }));
        expect(single.tone).toBe('danger');
        expect(single.warnings).toHaveLength(1);
        expect(single.warnings[0].severity).toBe('danger');
        expect(renderModel(single).warningTexts[0].text).toMatch(/zero prefix reuse/i);

        for (const mode of ['strict', 'semi']) {
            const m = buildConnClaudeCacheSummary(makeClaudeCacheState({
                source: 'claude',
                cachingAtDepth: 2,
                postProcessing: mode,
            }));
            expect(m.tone).toBe('warn');
            expect(m.warnings).toHaveLength(1);
            expect(m.warnings[0].severity).toBe('warn');
            expect(renderModel(m).warningTexts[0].text).toMatch(/system-prompt cache breakpoint is unavailable/i);
        }

        for (const safeMode of ['', 'merge']) {
            const ok = buildConnClaudeCacheSummary(makeClaudeCacheState({
                source: 'claude',
                enableSystemPromptCache: true,
                postProcessing: safeMode,
            }));
            expect(ok.tone).toBe('active');
            expect(ok.warnings).toEqual([]);
        }
    });

    test('Review Focus #4: postProcessing token renders read-only span when absent and interactive button when present', () => {
        const absent = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'claude',
            enableSystemPromptCache: true,
            postProcessing: 'single',
            canActivatePostProcessing: false,
        }));
        const absentWarnParts = renderTemplateParts(absent.warnings[0].template, absent.warnings[0].tokens);
        const absentTok = absentWarnParts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(absentTok).toBeTruthy();
        expect(absentTok.tagName).toBe('SPAN');
        expect(absentTok.classList.contains('is-readonly')).toBe(true);

        const onActivate = jest.fn(() => true);
        const present = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'claude',
            enableSystemPromptCache: true,
            postProcessing: 'strict',
            canActivatePostProcessing: true,
            onPostProcessingActivate: onActivate,
        }));
        const presentWarnParts = renderTemplateParts(present.warnings[0].template, present.warnings[0].tokens);
        const presentBtn = presentWarnParts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(presentBtn).toBeTruthy();
        expect(presentBtn.tagName).toBe('BUTTON');
        expect(presentBtn.dataset.bsumFields).toBe('postProcessing');
    });

    test('source === openrouter notes anthropic/claude* model scoping and omits claude post-processing warning', () => {
        const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'openrouter',
            enableSystemPromptCache: true,
            postProcessing: 'single',
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(renderModel(model).fullText).toContain('anthropic/claude*');
    });
});

describe('buildConnGeminiCacheSummary', () => {
    test('non-cc profile sets dormant tone and dims all 3 Gemini cache fields', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            hasProfile: true,
            profileMode: 'tc',
            enableHistoryCache: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(new Set(model.dormantFields)).toEqual(new Set(['enableSystemPromptCache', 'enableHistoryCache', 'keepRecentTurns']));
    });

    test('both toggles off sets dormant tone and dims keepRecentTurns', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: false,
            enableHistoryCache: false,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.dormantFields).toEqual(['keepRecentTurns']);
        expect(model.warnings).toEqual([]);
    });

    test('system cache only sets active tone and dims keepRecentTurns', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: true,
            enableHistoryCache: false,
            keepRecentTurns: 3,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual(['keepRecentTurns']);
        expect(model.warnings).toEqual([]);
        expect(renderModel(model).fullText).toMatch(/system prompt/i);
    });

    test('enableHistoryCache true supersedes enableSystemPromptCache, keeps keepRecentTurns active, and warns unsupported models error', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: true,
            enableHistoryCache: true,
            keepRecentTurns: 4,
        }));

        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toEqual(['enableSystemPromptCache']);
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/supersedes/i);
        expect(rendered.fullText).toContain('4');
        expect(rendered.fullText).toMatch(/current input uncached/i);
        expect(rendered.warningTexts[0].text).toMatch(/without explicit caching support will error/i);
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'enableHistoryCache',
            'enableSystemPromptCache',
            'keepRecentTurns',
        ]));
    });
});

describe('Connection Manager HTML cleanup, real init() mounting & locale validation', () => {
    function buildConnectionManagerShell({ includePostProcessing = true, collapsedPostDrawer = false, initialPostProcessing = '' } = {}) {
        const rmApi = document.createElement('div');
        rmApi.id = 'rm_api_block';
        rmApi.className = collapsedPostDrawer ? 'drawer-content closedDrawer' : 'drawer-content openDrawer';

        const openaiApi = document.createElement('div');
        openaiApi.id = 'openai_api';

        const sourceSelect = document.createElement('select');
        sourceSelect.id = 'chat_completion_source';
        for (const val of ['openai', 'claude', 'openrouter']) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            sourceSelect.appendChild(opt);
        }
        sourceSelect.value = 'claude';
        openaiApi.appendChild(sourceSelect);

        if (includePostProcessing) {
            const ppWrapper = document.createElement('div');
            ppWrapper.id = 'prompt_post_processing_form';
            let targetParent = ppWrapper;
            if (collapsedPostDrawer) {
                const details = document.createElement('details');
                details.id = 'test_pp_details';
                ppWrapper.appendChild(details);
                targetParent = details;
            }
            const ppSelect = document.createElement('select');
            ppSelect.id = 'custom_prompt_post_processing';
            for (const [val, label] of [
                ['', 'None'],
                ['merge', 'Merge consecutive roles'],
                ['semi', 'Semi-strict (alternating roles)'],
                ['strict', 'Strict (user first, alternating roles)'],
                ['single', 'Single user message (no tools)'],
            ]) {
                const opt = document.createElement('option');
                opt.value = val;
                opt.textContent = label;
                ppSelect.appendChild(opt);
            }
            ppSelect.value = initialPostProcessing;
            targetParent.appendChild(ppSelect);
            openaiApi.appendChild(ppWrapper);
        }

        rmApi.appendChild(openaiApi);
        document.body.appendChild(rmApi);
        return rmApi;
    }

    async function loadConnectionManagerInit({ extensionSettings, oaiSettings }) {
        const settingsHtml = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/connection-manager/settings.html'),
            'utf8',
        );

        const listeners = new Map();
        const eventSource = {
            on: jest.fn((evt, cb) => {
                if (!listeners.has(evt)) listeners.set(evt, []);
                listeners.get(evt).push(cb);
            }),
            once: jest.fn(),
            emit: jest.fn(async (evt, ...args) => {
                for (const cb of listeners.get(evt) || []) {
                    await cb(...args);
                }
            }),
        };

        jest.resetModules();
        jest.unstable_mockModule('fflate', () => ({
            gzipSync: () => new Uint8Array(),
            gzip: () => {},
        }));
        jest.unstable_mockModule('../../public/script.js', () => ({
            activateSendButtons: jest.fn(),
            CONNECT_API_MAP: {
                openai: { selected: 'openai', source: 'openai' },
                claude: { selected: 'openai', source: 'claude' },
                openrouter: { selected: 'openai', source: 'openrouter' },
                textgenerationwebui: { selected: 'textgenerationwebui', type: 'ooba' },
            },
            deactivateSendButtons: jest.fn(),
            event_types: {
                CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
                CONNECTION_PROFILE_CREATED: 'connection_profile_created',
                CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
                CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
                MAIN_API_CHANGED: 'main_api_changed',
                OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
                SETTINGS_UPDATED: 'settings_updated',
            },
            eventSource,
            main_api: 'openai',
            online_status: 'connected',
            saveSettingsDebounced: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extension_settings: extensionSettings,
            getContext: () => ({ extensionSettings }),
            renderExtensionTemplateAsync: async () => settingsHtml,
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup: jest.fn(async () => ''),
            Popup: { show: { confirm: jest.fn(async () => true) } },
            POPUP_RESULT: { AFFIRMATIVE: 1 },
            POPUP_TYPE: { INPUT: 1, CONFIRM: 2 },
        }));
        const commands = {
            api: { callback: jest.fn(async (_a, v) => { oaiSettings.chat_completion_source = v || oaiSettings.chat_completion_source; return oaiSettings.chat_completion_source; }) },
            'prompt-post-processing': {
                callback: jest.fn(async (_a, v) => {
                    if (v !== undefined) oaiSettings.custom_prompt_post_processing = v;
                    return oaiSettings.custom_prompt_post_processing;
                }),
            },
            'function-calling-plain-text': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.function_calling_plain_text = v === 'true'; return String(Boolean(oaiSettings.function_calling_plain_text)); }) },
            'function-calling-plain-text-error-retry': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.function_calling_plain_text_error_retry = v === 'true'; return String(Boolean(oaiSettings.function_calling_plain_text_error_retry)); }) },
            'function-calling-plain-text-error-retry-max-attempts': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.function_calling_plain_text_error_retry_max_attempts = Number(v); return String(oaiSettings.function_calling_plain_text_error_retry_max_attempts ?? 3); }) },
            'claude-enable-system-prompt-cache': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.claude_enable_system_prompt_cache = v === 'true'; return String(Boolean(oaiSettings.claude_enable_system_prompt_cache)); }) },
            'claude-extended-ttl': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.claude_extended_ttl = v === 'true'; return String(Boolean(oaiSettings.claude_extended_ttl)); }) },
            'claude-caching-at-depth': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.claude_caching_at_depth = Number(v); return String(oaiSettings.claude_caching_at_depth ?? -1); }) },
            'gemini-enable-system-prompt-cache': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.gemini_enable_system_prompt_cache = v === 'true'; return String(Boolean(oaiSettings.gemini_enable_system_prompt_cache)); }) },
            'gemini-enable-history-cache': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.gemini_enable_history_cache = v === 'true'; return String(Boolean(oaiSettings.gemini_enable_history_cache)); }) },
            'gemini-cache-keep-recent-turns': { callback: jest.fn(async (_a, v) => { if (v !== undefined) oaiSettings.gemini_cache_keep_recent_turns = Number(v); return String(oaiSettings.gemini_cache_keep_recent_turns ?? 2); }) },
        };
        const makeCmd = () => ({ callback: jest.fn(async () => '') });
        for (const key of ['api-url', 'custom-models', 'model', 'proxy', 'base-url', 'stop-strings', 'start-reply-with', 'reasoning-template', 'openrouter-providers', 'openrouter-quantizations', 'openrouter-allow-fallbacks', 'openrouter-use-fallback', 'openrouter-middleout', 'custom-include-body', 'custom-exclude-body', 'custom-include-headers', 'secret-id', 'preset', 'sysprompt', 'sysprompt-state', 'instruct', 'context', 'instruct-state', 'tokenizer']) {
            commands[key] = makeCmd();
        }
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
            SlashCommand: { fromProps: (p) => p },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandAbortController.js', () => ({
            SlashCommandAbortController: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: { BOOLEAN: 'boolean', STRING: 'string', NUMBER: 'number', CLOSURE: 'closure' },
            SlashCommandArgument: { fromProps: (p) => p },
            SlashCommandNamedArgument: Object.assign(function () {}, { fromProps: (p) => p }),
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
            commonEnumProviders: { boolean: () => () => [], connectionProfiles: () => () => [] },
            enumIcons: { server: 'server' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandDebugController.js', () => ({
            SlashCommandDebugController: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
            enumTypes: { name: 'name' },
            SlashCommandEnumValue: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandClosure.js', () => ({
            SlashCommandClosure: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
            SlashCommandParser: {
                commands,
                addCommandObject: jest.fn(),
            },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandScope.js', () => ({
            SlashCommandScope: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            collapseSpaces: (s) => String(s ?? '').replace(/\s+/g, ' ').trim(),
            getUniqueName: (s) => s,
            isFalseBoolean: (v) => v === false || v === 'false',
            isTrueBoolean: (v) => v === true || v === 'true',
            uuidv4: () => 'uuid-1',
            waitUntilCondition: jest.fn(async () => {}),
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
            translate: (s) => String(s ?? ''),
        }));
        jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
            getSecretLabelById: () => '',
            SECRET_KEYS: { CLAUDE: 'api_key_claude', OPENROUTER: 'api_key_openrouter' },
            writeSecret: jest.fn(async () => null),
        }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
            applyProxyProfileEntry: jest.fn(),
            chat_completion_sources: {
                OPENAI: 'openai',
                CLAUDE: 'claude',
                OPENROUTER: 'openrouter',
                CUSTOM: 'custom',
                VERTEXAI: 'vertexai',
                ZAI: 'zai',
                OPENAI_RESPONSES: 'openai_responses',
                AI21: 'ai21',
                MAKERSUITE: 'makersuite',
                MISTRALAI: 'mistralai',
                COHERE: 'cohere',
                PERPLEXITY: 'perplexity',
                GROQ: 'groq',
                ELECTRONHUB: 'electronhub',
                CHUTES: 'chutes',
                NANOGPT: 'nanogpt',
                DEEPSEEK: 'deepseek',
                AIMLAPI: 'aimlapi',
                XAI: 'xai',
                POLLINATIONS: 'pollinations',
                MOONSHOT: 'moonshot',
                FIREWORKS: 'fireworks',
                COMETAPI: 'cometapi',
                AZURE_OPENAI: 'azure_openai',
                SILICONFLOW: 'siliconflow',
            },
            getCurrentProxyProfileEntry: () => ({ name: '', url: '', password: '' }),
            oai_settings: oaiSettings,
            proxies: [],
            updateReverseProxyConflictWarning: jest.fn(),
            whenChatCompletionModelListReady: jest.fn(async () => {}),
        }));
        jest.unstable_mockModule('../../public/scripts/select2-actionable-single.js', () => ({
            initActionableSingleSelect: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/select2-multiselect.js', () => ({
            buildBulkDeleteConfirmBody: () => '',
        }));
        jest.unstable_mockModule('../../public/scripts/undo-toast.js', () => ({
            showUndoToast: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            performFuzzySearch: () => [],
        }));
        jest.unstable_mockModule('../../public/scripts/streaming-display.js', () => ({
            StreamingDisplay: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
            ConnectionManagerRequestService: { getProfileIcon: () => '', sendRequest: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
            formatReasoning: () => ({ formatted: '' }),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/connection-manager/embed-rerank.js', () => ({
            createEmbeddingProfileStub: jest.fn(),
            deleteEmbeddingProfile: jest.fn(),
            createRerankProfileStub: jest.fn(),
            deleteRerankProfile: jest.fn(),
            mountInlineProfileEditor: jest.fn(),
            renderProfileSelect: jest.fn(),
        }));

        const mod = await import('../../public/scripts/extensions/connection-manager/index.js');
        return { init: mod.init, eventSource };
    }

    test('settings.html deletes redundant static <small> hints/warnings and preserves Embed/Rerank tab descriptions', () => {
        const html = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/connection-manager/settings.html'),
            'utf8',
        );

        expect(html).not.toContain('connection_profile_max_request_retries_hint_block');
        expect(html).not.toContain('connection_profile_request_timeout_hint_block');
        expect(html).not.toContain('connection_profile_network_proxy_hint_block');
        expect(html).not.toContain('connection_profile_claude_cache_warning_single');
        expect(html).not.toContain('connection_profile_claude_cache_warning_strict');
        expect(html).not.toContain('Main-chat only. Fires on output cap or safety cutoff.');
        expect(html).not.toContain('Cache writes cost 1.25× base');
        expect(html).not.toContain('Only applied when OpenRouter routes to a Gemini model');
        expect(html).not.toContain('The current input is also kept uncached.');

        expect(html).toContain('Embedding profiles are used by Vector Storage and Memory Graph for text embeddings.');
        expect(html).toContain('Rerank profiles are used to re-score candidates after vector retrieval.');
    });

    test('Review Focus #4 in real index.js: absent #custom_prompt_post_processing degrades token to read-only span', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };
        buildConnectionManagerShell({ includePostProcessing: false });

        const extensionSettings = {
            connectionManager: {
                _proxyToBaseUrlMigrated: true,
                selectedProfile: 'cc1',
                profiles: [
                    {
                        id: 'cc1',
                        name: 'Claude Profile',
                        mode: 'cc',
                        api: 'claude',
                        'custom-models': '[]',
                        'claude-enable-system-prompt-cache': 'true',
                    },
                ],
            },
        };
        const oaiSettings = {
            chat_completion_source: 'claude',
            custom_prompt_post_processing: 'single',
            claude_enable_system_prompt_cache: true,
            claude_extended_ttl: false,
            claude_caching_at_depth: -1,
            gemini_enable_system_prompt_cache: false,
            gemini_enable_history_cache: false,
            gemini_cache_keep_recent_turns: 2,
        };

        const { init } = await loadConnectionManagerInit({ extensionSettings, oaiSettings });
        await init();

        const claudeCard = document.querySelector('.luker-bsum[data-bsum-id="conn-claude-cache"]');
        expect(claudeCard).toBeTruthy();
        expect(claudeCard.classList.contains('is-danger')).toBe(true);
        const warnSpan = claudeCard.querySelector('.luker-bsum-warnings .luker-bsum-tok');
        expect(warnSpan).toBeTruthy();
        expect(warnSpan.tagName).toBe('SPAN');
        expect(warnSpan.classList.contains('is-readonly')).toBe(true);
    });

    test('mounts all 4 cards in Advanced drawer, refreshes across profile/source/post-processing changes, preserves focus, and jumps to #custom_prompt_post_processing', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };
        buildConnectionManagerShell({ includePostProcessing: true, collapsedPostDrawer: true, initialPostProcessing: 'strict' });

        const ppSelect = document.getElementById('custom_prompt_post_processing');
        const ppScrollSpy = jest.fn();
        ppSelect.scrollIntoView = ppScrollSpy;

        const extensionSettings = {
            connectionManager: {
                _proxyToBaseUrlMigrated: true,
                selectedProfile: 'cc1',
                profiles: [
                    {
                        id: 'cc1',
                        name: 'Claude CC',
                        mode: 'cc',
                        api: 'claude',
                        'custom-models': '[]',
                        'function-calling-plain-text': 'true',
                        'function-calling-plain-text-error-retry': 'false',
                        'max-request-retries': 0,
                        'auto-continue-on-truncated': false,
                        'claude-enable-system-prompt-cache': 'true',
                        'claude-caching-at-depth': '-1',
                        'gemini-enable-history-cache': 'true',
                        'gemini-cache-keep-recent-turns': '4',
                    },
                    {
                        id: 'tc1',
                        name: 'Local TC',
                        mode: 'tc',
                        api: 'textgenerationwebui',
                    },
                ],
            },
        };
        const oaiSettings = {
            chat_completion_source: 'claude',
            custom_prompt_post_processing: 'strict',
            function_calling_plain_text: true,
            function_calling_plain_text_error_retry: false,
            function_calling_plain_text_error_retry_max_attempts: 3,
            claude_enable_system_prompt_cache: true,
            claude_extended_ttl: false,
            claude_caching_at_depth: -1,
            gemini_enable_system_prompt_cache: false,
            gemini_enable_history_cache: true,
            gemini_cache_keep_recent_turns: 4,
        };

        const { init, eventSource } = await loadConnectionManagerInit({ extensionSettings, oaiSettings });
        await init();

        const fcCard = document.querySelector('.luker-bsum[data-bsum-id="conn-plain-text-fc"]');
        const relCard = document.querySelector('.luker-bsum[data-bsum-id="conn-reliability"]');
        const claudeCard = document.querySelector('.luker-bsum[data-bsum-id="conn-claude-cache"]');
        const geminiCard = document.querySelector('.luker-bsum[data-bsum-id="conn-gemini-cache"]');
        expect(fcCard).toBeTruthy();
        expect(relCard).toBeTruthy();
        expect(claudeCard).toBeTruthy();
        expect(geminiCard).toBeTruthy();

        // Check initial state of all 4 cards
        expect(fcCard.classList.contains('is-active')).toBe(true);
        expect(document.getElementById('connection_profile_function_calling_plain_text_retry_attempts_block').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(relCard.classList.contains('is-active')).toBe(true);
        expect(document.getElementById('connection_profile_retry_status_whitelist_block').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(claudeCard.classList.contains('is-warn')).toBe(true);
        expect(geminiCard.classList.contains('is-warn')).toBe(true);

        // Cross-panel jump from Card 3 postProcessing token opens collapsed <details>, scrolls, focuses, and pulses #custom_prompt_post_processing
        const ppBtn = claudeCard.querySelector('button[data-bsum-fields="postProcessing"]');
        expect(ppBtn).toBeTruthy();
        ppBtn.click();
        expect(document.getElementById('test_pp_details').open).toBe(true);
        expect(ppScrollSpy).toHaveBeenCalled();
        expect(document.activeElement).toBe(ppSelect);
        expect(ppSelect.classList.contains('luker-bsum-field-pulse')).toBe(true);

        // Switching #custom_prompt_post_processing to 'single' refreshes Card 3 immediately to danger
        ppSelect.value = 'single';
        oaiSettings.custom_prompt_post_processing = 'single';
        ppSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(claudeCard.classList.contains('is-danger')).toBe(true);

        // Switching #chat_completion_source to 'openrouter' refreshes Card 3 immediately
        const sourceSelect = document.getElementById('chat_completion_source');
        sourceSelect.value = 'openrouter';
        oaiSettings.chat_completion_source = 'openrouter';
        sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        expect(claudeCard.classList.contains('is-active')).toBe(true);
        expect(claudeCard.textContent).toContain('anthropic/claude*');

        // Typing into maxRequestRetries updates Card 2 live and preserves input focus
        const retriesInput = document.getElementById('connection_profile_max_request_retries');
        retriesInput.focus();
        retriesInput.value = '2';
        retriesInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(retriesInput);
        expect(document.getElementById('connection_profile_retry_status_whitelist_block').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(relCard.textContent).toMatch(/streaming responses are not retried once streaming begins/i);

        // Switching to tc profile dims plain-text FC and networkProxy
        const profilesSelect = document.getElementById('connection_profiles');
        profilesSelect.value = 'tc1';
        profilesSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(fcCard.classList.contains('is-dormant')).toBe(true);
        expect(document.getElementById('connection_profile_network_proxy_block').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Switching to <None> makes Reliability card dormant
        profilesSelect.value = '';
        profilesSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(relCard.classList.contains('is-dormant')).toBe(true);

        // Preset update event refreshes Card 3 when oai_settings changes externally
        profilesSelect.value = 'cc1';
        profilesSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        sourceSelect.value = 'claude';
        oaiSettings.chat_completion_source = 'claude';
        sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        ppSelect.value = '';
        oaiSettings.custom_prompt_post_processing = '';
        await eventSource.emit('oai_preset_changed_after');
        expect(claudeCard.classList.contains('is-active')).toBe(true);
    });

    test('zh-cn and zh-tw locale files include all Connection Manager summary keys with matching ${token} placeholders and no unescaped semicolons', () => {
        const modelsSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/connection-manager/behavior-summary-models.js'),
            'utf8',
        );
        const indexSrc = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/connection-manager/index.js'),
            'utf8',
        );
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));

        const keys = new Set();
        for (const src of [modelsSrc, indexSrc]) {
            for (const m of src.matchAll(/\btranslate\(\s*'((?:\\'|[^'])*)'(?:\s*,\s*'((?:\\'|[^'])*)')?\s*\)/g)) {
                const text = m[1].replace(/\\'/g, '\'');
                const key = m[2] ? m[2].replace(/\\'/g, '\'') : text;
                keys.add(key);
            }
        }
        expect(keys.size).toBeGreaterThan(20);

        for (const key of keys) {
            expect(key).not.toMatch(/(?<!\\);/);
            expect(typeof zhCn[key]).toBe('string');
            expect(typeof zhTw[key]).toBe('string');
            expect(zhCn[key].length).toBeGreaterThan(0);
            expect(zhTw[key].length).toBeGreaterThan(0);

            const expectedTokens = [...key.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const cnTokens = [...zhCn[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const twTokens = [...zhTw[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            expect(cnTokens).toEqual(expectedTokens);
            expect(twTokens).toEqual(expectedTokens);
        }
    });

    test('zh-cn and zh-tw post-processing tokens and warning advice match public/index.html prompt_post_processing_* labels verbatim', () => {
        const indexHtml = readFileSync(resolve(REPO_ROOT, 'public/index.html'), 'utf8');
        const selectMatch = indexHtml.match(/<select[^>]*id="custom_prompt_post_processing"[^>]*>([\s\S]*?)<\/select>/);
        expect(selectMatch).toBeTruthy();

        const htmlOptions = [...selectMatch[1].matchAll(/<option[^>]*data-i18n="(prompt_post_processing_[^"]+)"[^>]*value="([^"]*)"/g)]
            .map((m) => ({ key: m[1], value: m[2] }));
        expect(htmlOptions).toEqual([
            { key: 'prompt_post_processing_none', value: '' },
            { key: 'prompt_post_processing_merge', value: 'merge' },
            { key: 'prompt_post_processing_semi', value: 'semi' },
            { key: 'prompt_post_processing_strict', value: 'strict' },
            { key: 'prompt_post_processing_single', value: 'single' },
        ]);

        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const savedLuker = globalThis.Luker;
        try {
            for (const localeMap of [zhCn, zhTw]) {
                const translateWithKey = (text, key = null) => localeMap?.[key || text] || text;
                globalThis.Luker = { getContext: () => ({ translate: translateWithKey }) };

                for (const opt of htmlOptions) {
                    const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
                        source: 'claude',
                        enableSystemPromptCache: true,
                        postProcessing: opt.value,
                    }));
                    expect(model.rows[1].tokens.postProcessing.text).toBe(localeMap[opt.key]);
                }

                const singleWarn = buildConnClaudeCacheSummary(makeClaudeCacheState({
                    source: 'claude',
                    enableSystemPromptCache: true,
                    postProcessing: 'single',
                }));
                const singleWarnText = renderModel(singleWarn).warningTexts[0].text;
                expect(singleWarnText).toContain(localeMap.prompt_post_processing_none);
                expect(singleWarnText).toContain(localeMap.prompt_post_processing_merge);

                const strictWarn = buildConnClaudeCacheSummary(makeClaudeCacheState({
                    source: 'claude',
                    enableSystemPromptCache: true,
                    postProcessing: 'strict',
                }));
                const strictWarnText = renderModel(strictWarn).warningTexts[0].text;
                expect(strictWarnText).toContain(localeMap.prompt_post_processing_none);
                expect(strictWarnText).toContain(localeMap.prompt_post_processing_merge);
            }
        } finally {
            if (savedLuker === undefined) delete globalThis.Luker;
            else globalThis.Luker = savedLuker;
        }
    });
});
