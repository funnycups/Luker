import { describe, expect, test } from '@jest/globals';
import { decodePresetRecordRelativePath, encodePresetRecordRelativePath } from '../../src/storage/preset-paths.js';

const dirKey = 'openAI_Settings';
const typed = text => `.luker-preset-records/v1/${Buffer.from(text).toString('hex').match(/.{1,120}/g).join('/')}/value.json`;

describe('preset declared path formats', () => {
    test.each([
        ['A.json', { kind: 'preset', dirKey, name: 'A' }],
        ['A.luker-state.n.json', { kind: 'preset-state', dirKey, name: 'A', namespace: 'n' }],
        ['A.luker-state.n.luker-state.m.json', { kind: 'preset-state', dirKey, name: 'A', namespace: 'n.luker-state.m' }],
        ['.luker-state.n.json', { kind: 'preset', dirKey, name: '.luker-state.n' }],
        ['A.luker-state..json', { kind: 'preset', dirKey, name: 'A.luker-state.' }],
    ])('legacy %s retains its published descriptor', (relative, expected) => {
        expect(decodePresetRecordRelativePath(dirKey, relative)).toEqual(expected);
    });

    test.each([
        { kind: 'preset', dirKey, name: 'A.luker-state.n' },
        { kind: 'preset-state', dirKey, name: 'A.luker-state.n', namespace: 'm' },
        { kind: 'preset-state', dirKey, name: '', namespace: '' },
        { kind: 'preset-state', dirKey, name: 'A.json', namespace: 'n' },
        { kind: 'preset-state', dirKey, name: '../name', namespace: 'n/\0\\x' },
        { kind: 'preset-state', dirKey, name: '\ud800', namespace: 'é'.repeat(128) },
    ])('the canonical writer preserves the complete tuple %j', record => {
        const relative = encodePresetRecordRelativePath(record);
        expect(decodePresetRecordRelativePath(dirKey, relative)).toEqual(record);
        expect(relative.split('/').every(segment => Buffer.byteLength(segment) <= 255)).toBe(true);
    });

    test.each([
        '.luker-preset-records/v2/00/value.json',
        '.luker-preset-records/v1/FF/value.json',
        typed('[ "preset", "openAI_Settings", "A" ]'),
        typed('["preset","novelAI_Settings","A"]'),
        typed('["preset-state","openAI_Settings","A"]'),
        '.luker-preset-records/v1/c0af/value.json',
    ])('present invalid typed path %s never becomes a legacy resource', relative => {
        expect(() => decodePresetRecordRelativePath(dirKey, relative)).toThrow();
    });
});
