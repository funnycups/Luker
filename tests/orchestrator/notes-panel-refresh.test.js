/**
 * Notes auto-refresh bus tests.
 *
 * `onNotesChanged` is the wakeup channel notes-panel uses to rerender
 * after an in-process write (LLM-driven `note_open` / `note_close` or a
 * UI-driven edit / delete). The adapter built inside `attachNotesFloorState`
 * is the canonical emitter — these tests drive the real adapter via a
 * minimal in-memory `createFloorState` fake so they actually exercise the
 * emit hook on every write surface, not a hand-rolled adapter that would
 * lie about parity.
 *
 * Covered:
 *   - `appendForFloor` fires on every successful append
 *   - `updateStatusById` fires on a real flip, NOT on already_open /
 *     already_closed / not_found
 *   - `updateTextById` fires on a real edit, NOT on not_found
 *   - `deleteByIds` fires when at least one id was removed, NOT when
 *     nothing matched
 *   - unsubscribe handle stops further deliveries
 *   - a throwing listener does not break sibling listeners or the write path
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';

import {
    attachNotesFloorState,
    onNotesChanged,
    resetNotesFloorStateInstanceForTesting,
    __resetNotesChangeListenersForTesting,
} from '../../public/scripts/extensions/orchestrator/loop-runtime.js';

/**
 * Minimal `createFloorState` fake. Production floor-state is namespaced,
 * persistent, chat-aware, and event-driven; for adapter-level emit tests
 * we only need the three methods `attachNotesFloorState` actually calls:
 * `ready` / `get` / `update`. Storage is a plain object so the adapter's
 * normalize / entries logic runs end-to-end. `get` and `update` return the
 * state-error envelope (`{ok:true, state}` / `{ok:true, updated:true}`)
 * the production adapter expects after the state-error-reasons refactor.
 */
function makeFakeCreateFloorState() {
    return async (_opts) => {
        let data = {};
        return {
            ready: async () => {},
            get: async () => ({ ok: true, state: data }),
            update: async (reducer, _opts) => {
                const next = await reducer(data);
                if (next && typeof next === 'object' && !Array.isArray(next)) {
                    data = next;
                }
                return { ok: true, updated: true };
            },
        };
    };
}

async function freshContext() {
    resetNotesFloorStateInstanceForTesting();
    __resetNotesChangeListenersForTesting();
    const ctx = { createFloorState: makeFakeCreateFloorState() };
    await attachNotesFloorState(ctx);
    return ctx;
}

describe('onNotesChanged + adapter emit hooks', () => {
    beforeEach(() => {
        resetNotesFloorStateInstanceForTesting();
        __resetNotesChangeListenersForTesting();
    });

    test('appendForFloor emits once per successful append', async () => {
        const ctx = await freshContext();
        const listener = jest.fn();
        onNotesChanged(listener);

        await ctx.__floorStateForNotes.appendForFloor(0, 'first note');
        await ctx.__floorStateForNotes.appendForFloor(0, 'second note');

        expect(listener).toHaveBeenCalledTimes(2);
    });

    test('updateStatusById emits on real flip; suppressed on already_<status> / not_found', async () => {
        const ctx = await freshContext();
        const fs = ctx.__floorStateForNotes;
        const { id } = await fs.appendForFloor(0, 'note A');

        const listener = jest.fn();
        onNotesChanged(listener);

        // Real flip open -> closed: should emit
        const flip = await fs.updateStatusById(id, 'closed', 'deployed');
        expect(flip).toEqual({ ok: true });
        expect(listener).toHaveBeenCalledTimes(1);

        // Redundant flip closed -> closed: outcome already_closed, no emit
        const noop = await fs.updateStatusById(id, 'closed', 'still deployed');
        expect(noop).toEqual({ ok: false, error: 'already_closed' });
        expect(listener).toHaveBeenCalledTimes(1);

        // Unknown id: not_found, no emit
        const miss = await fs.updateStatusById('nope', 'closed');
        expect(miss).toEqual({ ok: false, error: 'not_found' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('updateTextById emits on real edit; suppressed on not_found', async () => {
        const ctx = await freshContext();
        const fs = ctx.__floorStateForNotes;
        const { id } = await fs.appendForFloor(0, 'original');

        const listener = jest.fn();
        onNotesChanged(listener);

        const edit = await fs.updateTextById(id, 'edited');
        expect(edit).toEqual({ ok: true });
        expect(listener).toHaveBeenCalledTimes(1);

        const miss = await fs.updateTextById('nope', 'edited');
        expect(miss).toEqual({ ok: false, error: 'not_found' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('deleteByIds emits when at least one id was removed; suppressed otherwise', async () => {
        const ctx = await freshContext();
        const fs = ctx.__floorStateForNotes;
        const { id } = await fs.appendForFloor(0, 'doomed');

        const listener = jest.fn();
        onNotesChanged(listener);

        // No ids at all -> no write, no emit
        const empty = await fs.deleteByIds([]);
        expect(empty).toEqual({ removed: [], missing: [] });
        expect(listener).toHaveBeenCalledTimes(0);

        // All-missing -> no removal, no emit
        const allMissing = await fs.deleteByIds(['nope', 'also-nope']);
        expect(allMissing.removed).toEqual([]);
        expect(allMissing.missing.sort()).toEqual(['also-nope', 'nope']);
        expect(listener).toHaveBeenCalledTimes(0);

        // Real removal -> emit
        const real = await fs.deleteByIds([id]);
        expect(real.removed).toEqual([id]);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('unsubscribe handle stops further deliveries', async () => {
        const ctx = await freshContext();
        const fs = ctx.__floorStateForNotes;

        const listener = jest.fn();
        const off = onNotesChanged(listener);

        await fs.appendForFloor(0, 'first');
        expect(listener).toHaveBeenCalledTimes(1);

        off();

        await fs.appendForFloor(0, 'second');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('a throwing listener does not break sibling listeners or the write itself', async () => {
        const ctx = await freshContext();
        const fs = ctx.__floorStateForNotes;

        const boom = jest.fn(() => { throw new Error('listener bug'); });
        const sibling = jest.fn();
        onNotesChanged(boom);
        onNotesChanged(sibling);

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r = await fs.appendForFloor(0, 'survives');
            expect(r.ok).toBe(true);
            expect(typeof r.id).toBe('string');
            expect(boom).toHaveBeenCalledTimes(1);
            expect(sibling).toHaveBeenCalledTimes(1);
            const all = await fs.listAcrossFloors();
            expect(all.map(e => e.text)).toEqual(['survives']);
        } finally {
            warnSpy.mockRestore();
        }
    });
});
