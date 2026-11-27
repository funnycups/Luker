/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildTtsNarrationSummary,
    buildTtsNpcAttributionSummary,
} from '../../public/scripts/extensions/tts/behavior-summary-models.js';

function makeNarrationState(overrides = {}) {
    return {
        enabled: true,
        provider: 'ElevenLabs',
        autoGeneration: true,
        narrateUser: false,
        periodicAutoGeneration: false,
        narrateByParagraphs: false,
        narrateQuoted: false,
        narrateDialogues: false,
        narrateTranslatedOnly: false,
        skipCodeblocks: false,
        skipTags: false,
        passAsterisks: false,
        multiVoiceEnabled: false,
        applyRegex: false,
        playbackRate: 1,
        ...overrides,
    };
}

function makeNpcState(overrides = {}) {
    return {
        enabled: true,
        npcAttributionEnabled: true,
        apiPreset: '',
        preset: '',
        retryMax: 2,
        multiVoiceEnabled: true,
        canActivateMultiVoice: false,
        canActivateEnabled: false,
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

describe('buildTtsNarrationSummary', () => {
    test('!enabled sets dormant tone, clears warnings, and dims narration controls below #tts_enabled', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            enabled: false,
            passAsterisks: true,
            narrateDialogues: true,
            multiVoiceEnabled: true,
            narrateQuoted: true,
            autoGeneration: false,
            narrateUser: true,
            periodicAutoGeneration: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'narrateUser',
            'autoGeneration',
            'periodicAutoGeneration',
            'narrateByParagraphs',
            'narrateQuoted',
            'narrateDialogues',
            'narrateTranslatedOnly',
            'skipCodeblocks',
            'skipTags',
            'passAsterisks',
            'multiVoiceEnabled',
            'applyRegex',
            'regexPattern',
            'playbackRate',
        ]));
        expect(model.dormantFields).not.toContain('provider');
        expect(model.dormantFields).not.toContain('enabled');

        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set(['enabled']));
    });

    test('enabled with clean defaults renders 2 rows, provider, playback rate, and all active field bindings', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            enabled: true,
            provider: 'ElevenLabs',
            playbackRate: 1.25,
            autoGeneration: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.rowTexts).toHaveLength(2);
        expect(rendered.fullText).toContain('ElevenLabs');
        expect(rendered.fullText).toContain('1.25×');
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'autoGeneration',
            'narrateUser',
            'provider',
            'playbackRate',
            'periodicAutoGeneration',
            'narrateByParagraphs',
            'narrateTranslatedOnly',
            'skipCodeblocks',
            'skipTags',
            'passAsterisks',
            'narrateDialogues',
            'applyRegex',
            'narrateQuoted',
            'multiVoiceEnabled',
        ]));
    });

    test('passAsterisks && narrateDialogues emits warn linking both fields and puts narrateDialogues in dormantFields', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            passAsterisks: true,
            narrateDialogues: true,
        }));

        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toContain('narrateDialogues');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('passAsterisks')).toBe(true);
        expect(warnFields.has('narrateDialogues')).toBe(true);
        renderModel(model);
    });

    test('passAsterisks without narrateDialogues keeps narrateDialogues in dormantFields without warning', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            passAsterisks: true,
            narrateDialogues: false,
            multiVoiceEnabled: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual(['narrateDialogues']);
        renderModel(model);
    });

    test('multiVoiceEnabled && !passAsterisks emits warn linking multiVoiceEnabled and passAsterisks', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            multiVoiceEnabled: true,
            passAsterisks: false,
        }));

        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('passAsterisks')).toBe(true);
        expect(warnFields.has('multiVoiceEnabled')).toBe(true);
        renderModel(model);
    });

    test('multiVoiceEnabled && narrateQuoted emits warn linking multiVoiceEnabled and narrateQuoted', () => {
        const model = buildTtsNarrationSummary(makeNarrationState({
            multiVoiceEnabled: true,
            passAsterisks: true,
            narrateQuoted: true,
        }));

        expect(model.tone).toBe('warn');
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const warnFields = new Set(Object.values(model.warnings[0].tokens || {}).map((t) => t?.field));
        expect(warnFields.has('narrateQuoted')).toBe(true);
        expect(warnFields.has('multiVoiceEnabled')).toBe(true);
        renderModel(model);
    });

    test('periodicAutoGeneration && !autoGeneration and narrateUser && !autoGeneration emit warn and dim both fields', () => {
        const autoOn = buildTtsNarrationSummary(makeNarrationState({ autoGeneration: true }));
        const bothOff = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: false,
            narrateUser: false,
        }));
        expect(bothOff.tone).toBe('active');
        expect(bothOff.warnings).toEqual([]);
        expect(new Set(bothOff.dormantFields)).toEqual(new Set(['narrateUser', 'periodicAutoGeneration']));
        expect(renderModel(bothOff).rowTexts[0].text).not.toBe(renderModel(autoOn).rowTexts[0].text);

        const periodicWarn = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: true,
            narrateUser: false,
        }));
        expect(periodicWarn.tone).toBe('warn');
        expect(periodicWarn.warnings).toHaveLength(1);
        expect(periodicWarn.warnings[0].severity).toBe('warn');
        expect(new Set(periodicWarn.dormantFields)).toEqual(new Set(['narrateUser', 'periodicAutoGeneration']));
        expect(new Set(Object.values(periodicWarn.warnings[0].tokens || {}).map((t) => t?.field)).has('periodicAutoGeneration')).toBe(true);
        renderModel(periodicWarn);

        const userWarn = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: false,
            narrateUser: true,
        }));
        expect(userWarn.tone).toBe('warn');
        expect(userWarn.warnings).toHaveLength(1);
        expect(userWarn.warnings[0].severity).toBe('warn');
        expect(new Set(userWarn.dormantFields)).toEqual(new Set(['narrateUser', 'periodicAutoGeneration']));
        expect(new Set(Object.values(userWarn.warnings[0].tokens || {}).map((t) => t?.field)).has('narrateUser')).toBe(true);
        renderModel(userWarn);

        const bothWarn = buildTtsNarrationSummary(makeNarrationState({
            autoGeneration: false,
            periodicAutoGeneration: true,
            narrateUser: true,
        }));
        expect(bothWarn.tone).toBe('warn');
        expect(bothWarn.warnings).toHaveLength(2);
    });

    test('provider === "System" omits playbackRate token and speed text', () => {
        for (const autoGeneration of [true, false]) {
            const model = buildTtsNarrationSummary(makeNarrationState({
                provider: 'System',
                playbackRate: 1.75,
                autoGeneration,
            }));
            expect(tokenFieldKeys(model)).not.toContain('playbackRate');
            const rendered = renderModel(model);
            expect(rendered.fullText).toContain('System');
            expect(rendered.fullText).not.toContain('1.75');
            expect(rendered.fullText).not.toContain('×');
        }
    });

    test('transient blank playbackRate and hostile provider name render safely', () => {
        const blankRate = buildTtsNarrationSummary(makeNarrationState({
            playbackRate: '',
            provider: 'Edge',
        }));
        expect(renderModel(blankRate).fullText).toContain('1×');

        const hostile = '<img src=x onerror=1>${enabled}';
        const hostileModel = buildTtsNarrationSummary(makeNarrationState({ provider: hostile }));
        const parts = renderTemplateParts(hostileModel.rows[0].template, hostileModel.rows[0].tokens);
        const providerBtn = parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'provider');
        expect(providerBtn).toBeTruthy();
        expect(providerBtn.children.length).toBe(0);
        expect(providerBtn.textContent).toBe(hostile);
    });
});

describe('buildTtsNpcAttributionSummary', () => {
    test('!npcAttributionEnabled sets dormant tone and dims apiPreset, preset, and retryMax', () => {
        const model = buildTtsNpcAttributionSummary(makeNpcState({
            npcAttributionEnabled: false,
            multiVoiceEnabled: false,
            enabled: false,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['apiPreset', 'preset', 'retryMax']));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set(['npcAttributionEnabled']));
    });

    test('npcAttributionEnabled && multiVoiceEnabled renders active config with fallback tokens and retry count', () => {
        const model = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: true,
            apiPreset: '',
            preset: '',
            retryMax: 3,
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(model.dormantFields).toEqual([]);
        const rendered = renderModel(model);
        expect(model.rows[0].tokens.apiPreset.text.length).toBeGreaterThan(0);
        expect(model.rows[0].tokens.preset.text.length).toBeGreaterThan(0);
        expect(rendered.fullText).toContain('3');
    });

    test('npcAttributionEnabled && !multiVoiceEnabled emits warn and toggles read-only vs interactive cross-scope token', () => {
        const absent = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: false,
            canActivateMultiVoice: false,
        }));

        expect(absent.tone).toBe('warn');
        expect(absent.warnings).toHaveLength(1);
        expect(absent.warnings[0].severity).toBe('warn');
        const rendered = renderModel(absent);
        const absentTok = rendered.warningTexts[0].parts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(absentTok.tagName).toBe('SPAN');
        expect(absentTok.classList.contains('is-readonly')).toBe(true);

        const onActivate = jest.fn(() => true);
        const present = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: false,
            canActivateMultiVoice: true,
            onMultiVoiceActivate: onActivate,
        }));
        const presentParts = renderTemplateParts(present.warnings[0].template, present.warnings[0].tokens);
        const presentBtn = presentParts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(presentBtn.tagName).toBe('BUTTON');
        expect(presentBtn.dataset.bsumFields).toBe('multiVoiceEnabled');
    });

    test('npcAttributionEnabled && !enabled reflects dormant status and reacts to enabled + blank retryMax', () => {
        const activeReady = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: true,
            npcAttributionEnabled: true,
            multiVoiceEnabled: true,
            apiPreset: 'FastConn',
            preset: 'CleanPreset',
            retryMax: '',
        }));
        const pausedReady = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: false,
            npcAttributionEnabled: true,
            multiVoiceEnabled: true,
            apiPreset: 'FastConn',
            preset: 'CleanPreset',
            retryMax: '',
            canActivateEnabled: true,
        }));
        expect(pausedReady.tone).toBe('dormant');
        expect(pausedReady.warnings).toEqual([]);
        const rendered = renderModel(pausedReady);
        expect(rendered.fullText).toContain('FastConn');
        expect(rendered.fullText).toContain('CleanPreset');
        expect(rendered.fullText).toContain('2');
        expect(rendered.fullText).not.toBe(renderModel(activeReady).fullText);
        const enabledBtn = rendered.rowTexts[0].parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'enabled');
        expect(enabledBtn.tagName).toBe('BUTTON');

        const pausedNoMv = buildTtsNpcAttributionSummary(makeNpcState({
            enabled: false,
            npcAttributionEnabled: true,
            multiVoiceEnabled: false,
        }));
        expect(pausedNoMv.tone).toBe('warn');
        expect(pausedNoMv.warnings).toHaveLength(1);
    });
});
