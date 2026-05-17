import { describe, expect, test } from '@jest/globals';
import { presetContainsContentPrompts } from '../../../public/scripts/extensions/orchestrator/director-preset-lint.js';

describe('presetContainsContentPrompts', () => {
    test('returns true when charDescription is enabled with non-empty content', () => {
        const preset = {
            prompts: [{ identifier: 'charDescription', content: '{{description}}', enabled: true }],
        };
        expect(presetContainsContentPrompts(preset)).toBe(true);
    });

    test('returns true when personaDescription is enabled with non-empty content', () => {
        const preset = {
            prompts: [{ identifier: 'personaDescription', content: '{{persona}}', enabled: true }],
        };
        expect(presetContainsContentPrompts(preset)).toBe(true);
    });

    test('returns true when scenario is enabled with non-empty content', () => {
        const preset = {
            prompts: [{ identifier: 'scenario', content: '{{scenario}}', enabled: true }],
        };
        expect(presetContainsContentPrompts(preset)).toBe(true);
    });

    test('returns true when worldInfoBefore is enabled with content', () => {
        const preset = {
            prompts: [{ identifier: 'worldInfoBefore', content: '{{wiBefore}}', enabled: true }],
        };
        expect(presetContainsContentPrompts(preset)).toBe(true);
    });

    test('returns true when chatHistory marker is enabled', () => {
        const preset = {
            prompts: [{ identifier: 'chatHistory', marker: true, enabled: true }],
        };
        expect(presetContainsContentPrompts(preset)).toBe(true);
    });

    test('returns false for pure-instruction preset (only main/jailbreak/nsfw enabled with content)', () => {
        const preset = {
            prompts: [
                { identifier: 'main',       content: 'you are an AI...', enabled: true },
                { identifier: 'jailbreak',  content: 'OOC...',           enabled: true },
                { identifier: 'nsfw',       content: 'NSFW...',          enabled: true },
            ],
        };
        expect(presetContainsContentPrompts(preset)).toBe(false);
    });

    test('returns false when content prompts exist but are disabled', () => {
        const preset = {
            prompts: [
                { identifier: 'charDescription', content: '{{description}}', enabled: false },
                { identifier: 'jailbreak',       content: 'OOC...',          enabled: true },
            ],
        };
        expect(presetContainsContentPrompts(preset)).toBe(false);
    });

    test('returns false when content prompts are enabled with empty content (no marker)', () => {
        const preset = {
            prompts: [
                { identifier: 'charDescription', content: '', enabled: true },
                { identifier: 'scenario',        content: '', enabled: true },
            ],
        };
        expect(presetContainsContentPrompts(preset)).toBe(false);
    });

    test('handles missing or malformed preset gracefully', () => {
        expect(presetContainsContentPrompts(null)).toBe(false);
        expect(presetContainsContentPrompts(undefined)).toBe(false);
        expect(presetContainsContentPrompts({})).toBe(false);
        expect(presetContainsContentPrompts({ prompts: 'not an array' })).toBe(false);
        expect(presetContainsContentPrompts({ prompts: [null, undefined, 'not an obj'] })).toBe(false);
    });

    test('returns true when ANY content prompt qualifies (mix with disabled / pure-instruction)', () => {
        const preset = {
            prompts: [
                { identifier: 'jailbreak',         content: 'OOC...',          enabled: true },
                { identifier: 'main',              content: '',                enabled: false },
                { identifier: 'charDescription',   content: '{{description}}', enabled: true },
                { identifier: 'personaDescription',content: '',                enabled: false },
            ],
        };
        expect(presetContainsContentPrompts(preset)).toBe(true);
    });
});
