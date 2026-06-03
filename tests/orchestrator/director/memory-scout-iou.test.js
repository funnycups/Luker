/**
 * memory_scout IoU framework + content contract tests (spec 2).
 *
 * Spec: docs/superpowers/specs/2026-05-18-memory-scout-uses-readonly-api.md
 *
 * This file holds three categories of tests that gate spec 2 acceptance:
 *
 * 1. **IoU computation utility** — pure function used by future end-to-end
 *    tests that compare memory_scout's cited-id set against native
 *    `runLLMDrivenRecall` output. Tested standalone here so the math is
 *    locked before any LLM round-trip lands.
 * 2. **memory_scout content contract** (spec §8.3) — asserts the
 *    description + systemPrompt content after the spec-2 rewrite. These
 *    overlap with `director-fields.test.js` deliberately: this file is the
 *    spec-2 acceptance gate, that file is the schema gate.
 * 3. **Cited-id extraction** — pure regex utility tested standalone so
 *    future IoU tests have a known-good parser for memory_scout output.
 *
 * The real end-to-end IoU tests are left as `test.todo` per spec §9.1:
 * the threshold X is TBD until a deterministic LLM driver lands in the
 * unit-test env (real model with seed, or recorded-response replay shared
 * by native + scout).
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

    test('description does NOT claim traversal (spec §4.3 — old aspirational wording removed)', () => {
        expect(scout.description).not.toMatch(/traverse/i);
    });

    test('description contains enumerate / rank / expand / cite (spec §4.3 — new pipeline framing)', () => {
        expect(scout.description).toMatch(/enumerate/i);
        expect(scout.description).toMatch(/rank/i);
        expect(scout.description).toMatch(/expand/i);
        expect(scout.description).toMatch(/cite|cited/i);
    });

    test('description mentions LLM-grade recall (so main agent knows scout is recall-equivalent)', () => {
        expect(scout.description).toMatch(/LLM-grade\s+(memory-graph\s+)?recall/i);
    });

    test('systemPrompt drops chat-grounded signal heuristics (spec §4.4 — engaged/build/sedimented gone)', () => {
        expect(scout.systemPrompt).not.toMatch(/engaged with/i);
        expect(scout.systemPrompt).not.toMatch(/build on/i);
        expect(scout.systemPrompt).not.toMatch(/sedimented/i);
    });

    test('systemPrompt mentions every read-api tool by name (the menu the scout dispatches from)', () => {
        const expectedTools = [
            'memory_schema',
            'memory_list_candidates',
            'memory_node_brief',
            'memory_edge_summary',
            'memory_expand_seeds',
            'memory_keyword_search',
            'memory_vector_search',
            'memory_find_by_name',
        ];
        for (const tool of expectedTools) {
            expect(scout.systemPrompt).toContain(tool);
        }
    });
});

describe('memory_scout vs native recall — IoU end-to-end (deferred, spec §9.1)', () => {
    // These tests require a deterministic LLM driver shared by both the
    // native `runLLMDrivenRecall` path and the orchestrator's memory_scout
    // dispatch — either a real model with seed=fixed, or a recorded-response
    // replay layer. Neither exists in the unit-test env today.
    //
    // Spec §8.4 acceptance: "at least 1 fixture IoU ≥ X (X TBD); all fixtures
    // run without uncaught exceptions". The TBD threshold is contingent on
    // real-model calibration runs — see spec §9.1.
    //
    // Wiring expectation when these land:
    //   1. buildFixture<basic|hierarchical|large_pool|always_inject>() returns
    //      { store, chat, settings, expectedNativeSet }.
    //   2. Run native runLLMDrivenRecall against the fixture with seeded LLM.
    //   3. Run memory_scout via the director dispatcher with the SAME seeded LLM.
    //   4. computeRecallIoU(nativeSet, extractCitedMemoryIds(scoutOutput)) ≥ X.
    test.todo('IoU ≥ TBD against fixture_basic (small store, no hierarchical compression)');
    test.todo('IoU ≥ TBD against fixture_hierarchical (rollups + drill expansion path)');
    test.todo('IoU ≥ TBD against fixture_large_pool (rank pipeline narrows the pool)');
    test.todo('IoU ≥ TBD against fixture_always_inject (always_inject filtered from load-bearing picks)');
});
