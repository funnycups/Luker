// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { describe, test, expect } from '@jest/globals';
import { readFieldsByPaths } from '../../public/scripts/iteration-library/read-fields-helper.js';

const sampleRoot = {
    mainAgent: { systemPrompt: 'a', tools: { note: { open: true } } },
    subAgents: [
        { id: 'a', description: 'first' },
        { id: 'b', description: 'second' },
    ],
    maxRounds: 40,
};

describe('readFieldsByPaths', () => {
    test('reads simple + nested + array-indexed paths', () => {
        const out = readFieldsByPaths(sampleRoot, ['mainAgent.systemPrompt', 'subAgents[1].description', 'maxRounds']);
        expect(out['mainAgent.systemPrompt']).toBe('a');
        expect(out['subAgents[1].description']).toBe('second');
        expect(out['maxRounds']).toBe(40);
        expect(out.missing_paths).toEqual([]);
    });

    test('unknown path → null + missing_paths', () => {
        const out = readFieldsByPaths(sampleRoot, ['subAgents[99].id', 'mainAgent.systemPrompt']);
        expect(out['subAgents[99].id']).toBeNull();
        expect(out['mainAgent.systemPrompt']).toBe('a');
        expect(out.missing_paths).toEqual(['subAgents[99].id']);
    });

    // Size-based truncation was pulled from thin air and produced a
    // pathological failure mode: any string field > 5 KB (typical for
    // `systemPrompt`) became a 200-char preview envelope with no
    // subfield to narrow to, wedging anchor-based patch loops. This
    // helper now returns raw values regardless of size — the read
    // tool's contract is that the caller picks the exact path.
    test('value > 5KB is returned verbatim (no size-based truncation)', () => {
        const bigRoot = { field: 'x'.repeat(6000) };
        const out = readFieldsByPaths(bigRoot, ['field']);
        expect(out['field']).toBe('x'.repeat(6000));
        expect(out.missing_paths).toEqual([]);
    });

    test('non-array paths throws invalid_args', () => {
        expect(() => readFieldsByPaths(sampleRoot, 'not an array')).toThrow(/invalid_args/);
    });

    test('empty paths array returns empty result with missing_paths=[]', () => {
        const out = readFieldsByPaths(sampleRoot, []);
        expect(Object.keys(out).filter((k) => k !== 'missing_paths')).toEqual([]);
        expect(out.missing_paths).toEqual([]);
    });

    test('reads an entire array by index-free path', () => {
        const out = readFieldsByPaths(sampleRoot, ['subAgents']);
        expect(out['subAgents']).toEqual(sampleRoot.subAgents);
    });

    // FIX 3 (Fix Wave 1) — empty-string path silently skipped instead
    // of polluting the response with `out[''] = null` and
    // `missing_paths: ['']`. Callers can hand us a trailing empty
    // string (bad AI codegen, split-on-comma with trailing comma, etc)
    // without cluttering every batch's response envelope.
    test('empty-string path in paths array is silently skipped', () => {
        const out = readFieldsByPaths(sampleRoot, ['mainAgent.systemPrompt', '', 'maxRounds']);
        expect(out['mainAgent.systemPrompt']).toBe('a');
        expect(out['maxRounds']).toBe(40);
        // The empty string does NOT show up as a key.
        expect(Object.prototype.hasOwnProperty.call(out, '')).toBe(false);
        // The empty string does NOT show up in missing_paths.
        expect(out.missing_paths).not.toContain('');
        // Only the two real paths are in the response body.
        expect(Object.keys(out).filter((k) => k !== 'missing_paths').sort())
            .toEqual(['mainAgent.systemPrompt', 'maxRounds']);
    });

    test('non-string path entries (number / null / undefined) are silently skipped', () => {
        // Defensive: AI codegen occasionally emits mixed-type arrays.
        // Skip silently for the same reason as empty strings.
        const out = readFieldsByPaths(sampleRoot, [
            'mainAgent.systemPrompt',
            null,
            undefined,
            42,
            'maxRounds',
        ]);
        expect(out['mainAgent.systemPrompt']).toBe('a');
        expect(out['maxRounds']).toBe(40);
        expect(out.missing_paths).toEqual([]);
        // No numeric/null/undefined keys leaked in.
        expect(Object.keys(out).filter((k) => k !== 'missing_paths').sort())
            .toEqual(['mainAgent.systemPrompt', 'maxRounds']);
    });

    // FIX 4 (Fix Wave 1) — value that JSON.stringify can't serialize
    // (circular reference, throwing toJSON, BigInt in some engines)
    // returns the truncation envelope with `preview: '(unserializable)'`
    // instead of falling through to the untruncated branch and
    // returning the raw value (which the downstream tool_result
    // serializer would then blow up trying to JSON.stringify a second
    // time).
    test('circular-reference value returns the (unserializable) truncation envelope', () => {
        const a = {};
        a.self = a;
        const out = readFieldsByPaths({ circular: a }, ['circular']);
        expect(out['circular']).toEqual(expect.objectContaining({
            __truncated__: true,
            length: 0,
            preview: '(unserializable)',
        }));
        expect(typeof out['circular'].hint).toBe('string');
        // Sanity: subsequent JSON.stringify of the whole response
        // succeeds (this is the whole point — no downstream throw).
        expect(() => JSON.stringify(out)).not.toThrow();
    });

    test('throwing-toJSON value returns the (unserializable) truncation envelope', () => {
        // Not every unserializable is a circular ref. Anything that
        // makes JSON.stringify throw should land in the same envelope.
        const bomb = { toJSON() { throw new Error('nope'); } };
        const out = readFieldsByPaths({ bomb }, ['bomb']);
        expect(out['bomb']).toEqual(expect.objectContaining({
            __truncated__: true,
            length: 0,
            preview: '(unserializable)',
        }));
        expect(() => JSON.stringify(out)).not.toThrow();
    });
});
