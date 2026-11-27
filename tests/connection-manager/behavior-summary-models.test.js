/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';
import { renderTemplateParts } from '../../public/scripts/lens-shared/behavior-summary.js';
import {
    buildConnPlainTextFcSummary,
    buildConnReliabilitySummary,
    buildConnClaudeCacheSummary,
    buildConnGeminiCacheSummary,
} from '../../public/scripts/extensions/connection-manager/behavior-summary-models.js';

function makePlainTextFcState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        plainText: false,
        errorRetry: false,
        maxAttempts: 3,
        ...overrides,
    };
}

function makeReliabilityState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        rpmLimit: 0,
        maxRequestRetries: 0,
        retryStatusWhitelist: '',
        requestTimeout: 0,
        networkProxy: '',
        autoContinueOnTruncated: false,
        autoContinueMaxAttempts: 3,
        ...overrides,
    };
}

function makeClaudeCacheState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        source: 'claude',
        enableSystemPromptCache: false,
        extendedTtl: false,
        cachingAtDepth: -1,
        postProcessing: '',
        canActivatePostProcessing: false,
        ...overrides,
    };
}

function makeGeminiCacheState(overrides = {}) {
    return {
        hasProfile: true,
        profileMode: 'cc',
        enableSystemPromptCache: false,
        enableHistoryCache: false,
        keepRecentTurns: 2,
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

describe('buildConnPlainTextFcSummary', () => {
    test('non-cc profile (tc) sets dormant tone and dims all 3 plain-text FC fields', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: true,
            profileMode: 'tc',
            plainText: true,
            errorRetry: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['plainText', 'errorRetry', 'maxAttempts']));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
    });

    test('plainText false sets dormant tone and dims errorRetry and maxAttempts', () => {
        const tcModel = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: true,
            profileMode: 'tc',
        }));
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: true,
            profileMode: 'cc',
            plainText: false,
            errorRetry: true,
            maxAttempts: 4,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set(['errorRetry', 'maxAttempts']));
        const rendered = renderModel(model);
        expect(rendered.fullText).not.toBe(renderModel(tcModel).fullText);
    });

    test('plainText true with errorRetry false sets active tone and dims only maxAttempts', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            plainText: true,
            errorRetry: false,
            maxAttempts: 5,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual(['maxAttempts']);
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.rowTexts).toHaveLength(2);
        expect(rendered.rowTexts[1].tone).toBe('off');
        expect(tokenFieldKeys(model)).toEqual(new Set(['plainText', 'errorRetry']));
    });

    test('plainText true with errorRetry true renders active retries and leaves high attempts uncapped', () => {
        const model = buildConnPlainTextFcSummary(makePlainTextFcState({
            hasProfile: false,
            plainText: true,
            errorRetry: true,
            maxAttempts: 4,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual([]);
        expect(model.warnings).toEqual([]);
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('4');
        expect(tokenFieldKeys(model)).toEqual(new Set(['plainText', 'errorRetry', 'maxAttempts']));

        const fallbackModel = buildConnPlainTextFcSummary(makePlainTextFcState({
            plainText: true,
            errorRetry: true,
            maxAttempts: 'invalid',
        }));
        expect(renderModel(fallbackModel).fullText).toContain('3');

        const uncappedModel = buildConnPlainTextFcSummary(makePlainTextFcState({
            plainText: true,
            errorRetry: true,
            maxAttempts: 25,
        }));
        expect(uncappedModel.rows[1].tokens.maxAttempts.text).toBe('25');
    });
});

describe('buildConnReliabilitySummary', () => {
    test('no profile selected sets dormant tone and dims all reliability & auto-continue fields', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            hasProfile: false,
            profileMode: '',
            maxRequestRetries: 3,
            autoContinueOnTruncated: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.warnings).toEqual([]);
        expect(new Set(model.dormantFields)).toEqual(new Set([
            'rpmLimit',
            'maxRequestRetries',
            'retryStatusWhitelist',
            'requestTimeout',
            'networkProxy',
            'autoContinueOnTruncated',
            'autoContinueMaxAttempts',
        ]));
        const rendered = renderModel(model);
        expect(rendered.rowTexts[0].tone).toBe('off');
    });

    test('tc profile puts networkProxy in dormantFields and omits proxy URL', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            hasProfile: true,
            profileMode: 'tc',
            networkProxy: 'http://127.0.0.1:7890',
            maxRequestRetries: 2,
            autoContinueOnTruncated: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual(['networkProxy']);
        const rendered = renderModel(model);
        expect(rendered.fullText).not.toContain('127.0.0.1:7890');
    });

    test('maxRequestRetries === 0 puts retryStatusWhitelist in dormantFields', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            hasProfile: true,
            profileMode: 'cc',
            maxRequestRetries: 0,
            retryStatusWhitelist: '429, 500-504',
            autoContinueOnTruncated: true,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toContain('retryStatusWhitelist');
        expect(model.dormantFields).not.toContain('autoContinueMaxAttempts');
    });

    test('maxRequestRetries > 0 interpolates limits, proxy, custom whitelist, and auto-continue attempts', () => {
        const defaultWl = buildConnReliabilitySummary(makeReliabilityState({
            rpmLimit: 30,
            maxRequestRetries: 2,
            retryStatusWhitelist: '',
            requestTimeout: 1.5,
            networkProxy: 'socks5://127.0.0.1:1080',
            autoContinueOnTruncated: true,
            autoContinueMaxAttempts: 5,
        }));

        expect(defaultWl.tone).toBe('active');
        expect(defaultWl.dormantFields).toEqual([]);
        const defaultText = renderModel(defaultWl).fullText;
        expect(defaultText).toContain('30');
        expect(defaultText).toContain('2');
        expect(defaultText).toContain('1.5');
        expect(defaultText).toContain('socks5://127.0.0.1:1080');
        expect(defaultText).toContain('5');
        expect(tokenFieldKeys(defaultWl)).toEqual(new Set([
            'rpmLimit',
            'maxRequestRetries',
            'retryStatusWhitelist',
            'requestTimeout',
            'networkProxy',
            'autoContinueOnTruncated',
            'autoContinueMaxAttempts',
        ]));

        const customWl = buildConnReliabilitySummary(makeReliabilityState({
            maxRequestRetries: 3,
            retryStatusWhitelist: '429, 502-504',
        }));
        const customText = renderModel(customWl).fullText;
        expect(customText).toContain('429, 502-504');
    });

    test('autoContinueOnTruncated false dims autoContinueMaxAttempts', () => {
        const model = buildConnReliabilitySummary(makeReliabilityState({
            maxRequestRetries: 1,
            autoContinueOnTruncated: false,
            autoContinueMaxAttempts: 4,
        }));

        expect(model.dormantFields).toContain('autoContinueMaxAttempts');
        expect(renderModel(model).rowTexts[2].tone).toBe('off');
    });

    test('hostile networkProxy renders as literal textContent without child elements', () => {
        const hostile = '<img src=x onerror=1>${rpmLimit}';
        const model = buildConnReliabilitySummary(makeReliabilityState({
            networkProxy: hostile,
        }));
        const parts = renderTemplateParts(model.rows[1].template, model.rows[1].tokens);
        const proxyBtn = parts.find((p) => p instanceof Element && p.dataset?.bsumFields === 'networkProxy');
        expect(proxyBtn).toBeTruthy();
        expect(proxyBtn.children.length).toBe(0);
        expect(proxyBtn.textContent).toBe(hostile);
    });
});

describe('buildConnClaudeCacheSummary', () => {
    test('non-cc profile sets dormant tone and dims all 3 Claude cache fields', () => {
        const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
            hasProfile: true,
            profileMode: 'tc',
            enableSystemPromptCache: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(new Set(model.dormantFields)).toEqual(new Set(['enableSystemPromptCache', 'extendedTtl', 'cachingAtDepth']));
    });

    test('extendedTtl is in dormantFields when both system cache off and cachingAtDepth < 0', () => {
        const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
            enableSystemPromptCache: false,
            extendedTtl: true,
            cachingAtDepth: -1,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.dormantFields).toEqual(['extendedTtl']);
        expect(model.warnings).toEqual([]);
    });

    test('active via system cache or cachingAtDepth >= 0 clears dormantFields and formats TTL and multipliers', () => {
        const depthZero = buildConnClaudeCacheSummary(makeClaudeCacheState({
            enableSystemPromptCache: false,
            extendedTtl: false,
            cachingAtDepth: 0,
        }));
        expect(depthZero.tone).toBe('active');
        expect(depthZero.dormantFields).toEqual([]);
        const depthZeroText = renderModel(depthZero).fullText;
        expect(depthZeroText).toContain('0');
        expect(depthZeroText).toContain('5m');
        expect(depthZeroText).toContain('1.25x');
        expect(depthZeroText).toContain('0.1x');

        const both1h = buildConnClaudeCacheSummary(makeClaudeCacheState({
            enableSystemPromptCache: true,
            extendedTtl: true,
            cachingAtDepth: 4,
        }));
        expect(both1h.tone).toBe('active');
        expect(both1h.dormantFields).toEqual([]);
        const both1hText = renderModel(both1h).fullText;
        expect(both1hText).toContain('4');
        expect(both1hText).toContain('1h');
        expect(both1hText).toContain('2x');
        expect(both1hText).toContain('0.1x');
    });

    test('source === claude with active caching emits danger warning for single and warn for strict or semi', () => {
        const single = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'claude',
            enableSystemPromptCache: true,
            postProcessing: 'single',
        }));
        expect(single.tone).toBe('danger');
        expect(single.warnings).toHaveLength(1);
        expect(single.warnings[0].severity).toBe('danger');
        renderModel(single);

        for (const mode of ['strict', 'semi']) {
            const m = buildConnClaudeCacheSummary(makeClaudeCacheState({
                source: 'claude',
                cachingAtDepth: 2,
                postProcessing: mode,
            }));
            expect(m.tone).toBe('warn');
            expect(m.warnings).toHaveLength(1);
            expect(m.warnings[0].severity).toBe('warn');
            renderModel(m);
        }

        for (const safeMode of ['', 'merge']) {
            const ok = buildConnClaudeCacheSummary(makeClaudeCacheState({
                source: 'claude',
                enableSystemPromptCache: true,
                postProcessing: safeMode,
            }));
            expect(ok.tone).toBe('active');
            expect(ok.warnings).toEqual([]);
        }
    });

    test('postProcessing token renders read-only span when absent and interactive button when present', () => {
        const absent = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'claude',
            enableSystemPromptCache: true,
            postProcessing: 'single',
            canActivatePostProcessing: false,
        }));
        const absentWarnParts = renderTemplateParts(absent.warnings[0].template, absent.warnings[0].tokens);
        const absentTok = absentWarnParts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(absentTok).toBeTruthy();
        expect(absentTok.tagName).toBe('SPAN');
        expect(absentTok.classList.contains('is-readonly')).toBe(true);

        const onActivate = jest.fn(() => true);
        const present = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'claude',
            enableSystemPromptCache: true,
            postProcessing: 'strict',
            canActivatePostProcessing: true,
            onPostProcessingActivate: onActivate,
        }));
        const presentWarnParts = renderTemplateParts(present.warnings[0].template, present.warnings[0].tokens);
        const presentBtn = presentWarnParts.find((p) => p instanceof Element && p.classList.contains('luker-bsum-tok'));
        expect(presentBtn).toBeTruthy();
        expect(presentBtn.tagName).toBe('BUTTON');
        expect(presentBtn.dataset.bsumFields).toBe('postProcessing');
    });

    test('source === openrouter includes anthropic/claude* model scope and omits claude post-processing warning', () => {
        const model = buildConnClaudeCacheSummary(makeClaudeCacheState({
            source: 'openrouter',
            enableSystemPromptCache: true,
            postProcessing: 'single',
        }));

        expect(model.tone).toBe('active');
        expect(model.warnings).toEqual([]);
        expect(renderModel(model).fullText).toContain('anthropic/claude*');
    });
});

describe('buildConnGeminiCacheSummary', () => {
    test('non-cc profile sets dormant tone and dims all 3 Gemini cache fields', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            hasProfile: true,
            profileMode: 'tc',
            enableHistoryCache: true,
        }));

        expect(model.tone).toBe('dormant');
        expect(new Set(model.dormantFields)).toEqual(new Set(['enableSystemPromptCache', 'enableHistoryCache', 'keepRecentTurns']));
    });

    test('both toggles off sets dormant tone and dims keepRecentTurns', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: false,
            enableHistoryCache: false,
        }));

        expect(model.tone).toBe('dormant');
        expect(model.dormantFields).toEqual(['keepRecentTurns']);
        expect(model.warnings).toEqual([]);
    });

    test('system cache only sets active tone and dims keepRecentTurns', () => {
        const bothOff = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: false,
            enableHistoryCache: false,
        }));
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: true,
            enableHistoryCache: false,
            keepRecentTurns: 3,
        }));

        expect(model.tone).toBe('active');
        expect(model.dormantFields).toEqual(['keepRecentTurns']);
        expect(model.warnings).toEqual([]);
        expect(renderModel(model).fullText).not.toBe(renderModel(bothOff).fullText);
    });

    test('enableHistoryCache true dims enableSystemPromptCache, keeps keepRecentTurns active, and emits warn', () => {
        const model = buildConnGeminiCacheSummary(makeGeminiCacheState({
            enableSystemPromptCache: true,
            enableHistoryCache: true,
            keepRecentTurns: 4,
        }));

        expect(model.tone).toBe('warn');
        expect(model.dormantFields).toEqual(['enableSystemPromptCache']);
        expect(model.warnings).toHaveLength(1);
        expect(model.warnings[0].severity).toBe('warn');
        const rendered = renderModel(model);
        expect(rendered.fullText).toContain('4');
        expect(rendered.warningTexts[0].text.length).toBeGreaterThan(0);
        expect(tokenFieldKeys(model)).toEqual(new Set([
            'enableHistoryCache',
            'enableSystemPromptCache',
            'keepRecentTurns',
        ]));
    });
});
