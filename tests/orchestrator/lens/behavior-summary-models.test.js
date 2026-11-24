/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, jest } from '@jest/globals';
import { renderTemplateParts } from '../../../public/scripts/lens-shared/behavior-summary.js';
import { createDrafts } from '../../../public/scripts/extensions/orchestrator/lens/model/drafts.js';
import { createSettingsView } from '../../../public/scripts/extensions/orchestrator/lens/views/settings-view.js';
import { createSetupView } from '../../../public/scripts/extensions/orchestrator/lens/views/setup-view.js';
import {
    buildOrchDefaultModelSummary,
    buildOrchRuntimeLimitsSummary,
    buildOrchCrossModeLimitsSummary,
    buildOrchCapsuleSummary,
    buildOrchToolsSummary,
    buildOrchLorebookFilterSummary,
} from '../../../public/scripts/extensions/orchestrator/lens/model/behavior-summary-models.js';

function renderModel(model) {
    expect(model).toBeTruthy();
    const rowTexts = (model.rows || []).map((row) => {
        const parts = renderTemplateParts(row.template, row.tokens);
        return {
            role: row.role,
            tone: row.tone || '',
            text: parts.map(p => p.textContent).join(''),
            parts,
        };
    });
    const warningTexts = (model.warnings || []).map((warn) => {
        const parts = renderTemplateParts(warn.template, warn.tokens);
        return {
            severity: warn.severity || 'warn',
            text: parts.map(p => p.textContent).join(''),
            parts,
        };
    });
    const fullText = [
        ...rowTexts.map(r => `${r.role}: ${r.text}`),
        ...warningTexts.map(w => w.text),
    ].join('\n');
    expect(fullText).not.toContain('NaN');
    expect(fullText).not.toContain('undefined');
    return {
        rowTexts,
        warningTexts,
        fullText,
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

const BASE_VALUES = {
    llmNodeApiPresetName: 'MainAPI',
    llmNodePresetName: 'MainPreset',
    includeWorldInfoWithPreset: true,
    nodeIterationMaxRounds: 40,
    reviewRerunMaxRounds: 2,
    maxRecentMessages: 14,
    toolCallRetryMax: 2,
    rpmLimit: 0,
    capsuleInjectPosition: '6',
    capsuleInjectDepth: 0,
    capsuleInjectRole: '0',
    capsuleCustomInstruction: 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.',
};

describe('buildOrchDefaultModelSummary (2A)', () => {
    test('marks includeWorldInfoWithPreset active in spec/agenda/single and dormant in loop/director', () => {
        for (const mode of ['spec', 'agenda', 'single']) {
            const activeModel = buildOrchDefaultModelSummary({ mode, values: BASE_VALUES });
            expect(activeModel.dormantFields || []).not.toContain('includeWorldInfoWithPreset');
            const renderedOn = renderModel(activeModel);
            expect(renderedOn.fullText).toContain('MainAPI');
            expect(renderedOn.fullText).toContain('MainPreset');
            expect(tokenFieldKeys(activeModel).has('includeWorldInfoWithPreset')).toBe(true);

            const offModel = buildOrchDefaultModelSummary({
                mode,
                values: { ...BASE_VALUES, llmNodeApiPresetName: '', llmNodePresetName: '', includeWorldInfoWithPreset: false },
            });
            expect(offModel.dormantFields || []).not.toContain('includeWorldInfoWithPreset');
            renderModel(offModel);
        }

        for (const mode of ['loop', 'director']) {
            const model = buildOrchDefaultModelSummary({ mode, values: BASE_VALUES });
            expect(model.dormantFields || []).toContain('includeWorldInfoWithPreset');
            const rendered = renderModel(model);
            expect(rendered.rowTexts[1].tone).toBe('off');
            expect(tokenFieldKeys(model).has('includeWorldInfoWithPreset')).toBe(true);
        }
    });
});

describe('buildOrchRuntimeLimitsSummary (2B)', () => {
    test('covers all 5 modes accurately including director concurrency/discardOnAbort and agenda profile.limits', () => {
        // director
        const dirPreserve = buildOrchRuntimeLimitsSummary({
            mode: 'director',
            profile: { maxRounds: 25, maxConcurrentSubagents: 3, maxTotalSubagentRuns: 12, discardOnAbort: false },
            values: BASE_VALUES,
        });
        const dirPreserveText = renderModel(dirPreserve).fullText;
        expect(dirPreserveText).toContain('25');
        expect(dirPreserveText).toContain('3');
        expect(dirPreserveText).toContain('12');
        expect(tokenFieldKeys(dirPreserve)).toEqual(new Set(['maxRounds', 'maxConcurrentSubagents', 'maxTotalSubagentRuns', 'discardOnAbort']));

        const dirDiscard = buildOrchRuntimeLimitsSummary({
            mode: 'director',
            profile: { maxRounds: 25, maxConcurrentSubagents: 3, maxTotalSubagentRuns: 12, discardOnAbort: true },
            values: BASE_VALUES,
        });
        const dirDiscardText = renderModel(dirDiscard).fullText;
        expect(dirDiscardText).not.toBe(dirPreserveText);

        // agenda
        const agenda = buildOrchRuntimeLimitsSummary({
            mode: 'agenda',
            profile: { limits: { plannerMaxRounds: 8, maxConcurrentAgents: 5, maxTotalRuns: 30 } },
            values: BASE_VALUES,
        });
        const agendaText = renderModel(agenda).fullText;
        expect(agendaText).toContain('8');
        expect(agendaText).toContain('5');
        expect(agendaText).toContain('30');
        expect(tokenFieldKeys(agenda)).toEqual(new Set(['plannerMaxRounds', 'maxConcurrentAgents', 'maxTotalRuns']));

        // loop
        const loop = buildOrchRuntimeLimitsSummary({
            mode: 'loop',
            profile: { max_rounds: 18, wall_clock_budget_ms: 120000 },
            values: BASE_VALUES,
        });
        const loopText = renderModel(loop).fullText;
        expect(loopText).toContain('18');
        expect(loopText).toContain('120');
        expect(loopText).toContain('3');
        expect(tokenFieldKeys(loop)).toEqual(new Set(['max_rounds', 'wall_clock_budget_ms']));

        // spec
        const specActive = buildOrchRuntimeLimitsSummary({
            mode: 'spec',
            profile: {},
            values: { ...BASE_VALUES, nodeIterationMaxRounds: 35, reviewRerunMaxRounds: 4 },
        });
        const specActiveText = renderModel(specActive).fullText;
        expect(specActiveText).toContain('35');
        expect(specActiveText).toContain('4');
        expect(specActive.dormantFields || []).toEqual([]);

        const specZeroRerun = buildOrchRuntimeLimitsSummary({
            mode: 'spec',
            profile: {},
            values: { ...BASE_VALUES, nodeIterationMaxRounds: 35, reviewRerunMaxRounds: 0 },
        });
        const specZeroText = renderModel(specZeroRerun).fullText;
        expect(specZeroText).toContain('0');
        expect(specZeroText).not.toBe(specActiveText);

        // single
        const single = buildOrchRuntimeLimitsSummary({
            mode: 'single',
            profile: {},
            values: { ...BASE_VALUES, nodeIterationMaxRounds: 22, reviewRerunMaxRounds: 2 },
        });
        const singleText = renderModel(single).fullText;
        expect(singleText).toContain('22');
        expect(single.dormantFields || []).toContain('reviewRerunMaxRounds');
    });
});

describe('buildOrchCrossModeLimitsSummary (2C)', () => {
    test('marks maxRecentMessages dormant in loop/director and rpmLimit dormant in director', () => {
        for (const mode of ['spec', 'agenda', 'single']) {
            const m = buildOrchCrossModeLimitsSummary({ mode, values: { ...BASE_VALUES, rpmLimit: 12 } });
            expect(m.dormantFields || []).toEqual([]);
            const text = renderModel(m).fullText;
            expect(text).toContain('14');
            expect(text).toContain('2');
            expect(text).toContain('12');
        }

        const loop = buildOrchCrossModeLimitsSummary({ mode: 'loop', values: { ...BASE_VALUES, rpmLimit: 10 } });
        expect(loop.dormantFields || []).toEqual(['maxRecentMessages']);
        expect(renderModel(loop).fullText).toContain('10');

        const director = buildOrchCrossModeLimitsSummary({ mode: 'director', values: { ...BASE_VALUES, rpmLimit: 10 } });
        expect(new Set(director.dormantFields || [])).toEqual(new Set(['maxRecentMessages', 'rpmLimit']));
        renderModel(director);
    });
});

describe('buildOrchCapsuleSummary (2D)', () => {
    const positionLabels = {
        '0': '角色定义前',
        '6': '聊天深度',
    };
    const roleLabels = {
        '0': 'System',
        '1': 'User',
    };

    test('includes depth and role at atDepth and omits them for fixed positions', () => {
        const atDepthModel = buildOrchCapsuleSummary({
            values: {
                capsuleInjectPosition: '6',
                capsuleInjectDepth: 3,
                capsuleInjectRole: '1',
                capsuleCustomInstruction: 'Custom instruction here.',
            },
            positionLabels,
            roleLabels,
        });
        const atDepthText = renderModel(atDepthModel).fullText;
        expect(atDepthText).toContain('聊天深度');
        expect(atDepthText).toContain('3');
        expect(atDepthText).toContain('User');
        expect(tokenFieldKeys(atDepthModel)).toEqual(new Set([
            'capsuleInjectPosition',
            'capsuleInjectDepth',
            'capsuleInjectRole',
            'capsuleCustomInstruction',
        ]));

        const beforeModel = buildOrchCapsuleSummary({
            values: {
                capsuleInjectPosition: '0',
                capsuleInjectDepth: 3,
                capsuleInjectRole: '1',
                capsuleCustomInstruction: '',
            },
            positionLabels,
            roleLabels,
        });
        const beforeText = renderModel(beforeModel).fullText;
        expect(beforeText).toContain('角色定义前');
        expect(tokenFieldKeys(beforeModel)).toEqual(new Set([
            'capsuleInjectPosition',
            'capsuleCustomInstruction',
        ]));
    });
});

describe('buildOrchToolsSummary & buildOrchLorebookFilterSummary (2E)', () => {
    test('tools summary counts enabled defaults, renders override count as field: null span, and works across all 5 modes', () => {
        for (const mode of ['spec', 'agenda', 'director']) {
            const m = buildOrchToolsSummary({
                mode,
                defaultTools: { note: { open: true, close: false }, chat: { read_range: true, search: true } },
                agentOverrideCount: 1,
                totalAgents: 4,
            });
            const rendered = renderModel(m);
            const readonlySpans = rendered.allParts.filter(p => p.tagName === 'SPAN' && p.classList.contains('is-readonly'));
            expect(rendered.fullText).toContain('3');
            expect(rendered.fullText).toContain('1');
            expect(rendered.fullText).toContain('4');
            expect(readonlySpans.length).toBeGreaterThanOrEqual(1);
            expect(tokenFieldKeys(m).has('defaultTools')).toBe(true);
        }

        const loopModel = buildOrchToolsSummary({
            mode: 'loop',
            defaultTools: { note: { open: true }, chat: { search: true } },
        });
        expect(renderModel(loopModel).fullText).toContain('2');
        expect(tokenFieldKeys(loopModel).has('defaultTools')).toBe(true);

        const singleModel = buildOrchToolsSummary({ mode: 'single', defaultTools: null });
        expect(singleModel.tone).toBe('dormant');
        renderModel(singleModel);

        const specNull = buildOrchToolsSummary({
            mode: 'spec',
            defaultTools: null,
            agentOverrideCount: 0,
            totalAgents: 3,
        });
        const renderedNull = renderModel(specNull);
        expect(renderedNull.fullText).toContain('0');
        expect(renderedNull.fullText).toContain('3');
    });

    test('lorebook filter reports no-op when empty, OR behavior when set, 0-valid regex counts, and zero nested parentheses', () => {
        const maxParenDepth = (text) => {
            let depth = 0;
            let maxDepth = 0;
            for (const ch of String(text)) {
                if (ch === '(' || ch === '（') {
                    depth += 1;
                    if (depth > maxDepth) maxDepth = depth;
                } else if (ch === ')' || ch === '）') {
                    depth = Math.max(0, depth - 1);
                }
            }
            return maxDepth;
        };

        const empty = buildOrchLorebookFilterSummary({ bookPattern: '', entryPattern: '' });
        expect(empty.tone).toBe('dormant');
        renderModel(empty);

        const bookOnly = buildOrchLorebookFilterSummary({ bookPattern: '^private$', entryPattern: '' });
        expect(bookOnly.tone).toBe('active');
        const bookOnlyText = renderModel(bookOnly).fullText;
        expect(maxParenDepth(bookOnlyText)).toBeLessThanOrEqual(1);

        const entryOnly = buildOrchLorebookFilterSummary({ bookPattern: '', entryPattern: '^secret_' });
        expect(entryOnly.tone).toBe('active');
        const entryOnlyText = renderModel(entryOnly).fullText;
        expect(maxParenDepth(entryOnlyText)).toBeLessThanOrEqual(1);

        const both = buildOrchLorebookFilterSummary({ bookPattern: '^private$\n^tmp_', entryPattern: '^secret_' });
        expect(both.tone).toBe('active');
        const bothText = renderModel(both).fullText;
        expect(bothText).toContain('2');
        expect(bothText).toContain('1');

        const allInvalid = buildOrchLorebookFilterSummary({
            bookPattern: '[unclosed\n(bad',
            entryPattern: '[broken\n(also_bad',
        });
        expect(allInvalid.tone).toBe('warn');
        expect(allInvalid.warnings?.length).toBe(1);
        const allInvalidRendered = renderModel(allInvalid);
        const bookTok = allInvalidRendered.allParts.find((p) => p.dataset?.bsumFields === 'bookPattern');
        const entryTok = allInvalidRendered.allParts.find((p) => p.dataset?.bsumFields === 'entryPattern');
        expect(bookTok?.textContent).toContain('0');
        expect(bookTok?.textContent).not.toContain('2');
        expect(entryTok?.textContent).toContain('0');
        expect(entryTok?.textContent).not.toContain('2');

        const partialValid = buildOrchLorebookFilterSummary({
            bookPattern: '^valid$\n[invalid',
            entryPattern: '',
        });
        expect(partialValid.tone).toBe('warn');
        const partialBookTok = renderModel(partialValid).allParts.find((p) => p.dataset?.bsumFields === 'bookPattern');
        expect(partialBookTok?.textContent).toContain('1');
        expect(partialBookTok?.textContent).not.toContain('2');

        const bad = buildOrchLorebookFilterSummary({ bookPattern: '[unclosed', entryPattern: '' });
        expect(bad.tone).toBe('warn');
        expect(bad.warnings?.length).toBe(1);
        const badText = renderModel(bad).fullText;
        expect(maxParenDepth(badText)).toBeLessThanOrEqual(1);
    });
});

describe('settings-view & setup-view DOM wiring', () => {
    function makeSettingsApp({ mode = 'spec', enabled = false, profile = {} } = {}) {
        const settingsState = { ...BASE_VALUES };
        const profileState = structuredClone(profile);
        const setLimit = jest.fn(async (_target, patch) => {
            if (mode === 'agenda') {
                profileState.limits = { ...(profileState.limits || {}), ...patch };
            } else {
                Object.assign(profileState, patch);
            }
        });
        const app = {
            snapshot: () => ({
                enabled,
                mode,
                profile: profileState,
                target: { mode, scope: 'global', presetId: 'default' },
            }),
            modelOptions: () => ({ connections: ['MainAPI'], presets: ['MainPreset'] }),
            reloadModelOptions: jest.fn(async () => {}),
            reload: jest.fn(async () => {}),
            notify: jest.fn(),
            guard: async (fn) => { await fn(); },
            source: {
                settings: {
                    values: () => ({ ...settingsState }),
                    set: (key, val) => { settingsState[key] = val; },
                    setLimit,
                    promptDefaults: () => ({
                        capsuleCustomInstruction: BASE_VALUES.capsuleCustomInstruction,
                        request: 'req',
                        spec: 'spec',
                        loop: 'loop',
                        director: 'dir',
                        agenda: 'agenda',
                    }),
                },
                editLastResult: null,
            },
        };
        return { app, settingsState, profileState, setLimit };
    }

    function makeSetupApp({ mode = 'spec' } = {}) {
        const target = { mode, scope: 'global', presetId: 'default', avatar: '', chatKey: '' };
        const profile = mode === 'director'
            ? {
                mainAgent: { systemPrompt: 'main' },
                subAgents: [{ id: 'scout', description: 'd', systemPrompt: 's', tools: { chat: { search: true } } }],
                tools: { note: { open: true, close: false }, chat: { read_range: true, search: true } },
                lorebookFilter: { bookPattern: '', entryPattern: '' },
            }
            : mode === 'agenda'
                ? {
                    planner: { systemPrompt: 'p', userPromptTemplate: 'u' },
                    agents: { a1: { systemPrompt: 's', userPromptTemplate: 'u' } },
                    finalAgentId: 'a1',
                    defaultTools: null,
                    lorebookFilter: { bookPattern: '', entryPattern: '' },
                }
                : mode === 'loop'
                    ? {
                        system_prompt: 's',
                        tools: { note: { open: true }, finalize: true },
                        lorebookFilter: { bookPattern: '', entryPattern: '' },
                    }
                    : {
                        spec: {
                            stages: [{ id: 's1', mode: 'serial', nodes: ['distiller'] }],
                            defaultTools: null,
                            lorebookFilter: { bookPattern: '', entryPattern: '' },
                        },
                        presets: { distiller: { systemPrompt: 's', userPromptTemplate: 'u' } },
                    };
        const drafts = createDrafts();
        drafts.setBase(target, profile);
        const app = {
            drafts,
            snapshot: () => ({ target, profile, mode, presetName: 'Default', cardPinnedMode: '' }),
            canEdit: () => true,
            notify: jest.fn(),
            reload: jest.fn(async () => {}),
            promptText: jest.fn(async () => null),
            dialog: { ask: jest.fn(async () => '') },
            source: {
                presets: {
                    list: () => ({ character: [], global: [{ id: 'default', name: 'Default' }] }),
                    select: jest.fn(),
                    create: jest.fn(),
                    duplicate: jest.fn(),
                    rename: jest.fn(),
                    remove: jest.fn(),
                    exportActive: jest.fn(),
                    parseImport: jest.fn(),
                    importParsed: jest.fn(),
                    saveToGlobal: jest.fn(),
                    saveToCharacter: jest.fn(),
                    clearCharacter: jest.fn(),
                    pinMode: jest.fn(),
                    resetSingle: jest.fn(),
                    saveCustomTools: jest.fn(),
                },
                edit: {
                    allTools: (_m, on) => ({ note: { open: on, close: on }, chat: { read_range: on, search: on }, lorebook: { world_book_list: on, list: on, search: on, get: on } }),
                    baseTools: () => ({ chat: { read_range: false, search: false } }),
                    defaultMainPrompt: () => 'main',
                    convertFrom: () => null,
                },
                skills: { inventory: jest.fn(async () => []), mount: jest.fn() },
                customToolEditor: { registry: () => [], open: jest.fn(), bridge: jest.fn(), importDefaults: jest.fn(), defaults: () => [] },
            },
        };
        return { app };
    }

    test('settings-view mounts all expected cards, keeps them live when disabled, dims dormant fields, and updates on input without losing focus', () => {
        document.body.innerHTML = '';
        const { app } = makeSettingsApp({ mode: 'director', enabled: false, profile: { maxRounds: 30, maxConcurrentSubagents: 4, maxTotalSubagentRuns: 16, discardOnAbort: false } });
        const view = createSettingsView(app);
        document.body.appendChild(view.el);
        view.render();

        expect(view.el.querySelector('[data-bsum-id="orch-default-model"]')).toBeTruthy();
        expect(view.el.querySelector('[data-bsum-id="orch-runtime-limits"]')).toBeTruthy();
        expect(view.el.querySelector('[data-bsum-id="orch-cross-mode-limits"]')).toBeTruthy();
        expect(view.el.querySelector('[data-bsum-id="orch-capsule-injection"]')).toBeNull();

        // Remains active even when snapshot.enabled === false
        expect(view.el.querySelector('[data-bsum-id="orch-runtime-limits"]').classList.contains('is-active')).toBe(true);

        // Dormant fields dimmed in director mode
        expect(view.el.querySelector('[data-field-key="includeWorldInfoWithPreset"]').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(view.el.querySelector('[data-field-key="maxRecentMessages"]').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(view.el.querySelector('[data-field-key="rpmLimit"]').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Typing into maxRounds updates summary card without stealing focus
        const maxRoundsInput = view.el.querySelector('[data-field-key="maxRounds"] input');
        maxRoundsInput.focus();
        maxRoundsInput.value = '55';
        maxRoundsInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(maxRoundsInput);
        expect(view.el.querySelector('[data-bsum-id="orch-runtime-limits"]').textContent).toContain('55');

        view.destroy();
        view.el.remove();
    });

    test('settings-view mounts capsule summary in non-director mode and updates live on capsuleCustomInstruction input', () => {
        document.body.innerHTML = '';
        const { app } = makeSettingsApp({ mode: 'spec', enabled: true, profile: {} });
        const view = createSettingsView(app);
        document.body.appendChild(view.el);
        view.render();

        const capsuleCard = view.el.querySelector('[data-bsum-id="orch-capsule-injection"]');
        expect(capsuleCard).toBeTruthy();

        const textarea = view.el.querySelector('[data-field-key="capsuleCustomInstruction"] textarea');
        textarea.focus();
        textarea.value = '';
        textarea.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(textarea);
        expect(capsuleCard.textContent).not.toBe('');

        view.destroy();
        view.el.remove();
    });

    test('setup-view mounts tools & lorebook summaries, keeps override count read-only, and updates lorebook filter on input without losing focus', () => {
        document.body.innerHTML = '';
        const { app } = makeSetupApp({ mode: 'spec' });
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();

        const toolsCard = view.el.querySelector('[data-bsum-id="orch-default-tools"]');
        const loreCard = view.el.querySelector('[data-bsum-id="orch-lorebook-filter"]');
        expect(toolsCard).toBeTruthy();
        expect(loreCard).toBeTruthy();
        expect(loreCard.classList.contains('is-dormant')).toBe(true);
        expect(toolsCard.querySelector('span.luker-bsum-tok.is-readonly')).toBeTruthy();

        // Clicking tool checkbox updates toolsCard without replacing checkbox
        const firstCheck = view.el.querySelector('[data-field-key="defaultTools"] [role="checkbox"]');
        firstCheck.click();
        expect(toolsCard.textContent).toContain('1');

        // Typing into bookPattern updates loreCard without stealing focus
        const bookInput = view.el.querySelector('[data-field-key="bookPattern"] input');
        bookInput.focus();
        bookInput.value = '^private$';
        bookInput.dispatchEvent(new Event('input'));
        expect(document.activeElement).toBe(bookInput);
        expect(loreCard.classList.contains('is-active')).toBe(true);

        view.destroy();
        view.el.remove();
    });

    test('settings-view dims reviewRerunMaxRounds in single mode, handles agenda/loop limits, and focuses target on token click', () => {
        document.body.innerHTML = '';
        const { app: singleApp } = makeSettingsApp({ mode: 'single', enabled: true, profile: {} });
        const singleView = createSettingsView(singleApp);
        document.body.appendChild(singleView.el);
        singleView.render();

        expect(singleView.el.querySelector('[data-field-key="reviewRerunMaxRounds"]').classList.contains('luker-bsum-field-dormant')).toBe(true);
        const roundsTok = singleView.el.querySelector('[data-bsum-id="orch-runtime-limits"] button[data-bsum-fields="nodeIterationMaxRounds"]');
        expect(roundsTok).toBeTruthy();
        roundsTok.click();
        expect(document.activeElement).toBe(singleView.el.querySelector('[data-field-key="nodeIterationMaxRounds"] input'));
        singleView.destroy();
        singleView.el.remove();

        const { app: loopApp } = makeSettingsApp({ mode: 'loop', enabled: true, profile: { max_rounds: 20, wall_clock_budget_ms: 180000 } });
        const loopView = createSettingsView(loopApp);
        document.body.appendChild(loopView.el);
        loopView.render();
        expect(loopView.el.querySelector('[data-field-key="includeWorldInfoWithPreset"]').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(loopView.el.querySelector('[data-field-key="maxRecentMessages"]').classList.contains('luker-bsum-field-dormant')).toBe(true);
        expect(loopView.el.querySelector('[data-field-key="rpmLimit"]').classList.contains('luker-bsum-field-dormant')).toBe(false);
        expect(loopView.el.querySelector('[data-bsum-id="orch-runtime-limits"]').textContent).toContain('180');
        loopView.destroy();
        loopView.el.remove();
    });

    test('setup-view reports agent override counts in director mode and omits defaultTools card in loop/single modes', () => {
        document.body.innerHTML = '';
        const { app: dirApp } = makeSetupApp({ mode: 'director' });
        const dirView = createSetupView(dirApp);
        document.body.appendChild(dirView.el);
        dirView.render();

        const dirToolsCard = dirView.el.querySelector('[data-bsum-id="orch-default-tools"]');
        expect(dirToolsCard).toBeTruthy();
        expect(dirToolsCard.textContent).toContain('3');
        expect(dirToolsCard.textContent).toContain('1');
        expect(dirToolsCard.textContent).toContain('2');
        dirView.destroy();
        dirView.el.remove();

        const { app: loopApp } = makeSetupApp({ mode: 'loop' });
        const loopView = createSetupView(loopApp);
        document.body.appendChild(loopView.el);
        loopView.render();
        expect(loopView.el.querySelector('[data-bsum-id="orch-default-tools"]')).toBeNull();
        expect(loopView.el.querySelector('[data-bsum-id="orch-lorebook-filter"]')).toBeTruthy();
        loopView.destroy();
        loopView.el.remove();
    });
});
