/**
 * @jest-environment jsdom
 */
import './_mocks/luker-zh.js';
import { describe, test, expect } from '@jest/globals';
import { renderTemplateParts } from '../../../public/scripts/lens-shared/behavior-summary.js';
import { createSchemaView } from '../../../public/scripts/extensions/memory-graph/lens/schema/schema-view.js';
import {
    buildMgMasterNoticeModel,
    buildMgExtractionSectionModel,
    buildMgCustomCadenceModalModel,
    buildMgExtractionModeModel,
    buildMgRecallSectionModel,
    buildMgTechnicalSectionModel,
    buildMgSchemaTypeModel,
    buildMgManualCompressionModalModel,
} from '../../../public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js';

function renderModelText(model) {
    expect(model).toBeTruthy();
    const rowTexts = (model.rows || []).map((row) => {
        const parts = renderTemplateParts(row.template, row.tokens);
        return {
            role: row.role,
            text: parts.map(p => p.textContent).join(''),
            parts,
        };
    });
    const warningTexts = (model.warnings || []).map((warn) => {
        const parts = renderTemplateParts(warn.template, warn.tokens);
        return {
            severity: warn.severity,
            tone: warn.tone,
            text: parts.map(p => p.textContent).join(''),
            parts,
        };
    });
    return {
        rowTexts,
        warningTexts,
        fullText: [...rowTexts.map(r => `${r.role}: ${r.text}`), ...warningTexts.map(w => w.text)].join('\n'),
        allParts: [...rowTexts.flatMap(r => r.parts), ...warningTexts.flatMap(w => w.parts)],
    };
}

function tokenFieldKeys(model) {
    const keys = new Set();
    for (const row of model?.rows || []) {
        for (const tok of Object.values(row.tokens || {})) {
            if (Array.isArray(tok?.field)) tok.field.forEach(k => keys.add(k));
            else if (tok?.field) keys.add(tok.field);
        }
    }
    for (const warn of model?.warnings || []) {
        for (const tok of Object.values(warn.tokens || {})) {
            if (Array.isArray(tok?.field)) tok.field.forEach(k => keys.add(k));
            else if (tok?.field) keys.add(tok.field);
        }
    }
    return keys;
}

const BASE_OPTIONS = {
    connections: ['MainAPI'],
    presets: ['DefaultPreset'],
    embeddingProfiles: [{ id: 'emb-1', name: 'Embed 1' }],
    rerankProfiles: [{ id: 'rr-1', name: 'Rerank 1' }],
    positions: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
    roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
};

describe('buildMgMasterNoticeModel', () => {
    test('returns dormant model when enabled is false and null when enabled is true', () => {
        expect(buildMgMasterNoticeModel({ enabled: true })).toBeNull();

        const off = buildMgMasterNoticeModel({ enabled: false });
        expect(off.tone).toBe('dormant');
        const rendered = renderModelText(off);
        expect(rendered.fullText).not.toContain('NaN');
        expect(tokenFieldKeys(off).has('enabled')).toBe(true);
    });
});

describe('buildMgExtractionSectionModel & buildMgCustomCadenceModalModel', () => {
    const baseValues = {
        autoExtractionEnabled: true,
        autoCompressionEnabled: true,
        extractApiPresetName: 'MainAPI',
        extractPresetName: 'DefaultPreset',
    };
    const baseAdvanced = {
        updateEvery: 2,
        extractBatchTurns: 2,
        extractContextTurns: 2,
        extractExcludeRecentTurns: 0,
        extractIncludeWorldInfo: true,
        llmVisibleRecentMessages: 5,
    };

    test('active 2/2/5 separates memory update (raw context unaffected by floor hiding) and main model (5 messages)', () => {
        const section = buildMgExtractionSectionModel({
            values: baseValues,
            advanced: { ...baseAdvanced, extractExcludeRecentTurns: 1 },
            options: BASE_OPTIONS,
        });
        expect(section.tone).toBe('active');
        expect(section.rows).toHaveLength(2);
        const rendered = renderModelText(section);
        expect(rendered.rowTexts[0].text).toContain('2');
        expect(rendered.rowTexts[0].text).toContain('1');
        expect(rendered.rowTexts[0].text).toMatch(/楼层隐藏|floor hiding|原文/);
        expect(rendered.rowTexts[1].text).toContain('5');
        expect(rendered.fullText).not.toContain('NaN');

        const keys = tokenFieldKeys(section);
        for (const expectedKey of [
            'autoExtractionEnabled',
            'autoCompressionEnabled',
            'extractApiPresetName',
            'extractPresetName',
            'extractIncludeWorldInfo',
            'updateEvery',
            'extractBatchTurns',
            'extractContextTurns',
            'extractExcludeRecentTurns',
            'llmVisibleRecentMessages',
        ]) {
            expect(keys.has(expectedKey)).toBe(true);
        }

        const modal = buildMgCustomCadenceModalModel({
            draft: { ...baseAdvanced, extractExcludeRecentTurns: 1 },
            autoExtractionEnabled: true,
        });
        expect(modal.tone).toBe('active');
        expect(modal.rows).toHaveLength(2);
        const modalKeys = tokenFieldKeys(modal);
        expect(modalKeys).toEqual(new Set([
            'updateEvery',
            'extractBatchTurns',
            'extractContextTurns',
            'extractExcludeRecentTurns',
            'llmVisibleRecentMessages',
        ]));
    });

    test('llmVisibleRecentMessages: 0 reports full raw chat history', () => {
        const model = buildMgExtractionSectionModel({
            values: baseValues,
            advanced: { ...baseAdvanced, llmVisibleRecentMessages: 0 },
            options: BASE_OPTIONS,
        });
        const rendered = renderModelText(model);
        expect(rendered.rowTexts[1].text).toContain('0');
        expect(rendered.rowTexts[1].text).toMatch(/全部|all/i);
        expect(model.warnings).toEqual([]);
    });

    test('llmVisibleRecentMessages: 1 with updateEvery: 2 emits amber gap warning', () => {
        const model = buildMgExtractionSectionModel({
            values: baseValues,
            advanced: { ...baseAdvanced, updateEvery: 2, llmVisibleRecentMessages: 1 },
            options: BASE_OPTIONS,
        });
        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const rendered = renderModelText(model);
        expect(rendered.warningTexts[0].text).toContain('3');
        const warnKeys = new Set();
        for (const tok of Object.values(model.warnings[0].tokens || {})) {
            if (tok?.field) warnKeys.add(tok.field);
        }
        expect(warnKeys.has('llmVisibleRecentMessages')).toBe(true);
        expect(warnKeys.has('updateEvery')).toBe(true);

        const modal = buildMgCustomCadenceModalModel({
            draft: { ...baseAdvanced, updateEvery: 2, extractExcludeRecentTurns: 1, llmVisibleRecentMessages: 1 },
            autoExtractionEnabled: true,
        });
        expect(modal.tone).toBe('warn');
        expect(modal.warnings).toHaveLength(1);
        expect(modal.warnings[0].severity).toBe('warn');
    });

    test('autoExtractionEnabled: false dims extraction fields in both section and custom modal', () => {
        const section = buildMgExtractionSectionModel({
            values: { ...baseValues, autoExtractionEnabled: false },
            advanced: baseAdvanced,
            options: BASE_OPTIONS,
        });
        expect(section.dormantFields).toEqual(expect.arrayContaining([
            'extractApiPresetName',
            'extractPresetName',
            'extractIncludeWorldInfo',
        ]));
        expect(section.dormantFields).not.toContain('llmVisibleRecentMessages');

        const modal = buildMgCustomCadenceModalModel({
            draft: baseAdvanced,
            autoExtractionEnabled: false,
        });
        expect(modal.dormantFields).toEqual(expect.arrayContaining([
            'updateEvery',
            'extractBatchTurns',
            'extractContextTurns',
            'extractExcludeRecentTurns',
        ]));
        expect(modal.dormantFields).not.toContain('llmVisibleRecentMessages');
        renderModelText(section);
        renderModelText(modal);
    });

    test('Review Focus #2: transient blank or non-numeric draft inputs never produce NaN', () => {
        const modal = buildMgCustomCadenceModalModel({
            draft: {
                updateEvery: '',
                extractBatchTurns: '',
                extractContextTurns: 'abc',
                extractExcludeRecentTurns: '',
                llmVisibleRecentMessages: '',
            },
            autoExtractionEnabled: true,
        });
        const rendered = renderModelText(modal);
        expect(rendered.fullText).not.toContain('NaN');

        const section = buildMgExtractionSectionModel({
            values: baseValues,
            advanced: {
                updateEvery: '',
                extractBatchTurns: undefined,
                extractContextTurns: null,
                extractExcludeRecentTurns: '-',
                llmVisibleRecentMessages: '',
            },
            options: BASE_OPTIONS,
        });
        expect(renderModelText(section).fullText).not.toContain('NaN');
    });
});

describe('buildMgExtractionModeModel', () => {
    test('describes oneshot mode cleanly', () => {
        const model = buildMgExtractionModeModel({
            advanced: { extractMode: 'oneshot' },
        });
        expect(model.tone).toBe('active');
        const rendered = renderModelText(model);
        expect(rendered.fullText).toMatch(/全图|One-shot/i);
        expect(tokenFieldKeys(model).has('extractMode')).toBe(true);
    });

    test('describes crawl mode with candidateLimit 0 (unlimited) vs 40 + 2*12 = 64 slice cap', () => {
        const unlimited = buildMgExtractionModeModel({
            advanced: { extractMode: 'crawl', extractCrawlMaxRounds: 3, extractCrawlCandidateLimit: 0, extractCrawlMaxReads: 12 },
        });
        const unlimitedRendered = renderModelText(unlimited);
        expect(unlimitedRendered.fullText).toMatch(/不限|unlimited/i);
        expect(tokenFieldKeys(unlimited)).toEqual(new Set([
            'extractMode',
            'extractCrawlMaxRounds',
            'extractCrawlCandidateLimit',
            'extractCrawlMaxReads',
        ]));

        const capped = buildMgExtractionModeModel({
            advanced: { extractMode: 'crawl', extractCrawlMaxRounds: 3, extractCrawlCandidateLimit: 40, extractCrawlMaxReads: 12 },
        });
        const cappedRendered = renderModelText(capped);
        expect(cappedRendered.fullText).toContain('40');
        expect(cappedRendered.fullText).toContain('12');
        expect(cappedRendered.fullText).toContain('64');
        const sliceCapReadonly = cappedRendered.allParts.find(
            el => el.tagName === 'SPAN' && el.classList.contains('is-readonly') && el.textContent === '64',
        );
        expect(sliceCapReadonly).toBeTruthy();
    });
});

describe('buildMgRecallSectionModel', () => {
    const baseValues = {
        recallEnabled: true,
        recallMethod: 'llm',
        recallApiPresetName: 'MainAPI',
        recallPresetName: 'DefaultPreset',
        embeddingProfileId: 'emb-1',
        rerankProfileId: 'rr-1',
        ragUseRerank: false,
        ragUseQueryRewrite: false,
        vectorTopK: 20,
        hybridMaxResults: 15,
        ragDefaultPerTypeK: 3,
        recallInjectPosition: 6,
        recallInjectDepth: 4,
        recallInjectRole: 0,
    };

    test('!recallEnabled dims method/model/RAG fields while NEVER dimming recallInjectPosition, recallInjectDepth, or recallInjectRole', () => {
        const model = buildMgRecallSectionModel({
            values: { ...baseValues, recallEnabled: false, recallMethod: 'rag', ragUseRerank: true, ragUseQueryRewrite: true },
            advanced: { persistentInjectionMaxSeqDistance: 10, recallIncludeWorldInfo: true },
            options: BASE_OPTIONS,
        });
        expect(model.dormantFields).toEqual(expect.arrayContaining([
            'recallMethod',
            'embeddingProfileId',
            'vectorTopK',
            'hybridMaxResults',
            'ragDefaultPerTypeK',
            'ragUseRerank',
            'rerankProfileId',
            'ragUseQueryRewrite',
            'ragRewriteApiPresetName',
            'ragRewriteLlmPresetName',
            'recallApiPresetName',
            'recallPresetName',
            'recallIncludeWorldInfo',
        ]));
        expect(model.dormantFields).not.toContain('recallInjectPosition');
        expect(model.dormantFields).not.toContain('recallInjectDepth');
        expect(model.dormantFields).not.toContain('recallInjectRole');
        expect(model.dormantFields).not.toContain('persistentInjectionMaxSeqDistance');

        const rendered = renderModelText(model);
        expect(rendered.rowTexts[0].text).toContain('10');
        expect(rendered.rowTexts[2].text).toContain('4');
    });

    test('RAG with empty embeddingProfileId emits severity: danger warning', () => {
        const model = buildMgRecallSectionModel({
            values: { ...baseValues, recallMethod: 'rag', embeddingProfileId: '' },
            advanced: { persistentInjectionMaxSeqDistance: 0 },
            options: BASE_OPTIONS,
        });
        expect(model.tone).toBe('danger');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('danger');
        renderModelText(model);
    });

    test('RAG with ragUseRerank and empty rerankProfileId emits severity: warn warning', () => {
        const model = buildMgRecallSectionModel({
            values: { ...baseValues, recallMethod: 'rag', embeddingProfileId: 'emb-1', ragUseRerank: true, rerankProfileId: '' },
            advanced: { persistentInjectionMaxSeqDistance: 0 },
            options: BASE_OPTIONS,
        });
        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        renderModelText(model);
    });

    test('renders LLM recall branch and non-atDepth placement cleanly', () => {
        const model = buildMgRecallSectionModel({
            values: { ...baseValues, recallMethod: 'llm', recallInjectPosition: 1 },
            advanced: { persistentInjectionMaxSeqDistance: 0, recallIncludeWorldInfo: false },
            options: BASE_OPTIONS,
        });
        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        const keys = tokenFieldKeys(model);
        expect(keys.has('recallInjectPosition')).toBe(true);
        expect(keys.has('recallInjectDepth')).toBe(false);
        expect(keys.has('recallInjectRole')).toBe(false);
        renderModelText(model);
    });
});

describe('buildMgTechnicalSectionModel', () => {
    test('covers concurrency, retries, rpmLimit, recallQueryMessages, and omits recallMaxIterations in RAG mode', () => {
        const llmModel = buildMgTechnicalSectionModel({
            values: { recallMethod: 'llm' },
            advanced: {
                extractConcurrent: true,
                toolCallRetryMax: 3,
                rpmLimit: 0,
                recallQueryMessages: 4,
                recallMaxIterations: 5,
            },
        });
        expect(llmModel.tone).toBe('active');
        expect(tokenFieldKeys(llmModel)).toEqual(new Set([
            'extractConcurrent',
            'toolCallRetryMax',
            'rpmLimit',
            'recallQueryMessages',
            'recallMaxIterations',
        ]));
        renderModelText(llmModel);

        const ragModel = buildMgTechnicalSectionModel({
            values: { recallMethod: 'rag' },
            advanced: {
                extractConcurrent: false,
                toolCallRetryMax: 2,
                rpmLimit: 30,
                recallQueryMessages: 2,
                recallMaxIterations: 3,
            },
        });
        expect(tokenFieldKeys(ragModel).has('recallMaxIterations')).toBe(false);
        expect(renderModelText(ragModel).fullText).toContain('30');
    });
});

describe('buildMgSchemaTypeModel', () => {
    test('tableName: event_table reports hardcoded persistent injection even when alwaysInject is false', () => {
        const model = buildMgSchemaTypeModel({
            draft: {
                id: 'event',
                name: 'Event',
                alwaysInject: false,
                latestOnly: true,
                compression: true,
                columns: [{ key: 'summary', label: 'Summary' }],
                raw: {
                    tableName: 'event_table',
                    forceUpdate: true,
                    editable: false,
                    extractEveryN: 1,
                    ragPerTypeK: 0,
                    compression: { threshold: 5, fanIn: 3, maxDepth: 10, keepRecentLeaves: 3 },
                },
            },
            globalSettings: {
                autoCompressionEnabled: true,
                persistentInjectionMaxSeqDistance: 50,
                recallMethod: 'rag',
                ragDefaultPerTypeK: 3,
            },
        });
        const rendered = renderModelText(model);
        expect(rendered.rowTexts[0].text).toContain('event_table');
        expect(rendered.rowTexts[0].text).toContain('50');
        // id === 'event' reports append-only (ignoring latestOnly) and dims primaryKeyColumns
        expect(model.dormantFields).toContain('primaryKeyColumns');
        expect(rendered.rowTexts[1].text).not.toContain('NaN');
        // Global settings tokens are non-interactive readonly spans (field: null)
        const horizonSpan = rendered.allParts.find(
            el => el.tagName === 'SPAN' && el.classList.contains('is-readonly') && el.textContent.includes('50'),
        );
        expect(horizonSpan).toBeTruthy();
    });

    test('compression: false puts compression fields in dormantFields and global autoCompressionEnabled: false renders readonly span', () => {
        const disabledComp = buildMgSchemaTypeModel({
            draft: {
                id: 'character_sheet',
                name: 'Character Sheet',
                alwaysInject: false,
                latestOnly: false,
                compression: false,
                columns: [{ key: 'title', label: 'Name' }],
                raw: {
                    tableName: 'character_table',
                    forceUpdate: false,
                    editable: true,
                    extractEveryN: 2,
                    ragPerTypeK: 0,
                    compression: { threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 0 },
                },
            },
            globalSettings: {
                autoCompressionEnabled: true,
                persistentInjectionMaxSeqDistance: 0,
                recallMethod: 'rag',
                ragDefaultPerTypeK: 3,
            },
        });
        expect(disabledComp.dormantFields).toEqual(expect.arrayContaining([
            'threshold',
            'fanIn',
            'maxDepth',
            'keepRecentLeaves',
            'rule',
            'summarizeInstruction',
            'primaryKeyColumns',
        ]));
        renderModelText(disabledComp);

        const pausedAutoComp = buildMgSchemaTypeModel({
            draft: {
                id: 'location_state',
                name: 'Location',
                alwaysInject: true,
                latestOnly: true,
                compression: true,
                columns: [{ key: 'title', label: 'Name' }],
                raw: {
                    tableName: 'location_table',
                    forceUpdate: false,
                    editable: true,
                    extractEveryN: 2,
                    ragPerTypeK: 4,
                    primaryKeyColumns: ['title'],
                    compression: { threshold: 4, fanIn: 2, maxDepth: 3, keepRecentLeaves: 1 },
                },
            },
            globalSettings: {
                autoCompressionEnabled: false,
                persistentInjectionMaxSeqDistance: 0,
                recallMethod: 'llm',
                ragDefaultPerTypeK: 0,
            },
        });
        const renderedPaused = renderModelText(pausedAutoComp);
        const globalOffSpan = renderedPaused.allParts.find(
            el => el.tagName === 'SPAN' && el.classList.contains('is-readonly'),
        );
        expect(globalOffSpan).toBeTruthy();
        expect(pausedAutoComp.dormantFields).not.toContain('threshold');
    });
});

describe('schema-view live behavioral summary DOM integration', () => {
    test('mounts 1E summary card, updates live on flag/input changes without losing focus, and dims dormant compression fields', async () => {
        document.body.innerHTML = '';
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
        globalThis.cancelAnimationFrame = () => {};

        const app = {
            root: document.createElement('div'),
            model: () => ({ typeCounts: new Map([['event', 3], ['character_sheet', 2]]) }),
            isCompact: () => false,
            reload: () => {},
            showToast: () => {},
        };
        const schemaTypes = [
            {
                id: 'event',
                label: 'Event',
                tableName: 'event_table',
                tableColumns: ['summary'],
                embeddingColumns: ['summary'],
                columnHints: { summary: 'Summary' },
                requiredColumns: ['summary'],
                alwaysInject: false,
                latestOnly: false,
                forceUpdate: true,
                editable: false,
                compression: { mode: 'hierarchical', threshold: 5, fanIn: 3, maxDepth: 10, keepRecentLeaves: 3 },
            },
            {
                id: 'character_sheet',
                label: 'Character Sheet',
                tableName: 'character_table',
                tableColumns: ['title', 'identity'],
                embeddingColumns: ['title'],
                columnHints: { title: 'Name', identity: 'Identity' },
                requiredColumns: ['title'],
                alwaysInject: false,
                latestOnly: true,
                primaryKeyColumns: ['title'],
                forceUpdate: false,
                editable: true,
                ragPerTypeK: 0,
                compression: { mode: 'none', threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 0 },
            },
        ];
        const source = {
            schema: {
                read: async () => ({
                    scope: 'global',
                    hasCharacter: false,
                    avatar: '',
                    characterName: '',
                    types: JSON.parse(JSON.stringify(schemaTypes)),
                    defaults: JSON.parse(JSON.stringify(schemaTypes)),
                    labels: {},
                    globalSettings: {
                        autoCompressionEnabled: false,
                        persistentInjectionMaxSeqDistance: 40,
                        recallMethod: 'rag',
                        ragDefaultPerTypeK: 3,
                    },
                }),
                write: async () => ({}),
                restore: async () => {},
            },
        };

        const view = createSchemaView(app, source);
        app.root.appendChild(view.el);
        document.body.appendChild(app.root);
        view.render();
        await new Promise(resolve => setTimeout(resolve, 0));

        // Event type renders event_table persistent injection even though alwaysInject is false, plus read-only global horizon
        const eventCard = view.el.querySelector('[data-bsum-id="mg-schema-type"]');
        expect(eventCard).toBeTruthy();
        expect(eventCard.textContent).toContain('event_table');
        expect(eventCard.textContent).toContain('40');
        expect(eventCard.querySelector('span.luker-bsum-tok.is-readonly')).toBeTruthy();

        // Switch to character_sheet (compression off -> threshold dimmed)
        view.el.querySelectorAll('.ml-schema-type')[1].click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(view.el.querySelector('[data-field-key="threshold"]').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Toggle compression ON -> threshold no longer dimmed, card turns warn because global autoCompressionEnabled is false
        view.el.querySelector('[data-field-key="compression"]').click();
        expect(view.el.querySelector('[data-field-key="threshold"]').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(view.el.querySelector('[data-bsum-id="mg-schema-type"]').classList.contains('is-warn')).toBe(true);

        // Typing into threshold updates summary card in place without losing focus
        const thresholdInput = view.el.querySelector('[data-field-key="threshold"] input');
        thresholdInput.focus();
        thresholdInput.value = '12';
        thresholdInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(thresholdInput);
        expect(view.el.querySelector('[data-bsum-id="mg-schema-type"]').textContent).toContain('12');

        view.destroy();
    });
});

describe('buildMgManualCompressionModalModel', () => {
    const eventType = {
        id: 'event',
        label: 'Event',
        displayLabel: '事件',
        threshold: 5,
        fanIn: 3,
        maxDepth: 10,
        keepRecentLeaves: 3,
    };
    const momentType = {
        id: 'moment',
        label: 'Moment',
        displayLabel: '重要时刻',
        threshold: 4,
        fanIn: 2,
        maxDepth: 4,
        keepRecentLeaves: 0,
    };

    test('renders 3 plain-language rows with read-only schema metrics for a single selected type and unlimited stop rule', () => {
        const model = buildMgManualCompressionModalModel({
            draft: {
                scope: 'older',
                excludeRecent: 2,
                mode: 'schema',
                roundLimitMode: 'unlimited',
                maxRoundsPerType: 3,
                selectedTypeIds: ['event'],
            },
            types: [eventType],
        });
        expect(model.tone).toBe('active');
        expect(model.rows).toHaveLength(3);
        expect(model.warnings).toEqual([]);

        const rendered = renderModelText(model);
        expect(rendered.fullText).toContain('事件');
        expect(rendered.fullText).toContain('2');
        expect(rendered.fullText).toContain('5');
        expect(rendered.fullText).toContain('3');
        expect(rendered.fullText).toContain('10');
        expect(rendered.fullText).not.toContain('NaN');

        const keys = tokenFieldKeys(model);
        expect(keys).toEqual(new Set(['selectedTypeIds', 'scope', 'excludeRecent', 'mode', 'roundLimitMode']));
    });

    test('covers all scope, force/flat modes, multi-type summary, limited rounds, and transient blank inputs', () => {
        const forceLimited = buildMgManualCompressionModalModel({
            draft: {
                scope: 'all',
                excludeRecent: '',
                mode: 'force',
                roundLimitMode: 'limited',
                maxRoundsPerType: 7,
                selectedTypeIds: ['event'],
            },
            types: [eventType],
        });
        const forceRendered = renderModelText(forceLimited);
        expect(forceRendered.fullText).toContain('7');
        expect(forceRendered.fullText).not.toContain('NaN');
        expect(tokenFieldKeys(forceLimited)).toEqual(new Set(['selectedTypeIds', 'scope', 'mode', 'roundLimitMode', 'maxRoundsPerType']));

        const flatMulti = buildMgManualCompressionModalModel({
            draft: {
                scope: 'older',
                excludeRecent: 0,
                mode: 'flat',
                roundLimitMode: 'limited',
                maxRoundsPerType: '',
                selectedTypeIds: ['event', 'moment'],
            },
            types: [eventType, momentType],
        });
        const flatRendered = renderModelText(flatMulti);
        expect(flatRendered.fullText).toContain('事件');
        expect(flatRendered.fullText).toContain('重要时刻');
        expect(flatRendered.fullText).not.toContain('NaN');
    });

    test('emits amber warning when no types are selected', () => {
        const empty = buildMgManualCompressionModalModel({
            draft: {
                scope: 'older',
                excludeRecent: 2,
                mode: 'schema',
                roundLimitMode: 'unlimited',
                maxRoundsPerType: 3,
                selectedTypeIds: [],
            },
            types: [eventType],
        });
        expect(empty.tone).toBe('warn');
        expect(empty.warnings).toHaveLength(1);
        expect(empty.warnings[0].severity).toBe('warn');
        const rendered = renderModelText(empty);
        expect(rendered.fullText).not.toContain('NaN');
    });
});
