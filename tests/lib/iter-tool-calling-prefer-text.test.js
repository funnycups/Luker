// tests/lib/iter-tool-calling-prefer-text.test.js
import { describe, test, expect } from '@jest/globals';
import { serializeToolResultContentPreferText } from '../../public/scripts/lib/iter-tool-calling.js';

describe('serializeToolResultContentPreferText', () => {
    test('returns a non-empty toolResultText verbatim', () => {
        const result = { ok: true, toolResultText: '<simulation_result>Ash answers.</simulation_result>', extra: 1 };
        expect(serializeToolResultContentPreferText(result)).toBe('<simulation_result>Ash answers.</simulation_result>');
    });

    test('pretty-prints objects without toolResultText', () => {
        expect(serializeToolResultContentPreferText({ ok: true, count: 2 })).toBe(JSON.stringify({ ok: true, count: 2 }, null, 2));
    });

    test('an empty toolResultText falls back to JSON', () => {
        const result = { ok: true, toolResultText: '' };
        expect(serializeToolResultContentPreferText(result)).toBe(JSON.stringify(result, null, 2));
    });

    test('strings pass through and nullish becomes empty', () => {
        expect(serializeToolResultContentPreferText('plain')).toBe('plain');
        expect(serializeToolResultContentPreferText(null)).toBe('');
        expect(serializeToolResultContentPreferText(undefined)).toBe('');
    });
});
