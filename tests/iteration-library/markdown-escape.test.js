// Unit tests for the shared `mdLiteral` helper used by all four
// iter-studio plugins to wrap dynamic values (field names, paths,
// lorebook names, error messages) before they flow into the chat
// bubble's markdown renderer.

import { describe, expect, test } from '@jest/globals';
import { mdLiteral } from '../../public/scripts/iteration-library/markdown-escape.js';

describe('mdLiteral', () => {
    test('wraps plain text in single backticks', () => {
        expect(mdLiteral('hello')).toBe('`hello`');
    });

    test('preserves underscores so markdown does not interpret them as italic', () => {
        expect(mdLiteral('system_prompt')).toBe('`system_prompt`');
        expect(mdLiteral('__PREV_VALUE__')).toBe('`__PREV_VALUE__`');
    });

    test('preserves asterisks so markdown does not interpret them as bold', () => {
        expect(mdLiteral('**kwargs')).toBe('`**kwargs`');
        expect(mdLiteral('a*b*c')).toBe('`a*b*c`');
    });

    test('preserves square brackets so markdown does not interpret link syntax', () => {
        expect(mdLiteral('arr[3].field')).toBe('`arr[3].field`');
    });

    test('renders empty / null / undefined as a recognisable empty placeholder', () => {
        expect(mdLiteral('')).toBe('`(empty)`');
        expect(mdLiteral(null)).toBe('`(empty)`');
        expect(mdLiteral(undefined)).toBe('`(empty)`');
    });

    test('uses a longer fence when the value contains backtick runs', () => {
        // Single internal backtick: still safe with a single-backtick fence
        // because GFM only breaks the span at the literal fence pattern.
        // But our helper picks fence = run + 1 unconditionally, so two-tick.
        expect(mdLiteral('a`b')).toBe('``a`b``');
        // Two consecutive backticks → fence is three.
        expect(mdLiteral('value with ``backticks`` inside')).toBe('```value with ``backticks`` inside```');
        // Three consecutive backticks → fence is four (and padded because
        // the value also starts/ends with backticks).
        expect(mdLiteral('```fenced```')).toBe('```` ```fenced``` ````');
    });

    test('pads with a space when the value starts or ends with a backtick', () => {
        expect(mdLiteral('`leading')).toBe('`` `leading ``');
        expect(mdLiteral('trailing`')).toBe('`` trailing` ``');
        expect(mdLiteral('`both`')).toBe('`` `both` ``');
    });

    test('coerces non-strings deterministically', () => {
        expect(mdLiteral(42)).toBe('`42`');
        expect(mdLiteral(0)).toBe('`0`');
        expect(mdLiteral(false)).toBe('`false`');
        expect(mdLiteral(true)).toBe('`true`');
    });

    test('handles realistic error-message shapes that previously broke', () => {
        // Backend JSON error with quoted field name.
        const msg = "Invalid value for 'system_prompt': must not be empty";
        expect(mdLiteral(msg)).toBe(`\`${msg}\``);
        // Path with underscores.
        expect(mdLiteral('/var/data/users/default_user/chats/Some_Card_Name.jsonl'))
            .toBe('`/var/data/users/default_user/chats/Some_Card_Name.jsonl`');
        // Claude-style error with embedded backticks.
        expect(mdLiteral('model `claude-opus-4-5` not found'))
            .toBe('``model `claude-opus-4-5` not found``');
    });
});
