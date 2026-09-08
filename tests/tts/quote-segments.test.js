import { describe, test, expect } from '@jest/globals';
import {
    extractQuoteSegments,
    attachQuoteIndices,
} from '../../public/scripts/extensions/tts/quote-segments.js';

describe('extractQuoteSegments', () => {
    test('extracts six quote styles in document order with offsets', () => {
        const text = 'a "one" b “two” c «three» d 「four」 e 『five』 f ＂six＂ g';
        const out = extractQuoteSegments(text);
        expect(out.map(s => s.content)).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
        expect(out.map(s => s.qIndex)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(out[0].full).toBe('"one"');
        expect(out[0].start).toBe(2);
        expect(out[0].end).toBe(7);
    });

    test('quotes inside fenced and inline code are skipped, outer quotes index contiguously', () => {
        const text = 'before "outer one" ```code "not a quote"``` after `tick "x"` "outer two"';
        const out = extractQuoteSegments(text);
        expect(out.map(s => s.content)).toEqual(['outer one', 'outer two']);
        expect(out.map(s => s.qIndex)).toEqual([0, 1]);
    });

    test('style block quotes are skipped', () => {
        const text = '<style>.a { content: "skip" }</style> "kept"';
        const out = extractQuoteSegments(text);
        expect(out.map(s => s.content)).toEqual(['kept']);
    });

    test('unclosed quote produces no segment', () => {
        expect(extractQuoteSegments('"open')).toEqual([]);
    });

    test('empty string returns empty array', () => {
        expect(extractQuoteSegments('')).toEqual([]);
    });
});

describe('attachQuoteIndices', () => {
    test('attaches qIndex to dialogue segments in cursor order', () => {
        const segments = [
            { type: 'other', text: 'He nodded.' },
            { type: 'dialogue', text: 'first words' },
            { type: 'action', text: 'waves' },
            { type: 'dialogue', text: 'second words' },
        ];
        const quoteWindow = [
            { qIndex: 0, start: 11, end: 24, full: '"first words"', content: 'first words' },
            { qIndex: 1, start: 40, end: 54, full: '"second words"', content: 'second words' },
        ];
        attachQuoteIndices(segments, quoteWindow);
        expect(segments[1].qIndex).toBe(0);
        expect(segments[3].qIndex).toBe(1);
        expect(segments[0].qIndex).toBeUndefined();
        expect(segments[2].qIndex).toBeUndefined();
    });

    test('dialogue segment without matching quote gets no qIndex', () => {
        const segments = [{ type: 'dialogue', text: 'trimmed  inner' }];
        attachQuoteIndices(segments, []);
        expect(segments[0].qIndex).toBeUndefined();
    });

    test('exact match wins over containment, both succeed when distinct', () => {
        const segments = [
            { type: 'dialogue', text: 'hello' },
            { type: 'dialogue', text: 'hello there' },
        ];
        const quoteWindow = [
            { qIndex: 0, start: 0, end: 7, full: '"hello"', content: 'hello' },
            { qIndex: 1, start: 8, end: 21, full: '"hello there"', content: 'hello there' },
        ];
        attachQuoteIndices(segments, quoteWindow);
        expect(segments[0].qIndex).toBe(0);
        expect(segments[1].qIndex).toBe(1);
    });
});
