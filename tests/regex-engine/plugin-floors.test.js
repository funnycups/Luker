/**
 * Unit tests for lib/plugin-floors.js — chat floor accessor for plugin
 * LLM requests.
 *
 * Contract under test:
 *   - readPluginFloors(context, options) walks context.chat once and
 *     returns FloorRecord[] ({ seq, sourceIndex, depth, is_user,
 *     is_system, mesRaw, mesCooked }); seq = sourceIndex + 1; depth is
 *     computed from the chat tail skipping system messages (reuses
 *     chat-regex.computeDepthsFromEnd).
 *   - Default roles ['user','assistant'] also excludes is_system
 *     messages; an explicit roles list can re-include them.
 *   - Filters (fromSeq/toSeq/fromDepth/toDepth/roles) narrow WHICH
 *     records come back; every returned record still carries ALL fields.
 *   - mesCooked goes through ctx.regex.applyRegex with
 *     { isPluginPrompt: true, depth } and role-derived placement;
 *     mesRaw stays untouched.
 *   - context.chat non-array → [].
 *   - floorRecordToTaskMessage(record) → { role, content: mesCooked,
 *     sourceFloorIndex: sourceIndex } via markPluginFloorMessage.
 */

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';

const applyRegexCalls = [];

function makeApplyRegex() {
    return (raw, placement, params) => {
        applyRegexCalls.push({ raw, placement, params });
        return `[lane:${placement}|d:${params?.depth ?? 'none'}]${raw}`;
    };
}

function makeContext(applyRegex = makeApplyRegex()) {
    return {
        regex: {
            placement: { USER_INPUT: 1, AI_OUTPUT: 2 },
            applyRegex,
        },
        chat: [
            { mes: 'hello USERONLY', is_user: true },            // idx 0, depth 3
            { mes: 'hi there', is_user: false },                  // idx 1, depth 2
            { mes: 'system note', is_system: true },              // idx 2, system
            { mes: 'PLUGINONLY again', is_user: true },           // idx 3, depth 1
            { mes: 'last turn', is_user: false },                 // idx 4, depth 0
        ],
    };
}

let previousLuker;

beforeAll(() => {
    previousLuker = globalThis.Luker;
});

afterAll(() => {
    globalThis.Luker = previousLuker;
});

async function importModule(context) {
    globalThis.Luker = { getContext: () => context };
    const mod = await import('../../public/scripts/lib/plugin-floors.js');
    mod.__resetPluginFloorsCacheForTests();
    return mod;
}

describe('readPluginFloors', () => {
    test('returns records with correct seq/sourceIndex/depth and cooked text', async () => {
        const mod = await importModule(makeContext());
        const records = mod.readPluginFloors(globalThis.Luker.getContext(), {});
        expect(records).toHaveLength(4); // system floor excluded by default roles

        expect(records.map(r => r.seq)).toEqual([1, 2, 4, 5]);
        expect(records.map(r => r.sourceIndex)).toEqual([0, 1, 3, 4]);
        expect(records.map(r => r.depth)).toEqual([3, 2, 1, 0]);
        // last usable floor has depth 0
        expect(records[3].depth).toBe(0);
        expect(records[3].mesRaw).toBe('last turn');
    });

    test('mesCooked runs through the isPluginPrompt lane with real depth; mesRaw stays raw', async () => {
        const mod = await importModule(makeContext());
        const records = mod.readPluginFloors(globalThis.Luker.getContext(), {});

        const userFloor = records.find(r => r.sourceIndex === 0);
        expect(userFloor.mesRaw).toBe('hello USERONLY');
        expect(userFloor.mesCooked).toBe('[lane:1|d:3]hello USERONLY');

        const aiFloor = records.find(r => r.sourceIndex === 4);
        expect(aiFloor.mesCooked).toBe('[lane:2|d:0]last turn');
        expect(aiFloor.mesRaw).toBe('last turn');
    });

    test('fromDepth / toDepth filter by computed depth', async () => {
        const mod = await importModule(makeContext());
        const context = globalThis.Luker.getContext();

        expect(mod.readPluginFloors(context, { toDepth: 1 }).map(r => r.depth))
            .toEqual([1, 0]);
        expect(mod.readPluginFloors(context, { fromDepth: 2 }).map(r => r.depth))
            .toEqual([3, 2]);
        expect(mod.readPluginFloors(context, { fromDepth: 1, toDepth: 2 }).map(r => r.depth))
            .toEqual([2, 1]);
    });

    test('fromSeq / toSeq filter by 1-based sequence number', async () => {
        const mod = await importModule(makeContext());
        const context = globalThis.Luker.getContext();

        expect(mod.readPluginFloors(context, { fromSeq: 4 }).map(r => r.seq))
            .toEqual([4, 5]);
        expect(mod.readPluginFloors(context, { fromSeq: 2, toSeq: 4 }).map(r => r.seq))
            .toEqual([2, 4]);
    });

    test('roles filter narrows the set; explicit system role re-includes system floors with all fields present', async () => {
        const mod = await importModule(makeContext());
        const context = globalThis.Luker.getContext();

        const onlyAssistants = mod.readPluginFloors(context, { roles: ['assistant'] });
        expect(onlyAssistants.map(r => r.is_user)).toEqual([false, false]);

        const withSystem = mod.readPluginFloors(context, { roles: ['user', 'assistant', 'system'] });
        expect(withSystem.map(r => r.seq)).toEqual([1, 2, 3, 4, 5]);
        const systemRecord = withSystem.find(r => r.seq === 3);
        expect(systemRecord.is_system).toBe(true);
        // Every record carries all FloorRecord fields even when filtered.
        for (const record of withSystem) {
            expect(Object.keys(record).sort()).toEqual(
                ['depth', 'is_system', 'is_user', 'mesCooked', 'mesRaw', 'seq', 'sourceIndex'].sort(),
            );
        }
    });

    test('context.chat non-array returns [] defensively', async () => {
        const mod = await importModule({ ...makeContext(), chat: undefined });
        expect(mod.readPluginFloors(globalThis.Luker.getContext(), {})).toEqual([]);
        expect(mod.readPluginFloors({}, {})).toEqual([]);
        expect(mod.readPluginFloors(null, {})).toEqual([]);
    });

    test('__resetPluginFloorsCacheForTests re-resolves a replaced regex API', async () => {
        const context = makeContext();
        const mod = await importModule(context);
        expect(mod.readPluginFloors(context, {})[0].mesCooked)
            .toContain('[lane:1|d:3]');

        context.regex.applyRegex = (raw) => `second:${raw}`;
        mod.__resetPluginFloorsCacheForTests();
        expect(mod.readPluginFloors(context, {})[0].mesCooked)
            .toBe('second:hello USERONLY');
    });

    test('degrades to raw text when no regex API is reachable', async () => {
        globalThis.Luker = { getContext: () => ({ chat: [{ mes: 'plain', is_user: true }] }) };
        const mod = await import('../../public/scripts/lib/plugin-floors.js');
        mod.__resetPluginFloorsCacheForTests();
        const records = mod.readPluginFloors(globalThis.Luker.getContext(), {});
        expect(records[0].mesCooked).toBe('plain');
    });
});

describe('cookPluginFloorText', () => {
    test('cooks one message text at the given real depth', async () => {
        const mod = await importModule(makeContext());
        const out = mod.cookPluginFloorText({ mes: 'PLUGINONLY again', is_user: true }, 1);
        expect(out).toBe('[lane:1|d:1]PLUGINONLY again');
        expect(applyRegexCalls.at(-1).params).toEqual({ isPluginPrompt: true, depth: 1 });
    });
});

describe('floorRecordToTaskMessage', () => {
    test('maps a record to { role, content, sourceFloorIndex }', async () => {
        const mod = await importModule(makeContext());
        const record = {
            seq: 5,
            sourceIndex: 4,
            depth: 0,
            is_user: false,
            is_system: false,
            mesRaw: 'last turn',
            mesCooked: '[lane:2|d:0]last turn',
        };
        expect(mod.floorRecordToTaskMessage(record)).toEqual({
            role: 'assistant',
            content: '[lane:2|d:0]last turn',
            sourceFloorIndex: 4,
        });
    });

    test('role mapping covers user and system records', async () => {
        const mod = await importModule(makeContext());
        expect(mod.floorRecordToTaskMessage({
            seq: 1, sourceIndex: 0, depth: 0, is_user: true, is_system: false, mesRaw: '', mesCooked: 'c1',
        })).toEqual({ role: 'user', content: 'c1', sourceFloorIndex: 0 });
        expect(mod.floorRecordToTaskMessage({
            seq: 3, sourceIndex: 2, depth: undefined, is_user: false, is_system: true, mesRaw: '', mesCooked: 'c2',
        })).toEqual({ role: 'system', content: 'c2', sourceFloorIndex: 2 });
        // is_user is checked first when both flags are somehow set.
        expect(mod.floorRecordToTaskMessage({
            seq: 4, sourceIndex: 3, depth: 1, is_user: true, is_system: true, mesRaw: '', mesCooked: 'c3',
        })).toEqual({ role: 'user', content: 'c3', sourceFloorIndex: 3 });
    });

    test('default roles exclude system floors from task messages produced by readPluginFloors', async () => {
        const mod = await importModule(makeContext());
        const records = mod.readPluginFloors(globalThis.Luker.getContext(), {});
        const messages = records.map(mod.floorRecordToTaskMessage);
        expect(messages.every(m => m.role !== 'system')).toBe(true);
        expect(messages[messages.length - 1]).toEqual({
            role: 'assistant',
            content: '[lane:2|d:0]last turn',
            sourceFloorIndex: 4,
        });
    });
});
