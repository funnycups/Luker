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

describe('scanner: pushvar/popvar recognition', () => {
    test('recognizes pushvar with value', () => {
        const m = findNextSideEffectMacro('{{pushvar::queue::sword}}');
        expect(m).toMatchObject({ op: 'pushvar', key: 'queue', rawValue: 'sword' });
    });

    test('recognizes popvar without value', () => {
        const m = findNextSideEffectMacro('{{popvar::queue}}');
        expect(m).toMatchObject({ op: 'popvar', key: 'queue' });
        expect(m.rawValue).toBeUndefined();
    });

    test('pushvar key prefix is not truncated to push', () => {
        const m = findNextSideEffectMacro('{{pushvar::q::x}}');
        expect(m.op).toBe('pushvar');
    });
});

describe('scanner: dotted path in key', () => {
    test('setvar with path returns split root and path', () => {
        const m = findNextSideEffectMacro('{{setvar::roster.alice.hp::50}}');
        expect(m).toMatchObject({ op: 'setvar', key: 'roster', path: 'alice.hp', rawValue: '50' });
    });

    test('deletevar with path returns split root and path', () => {
        const m = findNextSideEffectMacro('{{deletevar::roster.alice}}');
        expect(m).toMatchObject({ op: 'deletevar', key: 'roster', path: 'alice' });
    });

    test('pushvar with path', () => {
        const m = findNextSideEffectMacro('{{pushvar::roster.alice.inv::sword}}');
        expect(m).toMatchObject({ op: 'pushvar', key: 'roster', path: 'alice.inv', rawValue: 'sword' });
    });

    test('flat key has empty path field (undefined or empty)', () => {
        const m = findNextSideEffectMacro('{{setvar::hp::50}}');
        expect(m).toMatchObject({ op: 'setvar', key: 'hp', rawValue: '50' });
        expect(m.path === undefined || m.path === '').toBe(true);
    });

    test('value with embedded dot in macro is not mis-split', () => {
        // The body's `.` inside a nested {{...}} should not be treated as a
        // path separator on the key — only the literal key portion (before `::`).
        const m = findNextSideEffectMacro('{{pushvar::queue::{{getvar::other.field}}}}');
        expect(m.op).toBe('pushvar');
        expect(m.key).toBe('queue');
        expect(m.path === undefined || m.path === '').toBe(true);
    });
});

describe('scanner: JSON-shaped value with trailing }', () => {
    // The macro-close `}}` and a JSON value's own closing `}` are visually
    // adjacent in inputs like `{{setvar::a::{"x":1}}}`. A naive `}}` close
    // would eat the JSON's last `}`. The scanner's rule: when at depth 0
    // and the next char after `}}` is *also* `}`, the first `}` is value
    // content and the macro close is the LAST `}}` in the run.

    test('setvar with flat JSON object value preserves the JSON close', () => {
        const m = findNextSideEffectMacro('{{setvar::config::{"x":1}}}');
        expect(m.op).toBe('setvar');
        expect(m.key).toBe('config');
        expect(m.rawValue).toBe('{"x":1}');
        expect(m.literal).toBe('{{setvar::config::{"x":1}}}');
    });

    test('setvar at path with JSON object value', () => {
        const m = findNextSideEffectMacro('{{setvar::roster.alice::{"hp":50}}}');
        expect(m).toMatchObject({
            op: 'setvar',
            key: 'roster',
            path: 'alice',
            rawValue: '{"hp":50}',
        });
    });

    test('setvar with nested-JSON value (two trailing })', () => {
        // Value: {"a":{"b":1}} — JSON has 2 trailing `}`s + macro close = 4 `}`s in a row.
        const m = findNextSideEffectMacro('{{setvar::data::{"a":{"b":1}}}}');
        expect(m.op).toBe('setvar');
        expect(m.rawValue).toBe('{"a":{"b":1}}');
    });

    test('pushvar with JSON object value', () => {
        const m = findNextSideEffectMacro('{{pushvar::roster::{"name":"Alice"}}}');
        expect(m.op).toBe('pushvar');
        expect(m.key).toBe('roster');
        expect(m.rawValue).toBe('{"name":"Alice"}');
    });

    test('setvar with JSON array value', () => {
        const m = findNextSideEffectMacro('{{setvar::inv::[1,2,3]}}');
        expect(m.rawValue).toBe('[1,2,3]');
    });

    test('JSON value with a literal } inside a string is preserved', () => {
        // The `}` inside "hello }" is content; the rule still picks the
        // rightmost `}}` as the close.
        const m = findNextSideEffectMacro('{{setvar::a::{"k":"hello }"}}}');
        expect(m.op).toBe('setvar');
        expect(m.rawValue).toBe('{"k":"hello }"}');
    });

    test('macro followed by literal } in narrative absorbs into value (documented regression)', () => {
        // Documented limitation of the trailing-run rule: a `}` immediately
        // after the macro is treated as value content. Authors needing this
        // shape should put whitespace between the macro and the trailing `}`.
        const m = findNextSideEffectMacro('{{setvar::mood::happy}}} more');
        expect(m.rawValue).toBe('happy}');
    });

    test('macro followed by space then } is not absorbed', () => {
        const m = findNextSideEffectMacro('{{setvar::mood::happy}} } more');
        expect(m.rawValue).toBe('happy');
        expect(m.literal).toBe('{{setvar::mood::happy}}');
    });

    test('empty value with no trailing } closes normally', () => {
        const m = findNextSideEffectMacro('{{setvar::flag::}}');
        expect(m.rawValue).toBe('');
    });

    test('rawValue runs back-to-back with another macro after it', () => {
        const matches = scanAllSideEffectMacros('{{setvar::a::{"x":1}}}{{incvar::n}}');
        expect(matches).toHaveLength(2);
        expect(matches[0]).toMatchObject({ op: 'setvar', key: 'a', rawValue: '{"x":1}' });
        expect(matches[1]).toMatchObject({ op: 'incvar', key: 'n' });
    });
});

describe('scanner: variable shorthand side-effect forms', () => {
    test('recognizes `{{.x = 5}}`', () => {
        const m = findNextSideEffectMacro('{{.x = 5}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '=', key: 'x', rawValue: '5' });
        expect(m.literal).toBe('{{.x = 5}}');
    });

    test('recognizes `{{.x=5}}` without surrounding whitespace', () => {
        const m = findNextSideEffectMacro('{{.x=5}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '=', key: 'x', rawValue: '5' });
    });

    test('recognizes `{{.x += 1}}`', () => {
        const m = findNextSideEffectMacro('{{.x += 1}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '+=', key: 'x', rawValue: '1' });
    });

    test('recognizes `{{.x -= 2}}`', () => {
        const m = findNextSideEffectMacro('{{.x -= 2}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '-=', key: 'x', rawValue: '2' });
    });

    test('recognizes `{{.x++}}` and `{{.x--}}` with no value', () => {
        expect(findNextSideEffectMacro('{{.x++}}')).toMatchObject({ op: 'subvar', shorthand: '++', key: 'x' });
        expect(findNextSideEffectMacro('{{.x--}}')).toMatchObject({ op: 'subvar', shorthand: '--', key: 'x' });
        expect(findNextSideEffectMacro('{{.x++}}').rawValue).toBeUndefined();
    });

    test('recognizes `{{.x ||= 0}}` and `{{.x ??= 1}}`', () => {
        expect(findNextSideEffectMacro('{{.x ||= 0}}')).toMatchObject({ op: 'subvar', shorthand: '||=', key: 'x', rawValue: '0' });
        expect(findNextSideEffectMacro('{{.x ??= 1}}')).toMatchObject({ op: 'subvar', shorthand: '??=', key: 'x', rawValue: '1' });
    });

    test('dotted shorthand splits root and path', () => {
        const m = findNextSideEffectMacro('{{.roster.alice.hp = 50}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '=', key: 'roster', path: 'alice.hp', rawValue: '50' });
    });

    test('rejects pure read `{{.x}}` (no operator → no side effect)', () => {
        expect(findNextSideEffectMacro('{{.x}}')).toBeNull();
    });

    test('rejects comparison ops (`==`, `!=`, `<=`, etc.)', () => {
        // Pure reads, no side effect — must not be captured by the op-log.
        expect(findNextSideEffectMacro('{{.x == 1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{.x != 1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{.x > 1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{.x >= 1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{.x < 1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{.x <= 1}}')).toBeNull();
    });

    test('rejects logical-read ops `||` and `??` (no assign)', () => {
        expect(findNextSideEffectMacro('{{.x || default}}')).toBeNull();
        expect(findNextSideEffectMacro('{{.x ?? default}}')).toBeNull();
    });

    test('rejects global-shorthand writes (`$x = 1` is out of scope, mirrors setglobalvar exclusion)', () => {
        expect(findNextSideEffectMacro('{{$x = 1}}')).toBeNull();
        expect(findNextSideEffectMacro('{{$x++}}')).toBeNull();
    });

    test('rejects identifiers that don\'t look like vars', () => {
        // Numeric leading char is not a valid identifier.
        expect(findNextSideEffectMacro('{{.1x = 1}}')).toBeNull();
        // Trailing dash is rejected (var rules: must end in word char).
        expect(findNextSideEffectMacro('{{.x- = 1}}')).toBeNull();
    });

    test('shorthand value tolerates nested display macros', () => {
        const m = findNextSideEffectMacro('{{.greeting = hi {{user}}}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '=', key: 'greeting' });
        expect(m.rawValue).toBe('hi {{user}}');
    });

    test('JSON-trailing rule applies to shorthand value', () => {
        const m = findNextSideEffectMacro('{{.config = {"x":1}}}');
        expect(m).toMatchObject({ op: 'subvar', shorthand: '=', key: 'config', rawValue: '{"x":1}' });
        expect(m.literal).toBe('{{.config = {"x":1}}}');
    });

    test('scanAllSideEffectMacros mixes conventional + shorthand in order', () => {
        const text = '{{setvar::a::1}} mid {{.b = 2}} end {{.c++}}';
        const matches = scanAllSideEffectMacros(text);
        expect(matches.map(m => m.key)).toEqual(['a', 'b', 'c']);
        expect(matches.map(m => m.op)).toEqual(['setvar', 'subvar', 'subvar']);
        expect(matches.map(m => m.shorthand)).toEqual([undefined, '=', '++']);
    });

    test('stripSideEffectMacros removes shorthand writes too', () => {
        expect(stripSideEffectMacros('A{{.x = 1}}B{{.y++}}C')).toBe('ABC');
    });

    test('shorthand obeys backslash escape', () => {
        // The conventional-form escape applies uniformly — `\{{.x = 1}}` is
        // treated as literal narrative text.
        expect(findNextSideEffectMacro('text \\{{.x = 1}} more')).toBeNull();
    });
});
