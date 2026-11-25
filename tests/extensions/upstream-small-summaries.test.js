/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import { buildCaptionSummaryModel } from '../../public/scripts/extensions/caption/behavior-summary-model.js';
import { buildExpressionsSummaryModel } from '../../public/scripts/extensions/expressions/behavior-summary-model.js';
import { buildTranslateSummaryModel } from '../../public/scripts/extensions/translate/behavior-summary-model.js';
import {
    buildQuickReplyGlobalSummary,
    buildQuickReplySetSummary,
} from '../../public/scripts/extensions/quick-reply/src/behavior-summary-models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

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
            is(selector) {
                if (selector === ':visible') {
                    return Boolean(list[0] && list[0].style?.display !== 'none' && !list[0].hidden);
                }
                if (selector === ':checked') {
                    return Boolean(list[0]?.checked);
                }
                return Boolean(list[0]?.matches?.(selector));
            },
            each(fn) {
                list.forEach((el, idx) => fn.call(el, idx, el));
                return api;
            },
            empty() {
                for (const el of list) el.innerHTML = '';
                return api;
            },
            val(...args) {
                if (args.length === 0) return list[0]?.value ?? '';
                const next = args[0] ?? '';
                for (const el of list) el.value = String(next);
                return api;
            },
            prop(name, value) {
                if (value === undefined) return list[0]?.[name];
                for (const el of list) el[name] = value;
                return api;
            },
            attr(name, value) {
                if (value === undefined) return list[0]?.getAttribute?.(name) ?? undefined;
                for (const el of list) el.setAttribute(name, String(value));
                return api;
            },
            text(value) {
                if (value === undefined) return list[0]?.textContent ?? '';
                for (const el of list) el.textContent = String(value);
                return api;
            },
            html(value) {
                if (value === undefined) return list[0]?.innerHTML ?? '';
                for (const el of list) el.innerHTML = String(value);
                return api;
            },
            append(value) {
                for (const el of list) {
                    if (typeof value === 'string') {
                        el.insertAdjacentHTML('beforeend', value);
                    } else if (value?.length !== undefined && !value.nodeType) {
                        for (const item of value) el.appendChild(item);
                    } else if (value) {
                        el.appendChild(value);
                    }
                }
                return api;
            },
            hide() {
                for (const el of list) el.style.display = 'none';
                return api;
            },
            show() {
                for (const el of list) el.style.display = '';
                return api;
            },
            toggle(show) {
                for (const el of list) el.style.display = show ? '' : 'none';
                return api;
            },
            addClass(cls) {
                for (const el of list) el.classList.add(cls);
                return api;
            },
            removeClass(cls) {
                for (const el of list) el.classList.remove(cls);
                return api;
            },
            toggleClass(cls, force) {
                for (const el of list) {
                    if (force === undefined) el.classList.toggle(cls);
                    else el.classList.toggle(cls, Boolean(force));
                }
                return api;
            },
            css(prop, value) {
                if (typeof prop === 'object' && prop !== null) {
                    for (const el of list) Object.assign(el.style, prop);
                } else {
                    for (const el of list) el.style[prop] = value;
                }
                return api;
            },
            data(key, value) {
                const attr = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
                if (value === undefined) {
                    return list[0]?.getAttribute?.(`data-${attr}`) ?? list[0]?.dataset?.[key];
                }
                for (const el of list) el.dataset[key] = String(value);
                return api;
            },
            sortable() {
                return api;
            },
            trigger(eventName) {
                const name = String(eventName).split('.')[0];
                for (const el of list) {
                    if (el.__jqHandlers) {
                        for (const entry of el.__jqHandlers) {
                            if (entry.type === name) {
                                entry.handler.call(el, { type: name, target: el, currentTarget: el });
                            }
                        }
                    }
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
                        el.__jqHandlers.push({ type, ns, listener, handler });
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
    document.body.className = '';
});

afterEach(() => {
    delete globalThis.$;
    delete globalThis.jQuery;
    delete globalThis.toastr;
    delete globalThis.Luker;
    delete globalThis.fetch;
    jest.restoreAllMocks();
});

function makeCaptionState(overrides = {}) {
    return {
        source: 'local',
        multimodalApi: 'openai',
        multimodalApiLabel: 'OpenAI',
        multimodalModel: 'gpt-5.6-luna',
        multimodalModelLabel: 'gpt-5.6-luna',
        customModel: '',
        ollamaCustomModel: '',
        allowReverseProxy: false,
        reverseProxyConfigured: false,
        altEndpointEnabled: false,
        altEndpointUrl: '',
        prompt: 'What\'s in this image?',
        promptAsk: false,
        template: '[{{user}} sends {{char}} a picture that contains: {{caption}}]',
        autoMode: false,
        refineMode: false,
        showInChat: false,
        ...overrides,
    };
}

function makeExpressionsState(overrides = {}) {
    return {
        api: 99,
        promptType: 'raw',
        translate: false,
        allowMultiple: true,
        rerollIfSame: false,
        filterAvailable: false,
        llmPrompt: 'Classify {{labels}}',
        fallback: 'joy',
        ...overrides,
    };
}

function makeTranslateState(overrides = {}) {
    return {
        autoMode: 'none',
        provider: 'google',
        providerLabel: 'Google',
        deeplEndpoint: 'free',
        targetLanguage: 'zh-CN',
        targetLanguageLabel: 'Chinese (Simplified)',
        hasKey: false,
        hasUrl: false,
        ...overrides,
    };
}

function makeQuickReplyGlobalState(overrides = {}) {
    return {
        isEnabled: false,
        isCombined: false,
        showPopoutButton: true,
        globalCount: 1,
        chatCount: 0,
        charCount: 0,
        hasChat: true,
        hasCharacter: true,
        ...overrides,
    };
}

function makeQuickReplySetState(overrides = {}) {
    return {
        setName: 'Default',
        disableSend: false,
        placeBeforeInput: false,
        injectInput: false,
        linkedScopes: ['global'],
        onlyBorderColor: false,
        color: 'transparent',
        ...overrides,
    };
}

describe('buildCaptionSummaryModel', () => {
    test('source !== multimodal hides multimodal detail (multimodalApi, model, reverse proxy, secondary endpoint, promptAsk)', () => {
        for (const source of ['local', 'horde']) {
            const model = buildCaptionSummaryModel(makeCaptionState({
                source,
                multimodalApi: 'openai',
                multimodalModel: 'gpt-5.6-luna',
                allowReverseProxy: true,
                altEndpointEnabled: true,
                altEndpointUrl: '',
                promptAsk: true,
            }));
            expect(model.tone).toBe('active');
            expect(model.warnings).toEqual([]);
            const rendered = renderModel(model);
            expect(rendered.fullText).not.toContain('OpenAI');
            expect(rendered.fullText).not.toContain('gpt-5.6-luna');
            expect(rendered.fullText).not.toMatch(/reverse proxy/i);
            expect(rendered.fullText).not.toMatch(/secondary/i);
            expect(rendered.fullText).not.toMatch(/Ask every time|custom prompt/i);
            const fields = tokenFieldKeys(model);
            expect(fields.has('multimodalApi')).toBe(false);
            expect(fields.has('multimodalModel')).toBe(false);
            expect(fields.has('allowReverseProxy')).toBe(false);
            expect(fields.has('altEndpointUrl')).toBe(false);
            expect(fields.has('promptAsk')).toBe(false);
        }
    });

    test('source === multimodal shows API, resolved model, reverse proxy / secondary URL notes, and video eligibility only for Google/Vertex/Z.AI', () => {
        for (const apiSpec of [
            { multimodalApi: 'google', multimodalApiLabel: 'Google AI Studio', multimodalModel: 'gemini-3.5-flash', video: true },
            { multimodalApi: 'vertexai', multimodalApiLabel: 'Google Vertex AI', multimodalModel: 'gemini-2.5-pro', video: true },
            { multimodalApi: 'zai', multimodalApiLabel: 'Z.AI (GLM)', multimodalModel: 'glm-5v-turbo', video: true },
            { multimodalApi: 'openai', multimodalApiLabel: 'OpenAI', multimodalModel: 'gpt-5.6-luna', video: false },
            { multimodalApi: 'anthropic', multimodalApiLabel: 'Claude', multimodalModel: 'claude-sonnet-5', video: false },
        ]) {
            const model = buildCaptionSummaryModel(makeCaptionState({
                source: 'multimodal',
                multimodalApi: apiSpec.multimodalApi,
                multimodalApiLabel: apiSpec.multimodalApiLabel,
                multimodalModel: apiSpec.multimodalModel,
                multimodalModelLabel: apiSpec.multimodalModel,
                allowReverseProxy: true,
                promptAsk: true,
            }));
            expect(model.tone).toBe('active');
            const rendered = renderModel(model);
            expect(rendered.fullText).toContain(apiSpec.multimodalApiLabel);
            expect(rendered.fullText).toContain(apiSpec.multimodalModel);
            expect(rendered.fullText).toMatch(/reverse proxy/i);
            expect(rendered.fullText).toMatch(/custom prompt|asks/i);
            const expectedMediaRe = apiSpec.video ? /video/i : /images only/i;
            expect(rendered.fullText).toMatch(expectedMediaRe);
        }

        const ollamaSecondary = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'ollama',
            multimodalApiLabel: 'Ollama',
            multimodalModel: 'llava',
            multimodalModelLabel: 'llava',
            altEndpointEnabled: true,
            altEndpointUrl: 'http://localhost:11434',
        }));
        expect(ollamaSecondary.tone).toBe('active');
        expect(ollamaSecondary.dormantFields).not.toContain('altEndpointUrl');
        expect(renderModel(ollamaSecondary).fullText).toContain('http://localhost:11434');
    });

    test('altEndpointEnabled && !altEndpointUrl emits danger; !altEndpointEnabled dims altEndpointUrl', () => {
        const missingAlt = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'ollama',
            multimodalApiLabel: 'Ollama',
            multimodalModel: 'llava',
            altEndpointEnabled: true,
            altEndpointUrl: '   ',
        }));
        expect(missingAlt.tone).toBe('danger');
        expect(missingAlt.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(renderModel(missingAlt).warningTexts[0].text).toContain('Secondary captioning endpoint URL');

        const disabledAlt = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'ollama',
            multimodalApiLabel: 'Ollama',
            multimodalModel: 'llava',
            altEndpointEnabled: false,
            altEndpointUrl: 'http://localhost:11434',
        }));
        expect(disabledAlt.tone).toBe('active');
        expect(disabledAlt.dormantFields).toContain('altEndpointUrl');
    });

    test('custom_custom / ollama_custom with empty model emits danger and non-custom selection dims customModel / ollamaCustomModel', () => {
        const emptyCustom = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'custom',
            multimodalApiLabel: 'Custom (OpenAI-compatible)',
            multimodalModel: 'custom_custom',
            customModel: '  ',
        }));
        expect(emptyCustom.tone).toBe('danger');
        expect(emptyCustom.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(emptyCustom.dormantFields).not.toContain('customModel');
        expect(emptyCustom.dormantFields).toContain('ollamaCustomModel');
        expect(renderModel(emptyCustom).warningTexts[0].text).toContain('Model Id');

        const filledCustom = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'custom',
            multimodalApiLabel: 'Custom (OpenAI-compatible)',
            multimodalModel: 'custom_custom',
            customModel: 'vision-pro-2',
        }));
        expect(filledCustom.tone).toBe('active');
        expect(renderModel(filledCustom).fullText).toContain('vision-pro-2');

        const emptyOllama = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'ollama',
            multimodalApiLabel: 'Ollama',
            multimodalModel: 'ollama_custom',
            ollamaCustomModel: '',
        }));
        expect(emptyOllama.tone).toBe('danger');
        expect(emptyOllama.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(emptyOllama.dormantFields).not.toContain('ollamaCustomModel');
        expect(emptyOllama.dormantFields).toContain('customModel');
        expect(renderModel(emptyOllama).warningTexts[0].text).toContain('Custom Model Tag');

        const nonCustom = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'openai',
            multimodalModel: 'gpt-5.6-luna',
        }));
        expect(nonCustom.dormantFields).toContain('customModel');
        expect(nonCustom.dormantFields).toContain('ollamaCustomModel');
    });

    test('showInChat clarifies manual/slash scope vs autoMode message text presence', () => {
        const autoOn = buildCaptionSummaryModel(makeCaptionState({
            source: 'local',
            autoMode: true,
            showInChat: false,
        }));
        const autoText = renderModel(autoOn).fullText;
        expect(autoText).toMatch(/message text/i);
        expect(autoText).toMatch(/manual|slash/i);

        const autoOff = buildCaptionSummaryModel(makeCaptionState({
            source: 'local',
            autoMode: false,
            showInChat: true,
        }));
        expect(renderModel(autoOff).fullText).toMatch(/manual|slash/i);
    });
});

describe('buildExpressionsSummaryModel', () => {
    test('api === 99 (None) sets dormant tone, describes manual/emote only, and puts translate in dormantFields', () => {
        const model = buildExpressionsSummaryModel(makeExpressionsState({
            api: 99,
            translate: true,
            allowMultiple: true,
            rerollIfSame: false,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toContain('translate');
        expect(model.dormantFields).toContain('filterAvailable');
        expect(model.dormantFields).toContain('llmPrompt');
        expect(model.dormantFields).toContain('promptType');
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/\/emote/);
        expect(rendered.fullText).toMatch(/manual/i);
    });

    test('api === 2 && promptType === full && translate emits warn; raw mode does not warn', () => {
        const fullTranslated = buildExpressionsSummaryModel(makeExpressionsState({
            api: 2,
            promptType: 'full',
            translate: true,
        }));
        expect(fullTranslated.tone).toBe('warn');
        expect(fullTranslated.warnings).toHaveLength(1);
        expect(fullTranslated.warnings[0].severity).toBe('warn');
        const warnText = renderModel(fullTranslated).warningTexts[0].text;
        expect(warnText).toContain('Full Context');
        expect(warnText).toContain('Translate text to English before classification');

        const rawTranslated = buildExpressionsSummaryModel(makeExpressionsState({
            api: 2,
            promptType: 'raw',
            translate: true,
        }));
        expect(rawTranslated.tone).toBe('active');
        expect(rawTranslated.warnings).toEqual([]);
    });

    test('rerollIfSame && !allowMultiple emits warn + dormant; !allowMultiple always dims rerollIfSame', () => {
        const conflict = buildExpressionsSummaryModel(makeExpressionsState({
            api: 0,
            allowMultiple: false,
            rerollIfSame: true,
        }));
        expect(conflict.tone).toBe('warn');
        expect(conflict.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(conflict.dormantFields).toContain('rerollIfSame');
        const warnText = renderModel(conflict).warningTexts[0].text;
        expect(warnText).toContain('Allow multiple sprites per expression');
        expect(warnText).toContain('Re-roll if same sprite is used again');

        const dormantOnly = buildExpressionsSummaryModel(makeExpressionsState({
            api: 0,
            allowMultiple: false,
            rerollIfSame: false,
        }));
        expect(dormantOnly.tone).toBe('active');
        expect(dormantOnly.warnings).toEqual([]);
        expect(dormantOnly.dormantFields).toContain('rerollIfSame');

        const bothOn = buildExpressionsSummaryModel(makeExpressionsState({
            api: 0,
            allowMultiple: true,
            rerollIfSame: true,
        }));
        expect(bothOn.dormantFields).not.toContain('rerollIfSame');
    });
});

describe('buildTranslateSummaryModel', () => {
    test('autoMode modes clearly distinguish none, responses, inputs (to English, NOT targetLanguage), and both', () => {
        const noneModel = buildTranslateSummaryModel(makeTranslateState({ autoMode: 'none' }));
        expect(noneModel.tone).toBe('dormant');
        expect(renderModel(noneModel).rowTexts[0].tone).toBe('off');
        expect(renderModel(noneModel).fullText).toMatch(/\/translate/);

        const respModel = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            targetLanguage: 'zh-CN',
            targetLanguageLabel: 'Chinese (Simplified)',
        }));
        expect(respModel.tone).toBe('active');
        expect(renderModel(respModel).fullText).toContain('Chinese (Simplified)');
        expect(renderModel(respModel).fullText).toMatch(/reasoning/i);
        expect(renderModel(respModel).fullText).toMatch(/prompt.*unchanged|display only/i);

        const inputsModel = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'inputs',
            targetLanguage: 'ja',
            targetLanguageLabel: 'Japanese',
        }));
        expect(inputsModel.tone).toBe('active');
        const inputsText = renderModel(inputsModel).fullText;
        expect(inputsText).toContain('English');
        expect(inputsText).toContain('Japanese');
        expect(inputsText).toMatch(/not.*output language|only.*manual/i);

        const bothModel = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'both',
            targetLanguage: 'fr',
            targetLanguageLabel: 'French',
        }));
        expect(bothModel.tone).toBe('active');
        expect(renderModel(bothModel).fullText).toContain('French');
        expect(renderModel(bothModel).fullText).toContain('English');
    });

    test('DeepL missing key & LibreTranslate missing URL emit danger; DeepL tier renders when selected; targetLanguage === en with inputs/both emits warn', () => {
        const deeplMissing = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            provider: 'deepl',
            providerLabel: 'DeepL API',
            deeplEndpoint: 'pro',
            hasKey: false,
        }));
        expect(deeplMissing.tone).toBe('danger');
        expect(deeplMissing.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const deeplText = renderModel(deeplMissing).fullText;
        expect(deeplText).toContain('DeepL API');
        expect(deeplText).toContain('Pro');

        const deeplReady = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            provider: 'deepl',
            providerLabel: 'DeepL API',
            deeplEndpoint: 'free',
            hasKey: true,
        }));
        expect(deeplReady.tone).toBe('active');
        expect(deeplReady.warnings).toEqual([]);
        expect(renderModel(deeplReady).fullText).toContain('Free');

        const libreMissing = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            provider: 'libre',
            providerLabel: 'LibreTranslate',
            hasUrl: false,
            hasKey: false,
        }));
        expect(libreMissing.tone).toBe('danger');
        expect(libreMissing.warnings.some((w) => w.severity === 'danger')).toBe(true);

        const libreReadyNoKey = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            provider: 'libre',
            providerLabel: 'LibreTranslate',
            hasUrl: true,
            hasKey: false,
        }));
        expect(libreReadyNoKey.tone).toBe('active');
        expect(libreReadyNoKey.warnings).toEqual([]);

        for (const autoMode of ['inputs', 'both']) {
            const enWarn = buildTranslateSummaryModel(makeTranslateState({
                autoMode,
                targetLanguage: 'en',
                targetLanguageLabel: 'English',
            }));
            expect(enWarn.tone).toBe('warn');
            expect(enWarn.warnings.some((w) => w.severity === 'warn')).toBe(true);
        }
    });
});

describe('buildQuickReplyGlobalSummary & buildQuickReplySetSummary', () => {
    test('Global: !isEnabled sets dormant tone, clarifies /run still works, and dims isCombined + showPopoutButton', () => {
        const model = buildQuickReplyGlobalSummary(makeQuickReplyGlobalState({
            isEnabled: false,
            isCombined: true,
            showPopoutButton: true,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['isCombined', 'showPopoutButton']));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toMatch(/\/run/);
    });

    test('Global: isEnabled shows Global/Chat/Character set counts, isCombined, and desktop (>1000px) popout visibility', () => {
        const model = buildQuickReplyGlobalSummary(makeQuickReplyGlobalState({
            isEnabled: true,
            isCombined: true,
            showPopoutButton: true,
            globalCount: 2,
            chatCount: 1,
            charCount: 3,
        }));
        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('2');
        expect(rendered.fullText).toContain('1');
        expect(rendered.fullText).toContain('3');
        expect(rendered.fullText).toContain('1000px');
    });

    test('Per-Set: disableSend: true states /commands paste as text instead of executing; placeBeforeInput && !injectInput emits warn + dormant; unlinked set shows inactive notice', () => {
        const model = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'UtilityMacros',
            disableSend: true,
            injectInput: false,
            placeBeforeInput: true,
            linkedScopes: [],
        }));
        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toContain('placeBeforeInput');
        expect(model.warnings.some((w) => w.severity === 'warn')).toBe(true);
        const rendered = renderModel(model);
        expect(rendered.fullText).toMatch(/\/commands.*pasted as text|paste.*as text instead of executing/i);
        expect(rendered.fullText).toMatch(/inactive in.*bar.*auto-execute/i);
        expect(rendered.warningTexts[0].text).toContain('Place quick reply before input');
        expect(rendered.warningTexts[0].text).toContain('Inject user input automatically');

        const injectOffClean = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'Default',
            injectInput: false,
            placeBeforeInput: false,
            linkedScopes: ['global'],
        }));
        expect(injectOffClean.tone).toBe('active');
        expect(injectOffClean.warnings).toEqual([]);
        expect(injectOffClean.dormantFields).toContain('placeBeforeInput');

        const unlinkedClean = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'Library',
            injectInput: true,
            placeBeforeInput: true,
            linkedScopes: [],
        }));
        expect(unlinkedClean.dormantFields).not.toContain('placeBeforeInput');
        expect(unlinkedClean.warnings).toEqual([]);
        expect(unlinkedClean.tone).toBe('dormant');
        const unlinkedRendered = renderModel(unlinkedClean);
        expect(unlinkedRendered.fullText).toMatch(/inactive in.*bar.*auto-execute/i);

        // Linked only with isVisible === false -> auto-execute only, hidden from bar
        const hiddenOnly = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'AutoMacro',
            linkedScopes: ['global', 'chat'],
            visibleScopes: [],
        }));
        expect(hiddenOnly.tone).toBe('active');
        const hiddenText = renderModel(hiddenOnly).fullText;
        expect(hiddenText).toMatch(/hidden from the Quick Reply bar/i);
        expect(hiddenText).toMatch(/auto-execute triggers only/i);

        // Linked in multiple scopes, visible in at least one -> bar + auto-execute with hidden-scope note
        const partialVisible = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'MixedSet',
            linkedScopes: ['global', 'chat'],
            visibleScopes: ['global'],
        }));
        expect(partialVisible.tone).toBe('active');
        const partialText = renderModel(partialVisible).fullText;
        expect(partialText).toMatch(/active in the Quick Reply bar and auto-execute triggers/i);
        expect(partialText).toMatch(/Buttons off in Chat/i);

        // Global summary distinguishes visible bar sets from hidden auto-execute-only sets
        const globalWithHidden = buildQuickReplyGlobalSummary(makeQuickReplyGlobalState({
            isEnabled: true,
            globalCount: 1,
            chatCount: 0,
            charCount: 0,
            hiddenCount: 2,
        }));
        expect(globalWithHidden.tone).toBe('active');
        const globalHiddenText = renderModel(globalWithHidden).fullText;
        expect(globalHiddenText).toContain('1 global');
        expect(globalHiddenText).toContain('2 hidden');
        expect(globalHiddenText).toMatch(/auto-execute only/i);
    });
});

describe('HTML cleanup & preserved hints', () => {
    test('caption/settings.html removes redundant [Custom model] notes and keeps Ollama pull link and {{caption}} hint', () => {
        const html = readFileSync(resolve(REPO_ROOT, 'public/scripts/extensions/caption/settings.html'), 'utf8');
        expect(html).not.toContain('(for [Custom model] option)');
        expect(html).toContain('id="caption_ollama_pull"');
        expect(html).toContain('ollama pull');
        expect(html).toContain('&lcub;&lcub;caption&rcub;&rcub;');
    });

    test('expressions/settings.html removes redundant classifier/fallback small notes and keeps sprite file-naming and /emote hints', () => {
        const html = readFileSync(resolve(REPO_ROOT, 'public/scripts/extensions/expressions/settings.html'), 'utf8');
        expect(html).not.toContain('Select the API for classifying expressions.');
        expect(html).not.toContain('Set the default and fallback expression being used when no matching expression is found.');
        expect(html).toContain('/emote');
        expect(html).toContain('Bob/formal');
        expect(html).toContain('[expression_label].[image_format]');
        expect(html).toContain('joy.png');
    });

    test('quick-reply/html/settings.html keeps (Private) and {{input}} macro hints intact', () => {
        const html = readFileSync(resolve(REPO_ROOT, 'public/scripts/extensions/quick-reply/html/settings.html'), 'utf8');
        expect(html).toContain('(Private)');
        expect(html).toContain('{{input}}');
    });
});

describe('jsdom mount & refresh integration across all 4 extensions', () => {
    const harness = {
        extensionSettings: {},
        chatMetadata: {},
        secretState: {},
        eventHandlers: {},
        templates: {},
    };

    function resetObject(target, next = {}) {
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, next);
    }

    beforeAll(() => {
        // Under `@jest-environment jsdom`, fflate (pulled via tests/util/lib-stub.js)
        // resolves its `browser` ESM entry which Jest cannot parse without a transform.
        jest.unstable_mockModule('fflate', () => ({
            gzipSync: (d) => d,
            gzip: (d, cb) => cb?.(null, d),
            unzlibSync: () => new Uint8Array(),
            strFromU8: () => '',
            strToU8: () => new Uint8Array(),
        }));

        const registerEvent = (evt, fn) => {
            harness.eventHandlers[evt] = harness.eventHandlers[evt] || [];
            harness.eventHandlers[evt].push(fn);
        };

        jest.unstable_mockModule('../../public/script.js', () => ({
            appendMediaToMessage: jest.fn(),
            chat_metadata: harness.chatMetadata,
            characters: [],
            eventSource: {
                on: registerEvent,
                once: registerEvent,
                makeFirst: registerEvent,
                emit: jest.fn(),
            },
            event_types: {
                MESSAGE_SENT: 'message_sent',
                MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
                USER_MESSAGE_RENDERED: 'user_message_rendered',
                CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
                MESSAGE_SWIPED: 'message_swiped',
                IMPERSONATE_READY: 'impersonate_ready',
                MESSAGE_EDITED: 'message_edited',
                MESSAGE_UPDATED: 'message_updated',
                MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
                MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
                TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
                CHAT_CHANGED: 'chat_changed',
                MOVABLE_PANELS_RESET: 'movable_panels_reset',
                GROUP_UPDATED: 'group_updated',
                SECRET_WRITTEN: 'secret_written',
                SECRET_DELETED: 'secret_deleted',
                SECRET_ROTATED: 'secret_rotated',
                APP_READY: 'app_ready',
            },
            generateQuietPrompt: jest.fn(),
            generateRaw: jest.fn(),
            getRequestHeaders: () => ({}),
            online_status: 'connected',
            reloadCurrentChat: jest.fn(),
            saveChatConditional: jest.fn(),
            saveSettingsDebounced: jest.fn(),
            substituteParams: (s) => String(s ?? ''),
            substituteParamsExtended: (s) => String(s ?? ''),
            system_message_types: {},
            this_chid: undefined,
            updateMessageBlock: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
            extension_settings: harness.extensionSettings,
            getContext: () => ({ chat: [], translate: (s) => String(s ?? ''), characters: [], groups: [] }),
            ModuleWorkerWrapper: class {
                constructor(fn) { this.fn = fn; }
                update() {}
            },
            renderExtensionTemplateAsync: async (ext, name) => harness.templates[`${ext}:${name}`] ?? '',
            saveMetadataDebounced: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
            debounce: (fn) => fn,
            delay: async () => {},
            ensureImageFormatSupported: async (f) => f,
            escapeRegex: (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            findChar: () => null,
            getBase64Async: async () => '',
            getCharaFilename: () => '',
            getFileExtension: () => 'png',
            getSortableDelay: () => 0,
            includesIgnoreCaseAndAccents: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
            isFalseBoolean: (v) => v === false || v === 'false',
            isTrueBoolean: (v) => v === true || v === 'true',
            onlyUnique: (v, i, a) => a.indexOf(v) === i,
            saveBase64AsFile: async () => '',
            showFontAwesomePicker: async () => '',
            splitRecursive: (s) => [String(s ?? '')],
            trimToEndSentence: (s) => s,
            trimToStartSentence: (s) => s,
            uuidv4: () => '00000000-0000-4000-8000-000000000000',
            waitUntilCondition: async () => {},
        }));
        jest.unstable_mockModule('../../public/scripts/RossAscends-mods.js', () => ({
            dragElement: jest.fn(),
            getMessageTimeStamp: () => 'now',
            isMobile: () => false,
        }));
        jest.unstable_mockModule('../../public/scripts/secrets.js', () => ({
            SECRET_KEYS: {},
            secret_state: harness.secretState,
        }));
        jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
            oai_settings: { reverse_proxy: '', custom_model: '' },
            POLLINATIONS_ENDPOINT: {},
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/shared.js', () => ({
            generateWebLlmChatPrompt: jest.fn(),
            getMultimodalCaption: jest.fn(),
            isWebLlmSupported: () => false,
        }));
        jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({
            isJsonSchemaSupported: () => false,
            textgen_types: {},
            textgenerationwebui_settings: { server_urls: {}, ollama_model: '', vllm_model: '' },
        }));
        jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
            loadMovingUIState: jest.fn(),
            performFuzzySearch: () => [],
            power_user: { experimental_macro_engine: false, movingUIState: {} },
        }));
        jest.unstable_mockModule('../../public/scripts/group-chats.js', () => ({
            hideMutedSprites: false,
            selected_group: null,
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({
            executeSlashCommandsOnChatInput: jest.fn(),
            executeSlashCommandsWithOptions: jest.fn(),
            setSlashCommandAutoComplete: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
            SlashCommandParser: Object.assign(class {}, { addCommandObject: jest.fn() }),
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
            SlashCommand: { fromProps: (p) => p },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
            ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean' },
            SlashCommandArgument: Object.assign(class {}, { fromProps: (p) => p }),
            SlashCommandNamedArgument: Object.assign(class {}, { fromProps: (p) => p }),
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
            commonEnumProviders: { boolean: () => () => [], characters: () => () => [], messages: () => () => [], messageMedia: () => () => [] },
            enumIcons: { server: 'server' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
            SlashCommandEnumValue: class {},
            enumTypes: { enum: 'enum', name: 'name' },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandReturnHelper.js', () => ({
            slashCommandReturnHelper: { doReturn: jest.fn(), enumList: () => [] },
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandAbortController.js', () => ({
            SlashCommandAbortController: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandBreakPoint.js', () => ({
            SlashCommandBreakPoint: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandClosure.js', () => ({
            SlashCommandClosure: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandClosureResult.js', () => ({
            SlashCommandClosureResult: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandDebugController.js', () => ({
            SlashCommandDebugController: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandExecutor.js', () => ({
            SlashCommandExecutor: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParserError.js', () => ({
            SlashCommandParserError: class extends Error {},
        }));
        jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandScope.js', () => ({
            SlashCommandScope: class {},
        }));
        jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
            callGenericPopup: jest.fn(),
            Popup: Object.assign(class {}, { show: { input: jest.fn(), confirm: jest.fn() } }),
            POPUP_RESULT: { NEGATIVE: 0 },
            POPUP_TYPE: { INPUT: 3, CONFIRM: 2 },
        }));
        jest.unstable_mockModule('../../public/scripts/constants.js', () => ({
            debounce_timeout: { quick: 0, short: 0 },
            MEDIA_DISPLAY: {},
            MEDIA_SOURCE: {},
            MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', getFromMime: () => 'image' },
            SCROLL_BEHAVIOR: {},
        }));
        jest.unstable_mockModule('../../public/scripts/lib/prompt-values.js', () => ({
            initializePromptDefaults: () => false,
            requireStoredPrompt: (v) => v,
        }));
        jest.unstable_mockModule('../../public/scripts/reasoning.js', () => ({
            removeReasoningFromString: (s) => s,
            updateReasoningUI: jest.fn(),
        }));
        jest.unstable_mockModule('../../public/scripts/macros/macro-system.js', () => ({
            macros: { register: jest.fn(), category: { MISC: 'misc' }, valueType: { STRING: 'string' } },
        }));
        jest.unstable_mockModule('/scripts/macros.js', () => ({
            MacrosParser: { registerMacro: jest.fn() },
        }));
        jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
            t: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), ''),
        }));
        jest.unstable_mockModule('../../public/scripts/extensions/quick-reply/index.js', () => ({
            debounceAsync: (fn) => fn,
            log: jest.fn(),
            warn: jest.fn(),
            quickReplyApi: {},
        }));
    });

    beforeEach(() => {
        resetObject(harness.extensionSettings);
        resetObject(harness.chatMetadata);
        resetObject(harness.secretState);
        resetObject(harness.eventHandlers);
        resetObject(harness.templates);
    });

    test('Caption mounts at top of .caption_settings .inline-drawer-content, refreshes on source/API/model/prompt_restore, and dims dormant fields', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };
        globalThis.fetch = jest.fn(async () => ({ ok: false, json: async () => [] }));

        const captionContainer = document.createElement('div');
        captionContainer.id = 'caption_container';
        const wandContainer = document.createElement('div');
        wandContainer.id = 'caption_wand_container';
        const formSheld = document.createElement('div');
        formSheld.id = 'form_sheld';
        document.body.append(captionContainer, wandContainer, formSheld);

        harness.templates['caption:settings'] = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/caption/settings.html'),
            'utf8',
        );
        resetObject(harness.extensionSettings, {
            caption: {
                source: 'local',
                multimodal_api: 'openai',
                multimodal_model: 'gpt-5.6-luna',
                alt_endpoint_enabled: false,
                alt_endpoint_url: '',
                custom_model: '',
                ollama_custom_model: '',
                prompt: 'What\'s in this image?',
                template: '[{{caption}}]',
                auto_mode: false,
                refine_mode: false,
                show_in_chat: false,
            },
        });

        const captionMod = await import('../../public/scripts/extensions/caption/index.js');
        await captionMod.init();

        const drawerContent = document.querySelector('.caption_settings .inline-drawer-content');
        const card = drawerContent.firstElementChild;
        expect(card?.classList.contains('luker-bsum')).toBe(true);
        expect(card.dataset.bsumId).toBe('caption-settings');
        expect(card.classList.contains('is-active')).toBe(true);
        expect(card.textContent).toContain('Local');
        expect(card.textContent).not.toContain('gpt-5.6-luna');

        const apiSel = document.getElementById('caption_multimodal_api');
        const modelSel = document.getElementById('caption_multimodal_model');
        const apiWrapper = apiSel.closest('.flex-container.flexFlowColumn');
        const modelWrapper = modelSel.closest('.flex-container.flexFlowColumn');
        expect(apiWrapper).toBeTruthy();
        expect(modelWrapper).toBeTruthy();
        expect(apiWrapper.classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(modelWrapper.classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(apiSel.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(modelSel.classList.contains('luker-bsum-field-dormant')).toBe(false);

        // Switch to multimodal -> shows API + model, undims parent wrappers, and dims altEndpointUrl and custom models
        const sourceSel = document.getElementById('caption_source');
        sourceSel.value = 'multimodal';
        sourceSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 15));

        expect(card.textContent).toContain('OpenAI');
        expect(card.textContent).toContain('gpt-5.6-luna');
        expect(apiWrapper.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(modelWrapper.classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(document.getElementById('caption_altEndpoint_url').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Switch API to google -> shows video support
        apiSel.value = 'google';
        apiSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 15));
        expect(card.textContent).toMatch(/video/i);

        // Switch API to custom & custom_custom with empty input -> danger + focus preservation
        apiSel.value = 'custom';
        apiSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 15));

        modelSel.value = 'custom_custom';
        modelSel.dispatchEvent(new Event('change', { bubbles: true }));
        expect(card.classList.contains('is-danger')).toBe(true);

        const customInput = document.getElementById('caption_custom_model');
        customInput.focus();
        customInput.value = 'my-vision';
        customInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.activeElement).toBe(customInput);
        expect(card.classList.contains('is-active')).toBe(true);
        expect(card.textContent).toContain('my-vision');

        // Empty prompt -> danger; Reset to default restores active
        const promptInput = document.getElementById('caption_prompt');
        promptInput.value = '';
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(card.classList.contains('is-danger')).toBe(true);

        document.getElementById('caption_prompt_restore').click();
        expect(card.classList.contains('is-active')).toBe(true);
    });

    test('Expressions mounts at top of .expression_settings .inline-drawer-content, reflects dormant/warn rules, and refreshes on programmatic changes', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };
        globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => [] }));

        const expContainer = document.createElement('div');
        expContainer.id = 'expressions_container';
        document.body.appendChild(expContainer);

        harness.templates['expressions:settings'] = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/expressions/settings.html'),
            'utf8',
        );
        resetObject(harness.extensionSettings, {
            expressions: {
                api: 99,
                promptType: 'raw',
                translate: true,
                allowMultiple: true,
                rerollIfSame: false,
                filterAvailable: false,
                llmPrompt: 'Classify: {{labels}}',
                fallback_expression: 'joy',
                custom: [],
            },
            expressionOverrides: [],
        });

        const intervalIds = [];
        const origSetInterval = globalThis.setInterval;
        jest.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...args) => {
            const id = origSetInterval(fn, ms, ...args);
            intervalIds.push(id);
            return id;
        });

        try {
            const expMod = await import('../../public/scripts/extensions/expressions/index.js');
            await expMod.init();

            const drawerContent = document.querySelector('.expression_settings .inline-drawer-content');
            const card = drawerContent.firstElementChild;
            expect(card?.classList.contains('luker-bsum')).toBe(true);
            expect(card.dataset.bsumId).toBe('expressions-settings');
            expect(card.classList.contains('is-dormant')).toBe(true);
            expect(document.getElementById('expression_translate').closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);

            // Switch to Main API (2) + Full Context + translate=true -> warn
            const apiSel = document.getElementById('expression_api');
            apiSel.value = '2';
            apiSel.dispatchEvent(new Event('change', { bubbles: true }));
            expect(card.classList.contains('is-active')).toBe(true);

            const fullRadio = document.getElementById('expression_prompt_full');
            fullRadio.checked = true;
            fullRadio.dispatchEvent(new Event('input', { bubbles: true }));
            fullRadio.dispatchEvent(new Event('change', { bubbles: true }));
            expect(card.classList.contains('is-warn')).toBe(true);

            // Uncheck allowMultiple and check rerollIfSame -> dims rerollIfSame and warns
            const allowMultiple = document.getElementById('expressions_allow_multiple');
            allowMultiple.checked = false;
            allowMultiple.dispatchEvent(new Event('input', { bubbles: true }));
            const reroll = document.getElementById('expressions_reroll_if_same');
            reroll.checked = true;
            reroll.dispatchEvent(new Event('input', { bubbles: true }));
            expect(reroll.closest('.checkbox_label').classList.contains('luker-bsum-field-dormant')).toBe(true);
            expect(card.querySelectorAll('.luker-bsum-warn')).toHaveLength(2);

            // jQuery .trigger('change') on #expression_fallback updates card
            const fallbackSel = document.getElementById('expression_fallback');
            fallbackSel.value = '#emoji';
            globalThis.$('#expression_fallback').trigger('change');
            await new Promise((r) => setTimeout(r, 0));
            expect(card.textContent).toMatch(/emoji/i);
        } finally {
            for (const id of intervalIds) clearInterval(id);
        }
    });

    test('Translate mounts at top of .translation_settings .inline-drawer-content and refreshes on auto_mode, provider, target_language, and SECRET events', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

        const container = document.createElement('div');
        container.id = 'translation_container';
        const wandContainer = document.createElement('div');
        wandContainer.id = 'translate_wand_container';
        document.body.append(container, wandContainer);

        harness.templates['translate:index'] = readFileSync(
            resolve(REPO_ROOT, 'public/scripts/extensions/translate/index.html'),
            'utf8',
        );
        resetObject(harness.extensionSettings, { translate: {} });

        const translateMod = await import('../../public/scripts/extensions/translate/index.js');
        await translateMod.init();

        const drawerContent = document.querySelector('.translation_settings .inline-drawer-content');
        const card = drawerContent.firstElementChild;
        expect(card?.classList.contains('luker-bsum')).toBe(true);
        expect(card.dataset.bsumId).toBe('translate-settings');
        expect(card.classList.contains('is-dormant')).toBe(true);

        // Switch autoMode to inputs with default targetLanguage === en -> warn
        const autoSel = document.getElementById('translation_auto_mode');
        autoSel.value = 'inputs';
        autoSel.dispatchEvent(new Event('change', { bubbles: true }));
        expect(card.classList.contains('is-warn')).toBe(true);

        // Switch targetLanguage to zh-CN -> active
        const langSel = document.getElementById('translation_target_language');
        langSel.value = 'zh-CN';
        langSel.dispatchEvent(new Event('change', { bubbles: true }));
        expect(card.classList.contains('is-active')).toBe(true);

        // Switch provider to deepl without key -> danger
        const providerSel = document.getElementById('translation_provider');
        providerSel.value = 'deepl';
        providerSel.dispatchEvent(new Event('change', { bubbles: true }));
        expect(card.classList.contains('is-danger')).toBe(true);

        // Secret written for deepl -> clears danger to active
        harness.secretState.deepl = true;
        for (const fn of harness.eventHandlers.secret_written || []) fn('deepl');
        expect(card.classList.contains('is-active')).toBe(true);

        // Switch provider to libre without libre_url -> danger; writing libre_url clears danger
        providerSel.value = 'libre';
        providerSel.dispatchEvent(new Event('change', { bubbles: true }));
        expect(card.classList.contains('is-danger')).toBe(true);

        harness.secretState.libre_url = true;
        for (const fn of harness.eventHandlers.secret_written || []) fn('libre_url');
        expect(card.classList.contains('is-active')).toBe(true);
    });

    test('Quick Reply mounts Global card at top of #qr--settings .inline-drawer-content and Per-Set card at top of #qr--set-settings, refreshing across toggles, set selection, and set-list mutations', async () => {
        installMinimalJQuery();
        globalThis.toastr = { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() };

        const settingsHtml = readFileSync(resolve(REPO_ROOT, 'public/scripts/extensions/quick-reply/html/settings.html'), 'utf8');
        globalThis.fetch = jest.fn(async () => ({
            ok: true,
            text: async () => settingsHtml,
        }));

        const { QuickReplySet } = await import('../../public/scripts/extensions/quick-reply/src/QuickReplySet.js');
        const { QuickReplyConfig } = await import('../../public/scripts/extensions/quick-reply/src/QuickReplyConfig.js');
        const { QuickReplySettings } = await import('../../public/scripts/extensions/quick-reply/src/QuickReplySettings.js');
        const { SettingsUi } = await import('../../public/scripts/extensions/quick-reply/src/ui/SettingsUi.js');

        const setAlpha = new QuickReplySet();
        setAlpha.name = 'Alpha';
        const setBeta = new QuickReplySet();
        setBeta.name = 'Beta';
        setBeta.disableSend = true;
        setBeta.placeBeforeInput = true;
        setBeta.injectInput = false;
        QuickReplySet.list = [setAlpha, setBeta];

        const settings = QuickReplySettings.from({
            isEnabled: false,
            isCombined: false,
            showPopoutButton: true,
            config: { setList: [{ set: 'Alpha', isVisible: true }] },
            characterConfigs: {},
        });
        settings.chatConfig = QuickReplyConfig.from({ setList: [] });
        settings.charConfig = QuickReplyConfig.from({ setList: [] });

        const ui = new SettingsUi(settings);
        const dom = await ui.render();
        document.body.appendChild(dom);

        const drawerContent = dom.querySelector('.inline-drawer-content');
        const setSettings = dom.querySelector('#qr--set-settings');
        const globalCard = drawerContent.firstElementChild;
        const setCard = setSettings.firstElementChild;

        expect(globalCard?.classList.contains('luker-bsum')).toBe(true);
        expect(globalCard.dataset.bsumId).toBe('quick-reply-global');
        expect(globalCard.classList.contains('is-dormant')).toBe(true);
        expect(dom.querySelector('#qr--isCombined').closest('label').classList.contains('luker-bsum-field-dormant')).toBe(true);

        expect(setCard?.classList.contains('luker-bsum')).toBe(true);
        expect(setCard.dataset.bsumId).toBe('quick-reply-set');
        expect(setCard.classList.contains('is-active')).toBe(true);

        // Enable Quick Replies -> clicking checkbox flips false -> true and activates Global card
        const enableCheck = dom.querySelector('#qr--isEnabled');
        enableCheck.click();
        expect(enableCheck.checked).toBe(true);
        expect(globalCard.classList.contains('is-active')).toBe(true);
        expect(globalCard.textContent).toContain('1');

        // Select Beta in #qr--set -> Per-Set card shows disableSend /commands paste note + placeBeforeInput warn + unlinked notice
        const setDropdown = dom.querySelector('#qr--set');
        setDropdown.value = 'Beta';
        setDropdown.dispatchEvent(new Event('change', { bubbles: true }));
        expect(setCard.classList.contains('is-warn')).toBe(true);
        expect(setCard.textContent).toMatch(/inactive in.*bar.*auto-execute/i);
        expect(setCard.textContent).toMatch(/\/commands/i);
        expect(dom.querySelector('#qr--placeBeforeInput').closest('label').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Click + Add in #qr--chat twice -> first adds Alpha, second adds Beta via real DOM clicks!
        dom.querySelector('#qr--chat-setListAdd').click();
        expect(globalCard.textContent).toMatch(/\b1 chat\b/i);
        expect(setCard.textContent).toMatch(/inactive in.*bar.*auto-execute/i);

        dom.querySelector('#qr--chat-setListAdd').click();
        expect(globalCard.textContent).toMatch(/\b2 chat\b/i);
        expect(setCard.textContent).not.toMatch(/inactive in.*bar.*auto-execute/i);

        // Delete Beta (2nd item in #qr--chat) via real DOM trash click -> inactive notice returns in Per-Set card
        dom.querySelectorAll('#qr--chat .qr--del')[1].click();
        expect(globalCard.textContent).toMatch(/\b1 chat\b/i);
        expect(setCard.textContent).toMatch(/inactive in.*bar.*auto-execute/i);

        // Swap charConfig to a config containing Beta -> refreshes both cards
        settings.charConfig = QuickReplyConfig.from({ setList: [{ set: 'Beta', isVisible: true }] });
        expect(globalCard.textContent).toMatch(/\b1 character\b/i);
        expect(setCard.textContent).not.toMatch(/inactive in.*bar.*auto-execute/i);

        // Uncheck Buttons (isVisible = false) on Beta in character list -> Card 1 counts 0 visible + 1 hidden, Card 2 switches to auto-execute-only
        ui.prepareCharacterSetList();
        const betaVisibleCheckbox = dom.querySelector('#qr--character .qr--visible input[type="checkbox"]');
        expect(betaVisibleCheckbox).toBeTruthy();
        expect(betaVisibleCheckbox.checked).toBe(true);
        betaVisibleCheckbox.click();
        expect(betaVisibleCheckbox.checked).toBe(false);
        expect(globalCard.textContent).toMatch(/\b0 character\b/i);
        expect(globalCard.textContent).toMatch(/\b1 hidden\b/i);
        expect(setCard.textContent).toMatch(/hidden from the Quick Reply bar/i);
        expect(setCard.textContent).toMatch(/auto-execute triggers only/i);

        // Re-check Buttons (isVisible = true) -> restores bar + auto-execute and clears hidden count
        betaVisibleCheckbox.click();
        expect(betaVisibleCheckbox.checked).toBe(true);
        expect(globalCard.textContent).toMatch(/\b1 character\b/i);
        expect(globalCard.textContent).not.toMatch(/auto-execute only/i);
        expect(setCard.textContent).toMatch(/active in the Quick Reply bar and auto-execute triggers/i);

        // rerender() stays idempotent (still exactly 1 Global and 1 Per-Set card)
        ui.rerender();
        expect(dom.querySelectorAll('.luker-bsum[data-bsum-id="quick-reply-global"]')).toHaveLength(1);
        expect(dom.querySelectorAll('.luker-bsum[data-bsum-id="quick-reply-set"]')).toHaveLength(1);
    });
});

describe('i18n parity & verbatim label checks', () => {
    test('zh-cn and zh-tw include all summary keys across all 4 extensions with matching ${token} placeholders, zero unescaped semicolons, and full-width CJK punctuation', () => {
        const sources = [
            'public/scripts/extensions/caption/behavior-summary-model.js',
            'public/scripts/extensions/caption/index.js',
            'public/scripts/extensions/expressions/behavior-summary-model.js',
            'public/scripts/extensions/expressions/index.js',
            'public/scripts/extensions/translate/behavior-summary-model.js',
            'public/scripts/extensions/translate/index.js',
            'public/scripts/extensions/quick-reply/src/behavior-summary-models.js',
            'public/scripts/extensions/quick-reply/src/ui/SettingsUi.js',
        ];
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const halfWidthCjk = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;

        const keys = new Set();
        const englishTexts = new Set();
        for (const rel of sources) {
            const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
            for (const m of src.matchAll(/\btranslate(?:Summary)?\(\s*'((?:\\'|[^'])*)'(?:\s*,\s*'((?:\\'|[^'])*)')?\s*\)/g)) {
                const text = m[1].replace(/\\'/g, '\'');
                const key = m[2] ? m[2].replace(/\\'/g, '\'') : text;
                englishTexts.add(text);
                keys.add(key);
            }
            for (const m of src.matchAll(/\btranslate(?:Summary)?\(\s*"((?:\\"|[^"])*)"(?:\s*,\s*"((?:\\"|[^"])*)")?\s*\)/g)) {
                const text = m[1].replace(/\\"/g, '"');
                const key = m[2] ? m[2].replace(/\\"/g, '"') : text;
                englishTexts.add(text);
                keys.add(key);
            }
        }
        expect(keys.size).toBeGreaterThan(30);

        for (const text of englishTexts) {
            expect(text).not.toMatch(/(?<!\\);/);
        }

        for (const key of keys) {
            expect(key).not.toMatch(/(?<!\\);/);
            expect(typeof zhCn[key]).toBe('string');
            expect(typeof zhTw[key]).toBe('string');
            expect(zhCn[key].length).toBeGreaterThan(0);
            expect(zhTw[key].length).toBeGreaterThan(0);
            expect(halfWidthCjk.test(zhCn[key])).toBe(false);
            expect(halfWidthCjk.test(zhTw[key])).toBe(false);

            const expectedTokens = [...key.matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const cnTokens = [...zhCn[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            const twTokens = [...zhTw[key].matchAll(/\$\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
            expect(cnTokens).toEqual(expectedTokens);
            expect(twTokens).toEqual(expectedTokens);
        }
    });

    test('zh-cn and zh-tw summary control tokens match extension HTML data-i18n labels verbatim', () => {
        const zhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const makeTranslate = (localeMap) => (text, key = null) => localeMap?.[key || text] || text;

        for (const localeMap of [zhCn, zhTw]) {
            globalThis.Luker = { getContext: () => ({ translate: makeTranslate(localeMap) }) };

            const capAlt = buildCaptionSummaryModel(makeCaptionState({
                source: 'multimodal',
                multimodalApi: 'ollama',
                multimodalModel: 'ollama_custom',
                ollamaCustomModel: '',
                altEndpointEnabled: true,
                altEndpointUrl: '',
            }));
            expect(capAlt.warnings[0].tokens.altEndpointEnabled.text).toBe(localeMap['Use secondary URL']);
            expect(capAlt.warnings[0].tokens.altEndpointUrl.text).toBe(localeMap['Secondary captioning endpoint URL']);
            expect(capAlt.warnings[1].tokens.multimodalModel.text).toBe(localeMap['[Custom model]']);
            expect(capAlt.warnings[1].tokens.ollamaCustomModel.text).toBe(localeMap['Custom Model Tag']);

            const expWarn = buildExpressionsSummaryModel(makeExpressionsState({
                api: 2,
                promptType: 'full',
                translate: true,
                allowMultiple: false,
                rerollIfSame: true,
            }));
            expect(expWarn.warnings[0].tokens.promptType.text).toBe(localeMap['Full Context']);
            expect(expWarn.warnings[0].tokens.translate.text).toBe(localeMap['Translate text to English before classification']);
            expect(expWarn.warnings[1].tokens.rerollIfSame.text).toBe(localeMap['Re-roll if same expression is used again']);
            expect(expWarn.warnings[1].tokens.allowMultiple.text).toBe(localeMap['Allow multiple sprites per expression']);

            const trModel = buildTranslateSummaryModel(makeTranslateState({
                autoMode: 'inputs',
                targetLanguage: 'en',
                targetLanguageLabel: 'English',
            }));
            expect(trModel.rows[0].tokens.autoMode.text).toBe(localeMap.ext_translate_mode_inputs);

            const qrSet = buildQuickReplySetSummary(makeQuickReplySetState({
                disableSend: true,
                injectInput: false,
                placeBeforeInput: true,
            }));
            expect(qrSet.warnings[0].tokens.placeBeforeInput.text).toBe(localeMap['Place Quick Reply Before Input']);
            expect(qrSet.warnings[0].tokens.injectInput.text).toBe(localeMap['Inject user input automatically']);
        }
    });
});
