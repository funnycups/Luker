// Case #71 — Critic regex search: extended director-driven branches (real e2e portion)
//
// Spec: extend critic-regex-search.spec.js. Add:
//   - critic votes reject → main agent does NOT commit suggested change
//   - critic suggests an edit → main agent applies the edit to its draft
//
// What unlocked the runtime-driven branches:
//   The mock LLM's director-aware router (`scriptDirectorRun`) drives
//   the full multi-round protocol — main writes draft → main dispatches
//   the critic sub-agent → critic returns its verdict as text → main
//   reacts (either keeps the draft or applies a patch) → main finalizes.
//   The sub-agent's reply lands in main's history as a tool result; main
//   reads it next round and branches accordingly.
//
// What stays here (this file): the two real director-driven branches.
// They commit a bubble to chat and assert on the persisted body, so
// they require the live takeover path + message-editor handle through
// a real Luker server.
//
// What moved to Jest (`tests/orchestrator/critic-regex-search-tool-primitives.test.js`):
//   The smoke test of the regex tool primitives (chat_search,
//   draft_search). Those were `page.evaluate(import(...))` calls
//   against pure functions and paid the server-boot cost despite
//   testing module contracts.

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
    installMinimalDirectorProfile,
} from '../_lib/page.js';

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*ack*'] });
    server = await startServer({ batchKey: 'orchestrator', scenarioId: '71-critic-regex' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#71 — Critic regex search: extended director-driven branches', () => {
    test('critic votes reject → main agent keeps original draft (does NOT apply the suggested change)', async ({ page }) => {
        // The contract: when the critic returns a "reject" vote, the
        // main agent's draft is committed as-is. We exercise it by
        // scripting a critic whose only reply is a verdict; the main
        // agent's NEXT round must NOT call apply_message_patches before
        // finalize. If it does, the bubble text will diverge from
        // ORIGINAL_DRAFT and the assertion will fail.
        const ORIGINAL_DRAFT =
            '*The lantern guttered once as she set the chart down.* '
            + '"Three breakers, no more no less. We will know by dawn whether they meant to be seen."';
        const CRITIC_VERDICT = 'VOTE: reject. The draft reads in voice; no edits proposed.';

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'You are the test director. Use write_message, dispatch_subagent, await_subagents, apply_message_patches, finalize.',
            subAgents: [
                {
                    id: 'voice_critic',
                    description: 'Test stub critic. Returns a verdict line.',
                    systemPrompt: 'You are the voice critic. Reply with a single verdict line.',
                },
            ],
        });

        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    // Round 0: write the initial draft, then dispatch
                    // the critic. Two tool calls in one round = parallel.
                    return { toolCalls: [
                        { name: 'write_message', arguments: { text: ORIGINAL_DRAFT, mode: 'replace' } },
                        { name: 'dispatch_subagent', arguments: { subagentId: 'voice_critic', task: 'critique the just-written draft for voice fit' } },
                    ] };
                }
                if (role === 'subagent') {
                    // Critic produces its verdict as no-tool-call text;
                    // that text becomes its outputText, returned to main
                    // via await_subagents.
                    return { text: CRITIC_VERDICT };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                }
                if (role === 'director-main' && turn === 2) {
                    // The critic rejected → DO NOT apply any patch.
                    // Just finalize. The body of the chat bubble must
                    // be ORIGINAL_DRAFT verbatim.
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        const { replyId } = await sendMessageAndAwaitReply(
            page,
            '*Hand on the rail, eyes seaward.* "Read the reef for me."',
            { timeoutMs: 60_000 },
        );

        // Contract: critic-reject leg never touches the draft. We compare
        // against the raw `chat[id].mes` (not DOM `.mes_text` innerText)
        // because the renderer turns markdown asterisks into <em> tags
        // and innerText strips them — the 1:1 fidelity check is about
        // the persisted body.
        const committedMes = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            return String(ctx.chat?.[id]?.mes ?? '');
        }, replyId);
        expect(committedMes.trim()).toBe(ORIGINAL_DRAFT.trim());

        // Defensive: confirm the critic verdict actually fired (the
        // sub-agent request must have hit the mock) so the test would
        // fail if the dispatch path stopped working. The verdict text
        // appears inside the await_subagents tool_result payload that
        // the main agent saw — we check it landed in mock.requests.
        const reqBodies = mock.requests.map(r => JSON.stringify(r.body));
        const sawCriticReply = reqBodies.some(b => b.includes('VOTE: reject'));
        expect(sawCriticReply).toBe(true);
    });

    test('critic suggests an edit → main agent applies the edit to its draft via apply_message_patches', async ({ page }) => {
        // Same scaffolding as the reject case, but the critic returns
        // a suggestion and main applies it before finalize. The
        // assertion is: the committed body contains the REPLACEMENT
        // text and NOT the original phrase.
        const ORIGINAL_PHRASE = '三个破浪点';
        const REPLACEMENT_PHRASE = '北方的三道暗流';
        const ORIGINAL_DRAFT =
            `*她把图卷在膝上摊开，指尖轻按其中一处。*\n\n`
            + `「今夜${ORIGINAL_PHRASE}都在那里。`
            + `若你愿意，我们可以等到月落再下灯。」`;
        const CRITIC_VERDICT = `VOTE: edit. Replace "${ORIGINAL_PHRASE}" with "${REPLACEMENT_PHRASE}".`;

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await installMinimalDirectorProfile(page, {
            mainSystemPrompt: 'You are the test director. Apply critic suggestions via apply_message_patches before finalize.',
            subAgents: [
                {
                    id: 'voice_critic',
                    description: 'Test stub critic.',
                    systemPrompt: 'You are the voice critic.',
                },
            ],
        });

        mock.scriptDirectorRun({
            route: ({ role, turn }) => {
                if (role === 'director-main' && turn === 0) {
                    return { toolCalls: [
                        { name: 'write_message', arguments: { text: ORIGINAL_DRAFT, mode: 'replace' } },
                        { name: 'dispatch_subagent', arguments: { subagentId: 'voice_critic', task: 'review draft' } },
                    ] };
                }
                if (role === 'subagent') {
                    return { text: CRITIC_VERDICT };
                }
                if (role === 'director-main' && turn === 1) {
                    return { tool: 'await_subagents', arguments: { handles: ['subagent-0'] } };
                }
                if (role === 'director-main' && turn === 2) {
                    // Critic suggested → apply the patch.
                    return { tool: 'apply_message_patches', arguments: {
                        patches: [{
                            kind: 'context_replace',
                            oldString: ORIGINAL_PHRASE,
                            newString: REPLACEMENT_PHRASE,
                        }],
                    } };
                }
                if (role === 'director-main' && turn === 3) {
                    return { tool: 'finalize', arguments: {} };
                }
                return null;
            },
        });

        const { replyId } = await sendMessageAndAwaitReply(
            page,
            '*她抬手挡风。*「读今夜的暗礁。」',
            { timeoutMs: 60_000 },
        );

        // Contract: the suggested edit lands in the committed bubble.
        // Compare against raw `chat[id].mes` rather than the DOM
        // .mes_text innerText (which strips markdown rendering) so the
        // assertion is on the persisted body, not the HTML rendering.
        const committedMes = await page.evaluate((id) => {
            const ctx = window.Luker.getContext();
            return String(ctx.chat?.[id]?.mes ?? '');
        }, replyId);
        expect(committedMes).toContain(REPLACEMENT_PHRASE);
        expect(committedMes).not.toContain(ORIGINAL_PHRASE);

        // Sanity: the critic verdict did appear in main's tool-result
        // history (proves the dispatch / await actually happened, not
        // that we just happened to emit a different draft).
        const reqBodies = mock.requests.map(r => JSON.stringify(r.body));
        const sawCriticReply = reqBodies.some(b => b.includes('VOTE: edit'));
        expect(sawCriticReply).toBe(true);
    });
});
