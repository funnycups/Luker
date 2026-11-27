import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { applyPatch as realApplyJsonPatch, compare as compareJsonPatch } from '../public/scripts/util/fast-json-patch.js';
import { cloneAsJsonWire as realCloneAsJsonWire } from '../public/scripts/util/json-clone.js';

const scriptSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

function between(source, start, end) {
    const startAt = source.indexOf(start);
    if (startAt < 0) throw new Error(`Missing start boundary: ${start}`);
    const endAt = source.indexOf(end, startAt + start.length);
    if (endAt < 0) throw new Error(`Missing end boundary: ${end}`);
    return source.slice(startAt, endAt);
}

const helperSlice = between(
    scriptSource,
    'function decodeJsonPointerSegment(segment)',
    '\nexport async function buildChatMessagePatchOperations(',
);

function createPatchTestHarness() {
    const applyCalls = [];
    const cloneCalls = [];

    const applyJsonPatchSpy = (doc, patch, validateOperation, mutateDocument) => {
        applyCalls.push({ doc, patch, validateOperation, mutateDocument });
        return realApplyJsonPatch(doc, patch, validateOperation, mutateDocument);
    };

    const cloneAsJsonWireSpy = (value) => {
        cloneCalls.push(value);
        return realCloneAsJsonWire(value);
    };

    const context = vm.createContext({
        Array,
        Object,
        Number,
        String,
        Boolean,
        Set,
        Error,
        TypeError,
        JSON,
        applyJsonPatch: applyJsonPatchSpy,
        cloneAsJsonWire: cloneAsJsonWireSpy,
    });

    vm.runInContext(
        `${helperSlice}
        globalThis.__exports = {
            decodeJsonPointerSegment,
            getJsonPointerValue,
            attachObjectPatchTests,
            extractTopMessageIndexFromPath,
            attachChatMessagePatchTests,
        };`,
        context,
    );

    return {
        ...context.__exports,
        applyCalls,
        cloneCalls,
    };
}

describe('attachChatMessagePatchTests', () => {
    test('short-circuits on empty operations or non-array inputs without cloning', () => {
        const harness = createPatchTestHarness();
        const prev = [{ mes: 'a' }, { mes: 'b' }];

        expect(harness.attachChatMessagePatchTests(prev, [])).toEqual([]);
        expect(harness.cloneCalls).toHaveLength(0);
        expect(harness.applyCalls).toHaveLength(0);

        const ops = [{ op: 'replace', path: '/0/mes', value: 'x' }];
        expect(harness.attachChatMessagePatchTests(null, ops)).toEqual(ops);
        expect(harness.attachChatMessagePatchTests({}, ops)).toEqual(ops);
        expect(harness.cloneCalls).toHaveLength(0);
    });

    test('mutates only its local working copy in place and clones only touched messages (CoW)', () => {
        const harness = createPatchTestHarness();
        const prev = Array.from({ length: 200 }, (_, i) => ({
            name: i % 2 === 0 ? 'Assistant' : 'User',
            mes: `message-${i}`,
            extra: { count: i, nested: { flag: false } },
        }));
        const prevSnapshot = JSON.stringify(prev);

        const ops = [
            { op: 'replace', path: '/199/mes', value: 'message-199-edited' },
            { op: 'replace', path: '/199/extra/nested/flag', value: true },
            { op: 'add', path: '/199/extra/tag', value: 'updated' },
            { op: 'add', path: '/-', value: { name: 'Assistant', mes: 'message-200', extra: { count: 200 } } },
        ];

        const guarded = harness.attachChatMessagePatchTests(prev, ops);

        // Every applyJsonPatch call must pass mutateDocument = true to avoid O(K*M) cloning.
        expect(harness.applyCalls).toHaveLength(ops.length);
        for (const call of harness.applyCalls) {
            expect(call.mutateDocument).toBe(true);
        }

        // Must never deep-clone the entire 200-message array; only index 199 (once for test, once for CoW).
        expect(harness.cloneCalls.some(arg => Array.isArray(arg) && arg.length === 200)).toBe(false);
        expect(harness.cloneCalls).toHaveLength(2);

        // Input array and message objects must remain untouched.
        expect(JSON.stringify(prev)).toBe(prevSnapshot);
        expect(prev[199].mes).toBe('message-199');
        expect(prev[199].extra.nested.flag).toBe(false);
        expect(prev[199].extra.tag).toBeUndefined();

        // Single coalesced /199 test guard emitted before the consecutive /199 ops.
        expect(guarded.filter(op => op.op === 'test')).toEqual([
            { op: 'test', path: '/199', value: prev[199] },
        ]);

        // Replaying guarded operations against a server copy reaches the exact target state.
        const serverCopy = realCloneAsJsonWire(prev);
        const replayed = realApplyJsonPatch(serverCopy, guarded, true, false).newDocument;
        expect(replayed).toHaveLength(201);
        expect(replayed[199]).toEqual({
            name: 'User',
            mes: 'message-199-edited',
            extra: { count: 199, nested: { flag: true }, tag: 'updated' },
        });
        expect(replayed[200]).toEqual({ name: 'Assistant', mes: 'message-200', extra: { count: 200 } });
    });

    test('handles mixed index-shifting add/remove, pre-existing test, escaped pointers, and throwing invalid ops', () => {
        const harness = createPatchTestHarness();
        const prev = [
            { mes: '0', extra: { 'a/b': 1, 'x~y': 2, '': 'empty', k: 'v0' } },
            { mes: '1', extra: { k: 'v1' } },
            { mes: '2', extra: { k: 'v2' } },
            { mes: '3', extra: { k: 'v3' } },
        ];
        const prevSnapshot = JSON.stringify(prev);

        const ops = [
            { op: 'test', path: '/0', value: realCloneAsJsonWire(prev[0]) },
            { op: 'replace', path: '/0/extra/a~1b', value: 11 },
            { op: 'replace', path: '/0/extra/x~0y', value: 22 },
            { op: 'replace', path: '/0/extra/', value: 'editedEmpty' },
            { op: 'replace', path: '/99/mes', value: 'out-of-bounds-throws' },
            { op: 'replace', path: '/1/missing/deep', value: 'missing-parent-throws' },
            { op: 'remove', path: '/1' },
            { op: 'replace', path: '/1/mes', value: 'was-2-now-1' },
            { op: 'add', path: '/1', value: { mes: 'inserted-at-1' } },
            { op: 'replace', path: '/2/extra/k', value: 'was-2-now-2-again' },
        ];

        const guarded = harness.attachChatMessagePatchTests(prev, ops);

        expect(JSON.stringify(prev)).toBe(prevSnapshot);
        // Existing test on /0 prevents duplicate test for /0/extra/* ops;
        // invalid /1/missing/deep emits test for /1 (then throws without mutating),
        // subsequent remove /1 shares lastTestedIndex=1 (no duplicate test),
        // remove clears lastTestedIndex so shifted /1 (old msg 2) gets a fresh test,
        // add /1 clears lastTestedIndex so shifted /2 (old msg 2 after edit) gets a fresh test.
        const testOps = guarded.filter(op => op.op === 'test');
        expect(testOps).toEqual([
            { op: 'test', path: '/0', value: prev[0] },
            { op: 'test', path: '/1', value: prev[1] },
            { op: 'test', path: '/1', value: prev[2] },
            { op: 'test', path: '/2', value: { mes: 'was-2-now-1', extra: { k: 'v2' } } },
        ]);
    });

    test('normalizes sparse arrays, non-JSON primitives, aliased message refs, and custom toJSON without mutating inputs', () => {
        const harness = createPatchTestHarness();
        const sharedSub = { score: 10, tags: ['a'] };
        const sharedMsg = { mes: 'shared', extra: sharedSub };
        const customToJson = {
            mes: 'raw',
            toJSON() {
                return { mes: 'serialized', nested: { v: 1 } };
            },
        };
        const innerSparse = new Array(3);
        innerSparse[1] = 1;
        innerSparse[2] = undefined;
        const sparse = new Array(6);
        sparse[0] = { mes: 'hi', undef: undefined, arr: innerSparse };
        // slot 1 left as sparse hole
        sparse[2] = NaN;
        sparse[3] = sharedMsg;
        sparse[4] = sharedMsg;
        sparse[5] = customToJson;

        const ops = [
            { op: 'replace', path: '/0/mes', value: 'updated' },
            { op: 'replace', path: '/1', value: { mes: 'filled' } },
            { op: 'remove', path: '/2' },
            { op: 'replace', path: '/2/extra/score', value: 42 },
            { op: 'replace', path: '/3/extra/score', value: 77 },
            { op: 'replace', path: '/4/nested/v', value: 2 },
        ];

        const guarded = harness.attachChatMessagePatchTests(sparse, ops);

        // Original shared reference must remain completely unmutated.
        expect(sharedSub.score).toBe(10);
        expect(sharedMsg.extra.score).toBe(10);

        const serverCopy = realCloneAsJsonWire(sparse);
        const replayed = realApplyJsonPatch(serverCopy, guarded, true, false).newDocument;
        expect(replayed).toEqual([
            { mes: 'updated', arr: [null, 1, null] },
            { mes: 'filled' },
            { mes: 'shared', extra: { score: 42, tags: ['a'] } },
            { mes: 'shared', extra: { score: 77, tags: ['a'] } },
            { mes: 'serialized', nested: { v: 2 } },
        ]);
    });

    test('preserves raw added op semantics and handles root-level replace followed by nested edits', () => {
        const harness = createPatchTestHarness();
        const prev = [{ mes: 'm0' }];

        // Adding a raw object carrying an undefined field followed by replacing that field.
        const opsWithRawAdd = [
            { op: 'add', path: '/1', value: { mes: 'm1', u: undefined } },
            { op: 'replace', path: '/1/u', value: 'defined' },
        ];
        const guardedRawAdd = harness.attachChatMessagePatchTests(prev, opsWithRawAdd);
        expect(guardedRawAdd).toEqual([
            { op: 'add', path: '/1', value: { mes: 'm1', u: undefined } },
            { op: 'test', path: '/1', value: { mes: 'm1' } },
            { op: 'replace', path: '/1/u', value: 'defined' },
        ]);

        // Root replace followed by nested replace on the replaced array.
        const opsWithRootReplace = [
            { op: 'replace', path: '', value: [{ mes: 'new0' }, { mes: 'new1' }] },
            { op: 'replace', path: '/1/mes', value: 'new1-updated' },
        ];
        const guardedRoot = harness.attachChatMessagePatchTests(prev, opsWithRootReplace);
        expect(prev).toEqual([{ mes: 'm0' }]);
        expect(guardedRoot).toEqual([
            { op: 'replace', path: '', value: [{ mes: 'new0' }, { mes: 'new1' }] },
            { op: 'test', path: '/1', value: { mes: 'new1' } },
            { op: 'replace', path: '/1/mes', value: 'new1-updated' },
        ]);
    });
});

describe('attachObjectPatchTests', () => {
    test('mutates only its local workingState copy in place and produces replay-equivalent test guards', () => {
        const harness = createPatchTestHarness();
        const prev = {
            version: 1,
            nested: { count: 10, items: ['a', 'b', 'c'], flags: { x: true, y: false } },
        };
        const next = {
            version: 2,
            nested: { count: 11, items: ['a', 'c', 'd'], flags: { x: true, y: true, z: 'new' } },
        };
        const prevSnapshot = JSON.stringify(prev);

        const rawOps = compareJsonPatch(prev, next);
        const guarded = harness.attachObjectPatchTests(prev, rawOps);

        expect(harness.applyCalls).toHaveLength(rawOps.length);
        for (const call of harness.applyCalls) {
            expect(call.mutateDocument).toBe(true);
        }

        // Input object must remain completely untouched.
        expect(JSON.stringify(prev)).toBe(prevSnapshot);

        // Replaying guarded ops against a fresh server copy produces exact target state.
        const replayed = realApplyJsonPatch(realCloneAsJsonWire(prev), guarded, true, false).newDocument;
        expect(replayed).toEqual(next);
    });
});
