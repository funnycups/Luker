// Case #71 — Critic regex search: full critic flow + extended branches
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
// What we DO cover via the smoke test (still useful):
//   - The regex tool primitives (chat_search, draft_search) exposed via
//     loop-tools.js / director-tools.js return the documented grep-style
//     shape on valid + invalid regex inputs. This is the standalone
//     contract that critics depend on regardless of director runtime.

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

const ESTABLISHED_NAME = '张明远';
const KNOWN_AGE = '二十';

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

test.describe('#71 — Critic regex search: tool primitives + extended branches', () => {
    test('chat_search + draft_search: valid regex returns grep-style ok=true; invalid regex returns explanatory error', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        const smoke = await page.evaluate(async ({ establishedName, knownAge }) => {
            const loopMod = await import('/scripts/extensions/orchestrator/loop-tools.js');
            const dirMod = await import('/scripts/extensions/orchestrator/director-tools.js');

            const chat = [
                { is_user: false, mes: `narrator: 灯下走廊一片寂静。${establishedName} 端坐窗前。` },
                {
                    is_user: false,
                    mes: `她端起茶盏，目光落在他脸上：「你的名字是${establishedName}，今年${knownAge}岁。」`,
                },
                { is_user: true, mes: '我点了点头，没说话。' },
            ];

            const validResult = await loopMod.executeLoopTool(
                'chat_search',
                { pattern: establishedName, flags: 'gm' },
                { chat },
            );

            const invalidResult = await loopMod.executeLoopTool(
                'chat_search',
                { pattern: '[unclosed', flags: 'gm' },
                { chat },
            );

            const draftText = `第一行无事。\n第二行出现 ${establishedName}。\n第三行又出现 ${establishedName} 和邻人。`;
            const fakeHandle = { getText: () => draftText };
            const draftValid = await dirMod.executeDraftSearchTool(
                fakeHandle,
                { pattern: establishedName, flags: 'gm' },
            );
            const draftInvalid = await dirMod.executeDraftSearchTool(
                fakeHandle,
                { pattern: '(unclosed', flags: 'gm' },
            );

            return { validResult, invalidResult, draftValid, draftInvalid };
        }, { establishedName: ESTABLISHED_NAME, knownAge: KNOWN_AGE });

        // chat_search — valid regex.
        expect(smoke.validResult).toBeTruthy();
        expect(smoke.validResult.ok).toBe(true);
        expect(typeof smoke.validResult.output).toBe('string');
        expect(smoke.validResult.output).toContain(ESTABLISHED_NAME);
        // grep -n shape: `floor_{N} [{role}]:{lineno}: {line}`.
        expect(smoke.validResult.output).toMatch(/floor_\d+ \[assistant\]:\d+: /);

        // chat_search — invalid regex returns explanatory error.
        expect(smoke.invalidResult.ok).toBe(false);
        expect(smoke.invalidResult.error).toMatch(/escape regex metacharacters/);

        // draft_search — valid regex over the in-flight draft text.
        expect(smoke.draftValid.ok).toBe(true);
        expect(smoke.draftValid.output).toMatch(/^2: .*张明远/m);
        expect(smoke.draftValid.output).toMatch(/^3: .*张明远/m);

        // draft_search — invalid regex.
        expect(smoke.draftInvalid.ok).toBe(false);
        expect(smoke.draftInvalid.error).toMatch(/escape regex metacharacters/);
    });

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

        const { text: bubble } = await sendMessageAndAwaitReply(
            page,
            '*Hand on the rail, eyes seaward.* "Read the reef for me."',
            { timeoutMs: 60_000 },
        );

        // Contract: critic-reject leg never touches the draft.
        expect(bubble.trim()).toBe(ORIGINAL_DRAFT.trim());

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

        const { text: bubble } = await sendMessageAndAwaitReply(
            page,
            '*她抬手挡风。*「读今夜的暗礁。」',
            { timeoutMs: 60_000 },
        );

        // Contract: the suggested edit lands in the committed bubble.
        expect(bubble).toContain(REPLACEMENT_PHRASE);
        expect(bubble).not.toContain(ORIGINAL_PHRASE);

        // Sanity: the critic verdict did appear in main's tool-result
        // history (proves the dispatch / await actually happened, not
        // that we just happened to emit a different draft).
        const reqBodies = mock.requests.map(r => JSON.stringify(r.body));
        const sawCriticReply = reqBodies.some(b => b.includes('VOTE: edit'));
        expect(sawCriticReply).toBe(true);
    });
});
