/**
 * Integration-flavored tests for the variable op-log feature.
 *
 * These exercise extract → forward-apply → rebuild end-to-end with realistic
 * chat-shaped objects (mimicking ST's chat[] shape including swipe_info).
 * No DOM, no event loop — pure data shape integration.
 */
import { describe, test, expect } from '@jest/globals';
import { extractFromMessage } from '../../public/scripts/variable-op-log/extractor.js';
import { rebuildVariables, getTrackedKeys, computeReplayedState } from '../../public/scripts/variable-op-log/rebuilder.js';

const aiMsg = (mes, extra = {}) => ({ is_user: false, is_system: false, mes, extra });
const userMsg = (mes) => ({ is_user: true, is_system: false, mes, extra: {} });

const envWith = (state) => () => ({
    user: 'Martin',
    char: 'Athena',
    getvar: (k) => String(state[k] ?? ''),
});

describe('integration: full chat lifecycle', () => {
    test('AI message with setvar populates state and strips literal', () => {
        const chat = [];
        const state = {};
        const msg = aiMsg('You open the door. {{setvar::hp::50}} Room is empty.');
        chat.push(msg);

        extractFromMessage(msg, state, envWith(state));

        expect(msg.mes).toBe('You open the door.  Room is empty.');
        expect(msg.extra.var_ops).toEqual([{ op: 'setvar', key: 'hp', value: '50' }]);
        expect(state.hp).toBe('50');

        // Rebuild from scratch reproduces the same state
        const rebuilt = {};
        rebuildVariables(chat, rebuilt);
        expect(rebuilt.hp).toBe('50');
    });

    test('continue scenario appends ops without reprocessing prior macros', () => {
        const chat = [];
        const state = {};

        // Initial generation
        const msg = aiMsg('You open the door. {{setvar::hp::50}}');
        chat.push(msg);
        extractFromMessage(msg, state, envWith(state));
        expect(msg.mes).toBe('You open the door. ');

        // Continue: append more text with another setvar
        msg.mes += ' Room is empty. {{setvar::tension::high}}';
        extractFromMessage(msg, state, envWith(state));

        expect(msg.mes).toBe('You open the door.  Room is empty. ');
        expect(msg.extra.var_ops).toEqual([
            { op: 'setvar', key: 'hp', value: '50' },
            { op: 'setvar', key: 'tension', value: 'high' },
        ]);
        expect(state).toEqual({ hp: '50', tension: 'high' });
    });

    test('deletion: removing a message rolls hp back via rebuild', () => {
        const state = {};
        const m1 = aiMsg('{{setvar::hp::50}}');
        const m2 = aiMsg('{{setvar::hp::10}}');
        const chat = [m1, m2];
        extractFromMessage(m1, state, envWith(state));
        extractFromMessage(m2, state, envWith(state));
        expect(state.hp).toBe('10');

        // Simulate deletion of m2
        chat.splice(1, 1);
        rebuildVariables(chat, state);

        expect(state.hp).toBe('50');
    });

    test('rebuild preserves keys not owned by op-log', () => {
        // Simulate a chat where slash command and WI wrote keys we don't own
        const state = { questStep: '3', weather: 'sunny' };
        const m1 = aiMsg('{{setvar::hp::50}}');
        const chat = [m1];
        extractFromMessage(m1, state, envWith(state));

        // Some structural change triggers rebuild
        rebuildVariables(chat, state);

        // hp is owned (from op), the others survive
        expect(state).toEqual({ hp: '50', questStep: '3', weather: 'sunny' });
    });

    test('the WI=10 / AI=50 / AI=10 deletion case from design discussions', () => {
        // World info has set hp=10 by render-time elsewhere; we model that as
        // a starting value already in state.
        const state = { hp: '10' };
        const m1 = aiMsg('{{setvar::hp::50}}');
        const m2 = aiMsg('{{setvar::hp::10}}');
        const chat = [m1, m2];
        extractFromMessage(m1, state, envWith(state));
        extractFromMessage(m2, state, envWith(state));
        expect(state.hp).toBe('10');

        // Delete m2; rebuild
        chat.splice(1, 1);
        rebuildVariables(chat, state);
        expect(state.hp).toBe('50');

        // Tracked keys reflect surviving ops only
        expect(getTrackedKeys(chat)).toEqual(new Set(['hp']));
    });

    test('multiple variables with sequential dependencies', () => {
        const state = {};
        const msg = aiMsg('{{setvar::a::1}} {{setvar::b::{{getvar::a}}}} {{setvar::c::{{getvar::b}}}}');
        const chat = [msg];
        extractFromMessage(msg, state, envWith(state));

        expect(msg.extra.var_ops.map(o => `${o.key}=${o.value}`))
            .toEqual(['a=1', 'b=1', 'c=1']);
        expect(state).toEqual({ a: '1', b: '1', c: '1' });

        // Full replay yields the same result
        expect(computeReplayedState(chat)).toEqual({ a: '1', b: '1', c: '1' });
    });

    test('user message side-effect macros are also extracted', () => {
        const state = {};
        const msg = userMsg('Setting flag now {{setvar::flag::true}}');
        const chat = [msg];
        extractFromMessage(msg, state, envWith(state));

        expect(msg.mes).toBe('Setting flag now ');
        expect(state.flag).toBe('true');
    });

    test('inc and dec arithmetic across messages', () => {
        const state = {};
        const m1 = aiMsg('{{setvar::turn::5}}');
        const m2 = aiMsg('{{incvar::turn}}');
        const m3 = aiMsg('{{incvar::turn}} {{decvar::turn}}');
        const chat = [m1, m2, m3];
        for (const m of chat) extractFromMessage(m, state, envWith(state));
        expect(state.turn).toBe(6);

        // delete m3, rebuild
        chat.splice(2, 1);
        rebuildVariables(chat, state);
        expect(state.turn).toBe(6);

        // delete m2 too
        chat.splice(1, 1);
        rebuildVariables(chat, state);
        expect(state.turn).toBe('5');
    });

    test('global variable macros are not extracted', () => {
        const state = {};
        const msg = aiMsg('{{setvar::a::1}} {{setglobalvar::g::2}} {{setvar::b::3}}');
        extractFromMessage(msg, state, envWith(state));

        expect(msg.mes).toContain('{{setglobalvar::g::2}}');
        expect(msg.extra.var_ops.map(o => o.key)).toEqual(['a', 'b']);
        expect(state).toEqual({ a: '1', b: '3' });
    });

    test('env exposes user/char to value templates', () => {
        const state = {};
        const msg = aiMsg('{{setvar::greeting::hi {{user}}, I am {{char}}}}');
        extractFromMessage(msg, state, envWith(state));
        expect(state.greeting).toBe('hi Martin, I am Athena');
    });

    test('deletevar in a later message removes a key set earlier on rebuild', () => {
        const state = {};
        const m1 = aiMsg('{{setvar::flag::on}}');
        const m2 = aiMsg('{{deletevar::flag}}');
        const chat = [m1, m2];
        for (const m of chat) extractFromMessage(m, state, envWith(state));
        expect('flag' in state).toBe(false);

        // Replay
        const rebuilt = {};
        rebuildVariables(chat, rebuilt);
        expect('flag' in rebuilt).toBe(false);
    });
});

describe('integration: swipe shape', () => {
    test('var_ops attached to swipe_info[i].extra cycles correctly', () => {
        // Simulate a message with two swipes, each with its own ops.
        const message = {
            is_user: false,
            mes: '',
            swipe_id: 0,
            swipes: ['', ''],
            swipe_info: [
                { extra: { var_ops: [{ op: 'setvar', key: 'hp', value: '50' }] } },
                { extra: { var_ops: [{ op: 'setvar', key: 'hp', value: '10' }] } },
            ],
            extra: { var_ops: [{ op: 'setvar', key: 'hp', value: '50' }] },
        };
        const chat = [message];

        // Switch to swipe 1 — simulate ST's syncSwipeToMes copying swipe_info[1].extra
        message.swipe_id = 1;
        message.extra = structuredClone(message.swipe_info[1].extra);

        const state = {};
        rebuildVariables(chat, state);
        expect(state.hp).toBe('10');

        // Switch back to swipe 0
        message.swipe_id = 0;
        message.extra = structuredClone(message.swipe_info[0].extra);
        rebuildVariables(chat, state);
        expect(state.hp).toBe('50');
    });

    test('clearMessageData simulation: new swipe starts with empty var_ops', () => {
        const message = {
            mes: '',
            swipe_id: 0,
            swipes: ['old text', ''],
            swipe_info: [
                { extra: { var_ops: [{ op: 'setvar', key: 'hp', value: '50' }] } },
                { extra: {} },
            ],
            extra: { var_ops: [{ op: 'setvar', key: 'hp', value: '50' }] },
        };

        // Begin swipe 1 — ST runs clearMessageData, which removes var_ops
        message.swipe_id = 1;
        message.extra = {};

        // AI generates new content with its own setvar
        message.mes = '{{setvar::hp::99}}';
        const state = {};
        extractFromMessage(message, state, () => ({}));
        expect(state.hp).toBe('99');
        expect(message.extra.var_ops).toEqual([{ op: 'setvar', key: 'hp', value: '99' }]);
    });
});

describe('integration: edge cases', () => {
    test('idempotent extraction: running twice does not duplicate ops', () => {
        const state = {};
        const msg = aiMsg('{{setvar::a::1}}');
        extractFromMessage(msg, state, envWith(state));
        const beforeOps = JSON.stringify(msg.extra.var_ops);
        const beforeMes = msg.mes;

        extractFromMessage(msg, state, envWith(state));

        expect(msg.mes).toBe(beforeMes);
        expect(JSON.stringify(msg.extra.var_ops)).toBe(beforeOps);
    });

    test('nested side-effect macro is preserved as literal in value', () => {
        const state = {};
        const msg = aiMsg('{{setvar::a::nested {{setvar::b::1}} value}}');
        extractFromMessage(msg, state, envWith(state));

        expect(msg.extra.var_ops).toHaveLength(1);
        expect(msg.extra.var_ops[0].value).toBe('nested {{setvar::b::1}} value');
        // Inner setvar was NOT extracted as a separate op (no double-execute)
        expect(state).toEqual({ a: 'nested {{setvar::b::1}} value' });
    });

    test('chat with mixed system, user, AI messages', () => {
        const state = {};
        const chat = [
            { is_system: true, mes: 'system header', extra: {} },
            userMsg('hi {{setvar::greeted::true}}'),
            aiMsg('hello {{setvar::reply_count::1}}'),
            userMsg('again'),
            aiMsg('{{incvar::reply_count}}'),
        ];
        for (const m of chat) extractFromMessage(m, state, envWith(state));
        expect(state).toEqual({
            greeted: 'true',
            reply_count: 2,
        });

        // Delete the last AI message
        chat.pop();
        rebuildVariables(chat, state);
        expect(state.reply_count).toBe('1');
        expect(state.greeted).toBe('true');
    });
});
