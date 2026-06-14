// #86 — Disable a member → no longer rotated to; re-enable → back in
//
// Tests the disabled_members field on a group. With LIST activation,
// disabled members are filtered out before draft order is computed, so
// the rotation should shrink to the remaining enabled members. After
// re-enabling, the disabled member should re-enter the rotation.

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
} from './_helpers.js';

let server, mock, trio, groupId;

// Three replies per round (covers a worst-case undisabled rotation),
// stretched across all expected rounds. The mock falls back to a
// deterministic echo if exhausted, so we err on the side of more.
const REPLIES = [
    // Round 1 — all three enabled, LIST(Ash, Rhonin, Kestrel)
    '*Ash sets the chart flat with a knuckle.* "Third bell already? I have only finished the inner half."',
    '*Rhonin grunts approval and slides the inkpot her way.* "Then we mark the inner half tonight and walk the outer at first light."',
    '*Kestrel nods, charcoal hovering over the paper.* "I will keep watch on the south flares while you both write."',
    // Round 2 — Rhonin disabled, only Ash + Kestrel rotate
    '*Ash sets the cap back on the inkpot and exhales.* "Outer half then; the third bell shifted earlier than last week."',
    '*Kestrel angles the lantern an inch toward the cove.* "South flares went steady twos again — I will mark them with the time."',
    // Round 3 — Rhonin re-enabled, full rotation resumes
    '*Ash stands, knees popping, and unrolls the outer chart.* "Here, then — let us walk the cove gate before the tide turns."',
    '*Rhonin takes the lantern from its hook without comment.* "Bring the brass spyglass; the mist is thicker on the seaward side tonight."',
    '*Kestrel folds her charcoal sketch into her coat.* "I will catch up — I am marking the last flare cluster."',
];

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'groups', scenarioId: 'disable' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    trio = seedThreeCartographers(server.dataRoot);
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#86 — Disable / re-enable group member', () => {
    test('disabling member 2 removes them from rotation; re-enabling restores it', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        const group = await createGroupViaApi(page, {
            name: 'Bryn Headland Watch',
            members: trio.map(c => c.avatar),
            activation_strategy: 1, // LIST
            generation_mode: 0,
        });
        groupId = group.id;
        await openGroupForChat(page, group.id);

        // --- Round 1: all enabled, all three should speak. ---
        const r1 = await sendUserAndAwaitGroupTurn(page, 'Status check before the inner chart is finished.');
        const round1Speakers = r1.messages.filter(m => !m.is_user && !m.is_system).map(m => m.name);
        expect(round1Speakers, 'round 1 should rotate through all three members').toEqual(trio.map(c => c.name));

        // --- Disable Rhonin (index 1). ---
        await page.evaluate(async ({ id, disableAvatar }) => {
            const headers = window.Luker.getContext().getRequestHeaders();
            // Fetch the current group, mutate disabled_members, push back.
            const all = await fetch('/api/groups/all', { method: 'POST', headers, body: JSON.stringify({}) }).then(r => r.json());
            const g = (all || []).find(x => x.id === id);
            if (!g) throw new Error('group not found in /api/groups/all');
            g.disabled_members = [disableAvatar];
            await fetch('/api/groups/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify(g),
            });
            // Refresh in-memory state.
            await window.Luker.getContext().getCharacters();
        }, { id: groupId, disableAvatar: trio[1].avatar });

        // --- Round 2: only Ash + Kestrel should rotate. ---
        const r2 = await sendUserAndAwaitGroupTurn(page, 'Status check after the inner chart is finished.');
        const round2Speakers = r2.messages.filter(m => !m.is_user && !m.is_system).map(m => m.name);
        expect(round2Speakers, 'disabled Rhonin should not be drafted').not.toContain(trio[1].name);
        expect(round2Speakers, 'remaining members should still rotate in order')
            .toEqual([trio[0].name, trio[2].name]);

        // --- Re-enable Rhonin. ---
        await page.evaluate(async ({ id }) => {
            const headers = window.Luker.getContext().getRequestHeaders();
            const all = await fetch('/api/groups/all', { method: 'POST', headers, body: JSON.stringify({}) }).then(r => r.json());
            const g = (all || []).find(x => x.id === id);
            g.disabled_members = [];
            await fetch('/api/groups/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify(g),
            });
            await window.Luker.getContext().getCharacters();
        }, { id: groupId });

        // --- Round 3: full rotation should resume. ---
        const r3 = await sendUserAndAwaitGroupTurn(page, 'Status check before the cove walk.');
        const round3Speakers = r3.messages.filter(m => !m.is_user && !m.is_system).map(m => m.name);
        expect(round3Speakers, 're-enabling Rhonin should restore the full rotation order')
            .toEqual(trio.map(c => c.name));
    });
});
