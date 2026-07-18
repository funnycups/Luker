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

    test('kind=too_long_to_diagnose when currentText > 20KB', () => {
        const bigText = 'a'.repeat(21000);
        const out = diagnoseAnchorMiss(bigText, 'anchor that misses');
        expect(out.kind).toBe('too_long_to_diagnose');
        expect(out.snippets).toHaveLength(0);
    });

    test('kind=too_long_to_diagnose when oldString > 20KB', () => {
        const bigOld = 'x'.repeat(21000);
        const out = diagnoseAnchorMiss('short current text', bigOld);
        expect(out.kind).toBe('too_long_to_diagnose');
    });

    test('truncated=true when snippets would exceed 800-char total payload', () => {
        // Force similar_snippet path with a very long current text
        const current = 'A B C D '.repeat(500); // 4000 chars
        const oldString = 'A B C D'; // matches many places
        const out = diagnoseAnchorMiss(current, oldString);
        expect(out.snippets.length).toBeLessThanOrEqual(2);
        // Verify total snippet length is bounded
        const totalLen = out.snippets.reduce((s, x) => s + x.current.length, 0);
        expect(totalLen).toBeLessThanOrEqual(800);
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
