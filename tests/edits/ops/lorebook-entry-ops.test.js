import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../../public/scripts/lib/edits/engine.js';
import {
    createLorebookEntryAddOp,
    createLorebookEntryUpdateOp,
    createLorebookEntryRemoveOp,
} from '../../../public/scripts/extensions/character-editor-assistant/lorebook-ops.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

function makeEngine() {
    const engine = createEngine(deps);
    engine.registerOp('lorebook_entry_add', createLorebookEntryAddOp());
    engine.registerOp('lorebook_entry_update', createLorebookEntryUpdateOp());
    engine.registerOp('lorebook_entry_remove', createLorebookEntryRemoveOp());
    return engine;
}

const seedLive = () => ({
    card: { name: 'Alice' },
    lorebook: {
        bookName: 'Wonderland',
        entries: {
            17: { uid: 17, key: ['rabbit'], content: 'White rabbit', comment: 'main' },
            18: { uid: 18, key: ['tea'], content: 'Mad tea party', comment: '' },
        },
    },
});

describe('lorebook_entry_add op', () => {
    test('apply inserts a new entry at uid', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: 42,
            entry: { uid: 42, key: ['queen'], content: 'Queen of Hearts', comment: '' },
        }], live);
        expect(result.conflicts).toEqual([]);
        expect(result.newLive.lorebook.entries[42].content).toBe('Queen of Hearts');
    });

    test('detectConflict returns duplicate when uid already exists', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: 17,    // already in seedLive
            entry: { uid: 17, key: ['x'], content: 'collision', comment: '' },
        }], live);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('duplicate');
    });

    test('inverse produces a lorebook_entry_remove for the same uid+entry', () => {
        const engine = makeEngine();
        const edit = {
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: 42,
            entry: { uid: 42, key: ['queen'], content: 'Q', comment: '' },
        };
        const inv = engine.inverseEdit(edit);
        expect(inv).toEqual({
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 42,
            entry: { uid: 42, key: ['queen'], content: 'Q', comment: '' },
        });
    });

    test('apply + applyInverse round-trips', () => {
        const live = seedLive();
        const engine = makeEngine();
        const edit = {
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: 42,
            entry: { uid: 42, key: ['queen'], content: 'Q', comment: '' },
        };
        const after = engine.applyEdits([edit], live).newLive;
        const back = engine.applyEdits([engine.inverseEdit(edit)], after).newLive;
        expect(back.lorebook.entries[42]).toBeUndefined();
        expect(Object.keys(back.lorebook.entries).sort()).toEqual(['17', '18']);
    });
});

describe('lorebook_entry_update op', () => {
    test('apply merges patch into entry (shallow)', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'White rabbit (revised)', comment: 'updated' },
            before: { content: 'White rabbit', comment: 'main' },
        }], live);
        expect(result.conflicts).toEqual([]);
        expect(result.newLive.lorebook.entries[17].content).toBe('White rabbit (revised)');
        expect(result.newLive.lorebook.entries[17].comment).toBe('updated');
        // Unpatched fields preserved
        expect(result.newLive.lorebook.entries[17].key).toEqual(['rabbit']);
    });

    test('detectConflict: not_found when uid is missing', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 999,
            patch: { content: 'x' },
            before: { content: 'y' },
        }], live);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('not_found');
    });

    test('detectConflict: already_done when current state already matches patch', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'White rabbit', comment: 'main' },   // matches current state
            before: { content: 'White rabbit', comment: 'main' },
        }], live);
        expect(result.alreadyDone).toHaveLength(1);
        expect(result.alreadyDone[0].op).toBe('lorebook_entry_update');
    });

    test('detectConflict: value_drifted when current state differs from `before` on patched fields', () => {
        const live = seedLive();
        live.lorebook.entries[17].content = 'Drifted content';   // external edit
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'White rabbit (revised)' },
            before: { content: 'White rabbit' },
        }], live);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('inverse swaps patch and before', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit({
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'A' },
            before: { content: 'B' },
        });
        expect(inv).toEqual({
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'B' },
            before: { content: 'A' },
        });
    });

    test('apply + applyInverse round-trips', () => {
        const engine = makeEngine();
        const live = seedLive();
        const edit = {
            op: 'lorebook_entry_update',
            path: 'lorebook.entries',
            uid: 17,
            patch: { content: 'A', comment: 'updated' },
            before: { content: 'White rabbit', comment: 'main' },
        };
        const after = engine.applyEdits([edit], live).newLive;
        const back = engine.applyEdits([engine.inverseEdit(edit)], after).newLive;
        expect(back.lorebook.entries[17].content).toBe('White rabbit');
        expect(back.lorebook.entries[17].comment).toBe('main');
    });
});

describe('lorebook_entry_remove op', () => {
    test('apply removes entry at uid', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 17,
            entry: { uid: 17, key: ['rabbit'], content: 'White rabbit', comment: 'main' },
        }], live);
        expect(result.conflicts).toEqual([]);
        expect(result.newLive.lorebook.entries[17]).toBeUndefined();
        expect(result.newLive.lorebook.entries[18]).toBeDefined();
    });

    test('detectConflict: not_found when uid missing', () => {
        const live = seedLive();
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 999,
            entry: {},
        }], live);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('not_found');
    });

    test('detectConflict: value_drifted when entry content differs from expected', () => {
        const live = seedLive();
        live.lorebook.entries[17].content = 'Externally changed';
        const engine = makeEngine();
        const result = engine.applyEdits([{
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 17,
            entry: { uid: 17, key: ['rabbit'], content: 'White rabbit', comment: 'main' },
        }], live);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0].reason).toBe('value_drifted');
    });

    test('inverse produces lorebook_entry_add with same uid+entry', () => {
        const engine = makeEngine();
        const inv = engine.inverseEdit({
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 17,
            entry: { uid: 17, content: 'White rabbit' },
        });
        expect(inv).toEqual({
            op: 'lorebook_entry_add',
            path: 'lorebook.entries',
            uid: 17,
            entry: { uid: 17, content: 'White rabbit' },
        });
    });

    test('round-trip: remove then add restores entry', () => {
        const engine = makeEngine();
        const live = seedLive();
        const edit = {
            op: 'lorebook_entry_remove',
            path: 'lorebook.entries',
            uid: 17,
            entry: { uid: 17, key: ['rabbit'], content: 'White rabbit', comment: 'main' },
        };
        const after = engine.applyEdits([edit], live).newLive;
        const back = engine.applyEdits([engine.inverseEdit(edit)], after).newLive;
        expect(back.lorebook.entries[17].content).toBe('White rabbit');
    });
});
