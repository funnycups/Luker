// #87 — Group + Director mode → choose main speaker
//
// "Director mode" in a group context: an external decision picks which
// member speaks for a given turn instead of letting the group's
// activation strategy rotate. The canonical Luker entry point is the
// `/trigger <member-name>` slash command, which routes to
// `Generate('normal', { force_chid })` — group-chats.js#generateGroupWrapper
// short-circuits its activation strategy when `params.force_chid` is
// set and uses only that member.
//
// The test sets MANUAL activation strategy on the group so the natural
// path produces zero speakers from the activation phase (MANUAL only
// fires on auto-mode iterations, not on user-input turns), and the
// director's force_chid is what actually drives the rotation. Then the
// "director" (driven by this test, mock-scripted) picks member 1 first,
// then member 3, and we assert each turn produced exactly that member's
// reply — by message name, by message body (the scripted reply), and by
// the prompt that hit the mock LLM (each character has a unique
// description; only the chosen member's description should be present).
//
// Lessons baked in: tools listed are registered globally but we don't
// need tool-calling here; selectCharacterByName desyncs in group
// context so we open via openGroupById; /trigger requires `await=true`
// to wait for the generation to finish before returning.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import {
    seedThreeCartographers,
    createGroupViaApi,
    openGroupForChat,
    chatCompletionRequestsSince,
    readGroupChatOnDisk,
} from './_helpers.js';

let server, mock, trio, groupId, chatId;

// Two scripted replies — one for each director pick. The mock pops a
// reply per /chat/completions request, so member-1 (Ash) gets the
// first scripted reply and member-3 (Kestrel) gets the second.
const REPLIES = [
    '*Ash anchors the chart corner with the brass spyglass and reads aloud.* "Inner half is mapped — three breakers north of the gull rocks, two south. The slow swallow is forming."',
    '*Kestrel sketches a quick arc on a fresh corner of paper.* "South pier just put up a fourth flare. That is one beyond the steady-twos. The pilot wants confirmation before the next bell."',
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'groups', scenarioId: 'director' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    trio = seedThreeCartographers(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

/**
 * Send the user's turn through the chat as a /send (no /trigger), then
 * fire a /trigger await=true memberName separately. /trigger in a group
 * routes to Generate('normal', { force_chid }) — exactly the path the
 * director would invoke to nominate a single speaker per turn. The
 * `await=true` flag is critical so the call blocks until the chosen
 * member's reply has been appended to the chat.
 *
 * Returns the snapshot of messages appended since the call started so
 * the caller can identify which member spoke.
 */
async function directorPicksSpeaker(page, { userText, memberName, timeoutMs = 120_000 }) {
    const lengthBefore = await page.evaluate(() => window.Luker.getContext().chat?.length || 0);

    const wrapperDonePromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('group wrapper timeout')), to);
        const handler = (payload) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.GROUP_WRAPPER_FINISHED, handler); } catch {}
            resolve(payload);
        };
        ctx.eventSource.on(ctx.eventTypes.GROUP_WRAPPER_FINISHED, handler);
    }), timeoutMs);

    await page.evaluate(async ({ user, name }) => {
        const ctx = window.Luker.getContext();
        // Inject the user turn (no auto-trigger) so the chat reflects
        // what the user said, then have the director force the speaker.
        // `/trigger await=true <name>` blocks until the picked member's
        // reply has been appended.
        await ctx.executeSlashCommandsWithOptions(`/send ${user.replace(/\n/g, ' ')} | /trigger await=true ${name}`);
    }, { user: userText, name: memberName });

    await wrapperDonePromise;

    const messages = await page.evaluate((startAt) => {
        const ctx = window.Luker.getContext();
        const all = ctx.chat || [];
        return all.slice(startAt).map(m => ({
            name: m.name,
            is_user: !!m.is_user,
            is_system: !!m.is_system,
            mes: m.mes,
            original_avatar: m.original_avatar,
        }));
    }, lengthBefore);

    return { messages, lengthBefore };
}

test.describe('#87 — Director mode picks a single group speaker per turn', () => {
    test('director picks member 1 (Ash), then member 3 (Kestrel); only the chosen member speaks each turn', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // MANUAL strategy → activation phase is a no-op for user-input
        // turns, so the only way a speaker enters the rotation is via
        // force_chid (set by /trigger). This is the cleanest "director
        // picks" surface — no fallback to natural / list / pooled.
        const group = await createGroupViaApi(page, {
            name: 'Bryn Headland Watch (Director)',
            members: trio.map(c => c.avatar),
            activation_strategy: 2, // MANUAL
            generation_mode: 0,      // SWAP — each turn isolates one speaker
        });
        groupId = group.id;
        chatId = group.chat_id;
        await openGroupForChat(page, groupId);

        const reqsAtStart = mock.requests.length;

        // ---- Director pick #1: member 1 = Ash Cartographer ----
        const member1 = trio[0];
        const t1 = await directorPicksSpeaker(page, {
            userText: 'Director call — Ash, take the chart. Read me the inner half before the next bell.',
            memberName: member1.name,
        });
        const t1Users = t1.messages.filter(m => m.is_user && !m.is_system);
        const t1Assts = t1.messages.filter(m => !m.is_user && !m.is_system);
        expect(t1Users.length, 'director turn 1 should append exactly one user message').toBe(1);
        expect(t1Assts.length, 'director turn 1 must produce exactly one assistant message (force_chid isolates the chosen member)').toBe(1);
        expect(t1Assts[0].name, 'turn 1 speaker must be Ash (member 1) as nominated by /trigger').toBe(member1.name);
        expect(t1Assts[0].mes, 'turn 1 body must be the first scripted reply verbatim').toBe(REPLIES[0]);

        const t1Reqs = chatCompletionRequestsSince(mock.requests, reqsAtStart);
        expect(t1Reqs.length, 'turn 1 should make exactly one chat-completion request').toBe(1);
        const t1Flat = JSON.stringify(t1Reqs[0]?.body?.messages ?? []);
        expect(t1Flat, 'turn 1 prompt must reference Ash\'s description').toContain(member1.description);
        // SWAP mode: the other members' descriptions must NOT leak.
        for (let i = 1; i < trio.length; i++) {
            expect(t1Flat, `turn 1 (Ash) must not leak ${trio[i].name}'s description (SWAP mode + director isolates speakers)`)
                .not.toContain(trio[i].description);
        }

        const reqsAfterT1 = mock.requests.length;

        // ---- Director pick #2: member 3 = Kestrel Pilot ----
        const member3 = trio[2];
        const t2 = await directorPicksSpeaker(page, {
            userText: 'Director call — Kestrel, what did the pier flares say?',
            memberName: member3.name,
        });
        const t2Users = t2.messages.filter(m => m.is_user && !m.is_system);
        const t2Assts = t2.messages.filter(m => !m.is_user && !m.is_system);
        expect(t2Users.length, 'director turn 2 should append exactly one user message').toBe(1);
        expect(t2Assts.length, 'director turn 2 must produce exactly one assistant message').toBe(1);
        expect(t2Assts[0].name, 'turn 2 speaker must be Kestrel (member 3) as nominated by /trigger').toBe(member3.name);
        expect(t2Assts[0].mes, 'turn 2 body must be the second scripted reply verbatim').toBe(REPLIES[1]);

        const t2Reqs = chatCompletionRequestsSince(mock.requests, reqsAfterT1);
        expect(t2Reqs.length, 'turn 2 should make exactly one chat-completion request').toBe(1);
        const t2Flat = JSON.stringify(t2Reqs[0]?.body?.messages ?? []);
        expect(t2Flat, 'turn 2 prompt must reference Kestrel\'s description').toContain(member3.description);
        // Ash (member 1) and Rhonin (member 2) must NOT leak into Kestrel's prompt.
        expect(t2Flat, 'turn 2 (Kestrel) must not leak Ash\'s description (SWAP mode + director isolates speakers)')
            .not.toContain(trio[0].description);
        expect(t2Flat, 'turn 2 (Kestrel) must not leak Rhonin\'s description (SWAP mode + director isolates speakers)')
            .not.toContain(trio[1].description);

        // ---- Cross-cut: Rhonin (member 2) was never picked, never spoke ----
        const memberTwo = trio[1];
        const allMessagesFromStart = await page.evaluate((startAt) => {
            const ctx = window.Luker.getContext();
            return (ctx.chat || []).slice(startAt).map(m => ({
                name: m.name,
                is_user: !!m.is_user,
                is_system: !!m.is_system,
            }));
        }, /* startAt */ 0);
        const rhoninAssistantTurns = allMessagesFromStart.filter(
            m => !m.is_user && !m.is_system && m.name === memberTwo.name,
        );
        // The fresh group seeds each member's first_mes as a greeting,
        // so Rhonin's name shows up exactly once (the greeting); any
        // additional Rhonin assistant turns would be a director leak.
        expect(
            rhoninAssistantTurns.length,
            `member 2 (${memberTwo.name}) was never picked by the director; only the seeded greeting should carry their name`,
        ).toBeLessThanOrEqual(1);

        // ---- Persistence: the picked speakers' replies are on disk too ----
        const onDisk = readGroupChatOnDisk(server.dataRoot, chatId);
        const diskAssts = onDisk.messages.filter(m => !m.is_user && !m.is_system);
        const m1Drafted = diskAssts.filter(m => m.name === member1.name && m.mes === REPLIES[0]);
        const m3Drafted = diskAssts.filter(m => m.name === member3.name && m.mes === REPLIES[1]);
        expect(m1Drafted.length, 'Ash\'s director-driven reply must be persisted to the group chat jsonl').toBe(1);
        expect(m3Drafted.length, 'Kestrel\'s director-driven reply must be persisted to the group chat jsonl').toBe(1);
    });
});
