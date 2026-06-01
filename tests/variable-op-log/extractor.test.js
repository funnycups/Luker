import { describe, test, expect } from '@jest/globals';
import { extractFromText, extractFromMessage } from '../../public/scripts/variable-op-log/extractor.js';

describe('extractor: extractFromText', () => {
    test('returns input unchanged when no macros', () => {
        const state = {};
        const result = extractFromText('plain text', state, () => ({}));
        expect(result.mes).toBe('plain text');
        expect(result.ops).toEqual([]);
        expect(state).toEqual({});
    });

    test('extracts a single setvar', () => {
        const state = {};
        const result = extractFromText('hp is now {{setvar::hp::50}} ok', state, () => ({}));
        expect(result.mes).toBe('hp is now  ok');
        expect(result.ops).toEqual([{ op: 'setvar', key: 'hp', value: '50' }]);
        expect(state.hp).toBe('50');
    });

    test('extracts multiple ops in source order', () => {
        const state = {};
        const result = extractFromText(
            '{{setvar::a::1}}-{{incvar::b}}-{{decvar::c}}-{{deletevar::d}}',
            state,
            () => ({}),
        );
        expect(result.mes).toBe('---');
        expect(result.ops.map(o => o.op)).toEqual(['setvar', 'incvar', 'decvar', 'deletevar']);
        expect(result.ops.map(o => o.key)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('sequential resolve: later setvar can read earlier setvar value', () => {
        const state = {};
        const env = () => ({ getvar: (k) => state[k] ?? '' });
        const result = extractFromText(
            '{{setvar::a::1}} {{setvar::b::{{getvar::a}}}}',
            state,
            env,
        );
        expect(result.ops).toEqual([
            { op: 'setvar', key: 'a', value: '1' },
            { op: 'setvar', key: 'b', value: '1' },
        ]);
        expect(state).toEqual({ a: '1', b: '1' });
    });

    test('resolves {{user}} and {{char}} in setvar value', () => {
        const state = {};
        const env = () => ({ user: 'Martin', char: 'Athena' });
        const result = extractFromText(
            '{{setvar::greeting::hi {{user}}, I am {{char}}}}',
            state,
            env,
        );
        expect(result.ops[0].value).toBe('hi Martin, I am Athena');
    });

    test('does not execute side-effect macros nested in value', () => {
        // Inner setvar should be left as literal — only the outer is executed
        const state = {};
        const result = extractFromText(
            '{{setvar::a::nested {{setvar::b::1}} value}}',
            state,
            () => ({}),
        );
        expect(result.ops).toHaveLength(1);
        expect(result.ops[0].key).toBe('a');
        expect(result.ops[0].value).toBe('nested {{setvar::b::1}} value');
        expect(state.a).toBe('nested {{setvar::b::1}} value');
        expect('b' in state).toBe(false);
    });

    test('addvar numeric', () => {
        const state = { x: '5' };
        const result = extractFromText('{{addvar::x::3}}', state, () => ({}));
        expect(state.x).toBe(8);
        expect(result.ops[0]).toEqual({ op: 'addvar', key: 'x', value: '3' });
    });

    test('incvar / decvar do not have value', () => {
        const state = { t: '10' };
        const result = extractFromText('{{incvar::t}}{{decvar::t}}', state, () => ({}));
        expect(result.ops[0]).toEqual({ op: 'incvar', key: 't' });
        expect(result.ops[1]).toEqual({ op: 'decvar', key: 't' });
        expect(state.t).toBe(10);
    });

    test('preserves text positions exactly when stripping', () => {
        const result = extractFromText(
            'A{{setvar::x::1}}B{{incvar::y}}C',
            {},
            () => ({}),
        );
        expect(result.mes).toBe('ABC');
    });

    test('global variable macros are not extracted', () => {
        const state = {};
        const result = extractFromText(
            'before {{setglobalvar::g::1}} after',
            state,
            () => ({}),
        );
        expect(result.mes).toBe('before {{setglobalvar::g::1}} after');
        expect(result.ops).toEqual([]);
        expect(state).toEqual({});
    });

    test('idempotent: running extract twice has no further effect', () => {
        const state = {};
        const first = extractFromText('hi {{setvar::a::1}}', state, () => ({}));
        const second = extractFromText(first.mes, state, () => ({}));
        expect(second.mes).toBe('hi ');
        expect(second.ops).toEqual([]);
        expect(state.a).toBe('1');
    });

    test('continue scenario: re-extract on appended text only finds new macros', () => {
        const state = {};
        // First pass — original message
        let mes = 'opens door {{setvar::hp::50}}';
        const r1 = extractFromText(mes, state, () => ({}));
        mes = r1.mes; // "opens door "

        // Continue: append new tokens to the cleaned mes
        mes += ' room is empty {{setvar::tension::high}}';
        const r2 = extractFromText(mes, state, () => ({}));

        expect(r2.ops).toEqual([{ op: 'setvar', key: 'tension', value: 'high' }]);
        expect(r2.mes).toBe('opens door  room is empty ');
        expect(state).toEqual({ hp: '50', tension: 'high' });
    });

    test('handles non-string input gracefully', () => {
        const result = extractFromText(null, {}, () => ({}));
        expect(result.mes).toBe('');
        expect(result.ops).toEqual([]);
    });

    test('null state does not crash', () => {
        const result = extractFromText('{{setvar::a::1}}', null, () => ({}));
        expect(result.ops).toEqual([{ op: 'setvar', key: 'a', value: '1' }]);
    });
});

describe('extractor: extractFromMessage', () => {
    test('mutates message.mes and pushes ops to extra.var_ops', () => {
        const state = {};
        const message = { mes: 'hi {{setvar::x::1}} bye', extra: {} };
        const ops = extractFromMessage(message, state, () => ({}));

        expect(message.mes).toBe('hi  bye');
        expect(message.extra.var_ops).toEqual([{ op: 'setvar', key: 'x', value: '1' }]);
        expect(ops).toEqual([{ op: 'setvar', key: 'x', value: '1' }]);
        expect(state.x).toBe('1');
    });

    test('appends to existing var_ops without replacing', () => {
        const state = {};
        const message = {
            mes: '{{setvar::b::2}}',
            extra: { var_ops: [{ op: 'setvar', key: 'a', value: '1' }] },
        };
        extractFromMessage(message, state, () => ({}));
        expect(message.extra.var_ops).toEqual([
            { op: 'setvar', key: 'a', value: '1' },
            { op: 'setvar', key: 'b', value: '2' },
        ]);
    });

    test('initializes missing extra/var_ops', () => {
        const state = {};
        const message = { mes: '{{setvar::a::1}}' };
        extractFromMessage(message, state, () => ({}));
        expect(message.extra).toBeDefined();
        expect(message.extra.var_ops).toEqual([{ op: 'setvar', key: 'a', value: '1' }]);
    });

    test('returns empty array and leaves message untouched if no macros', () => {
        const message = { mes: 'plain text', extra: { var_ops: [{ op: 'setvar', key: 'x' }] } };
        const result = extractFromMessage(message, {}, () => ({}));
        expect(result).toEqual([]);
        expect(message.mes).toBe('plain text');
        expect(message.extra.var_ops).toEqual([{ op: 'setvar', key: 'x' }]);
    });

    test('handles undefined message gracefully', () => {
        expect(extractFromMessage(undefined, {}, () => ({}))).toEqual([]);
        expect(extractFromMessage(null, {}, () => ({}))).toEqual([]);
        expect(extractFromMessage({}, {}, () => ({}))).toEqual([]);
    });
});

describe('extractor: path field propagates from match into op record', () => {
    test('setvar with path produces op with path', () => {
        const state = {};
        const { ops } = extractFromText('Pre {{setvar::roster.alice.hp::50}} post', state, () => ({}));
        expect(ops).toEqual([{ op: 'setvar', key: 'roster', path: 'alice.hp', value: '50' }]);
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('pushvar with value yields op carrying value', () => {
        const state = {};
        const { ops } = extractFromText('{{pushvar::queue::a}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'pushvar', key: 'queue', value: 'a' }]);
        expect(JSON.parse(state.queue)).toEqual(['a']);
    });

    test('popvar yields op without value', () => {
        const state = { queue: JSON.stringify(['a', 'b']) };
        const { ops } = extractFromText('{{popvar::queue}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'popvar', key: 'queue' }]);
        expect(JSON.parse(state.queue)).toEqual(['a']);
    });

    test('chained path ops in one message all run forward', () => {
        const state = {};
        const { ops } = extractFromText(
            '{{setvar::roster.alice.hp::50}} {{pushvar::roster.alice.inv::sword}} {{deletevar::roster.alice.hp}}',
            state,
            () => ({}),
        );
        expect(ops.length).toBe(3);
        expect(JSON.parse(state.roster)).toEqual({ alice: { inv: ['sword'] } });
    });

    test('flat ops still produce path-free records', () => {
        const state = {};
        const { ops } = extractFromText('{{setvar::hp::50}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'setvar', key: 'hp', value: '50' }]);
        expect(ops[0].path).toBeUndefined();
    });
});

describe('extractor: variable shorthand → canonical VarOps', () => {
    test('`{{.x = 5}}` → setvar', () => {
        const state = {};
        const { mes, ops } = extractFromText('hp is {{.x = 5}} ok', state, () => ({}));
        expect(mes).toBe('hp is  ok');
        expect(ops).toEqual([{ op: 'setvar', key: 'x', value: '5' }]);
        expect(state.x).toBe('5');
    });

    test('`{{.x += 3}}` → addvar', () => {
        const state = { x: '5' };
        const { ops } = extractFromText('{{.x += 3}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'addvar', key: 'x', value: '3' }]);
        expect(state.x).toBe(8);
    });

    test('`{{.x -= 2}}` → addvar with negated value', () => {
        const state = { x: '10' };
        const { ops } = extractFromText('{{.x -= 2}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'addvar', key: 'x', value: '-2' }]);
        expect(state.x).toBe(8);
    });

    test('`{{.x -= nope}}` (non-numeric) is a no-op but literal is stripped', () => {
        const state = { x: '10' };
        const { mes, ops } = extractFromText('A{{.x -= nope}}B', state, () => ({}));
        expect(mes).toBe('AB');
        expect(ops).toEqual([]);
        expect(state.x).toBe('10');
    });

    test('`{{.x++}}` / `{{.x--}}` → incvar / decvar', () => {
        const state = { t: '10' };
        const { ops } = extractFromText('{{.t++}}{{.t--}}', state, () => ({}));
        expect(ops).toEqual([
            { op: 'incvar', key: 't' },
            { op: 'decvar', key: 't' },
        ]);
        expect(state.t).toBe(10);
    });

    test('`{{.x ||= v}}` writes only when current is falsy', () => {
        const falsy = {};
        const { ops: ops1 } = extractFromText('{{.x ||= seeded}}', falsy, () => ({}));
        expect(ops1).toEqual([{ op: 'setvar', key: 'x', value: 'seeded' }]);
        expect(falsy.x).toBe('seeded');

        const populated = { x: 'already' };
        const { mes, ops: ops2 } = extractFromText('A{{.x ||= seeded}}B', populated, () => ({}));
        expect(mes).toBe('AB');
        expect(ops2).toEqual([]);
        expect(populated.x).toBe('already');
    });

    test('`||=` treats ST falsy strings (\'0\', \'false\', \'off\') as falsy', () => {
        const state = { x: '0' };
        const { ops } = extractFromText('{{.x ||= 7}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'setvar', key: 'x', value: '7' }]);
        expect(state.x).toBe('7');
    });

    test('`{{.x ??= v}}` writes only when current is undefined', () => {
        const absent = {};
        const { ops: ops1 } = extractFromText('{{.x ??= init}}', absent, () => ({}));
        expect(ops1).toEqual([{ op: 'setvar', key: 'x', value: 'init' }]);

        const empty = { x: '' };
        // Empty string IS defined — `??=` doesn't write.
        const { ops: ops2 } = extractFromText('{{.x ??= init}}', empty, () => ({}));
        expect(ops2).toEqual([]);
        expect(empty.x).toBe('');
    });

    test('shorthand value can read prior shorthand effect in same message', () => {
        const state = {};
        const env = () => ({ getvar: (k) => state[k] ?? '' });
        const { ops } = extractFromText('{{.a = 1}} {{.b = {{.a}}}}', state, env);
        expect(ops).toEqual([
            { op: 'setvar', key: 'a', value: '1' },
            { op: 'setvar', key: 'b', value: '1' },
        ]);
        expect(state).toEqual({ a: '1', b: '1' });
    });

    test('dotted shorthand routes through path-flavored setvar', () => {
        const state = {};
        const { ops } = extractFromText('{{.roster.alice.hp = 50}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'setvar', key: 'roster', path: 'alice.hp', value: '50' }]);
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('dotted `||=` checks the leaf, not the root', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 0 } }) };
        const { ops } = extractFromText('{{.roster.alice.hp ||= 50}}', state, () => ({}));
        expect(ops).toEqual([{ op: 'setvar', key: 'roster', path: 'alice.hp', value: '50' }]);
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('dotted `??=` no-op when leaf is defined (even if empty string)', () => {
        const state = { roster: JSON.stringify({ alice: { hp: '' } }) };
        const { ops } = extractFromText('{{.roster.alice.hp ??= 50}}', state, () => ({}));
        expect(ops).toEqual([]);
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: '' } });
    });

    test('shorthand and conventional macros mix correctly in source order', () => {
        const state = {};
        const { mes, ops } = extractFromText(
            '{{setvar::a::1}} {{.b = 2}} {{incvar::c}} {{.d++}}',
            state,
            () => ({}),
        );
        expect(mes).toBe('   ');
        expect(ops.map(o => o.op)).toEqual(['setvar', 'setvar', 'incvar', 'incvar']);
        expect(ops.map(o => o.key)).toEqual(['a', 'b', 'c', 'd']);
    });
});
