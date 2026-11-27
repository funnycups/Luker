/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import { registerWorkbenchLocaleData } from '../../public/scripts/workbench/locale-data.js';
import { createSettingsPage } from '../../public/scripts/workbench/pages/settings.js';
import {
    buildWorkbenchAiSummary,
    buildWorkbenchQaSummary,
} from '../../public/scripts/workbench/model/behavior-summary-models.js';

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

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

function findTokenByField(model, fieldKey) {
    for (const row of model?.rows || []) {
        for (const tok of Object.values(row.tokens || {})) {
            if (tok?.field === fieldKey || (Array.isArray(tok?.field) && tok.field.includes(fieldKey))) {
                return tok;
            }
        }
    }
    return null;
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

function installLocale(locale) {
    const tables = {};
    registerWorkbenchLocaleData((loc, data) => {
        tables[loc] = { ...(tables[loc] || {}), ...data };
    });
    globalThis.Luker = {
        getContext: () => ({
            getCurrentLocale: () => locale,
            translate: (text) => (locale === 'en' ? text : (tables[locale]?.[text] ?? text)),
        }),
    };
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
    installLocale('en');
});

afterEach(() => {
    delete globalThis.Luker;
});

describe('buildWorkbenchAiSummary', () => {
    test('distinguishes reviewChanges modes, explicit vs fallback selections, and override counts structurally', () => {
        const previewModel = buildWorkbenchAiSummary({
            sharedConnection: 'OpenAI Main',
            sharedPreset: 'plugin-only',
            reviewChanges: true,
            targetOverrideCount: 0,
        });
        expect(previewModel.tone).toBe('active');
        expect(previewModel.warnings || []).toEqual([]);
        const previewRendered = renderModel(previewModel);
        expect(previewRendered.fullText).toContain('OpenAI Main');
        expect(previewRendered.fullText).toContain('plugin-only');
        expect(tokenFieldKeys(previewModel)).toEqual(new Set([
            'sharedConnection',
            'sharedPreset',
            'targetOverrides',
            'reviewChanges',
        ]));

        const directModel = buildWorkbenchAiSummary({
            sharedConnection: '',
            sharedPreset: '',
            reviewChanges: false,
            targetOverrideCount: 2,
        });
        expect(directModel.tone).toBe('active');
        const directRendered = renderModel(directModel);
        expect(directRendered.fullText).toContain('2');
        expect(directRendered.fullText).not.toContain('OpenAI Main');
        expect(directRendered.fullText).not.toBe(previewRendered.fullText);
        expect(findTokenByField(directModel, 'reviewChanges')?.text).not.toBe(findTokenByField(previewModel, 'reviewChanges')?.text);
    });

    test('renders cleanly in zh-cn and zh-tw with matching placeholders and translated output', () => {
        const enModel = buildWorkbenchAiSummary({
            sharedConnection: 'ConnA',
            sharedPreset: 'PresetA',
            reviewChanges: true,
            targetOverrideCount: 0,
        });
        const enText = renderModel(enModel).fullText;

        for (const loc of ['zh-cn', 'zh-tw']) {
            installLocale(loc);
            const m0 = buildWorkbenchAiSummary({
                sharedConnection: 'ConnA',
                sharedPreset: 'PresetA',
                reviewChanges: true,
                targetOverrideCount: 0,
            });
            const r0 = renderModel(m0);
            expect(r0.fullText).toContain('ConnA');
            expect(r0.fullText).toContain('PresetA');
            expect(r0.fullText).not.toBe(enText);

            const m1 = buildWorkbenchAiSummary({
                sharedConnection: '',
                sharedPreset: '',
                reviewChanges: false,
                targetOverrideCount: 1,
            });
            const r1 = renderModel(m1);
            expect(r1.fullText).toContain('1');
            expect(r1.fullText).not.toBe(r0.fullText);
        }
    });
});

describe('buildWorkbenchQaSummary', () => {
    const ALL_SOURCES = ['Request inspector', 'Frontend logs', 'Server logs', 'Current content', 'Installed extensions'];

    test('renders active summary when sources are enabled and redact is true', () => {
        const model = buildWorkbenchQaSummary({
            enabledSources: ['Request inspector', 'Current content'],
            allSources: ALL_SOURCES,
            floors: 2,
            previewBeforeSend: false,
            redact: true,
        });
        expect(model.tone).toBe('active');
        expect(model.warnings || []).toEqual([]);
        expect(model.dormantFields || []).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('Request inspector, Current content');
        expect(rendered.fullText).toContain('2');
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'qaSources',
            'qaFloors',
            'qaRedact',
            'qaPreviewBeforeSend',
        ]));

        const allFloorsModel = buildWorkbenchQaSummary({
            enabledSources: ALL_SOURCES,
            allSources: ALL_SOURCES,
            floors: 'all',
            previewBeforeSend: true,
            redact: true,
        });
        const allRendered = renderModel(allFloorsModel);
        expect(allRendered.fullText).not.toBe(rendered.fullText);
        expect(findTokenByField(allFloorsModel, 'qaFloors')?.text).not.toBe(findTokenByField(model, 'qaFloors')?.text);
        expect(findTokenByField(allFloorsModel, 'qaPreviewBeforeSend')?.text).not.toBe(findTokenByField(model, 'qaPreviewBeforeSend')?.text);
    });

    test('warns with severity warn when redact === false', () => {
        const model = buildWorkbenchQaSummary({
            enabledSources: ALL_SOURCES,
            allSources: ALL_SOURCES,
            floors: 0,
            previewBeforeSend: false,
            redact: false,
        });
        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].text.length).toBeGreaterThan(0);
        expect(tokenFieldKeys(model).has('qaRedact')).toBe(true);
    });

    test('warns with severity warn and marks qaFloors dormant when enabledSources is empty', () => {
        const model = buildWorkbenchQaSummary({
            enabledSources: [],
            allSources: ALL_SOURCES,
            floors: 5,
            previewBeforeSend: true,
            redact: true,
        });
        expect(model.tone).toBe('warn');
        expect(model.dormantFields || []).toContain('qaFloors');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const rendered = renderModel(model);
        expect(rendered.warningTexts[0].text.length).toBeGreaterThan(0);
        expect(tokenFieldKeys(model).has('qaSources')).toBe(true);
    });

    test('emits both warnings when redact === false and enabledSources is empty', () => {
        const model = buildWorkbenchQaSummary({
            enabledSources: [],
            allSources: ALL_SOURCES,
            floors: 2,
            previewBeforeSend: false,
            redact: false,
        });
        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(2);
        expect(model.warnings.every(w => w.severity === 'warn')).toBe(true);
        renderModel(model);
    });

    test('renders cleanly in zh-cn and zh-tw', () => {
        const enActive = renderModel(buildWorkbenchQaSummary({
            enabledSources: ['请求检查器', '当前内容'],
            allSources: ALL_SOURCES,
            floors: 2,
            previewBeforeSend: true,
            redact: true,
        })).fullText;

        for (const loc of ['zh-cn', 'zh-tw']) {
            installLocale(loc);
            const active = buildWorkbenchQaSummary({
                enabledSources: ['请求检查器', '当前内容'],
                allSources: ALL_SOURCES,
                floors: 2,
                previewBeforeSend: true,
                redact: true,
            });
            const rActive = renderModel(active);
            expect(rActive.fullText).toContain('请求检查器');
            expect(rActive.fullText).toContain('当前内容');
            expect(rActive.fullText).not.toBe(enActive);

            const warned = buildWorkbenchQaSummary({
                enabledSources: [],
                allSources: ALL_SOURCES,
                floors: 'all',
                previewBeforeSend: false,
                redact: false,
            });
            const rWarned = renderModel(warned);
            expect(rWarned.warningTexts).toHaveLength(2);
            expect(rWarned.warningTexts.every(w => w.text.length > 0)).toBe(true);
        }
    });
});

describe('workbench settings page behavioral summary wiring', () => {
    function makeApp(initialSettings) {
        let settings = JSON.parse(JSON.stringify(initialSettings));
        const app = {
            settings: () => settings,
            saveSettings: jest.fn((next) => { settings = next; }),
            toast: jest.fn(),
            iterateTargets: () => [
                { id: 'memory', label: 'Memory graph config', tone: 'memory' },
                { id: 'preset', label: 'Preset', tone: 'preset' },
            ],
            suggestRuleProviders: () => [],
            source: {
                listAiChoices: jest.fn(async () => ({
                    connections: ['ConnA', 'ConnB'],
                    presets: ['plugin-only', 'PresetA'],
                    native: {},
                    hasPluginOnly: true,
                    errors: {},
                })),
                promptInfo: jest.fn(async () => ({ from: 'Built-in', custom: false, text: 'prompt' })),
            },
        };
        return { app, getSettings: () => settings };
    }

    test('mounts AI and Q&A summary cards, removes redundant static AI intro, and updates live on control changes', async () => {
        const { app, getSettings } = makeApp({
            ai: { default: { connection: '', preset: '' } },
            reviewChanges: true,
            ask: {
                sources: { inspector: true, frontLogs: true, serverLogs: true, content: true, plugins: true },
                floors: 2,
                previewBeforeSend: false,
                redact: true,
            },
            rules: {},
            dismissed: {},
        });

        const page = createSettingsPage(app);
        document.body.appendChild(page.el);
        page.show();
        await flushMicrotasks();

        const aiCard = page.el.querySelector('[data-bsum-id="wb-ai-settings"]');
        const qaCard = page.el.querySelector('[data-bsum-id="wb-qa-settings"]');
        expect(aiCard).toBeTruthy();
        expect(qaCard).toBeTruthy();

        const initialAiText = aiCard.textContent;
        expect(initialAiText).toContain('plugin-only');

        // Changing shared connection select updates AI summary live
        const connSelect = page.el.querySelector('[data-field-key="sharedConnection"] select');
        expect(connSelect).toBeTruthy();
        connSelect.value = 'ConnA';
        connSelect.dispatchEvent(new Event('change'));
        expect(aiCard.textContent).toContain('ConnA');

        // Toggling reviewChanges checkbox updates AI summary live without losing focus
        const reviewCheck = page.el.querySelector('[data-field-key="reviewChanges"]');
        expect(reviewCheck).toBeTruthy();
        const beforeReviewToggle = aiCard.textContent;
        reviewCheck.focus();
        reviewCheck.click();
        expect(document.activeElement).toBe(reviewCheck);
        expect(aiCard.textContent).not.toBe(beforeReviewToggle);
        expect(getSettings().reviewChanges).toBe(false);

        // Clicking targetOverrides token opens the targets <details> block
        const targetsDetails = page.el.querySelector('details[data-field-key="targetOverrides"]');
        expect(targetsDetails.open).toBe(false);
        const overrideTok = aiCard.querySelector('button[data-bsum-fields="targetOverrides"]');
        overrideTok.click();
        expect(targetsDetails.open).toBe(true);

        // Changing a per-target override updates targetOverrideCount in AI summary
        const targetSelect = targetsDetails.querySelector('tbody select');
        const beforeOverrideText = aiCard.textContent;
        targetSelect.value = 'ConnB';
        targetSelect.dispatchEvent(new Event('change'));
        expect(aiCard.textContent).not.toBe(beforeOverrideText);
        expect(aiCard.textContent).toContain('1');

        // Toggling redact off triggers warning inside Q&A summary card
        const redactCheck = page.el.querySelector('[data-field-key="qaRedact"]');
        expect(redactCheck).toBeTruthy();
        redactCheck.click();
        expect(qaCard.classList.contains('is-warn')).toBe(true);
        expect(qaCard.querySelector('.luker-bsum-warnings').hidden).toBe(false);
        expect(qaCard.querySelectorAll('.luker-bsum-warn')).toHaveLength(1);

        // Turning off all 5 Q&A sources triggers no-source warning and marks qaFloors dormant
        const sourceChecks = Array.from(page.el.querySelectorAll('[data-field-key="qaSources"] [role="checkbox"]'));
        expect(sourceChecks).toHaveLength(5);
        for (const cb of sourceChecks) cb.click();
        expect(qaCard.querySelectorAll('.luker-bsum-warn')).toHaveLength(2);
        expect(page.el.querySelector('[data-field-key="qaFloors"]').classList.contains('luker-bsum-field-dormant')).toBe(true);

        // Changing floors select updates Q&A summary live
        const floorsSelect = page.el.querySelector('[data-field-key="qaFloors"] select');
        const beforeFloorsText = qaCard.textContent;
        floorsSelect.value = 'all';
        floorsSelect.dispatchEvent(new Event('change'));
        expect(qaCard.textContent).not.toBe(beforeFloorsText);

        page.destroy();
        page.el.remove();
    });
});
