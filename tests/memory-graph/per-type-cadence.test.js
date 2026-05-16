import { describe, test, expect } from '@jest/globals';

import {
    DEFAULT_PER_TYPE_INSTRUCTIONS,
    computeActiveExtractionTypes,
    assembleExtractionSystemPrompt,
} from '../../public/scripts/extensions/memory-graph/extraction-schedule.js';

describe('DEFAULT_PER_TYPE_INSTRUCTIONS', () => {
    test('seeds non-empty strings for stock types', () => {
        expect(DEFAULT_PER_TYPE_INSTRUCTIONS.event).toEqual(expect.stringContaining('Event'));
        expect(DEFAULT_PER_TYPE_INSTRUCTIONS.character_sheet).toEqual(expect.stringContaining('Character'));
        expect(DEFAULT_PER_TYPE_INSTRUCTIONS.location_state).toEqual(expect.stringContaining('Location'));
    });

    test('event instructions inherit the strict one-per-batch policy that was previously in the base prompt', () => {
        expect(DEFAULT_PER_TYPE_INSTRUCTIONS.event).toContain('AT MOST ONE event node');
    });

    test('character instructions inherit the consistency hard rule that was previously in the base prompt', () => {
        expect(DEFAULT_PER_TYPE_INSTRUCTIONS.character_sheet).toContain('Character consistency hard rule');
    });
});

describe('computeActiveExtractionTypes', () => {
    const schema = [
        { id: 'event', extractEveryN: 1 },
        { id: 'character_sheet', extractEveryN: 2 },
        { id: 'location_state', extractEveryN: 3 },
    ];

    test('extractEveryN=1 always active', () => {
        for (let seq = 0; seq < 10; seq++) {
            expect(computeActiveExtractionTypes(schema, seq).has('event')).toBe(true);
        }
    });

    test('extractEveryN=2 active on even seq, inactive on odd', () => {
        expect(computeActiveExtractionTypes(schema, 0).has('character_sheet')).toBe(true);
        expect(computeActiveExtractionTypes(schema, 1).has('character_sheet')).toBe(false);
        expect(computeActiveExtractionTypes(schema, 2).has('character_sheet')).toBe(true);
        expect(computeActiveExtractionTypes(schema, 3).has('character_sheet')).toBe(false);
    });

    test('extractEveryN=3 active on multiples of 3', () => {
        expect(computeActiveExtractionTypes(schema, 0).has('location_state')).toBe(true);
        expect(computeActiveExtractionTypes(schema, 1).has('location_state')).toBe(false);
        expect(computeActiveExtractionTypes(schema, 3).has('location_state')).toBe(true);
        expect(computeActiveExtractionTypes(schema, 6).has('location_state')).toBe(true);
    });

    test('missing extractEveryN defaults to 1 (always active)', () => {
        const partialSchema = [{ id: 'event' }];
        expect(computeActiveExtractionTypes(partialSchema, 7).has('event')).toBe(true);
    });

    test('non-integer / non-positive extractEveryN clamps to 1', () => {
        const oddSchema = [
            { id: 'a', extractEveryN: 0 },
            { id: 'b', extractEveryN: -3 },
            { id: 'c', extractEveryN: 'banana' },
        ];
        for (let seq = 0; seq < 5; seq++) {
            const active = computeActiveExtractionTypes(oddSchema, seq);
            expect(active.has('a')).toBe(true);
            expect(active.has('b')).toBe(true);
            expect(active.has('c')).toBe(true);
        }
    });

    test('returns a Set with all active typeIds for given seq', () => {
        const result = computeActiveExtractionTypes(schema, 6);
        expect(result).toBeInstanceOf(Set);
        expect(result.has('event')).toBe(true);
        expect(result.has('character_sheet')).toBe(true);
        expect(result.has('location_state')).toBe(true);
    });

    test('non-array schema returns empty set', () => {
        expect(computeActiveExtractionTypes(null, 0).size).toBe(0);
        expect(computeActiveExtractionTypes(undefined, 0).size).toBe(0);
    });
});

describe('assembleExtractionSystemPrompt', () => {
    test('appends active types instructions in schema order', () => {
        const schema = [
            { id: 'event', extractionInstructions: 'EVENT_RULES', extractEveryN: 1 },
            { id: 'character_sheet', extractionInstructions: 'CHAR_RULES', extractEveryN: 1 },
            { id: 'location_state', extractionInstructions: 'LOC_RULES', extractEveryN: 1 },
        ];
        const active = new Set(['event', 'location_state']);
        const out = assembleExtractionSystemPrompt('BASE_PROMPT', schema, active);
        expect(out).toContain('BASE_PROMPT');
        expect(out).toContain('EVENT_RULES');
        expect(out).toContain('LOC_RULES');
        expect(out).not.toContain('CHAR_RULES');
        expect(out.indexOf('EVENT_RULES')).toBeLessThan(out.indexOf('LOC_RULES'));
        expect(out).toContain('Per-type extraction rules (active this round)');
    });

    test('skips types with empty extractionInstructions', () => {
        const schema = [
            { id: 'event', extractionInstructions: 'EVENT_RULES', extractEveryN: 1 },
            { id: 'custom', extractionInstructions: '', extractEveryN: 1 },
        ];
        const out = assembleExtractionSystemPrompt('BASE', schema, new Set(['event', 'custom']));
        expect(out).toContain('EVENT_RULES');
        expect(out).not.toContain('[custom]');
    });

    test('returns base prompt unchanged when no active types have instructions', () => {
        expect(assembleExtractionSystemPrompt('BASE', [], new Set())).toBe('BASE');
        expect(assembleExtractionSystemPrompt('BASE', [{ id: 'event', extractionInstructions: 'X' }], new Set())).toBe('BASE');
    });

    test('labels each appended section with the typeId', () => {
        const schema = [{ id: 'event', extractionInstructions: 'X', extractEveryN: 1 }];
        const out = assembleExtractionSystemPrompt('BASE', schema, new Set(['event']));
        expect(out).toContain('[event]');
    });
});
