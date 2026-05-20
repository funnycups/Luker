import { describe, test, expect } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';

const deps = {
    get: lodash.get, set: lodash.set, unset: lodash.unset,
    isEqual: lodash.isEqual, cloneDeep: lodash.cloneDeep,
};

describe('custom op registration (third-party scenario)', () => {
    test('plugin registers node.add and applies it', () => {
        const engine = createEngine(deps);

        engine.registerOp('node.add', {
            apply(deps, edit, live) {
                live.nodes = live.nodes || {};
                live.nodes[edit.id] = edit.data;
                return live;
            },
            inverse(edit) {
                return { op: 'node.remove', id: edit.id };
            },
            detectConflict(deps, edit, live) {
                if (live.nodes && live.nodes[edit.id]) {
                    return {
                        reason: 'duplicate',
                        baseline: undefined,
                        current: live.nodes[edit.id],
                    };
                }
                return null;
            },
        });

        const result = engine.applyEdits(
            [{ op: 'node.add', id: 'n1', data: { label: 'Alpha' } }],
            {},
        );
        expect(result.newLive).toEqual({ nodes: { n1: { label: 'Alpha' } } });
        expect(result.clean.length).toBe(1);
    });

    test('custom op surface conflict via custom reason string', () => {
        const engine = createEngine(deps);
        engine.registerOp('node.add', {
            apply: (deps, edit, live) => { live.nodes[edit.id] = edit.data; return live; },
            inverse: edit => ({ op: 'node.remove', id: edit.id }),
            detectConflict: (deps, edit, live) =>
                live.nodes[edit.id]
                    ? { reason: 'duplicate', current: live.nodes[edit.id] }
                    : null,
        });

        const result = engine.applyEdits(
            [{ op: 'node.add', id: 'n1', data: { label: 'Beta' } }],
            { nodes: { n1: { label: 'EXISTING' } } },
        );
        expect(result.conflicts.length).toBe(1);
        expect(result.conflicts[0].reason).toBe('duplicate');
        expect(result.conflicts[0].current).toEqual({ label: 'EXISTING' });
    });
});

describe('orphan op handling', () => {
    test('applyEdits throws on unknown op (plugin uninstalled)', () => {
        const engine = createEngine(deps);
        expect(() => engine.applyEdits([{ op: 'ghost.thing', x: 1 }], {}))
            .toThrow(/unknown op: ghost.thing/);
    });
});
