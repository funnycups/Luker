/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
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

describe('buildCeaSummaryModel', () => {
    test('reports fallback tokens, retry count, and interactive field bindings when connection/preset are unset', () => {
        const model = buildCeaSummaryModel({
            requestApiPresetName: '',
            requestLlmPresetName: '',
            toolCallRetryMax: 2,
        });

        expect(model.tone).toBe('active');
        expect(model.rows).toHaveLength(1);
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'requestApiPresetName',
            'requestLlmPresetName',
            'toolCallRetryMax',
        ]));

        const { fullText } = renderModel(model);
        expect(model.rows[0].tokens.requestApiPresetName.text.length).toBeGreaterThan(0);
        expect(model.rows[0].tokens.requestLlmPresetName.text.length).toBeGreaterThan(0);
        expect(fullText).toContain('2');
    });

    test('reports explicit connection, preset, and retry tones without upper cap', () => {
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

    test('routes template, role, and fallback token labels through the provided i18n function', () => {
        const model = buildCeaSummaryModel({
            requestApiPresetName: '',
            requestLlmPresetName: '',
            toolCallRetryMax: 1,
            i18n: (s) => `[T]${s}`,
        });
        expect(model.rows[0].role).toMatch(/^\[T\]/);
        expect(model.rows[0].template).toMatch(/^\[T\]/);
        expect(model.rows[0].tokens.requestApiPresetName.text).toMatch(/^\[T\]/);
        expect(model.rows[0].tokens.requestLlmPresetName.text).toMatch(/^\[T\]/);
    });
});

describe('buildCpaSummaryModel', () => {
    test('reports all 3 prompts using defaults with all 3 field keys linked', () => {
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

    test('detected hooks with 0 custom orders renders active state distinct from custom-ordered state', () => {
        const defaultOnly = buildHookOrderSummaryModel({
            hooks: [
                { eventName: 'message_sent', discoveredPlugins: ['ext-a', 'ext-b'], customOrder: [] },
                { eventName: 'message_received', discoveredPlugins: ['ext-c'], customOrder: [] },
                { eventName: 'chat_changed', discoveredPlugins: [], customOrder: [] },
            ],
        });

        expect(defaultOnly.tone).toBe('active');
        expect(defaultOnly.rows).toHaveLength(1);
        const { fullText } = renderModel(defaultOnly);
        expect(fullText).toContain('2');
        expect(defaultOnly.rows[0].tokens.detectedCount.text).toBe('2');
        expect(defaultOnly.rows[0].tokens.customCount).toBeUndefined();
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
