import './_mocks/luker-zh.js';
import { describe, test, expect } from '@jest/globals';
import {
    TECHNICAL_FIELDS,
    CADENCE_PRESETS,
    matchCadencePreset,
    detectVisibilityGap,
    formatCadenceSummary,
    buildCadenceDemoFrames,
    getDirtyAdvancedKeys,
} from '../../../public/scripts/extensions/memory-graph/lens/settings/settings-model.js';

describe('TECHNICAL_FIELDS', () => {
    test('does not include llmVisibleRecentMessages (moved out of collapsed technical section)', () => {
        expect(TECHNICAL_FIELDS.some(f => f.key === 'llmVisibleRecentMessages')).toBe(false);
    });
});

describe('CADENCE_PRESETS & matchCadencePreset', () => {
    test('defines the 5 canonical presets with exact cadence and floor-hiding values', () => {
        expect(CADENCE_PRESETS.map(p => [p.id, p.values])).toEqual([
            ['every_1', { updateEvery: 1, extractBatchTurns: 1, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 3 }],
            ['balanced', { updateEvery: 2, extractBatchTurns: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 5 }],
            ['saver', { updateEvery: 3, extractBatchTurns: 3, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 7 }],
            ['long_window', { updateEvery: 5, extractBatchTurns: 5, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 11 }],
            ['no_hide', { updateEvery: 2, extractBatchTurns: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 0 }],
        ]);
    });

    test('matchCadencePreset matches exact preset ignoring unrelated keys and returns null for custom combos', () => {
        expect(matchCadencePreset({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 5,
            extractContextTurns: 4,
            extractMode: 'crawl',
        })).toBe('balanced');

        expect(matchCadencePreset({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 0,
        })).toBe('no_hide');

        expect(matchCadencePreset({
            updateEvery: 4,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 9,
        })).toBeNull();
    });
});

describe('detectVisibilityGap', () => {
    test('returns hasGap: false for valid odd windows and disabled hiding', () => {
        expect(detectVisibilityGap({ updateEvery: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 5 })).toEqual({ hasGap: false });
        expect(detectVisibilityGap({ updateEvery: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 3 })).toEqual({ hasGap: false });
        expect(detectVisibilityGap({ updateEvery: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 0 })).toEqual({ hasGap: false });
        expect(detectVisibilityGap({ updateEvery: 1, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 1 })).toEqual({ hasGap: false });
    });

    test('flags even boundary where paired user message is hidden before extraction', () => {
        expect(detectVisibilityGap({ updateEvery: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 2 })).toEqual({
            hasGap: true,
            minRecommendedVisible: 3,
            maxUnextracted: 1,
            visibleAssistantTurns: 1,
        });
        expect(detectVisibilityGap({ updateEvery: 3, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 4 })).toEqual({
            hasGap: true,
            minRecommendedVisible: 5,
            maxUnextracted: 2,
            visibleAssistantTurns: 2,
        });
        expect(detectVisibilityGap({ updateEvery: 2, extractExcludeRecentTurns: 1, llmVisibleRecentMessages: 4 })).toEqual({
            hasGap: true,
            minRecommendedVisible: 5,
            maxUnextracted: 2,
            visibleAssistantTurns: 2,
        });
    });
});

describe('buildCadenceDemoFrames', () => {
    test('simulates the 2-2-5 preset cleanly with zero hidden-unextracted pills and shows hiding after extraction', () => {
        const frames = buildCadenceDemoFrames({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 5,
        });
        expect(frames.length).toBeGreaterThanOrEqual(4);
        expect(frames.length).toBeLessThanOrEqual(6);

        // No frame in 2-2-5 ever hides an unextracted turn.
        for (const frame of frames) {
            expect(frame.hasGap).toBe(false);
            expect(frame.messages.some(m => m.state === 'hidden-unextracted')).toBe(false);
        }

        // Includes a trigger frame with extracting pills and a later sliding-window frame with hidden-extracted pills.
        expect(frames.some(f => f.messages.some(m => m.state === 'extracting'))).toBe(true);
        const hiddenFrame = frames.find(f => f.messages.some(m => m.state === 'hidden-extracted'));
        expect(hiddenFrame).toBeTruthy();
        expect(hiddenFrame.messages.filter(m => m.state === 'hidden-extracted').map(m => m.id)).toEqual(['U1', 'A1']);
        expect(hiddenFrame.messages.filter(m => m.state !== 'hidden-extracted').length).toBe(5);
    });

    test('produces zero hidden pills when llmVisibleRecentMessages is 0', () => {
        const frames = buildCadenceDemoFrames({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 0,
        });
        expect(frames.length).toBeGreaterThanOrEqual(3);
        for (const frame of frames) {
            expect(frame.hasGap).toBe(false);
            expect(frame.messages.some(m => m.state === 'hidden-extracted' || m.state === 'hidden-unextracted')).toBe(false);
        }
    });

    test('marks hidden-unextracted pills on gapped odd and even windows matching detectVisibilityGap', () => {
        for (const params of [
            { updateEvery: 2, extractBatchTurns: 2, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 2 },
            { updateEvery: 3, extractBatchTurns: 3, extractExcludeRecentTurns: 0, llmVisibleRecentMessages: 3 },
        ]) {
            const frames = buildCadenceDemoFrames(params);
            expect(frames.some(f => f.hasGap && f.messages.some(m => m.state === 'hidden-unextracted'))).toBe(true);
        }
    });

    test('keeps large cadences like 5-5-11 compact with zero gap', () => {
        const frames = buildCadenceDemoFrames({
            updateEvery: 5,
            extractBatchTurns: 5,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 11,
        });
        expect(frames.length).toBeGreaterThanOrEqual(4);
        expect(frames.length).toBeLessThanOrEqual(6);
        for (const frame of frames) {
            expect(frame.hasGap).toBe(false);
            expect(frame.messages.some(m => m.state === 'hidden-unextracted')).toBe(false);
        }
    });
});

describe('getDirtyAdvancedKeys', () => {
    test('tracks changed keys and clears when reverted back to saved values', () => {
        const saved = { updateEvery: 2, llmVisibleRecentMessages: 5, extractConcurrent: false, extractTemplate: 'abc' };
        expect(getDirtyAdvancedKeys({ ...saved }, saved)).toEqual([]);
        expect(getDirtyAdvancedKeys({ ...saved, llmVisibleRecentMessages: '5' }, saved)).toEqual([]);
        expect(getDirtyAdvancedKeys({ ...saved, llmVisibleRecentMessages: 3 }, saved)).toEqual(['llmVisibleRecentMessages']);
        expect(getDirtyAdvancedKeys({ ...saved, llmVisibleRecentMessages: 5 }, saved)).toEqual([]);
    });
});

describe('formatCadenceSummary', () => {
    test('describes both extraction cadence and floor hiding for odd window, disabled hiding, and trailing exclusions', () => {
        const balanced = formatCadenceSummary({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractContextTurns: 2,
            extractExcludeRecentTurns: 0,
            llmVisibleRecentMessages: 5,
        });
        expect(balanced).toContain('2');
        expect(balanced).toContain('5');
        expect(balanced).not.toContain('跳过最新 0');

        const noHide = formatCadenceSummary({
            updateEvery: 2,
            extractBatchTurns: 2,
            extractContextTurns: 2,
            extractExcludeRecentTurns: 1,
            llmVisibleRecentMessages: 0,
        });
        expect(noHide).toContain('全部');
        expect(noHide).toContain('1');
    });
});
