// #84 — Create group + add 3 members + turn rotation
//
// Seeds three distinct cartographer characters, creates a group with
// activation_strategy=LIST so rotation is deterministic, sends one user
// turn, and verifies:
//   - the group chat file on disk lists three assistant messages (one
//     per member) in member order
//   - the three assistant message `name` fields match the three members
//     in the configured rotation order
//   - each chat-completion request that the mock LLM sees has a system
//     message naming the speaker (the per-character description / first
//     message text is the most reliable per-turn fingerprint, since the
//     `name` field on the user message is the user persona, not the
//     drafted character)

import { test, expect } from '@playwright/test';
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

const REPLIES = [
    '*Ash flicks one knuckle along the chart toward the gull rocks.* "The third bell\'s breaker came in flat, which means the slow swallow is shaping under it. We watch — we do not move the lantern."',
    '*Rhonin sets his palm on the rail and tilts his ear toward the cove.* "Flat breakers and a dry north wind. I would have the chart over here, Ash; the cove gate read three drifters past the third stone tonight, and that is one too many."',
    '*Kestrel sketches a quick arc on her scrap of paper, charcoal whispering.* "South flares are steady twos and threes — no escort pattern. If the drifters are inside the cove, they came without a pilot, and I do not know any skiff that risks the inner channel blind."',
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'groups', scenarioId: 'rotation' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    trio = seedThreeCartographers(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#84 — Group rotation across 3 members', () => {
    test('LIST activation rotates Ash → Rhonin → Kestrel in order', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Verify all three characters loaded into the running session.
        const loadedNames = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return (ctx.characters || []).map(c => c?.name).filter(Boolean);
        });
        for (const c of trio) {
            expect(loadedNames, `character ${c.name} should have been loaded from disk`).toContain(c.name);
        }

        // Create the group via the same /api/groups/create endpoint the UI uses.
        const group = await createGroupViaApi(page, {
            name: 'Bryn Headland Watch',
            members: trio.map(c => c.avatar),
            activation_strategy: 1, // LIST → deterministic rotation in member order
            generation_mode: 0,     // SWAP → each member generates against its own prompt
        });
        groupId = group.id;
        chatId = group.chat_id;
        expect(group.id, 'group id should be set').toBeTruthy();
        expect(group.members, 'group members should equal the three seeded avatars').toEqual(trio.map(c => c.avatar));

        // Open the group as the active chat.
        await openGroupForChat(page, group.id);

        const reqBefore = mock.requests.length;
        const turn = await sendUserAndAwaitGroupTurn(page, 'The third bell has rung. What do each of you read from the cove?');

        // The slice should contain: 1 user + 3 assistant messages.
        const userMsgs = turn.messages.filter(m => m.is_user && !m.is_system);
        const asstMsgs = turn.messages.filter(m => !m.is_user && !m.is_system);
        expect(userMsgs.length, 'exactly one user message should have been appended').toBe(1);
        expect(asstMsgs.length, 'rotation should produce one assistant message per group member').toBe(trio.length);

        // The assistant messages should appear in member-list order
        // (the LIST activation strategy guarantees this).
        const speakerOrder = asstMsgs.map(m => m.name);
        expect(speakerOrder, 'each member should speak exactly once in the configured rotation order')
            .toEqual(trio.map(c => c.name));

        // The reply text on each bubble should be the corresponding scripted reply (no truncation).
        for (let i = 0; i < trio.length; i++) {
            expect(asstMsgs[i].mes, `assistant ${i} (${trio[i].name}) should hold the scripted reply verbatim`).toBe(REPLIES[i]);
        }

        // Each member's turn should hit the mock LLM with that member's
        // system prompt / description embedded in the message stream.
        const turnReqs = chatCompletionRequestsSince(mock.requests, reqBefore);
        expect(turnReqs.length, 'expected one chat-completion request per drafted member').toBe(trio.length);

        for (let i = 0; i < trio.length; i++) {
            const character = trio[i];
            const body = turnReqs[i]?.body || {};
            const flat = JSON.stringify(body.messages ?? []);
            // The character description we set is unique to each member;
            // it is the strongest per-turn fingerprint.
            expect(flat, `request ${i} should reference ${character.name}'s description`).toContain(character.description);
            // None of the OTHER members' descriptions should be in this prompt
            // when generation_mode is SWAP (each turn isolates a single speaker).
            for (let j = 0; j < trio.length; j++) {
                if (i === j) continue;
                expect(flat, `request ${i} (${character.name}) must not leak ${trio[j].name}'s description (SWAP mode)`)
                    .not.toContain(trio[j].description);
            }
        }

        // On-disk persistence: the group chat file holds the same
        // sequence the in-memory snapshot saw. A fresh group chat also
        // seeds each member's first_mes as a greeting before the user
        // turn, so we slice from the first user message onward.
        const onDisk = readGroupChatOnDisk(server.dataRoot, chatId);
        expect(onDisk.header, 'group chat file must start with a chat_metadata header').toBeTruthy();
        const firstUserIdx = onDisk.messages.findIndex(m => m.is_user);
        expect(firstUserIdx, 'a user message should be present in the persisted log').toBeGreaterThanOrEqual(0);
        const turnSlice = onDisk.messages.slice(firstUserIdx);
        const diskUsers = turnSlice.filter(m => m.is_user);
        const diskAssts = turnSlice.filter(m => !m.is_user && !m.is_system);
        expect(diskUsers.length, 'one persisted user message in the turn slice').toBe(1);
        expect(diskAssts.length, 'three persisted assistant messages, one per member').toBe(3);
        expect(diskAssts.map(m => m.name), 'persisted assistant order matches member-list order')
            .toEqual(trio.map(c => c.name));
    });
});
