/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildVectorsSharedSummary,
    buildVectorsWorldInfoSummary,
    buildVectorsFilesSummary,
    buildVectorsChatsSummary,
} from '../../public/scripts/extensions/vectors/behavior-summary-models.js';

function makeSharedState(overrides = {}) {
    return {
        enabledWorldInfo: false,
        enabledFiles: false,
        enabledChats: true,
        embeddingProfileId: 'embed-1',
        embeddingProfileLabel: 'OpenAI Small',
        query: 2,
        scoreThreshold: 0.25,
        forceChunkDelimiter: '',
        includeWi: false,
        rerankEnabled: false,
        rerankProfileId: '',
        rerankProfileLabel: '',
        ...overrides,
    };
}

function makeWorldInfoState(overrides = {}) {
    return {
        enabledWorldInfo: true,
        enabledForAll: false,
        maxEntries: 5,
        ...overrides,
    };
}

function makeFilesState(overrides = {}) {
    return {
        enabledFiles: true,
        onlyCustomBoundary: false,
        forceChunkDelimiter: '',
        translateFiles: false,
        translationAvailable: true,
        sizeThreshold: 10,
        chunkSize: 5000,
        overlapPercent: 0,
        chunkCount: 2,
        sizeThresholdDb: 5,
        chunkSizeDb: 2500,
        overlapPercentDb: 0,
        chunkCountDb: 5,
        fileTemplateDb: 'Related information:\n{{text}}',
        filePositionDb: 0,
        fileDepthDb: 4,
        fileDepthRoleDb: 0,
        ...overrides,
    };
}

function makeChatsState(overrides = {}) {
    return {
        enabledChats: true,
        keepHidden: false,
        template: 'Past events:\n{{text}}',
        position: 0,
        depth: 2,
        messageChunkSize: 400,
        protect: 5,
        insert: 3,
        summarize: false,
        summarizeSent: false,
        summarySource: 'main',
        summaryPrompt: 'Summarize concisely.',
        summaryRetries: 2,
        summaryThreshold: 200,
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

describe('buildVectorsSharedSummary', () => {
    test('all 3 feature toggles off sets dormant tone, clears warnings, and dims shared retrieval/rerank controls', () => {
        const model = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: false,
            enabledFiles: false,
            enabledChats: false,
            embeddingProfileId: '',
            rerankEnabled: true,
            rerankProfileId: '',
            includeWi: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'embeddingProfileId',
            'query',
            'scoreThreshold',
            'forceChunkDelimiter',
            'includeWi',
            'rerankEnabled',
            'rerankProfileId',
        ]));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'enabledWorldInfo',
            'enabledFiles',
            'enabledChats',
        ]));
    });

    test('any feature toggle on with empty embeddingProfileId emits danger warning linking embeddingProfileId', () => {
        for (const toggles of [
            { enabledWorldInfo: true, enabledFiles: false, enabledChats: false },
            { enabledWorldInfo: false, enabledFiles: true, enabledChats: false },
            { enabledWorldInfo: false, enabledFiles: false, enabledChats: true },
        ]) {
            const model = buildVectorsSharedSummary(makeSharedState({
                ...toggles,
                embeddingProfileId: '',
                embeddingProfileLabel: '',
            }));
            expect(model.tone).toBe('danger');
            expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
            renderModel(model);
            const dangerWarn = model.warnings.find((w) => w.severity === 'danger');
            const warnFields = new Set(Object.values(dangerWarn.tokens || {}).map((t) => t?.field));
            expect(warnFields.has('embeddingProfileId')).toBe(true);
        }
    });

    test('rerankEnabled without rerankProfileId emits warn; !rerankEnabled puts rerankProfileId in dormantFields', () => {
        const missingRerank = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            rerankEnabled: true,
            rerankProfileId: '',
        }));
        expect(missingRerank.tone).toBe('warn');
        expect(missingRerank.warnings).toHaveLength(1);
        expect(missingRerank.warnings[0].severity).toBe('warn');
        expect(missingRerank.dormantFields).not.toContain('rerankProfileId');
        const warnFields = new Set(Object.values(missingRerank.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('rerankProfileId')).toBe(true);
        renderModel(missingRerank);

        const rerankOff = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            rerankEnabled: false,
            rerankProfileId: 'rr-1',
            rerankProfileLabel: 'Cohere Rerank',
        }));
        expect(rerankOff.tone).toBe('active');
        expect(rerankOff.warnings).toEqual([]);
        expect(rerankOff.dormantFields).toContain('rerankProfileId');
        expect(renderModel(rerankOff).rowTexts[1].tone).toBe('off');

        const rerankReady = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            rerankEnabled: true,
            rerankProfileId: 'rr-1',
            rerankProfileLabel: 'Cohere Rerank',
        }));
        expect(rerankReady.tone).toBe('active');
        expect(rerankReady.dormantFields).not.toContain('rerankProfileId');
        expect(renderModel(rerankReady).fullText).toContain('Cohere Rerank');
    });

    test('includeWi on while only World Info enabled puts includeWi and forceChunkDelimiter in dormantFields and emits warn', () => {
        const wiOnly = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: true,
            enabledFiles: false,
            enabledChats: false,
            includeWi: true,
        }));
        expect(wiOnly.tone).toBe('warn');
        expect(wiOnly.dormantFields).toContain('includeWi');
        expect(wiOnly.dormantFields).toContain('forceChunkDelimiter');
        expect(wiOnly.warnings).toHaveLength(1);
        expect(wiOnly.warnings[0].severity).toBe('warn');
        expect(new Set(Object.values(wiOnly.warnings[0].tokens || {}).map((t) => t?.field)).has('includeWi')).toBe(true);
        renderModel(wiOnly);

        const withChats = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: true,
            enabledFiles: false,
            enabledChats: true,
            includeWi: true,
        }));
        expect(withChats.tone).toBe('active');
        expect(withChats.dormantFields).not.toContain('includeWi');
        expect(withChats.dormantFields).not.toContain('forceChunkDelimiter');
        expect(withChats.warnings).toEqual([]);

        const withFiles = buildVectorsSharedSummary(makeSharedState({
            enabledWorldInfo: false,
            enabledFiles: true,
            enabledChats: false,
            includeWi: true,
        }));
        expect(withFiles.tone).toBe('active');
        expect(withFiles.dormantFields).not.toContain('includeWi');
        expect(withFiles.dormantFields).not.toContain('forceChunkDelimiter');
        expect(withFiles.warnings).toEqual([]);
    });

    test('transient blank numeric inputs render safely without NaN or undefined', () => {
        const model = buildVectorsSharedSummary(makeSharedState({
            enabledChats: true,
            query: '',
            scoreThreshold: '',
        }));
        expect(model.tone).toBe('active');
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('OpenAI Small');
        expect(rendered.fullText).toContain('2');
        expect(rendered.fullText).toContain('0.25');
    });
});

describe('buildVectorsWorldInfoSummary', () => {
    test('disabled state sets dormant tone and dims enabledForAll and maxEntries', () => {
        const model = buildVectorsWorldInfoSummary(makeWorldInfoState({
            enabledWorldInfo: false,
            enabledForAll: true,
            maxEntries: 8,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['enabledForAll', 'maxEntries']));
        expect(renderModel(model).rowTexts[0].tone).toBe('off');
    });

    test('enabled state distinguishes enabledForAll modes and interpolates maxEntries', () => {
        const allEntries = buildVectorsWorldInfoSummary(makeWorldInfoState({
            enabledWorldInfo: true,
            enabledForAll: true,
            maxEntries: 7,
        }));
        expect(allEntries.tone).toBe('active');
        expect(allEntries.dormantFields).toEqual([]);
        const allText = renderModel(allEntries).fullText;
        expect(allText).toContain('7');

        const vecOnly = buildVectorsWorldInfoSummary(makeWorldInfoState({
            enabledWorldInfo: true,
            enabledForAll: false,
            maxEntries: 3,
        }));
        expect(vecOnly.tone).toBe('active');
        const vecText = renderModel(vecOnly).fullText;
        expect(vecText).toContain('3');
        expect(allEntries.rows[0].tokens.enabledForAll.text).not.toBe(vecOnly.rows[0].tokens.enabledForAll.text);
    });
});

describe('buildVectorsFilesSummary', () => {
    test('disabled state sets dormant tone and dims all file controls', () => {
        const model = buildVectorsFilesSummary(makeFilesState({
            enabledFiles: false,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'onlyCustomBoundary',
            'translateFiles',
            'sizeThreshold',
            'chunkSize',
            'overlapPercent',
            'chunkCount',
            'sizeThresholdDb',
            'chunkSizeDb',
            'overlapPercentDb',
            'chunkCountDb',
            'fileTemplateDb',
            'filePositionDb',
            'fileDepthDb',
            'fileDepthRoleDb',
        ]));
    });

    test('onlyCustomBoundary without forceChunkDelimiter emits warn linking forceChunkDelimiter; with delimiter clears warn', () => {
        const missingDelim = buildVectorsFilesSummary(makeFilesState({
            onlyCustomBoundary: true,
            forceChunkDelimiter: '',
        }));
        expect(missingDelim.tone).toBe('warn');
        expect(missingDelim.warnings).toHaveLength(1);
        expect(missingDelim.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(missingDelim.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('forceChunkDelimiter')).toBe(true);
        expect(warnFields.has('onlyCustomBoundary')).toBe(true);
        renderModel(missingDelim);

        const withDelim = buildVectorsFilesSummary(makeFilesState({
            onlyCustomBoundary: true,
            forceChunkDelimiter: '---',
        }));
        expect(withDelim.tone).toBe('active');
        expect(withDelim.warnings).toEqual([]);
        expect(renderModel(withDelim).fullText).toContain('---');
    });

    test('translateFiles when translationAvailable is false emits warn linking translateFiles', () => {
        const unavailable = buildVectorsFilesSummary(makeFilesState({
            translateFiles: true,
            translationAvailable: false,
        }));
        expect(unavailable.tone).toBe('warn');
        expect(unavailable.warnings).toHaveLength(1);
        expect(unavailable.warnings[0].severity).toBe('warn');
        expect(new Set(Object.values(unavailable.warnings[0].tokens || {}).map((t) => t?.field)).has('translateFiles')).toBe(true);
        renderModel(unavailable);

        const available = buildVectorsFilesSummary(makeFilesState({
            translateFiles: true,
            translationAvailable: true,
        }));
        expect(available.tone).toBe('active');
        expect(available.warnings).toEqual([]);
    });

    test('missing {{text}} in fileTemplateDb emits danger warning linking fileTemplateDb', () => {
        const model = buildVectorsFilesSummary(makeFilesState({
            fileTemplateDb: 'Related info without macro',
        }));
        expect(model.tone).toBe('danger');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('danger');
        expect(new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field)).has('fileTemplateDb')).toBe(true);
        expect(renderModel(model).warningTexts[0].text).toContain('{{text}}');
    });

    test('filePositionDb !== 1 dims fileDepthDb and fileDepthRoleDb; === 1 activates and renders depth & role tokens', () => {
        for (const pos of [0, 2]) {
            const nonChat = buildVectorsFilesSummary(makeFilesState({
                filePositionDb: pos,
                fileDepthDb: 6,
                fileDepthRoleDb: 1,
            }));
            expect(new Set(nonChat.dormantFields)).toEqual(new Set(['fileDepthDb', 'fileDepthRoleDb']));
            expect(tokenFieldKeys(nonChat)).not.toContain('fileDepthDb');
            expect(tokenFieldKeys(nonChat)).not.toContain('fileDepthRoleDb');
            renderModel(nonChat);
        }

        const inChat = buildVectorsFilesSummary(makeFilesState({
            filePositionDb: 1,
            fileDepthDb: 6,
            fileDepthRoleDb: 2,
        }));
        expect(inChat.dormantFields).toEqual([]);
        const rendered = renderModel(inChat);
        expect(rendered.fullText).toContain('6');
        expect(tokenFieldKeys(inChat)).toContain('fileDepthDb');
        expect(tokenFieldKeys(inChat)).toContain('fileDepthRoleDb');
    });
});

describe('buildVectorsChatsSummary', () => {
    test('disabled state sets dormant tone and dims all chat controls', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            enabledChats: false,
            summarize: true,
        }));
        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'keepHidden',
            'template',
            'position',
            'depth',
            'messageChunkSize',
            'protect',
            'insert',
            'summarize',
            'summarizeSent',
            'summarySource',
            'summaryPrompt',
            'summaryRetries',
            'summaryThreshold',
        ]));
    });

    test('summarizeSent without summarize emits warn linking both fields and dims all summary sub-controls', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            summarize: false,
            summarizeSent: true,
            position: 0,
        }));
        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('summarizeSent')).toBe(true);
        expect(warnFields.has('summarize')).toBe(true);
        renderModel(model);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'summarizeSent',
            'summarySource',
            'summaryPrompt',
            'summaryRetries',
            'summaryThreshold',
            'depth',
        ]));
    });

    test('missing {{text}} in template emits danger warning linking template', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            template: 'No macro here',
        }));
        expect(model.tone).toBe('danger');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('danger');
        expect(new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field)).has('template')).toBe(true);
        expect(renderModel(model).warningTexts[0].text).toContain('{{text}}');
    });

    test('summarize with whitespace-only summaryPrompt emits danger warning linking summaryPrompt', () => {
        const model = buildVectorsChatsSummary(makeChatsState({
            summarize: true,
            summaryPrompt: '   \n\t ',
        }));
        expect(model.tone).toBe('danger');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('danger');
        expect(new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field)).has('summaryPrompt')).toBe(true);
        renderModel(model);
    });

    test('position !== 1 dims depth; position === 1 renders depth and distinguishes chunk/hidden/source modes', () => {
        const chunkedHiddenOff = buildVectorsChatsSummary(makeChatsState({
            position: 0,
            depth: 3,
            summarize: true,
            summarySource: 'main',
            summaryThreshold: 200,
            summaryRetries: 4,
            summarizeSent: false,
            messageChunkSize: 400,
            keepHidden: false,
        }));
        const inPrompt = buildVectorsChatsSummary(makeChatsState({
            position: 0,
            depth: 3,
            summarize: true,
            summarySource: 'webllm',
            summaryThreshold: 0,
            summaryRetries: 4,
            summarizeSent: true,
            messageChunkSize: 0,
            keepHidden: true,
        }));
        expect(inPrompt.tone).toBe('active');
        expect(inPrompt.dormantFields).toEqual(['depth']);
        const promptText = renderModel(inPrompt).fullText;
        expect(promptText).toContain('4');
        expect(promptText).not.toBe(renderModel(chunkedHiddenOff).fullText);

        const inChat = buildVectorsChatsSummary(makeChatsState({
            position: 1,
            depth: 7,
            summarize: true,
        }));
        expect(inChat.dormantFields).toEqual([]);
        expect(renderModel(inChat).fullText).toContain('7');
        expect(tokenFieldKeys(inChat)).toContain('depth');
    });
});
