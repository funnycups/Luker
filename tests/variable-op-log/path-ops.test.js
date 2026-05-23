import { describe, test, expect } from '@jest/globals';
import { splitRootAndPath, tryParseValue } from '../../public/scripts/variable-op-log/path-ops.js';
import { lodashSetPath, lodashDeletePath } from '../../public/scripts/variable-op-log/path-ops.js';
import { pushAtPath, popAtPath } from '../../public/scripts/variable-op-log/path-ops.js';
import { applyPathOp } from '../../public/scripts/variable-op-log/path-ops.js';

describe('splitRootAndPath', () => {
    test('plain key has empty path', () => {
        expect(splitRootAndPath('roster')).toEqual({ root: 'roster', path: '' });
    });

    test('dotted key splits on first dot', () => {
        expect(splitRootAndPath('roster.alice.hp')).toEqual({ root: 'roster', path: 'alice.hp' });
    });

    test('numeric segments stay in path string', () => {
        expect(splitRootAndPath('roster.0.hp')).toEqual({ root: 'roster', path: '0.hp' });
    });

    test('empty string yields empty root and path', () => {
        expect(splitRootAndPath('')).toEqual({ root: '', path: '' });
    });

    test('leading dot leaves empty root', () => {
        expect(splitRootAndPath('.alice')).toEqual({ root: '', path: 'alice' });
    });

    test('trailing dot is preserved in path', () => {
        expect(splitRootAndPath('roster.')).toEqual({ root: 'roster', path: '' });
    });
});

describe('tryParseValue', () => {
    test('JSON object string parses to object', () => {
        expect(tryParseValue('{"hp":40}')).toEqual({ hp: 40 });
    });

    test('JSON array string parses to array', () => {
        expect(tryParseValue('[1,2,3]')).toEqual([1, 2, 3]);
    });

    test('numeric string parses to number', () => {
        expect(tryParseValue('50')).toBe(50);
    });

    test('boolean string stays a string (primitive parse is preserved as string)', () => {
        expect(tryParseValue('true')).toBe('true');
        expect(tryParseValue('null')).toBe('null');
    });

    test('non-JSON string returns string unchanged', () => {
        expect(tryParseValue('Alice')).toBe('Alice');
    });

    test('non-string input returned as-is', () => {
        expect(tryParseValue(42)).toBe(42);
        expect(tryParseValue(undefined)).toBe(undefined);
        expect(tryParseValue(null)).toBe(null);
    });

    test('numeric string with leading zero preserved (parse to number)', () => {
        expect(tryParseValue('007')).toBe('007');
    });
});

describe('lodashSetPath', () => {
    test('sets a single-segment path on an empty object', () => {
        const obj = {};
        lodashSetPath(obj, 'hp', 50);
        expect(obj).toEqual({ hp: 50 });
    });

    test('sets a deep path, auto-creating intermediate objects', () => {
        const obj = {};
        lodashSetPath(obj, 'alice.hp', 50);
        expect(obj).toEqual({ alice: { hp: 50 } });
    });

    test('sets a deep path, auto-creating arrays for numeric segments', () => {
        const obj = {};
        lodashSetPath(obj, 'roster.0.hp', 50);
        expect(obj).toEqual({ roster: [{ hp: 50 }] });
    });

    test('overwrites scalar intermediate with container', () => {
        const obj = { alice: 'gone' };
        lodashSetPath(obj, 'alice.hp', 50);
        expect(obj).toEqual({ alice: { hp: 50 } });
    });

    test('overwrites existing leaf value', () => {
        const obj = { alice: { hp: 40 } };
        lodashSetPath(obj, 'alice.hp', 50);
        expect(obj.alice.hp).toBe(50);
    });

    test('numeric path on existing array writes by index', () => {
        const obj = { inv: ['sword'] };
        lodashSetPath(obj, 'inv.1', 'shield');
        expect(obj.inv).toEqual(['sword', 'shield']);
    });

    test('empty path is a no-op (caller should never reach here)', () => {
        const obj = { hp: 50 };
        lodashSetPath(obj, '', 99);
        expect(obj).toEqual({ hp: 50 });
    });

    test('skips empty segments from `roster..hp`', () => {
        const obj = {};
        lodashSetPath(obj, 'roster..hp', 50);
        expect(obj).toEqual({ roster: { hp: 50 } });
    });

    test('sets an object value at a leaf', () => {
        const obj = {};
        lodashSetPath(obj, 'alice', { hp: 50 });
        expect(obj).toEqual({ alice: { hp: 50 } });
    });

    test('rejects __proto__ as a path segment (prototype-pollution guard)', () => {
        const obj = {};
        lodashSetPath(obj, '__proto__.polluted', 'yes');
        expect(obj).toEqual({});
        expect({}.polluted).toBeUndefined();
    });

    test('rejects constructor and prototype segments anywhere in path', () => {
        const obj = {};
        lodashSetPath(obj, 'a.constructor.prototype.polluted', 'yes');
        expect(obj).toEqual({});
    });
});

describe('lodashDeletePath', () => {
    test('deletes a single-segment key from an object', () => {
        const obj = { hp: 50, mp: 20 };
        expect(lodashDeletePath(obj, 'hp')).toBe(true);
        expect(obj).toEqual({ mp: 20 });
    });

    test('deletes a deep object key', () => {
        const obj = { alice: { hp: 50, mp: 20 } };
        expect(lodashDeletePath(obj, 'alice.hp')).toBe(true);
        expect(obj).toEqual({ alice: { mp: 20 } });
    });

    test('splices array element when parent is an array', () => {
        const obj = { inv: ['a', 'b', 'c'] };
        expect(lodashDeletePath(obj, 'inv.1')).toBe(true);
        expect(obj.inv).toEqual(['a', 'c']);
    });

    test('returns false when path does not exist', () => {
        const obj = { alice: { hp: 50 } };
        expect(lodashDeletePath(obj, 'bob.hp')).toBe(false);
        expect(obj).toEqual({ alice: { hp: 50 } });
    });

    test('returns false when intermediate node is a scalar', () => {
        const obj = { alice: 'gone' };
        expect(lodashDeletePath(obj, 'alice.hp')).toBe(false);
    });

    test('empty path returns false', () => {
        const obj = { hp: 50 };
        expect(lodashDeletePath(obj, '')).toBe(false);
        expect(obj).toEqual({ hp: 50 });
    });

    test('rejects __proto__ as a path segment (silent no-op on delete)', () => {
        const obj = { hp: 50 };
        expect(lodashDeletePath(obj, '__proto__.hp')).toBe(false);
        expect(obj).toEqual({ hp: 50 });
    });
});

describe('pushAtPath', () => {
    test('pushes onto an existing array', () => {
        const obj = { inv: ['a'] };
        expect(pushAtPath(obj, 'inv', 'b')).toBe(true);
        expect(obj.inv).toEqual(['a', 'b']);
    });

    test('auto-creates the leaf array when missing', () => {
        const obj = {};
        expect(pushAtPath(obj, 'inv', 'a')).toBe(true);
        expect(obj.inv).toEqual(['a']);
    });

    test('auto-creates intermediate objects', () => {
        const obj = {};
        expect(pushAtPath(obj, 'alice.inv', 'sword')).toBe(true);
        expect(obj).toEqual({ alice: { inv: ['sword'] } });
    });

    test('refuses to push onto a non-array leaf', () => {
        const obj = { inv: 'broken' };
        const before = { ...obj };
        expect(pushAtPath(obj, 'inv', 'x')).toBe(false);
        expect(obj).toEqual(before);
    });

    test('refuses when intermediate is scalar', () => {
        const obj = { alice: 'gone' };
        expect(pushAtPath(obj, 'alice.inv', 'x')).toBe(false);
        expect(obj).toEqual({ alice: 'gone' });
    });

    test('empty path returns false', () => {
        expect(pushAtPath({}, '', 'x')).toBe(false);
    });

    test('pushes a structured value', () => {
        const obj = {};
        expect(pushAtPath(obj, 'roster', { name: 'Alice' })).toBe(true);
        expect(obj.roster).toEqual([{ name: 'Alice' }]);
    });

    test('rejects __proto__ path (prototype-pollution guard)', () => {
        const obj = {};
        expect(pushAtPath(obj, '__proto__.inv', 'x')).toBe(false);
        expect(obj).toEqual({});
    });
});

describe('popAtPath', () => {
    test('pops the last element from an array', () => {
        const obj = { inv: ['a', 'b'] };
        expect(popAtPath(obj, 'inv')).toBe('b');
        expect(obj.inv).toEqual(['a']);
    });

    test('returns undefined for empty array', () => {
        const obj = { inv: [] };
        expect(popAtPath(obj, 'inv')).toBeUndefined();
        expect(obj.inv).toEqual([]);
    });

    test('returns undefined when path does not exist', () => {
        const obj = {};
        expect(popAtPath(obj, 'inv')).toBeUndefined();
    });

    test('returns undefined when target is not an array', () => {
        const obj = { inv: 'hi' };
        expect(popAtPath(obj, 'inv')).toBeUndefined();
        expect(obj.inv).toBe('hi');
    });

    test('pops deep path', () => {
        const obj = { alice: { inv: ['sword', 'shield'] } };
        expect(popAtPath(obj, 'alice.inv')).toBe('shield');
        expect(obj.alice.inv).toEqual(['sword']);
    });

    test('rejects __proto__ path (prototype-pollution guard)', () => {
        const obj = {};
        expect(popAtPath(obj, '__proto__.inv')).toBeUndefined();
    });
});

describe('applyPathOp: setvar with path', () => {
    test('creates root object and writes leaf', () => {
        const state = {};
        applyPathOp(state, { op: 'setvar', key: 'roster', path: 'alice.hp', value: '50' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('writes JSON-object value at a path', () => {
        const state = {};
        applyPathOp(state, { op: 'setvar', key: 'roster', path: 'alice', value: '{"hp":50}' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('writes non-JSON string at a leaf', () => {
        const state = {};
        applyPathOp(state, { op: 'setvar', key: 'roster', path: 'alice.mood', value: 'calm' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { mood: 'calm' } });
    });

    test('preserves untouched sibling keys', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 }, bob: { hp: 30 } }) };
        applyPathOp(state, { op: 'setvar', key: 'roster', path: 'alice.hp', value: '40' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 40 }, bob: { hp: 30 } });
    });

    test('numeric path segment creates an array', () => {
        const state = {};
        applyPathOp(state, { op: 'setvar', key: 'inv', path: '0', value: 'sword' });
        expect(JSON.parse(state.inv)).toEqual(['sword']);
    });

    test('non-JSON top-level value is overwritten with object', () => {
        const state = { roster: 'literally a string' };
        applyPathOp(state, { op: 'setvar', key: 'roster', path: 'alice', value: '{"hp":50}' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });
});

describe('applyPathOp: deletevar with path', () => {
    test('deletes a leaf', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 }, bob: { hp: 30 } }) };
        applyPathOp(state, { op: 'deletevar', key: 'roster', path: 'bob' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('missing path is no-op (warn, do not throw)', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 } }) };
        applyPathOp(state, { op: 'deletevar', key: 'roster', path: 'charlie' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('missing top-level key is no-op', () => {
        const state = {};
        applyPathOp(state, { op: 'deletevar', key: 'roster', path: 'alice' });
        expect(state.roster).toBeUndefined();
    });
});

describe('applyPathOp: pushvar', () => {
    test('creates root array and pushes when no path', () => {
        const state = {};
        applyPathOp(state, { op: 'pushvar', key: 'queue', value: 'first' });
        expect(JSON.parse(state.queue)).toEqual(['first']);
    });

    test('pushes onto existing root array', () => {
        const state = { queue: JSON.stringify(['a']) };
        applyPathOp(state, { op: 'pushvar', key: 'queue', value: 'b' });
        expect(JSON.parse(state.queue)).toEqual(['a', 'b']);
    });

    test('pushes JSON value', () => {
        const state = {};
        applyPathOp(state, { op: 'pushvar', key: 'roster', value: '{"name":"Alice"}' });
        expect(JSON.parse(state.roster)).toEqual([{ name: 'Alice' }]);
    });

    test('numeric value pushes as number', () => {
        const state = {};
        applyPathOp(state, { op: 'pushvar', key: 'scores', value: '42' });
        expect(JSON.parse(state.scores)).toEqual([42]);
    });

    test('pushes at a path inside an object', () => {
        const state = { roster: JSON.stringify({ alice: { inv: ['sword'] } }) };
        applyPathOp(state, { op: 'pushvar', key: 'roster', path: 'alice.inv', value: 'shield' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { inv: ['sword', 'shield'] } });
    });

    test('auto-creates leaf array at path', () => {
        const state = { roster: JSON.stringify({ alice: {} }) };
        applyPathOp(state, { op: 'pushvar', key: 'roster', path: 'alice.inv', value: 'sword' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { inv: ['sword'] } });
    });
});

describe('applyPathOp: popvar', () => {
    test('pops from root array', () => {
        const state = { queue: JSON.stringify(['a', 'b']) };
        applyPathOp(state, { op: 'popvar', key: 'queue' });
        expect(JSON.parse(state.queue)).toEqual(['a']);
    });

    test('pop on empty array is no-op', () => {
        const state = { queue: JSON.stringify([]) };
        applyPathOp(state, { op: 'popvar', key: 'queue' });
        expect(JSON.parse(state.queue)).toEqual([]);
    });

    test('pop on missing key is no-op (does not create state)', () => {
        const state = {};
        applyPathOp(state, { op: 'popvar', key: 'queue' });
        expect(state.queue).toBeUndefined();
    });

    test('pop at path', () => {
        const state = { roster: JSON.stringify({ alice: { inv: ['sword', 'shield'] } }) };
        applyPathOp(state, { op: 'popvar', key: 'roster', path: 'alice.inv' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { inv: ['sword'] } });
    });
});

describe('applyPathOp: incvar / decvar with path', () => {
    test('incvar on missing leaf starts at 0 + 1', () => {
        const state = {};
        applyPathOp(state, { op: 'incvar', key: 'roster', path: 'alice.hp' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 1 } });
    });

    test('incvar on existing numeric leaf increments', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 49 } }) };
        applyPathOp(state, { op: 'incvar', key: 'roster', path: 'alice.hp' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('decvar on existing numeric leaf decrements', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 } }) };
        applyPathOp(state, { op: 'decvar', key: 'roster', path: 'alice.hp' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 49 } });
    });

    test('incvar on non-numeric leaf string-concats "1" (mirrors flat incvar semantics)', () => {
        const state = { roster: JSON.stringify({ alice: { mood: 'happy' } }) };
        applyPathOp(state, { op: 'incvar', key: 'roster', path: 'alice.mood' });
        const r = JSON.parse(state.roster);
        expect(r.alice.mood).toBe('happy1');
    });
});

describe('applyPathOp: forbidden-path rejection (prototype-pollution safety)', () => {
    test('setvar with forbidden path does not mutate state', () => {
        const state = {};
        applyPathOp(state, { op: 'setvar', key: 'roster', path: '__proto__.polluted', value: 'yes' });
        expect(state.roster).toBeUndefined();
        expect({}.polluted).toBeUndefined();
    });

    test('setvar with forbidden path preserves existing top-level value', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 } }) };
        applyPathOp(state, { op: 'setvar', key: 'roster', path: 'alice.__proto__.x', value: 'y' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('deletevar with forbidden path does not delete top-level', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 } }) };
        applyPathOp(state, { op: 'deletevar', key: 'roster', path: 'alice.__proto__' });
        expect(JSON.parse(state.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('pushvar with forbidden path does not push to root array', () => {
        const state = { roster: JSON.stringify(['a']) };
        applyPathOp(state, { op: 'pushvar', key: 'roster', path: '__proto__', value: 'b' });
        expect(JSON.parse(state.roster)).toEqual(['a']);
    });

    test('popvar with forbidden path does not pop root array', () => {
        const state = { queue: JSON.stringify(['a', 'b']) };
        applyPathOp(state, { op: 'popvar', key: 'queue', path: 'constructor' });
        expect(JSON.parse(state.queue)).toEqual(['a', 'b']);
    });
});

describe('applyPathOp: pushvar non-array leaf leaves state stable', () => {
    test('pushvar at non-array leaf does not mutate', () => {
        const state = { roster: JSON.stringify({ alice: { hp: 50 } }) };
        const before = state.roster;
        applyPathOp(state, { op: 'pushvar', key: 'roster', path: 'alice.hp', value: 'sword' });
        expect(state.roster).toBe(before);
    });
});
