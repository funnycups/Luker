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

    test('value > 5KB → truncation envelope', () => {
        const bigRoot = { field: 'x'.repeat(6000) };
        const out = readFieldsByPaths(bigRoot, ['field']);
        expect(out['field']).toEqual(expect.objectContaining({
            __truncated__: true,
            length: 6000,
        }));
        expect(out['field'].preview).toHaveLength(200);
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
});
