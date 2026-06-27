/**
 * memory_scout IoU framework + content contract tests.
 *
 * This file holds two categories of tests:
 *
 * 1. **IoU computation utility** — pure function reusable by any future
 *    end-to-end test that compares memory_scout's cited-id set against
 *    native `runLLMDrivenRecall` output. Tested standalone here so the
 *    math is locked.
 * 2. **memory_scout content contract** — asserts the description +
 *    systemPrompt content. Overlap with
 *    `director-fields.test.js` is deliberate: this file is the content
 *    acceptance gate, that file is the schema gate.
 * 3. **Cited-id extraction** — pure regex utility tested standalone so
 *    any future IoU runner has a known-good parser for memory_scout
 *    output.
 *
 * End-to-end IoU coverage (native runLLMDrivenRecall vs orchestrator
 * memory_scout dispatch against shared fixtures) belongs in the e2e
 * suite — the orchestrator/native pair both depend on a live mock LLM
 * server with scripted-response replay, which the unit env does not run.
 * If/when that lands, the test goes under tests/e2e/orchestrator/ and
 * uses computeRecallIoU + extractCitedMemoryIds exported from here.
 */

import { describe, test, expect } from '@jest/globals';
import { createDefaultDirectorProfile } from '../../../public/scripts/extensions/orchestrator/director-defaults.js';

/**
 * Compute the Jaccard / IoU similarity between two id collections.
 * Convention: both-empty → 1 (vacuously equivalent).
 */
function computeRecallIoU(nativeIds, scoutIds) {
    const a = new Set(nativeIds);
    const b = new Set(scoutIds);
    if (a.size === 0 && b.size === 0) return 1;
    let intersectionSize = 0;
    for (const id of a) {
        if (b.has(id)) intersectionSize += 1;
    }
    const unionSize = a.size + b.size - intersectionSize;
    return unionSize === 0 ? 1 : intersectionSize / unionSize;
}

/**
 * Extract memory ids from a memory_scout output text. The agreed citation
 * format (per memory_scout systemPrompt) is `Source: memory[id=<id>]`.
 * Tolerates whitespace inside the brackets.
 */
function extractCitedMemoryIds(scoutOutput) {
    if (typeof scoutOutput !== 'string') return [];
    const out = [];
    const re = /memory\[id=([^\]]+)\]/g;
    let match;
    while ((match = re.exec(scoutOutput)) !== null) {
        const trimmed = String(match[1] || '').trim();
        if (trimmed) out.push(trimmed);
    }
    return out;
}

describe('computeRecallIoU (Jaccard)', () => {
    test('returns 1 for identical sets', () => {
        expect(computeRecallIoU(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    test('returns 0 for disjoint sets', () => {
        expect(computeRecallIoU(['a'], ['b'])).toBe(0);
    });

    test('returns 1/3 for {a,b} vs {b,c} (one in intersection, three in union)', () => {
        expect(computeRecallIoU(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    });

    test('returns 1 when both sets are empty (vacuously equivalent)', () => {
        expect(computeRecallIoU([], [])).toBe(1);
    });

    test('returns 0 when one set is empty and the other is not', () => {
        expect(computeRecallIoU([], ['a'])).toBe(0);
        expect(computeRecallIoU(['a'], [])).toBe(0);
    });

    test('handles duplicates in input (set semantics)', () => {
        expect(computeRecallIoU(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
    });

    test('handles Set instances directly', () => {
        expect(computeRecallIoU(new Set(['x', 'y']), new Set(['y', 'z']))).toBeCloseTo(1 / 3);
    });

    test('IoU is symmetric', () => {
        const a = ['evt_1', 'evt_2', 'char_1'];
        const b = ['evt_2', 'char_1', 'loc_3', 'loc_4'];
        expect(computeRecallIoU(a, b)).toBe(computeRecallIoU(b, a));
    });
});

describe('extractCitedMemoryIds', () => {
    test('extracts ids from the canonical Source: memory[id=...] format', () => {
        const sample = [
            'Item: foreshadowing planted. Source: memory[id=evt_42]. Why: relevant. Signal: high.',
            'Item: character beat. Source: memory[id=node_7]. Why: hub. Signal: medium.',
        ].join('\n');
        expect(extractCitedMemoryIds(sample)).toEqual(['evt_42', 'node_7']);
    });

    test('returns empty array when no citations present', () => {
        expect(extractCitedMemoryIds('No memories found this round.')).toEqual([]);
    });

    test('trims whitespace inside id brackets', () => {
        expect(extractCitedMemoryIds('Source: memory[id=  padded_id  ]')).toEqual(['padded_id']);
    });

    test('handles multiple citations on one line', () => {
        const sample = 'Cross-refs memory[id=a1] and memory[id=b2] together.';
        expect(extractCitedMemoryIds(sample)).toEqual(['a1', 'b2']);
    });

    test('preserves order of appearance', () => {
        const sample = 'memory[id=z9] before memory[id=a1] before memory[id=m5]';
        expect(extractCitedMemoryIds(sample)).toEqual(['z9', 'a1', 'm5']);
    });

    test('skips empty id brackets', () => {
        expect(extractCitedMemoryIds('memory[id=  ] then memory[id=real]')).toEqual(['real']);
    });

    test('non-string input → empty array', () => {
        expect(extractCitedMemoryIds(null)).toEqual([]);
        expect(extractCitedMemoryIds(undefined)).toEqual([]);
        expect(extractCitedMemoryIds(42)).toEqual([]);
        expect(extractCitedMemoryIds({})).toEqual([]);
    });
});

describe('memory_scout content contract (spec 2 §8.3)', () => {
    const profile = createDefaultDirectorProfile();
    const scout = profile.subAgents.find(a => a.id === 'memory_scout');

    test('memory_scout exists in default profile', () => {
        expect(scout).toBeDefined();
        expect(typeof scout.description).toBe('string');
        expect(typeof scout.systemPrompt).toBe('string');
    });
});
