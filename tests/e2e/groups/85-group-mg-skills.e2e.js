// #85 — Group + Memory-Graph + Skills coexist
//
// Three Luker subsystems together in one chat:
//   - Group chat with deterministic LIST-rotation across 3 members
//   - Memory-Graph available, with records seeded each turn through the
//     Layer-1 session API (the live LLM-driven extraction pipeline
//     needs a faithful tool-calling backend the shared mockLLM cannot
//     replay, so we drive the SAME public session API the orchestrator
//     extractor uses — same persistence path, same shape on disk; see
//     memorygraph/#52 for the rationale).
//   - Skills, with one skill installed under `character/<member1.avatar>`
//     scope — the character-scoped skill list endpoint returns the
//     skill for member 1 only.
//
// What the test pins:
//   a) MG records land on disk per turn (the floor_log sidecar holds
//      one commit per session-create; we seed both pre- and post-turn
//      and verify both titles appear in the persisted patches).
//   b) On member 1's turn (Ash, the skill-bound member), the mock LLM
//      emits a tool_call(skill_read) — ST's ToolManager invokes it; the
//      response from `skillsApi.readFile` succeeds and the post-tool
//      reply lands in member 1's chat slot.
//   c) Members 2 and 3 emit plain text replies with no tool invocations.
//   d) The character-scoped skill list endpoint
//      `GET /api/skills?scope=character/<avatar>` returns the skill for
//      member 1 ONLY — members 2 and 3 see an empty character scope.
//
// Notes / lessons:
//   - MG `settings.enabled` triggers the live extractor on every
//     assistant turn. The extractor's own /chat/completions probes
//     would race for our scripted reply queue, so we keep it disabled
//     and drive the session API directly — same persistence guarantee,
//     no contention with the test's mock script.
//   - oai_settings.function_calling defaults to false; we flip it on.
//   - The shared mockLLM emits streaming tool_call frames WITHOUT
//     `choice.index`, which ToolManager.parseToolCalls silently drops
//     (only the non-streaming branch returns OpenAI-shaped messages
//     with index=0). We disable streaming for this scenario so the
//     tool-call round-trip actually fires.

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    seedThreeCartographers,
    createGroupViaApi,
    openGroupForChat,
    sendUserAndAwaitGroupTurn,
    chatCompletionRequestsSince,
    readGroupChatOnDisk,
} from './_helpers.js';

let server, mock, trio, groupId, chatId;

const SKILL_NAME = 'reef-shudder-protocol';
const SKILL_MD = `---
name: ${SKILL_NAME}
description: Field protocol for logging reef-shudder events on the Bryn headland watch. Captures amplitude, period, bell offset, and pier flare correlation.
license: MIT
metadata:
  author: luker-e2e
  version: 1.0.0
  tags: [bryn, watch, protocol]
---

# Reef-shudder protocol

When a breaker arrives off-phase with the moon cycle:

1. Log amplitude in fathoms.
2. Note bell offset (first/second/third…).
3. Cross-reference south pier flare count.
4. If amplitude > 5 fathoms AND bell offset is non-zero, mark "slow swallow".
5. If flares are not in the steady-twos pattern, raise the pilot signal.
`;

// Reply queue alignment for the mock:
//   - The mock pops EITHER a `tools` entry OR a `replies` entry per
//     /chat/completions request (mutually exclusive — tools take
//     precedence). So the reply queue stays aligned with the per-member
//     text answers regardless of how many tool calls fire.
//
// Turn timeline (LIST rotation = Ash, Rhonin, Kestrel):
//   request 1 (member 1 first call)  — tool_call(skill_read); no reply consumed
//   request 2 (member 1 follow-up)   — ASH_REPLY (the post-tool answer)
//   request 3 (member 2)             — RHONIN_REPLY
//   request 4 (member 3)             — KESTREL_REPLY
const ASH_REPLY = '*Ash sets the chart flat after checking the protocol.* "Per the field log — amplitude six, third bell, flares stuck on threes. That is a slow-swallow night with the pilot already asking for confirmation. We hold."';
const RHONIN_REPLY = '*Rhonin folds his arms and lets the lantern do the talking for a moment.* "Held. I would mark the inner gate as nominal-with-drifters and walk the outer line at first light."';
const KESTREL_REPLY = '*Kestrel angles the spyglass toward the south flares and counts under her breath.* "Steady-twos returned at the half-bell. The pilot is satisfied. We have a clean log."';
const REPLIES = [
    ASH_REPLY,
    RHONIN_REPLY,
    KESTREL_REPLY,
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'groups', scenarioId: 'mg-skills-coexist' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    trio = seedThreeCartographers(server.dataRoot);

    // Enable function-calling so ToolManager pushes its globally-
    // registered skill_* tools into every chat-completion request.
    // Also force non-streaming so the mock's tool_call frame (which
    // omits `choice.index`) is actually accepted by ToolManager —
    // the non-streaming branch in tool-calling.js does a deep check
    // (`choices.find(c => c.index === 0)`), and the mock's non-stream
    // payload DOES include `index: 0`. The streaming branch silently
    // drops index-less choices.
    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.function_calling = true;
    s.oai_settings.stream_openai = false;
    // The enum value for NONE is the empty string (custom_prompt_post_processing_types.NONE = '').
    // Anything else outside {'', 'merge', 'semi', 'strict'} fails the
    // isToolCallingSupported gate, which silently disables tool dispatch
    // for the chat-completion path.
    s.oai_settings.custom_prompt_post_processing = '';
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));

    // Install the test skill under `character/<member1.avatar>` scope
    // on disk so the per-user skill repository walks it on first
    // request. No install API call needed pre-boot.
    const skillDir = resolve(
        server.dataRoot, 'default-user', 'skills', 'character', trio[0].avatar, SKILL_NAME,
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(resolve(skillDir, 'SKILL.md'), SKILL_MD, 'utf8');
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#85 — Group + Memory-Graph + Skills coexistence', () => {
    test('MG seeds per turn; skill-bound member 1 invokes skill_read; members 2/3 do not see the skill in their scope', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // ---- Sanity (d): the test skill is visible to member 1 ONLY. ----
        const skillVisibility = await page.evaluate(async ({ avatars }) => {
            const out = {};
            for (const avatar of avatars) {
                const scopeFrag = `character/${avatar}`;
                const res = await fetch(`/api/skills?scope=${encodeURIComponent(scopeFrag)}`, {
                    method: 'GET',
                    headers: window.SillyTavern.getContext().getRequestHeaders(),
                });
                const arr = res.ok ? await res.json() : [];
                out[avatar] = Array.isArray(arr) ? arr.map(e => e.name) : [];
            }
            return out;
        }, { avatars: trio.map(c => c.avatar) });

        expect(
            skillVisibility[trio[0].avatar],
            `member 1 (${trio[0].name}) character-scoped skill list should contain ${SKILL_NAME}`,
        ).toContain(SKILL_NAME);
        expect(
            skillVisibility[trio[1].avatar],
            `member 2 (${trio[1].name}) character-scoped list must NOT contain ${SKILL_NAME} — the skill is bound to member 1 only`,
        ).not.toContain(SKILL_NAME);
        expect(
            skillVisibility[trio[2].avatar],
            `member 3 (${trio[2].name}) character-scoped list must NOT contain ${SKILL_NAME} — the skill is bound to member 1 only`,
        ).not.toContain(SKILL_NAME);

        // ---- Create the 3-member group and open its chat. ----
        const group = await createGroupViaApi(page, {
            name: 'Bryn Watch (MG + Skills)',
            members: trio.map(c => c.avatar),
            activation_strategy: 1, // LIST
            generation_mode: 0,      // SWAP
        });
        groupId = group.id;
        chatId = group.chat_id;
        await openGroupForChat(page, groupId);

        // ---- Seed an MG record BEFORE the turn (pre-turn baseline). ----
        // We deliberately keep MG `settings.enabled = false` so the live
        // extractor doesn't race our scripted mock queue with its own
        // tool-calling probes. The session-write API exercises the
        // SAME persistence path the extractor uses, so the on-disk
        // floor_log shape is identical.
        const seededPre = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            if (!mgApi) return { ok: false, reason: 'no mg extension api' };
            const session = await mgApi.openSession?.(ctx);
            if (!session) return { ok: false, reason: 'no mg session for group chat' };
            const node = await session.createNode({
                type: 'character_sheet',
                title: 'Bryn watch pre-turn baseline',
                fields: {
                    title: 'Bryn watch pre-turn baseline',
                    identity: 'Initial baseline for the night watch — recorded before the first bell of the group turn.',
                },
            });
            await ctx.saveChat();
            return { ok: true, nodeId: node?.id || '' };
        });
        expect(seededPre.ok, `pre-turn MG seed should succeed: ${JSON.stringify(seededPre)}`).toBe(true);
        expect(seededPre.nodeId, 'pre-turn MG seed should return a node id').toBeTruthy();

        // ---- Script the per-turn behavior on the mock. ----
        // Member 1's turn will emit a tool_call(skill_read) on its first
        // request; ST will invoke the skill, recurse Generate, and the
        // recursive request will get ASH_REPLY (queue: [ASH, RHONIN,
        // KESTREL]; req1 = tool only, no reply consumed; req2 = ASH;
        // req3 = RHONIN; req4 = KESTREL).
        mock.scriptToolCall({
            name: 'skill_read',
            arguments: { name: SKILL_NAME, path: 'SKILL.md' },
        });

        // ---- Drive the group turn (LIST rotation: Ash → Rhonin → Kestrel). ----
        const reqsBeforeTurn = mock.requests.length;
        const turn = await sendUserAndAwaitGroupTurn(page, 'Bell-sweep — give me amplitude, bell offset, and pier flare correlation for the inner cove.');

        // Diagnostic dumps used when assertions below fail — the most
        // useful single signal during debugging was "which scripted reply
        // landed on which slot", so we collect that up front and embed
        // it in failure messages.
        const turnDiag = JSON.stringify(turn.messages.map(m => ({
            name: m.name,
            is_user: m.is_user,
            is_system: m.is_system,
            mes_preview: String(m.mes || '').slice(0, 80),
            mes_len: String(m.mes || '').length,
        })), null, 2);
        const turnReqsDiag = JSON.stringify(
            mock.requests.slice(reqsBeforeTurn).map((r, i) => ({
                idx: i,
                hasTools: Array.isArray(r.body?.tools) && r.body.tools.length > 0,
                lastMsgRole: r.body?.messages?.[r.body.messages.length - 1]?.role,
            })),
            null, 2,
        );

        // ---- Assertion (a): each member spoke exactly once. ----
        const asstMsgs = turn.messages.filter(m => !m.is_user && !m.is_system);
        expect(
            asstMsgs.length,
            `LIST rotation must produce one assistant message per member.\nTurn messages:\n${turnDiag}\nMock requests:\n${turnReqsDiag}`,
        ).toBe(trio.length);
        for (let i = 0; i < trio.length; i++) {
            expect(asstMsgs[i].name, `assistant ${i} should be ${trio[i].name}`).toBe(trio[i].name);
        }

        // ---- Assertion (b): the tool ran on member 1; the post-tool
        //      reply landed in Ash's slot.
        expect(
            asstMsgs[0].mes,
            `Ash's reply must be the scripted post-tool answer.\nTurn messages:\n${turnDiag}\nMock requests:\n${turnReqsDiag}`,
        ).toBe(ASH_REPLY);
        // Members 2 and 3 get their plain replies verbatim.
        expect(asstMsgs[1].mes, 'Rhonin\'s reply must be the second scripted reply').toBe(RHONIN_REPLY);
        expect(asstMsgs[2].mes, 'Kestrel\'s reply must be the third scripted reply').toBe(KESTREL_REPLY);

        // ---- Assertion (b cont.): the chat-completion requests show
        //      the right shape: 4 total (1 tool + 1 follow-up for mem 1,
        //      then 1 each for mem 2 and 3). Every request must carry
        //      the skill_* tools in its `tools` array (function_calling
        //      = true + global ToolManager).
        const turnReqs = chatCompletionRequestsSince(mock.requests, reqsBeforeTurn);
        expect(
            turnReqs.length,
            `expected 4 chat-completion requests this turn: member1 tool-call + member1 follow-up + member2 + member3.\nMock requests:\n${turnReqsDiag}`,
        ).toBe(4);

        for (let i = 0; i < turnReqs.length; i++) {
            const reqTools = Array.isArray(turnReqs[i]?.body?.tools) ? turnReqs[i].body.tools : [];
            const toolNames = reqTools.map(t => t?.function?.name).filter(Boolean);
            expect(
                toolNames,
                `request ${i} should advertise the global skill_* tools to the LLM`,
            ).toEqual(expect.arrayContaining(['skill_list', 'skill_read', 'skill_search']));
        }

        // The follow-up request must include a `tool` role message
        // carrying a slice of SKILL.md — proves `skillsApi.readFile`
        // succeeded and ST routed the result back as a tool_result.
        const followUpReq = turnReqs[1];
        const followUpMsgs = Array.isArray(followUpReq?.body?.messages) ? followUpReq.body.messages : [];
        const toolResultMsgs = followUpMsgs.filter(m => m && m.role === 'tool');
        expect(
            toolResultMsgs.length,
            'member 1\'s follow-up request must include the tool_result from the previous skill_read',
        ).toBeGreaterThan(0);
        const toolBodyFlat = JSON.stringify(toolResultMsgs);
        expect(
            toolBodyFlat,
            'tool result should contain a slice of the SKILL.md body — proves the read landed on the right file',
        ).toContain('Reef-shudder protocol');

        // ---- Assertion (c): members 2 and 3 made plain calls with no
        //      tool. Their persisted replies must not carry a
        //      tool_invocations payload (those only land in
        //      extra.tool_invocations when ST routed a tool round-trip).
        const onDisk = readGroupChatOnDisk(server.dataRoot, chatId);
        const persistedAssts = onDisk.messages.filter(m => !m.is_user && !m.is_system);
        const member2Mes = persistedAssts.find(m => m.name === trio[1].name && m.mes === RHONIN_REPLY);
        const member3Mes = persistedAssts.find(m => m.name === trio[2].name && m.mes === KESTREL_REPLY);
        expect(member2Mes, 'Rhonin\'s persisted reply must exist').toBeTruthy();
        expect(member3Mes, 'Kestrel\'s persisted reply must exist').toBeTruthy();
        const member2ToolInvocations = member2Mes?.extra?.tool_invocations || [];
        const member3ToolInvocations = member3Mes?.extra?.tool_invocations || [];
        expect(
            member2ToolInvocations.length,
            'Rhonin\'s reply must carry no tool_invocations — the mock never scripted a tool call for member 2',
        ).toBe(0);
        expect(
            member3ToolInvocations.length,
            'Kestrel\'s reply must carry no tool_invocations — the mock never scripted a tool call for member 3',
        ).toBe(0);

        // ---- Assertion (a, MG side): seed a post-turn record and
        //      verify both pre- and post-turn titles land in the floor
        //      log on disk. Mirrors what the live extractor would do
        //      (one commit per "extraction round"), through the same
        //      Layer-1 session API.
        const seededPost = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            const session = await mgApi.openSession?.(ctx);
            const node = await session.createNode({
                type: 'location_state',
                title: 'Bryn cove gate after first bell-sweep',
                fields: {
                    title: 'Bryn cove gate after first bell-sweep',
                    state: 'Slow-swallow night confirmed; pilot signal returned to steady-twos at the half-bell.',
                    controller: 'Ash Cartographer',
                    resources: 'Brass spyglass, six hours of lantern oil.',
                },
            });
            await ctx.saveChat();
            return { ok: true, nodeId: node?.id || '' };
        });
        expect(seededPost.ok, 'post-turn MG seed should succeed').toBe(true);
        expect(seededPost.nodeId, 'post-turn MG seed should return a node id').toBeTruthy();

        // The MG floor_log sidecar must be present on disk for the
        // group chat and carry both seeded titles.
        const chatsRoot = resolve(server.dataRoot, 'default-user', 'group chats');
        const floorLogs = collectSidecars(chatsRoot, /\.luker-state\.memory_graph__floor_log\.json$/);
        expect(
            floorLogs.length,
            `MG floor_log sidecar must materialize under ${chatsRoot} for the group chat`,
        ).toBeGreaterThan(0);
        const log = JSON.parse(readFileSync(floorLogs[0], 'utf8'));
        const persistedTitles = collectPersistedTitles(log);
        expect(
            persistedTitles,
            'MG floor_log must record the pre-turn baseline title',
        ).toContain('Bryn watch pre-turn baseline');
        expect(
            persistedTitles,
            'MG floor_log must record the post-turn cove-gate title',
        ).toContain('Bryn cove gate after first bell-sweep');

        // ---- Final cross-cut: live re-read via the read API agrees
        //      with the on-disk floor log. Both seeded nodes are
        //      retrievable as visible candidates.
        const mgAfterTurn = await page.evaluate(async () => {
            const ctx = window.SillyTavern.getContext();
            const mgApi = ctx.getExtensionApi?.('memory-graph');
            const session = await mgApi.openSession?.(ctx);
            const cands = session.listVisibleCandidates({});
            return { ok: true, titles: cands.map(n => n.title), count: cands.length };
        });
        expect(mgAfterTurn.ok, 'MG session should still be usable after the group turn').toBe(true);
        expect(mgAfterTurn.titles).toContain('Bryn watch pre-turn baseline');
        expect(mgAfterTurn.titles).toContain('Bryn cove gate after first bell-sweep');
    });
});

/**
 * Walk `dir` recursively and return absolute paths of files whose basename
 * matches `pattern`. Mirrors the helper in memorygraph/52-extract-render-persist.
 */
function collectSidecars(dir, pattern) {
    const out = [];
    if (!existsSync(dir)) return out;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries = [];
        try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const full = resolve(cur, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (pattern.test(entry.name)) out.push(full);
        }
    }
    return out;
}

/**
 * Walk an MG floor log's commits and pluck every persisted node title.
 * Same shape as the helper used in memorygraph/52.
 */
function collectPersistedTitles(log) {
    const titles = [];
    for (const commit of log.commits || []) {
        for (const patch of commit.patches || []) {
            const value = patch.value;
            if (!value || typeof value !== 'object') continue;
            const nodeCarriers = patch.path === '/nodes'
                ? Object.values(value)
                : (patch.path?.startsWith('/nodes/') ? [value] : []);
            for (const node of nodeCarriers) {
                if (typeof node?.title === 'string') titles.push(node.title);
            }
        }
    }
    return titles;
}
