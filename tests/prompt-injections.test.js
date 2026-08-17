import { describe, expect, jest, test } from '@jest/globals';

import {
    INJECTION_POSITION,
    applyAttachedPromptsToMessages,
    applyPromptManagerOverrides,
    getPromptInjectionGroups,
    getPromptInjectionPosition,
    getRelativePromptById,
    isPromptInjectionPosition,
} from '../public/scripts/prompt-injections.js';

// Chat history convention matches openai.js callsite: messages[0] is the newest turn,
// so `.reverse()` inside applyAttachedPromptsToMessages produces oldest-first ordering.
// Under that convention: attach_index=1 targets the OLDEST matching role message,
// attach_index=-1 targets the NEWEST matching role message.
function makeMessages() {
    return [
        // Latest first
        { role: 'assistant', content: 'A_new' },
        { role: 'user', content: 'U_new' },
        { role: 'assistant', content: 'A_mid' },
        { role: 'user', content: 'U_mid' },
        { role: 'assistant', content: 'A_old' },
        { role: 'user', content: 'U_old' },
    ];
}

describe('INJECTION_POSITION', () => {
    test('has RELATIVE, ABSOLUTE, ATTACH_EXISTING with stable numeric values', () => {
        expect(INJECTION_POSITION.RELATIVE).toBe(0);
        expect(INJECTION_POSITION.ABSOLUTE).toBe(1);
        expect(INJECTION_POSITION.ATTACH_EXISTING).toBe(2);
    });
});

describe('getPromptInjectionPosition', () => {
    test('defaults to RELATIVE for missing / null / undefined prompt', () => {
        expect(getPromptInjectionPosition(undefined)).toBe(INJECTION_POSITION.RELATIVE);
        expect(getPromptInjectionPosition(null)).toBe(INJECTION_POSITION.RELATIVE);
        expect(getPromptInjectionPosition({})).toBe(INJECTION_POSITION.RELATIVE);
    });

    test('returns known enum values as-is', () => {
        expect(getPromptInjectionPosition({ injection_position: 0 })).toBe(INJECTION_POSITION.RELATIVE);
        expect(getPromptInjectionPosition({ injection_position: 1 })).toBe(INJECTION_POSITION.ABSOLUTE);
        expect(getPromptInjectionPosition({ injection_position: 2 })).toBe(INJECTION_POSITION.ATTACH_EXISTING);
    });

    test('falls back to RELATIVE for unknown numeric values', () => {
        expect(getPromptInjectionPosition({ injection_position: 99 })).toBe(INJECTION_POSITION.RELATIVE);
        expect(getPromptInjectionPosition({ injection_position: -1 })).toBe(INJECTION_POSITION.RELATIVE);
    });

    test('coerces string-encoded values (legacy preset shape)', () => {
        expect(getPromptInjectionPosition({ injection_position: '2' })).toBe(INJECTION_POSITION.ATTACH_EXISTING);
    });
});

describe('isPromptInjectionPosition', () => {
    test('matches only the requested position', () => {
        const prompt = { injection_position: INJECTION_POSITION.ATTACH_EXISTING };
        expect(isPromptInjectionPosition(prompt, INJECTION_POSITION.ATTACH_EXISTING)).toBe(true);
        expect(isPromptInjectionPosition(prompt, INJECTION_POSITION.RELATIVE)).toBe(false);
    });
});

describe('applyPromptManagerOverrides', () => {
    test('copies attach fields from collection prompt onto generated prompt', () => {
        const generated = { content: 'hello' };
        const collection = {
            injection_position: INJECTION_POSITION.ATTACH_EXISTING,
            attach_role: 'assistant',
            attach_index: -1,
            attach_side: 'start',
            role: 'system',
        };
        applyPromptManagerOverrides(generated, collection);
        expect(generated.injection_position).toBe(INJECTION_POSITION.ATTACH_EXISTING);
        expect(generated.attach_role).toBe('assistant');
        expect(generated.attach_index).toBe(-1);
        expect(generated.attach_side).toBe('start');
        expect(generated.role).toBe('system');
    });

    test('leaves target untouched when collection prompt is null / undefined', () => {
        const generated = { content: 'x' };
        expect(applyPromptManagerOverrides(generated, null)).toBe(generated);
        expect(applyPromptManagerOverrides(generated, undefined)).toBe(generated);
        expect(generated).toEqual({ content: 'x' });
    });

    test('does not overwrite target fields that collection prompt leaves undefined', () => {
        const generated = { attach_role: 'user', attach_index: 3 };
        applyPromptManagerOverrides(generated, { injection_position: INJECTION_POSITION.RELATIVE });
        expect(generated.attach_role).toBe('user');
        expect(generated.attach_index).toBe(3);
    });
});

describe('getPromptInjectionGroups', () => {
    test('partitions collection into relative-user ids, absolute prompts, and attached prompts', () => {
        const prompts = {
            collection: [
                { identifier: 'a_marker', system_prompt: true, injection_position: 0, marker: true },
                { identifier: 'b_user_rel', system_prompt: false, injection_position: 0 },
                { identifier: 'c_user_abs', system_prompt: false, injection_position: 1 },
                { identifier: 'd_sys_attach', system_prompt: true, injection_position: 2 },
                { identifier: 'e_user_attach', system_prompt: false, injection_position: 2 },
            ],
        };
        const { userRelativePromptIds, absolutePrompts, attachedPrompts } = getPromptInjectionGroups(prompts);
        expect(userRelativePromptIds).toEqual(['b_user_rel']);
        expect(absolutePrompts.map(p => p.identifier)).toEqual(['c_user_abs']);
        expect(attachedPrompts.map(p => p.identifier)).toEqual(['d_sys_attach', 'e_user_attach']);
    });

    test('tolerates missing / non-array collection', () => {
        expect(getPromptInjectionGroups(undefined)).toEqual({
            userRelativePromptIds: [],
            absolutePrompts: [],
            attachedPrompts: [],
        });
        expect(getPromptInjectionGroups({ collection: null })).toEqual({
            userRelativePromptIds: [],
            absolutePrompts: [],
            attachedPrompts: [],
        });
    });
});

describe('getRelativePromptById', () => {
    test('returns the prompt when it is RELATIVE, else null', () => {
        const relative = { identifier: 'r', injection_position: INJECTION_POSITION.RELATIVE };
        const absolute = { identifier: 'a', injection_position: INJECTION_POSITION.ABSOLUTE };
        const attach = { identifier: 't', injection_position: INJECTION_POSITION.ATTACH_EXISTING };
        const prompts = { get: id => ({ r: relative, a: absolute, t: attach }[id] ?? null) };
        expect(getRelativePromptById(prompts, 'r')).toBe(relative);
        expect(getRelativePromptById(prompts, 'a')).toBeNull();
        expect(getRelativePromptById(prompts, 't')).toBeNull();
        expect(getRelativePromptById(prompts, 'missing')).toBeNull();
    });
});

describe('applyAttachedPromptsToMessages', () => {
    test('appends to newest matching role by default (side=end, index=-1)', () => {
        const messages = makeMessages();
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p1', content: 'ATTACHED', attach_role: 'user', attach_index: -1, attach_side: 'end' }],
            messages,
        );
        expect(applied).toBe(1);
        // Newest user turn is U_new
        expect(messages.find(m => m.content.includes('ATTACHED')).content).toBe('U_new\n\nATTACHED');
        // Untouched messages preserved
        expect(messages.find(m => m.content === 'U_mid')).toBeDefined();
    });

    test('prepends to oldest matching role when side=start, index=1', () => {
        const messages = makeMessages();
        applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'ATT', attach_role: 'assistant', attach_index: 1, attach_side: 'start' }],
            messages,
        );
        // Oldest assistant is A_old
        expect(messages.find(m => m.content.includes('ATT')).content).toBe('ATT\n\nA_old');
    });

    test('treats attach_index=0 as 1 (oldest of role)', () => {
        const messages = makeMessages();
        applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'user', attach_index: 0, attach_side: 'end' }],
            messages,
        );
        expect(messages.find(m => m.content.includes('X')).content).toBe('U_old\n\nX');
    });

    test('clamps positive index beyond range to newest', () => {
        const messages = makeMessages();
        applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'Z', attach_role: 'user', attach_index: 999, attach_side: 'end' }],
            messages,
        );
        expect(messages.find(m => m.content.includes('Z')).content).toBe('U_new\n\nZ');
    });

    test('clamps negative index beyond range to oldest', () => {
        const messages = makeMessages();
        applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'Z', attach_role: 'user', attach_index: -999, attach_side: 'end' }],
            messages,
        );
        expect(messages.find(m => m.content.includes('Z')).content).toBe('U_old\n\nZ');
    });

    test('skips messages marked injected (author note / world info injections)', () => {
        const messages = [
            { role: 'user', content: 'REAL_new' },
            { role: 'user', content: 'INJ_1', injected: true },
            { role: 'user', content: 'REAL_old' },
        ];
        applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'user', attach_index: -1, attach_side: 'end' }],
            messages,
        );
        // Newest non-injected user turn is REAL_new (messages[0])
        expect(messages[0].content).toBe('REAL_new\n\nX');
        // Injected message unchanged
        expect(messages[1].content).toBe('INJ_1');
    });

    test('joins with a single blank line (\\n\\n) rather than replacing content', () => {
        const messages = [{ role: 'user', content: 'ORIG' }];
        applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'ADD', attach_role: 'user', attach_index: 1, attach_side: 'end' }],
            messages,
        );
        expect(messages[0].content).toBe('ORIG\n\nADD');
    });

    test('drops empty content silently without warning or mutation', () => {
        const warn = jest.fn();
        const messages = [{ role: 'user', content: 'ORIG' }];
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: '   ', attach_role: 'user', attach_index: 1 }],
            messages,
            { warn },
        );
        expect(applied).toBe(0);
        expect(warn).not.toHaveBeenCalled();
        expect(messages[0].content).toBe('ORIG');
    });

    test('warns and skips invalid attach_role', () => {
        const warn = jest.fn();
        const messages = [{ role: 'user', content: 'ORIG' }];
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'bogus', attach_index: 1 }],
            messages,
            { warn },
        );
        expect(applied).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/invalid target role/i);
        expect(messages[0].content).toBe('ORIG');
    });

    test('warns and skips non-integer attach_index', () => {
        const warn = jest.fn();
        const messages = [{ role: 'user', content: 'ORIG' }];
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'user', attach_index: 1.5 }],
            messages,
            { warn },
        );
        expect(applied).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/invalid message index/i);
    });

    test('warns and skips when no messages of the requested role exist', () => {
        const warn = jest.fn();
        const messages = [{ role: 'user', content: 'U1' }];
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'assistant', attach_index: 1 }],
            messages,
            { warn },
        );
        expect(applied).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/no existing assistant messages/i);
    });

    test('warns but still applies with default side when attach_side is invalid', () => {
        const warn = jest.fn();
        const messages = [{ role: 'user', content: 'ORIG' }];
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'user', attach_index: 1, attach_side: 'middle' }],
            messages,
            { warn },
        );
        expect(applied).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/invalid attach side/i);
        // Falls back to append
        expect(messages[0].content).toBe('ORIG\n\nX');
    });

    test('returns 0 and no-ops for empty attached prompt list', () => {
        const messages = makeMessages();
        const snapshot = JSON.stringify(messages);
        expect(applyAttachedPromptsToMessages([], messages)).toBe(0);
        expect(JSON.stringify(messages)).toBe(snapshot);
    });

    test('returns 0 and no-ops for empty message history', () => {
        const messages = [];
        const applied = applyAttachedPromptsToMessages(
            [{ identifier: 'p', content: 'X', attach_role: 'user', attach_index: 1 }],
            messages,
        );
        expect(applied).toBe(0);
        expect(messages).toEqual([]);
    });

    test('applies multiple attach prompts in list order, respecting mutations', () => {
        const messages = [{ role: 'user', content: 'ORIG' }];
        const applied = applyAttachedPromptsToMessages(
            [
                { identifier: 'p1', content: 'FIRST', attach_role: 'user', attach_index: 1, attach_side: 'end' },
                { identifier: 'p2', content: 'SECOND', attach_role: 'user', attach_index: 1, attach_side: 'start' },
            ],
            messages,
        );
        expect(applied).toBe(2);
        // p1 appends FIRST → 'ORIG\n\nFIRST', p2 prepends SECOND → 'SECOND\n\nORIG\n\nFIRST'
        expect(messages[0].content).toBe('SECOND\n\nORIG\n\nFIRST');
    });
});
