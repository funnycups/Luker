// tests/lib/template-format.test.js
import { describe, test, expect } from '@jest/globals';
import { formatTemplate, formatWithI18n } from '../../public/scripts/lib/template-format.js';

describe('formatTemplate', () => {
    test('fills indexed placeholders in any order', () => {
        expect(formatTemplate('${1} charts ${0}', 'the reef', 'Ash')).toBe('Ash charts the reef');
    });

    test('missing or nullish values become empty strings', () => {
        expect(formatTemplate('[${0}|${1}|${2}]', 'a', null)).toBe('[a||]');
    });

    test('a nullish template becomes an empty string', () => {
        expect(formatTemplate(undefined, 'x')).toBe('');
        expect(formatTemplate(null)).toBe('');
    });

    test('replacement patterns inside values stay literal', () => {
        expect(formatTemplate('cost: ${0}', '$& and $1')).toBe('cost: $& and $1');
    });
});

describe('formatWithI18n', () => {
    test('without an i18n function it formats the template', () => {
        expect(formatWithI18n(null, 'Insert into ${0}', 'notes')).toBe('Insert into notes');
    });

    test('fills placeholders left in the translated template', () => {
        const i18n = (s) => (s === 'Insert into ${0}' ? '插入到 ${0}' : s);
        expect(formatWithI18n(i18n, 'Insert into ${0}', 'notes')).toBe('插入到 notes');
    });

    test('falls back to the template when the translation is empty', () => {
        expect(formatWithI18n(() => '', 'Remove ${0}', 'row')).toBe('Remove row');
    });

    test('falls back to the template when the translation is not a string', () => {
        expect(formatWithI18n(() => 42, 'Remove ${0}', 'row')).toBe('Remove row');
    });

    test('returns an already-substituted translation unchanged', () => {
        const tf = (_s, ...v) => `done:${v.join('+')}`;
        expect(formatWithI18n(tf, 'Move ${0} to ${1}', 'a', 'b')).toBe('done:a+b');
    });
});
