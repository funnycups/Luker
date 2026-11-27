/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import { buildCaptionSummaryModel } from '../../public/scripts/extensions/caption/behavior-summary-model.js';
import { buildExpressionsSummaryModel } from '../../public/scripts/extensions/expressions/behavior-summary-model.js';
import { buildTranslateSummaryModel } from '../../public/scripts/extensions/translate/behavior-summary-model.js';
import {
    buildQuickReplyGlobalSummary,
    buildQuickReplySetSummary,
} from '../../public/scripts/extensions/quick-reply/src/behavior-summary-models.js';

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
    test('source !== multimodal hides multimodal tokens and suppresses multimodal warnings', () => {
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
            const fields = tokenFieldKeys(model);
            expect(fields.has('multimodalApi')).toBe(false);
            expect(fields.has('multimodalModel')).toBe(false);
            expect(fields.has('allowReverseProxy')).toBe(false);
            expect(fields.has('altEndpointUrl')).toBe(false);
            expect(fields.has('promptAsk')).toBe(false);
        }
    });

    test('source === multimodal includes API, resolved model, proxy/ask tokens, and distinguishes video-capable APIs', () => {
        const renderedByVideo = { true: [], false: [] };
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
            const fields = tokenFieldKeys(model);
            expect(fields.has('multimodalApi')).toBe(true);
            expect(fields.has('multimodalModel')).toBe(true);
            expect(fields.has('allowReverseProxy')).toBe(true);
            expect(fields.has('promptAsk')).toBe(true);
            renderedByVideo[String(apiSpec.video)].push(model.rows[0].tokens.mediaSupport.text);
        }
        expect(new Set(renderedByVideo.true).size).toBe(1);
        expect(new Set(renderedByVideo.false).size).toBe(1);
        expect(renderedByVideo.true[0]).not.toBe(renderedByVideo.false[0]);

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

    test('altEndpointEnabled && !altEndpointUrl emits danger linking altEndpointUrl; !altEndpointEnabled dims altEndpointUrl', () => {
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
        expect(tokenFieldKeys(missingAlt)).toContain('altEndpointUrl');
        expect(tokenFieldKeys(missingAlt)).toContain('altEndpointEnabled');
        renderModel(missingAlt);

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
        expect(tokenFieldKeys(emptyCustom)).toContain('customModel');
        renderModel(emptyCustom);

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
        expect(tokenFieldKeys(emptyOllama)).toContain('ollamaCustomModel');
        renderModel(emptyOllama);

        const nonCustom = buildCaptionSummaryModel(makeCaptionState({
            source: 'multimodal',
            multimodalApi: 'openai',
            multimodalModel: 'gpt-5.6-luna',
        }));
        expect(nonCustom.dormantFields).toContain('customModel');
        expect(nonCustom.dormantFields).toContain('ollamaCustomModel');
    });

    test('autoMode and showInChat toggle distinct output templates and field tokens', () => {
        const autoOn = buildCaptionSummaryModel(makeCaptionState({
            source: 'local',
            autoMode: true,
            showInChat: false,
        }));
        const autoOff = buildCaptionSummaryModel(makeCaptionState({
            source: 'local',
            autoMode: false,
            showInChat: true,
        }));
        expect(tokenFieldKeys(autoOn)).toContain('autoMode');
        expect(tokenFieldKeys(autoOn)).toContain('showInChat');
        expect(renderModel(autoOn).fullText).not.toBe(renderModel(autoOff).fullText);
    });
});

describe('buildExpressionsSummaryModel', () => {
    test('api === 99 (None) sets dormant tone and puts classifier options in dormantFields', () => {
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
        expect(tokenFieldKeys(model)).toContain('api');
    });

    test('api === 2 && promptType === full && translate emits warn linking promptType and translate; raw mode does not warn', () => {
        const fullTranslated = buildExpressionsSummaryModel(makeExpressionsState({
            api: 2,
            promptType: 'full',
            translate: true,
        }));
        expect(fullTranslated.tone).toBe('warn');
        expect(fullTranslated.warnings).toHaveLength(1);
        expect(fullTranslated.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(fullTranslated.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('promptType')).toBe(true);
        expect(warnFields.has('translate')).toBe(true);
        renderModel(fullTranslated);

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
        const warnFields = new Set(Object.values(conflict.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('allowMultiple')).toBe(true);
        expect(warnFields.has('rerollIfSame')).toBe(true);
        renderModel(conflict);

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
    test('autoMode modes produce distinct summaries and interpolate configured target language labels', () => {
        const noneModel = buildTranslateSummaryModel(makeTranslateState({ autoMode: 'none' }));
        expect(noneModel.tone).toBe('dormant');
        expect(renderModel(noneModel).rowTexts[0].tone).toBe('off');

        const respModel = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            targetLanguage: 'zh-CN',
            targetLanguageLabel: 'Chinese (Simplified)',
        }));
        expect(respModel.tone).toBe('active');
        const respText = renderModel(respModel).fullText;
        expect(respText).toContain('Chinese (Simplified)');

        const inputsModel = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'inputs',
            targetLanguage: 'ja',
            targetLanguageLabel: 'Japanese',
        }));
        expect(inputsModel.tone).toBe('active');
        const inputsText = renderModel(inputsModel).fullText;
        expect(inputsText).toContain('Japanese');
        expect(inputsModel.rows[0].template).not.toBe(respModel.rows[0].template);

        const bothModel = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'both',
            targetLanguage: 'fr',
            targetLanguageLabel: 'French',
        }));
        expect(bothModel.tone).toBe('active');
        const bothText = renderModel(bothModel).fullText;
        expect(bothText).toContain('French');
        expect(bothModel.rows[0].template).not.toBe(respModel.rows[0].template);
        expect(bothModel.rows[0].template).not.toBe(inputsModel.rows[0].template);
    });

    test('DeepL missing key & LibreTranslate missing URL emit danger; DeepL tier distinguishes free/pro; targetLanguage === en with inputs/both emits warn', () => {
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

        const deeplReady = buildTranslateSummaryModel(makeTranslateState({
            autoMode: 'responses',
            provider: 'deepl',
            providerLabel: 'DeepL API',
            deeplEndpoint: 'free',
            hasKey: true,
        }));
        expect(deeplReady.tone).toBe('active');
        expect(deeplReady.warnings).toEqual([]);
        expect(deeplReady.rows[1].tokens.deeplEndpoint.text).not.toBe(deeplMissing.rows[1].tokens.deeplEndpoint.text);

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
    test('Global: !isEnabled sets dormant tone and dims isCombined + showPopoutButton', () => {
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
        expect(tokenFieldKeys(model)).toContain('isEnabled');
    });

    test('Global: isEnabled shows Global/Chat/Character counts and distinguishes hidden sets', () => {
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

        const globalWithHidden = buildQuickReplyGlobalSummary(makeQuickReplyGlobalState({
            isEnabled: true,
            globalCount: 1,
            chatCount: 0,
            charCount: 0,
            hiddenCount: 2,
        }));
        expect(globalWithHidden.tone).toBe('active');
        const globalHiddenText = renderModel(globalWithHidden).fullText;
        expect(globalHiddenText).toContain('1');
        expect(globalHiddenText).toContain('2');
        expect(globalHiddenText).not.toBe(rendered.fullText);
    });

    test('Per-Set: validates placeBeforeInput/injectInput dormancy & warning and distinguishes unlinked, hidden-only, and partial-visible sets', () => {
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
        const warnFields = new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('placeBeforeInput')).toBe(true);
        expect(warnFields.has('injectInput')).toBe(true);
        renderModel(model);

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
        const unlinkedText = renderModel(unlinkedClean).fullText;

        // Linked only with isVisible === false -> active, distinct from unlinked and partial-visible
        const hiddenOnly = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'AutoMacro',
            linkedScopes: ['global', 'chat'],
            visibleScopes: [],
        }));
        expect(hiddenOnly.tone).toBe('active');
        const hiddenText = renderModel(hiddenOnly).fullText;
        expect(hiddenText).not.toBe(unlinkedText);

        // Linked in multiple scopes, visible in at least one -> active, distinct from hiddenOnly
        const partialVisible = buildQuickReplySetSummary(makeQuickReplySetState({
            setName: 'MixedSet',
            linkedScopes: ['global', 'chat'],
            visibleScopes: ['global'],
        }));
        expect(partialVisible.tone).toBe('active');
        const partialText = renderModel(partialVisible).fullText;
        expect(partialText).not.toBe(hiddenText);
        expect(partialText).not.toBe(unlinkedText);
    });
});
