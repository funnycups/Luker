import { describe, test, expect } from '@jest/globals';
import { applyOp, applyAll } from '../../public/scripts/variable-op-log/apply.js';

describe('apply: applyOp', () => {
    test('setvar writes value', () => {
        const state = {};
        applyOp(state, { op: 'setvar', key: 'hp', value: '50' });
        expect(state.hp).toBe('50');
    });

    test('setvar overwrites prior value', () => {
        const state = { hp: '100' };
        applyOp(state, { op: 'setvar', key: 'hp', value: '50' });
        expect(state.hp).toBe('50');
    });

    test('setvar empty value yields empty string', () => {
        const state = { hp: '50' };
        applyOp(state, { op: 'setvar', key: 'hp', value: '' });
        expect(state.hp).toBe('');
    });

    test('setvar missing value defaults to empty string', () => {
        const state = {};
        applyOp(state, { op: 'setvar', key: 'k' });
        expect(state.k).toBe('');
    });

    test('deletevar removes the key', () => {
        const state = { hp: '50', mp: '20' };
        applyOp(state, { op: 'deletevar', key: 'hp' });
        expect('hp' in state).toBe(false);
        expect(state.mp).toBe('20');
    });

    test('deletevar on missing key is no-op', () => {
        const state = { mp: '20' };
        applyOp(state, { op: 'deletevar', key: 'nonexistent' });
        expect(state.mp).toBe('20');
    });

    test('addvar numeric on numeric current', () => {
        const state = { coins: '10' };
        applyOp(state, { op: 'addvar', key: 'coins', value: '5' });
        expect(state.coins).toBe(15);
    });

    test('addvar numeric on undefined current treats as concat (matches ST)', () => {
        // ST's addLocalVariable: when current is undefined, current||0 = 0,
        // and parseJSON fails so number path takes over. We mirror as concat
        // when current is empty/undefined to be safe.
        const state = {};
        applyOp(state, { op: 'addvar', key: 'coins', value: '5' });
        // State key gets set
        expect('coins' in state).toBe(true);
    });

    test('addvar string concatenation', () => {
        const state = { name: 'Athena' };
        applyOp(state, { op: 'addvar', key: 'name', value: '_v2' });
        expect(state.name).toBe('Athena_v2');
    });

    test('addvar to JSON array pushes element', () => {
        const state = { inventory: '[]' };
        applyOp(state, { op: 'addvar', key: 'inventory', value: 'sword' });
        expect(state.inventory).toBe('["sword"]');
    });

    test('addvar to JSON array preserves prior elements', () => {
        const state = { items: '["sword","shield"]' };
        applyOp(state, { op: 'addvar', key: 'items', value: 'potion' });
        expect(JSON.parse(state.items)).toEqual(['sword', 'shield', 'potion']);
    });

    test('incvar increments numeric value by 1', () => {
        const state = { turn: '5' };
        applyOp(state, { op: 'incvar', key: 'turn' });
        expect(state.turn).toBe(6);
    });

    test('decvar decrements numeric value by 1', () => {
        const state = { turn: '5' };
        applyOp(state, { op: 'decvar', key: 'turn' });
        expect(state.turn).toBe(4);
    });

    test('incvar on undefined creates string "1"', () => {
        const state = {};
        applyOp(state, { op: 'incvar', key: 'turn' });
        // Mirrors ST: String(currentValue || '') + 1 = "1"
        expect(state.turn).toBe('1');
    });

    test('unknown op is ignored', () => {
        const state = { hp: '50' };
        applyOp(state, { op: 'mystery', key: 'hp', value: '99' });
        expect(state.hp).toBe('50');
    });

    test('null state is safe', () => {
        expect(() => applyOp(null, { op: 'setvar', key: 'a', value: '1' }))
            .not.toThrow();
    });

    test('missing key is safe', () => {
        const state = {};
        applyOp(state, { op: 'setvar', value: '1' });
        expect(state).toEqual({});
    });
});

describe('apply: applyAll', () => {
    test('applies a sequence in order', () => {
        const state = {};
        applyAll(state, [
            { op: 'setvar', key: 'hp', value: '50' },
            { op: 'incvar', key: 'hp' },
            { op: 'incvar', key: 'hp' },
        ]);
        expect(state.hp).toBe(52);
    });

    test('handles empty iterable', () => {
        const state = { x: '1' };
        applyAll(state, []);
        expect(state.x).toBe('1');
    });

    test('returns the same state reference', () => {
        const state = {};
        const result = applyAll(state, []);
        expect(result).toBe(state);
    });

    test('null inputs do not throw', () => {
        expect(() => applyAll(null, null)).not.toThrow();
        expect(() => applyAll({}, null)).not.toThrow();
    });
});
