import { describe, test, expect } from '@jest/globals';
import { execChatReadRange } from '../../public/scripts/extensions/orchestrator/loop-tools/chat.js';

function ctx(...messages) {
    return { chat: messages };
}
const U = mes => ({ is_user: true, mes });
const A = mes => ({ is_user: false, mes });
const S = mes => ({ is_user: false, is_system: true, mes });

describe('execChatReadRange: pair-boundary auto-expansion', () => {
    test('expands assistant-only request backward to preceding user', async () => {
        const out = await execChatReadRange({ start: 1, end: 1 }, ctx(U('u0'), A('a0'), U('u1'), A('a1')));
        expect(out.map(m => m.floor)).toEqual([0, 1]);
    });

    test('expands user-only request forward to next assistant', async () => {
        const out = await execChatReadRange({ start: 2, end: 2 }, ctx(U('u0'), A('a0'), U('u1'), A('a1')));
        expect(out.map(m => m.floor)).toEqual([2, 3]);
    });

    test('expands middle slice to include both anchors (single pair sandwiched by extras)', async () => {
        const out = await execChatReadRange({ start: 1, end: 2 }, ctx(U('u0'), A('a0'), U('u1'), A('a1'), U('u2'), A('a2')));
        expect(out.map(m => m.floor)).toEqual([0, 1, 2, 3]);
    });

    test('already-aligned range passes through unchanged', async () => {
        const out = await execChatReadRange({ start: 0, end: 1 }, ctx(U('u0'), A('a0'), U('u1'), A('a1')));
        expect(out.map(m => m.floor)).toEqual([0, 1]);
    });

    test('opening assistant greeting (no preceding user) stops at index 0', async () => {
        const out = await execChatReadRange({ start: 0, end: 0 }, ctx(A('greeting'), U('u'), A('a')));
        expect(out.map(m => m.floor)).toEqual([0]);
    });

    test('trailing user with no following assistant stops at chat end', async () => {
        const out = await execChatReadRange({ start: 2, end: 2 }, ctx(U('u0'), A('a0'), U('u1')));
        expect(out.map(m => m.floor)).toEqual([2]);
    });

    test('system messages between user and assistant are skipped over during forward walk', async () => {
        const out = await execChatReadRange({ start: 0, end: 1 }, ctx(U('u'), S('system note'), A('a')));
        // start=0 (user) stays; end=1 (system) walks forward to assistant at index 2.
        expect(out.map(m => m.floor)).toEqual([0, 1, 2]);
    });

    test('throws CHAT_RANGE_TOO_LARGE when expansion pushes range over MAX_RANGE', async () => {
        // 60 messages, alternating U/A. Request a 50-message slice that lands
        // mid-pair on both ends; expansion adds 1-2 messages and tips over.
        const big = [];
        for (let i = 0; i < 60; i++) {
            big.push(i % 2 === 0 ? U(`u${i}`) : A(`a${i}`));
        }
        // start=1 (assistant) → expansion walks back to 0 (user).
        // end=50 (user) → expansion walks forward to 51 (assistant).
        // New span = 52, over MAX_RANGE=50.
        await expect(execChatReadRange({ start: 1, end: 50 }, { chat: big }))
            .rejects.toMatchObject({ code: 'CHAT_RANGE_TOO_LARGE' });
    });

    test('empty chat returns empty array', async () => {
        const out = await execChatReadRange({ start: 0, end: 0 }, ctx());
        expect(out).toEqual([]);
    });

    test('negative indices (Pythonic) still work, then get expanded', async () => {
        // Chat: [u, a, u, a]. Request end=-1 → resolves to 3 (assistant). start=-3 → resolves to 1 (assistant, mid-pair).
        // Expansion walks start back to 0 (user). Final range [0, 3].
        const out = await execChatReadRange({ start: -3, end: -1 }, ctx(U('u0'), A('a0'), U('u1'), A('a1')));
        expect(out.map(m => m.floor)).toEqual([0, 1, 2, 3]);
    });
});
