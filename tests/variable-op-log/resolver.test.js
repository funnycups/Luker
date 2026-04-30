import { describe, test, expect, jest } from '@jest/globals';
import { resolveDisplayMacros } from '../../public/scripts/variable-op-log/resolver.js';

describe('resolver: resolveDisplayMacros', () => {
    test('returns empty string for empty input', () => {
        expect(resolveDisplayMacros('')).toBe('');
        expect(resolveDisplayMacros(null)).toBe('');
        expect(resolveDisplayMacros(undefined)).toBe('');
    });

    test('returns text unchanged when no macros present', () => {
        expect(resolveDisplayMacros('plain text', {})).toBe('plain text');
    });

    test('resolves {{user}} from env', () => {
        expect(resolveDisplayMacros('hi {{user}}', { user: 'Martin' }))
            .toBe('hi Martin');
    });

    test('resolves {{char}} from env', () => {
        expect(resolveDisplayMacros('this is {{char}}', { char: 'Athena' }))
            .toBe('this is Athena');
    });

    test('resolves {{time}} via callable', () => {
        const env = { time: () => '03:42:11' };
        expect(resolveDisplayMacros('now is {{time}}', env)).toBe('now is 03:42:11');
    });

    test('resolves {{getvar::name}} via callable', () => {
        const env = { getvar: (name) => name === 'hp' ? '50' : '' };
        expect(resolveDisplayMacros('hp={{getvar::hp}}', env)).toBe('hp=50');
    });

    test('handles nested getvar inside getvar', () => {
        const env = {
            getvar: (name) => name === 'inner' ? 'real_key' : (name === 'real_key' ? 'final_value' : ''),
        };
        const out = resolveDisplayMacros('{{getvar::{{getvar::inner}}}}', env);
        expect(out).toBe('final_value');
    });

    test('case-insensitive macro names', () => {
        expect(resolveDisplayMacros('{{USER}}', { user: 'Martin' })).toBe('Martin');
        expect(resolveDisplayMacros('{{GetVar::x}}', { getvar: () => 'v' })).toBe('v');
    });

    test('preserves unknown macros verbatim', () => {
        expect(resolveDisplayMacros('hello {{unknown_thing}} world', {}))
            .toBe('hello {{unknown_thing}} world');
    });

    test('preserves side-effect macros verbatim (does not execute)', () => {
        const calls = [];
        const env = {
            getvar: (n) => { calls.push(`getvar:${n}`); return 'X'; },
        };
        const result = resolveDisplayMacros('{{setvar::a::1}} sep {{addvar::b::2}}', env);
        expect(result).toBe('{{setvar::a::1}} sep {{addvar::b::2}}');
        expect(calls).toEqual([]);
    });

    test('preserves side-effect macros even when nested inside another expression', () => {
        // Outer is unknown so it stays verbatim, but inner setvar must also stay
        const text = '{{wrapper::{{setvar::a::1}}}}';
        expect(resolveDisplayMacros(text, {})).toBe(text);
    });

    test('uses env.extra for additional named macros', () => {
        const env = { extra: { greeting: 'hello there' } };
        expect(resolveDisplayMacros('{{greeting}}', env)).toBe('hello there');
    });

    test('env.extra accepts function values', () => {
        let count = 0;
        const env = { extra: { counter: () => String(++count) } };
        expect(resolveDisplayMacros('{{counter}} {{counter}}', env)).toBe('1 2');
    });

    test('missing env returns empty string for known macros', () => {
        expect(resolveDisplayMacros('{{user}}', {})).toBe('');
        expect(resolveDisplayMacros('{{time}}', {})).toBe('');
        expect(resolveDisplayMacros('{{getvar::x}}', {})).toBe('');
    });

    test('handles unterminated macro by emitting verbatim', () => {
        expect(resolveDisplayMacros('text {{user', { user: 'M' })).toBe('text {{user');
    });

    test('handles side-effect inner with display outer', () => {
        // Outer is display (unknown returns literal), inner side-effect stays
        // and the nested-resolution pass returns the side-effect literal as-is.
        // Then outer renderer gets the literal as inner text. Since it's unknown
        // op, returns the original literal verbatim.
        const text = '{{custom::value::{{setvar::x::1}}}}';
        expect(resolveDisplayMacros(text, {})).toBe(text);
    });

    test('does not mutate env on resolve', () => {
        const env = { user: 'A', extra: { x: 'y' } };
        const snapshot = JSON.stringify(env);
        resolveDisplayMacros('{{user}} {{x}}', env);
        expect(JSON.stringify(env)).toBe(snapshot);
    });

    test('multiple macros in one string', () => {
        const env = {
            user: 'Martin',
            char: 'Athena',
            getvar: (n) => n === 'mood' ? 'happy' : '',
        };
        const out = resolveDisplayMacros('{{user}} says {{char}} feels {{getvar::mood}}', env);
        expect(out).toBe('Martin says Athena feels happy');
    });

    test('errors in env callables degrade to empty', () => {
        const env = {
            user: undefined,
            time: () => { throw new Error('boom'); },
            getvar: () => { throw new Error('nope'); },
        };
        const out = resolveDisplayMacros('{{time}} {{getvar::x}}', env);
        expect(out).toBe(' ');
    });

    test('resolves random via callable', () => {
        let calls = 0;
        const env = { random: () => `r${++calls}` };
        expect(resolveDisplayMacros('{{random}}-{{random}}', env)).toBe('r1-r2');
    });

    test('lastMessage / lastUserMessage / lastCharMessage', () => {
        const env = {
            lastMessage: () => 'm',
            lastUserMessage: () => 'u',
            lastCharMessage: () => 'c',
        };
        expect(resolveDisplayMacros('{{lastMessage}} {{lastUserMessage}} {{lastCharMessage}}', env))
            .toBe('m u c');
    });
});
