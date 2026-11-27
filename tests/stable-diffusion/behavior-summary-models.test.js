/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildIllustrationMainSummary,
    buildIllustrationProfileAgentSummary,
    buildSdModeSummary,
} from '../../public/scripts/extensions/stable-diffusion/behavior-summary-models.js';

function makeMainState(overrides = {}) {
    return {
        enabled: true,
        autoGenerate: true,
        hasPreset: true,
        presetName: 'Default Tag',
        apiPresetName: '',
        llmPresetName: '',
        contextMessageCount: 10,
        maxConcurrentGenerations: 1,
        minGenerationInterval: 0,
        imageDisplayWidth: 100,
        characterImageConflict: null,
        ...overrides,
    };
}

function makeProfileAgentState(overrides = {}) {
    return {
        characterReferenceEnabled: true,
        canActivateCharacterReference: false,
        visualInspection: false,
        explorationApiPreset: '',
        explorationLlmPreset: '',
        illustrationApiPreset: '',
        illustrationLlmPreset: '',
        ...overrides,
    };
}

function makeSdModeState(overrides = {}) {
    return {
        functionTool: false,
        interactiveMode: false,
        toolCallingSupported: true,
        refineMode: false,
        freeExtend: false,
        minimalPromptProcessing: false,
        multimodalCaptioning: false,
        snap: false,
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

describe('buildIllustrationMainSummary', () => {
    test('disabled state sets dormant tone, dims autoGenerate, and still interpolates preset/connection/display metrics', () => {
        const model = buildIllustrationMainSummary(makeMainState({
            enabled: false,
            autoGenerate: true,
            presetName: 'Anime Tag',
            apiPresetName: 'FastConn',
            llmPresetName: 'StudioPreset',
            maxConcurrentGenerations: 3,
            minGenerationInterval: 500,
            imageDisplayWidth: 80,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(['autoGenerate']);

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(rendered.fullText).toContain('Anime Tag');
        expect(rendered.fullText).toContain('FastConn');
        expect(rendered.fullText).toContain('StudioPreset');
        expect(rendered.fullText).toContain('3');
        expect(rendered.fullText).toContain('500');
        expect(rendered.fullText).toContain('80%');
    });

    test('enabled state covers auto/manual trigger, zero/non-zero context, and fallback vs explicit presets', () => {
        const autoZero = buildIllustrationMainSummary(makeMainState({
            enabled: true,
            autoGenerate: true,
            contextMessageCount: 0,
            apiPresetName: '',
            llmPresetName: '',
        }));
        expect(autoZero.tone).toBe('active');
        expect(autoZero.dormantFields).toEqual([]);
        const autoText = renderModel(autoZero).fullText;
        const autoTokens = autoZero.rows.flatMap((r) => Object.values(r.tokens || {}));
        expect(autoTokens.find((t) => t?.field === 'apiPresetName')?.text.length).toBeGreaterThan(0);
        expect(autoTokens.find((t) => t?.field === 'llmPresetName')?.text.length).toBeGreaterThan(0);

        const manual = buildIllustrationMainSummary(makeMainState({
            enabled: true,
            autoGenerate: false,
            contextMessageCount: 12,
            apiPresetName: 'OpenAIConn',
            llmPresetName: 'NovelTag',
        }));
        expect(manual.tone).toBe('active');
        const manualText = renderModel(manual).fullText;
        expect(manualText).not.toBe(autoText);
        expect(manualText).toContain('12');
        expect(manualText).toContain('OpenAIConn');
        expect(manualText).toContain('NovelTag');
        expect(tokenFieldKeys(manual)).toEqual(new Set([
            'autoGenerate',
            'preset',
            'apiPresetName',
            'llmPresetName',
            'contextMessageCount',
            'maxConcurrentGenerations',
            'minGenerationInterval',
            'imageDisplayWidth',
        ]));
    });

    test('missing preset emits danger warning and elevates tone to danger even when disabled', () => {
        const model = buildIllustrationMainSummary(makeMainState({
            enabled: false,
            hasPreset: false,
            presetName: '',
        }));

        expect(model.tone).toBe('danger');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('danger');
        expect(tokenFieldKeys(model).has('preset')).toBe(true);
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].severity).toBe('danger');
    });

    test('characterImageConflict surfaces conflict notice and elevates tone', () => {
        const model = buildIllustrationMainSummary(makeMainState({
            enabled: true,
            characterImageConflict: {
                code: 'novel_char_ref_requires_v45',
                message: 'NovelAI character reference images require a V4.5 model.',
                affects: ['character_image'],
            },
        }));

        expect(['warn', 'danger']).toContain(model.tone);
        expect(model.warnings).toHaveLength(1);
        expect(['warn', 'danger']).toContain(model.warnings[0].severity);
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].text).toContain('V4.5');
    });

    test('hostile preset name renders as literal textContent without child elements', () => {
        const hostile = '<img src=x onerror=1>${autoGenerate}';
        const model = buildIllustrationMainSummary(makeMainState({ presetName: hostile }));
        const parts = renderTemplateParts(model.rows[0].template, model.rows[0].tokens);
        const presetBtn = parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'preset');
        expect(presetBtn).toBeTruthy();
        expect(presetBtn.children.length).toBe(0);
        expect(presetBtn.textContent).toBe(hostile);
    });
});

describe('buildIllustrationProfileAgentSummary', () => {
    test('characterReferenceEnabled false sets dormant tone and renders read-only span when absent from DOM', () => {
        const model = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            characterReferenceEnabled: false,
            canActivateCharacterReference: false,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        const charRefPart = rendered.rowTexts[0].parts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(charRefPart).toBeTruthy();
        expect(charRefPart.tagName).toBe('SPAN');
        expect(charRefPart.classList.contains('is-readonly')).toBe(true);
    });

    test('characterReferenceEnabled true renders active state and interactive button when activatable', () => {
        const onActivate = jest.fn(() => true);
        const model = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            characterReferenceEnabled: true,
            canActivateCharacterReference: true,
            onCharacterReferenceActivate: onActivate,
        }));

        expect(model.tone).toBe('active');
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).not.toBe('off');
        const btn = rendered.rowTexts[0].parts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.dataset.bsumFields).toBe('characterReferenceEnabled');
    });

    test('paired-inheritance: inherits illustration pair only when both empty; half-set warns and does not inherit partner', () => {
        const inherited = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: '',
            explorationLlmPreset: '',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(inherited.tone).toBe('active');
        expect(inherited.warnings).toEqual([]);
        const inheritedText = renderModel(inherited).fullText;
        expect(inheritedText).toContain('IllConn');
        expect(inheritedText).toContain('IllPreset');

        const apiOnly = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: 'ExpConn',
            explorationLlmPreset: '',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(apiOnly.tone).toBe('warn');
        expect(apiOnly.warnings).toHaveLength(1);
        expect(apiOnly.warnings[0].severity).toBe('warn');
        const apiOnlyRendered = renderModel(apiOnly);
        expect(apiOnlyRendered.fullText).toContain('ExpConn');
        expect(apiOnlyRendered.fullText).not.toContain('IllPreset');

        const llmOnly = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: '',
            explorationLlmPreset: 'ExpPreset',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(llmOnly.tone).toBe('warn');
        expect(llmOnly.warnings).toHaveLength(1);
        expect(llmOnly.warnings[0].severity).toBe('warn');
        const llmOnlyRendered = renderModel(llmOnly);
        expect(llmOnlyRendered.fullText).toContain('ExpPreset');
        expect(llmOnlyRendered.fullText).not.toContain('IllConn');

        const bothSet = buildIllustrationProfileAgentSummary(makeProfileAgentState({
            explorationApiPreset: 'ExpConn',
            explorationLlmPreset: 'ExpPreset',
            illustrationApiPreset: 'IllConn',
            illustrationLlmPreset: 'IllPreset',
        }));
        expect(bothSet.tone).toBe('active');
        expect(bothSet.warnings).toEqual([]);
        const bothText = renderModel(bothSet).fullText;
        expect(bothText).toContain('ExpConn');
        expect(bothText).toContain('ExpPreset');
    });

    test('visualInspection toggles distinct summary states', () => {
        const visionOn = buildIllustrationProfileAgentSummary(makeProfileAgentState({ visualInspection: true }));
        const visionOff = buildIllustrationProfileAgentSummary(makeProfileAgentState({ visualInspection: false }));
        expect(renderModel(visionOn).fullText).not.toBe(renderModel(visionOff).fullText);
        expect(tokenFieldKeys(visionOn)).toContain('visualInspection');
    });
});

describe('buildSdModeSummary', () => {
    test('functionTool && interactiveMode && toolCallingSupported emits warn and puts interactiveMode in dormantFields', () => {
        const model = buildSdModeSummary(makeSdModeState({
            functionTool: true,
            interactiveMode: true,
            toolCallingSupported: true,
        }));

        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toEqual(['interactiveMode']);
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('functionTool')).toBe(true);
        expect(warnFields.has('interactiveMode')).toBe(true);
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('GenerateImage');
    });

    test('functionTool && interactiveMode && !toolCallingSupported does not suppress interactiveMode', () => {
        const supported = buildSdModeSummary(makeSdModeState({
            functionTool: true,
            interactiveMode: false,
            toolCallingSupported: true,
        }));
        const model = buildSdModeSummary(makeSdModeState({
            functionTool: true,
            interactiveMode: true,
            toolCallingSupported: false,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual([]);
        expect(model.warnings).toEqual([]);
        expect(renderModel(model).fullText).not.toBe(renderModel(supported).fullText);
    });

    test('covers all 5 prompt/ratio switches in both states with distinct rendered tokens', () => {
        const allOff = buildSdModeSummary(makeSdModeState());
        expect(allOff.tone).toBe('active');
        expect(allOff.dormantFields).toEqual([]);
        expect(allOff.warnings).toEqual([]);
        expect(tokenFieldKeys(allOff)).toEqual(new Set([
            'functionTool',
            'interactiveMode',
            'freeExtend',
            'refineMode',
            'minimalPromptProcessing',
            'multimodalCaptioning',
            'snap',
        ]));

        const allOn = buildSdModeSummary(makeSdModeState({
            interactiveMode: true,
            freeExtend: true,
            refineMode: true,
            minimalPromptProcessing: true,
            multimodalCaptioning: true,
            snap: true,
        }));
        expect(allOn.tone).toBe('active');
        expect(renderModel(allOn).fullText).not.toBe(renderModel(allOff).fullText);
        for (const field of ['freeExtend', 'refineMode', 'minimalPromptProcessing', 'multimodalCaptioning', 'snap']) {
            const offTok = allOff.rows.flatMap((r) => Object.values(r.tokens || {})).find((t) => t?.field === field);
            const onTok = allOn.rows.flatMap((r) => Object.values(r.tokens || {})).find((t) => t?.field === field);
            expect(offTok).toBeTruthy();
            expect(onTok).toBeTruthy();
            expect(onTok.text).not.toBe(offTok.text);
        }
    });
});
