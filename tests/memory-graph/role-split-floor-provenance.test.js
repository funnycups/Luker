/**
 * Verifies that role-split chat messages built for extraction / recall /
 * rewrite LLM inputs carry the plugin-floor provenance marker
 * (`sourceFloorIndex`) equal to each frame's `source_index`, so the
 * request dispatcher (`applyPluginLaneRegex`) skips re-cooking texts that
 * were already cooked once at build time (exactly-once contract).
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import './_mocks/main-module-stack.js';

let buildRoleSplitChatMessages;

beforeAll(async () => {
    const main = await import('../../public/scripts/extensions/memory-graph/main.js');
    buildRoleSplitChatMessages = main._buildRoleSplitChatMessagesForTest;
});

describe('role-split chat message floor provenance', () => {
    test('each message carries numeric sourceFloorIndex equal to source_index', () => {
        const context = { chat: [{ mes: 'a', is_user: true }, { mes: 'b', is_user: false }] };
        const items = [
            { seq: 1, is_user: true, mes: 'hello', source_index: 0 },
            { seq: 2, is_user: false, mes: 'hi there', source_index: 1 },
        ];
        const messages = buildRoleSplitChatMessages(items, context, { wrapWithSeq: true });
        expect(messages).toHaveLength(2);
        expect(Number.isFinite(messages[0].sourceFloorIndex)).toBe(true);
        expect(messages[0].sourceFloorIndex).toBe(0);
        expect(Number.isFinite(messages[1].sourceFloorIndex)).toBe(true);
        expect(messages[1].sourceFloorIndex).toBe(1);
        expect(messages[0].role).toBe('user');
        expect(messages[1].role).toBe('assistant');
    });

    test('missing source_index leaves a non-finite marker so the dispatcher still cooks it', () => {
        const context = { chat: [{ mes: 'a', is_user: true }] };
        const messages = buildRoleSplitChatMessages(
            [{ seq: 1, is_user: true, mes: 'orphan turn' }],
            context,
        );
        expect(messages).toHaveLength(1);
        expect(Number.isFinite(messages[0].sourceFloorIndex)).toBe(false);
    });
});
