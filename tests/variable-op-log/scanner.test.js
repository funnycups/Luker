import { describe, test, expect } from '@jest/globals';
import {
    findNextSideEffectMacro,
    scanAllSideEffectMacros,
    stripSideEffectMacros,
} from '../../public/scripts/variable-op-log/scanner.js';

describe('scanner: findNextSideEffectMacro', () => {
    test('returns null on empty input', () => {
        expect(findNextSideEffectMacro('')).toBeNull();
        expect(findNextSideEffectMacro('   ')).toBeNull();
    });

    test('returns null when no macros present', () => {
        expect(findNextSideEffectMacro('plain text')).toBeNull();
        expect(findNextSideEffectMacro('text with {{user}} and {{getvar::x}}')).toBeNull();
    });

    test('finds a setvar macro', () => {
        const text = 'before {{setvar::hp::50}} after';
        const m = findNextSideEffectMacro(text);
        expect(m).not.toBeNull();
        expect(m.op).toBe('setvar');
        expect(m.key).toBe('hp');
        expect(m.rawValue).toBe('50');
        expect(text.slice(m.start, m.end)).toBe('{{setvar::hp::50}}');
    });

    test('finds a setvar with empty value', () => {
        const text = '{{setvar::flag::}}';
        const m = findNextSideEffectMacro(text);
        expect(m.op).toBe('setvar');
        expect(m.key).toBe('flag');
        expect(m.rawValue).toBe('');
    });

    test('finds an addvar macro', () => {
        const m = findNextSideEffectMacro('{{addvar::counter::5}}');
        expect(m.op).toBe('addvar');
        expect(m.key).toBe('counter');
        expect(m.rawValue).toBe('5');
    });

    test('finds an incvar macro (no value)', () => {
        const m = findNextSideEffectMacro('{{incvar::turn}}');
        expect(m.op).toBe('incvar');
        expect(m.key).toBe('turn');
        expect(m.rawValue).toBeUndefined();
    });

    test('finds a decvar macro', () => {
        const m = findNextSideEffectMacro('{{decvar::lives}}');
        expect(m.op).toBe('decvar');
        expect(m.key).toBe('lives');
    });

    test('finds a deletevar macro', () => {
        const m = findNextSideEffectMacro('{{deletevar::flag}}');
        expect(m.op).toBe('deletevar');
        expect(m.key).toBe('flag');
    });

    test('is case-insensitive on op name', () => {
        expect(findNextSideEffectMacro('{{SETVAR::a::1}}').op).toBe('setvar');
        expect(findNextSideEffectMacro('{{IncVar::n}}').op).toBe('incvar');
    });

    test('preserves original case in key and value', () => {
        const m = findNextSideEffectMacro('{{setvar::HeroName::Athena}}');
        expect(m.key).toBe('HeroName');
        expect(m.rawValue).toBe('Athena');
    });

    test('respects cursor parameter', () => {
        const text = '{{setvar::a::1}} {{setvar::b::2}}';
        const first = findNextSideEffectMacro(text, 0);
        expect(first.key).toBe('a');
        const second = findNextSideEffectMacro(text, first.end);
        expect(second.key).toBe('b');
        expect(findNextSideEffectMacro(text, second.end)).toBeNull();
    });

    test('does not match global variable macros', () => {
        expect(findNextSideEffectMacro('{{setglobalvar::g::1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{addglobalvar::g::1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{incglobalvar::g}}')).toBeNull();
        expect(findNextSideEffectMacro('{{decglobalvar::g}}')).toBeNull();
    });

    test('does not match getvar / hasvar / display macros', () => {
        expect(findNextSideEffectMacro('{{getvar::x}}')).toBeNull();
        expect(findNextSideEffectMacro('{{getglobalvar::x}}')).toBeNull();
        expect(findNextSideEffectMacro('{{user}}')).toBeNull();
        expect(findNextSideEffectMacro('{{char}}')).toBeNull();
        expect(findNextSideEffectMacro('{{time}}')).toBeNull();
    });

    test('rejects malformed macros (missing key)', () => {
        expect(findNextSideEffectMacro('{{setvar::::value}}')).toBeNull();
        expect(findNextSideEffectMacro('{{incvar::}}')).toBeNull();
    });

    test('rejects unterminated macros', () => {
        expect(findNextSideEffectMacro('{{setvar::a::1')).toBeNull();
        expect(findNextSideEffectMacro('start {{setvar::a::1 end')).toBeNull();
    });

    test('handles nested macros in value (balanced)', () => {
        const text = '{{setvar::log::user is {{user}} now}}';
        const m = findNextSideEffectMacro(text);
        expect(m).not.toBeNull();
        expect(m.op).toBe('setvar');
        expect(m.key).toBe('log');
        expect(m.rawValue).toBe('user is {{user}} now');
        expect(text.slice(m.start, m.end)).toBe(text);
    });

    test('handles deeply nested macros in value', () => {
        const text = '{{setvar::a::{{setvar::b::{{getvar::c}}}}}}';
        const m = findNextSideEffectMacro(text);
        expect(m).not.toBeNull();
        expect(m.op).toBe('setvar');
        expect(m.key).toBe('a');
        // Outer macro should swallow the entire nested structure
        expect(m.rawValue).toBe('{{setvar::b::{{getvar::c}}}}');
    });

    test('handles `::` inside nested macro without splitting on it', () => {
        const text = '{{setvar::name::{{getvar::other_key}}}}';
        const m = findNextSideEffectMacro(text);
        expect(m.key).toBe('name');
        expect(m.rawValue).toBe('{{getvar::other_key}}');
    });

    test('skips non-macro `{{` and continues scanning', () => {
        const text = 'literal {{ text and {{setvar::x::1}}';
        const m = findNextSideEffectMacro(text);
        expect(m).not.toBeNull();
        expect(m.key).toBe('x');
    });
});

describe('scanner: scanAllSideEffectMacros', () => {
    test('returns empty array on no matches', () => {
        expect(scanAllSideEffectMacros('plain')).toEqual([]);
        expect(scanAllSideEffectMacros('{{user}} {{char}}')).toEqual([]);
    });

    test('returns matches in source order', () => {
        const text = '{{setvar::a::1}} mid {{incvar::b}} end {{decvar::c}}';
        const matches = scanAllSideEffectMacros(text);
        expect(matches.map(m => m.key)).toEqual(['a', 'b', 'c']);
        expect(matches.map(m => m.op)).toEqual(['setvar', 'incvar', 'decvar']);
    });

    test('does not match overlapping or partial macros', () => {
        const text = '{{setvar::a::{{setvar::b::1}}}}';
        const matches = scanAllSideEffectMacros(text);
        expect(matches).toHaveLength(1);
        expect(matches[0].key).toBe('a');
        expect(matches[0].rawValue).toBe('{{setvar::b::1}}');
    });

    test('handles many macros without infinite loops', () => {
        let text = '';
        for (let i = 0; i < 100; i++) text += `{{setvar::k${i}::${i}}}`;
        const matches = scanAllSideEffectMacros(text);
        expect(matches).toHaveLength(100);
        expect(matches[0].key).toBe('k0');
        expect(matches[99].key).toBe('k99');
    });
});

describe('scanner: stripSideEffectMacros', () => {
    test('returns input unchanged when no matches', () => {
        expect(stripSideEffectMacros('plain text')).toBe('plain text');
        expect(stripSideEffectMacros('')).toBe('');
    });

    test('removes a single macro', () => {
        expect(stripSideEffectMacros('hello {{setvar::a::1}} world'))
            .toBe('hello  world');
    });

    test('removes multiple macros', () => {
        expect(stripSideEffectMacros('{{setvar::a::1}}before{{incvar::b}}after{{decvar::c}}'))
            .toBe('beforeafter');
    });

    test('preserves non-side-effect macros', () => {
        expect(stripSideEffectMacros('hi {{user}} {{setvar::a::1}}'))
            .toBe('hi {{user}} ');
    });

    test('preserves text before, between, and after macros', () => {
        expect(stripSideEffectMacros('A{{setvar::x::1}}B{{incvar::y}}C'))
            .toBe('ABC');
    });

    test('handles nested macros (whole thing removed)', () => {
        expect(stripSideEffectMacros('{{setvar::a::{{getvar::b}}}}'))
            .toBe('');
    });

    test('idempotent: stripping twice equals stripping once', () => {
        const text = 'one {{setvar::a::1}} two {{incvar::b}} three';
        const once = stripSideEffectMacros(text);
        const twice = stripSideEffectMacros(once);
        expect(twice).toBe(once);
        expect(once).toBe('one  two  three');
    });

    test('non-string input returns as-is', () => {
        // @ts-ignore — testing defensive behavior
        expect(stripSideEffectMacros(null)).toBeNull();
        // @ts-ignore
        expect(stripSideEffectMacros(undefined)).toBeUndefined();
    });
});
