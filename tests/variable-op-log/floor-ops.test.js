/**
 * Tests for floor-ops.js — the pure pushFloorVarOp + swipe-mirror primitives.
 *
 * These cover the programmatic op-injection path: extension code that wants
 * to "tie this variable change to floor N" without round-tripping through
 * literal `{{setvar}}` macros in message text.
 */
import { describe, test, expect } from '@jest/globals';
import { pushFloorVarOp, mirrorMessageExtraToCurrentSwipe } from '../../public/scripts/variable-op-log/floor-ops.js';
import { rebuildVariables } from '../../public/scripts/variable-op-log/rebuilder.js';

const aiMsg = (mes, extra = {}) => ({ is_user: false, is_system: false, mes, extra });

/**
 * Build a message with a swipes array so `mirrorMessageExtraToCurrentSwipe`
 * has somewhere to write.
 */
function aiMsgWithSwipes(swipeTexts, activeIndex = 0) {
    const message = {
        is_user: false,
        is_system: false,
        mes: swipeTexts[activeIndex],
        swipe_id: activeIndex,
        swipes: [...swipeTexts],
        swipe_info: swipeTexts.map(() => ({ extra: {} })),
        extra: {},
    };
    return message;
}

describe('pushFloorVarOp', () => {
    test('appends a setvar op and forward-applies to state', () => {
        const m0 = aiMsg('hello');
        const chat = [m0];
        const state = {};

        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '100' });

        expect(m0.extra.var_ops).toEqual([{ op: 'setvar', key: 'hp', value: '100' }]);
        expect(state.hp).toBe('100');
    });

    test('preserves message text (no stripping like the extractor does)', () => {
        const m0 = aiMsg('You open the door.');
        const chat = [m0];
        const state = {};

        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '50' });

        // pushFloorVarOp does NOT touch mes — only extra.var_ops
        expect(m0.mes).toBe('You open the door.');
    });

    test('multiple ops on same floor stack in source order', () => {
        const m0 = aiMsg('hello');
        const chat = [m0];
        const state = {};

        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '100' });
        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '80' });
        pushFloorVarOp(chat, state, 0, { op: 'incvar', key: 'hp' });

        expect(m0.extra.var_ops).toEqual([
            { op: 'setvar', key: 'hp', value: '100' },
            { op: 'setvar', key: 'hp', value: '80' },
            { op: 'incvar', key: 'hp' },
        ]);
        expect(state.hp).toBe(81);
    });

    test('mirrors extra to the active swipe slot', () => {
        const m0 = aiMsgWithSwipes(['swipe-a', 'swipe-b'], 0);
        const chat = [m0];
        const state = {};

        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '100' });

        expect(m0.swipe_info[0].extra.var_ops).toEqual([
            { op: 'setvar', key: 'hp', value: '100' },
        ]);
        // The other swipe's slot is untouched
        expect(m0.swipe_info[1].extra).toEqual({});
    });

    test('does not mirror when swipe_id is invalid (no swipes recorded)', () => {
        const m0 = aiMsg('hello'); // no swipe_id / swipes
        const chat = [m0];
        const state = {};

        // Should not throw
        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '100' });
        expect(m0.extra.var_ops).toEqual([{ op: 'setvar', key: 'hp', value: '100' }]);
    });

    test('rejects out-of-range floor', () => {
        const chat = [aiMsg('a'), aiMsg('b')];
        const state = {};
        expect(() => pushFloorVarOp(chat, state, 5, { op: 'setvar', key: 'hp', value: '1' }))
            .toThrow(/no message at floor 5/);
        expect(() => pushFloorVarOp(chat, state, -1, { op: 'setvar', key: 'hp', value: '1' }))
            .toThrow(/no message at floor -1/);
    });

    test('rejects malformed op', () => {
        const chat = [aiMsg('a')];
        const state = {};
        expect(() => pushFloorVarOp(chat, state, 0, null))
            .toThrow(/op requires a non-empty string key/);
        expect(() => pushFloorVarOp(chat, state, 0, { op: 'setvar' }))
            .toThrow(/op requires a non-empty string key/);
        expect(() => pushFloorVarOp(chat, state, 0, { op: 'setvar', key: '' }))
            .toThrow(/op requires a non-empty string key/);
    });

    test('rebuild reproduces same state from chat after deletion', () => {
        const m0 = aiMsg('first');
        const m1 = aiMsg('second');
        const chat = [m0, m1];
        const state = {};

        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '100' });
        pushFloorVarOp(chat, state, 1, { op: 'setvar', key: 'hp', value: '50' });
        expect(state.hp).toBe('50');

        // Simulate floor-1 deletion + rebuild
        chat.splice(1, 1);
        rebuildVariables(chat, state);
        expect(state.hp).toBe('100');
    });

    test('switching swipes (manual swap) flips active var_ops correctly', () => {
        // Floor with two swipes; swipe A pushes hp=100, swipe B pushes hp=50.
        const m0 = aiMsgWithSwipes(['swipe-a', 'swipe-b'], 0);
        const chat = [m0];
        const state = {};

        // Active swipe is 0 → push hp=100 op
        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '100' });

        // Manually flip to swipe 1 — mimic what saveReply does on swipe switch:
        // stash current extra to active slot (already done by pushFloorVarOp's
        // mirror), then load target slot's extra back onto message.
        m0.swipe_id = 1;
        m0.extra = structuredClone(m0.swipe_info[1].extra ?? {});
        m0.mes = m0.swipes[1];

        // Now push hp=50 op against swipe 1
        pushFloorVarOp(chat, state, 0, { op: 'setvar', key: 'hp', value: '50' });
        expect(m0.swipe_info[1].extra.var_ops).toEqual([
            { op: 'setvar', key: 'hp', value: '50' },
        ]);
        // Swipe 0's stored ops were preserved
        expect(m0.swipe_info[0].extra.var_ops).toEqual([
            { op: 'setvar', key: 'hp', value: '100' },
        ]);

        // Flip back to swipe 0 + rebuild
        m0.swipe_id = 0;
        m0.extra = structuredClone(m0.swipe_info[0].extra ?? {});
        m0.mes = m0.swipes[0];
        rebuildVariables(chat, state);
        expect(state.hp).toBe('100');
    });
});

describe('mirrorMessageExtraToCurrentSwipe', () => {
    test('copies message.extra into the active swipe slot', () => {
        const m = aiMsgWithSwipes(['a', 'b'], 1);
        m.extra.var_ops = [{ op: 'setvar', key: 'x', value: '1' }];

        mirrorMessageExtraToCurrentSwipe(m);

        expect(m.swipe_info[1].extra.var_ops).toEqual([
            { op: 'setvar', key: 'x', value: '1' },
        ]);
        expect(m.swipe_info[0].extra).toEqual({});
    });

    test('is a no-op when message has no swipe metadata', () => {
        const m = { mes: 'plain', extra: { var_ops: [{ op: 'setvar', key: 'x', value: '1' }] } };
        // Should not throw
        mirrorMessageExtraToCurrentSwipe(m);
        // Nothing to assert beyond "did not crash"
        expect(m.extra.var_ops).toHaveLength(1);
    });

    test('is a no-op when swipe_id is out of range', () => {
        const m = aiMsgWithSwipes(['a', 'b'], 0);
        m.swipe_id = 99;
        m.extra.var_ops = [{ op: 'setvar', key: 'x', value: '1' }];
        mirrorMessageExtraToCurrentSwipe(m);
        // Neither slot should have been written
        expect(m.swipe_info[0].extra).toEqual({});
        expect(m.swipe_info[1].extra).toEqual({});
    });
});
