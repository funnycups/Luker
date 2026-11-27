/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import { buildRegexBehaviorSummary } from '../../public/scripts/extensions/regex/behavior-summary-model.js';

function makeState(overrides = {}) {
    return {
        disabled: false,
        placements: [1],
        pluginRequest: false,
        pluginReply: false,
        minDepthRaw: '',
        maxDepthRaw: '',
        runOnEdit: false,
        substituteRegex: 0,
        markdownOnly: true,
        promptOnly: false,
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

describe('buildRegexBehaviorSummary (all 11 runtime rules)', () => {
    test('Rule 1: disabled: true sets dormant tone and binds disabled field', () => {
        const model = buildRegexBehaviorSummary(makeState({
            disabled: true,
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            runOnEdit: true,
            minDepthRaw: '5',
            maxDepthRaw: '2',
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(tokenFieldKeys(model)).toContain('disabled');
    });

    test('Rule 2: empty placements + !pluginReply emits danger warning linking placements (and pluginRequest when active)', () => {
        const displayModel = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: true,
            pluginRequest: false,
            pluginReply: false,
        }));
        expect(displayModel.tone).toBe('danger');
        expect(displayModel.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(tokenFieldKeys(displayModel)).toContain('placements');
        renderModel(displayModel);

        const pluginReqModel = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            pluginReply: false,
        }));
        expect(pluginReqModel.tone).toBe('danger');
        expect(pluginReqModel.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const warnFields = new Set(pluginReqModel.warnings.flatMap((w) => Object.values(w.tokens || {}).map((t) => t?.field)));
        expect(warnFields.has('pluginRequest')).toBe(true);
        expect(warnFields.has('placements')).toBe(true);
        renderModel(pluginReqModel);
    });

    test('Rule 3: permanent mutation mode emits danger warning, dims minDepth/maxDepth, and keeps runOnEdit active', () => {
        const model = buildRegexBehaviorSummary(makeState({
            placements: [1, 2],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: false,
            runOnEdit: true,
            minDepthRaw: '1',
            maxDepthRaw: '4',
        }));

        expect(model.tone).toBe('danger');
        expect(model.warnings.some((w) => w.severity === 'danger')).toBe(true);
        expect(model.dormantFields).toContain('minDepth');
        expect(model.dormantFields).toContain('maxDepth');
        expect(model.dormantFields).not.toContain('runOnEdit');
        renderModel(model);

        const keys = tokenFieldKeys(model);
        expect(keys).toContain('markdownOnly');
        expect(keys).toContain('promptOnly');
        expect(keys).toContain('pluginRequest');
        expect(keys).toContain('pluginReply');
        expect(keys).toContain('runOnEdit');
    });

    test('Rule 4: pluginRequest: true alone is active non-destructive mode without permanent warning', () => {
        const model = buildRegexBehaviorSummary(makeState({
            placements: [1, 2],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            pluginReply: false,
            runOnEdit: false,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(['runOnEdit']);
        expect(tokenFieldKeys(model)).toContain('pluginRequest');
        renderModel(model);
    });

    test('Rule 5: WORLD_INFO (5) without promptOnly and without pluginRequest emits warn; valid with either', () => {
        const warnModel = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: true,
            promptOnly: false,
            pluginRequest: false,
            runOnEdit: false,
        }));
        expect(warnModel.tone).toBe('warn');
        expect(warnModel.warnings).toHaveLength(1);
        expect(warnModel.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(warnModel.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('promptOnly')).toBe(true);
        expect(warnFields.has('pluginRequest')).toBe(true);
        renderModel(warnModel);

        const promptOk = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: false,
            promptOnly: true,
            pluginRequest: false,
            runOnEdit: false,
        }));
        expect(promptOk.tone).toBe('active');
        expect(promptOk.warnings).toEqual([]);

        const pluginReqOk = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(pluginReqOk.tone).toBe('active');
        expect(pluginReqOk.warnings).toEqual([]);
    });

    test('Rule 6: SLASH_COMMAND (3) with only promptOnly and/or pluginRequest emits warn; valid with markdownOnly', () => {
        for (const flags of [
            { markdownOnly: false, promptOnly: true, pluginRequest: false },
            { markdownOnly: false, promptOnly: false, pluginRequest: true },
            { markdownOnly: false, promptOnly: true, pluginRequest: true },
        ]) {
            const warnModel = buildRegexBehaviorSummary(makeState({
                placements: [3],
                ...flags,
                runOnEdit: false,
            }));
            expect(warnModel.tone).toBe('warn');
            expect(warnModel.warnings.some((w) => w.severity === 'warn')).toBe(true);
            renderModel(warnModel);
        }

        const displayOk = buildRegexBehaviorSummary(makeState({
            placements: [3],
            markdownOnly: true,
            promptOnly: false,
            pluginRequest: false,
            runOnEdit: false,
        }));
        expect(displayOk.tone).toBe('active');
        expect(displayOk.warnings).toEqual([]);
    });

    test('Rule 7: REASONING (6) with only pluginRequest emits warn; valid with markdownOnly or promptOnly', () => {
        const warnModel = buildRegexBehaviorSummary(makeState({
            placements: [6],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(warnModel.tone).toBe('warn');
        expect(warnModel.warnings.some((w) => w.severity === 'warn')).toBe(true);
        renderModel(warnModel);

        const displayOk = buildRegexBehaviorSummary(makeState({
            placements: [6],
            markdownOnly: true,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(displayOk.tone).toBe('active');
        expect(displayOk.warnings).toEqual([]);

        const promptOk = buildRegexBehaviorSummary(makeState({
            placements: [6],
            promptOnly: true,
            pluginRequest: true,
            runOnEdit: false,
        }));
        expect(promptOk.tone).toBe('active');
        expect(promptOk.warnings).toEqual([]);
    });

    test('Rule 8: runOnEdit: true while any scoped lane is active (or only WORLD_INFO checked) emits warn and dims runOnEdit', () => {
        for (const lane of [
            { markdownOnly: true, placements: [1] },
            { promptOnly: true, placements: [1] },
            { pluginRequest: true, placements: [1] },
            { pluginReply: true, placements: [] },
        ]) {
            const model = buildRegexBehaviorSummary(makeState({
                markdownOnly: false,
                promptOnly: false,
                pluginRequest: false,
                pluginReply: false,
                runOnEdit: true,
                ...lane,
            }));
            expect(model.tone).toBe('warn');
            expect(model.dormantFields).toContain('runOnEdit');
            expect(model.warnings.some((w) => w.severity === 'warn')).toBe(true);
            const warnFields = new Set(model.warnings.flatMap((w) => Object.values(w.tokens || {}).map((t) => t?.field)));
            expect(warnFields.has('runOnEdit')).toBe(true);
            renderModel(model);
        }

        const worldInfoOnlyPerm = buildRegexBehaviorSummary(makeState({
            placements: [5],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: false,
            runOnEdit: true,
        }));
        expect(worldInfoOnlyPerm.dormantFields).toContain('runOnEdit');
        expect(worldInfoOnlyPerm.warnings.some((w) => w.severity === 'warn')).toBe(true);
        renderModel(worldInfoOnlyPerm);
    });

    test('Rule 9: minDepth > maxDepth emits danger; equal and negative/blank depths are valid and distinct', () => {
        const inverted = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '5',
            maxDepthRaw: '2',
        }));
        expect(inverted.tone).toBe('danger');
        expect(inverted.warnings.some((w) => w.severity === 'danger')).toBe(true);
        const invRendered = renderModel(inverted);
        expect(invRendered.warningTexts.some((w) => w.severity === 'danger' && w.text.includes('5') && w.text.includes('2'))).toBe(true);

        const equal = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '2',
            maxDepthRaw: '2',
        }));
        expect(equal.tone).toBe('active');
        expect(equal.warnings).toEqual([]);
        const eqRendered = renderModel(equal);
        expect(eqRendered.fullText).toContain('2');

        const positiveMin = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '0',
            maxDepthRaw: '3',
        }));
        const contDefault = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '',
            maxDepthRaw: '',
        }));
        expect(contDefault.tone).toBe('active');
        expect(renderModel(contDefault).fullText).not.toBe(renderModel(positiveMin).fullText);

        const contMinusOne = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: true,
            minDepthRaw: '-1',
            maxDepthRaw: '3',
        }));
        expect(contMinusOne.tone).toBe('active');
        expect(renderModel(contMinusOne).fullText).not.toBe(renderModel(positiveMin).fullText);
    });

    test('Rule 10: pluginReply only with placements or depth set emits warn and dims placements/minDepth/maxDepth/runOnEdit', () => {
        const withPlacement = buildRegexBehaviorSummary(makeState({
            placements: [1],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: true,
            runOnEdit: false,
        }));
        expect(withPlacement.tone).toBe('warn');
        expect(withPlacement.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(new Set(withPlacement.dormantFields)).toEqual(new Set(['placements', 'minDepth', 'maxDepth', 'runOnEdit']));
        const warnFields = new Set(withPlacement.warnings.flatMap((w) => Object.values(w.tokens || {}).map((t) => t?.field)));
        expect(warnFields.has('pluginReply')).toBe(true);
        renderModel(withPlacement);

        const withDepth = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: true,
            minDepthRaw: '1',
            maxDepthRaw: '3',
            runOnEdit: false,
        }));
        expect(withDepth.tone).toBe('warn');
        expect(withDepth.warnings.some((w) => w.severity === 'warn')).toBe(true);
        expect(new Set(withDepth.dormantFields)).toEqual(new Set(['placements', 'minDepth', 'maxDepth', 'runOnEdit']));

        const cleanReplyOnly = buildRegexBehaviorSummary(makeState({
            placements: [],
            markdownOnly: false,
            promptOnly: false,
            pluginRequest: false,
            pluginReply: true,
            minDepthRaw: '',
            maxDepthRaw: '',
            runOnEdit: false,
        }));
        expect(cleanReplyOnly.tone).toBe('active');
        expect(cleanReplyOnly.warnings).toEqual([]);
        expect(new Set(cleanReplyOnly.dormantFields)).toEqual(new Set(['placements', 'minDepth', 'maxDepth', 'runOnEdit']));
        renderModel(cleanReplyOnly);
    });

    test('Rule 11: transient "-" or "" depth inputs parse cleanly without NaN', () => {
        for (const [minDepthRaw, maxDepthRaw] of [
            ['-', ''],
            ['', '-'],
            ['-', '-'],
            ['-', '2'],
            ['2', '-'],
            ['   ', ''],
            [null, undefined],
        ]) {
            const model = buildRegexBehaviorSummary(makeState({
                placements: [1],
                markdownOnly: true,
                minDepthRaw,
                maxDepthRaw,
            }));
            expect(model.tone).toBe('active');
            expect(model.warnings).toEqual([]);
            const rendered = renderModel(model);
            expect(rendered.fullText).not.toContain('NaN');
            expect(rendered.fullText).not.toContain('undefined');
        }
    });

    test('forwards (text, key) through custom translate callback', () => {
        const seenKeys = [];
        const model = buildRegexBehaviorSummary(makeState({
            placements: [1, 2],
            markdownOnly: true,
            promptOnly: true,
            translate: (text, key) => {
                seenKeys.push(key || text);
                return `[T:${key || text}]`;
            },
        }));
        expect(seenKeys.length).toBeGreaterThan(0);
        expect(model.rows[0].role).toMatch(/^\[T:/);
        expect(model.rows[0].tokens.placements.text).toMatch(/^\[T:/);
        renderModel(model);
    });
});
