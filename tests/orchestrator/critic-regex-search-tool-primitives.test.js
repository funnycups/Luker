// Case #71 — Critic regex search: tool primitives (ported from e2e).
//
// Spec (smoke half — pure tool primitive contracts):
//   The regex tool primitives (chat_search, draft_search) exposed via
//   loop-tools.js / director-tools.js return the documented grep-style
//   shape on valid + invalid regex inputs. This is the standalone
//   contract that critics depend on regardless of director runtime.
//
// The other two cases in the original e2e file (critic-reject /
// critic-suggests-edit branches) stay as e2e — they drive a real
// director-aware multi-round mock LLM run, dispatch_subagent +
// await_subagents + apply_message_patches against a live chat, and
// assert on the committed bubble body. Those require the production
// dispatch path through the takeover hook and the message-editor
// handle — there's no useful smaller unit boundary.

import { describe, test, expect } from '@jest/globals';
import { executeLoopTool } from '../../public/scripts/extensions/orchestrator/loop-tools.js';
import { executeDraftSearchTool } from '../../public/scripts/extensions/orchestrator/director-tools.js';

const ESTABLISHED_NAME = '张明远';
const KNOWN_AGE = '二十';

describe('#71 — Critic regex search: tool primitives', () => {
    test('chat_search + draft_search: valid regex returns grep-style ok=true; invalid regex returns explanatory error', async () => {
        const chat = [
            { is_user: false, mes: `narrator: 灯下走廊一片寂静。${ESTABLISHED_NAME} 端坐窗前。` },
            {
                is_user: false,
                mes: `她端起茶盏，目光落在他脸上：「你的名字是${ESTABLISHED_NAME}，今年${KNOWN_AGE}岁。」`,
            },
            { is_user: true, mes: '我点了点头，没说话。' },
        ];

        // chat_search — valid regex.
        const validResult = await executeLoopTool(
            'chat_search',
            { pattern: ESTABLISHED_NAME, flags: 'gm' },
            { chat },
        );
        expect(validResult).toBeTruthy();
        expect(validResult.ok).toBe(true);
        expect(typeof validResult.output).toBe('string');
        expect(validResult.output).toContain(ESTABLISHED_NAME);
        // grep -n shape: `floor_{N} [{role}]:{lineno}: {line}`.
        expect(validResult.output).toMatch(/floor_\d+ \[assistant\]:\d+: /);

        // chat_search — invalid regex returns explanatory error.
        const invalidResult = await executeLoopTool(
            'chat_search',
            { pattern: '[unclosed', flags: 'gm' },
            { chat },
        );
        expect(invalidResult.ok).toBe(false);
        expect(invalidResult.error).toMatch(/escape regex metacharacters/);

        // draft_search — valid regex over the in-flight draft text.
        const draftText = `第一行无事。\n第二行出现 ${ESTABLISHED_NAME}。\n第三行又出现 ${ESTABLISHED_NAME} 和邻人。`;
        const fakeHandle = { getText: () => draftText };
        const draftValid = await executeDraftSearchTool(
            fakeHandle,
            { pattern: ESTABLISHED_NAME, flags: 'gm' },
        );
        expect(draftValid.ok).toBe(true);
        expect(draftValid.output).toMatch(/^2: .*张明远/m);
        expect(draftValid.output).toMatch(/^3: .*张明远/m);

        // draft_search — invalid regex.
        const draftInvalid = await executeDraftSearchTool(
            fakeHandle,
            { pattern: '(unclosed', flags: 'gm' },
        );
        expect(draftInvalid.ok).toBe(false);
        expect(draftInvalid.error).toMatch(/escape regex metacharacters/);
    });
});
