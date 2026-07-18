// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { describe, test, expect } from '@jest/globals';
import { diagnoseAnchorMiss } from '../../public/scripts/iteration-library/anchor-diagnostic.js';

describe('diagnoseAnchorMiss', () => {
    test('kind=no_similar when oldString has zero recognizable overlap', () => {
        const out = diagnoseAnchorMiss('hello world', 'totally unrelated content');
        expect(out.kind).toBe('no_similar');
        expect(Array.isArray(out.snippets)).toBe(true);
        expect(out.snippets).toHaveLength(0);
    });

    test('kind=whitespace_drift when only trailing whitespace differs', () => {
        const current = 'line one\nline two\nline three';
        const oldString = 'line one \nline two\nline three'; // extra trailing space on line 1
        const out = diagnoseAnchorMiss(current, oldString);
        expect(out.kind).toBe('whitespace_drift');
        expect(out.note.toLowerCase()).toContain('whitespace');
        expect(out.snippets.length).toBeGreaterThan(0);
    });

    test('kind=whitespace_drift when oldString is uniformly dedented', () => {
        const current = '    if (x) {\n        doThing();\n    }';
        const oldString = 'if (x) {\n    doThing();\n}'; // dedented by 4
        const out = diagnoseAnchorMiss(current, oldString);
        expect(out.kind).toBe('whitespace_drift');
        expect(out.note.toLowerCase()).toContain('dedent');
    });

    test('kind=similar_snippet when normalized-whitespace match hits but structure differs', () => {
        const current = 'The\tquick   brown\n\nfox';
        const oldString = 'The quick brown fox';
        const out = diagnoseAnchorMiss(current, oldString);
        expect(out.kind).toBe('similar_snippet');
        expect(out.snippets.length).toBeGreaterThan(0);
        expect(out.snippets[0].current).toContain('brown');
    });

    // The 20 KB input cap was pulled from thin air. It turned
    // legitimate patch attempts against long `systemPrompt` fields
    // into a `too_long_to_diagnose` reply that gave the AI nothing
    // actionable. Fuzzy diagnosis now runs regardless of input size —
    // string search is linear and cheap enough that a diagnostic
    // round-trip against a 21 KB field costs nothing worth capping.
    test('long currentText is still diagnosed (no input-size cap)', () => {
        const bigText = 'a'.repeat(21000) + 'ANCHOR-HERE' + 'b'.repeat(1000);
        const out = diagnoseAnchorMiss(bigText, 'ANCHOR-HERE');
        // ANCHOR-HERE occurs verbatim so the whitespace-normalized
        // layer trivially hits.
        expect(out.kind).not.toBe('too_long_to_diagnose');
        expect(out.snippets.length).toBeGreaterThan(0);
    });

    test('long oldString is still diagnosed (no input-size cap)', () => {
        // oldString repeats a distinctive marker so the 40-char probe
        // layer finds it inside a matching current text.
        const marker = 'MARKER-XYZ-THAT-DOES-NOT-COLLIDE-BUT-IS-40+CHARS!!';
        const oldString = marker + 'y'.repeat(21000);
        const current = 'preamble ' + marker + 'DIFFERENT TAIL';
        const out = diagnoseAnchorMiss(current, oldString);
        expect(out.kind).not.toBe('too_long_to_diagnose');
        expect(out.snippets.length).toBeGreaterThan(0);
    });

    // The 800-char / 2-snippet payload cap silently swallowed matches
    // that would have pinpointed the drift. All hits are now surfaced.
    test('all similar-snippet hits are surfaced (no snippet-count or payload cap)', () => {
        // Layer 3.5 (40-char prefix probe) is deterministic — every
        // occurrence of the probe in the current text becomes a
        // snippet. Use a prose-like current that has the 40-char
        // prefix ≥3 times so we can prove no 2-hit cap.
        const probe = 'The quick brown fox jumps over the lazy do'; // exactly 42 chars, > PROBE_PREFIX_LEN=40
        const current = `${probe}g. ${probe}g. ${probe}g. tail`;
        const oldString = `${probe}g. DIVERGES HERE`;
        const out = diagnoseAnchorMiss(current, oldString);
        expect(out.kind).toBe('similar_snippet');
        // Three occurrences of the prefix — all surfaced.
        expect(out.snippets.length).toBe(3);
    });

    test('empty oldString returns no_similar', () => {
        const out = diagnoseAnchorMiss('some text', '');
        expect(out.kind).toBe('no_similar');
    });

    test('never throws — degrades gracefully on weird input', () => {
        expect(() => diagnoseAnchorMiss(null, undefined)).not.toThrow();
        expect(() => diagnoseAnchorMiss(123, {})).not.toThrow();
    });
});
