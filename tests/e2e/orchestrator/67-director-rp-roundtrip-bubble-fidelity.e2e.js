// Case #67 — Director RP one full round → 1:1 bubble fidelity.
//
// Spec:
//   - Enable orchestrator + director mode.
//   - Send an RP-immersive turn.
//   - The director main agent runs; the mock LLM router answers each
//     /chat/completions hit by sequencing: write_message(FINAL_REPLY) →
//     finalize(). The runtime commits the handle's buffered draft as
//     the chat bubble.
//   - The final chat bubble in the chat list MUST equal the model's final
//     text byte-for-byte (per `feedback_no_silent_truncation`).
//   - Restart the server; the chat history is rehydrated and the bubble
//     text is still preserved.
//
// What unlocked this:
//   The mock LLM now supports a director-aware router (`scriptDirectorRun`)
//   that distinguishes main-agent vs sub-agent requests by the presence
//   of director-only tools (write_message / finalize / dispatch_subagent)
//   in the tools array. Each call gets a per-role turn counter so the
//   spec can sequence the two-step write→finalize protocol deterministically.
//   See `_lib/mockLLM.js` header comment for the full API.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    reloadAndAwait,
    getChatSnapshot,
    installMinimalDirectorProfile,
} from '../_lib/page.js';

// The reply text needs to be distinctive so the byte-equality assertion
// is meaningful. Multi-line + special chars catch encoding gaps.
const FINAL_REPLY =
    '*Ash lowers the brass spyglass with deliberate care, the lantern light catching the verdigris on its rim.*\n\n'
    + '"The third breaker hasn\'t moved in six minutes. That\'s not the tide — that\'s a hull. Two more like it half a league out."\n\n'
    + '*Her hand closes around your sleeve, fingers cold.* "We move now, or we don\'t move at all."';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '67-bubble-fidelity' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#67 — Director RP one full round → 1:1 bubble fidelity', () => {
    test('director run commits scripted reply 1:1 to chat bubble + persists across restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await installMinimalDirectorProfile(page);

        // Two-step director protocol: write the entire body into the
        // handle, then finalize to commit. Anything else (sub-agent
        // dispatches, additional write_message calls, patches) would
        // also work, but for this 1:1 fidelity check the simplest
        // possible main-agent script is the right one. Each step pops
        // one turn off the router's per-role counter.
        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { tool: 'write_message', arguments: { text: FINAL_REPLY, mode: 'replace' } };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        // Send a single RP-immersive prompt and wait for the assistant
        // bubble to materialize.
        const { text: bubble } = await sendMessageAndAwaitReply(
            page,
            '*I cup my hand to the lantern, shielding the flame from the wind, and lean toward Ash.* "What do you read in the reef tonight?"',
            { timeoutMs: 60_000 },
        );

        // Byte-equality (post-trim — the renderer trims trailing newlines).
        expect(bubble.trim()).toBe(FINAL_REPLY.trim());

        // Persistence assertion: restart and re-open the chat.
        const before = await getChatSnapshot(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Wait for the persisted chat to rehydrate.
        await page.waitForFunction((wantLen) => {
            const ctx = window.Luker?.getContext?.();
            return Array.isArray(ctx?.chat) && ctx.chat.length >= wantLen;
        }, before.length, { timeout: 30_000 });

        const after = await getChatSnapshot(page);
        const lastAssistantBefore = [...before.messages].reverse().find(m => !m.is_user);
        const lastAssistantAfter = [...after.messages].reverse().find(m => !m.is_user);
        expect(lastAssistantAfter?.mes).toBe(lastAssistantBefore?.mes);
        expect(lastAssistantAfter?.mes?.trim()).toBe(FINAL_REPLY.trim());
    });
});
